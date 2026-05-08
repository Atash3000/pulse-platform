# Glossary

Every domain term used in the Pulse Platform codebase, defined once.

---

## OrderStatus

The customer/staff lifecycle of an order. PostgreSQL `order_status_enum`.

| Value | Means |
|---|---|
| `DRAFT` | Order row inserted; PaymentIntent not yet created. Transitional, exists for milliseconds inside the checkout transaction. |
| `PENDING_PAYMENT` | Stripe PaymentIntent created and returned to iOS. Awaiting customer's confirmation in the Stripe sheet. |
| `PAID` | Stripe webhook confirmed payment. Set ONLY by `POST /api/v1/payments/webhook`. |
| `ACCEPTED` | Staff accepted the order in the dashboard. Barista has it in hand. |
| `IN_PROGRESS` | Barista started preparing the order. |
| `READY` | Barista marked the order ready. Push notification dispatched: "Your coffee is ready." |
| `PICKED_UP` | Customer collected the order. Terminal happy state. |
| `CANCELLED` | Cancelled by the customer (only from DRAFT) or by staff (manager+ from any pre-PAID state). |
| `REFUNDED` | Full refund issued via Stripe. The original `OrderStatus` history is preserved in `order_events`. |
| `FAILED` | Payment declined or unrecoverable error during checkout. |

## PaymentStatus

What Stripe has confirmed about the money. PostgreSQL `payment_status_enum`. **Only the Stripe webhook sets this.**

| Value | Means |
|---|---|
| `REQUIRES_PAYMENT` | Initial state. PaymentIntent created. |
| `PROCESSING` | Stripe is processing the payment (some payment methods take time). |
| `SUCCEEDED` | Stripe confirmed receipt of funds. Only valid signal to set `OrderStatus = PAID`. |
| `FAILED` | Payment declined or errored. |
| `REFUNDED` | Full refund issued. |
| `PARTIALLY_REFUNDED` | Partial refund — see `refunds` table for the exact amount and reason. |

## CloverSyncStatus

Whether the Clover POS has received the order. PostgreSQL `clover_sync_status_enum`. **Independent of OrderStatus and PaymentStatus.**

| Value | Means |
|---|---|
| `NOT_SENT` | Default. Sync hasn't started. |
| `PENDING` | In the Clover sync worker queue. |
| `SENT` | Clover acknowledged the order. The barista will see it on the POS terminal alongside walk-in orders. |
| `FAILED` | At least one attempt failed. The worker is retrying with backoff. |
| `MANUAL_REQUIRED` | All four retries (0s, 30s, 2min, 10min) exhausted. The owner has been Telegram-alerted; staff enter the order in the Clover terminal by hand. |

**`MANUAL_REQUIRED` does NOT mean payment failed.** The customer paid. The order is real. The receipt is owed. It means *only* that the Clover API was unreachable for >13 minutes total and the platform decided to stop retrying. Refunding or cancelling the order is the wrong response.

## Outbox Pattern

Critical events (`ORDER_PAID`, `REFUND_CREATED`, etc.) are written into a database table (`outbox_events`) **inside the same transaction** as the state change they describe. A separate worker polls the table and dispatches them downstream.

In plain English: instead of "update the row, then publish the event" — which can lose the event if the publish fails after the update commits — we write "I owe a publish for X" into the same database commit as the update. A poller does the actual publish. If the publish fails, the row stays `PENDING` and the poller retries. After 5 failed attempts the row becomes `DEAD` and the owner is alerted.

The pattern's job is to make event delivery as durable as the database write. We accept ~1 second of latency in exchange for the guarantee that nothing is silently lost.

## Location Availability

The set of conditions checked by `HoursService.canAcceptOrders()`. All five must pass for an order to be accepted; iOS calls this endpoint before showing the checkout button.

1. `location_settings.mobile_ordering_paused` must be false.
2. For ASAP: today's `location_hours.is_closed` must be false.
3. For ASAP: current time must fall within today's `open_time .. close_time`.
4. For SCHEDULED: `location_settings.scheduled_ordering` must be true; `scheduledPickupAt` must fall within open hours of that day; `scheduledPickupAt` must be ≤ `max_schedule_days` from now.
5. The location itself must be `active = true`.

