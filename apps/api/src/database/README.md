# `database/`

Single source of truth for the schema. `entities.ts` defines every entity and every enum. `data-source.ts` configures the TypeORM DataSource. `migrations/` holds the schema-evolution history. `seeds/` and `../scripts/` hold the data seeds.

## Three independent status enums

The most-misunderstood part of the schema. The `orders` table has three separate enum columns:

```sql
order_status        order_status_enum         -- DRAFT, PENDING_PAYMENT, PAID, ...
payment_status      payment_status_enum       -- REQUIRES_PAYMENT, SUCCEEDED, FAILED, ...
clover_sync_status  clover_sync_status_enum   -- NOT_SENT, SENT, FAILED, MANUAL_REQUIRED
```

They look like they should be one column. They are not, on purpose.

Each one has its own *source of truth*:

- `OrderStatus` is set by checkout, the Stripe webhook, and staff actions.
- `PaymentStatus` is set **only** by the Stripe webhook.
- `CloverSyncStatus` is set by the `clover.worker`.

They fail independently. The canonical example: a successful payment whose Clover sync exhausted all retries reads `(PAID, SUCCEEDED, MANUAL_REQUIRED)`. A single-column "order_state" enum would have to invent a hybrid value or pick one truth and lie about another. Three independent fields let each subsystem report what it knows, and the UI composes the right view per audience.

See `docs/glossary.md` for every enum value with its operational meaning.

## Integer cents

Every monetary column is `INT NOT NULL`. `650` means $6.50. The `_cents` suffix on every column name (`subtotal_cents`, `tax_cents`, `total_cents`, `unit_price_cents`, …) is the visual reminder.

No `DECIMAL`, no `NUMERIC`, no app-side `BigDecimal`-style libraries. The `PricingService` does all arithmetic in plain JavaScript integer math, well within the 53-bit safe integer range for any realistic order. Display formatting (`(cents / 100).toFixed(2)`) is the UI's responsibility, performed *once* at the boundary.

## Basis points

`pricing_rules.tax_rate_bps INT`. **1 basis point = 0.01%.** So `875` means 8.75%, `888` ≈ 8.875%. The formula:

```ts
taxCents = Math.round(taxableCents * tax_rate_bps / 10000)
```

Integer multiplication first, then `Math.round` after. No float accumulation in business logic. The seed for our NYC location uses `888` for the integer-rounded equivalent of 8.875% — see `apps/api/scripts/seed-dev-data.ts`.

(Beware the off-by-100x mistake: writing `tax_rate_bps = 8875` thinking it represents 8.875% produces 88.75% under the formula above. We've seen this bug; we now flag it in code review.)

## The outbox pattern

`outbox_events` exists to make critical event delivery durable. The table is written to **inside the same transaction** as the state change it describes. A separate poller (`outbox.worker`, polling every 1s) reads pending rows and dispatches them to SQS.

Schema of interest:

```sql
event_type   outbox_event_type_enum  -- ORDER_PAID, REFUND_CREATED, ITEM_OUT_OF_STOCK, ...
status       outbox_status_enum      -- PENDING, PROCESSED, DEAD
attempts     INT DEFAULT 0
last_error   TEXT
payload      JSONB
```

Index of interest: `(status, created_at)`. The worker's hot query is `WHERE status='PENDING' ORDER BY created_at LIMIT 10`, which becomes an index-only scan. Adding the index is in `1778273529985-AddExplicitIndexes.ts`.

See `docs/architecture.md` flow #2 for the disaster diagram and `docs/golden-rules.md` rule #9.

## Migration discipline

`synchronize` is permanently `false`. All schema changes are in committed migration files under `migrations/`. Workflow:

```bash
# 1. Edit entities.ts.
# 2. Generate the migration:
npm run migration:generate -- src/database/migrations/<DescriptiveName>
# 3. READ the generated file. Always.
# 4. Apply:
npm run migration:run
```

Step 3 is non-optional. The generator is a useful first draft, not a finished artifact.

### The shared-enum quirk

TypeORM 0.3's generator emits a duplicate `CREATE TYPE "<enum>_enum"` whenever an enum is referenced by more than one column (e.g., `payment_status_enum` is on `orders.payment_status` *and* `payments.payment_status`; `clover_sync_status_enum` is on `orders.clover_sync_status` *and* `clover_sync_log.sync_status`). The first migration to introduce a shared enum will fail with `error: type "..." already exists` if you run it as-generated.

The symmetric problem hits `down()`: the generator emits a `DROP TYPE` for the shared enum after dropping the *first* table that uses it, then again after the *second* — so the first DROP fires while the second referencing table still exists, and Postgres errors out.

The fix in `up()`:
- Find the duplicate `CREATE TYPE` in the generated migration.
- Replace the duplicate with a `// already created above` comment.
- Keep the first `CREATE TYPE`.

The fix in `down()`:
- Find the early `DROP TYPE` calls that fire mid-flow.
- Move them to the very end so they run only after every referencing table is dropped.

`migrations/1778273424632-InitialSchema.ts` shows the pattern with explanatory comments. Use it as the template for any future migration that touches a shared enum.

**Never modify a migration that has already been run in any environment.** It will produce divergent schemas across local/staging/prod that are extremely hard to recover from. If a migration is wrong post-run, write a *new* migration that applies the correction forward.

## Snapshot fields in `order_items`

```sql
order_items
  unit_price_cents  INT NOT NULL          -- price snapshot at order time
  modifiers         JSONB                 -- [{modifierId, name, priceCents}, ...]
```

These are **frozen at order time**. They are not resolved at read time by joining back to `menu_items` or `modifiers`.

Reason: the menu changes. Items get renamed, repriced, or deleted. The order row is a complete, durable record of *what was sold and for how much*; the menu is a current view of *what's for sale today*. Conflating them makes "what did the customer pay six months ago" un-answerable, and makes Stripe-vs-our-ledger reconciliation impossible.

The frozen `name` inside the modifiers JSONB is the same idea: even if "Oat Milk" gets renamed to "Oat Milk (Organic)" tomorrow, last week's order still says "Oat Milk." That's what the customer ordered. That's what the receipt should say.

The cost is a few hundred bytes per order row. The benefit is a complete, auditable history that doesn't drift as the menu evolves.
