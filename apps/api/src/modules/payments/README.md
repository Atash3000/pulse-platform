# `modules/payments`

Owns the Stripe webhook, the Stripe client, and the atomic outbox transaction that promotes an order from `PENDING_PAYMENT` to `PAID`.

## The Stripe webhook is the single source of payment truth

Three places in the system can speak about money:

- **iOS** — generates a PaymentIntent client secret via `POST /api/v1/checkout` and confirms it through the Stripe SDK.
- **The backend's `CheckoutService`** — creates the PaymentIntent inside the checkout transaction.
- **Stripe** — actually moves money.

Only the third one knows for certain whether the customer was charged. The webhook is Stripe's report of that fact, signed with a secret only Stripe and our server hold.

So `payment_status = SUCCEEDED` and `order_status = PAID` are set **exclusively** in `WebhookOrdersService.markPaidFromWebhook()` (in `webhook-orders.service.ts`), called from `PaymentsController.handleWebhook()` after signature verification. No other code path touches these columns. Not the iOS app, not the dashboard, not an admin endpoint, not a manual `UPDATE` we're tempted to slip in for a refund flow. Only the webhook.

The tradeoff: the customer sees "paid" in the iOS app a few hundred milliseconds *after* Stripe confirms, instead of immediately. That latency is acceptable because every other approach is broken.

## Why signature verification is mandatory

Without `Stripe-Signature` verification, `POST /api/v1/payments/webhook` is just an unauthenticated endpoint. An attacker who knows the URL — and the URL must be public for Stripe to call it — can `curl` it with a hand-crafted payload claiming any order has been paid:

```bash
curl -X POST https://api.pulsecoffee.com/api/v1/payments/webhook \
  -H 'Content-Type: application/json' \
  -d '{"type":"payment_intent.succeeded","data":{"object":{"id":"pi_attacker","metadata":{"orderId":"<their-order>"}}}}'
```

If we trusted the body, that order would flip to PAID with no money changing hands. The customer walks out with a free coffee.

Signature verification closes that hole. Stripe signs every request body with `STRIPE_WEBHOOK_SECRET` (different per environment). The library's `stripe.webhooks.constructEvent(rawBody, signature, secret)` recomputes the HMAC and rejects any tampered or forged body. Without the secret, the attacker can't produce a valid signature.

This is why `main.ts` is configured with `rawBody: true` — the signature is computed over the byte-for-byte request body, not the parsed JSON. A re-serialised JSON object has different whitespace and would fail the HMAC.

**Verification runs on every single webhook request.** No exceptions. Returning 400 on failure is the only valid 400 from this endpoint.

## Why the handler must be idempotent

Stripe retries webhooks under several conditions:

- The receiver (us) returns non-2xx.
- The receiver (us) takes longer than 10 seconds.
- A connection times out before Stripe sees the response.
- A network failure between Stripe and our load balancer.

Stripe's documented retry schedule is up to 3 days, with backoff. So in practice the same `evt_…` event can arrive 2-10 times. The handler must produce the same end state for every delivery — no double-charging the audit trail, no double-incrementing loyalty points, no double-publishing the outbox event.

The mechanism:

```ts
const order = await em.createQueryBuilder(Order, 'o')
  .setLock('pessimistic_write')
  .where('o.id = :id', { id: orderId })
  .getOne();

if (order.payment_status === PaymentStatus.SUCCEEDED) {
  return; // idempotent no-op
}
```

The `SELECT … FOR UPDATE` serialises concurrent webhook deliveries (two Stripe machines can deliver the same event a few ms apart). The `payment_status === SUCCEEDED` check exits cleanly when the event has already been processed. No second row in `order_events`, no second `outbox_events` insert, no second `payments` row.

`Payments` insert also uses `ON CONFLICT DO NOTHING` (`stripe_payment_id` is unique) as a belt-and-braces second line of defence in the unlikely event that two transactions race past the lock.

## Why the outbox event is in the same transaction as the status update

Because if it weren't, this could happen:

```
BEGIN
  UPDATE orders SET order_status='PAID'
COMMIT
                                ← network blip, our process crashes
await sqs.publish('ORDER_PAID') ← never runs
```

The order is now PAID in the database. Clover never gets notified, the customer never gets a push, the owner never gets a Telegram alert. The platform is silently broken for that order, and nothing in the system retries because nothing knows the publish failed.

By inserting `outbox_events (event_type='ORDER_PAID', status='PENDING')` *inside* the same transaction:

```
BEGIN
  UPDATE orders SET order_status='PAID'
  INSERT order_events (...)
  INSERT payments (...)
  INSERT outbox_events (status='PENDING', payload=...)
COMMIT
```

…the outbox row is durable as soon as the order update is durable. The outbox worker (a separate process, polling every 1s) reads pending rows, dispatches them to SQS, and marks them PROCESSED on success or DEAD after 5 failures. If our process crashes between the COMMIT and the SQS publish, the row stays `PENDING` and the next worker tick picks it up. Nothing is lost.

This is the entire reason `outbox_events` exists. Removing or relocating the insert outside the transaction defeats the purpose.

See `docs/architecture.md` flow #2 for the disaster diagram and `docs/golden-rules.md` rule #9.