## Idempotency Key

A 32-128 character client-generated string accompanying every checkout. iOS computes it as `SHA256(userId + sortedCartItemIds + timestamp)`. Stored in `orders.idempotency_key` with a unique constraint.

Behaviour on duplicate keys:
- Existing order with `payment_status = SUCCEEDED` → 200 with the cached payload (`clientSecret = ""`). Safe replay.
- Existing order with `payment_status` in `{REQUIRES_PAYMENT, PROCESSING}` → 409 `PAYMENT_IN_FLIGHT`. Client should wait for the webhook, not retry.
- Same key from a different `customer_id` → 409. (Never lets one user replay another's order.)
- Existing order in `FAILED` or `REFUNDED` → 409. Old keys aren't reusable; iOS generates a new key for a new attempt.

## Tracking Set

A Redis `SET` named `menu:items:loc:{locationId}` that records every item-cache key currently populated for that location. `MenuCache.setItem()` adds the item id; `MenuCache.invalidateMenu()` reads the set with `SMEMBERS` and `DEL`s each tracked item key in one pipeline.

Exists because the obvious alternative — `SCAN MATCH menu:item:*` — is O(N over the whole Redis keyspace) and becomes a noisy neighbour at scale. See `docs/architecture.md` flow #5 and `docs/decision-log.md` for the full reasoning.

## Integer Cents

All monetary values are stored and computed as integers representing cents. `650` means $6.50.

- `INT NOT NULL` in Postgres for `*_cents` columns.
- `number` (32-bit-safe integers) in TypeScript.
- Display formatting (`(cents / 100).toFixed(2)`) happens only in the UI layer, never inside business logic.

Floats are explicitly forbidden in price calculations. They lose pennies on long-tail rounding and the loss compounds across orders to the point where you can't reconcile against the Stripe ledger.

## Basis Points

Used for tax rates. **1 basis point = 0.01%.** So 875 bps = 8.75%, 888 bps ≈ 8.875%. The formula:

```
taxCents = Math.round(taxableCents * tax_rate_bps / 10000)
```

The integer multiplication-then-divide stays inside JavaScript's safe integer range for any realistic order, and the `Math.round` happens *after* the integer math so we never accumulate float error. The spec example: `tax_rate_bps = 875` → 8.75%. NYC's 8.875% rounds to `888`.

(Note: do not write `tax_rate_bps = 8875` thinking it represents 8.875% — that produces 88.75% with the formula above. We've already corrected this once in the dev seed.)

## Modifier Group vs Modifier

A **modifier group** describes a *choice* attached to a menu item — e.g., "Size", "Milk", "Extras". Stored in `modifier_groups`. Has a `required` flag (must the customer pick one?) and a `multi_select` flag (can they pick more than one?).

A **modifier** is a single *option* inside that group — e.g., "Small", "Oat Milk", "Extra Shot". Stored in `modifiers`. Has a `price_cents` upcharge (often 0 or positive; never negative in Phase 1).

Schema relationship: `menu_items` 1—N `modifier_groups` 1—N `modifiers`. Checkout validates that every selected `modifierId` belongs to a `modifier_group` of the cart item it's attached to — that's the integrity check that prevents "attach the cheap-size modifier from a different drink to bypass pricing."

## Outbox Event Types

Six business-critical event types live in `outbox_events.event_type`:

| Event | Triggers |
|---|---|
| `ORDER_PAID` | Clover sync, push notification, loyalty points, Telegram alert, PostHog. |
| `ORDER_CANCELLED` | Stripe refund (if applicable), push, Telegram, analytics. |
| `ORDER_READY` | Push: "Your coffee is ready." |
| `ORDER_PICKED_UP` | Close order, analytics, update `customers.last_visit_at`. |
| `REFUND_CREATED` | Stripe refund call, order status update, push, Telegram. |
| `ITEM_OUT_OF_STOCK` | Hide from menu cache (call `MenuService.invalidate()`), Telegram alert. |

Anything that doesn't appear in this list is *not* a critical event and uses PostHog (analytics-only) instead of the outbox.
