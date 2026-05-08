# `modules/checkout`

The single most important module in the codebase. Everything else exists to support what this module does correctly.

## Why checkout is sacred

A bug in `auth` produces a login failure: the user retries and it works. A bug in `menu` produces a stale price: the user notices and complains. A bug in `checkout` produces a wrong charge, a double charge, a phantom order, or — worst — a customer who paid for a coffee they never get. Money mistakes don't get retried; they get disputed, refunded, and remembered.

So this module is deliberately boring:

- **No A/B tests.** Every customer goes through the same code path.
- **No clever optimisations.** No "let's batch the inventory check with the item lookup to save a query." The 6-step sequence is the whole spec.
- **No dynamic logic.** No feature flags inside the checkout flow itself. (Feature-flagged products are added or hidden upstream — by the time we're in checkout, the cart is what it is.)
- **No AI.** Nothing that decides things based on the customer's history, the time of day, or "what we think they wanted." Personalisation is Phase 2 and lives upstream.
- **Small surface.** One endpoint, one DTO, one service.

When in doubt about a change in this module: don't make it. Open an issue, talk to the CTO chat, get a decision-log entry. The cost of refusing a "small improvement" is a couple of paragraphs of conversation. The cost of a checkout regression is a Stripe dispute and an unhappy customer.

## The 7-step sequence

`POST /api/v1/checkout` runs exactly this, in this order:

1. **Idempotency check.** Look up `dto.idempotencyKey` in `orders`. Already SUCCEEDED → return cached payload. In flight → 409. Different customer → 409.
2. **Location validation.** `HoursService.canAcceptOrders()` — paused, closed today, outside hours, SCHEDULED gate. Reject with structured reason on failure.
3. **Item + modifier validation.** Load every menu item from the DB and confirm `active = true` and the item belongs to a category at this `locationId` (multi-tenant safety). Load every modifier and confirm it belongs to a `modifier_group` of the cart item it was attached to. **The backend's prices replace the client's.**
4. **Tip-percent validation.** `PricingService.validateTipPercent()` — must be 0 or in this location's `pricing_rules.tip_options`.
5. **Pricing.** `PricingService.calculateOrder()`. All math integer cents. Returns subtotal/modifier/discount/tax/tip/total + display strings.
6. **Atomic transaction:**
   - Re-check inventory for every item *inside* the transaction.
   - Insert `orders` (DRAFT, REQUIRES_PAYMENT).
   - Insert `order_items` with frozen snapshots of name, unit price, modifier `{name, priceCents}` triples.
   - Insert `order_events` for the DRAFT creation.
   - Call Stripe `paymentIntents.create()`.
   - Update the order: `stripe_payment_id` set, `order_status = PENDING_PAYMENT`.
   - Insert `order_events` for the PENDING_PAYMENT transition.
   - Commit.
7. **Return** `{orderId, clientSecret, totalCents, display}` to iOS.

If anything in step 6 fails (inventory race, Stripe error, DB constraint), the entire transaction rolls back. There is no partial state.

## Why inventory is re-checked inside the transaction

Concrete example. Two customers, simultaneously, both want the last Oat Milk Latte:

```
T+0     Customer A: POST /checkout → step 3 reads inventory (available, 1 left)
T+5ms   Customer B: POST /checkout → step 3 reads inventory (available, 1 left)  ← same!
T+10ms  Customer A: step 6 — opens transaction, INSERTs order + items, calls Stripe...
T+200ms Customer B: step 6 — opens transaction, INSERTs order + items, calls Stripe...
```

If we **don't** re-check inventory inside the transaction, both orders succeed. Stripe charges both customers. The barista has 1 latte to give to 2 people, and someone gets a Telegram alert with no good way to resolve it.

If we **do** re-check inside the transaction, the second one finds `quantity_left = 0` (or `available = false` after a staff toggle that landed between T+5 and T+200) and rolls back before charging. The customer sees an "item just sold out" error and picks something else.

The same race applies to staff sold-out toggles: a manager flipping `inventory.available = false` between step 3 and step 6 must be honoured. The double-check is what makes that safe.

(For Phase 1 we read inventory inside the transaction without `SELECT FOR UPDATE` — we don't decrement `quantity_left` on checkout, so there's no row-lock contention. When Phase 2 adds quantity-tracked inventory, the read becomes a `SELECT FOR UPDATE`.)

## Why item names and modifier prices are snapshotted

`order_items` rows store `unit_price_cents` and a `modifiers` JSONB array of `{modifierId, name, priceCents}` triples. They are **frozen at order time** — never resolved by joining back to `menu_items` or `modifiers`.

The reason: the menu changes. The "Oat Milk Latte" might be renamed, repriced, or deleted. Six months later, the customer asks "what did I order?" or the owner asks "show me last March's revenue from oat lattes." Those questions only have answers if every order row carries its own copy of what was ordered.

Without snapshots:
- A renamed item retroactively rewrites historical order display.
- A deleted item makes historical order details un-resolvable.
- A repriced item makes Stripe-vs-our-ledger reconciliation impossible.

With snapshots, the order row is a complete, durable record of the transaction. The cost is a few hundred bytes per order.

## Duplicate idempotency keys

Three cases. All three are handled in `tryReturnCachedResponse()` before any other work runs.

| Existing order's payment_status | Behaviour |
|---|---|
| `SUCCEEDED` (same customer) | Return 200 with the cached display payload. `clientSecret = ""`. The replay is safe — same money, same order, no double-charge. |
| `REQUIRES_PAYMENT` or `PROCESSING` (same customer) | Return 409 `PAYMENT_IN_FLIGHT` with the existing `orderId`. The client must wait for the Stripe webhook, not retry. |
| `FAILED` or `REFUNDED` (same customer) | Return 409. Old keys aren't reusable. iOS must generate a fresh key (new timestamp). |
| Any state, **different customer** | Return 409. Never let one user replay another user's order — even with a guessed idempotency key. |

The unique constraint on `orders.idempotency_key` is what guarantees the lookup is unambiguous. Race condition: two simultaneous requests with the same key — one wins the INSERT, the other gets a unique-violation. We could catch and retry the lookup, but the simpler answer is "a single client doesn't generate the same key twice in the same millisecond" — `Date.now()` has 1ms resolution, the cart-id sort is deterministic, and `userId` is fixed per customer.
