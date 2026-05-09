# Pulse API

NestJS + TypeScript + TypeORM. Owns Postgres, Redis, Stripe, Clover, push, Telegram. The iOS app and the React dashboard talk only to this service.

## Module status

| Module | Status | Notes |
|---|---|---|
| `auth` | Built | Customer + staff JWT, bcrypt, refresh, RBAC roles guard. |
| `health` | Built | `GET /health` checks Postgres + Redis with 2s cap. ECS task health check. |
| `locations` | Built | List, detail, `canAcceptOrders()` implementing spec 5.5. |
| `menu` | Built | Two-layer Redis cache (`menu:full:{loc}` + `menu:item:{id}`), tracking-set invalidation. |
| `pricing` | Built | All money math. Integer cents. 22/22 unit tests pass. |
| `payments` | Built | Stripe webhook + atomic outbox transaction (`ORDER_PAID`). |
| `checkout` | Built | 6-step flow (idempotency → location → items → pricing → atomic txn → response). |
| `orders` | Built | `GET /orders/:id`, `GET /orders/my` (paginated), `POST /orders/:id/cancel` (DRAFT or PENDING_PAYMENT). Also hosts `PendingPaymentCleanupTask` — a `@Cron(EVERY_5_MINUTES)` sweep that transitions abandoned-at-checkout orders (PENDING_PAYMENT > 30 min) to FAILED and best-effort cancels their Stripe PaymentIntent. |
| `admin` | Built | 14 endpoints across orders/items/ordering/dashboard/feature-flags. RBAC enforced. |
| `workers` | Built | Outbox poller + order worker. `SELECT FOR UPDATE SKIP LOCKED` for multi-pod safety. Stub Clover/Telegram still in place. |
| `clover` | Stub | `CloverSyncService.syncOrder()` logs only. Real Clover REST integration is the next module. |
| `notifications` | Stub | `TelegramService.alertDeadOutboxEvent()` logs `[telegram-stub]` only. APNs not wired. |
| `loyalty` | Next | Points on `ORDER_PAID`, tier upgrades. Currently `last_visit_at` updates inside `OrderWorker`; loyalty triggers when its module ships. |
| `inventory` | Subsumed | Sold-out toggle currently lives in the `admin` module (`POST /admin/items/:id/sold-out`). A dedicated `inventory` module isn't needed for Phase 1. |

The current top priority is the **Clover integration** — replacing `CloverSyncService.syncOrder()` so the `MANUAL_REQUIRED` terminal state becomes a real outcome of the retry sequence (`[0s, 30s, 2min, 10min]`) instead of a stub log line. After that: APNs push so `ORDER_READY` actually notifies the customer.

### Where `ORDER_READY` push delivery currently lands

When staff press Ready on an order, `AdminOrdersService.markReady()` inserts `outbox_events (event_type='ORDER_READY', status='PENDING')`. The outbox worker picks it up, sees there's no registered handler, logs a warning, and marks it `PROCESSED`. **No push is sent yet** — the customer-facing "your coffee is ready" notification is wired up when the notifications module ships. Operationally, today, customers learn the order is ready by polling `GET /orders/:id`.

## Migrations

Schema is managed exclusively by migration files under `src/database/migrations/`. `synchronize` is permanently `false`.

```bash
npm run migration:generate -- src/database/migrations/<Name>
npm run migration:run
npm run migration:revert
npm run migration:show
```

### The shared-enum quirk to watch for

TypeORM 0.3's `migration:generate` emits **duplicate `CREATE TYPE`** statements for any enum that's referenced by more than one column (e.g., `payment_status_enum` is used by both `orders.payment_status` and `payments.payment_status`). The first migration run will fail with `type "..." already exists`.

The fix is manual: open the generated migration, delete the duplicate `CREATE TYPE` lines (keep the first one), and in `down()` move the `DROP TYPE` for shared enums to the end so they fire **after** every referencing table is dropped. The `1778273424632-InitialSchema.ts` migration in the repo shows the pattern with explanatory comments — copy that approach for any future shared-enum migration.

