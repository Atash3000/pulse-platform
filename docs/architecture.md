# Architecture — the five core flows

This is the operational reference. If a flow described here disagrees with the code, the code is the bug.

## 1. Checkout and payment flow

The flow from "customer taps Checkout" to "order_status = PAID."

1. iOS computes `idempotencyKey = SHA256(userId + sortedCartItemIds + timestamp)`.
2. iOS posts `{locationId, idempotencyKey, items, tipPercent, pickupType, scheduledPickupAt?, notes?}` to `POST /api/v1/checkout` with the customer JWT.
3. **Backend, step 1 — idempotency check.** Look up the key in `orders`. If found with `payment_status = SUCCEEDED`, return the cached success payload (200, `clientSecret = ""`). If found with `REQUIRES_PAYMENT` or `PROCESSING`, return 409 `PAYMENT_IN_FLIGHT`.
4. **Backend, step 2 — location validation.** Call `HoursService.canAcceptOrders()` (paused → closed today → outside hours → SCHEDULED gate). Reject with 400 + structured reason on failure.
5. **Backend, step 3 — item validation.** For every cart line, load the menu item from the DB and confirm `active = true` and the item belongs to a category at the requested location. For every modifier ID, load it and confirm it belongs to a `modifier_group` of that menu item and is active. **Backend prices replace iOS prices entirely.**
6. **Backend, step 4 — pricing.** `PricingService.validateTipPercent()`, then `PricingService.calculateOrder()`. All math is integer cents.
7. **Backend, step 5 — atomic transaction.** Re-check inventory for every item *inside* the transaction (a different customer or a sold-out toggle could have flipped between step 3 and now). Insert the order with `order_status=DRAFT`, `payment_status=REQUIRES_PAYMENT`, all cents fields, and the idempotency key. Insert `order_items` with frozen snapshots of `item_name`, `unit_price_cents`, and modifier `{name, priceCents}` triples. Insert an `order_events` row for the DRAFT creation. Call Stripe `paymentIntents.create({amount, metadata:{orderId, customerId}})`. On success, update the order to `order_status=PENDING_PAYMENT`, persist `stripe_payment_id`, insert another `order_events` row. **Commit.**
8. **Backend, step 6 — return** `{orderId, clientSecret, totalCents, display}` to iOS.
9. iOS confirms the PaymentIntent with the Stripe SDK (Apple Pay or saved card).
10. Stripe POSTs `payment_intent.succeeded` to `POST /api/v1/payments/webhook`.
11. **Webhook — signature verification.** Verify `Stripe-Signature` against the raw body. Anything else → 400.
12. **Webhook — atomic outbox transaction.** `SELECT … FOR UPDATE` the order. If `payment_status = SUCCEEDED` already, idempotent return. Otherwise set `order_status=PAID, payment_status=SUCCEEDED, stripe_payment_id=<pi.id>`. Insert `order_events (from=PENDING_PAYMENT, to=PAID, created_by='stripe-webhook', metadata={stripe_event_id, payment_intent_id, request_id})`. Insert `payments` with the full Stripe response in JSONB. **Insert `outbox_events (event_type=ORDER_PAID, status=PENDING)` in the same transaction.** Commit.
13. The outbox worker picks up the row within ~1 second. **Phase 1** dispatch path:
    - Log "Clover sync deferred to Phase 2 for order {orderId}" — Clover is NOT called in Phase 1.
    - Update `customers.last_visit_at = NOW()`.
    - Emit structured analytics log line.
    - (Future) Telegram "new order" alert — currently a stub on the notifications module.
    - Mark outbox row `PROCESSED`.

The customer sees confirmation as soon as step 12 commits. Step 13 is async.

**Abandoned-checkout cleanup.** If the customer never confirms in step 9 (closes the app, loses network, walks away), the order stays at `PENDING_PAYMENT` and steps 10–13 never fire. A scheduled task — `PendingPaymentCleanupTask` in `modules/orders/` — runs every 5 minutes and transitions any `PENDING_PAYMENT` order older than 30 minutes to `FAILED` with reason `"abandoned at checkout"`. It best-effort cancels the underlying Stripe PaymentIntent first. No outbox event is emitted: there's nothing to refund and a "your order was cancelled" push to a customer who already abandoned would be confusing. iOS polling discovers the FAILED state on its next request and stops polling. See `docs/decision-log.md` for the why.

**Phase 2** dispatch path will additionally include a real Clover REST call with retries and a "your coffee is ready" push notification on `ORDER_READY`. See the decision log for why those are out of scope today; the staff dashboard handles operational order management in Phase 1.

## 2. The outbox pattern

**The disaster it prevents:** a "naive" implementation looks like this:

```
UPDATE orders SET status='PAID'   ← DB succeeds
await sqs.publish('ORDER_PAID')   ← network blip; throws.
```

Result: order is paid, Clover is never notified, customer is never push-notified, owner is never alerted. Nothing in the system retries because nothing knows the SQS publish failed. Money was taken; the operational loop never closed.

**What the outbox pattern does:** the event-publish intent is written to the database in the same transaction as the state change.

```
BEGIN
  UPDATE orders SET order_status='PAID'
  INSERT outbox_events (event_type='ORDER_PAID', status='PENDING', payload=…)
COMMIT     ← both happen, or neither happens. Atomic.
```

A separate poller (the outbox worker) reads `outbox_events WHERE status='PENDING'` every second and publishes them to SQS. If publishing fails, the row stays `PENDING` and the worker retries on the next tick. After 5 failed attempts the row becomes `DEAD` and the owner gets a Telegram alert.

The price: a database write per event, ~1-second event latency. The benefit: nothing is silently lost. For payment-driven workflows that's the right trade.

## 3. Clover sync flow — PHASE 2 (NOT ACTIVE IN PHASE 1)

> **Phase 1 status:** Clover sync is **deferred to Phase 2**. `OrderWorker.handleOrderPaid` does not call Clover; every Phase 1 order keeps `clover_sync_status = NOT_SENT` and the staff dashboard is the operational order management surface. This section describes the Phase 2 design — keep it for reference but do not implement until Phase 2 is explicitly started. See `docs/decision-log.md`.

Triggered by `ORDER_PAID` consumed from SQS by `clover.worker`.

1. `attempts = 0`. Delays: `[0s, 30s, 2min, 10min]`.
2. For each delay: sleep, then `POST https://api.clover.com/v3/merchants/{merchantId}/orders` with the order payload.
3. **Success** → `UPDATE orders SET clover_sync_status='SENT', clover_order_id=<clover_id>`. Insert `clover_sync_log (attempt_number, sync_status='SENT', request_payload, response_payload)`. Done.
4. **Failure** → insert `clover_sync_log (attempt_number, sync_status='FAILED', error_message)`. If this was the last delay (attempt 4), set `clover_sync_status='MANUAL_REQUIRED'` and send a Telegram alert to the owner:
   ```
   CLOVER SYNC FAILED — MANUAL ACTION REQUIRED
   Order: <id> | Customer paid: YES | In Clover POS: NO
   Enter manually in Clover terminal.
   ```
   The `OrderStatus` and `PaymentStatus` are **NOT** changed. The customer paid; the order still exists; only the POS sync failed.

The dead-letter queue catches `ORDER_PAID` events that themselves fail to be consumed (Clover API down for >13 minutes total, our worker crash-looping, etc.). DLQ messages also trigger an owner Telegram alert.

## 4. The three-status system

Three completely independent enums on the `orders` table:

| Enum | Source of truth | Purpose |
|---|---|---|
| `OrderStatus` | The state machine — set by checkout, webhook, staff actions | Where the order is in the customer/staff lifecycle: DRAFT → PENDING_PAYMENT → PAID → ACCEPTED → IN_PROGRESS → READY → PICKED_UP. |
| `PaymentStatus` | Stripe (via webhook) — `REQUIRES_PAYMENT`, `PROCESSING`, `SUCCEEDED`, `FAILED`, `REFUNDED`, `PARTIALLY_REFUNDED` | What Stripe has confirmed about the money. Only the webhook sets this. |
| `CloverSyncStatus` | The Clover worker — `NOT_SENT`, `PENDING`, `SENT`, `FAILED`, `MANUAL_REQUIRED` | Whether the POS has received the order. |

They fail independently. **The canonical example: `CloverSyncStatus = MANUAL_REQUIRED` does not mean the order failed.**

> **Phase 1 reality:** Clover is deferred to Phase 2, so every Phase 1 order is `clover_sync_status = NOT_SENT` for its entire lifetime — that is correct, not a problem. `MANUAL_REQUIRED` is a Phase 2 terminal state and won't appear in Phase 1 data.

In Phase 2, after a successful payment whose Clover sync exhausted all retries, the row would read:
```
order_status        = PAID
payment_status      = SUCCEEDED
clover_sync_status  = MANUAL_REQUIRED
```

The customer paid. The order is real. The receipt is owed. Staff would get a Telegram alert and enter the order into the Clover terminal by hand. The platform doesn't refund, doesn't cancel, doesn't change the order status — none of those are appropriate responses to a POS API outage.

UI rules:
- iOS shows order status from `OrderStatus`. The customer never sees `CloverSyncStatus`.
- Staff dashboard shows all three. Manager+ sees the alert badge for `MANUAL_REQUIRED`.

## 5. Menu cache flow with tracking-set invalidation

Two key types in Redis:

```
menu:full:{locationId}      STRING  JSON of the full menu tree     TTL 600s
menu:item:{itemId}          STRING  JSON of one item with mods    TTL 600s
menu:items:loc:{locationId} SET     item ids cached for that loc   TTL 600s
```

**Read path:**

- `GET /menu` → look up `menu:full:{loc}`. Hit → return. Miss → query DB, build JSON, `SET` with TTL, also implicitly populate the tracking set on item-detail calls.
- `GET /menu/items/:id` → look up `menu:item:{id}`. Hit → return. Miss → query DB, `SET` the item, **also `SADD` the item id into `menu:items:loc:{loc}`** so we can find it again.

**Invalidation path** (`MenuService.invalidate(locationId)`):

```
SMEMBERS menu:items:loc:{locationId}    ← the ids we cached
DEL menu:full:{locationId}
DEL menu:item:{x}                       ← for each id from above
DEL menu:items:loc:{locationId}
```

All in one Redis pipeline.

**Why `SCAN` was rejected.** The obvious alternative is `SCAN MATCH menu:item:*` to find all per-item keys. That's bad for two reasons:

1. `SCAN` walks the entire keyspace. On a shared Redis at scale (think 100k keys for menus, sessions, idempotency, etc.), each `SCAN` becomes a noisy neighbour that slows down every other tenant. There's no `SCAN MATCH` index.
2. We don't know which items belong to which location without parsing the JSON value of every match. Even an item-key naming scheme like `menu:item:{loc}:{id}` would prevent cross-location item lookups.

The tracking set is O(N items cached for this location), runs in one pipeline, and shares no state with anyone else's keys. It's a sliding TTL — every `setItem` call refreshes the set's TTL — so if a location goes idle, the set expires alongside the data.

Inventory toggles, Clover menu imports, and (Phase 2) dynamic-pricing flips all call `MenuService.invalidate(locationId)`.