**Always read a generated migration before running it.** The generator is a useful first draft, not a finished artifact.

## Seeds

```bash
npm run seed:feature-flags    # 12 flags from spec 3.5. Idempotent.
npm run seed:dev              # 1 location with hours/settings/pricing rule. Idempotent.
```

`seed:dev` creates "Pulse Coffee — Main St" with:
- Mon–Fri 7:00–18:00, Sat 8:00–16:00, Sun closed
- `current_wait_minutes=5`, `scheduled_ordering=true`, `max_schedule_days=7`
- Pricing rule: `tax_rate_bps=888` (≈8.875% NYC), `tip_options=[15, 18, 20, 25]`

Both seeds are idempotent — safe to re-run; they upsert by natural key.

## Environment variables

All variables live in `apps/api/.env` (copied from `pulse-platform/.env.example`). Production reads from AWS Parameter Store, never from `.env`.

| Variable | Where to get it |
|---|---|
| `API_ENABLED` | `true` (default) — opens the HTTP listener. Set `false` on dedicated worker tasks. |
| `WORKERS_ENABLED` | `true` (default) — runs the outbox worker. **Set `false` on every API replica when `desiredCount > 1`** so only one task polls the outbox. |
| `DATABASE_*` | `pulse`/`pulse`/`pulse` for local dev. Production: RDS via Parameter Store. |
| `REDIS_*` | `localhost:6379` for local dev. Production: ElastiCache. |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Generate with `openssl rand -base64 32`. Different for each. |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | `15m` / `30d` per spec Part 10. |
| `BCRYPT_ROUNDS` | `12`. Lower in CI/test only. |
| `STRIPE_SECRET_KEY` | <https://dashboard.stripe.com/test/apikeys> — use the `sk_test_…` key for local. |
| `STRIPE_WEBHOOK_SECRET` | Printed by `stripe listen` when running the Stripe CLI locally. Different per environment. |
| `STRIPE_API_VERSION` | `2024-06-20`. |
| `CLOVER_*` | Clover developer dashboard. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID` | `@BotFather` on Telegram. |
| `APNS_*` | Apple Developer portal — APNs auth key. |
| `SENTRY_DSN` | Sentry project settings. Optional in dev. |
| `POSTHOG_API_KEY` | PostHog project settings. Optional in dev. |
| `THROTTLE_*` | Optional overrides. Defaults match spec Part 4.5. |

## Verifying it's working locally

```bash
# 1. Health check — both deps up
curl http://localhost:3000/api/v1/health
# → {"status":"ok","postgres":"up","redis":"up","timestamp":"..."}

# 2. Swagger UI — every endpoint is decorated
open http://localhost:3000/api/docs

# 3. List locations (verifies seed:dev ran)
curl http://localhost:3000/api/v1/locations | jq

# 4. Public menu (returns empty categories until you seed menu items)
LOC=$(curl -s http://localhost:3000/api/v1/locations | jq -r '.[0].id')
curl "http://localhost:3000/api/v1/menu?locationId=$LOC" | jq
```

If `/health` returns 503 with `redis:down`, run `docker compose ps` and confirm both containers are `(healthy)`.

## Port conflict note

If another local project is using port **5432** (e.g., a different Postgres container), `docker compose up` will fail with `Bind for 0.0.0.0:5432 failed: port is already allocated`. The Pulse stack maps Postgres to **host port 5433** by default to coexist:

```
Host 5433  →  pulse-postgres :5432
Host 6379  →  pulse-redis    :6379
```

`apps/api/.env.example` uses `DATABASE_PORT=5433`. If you need 5432 instead, edit `docker-compose.yml` and `.env` together, or stop the other service.

## Tests

```bash
npm test           # current: 22/22 PricingService unit tests
```

Pricing has the only test suite right now. Checkout integration tests (with mocked Stripe) come with the orders module.
