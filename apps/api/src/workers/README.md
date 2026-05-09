# `workers/`

Background processes that consume rows from `outbox_events` and dispatch the side effects each event represents (loyalty points, push notifications, Clover sync, Telegram alerts, etc.).

## Status

**Built:**
- `outbox.worker.ts` — polls `outbox_events` every 1 second, claims `PENDING` rows under `FOR UPDATE SKIP LOCKED`, dispatches each, marks `PROCESSED` or progresses toward `DEAD`. Multi-pod safe.
- `order.worker.ts` — handles `ORDER_PAID`. Loads the order from the database (payload only carries `orderId`), logs the Clover-deferred line, updates `customers.last_visit_at`, emits a structured analytics log.

**Scheduled tasks (live in their owning module, not in `workers/`):**
- `modules/orders/pending-payment-cleanup.task.ts` — runs every 5 minutes (`@Cron(CronExpression.EVERY_5_MINUTES)`). Reaps orders abandoned at checkout: any `PENDING_PAYMENT` order older than 30 minutes is transitioned to `FAILED` with reason `"abandoned at checkout"`. Best-effort cancels the underlying Stripe PaymentIntent first. Uses the same `FOR UPDATE SKIP LOCKED` claim pattern as the outbox worker and is gated by the same `WORKERS_ENABLED` env var, so it's multi-pod safe and only runs on dedicated worker tasks. No outbox event is emitted — the customer never paid, so there's nothing to refund or notify about.

**Phase 1 stance on Clover:** **DEFERRED TO PHASE 2.** `OrderWorker.handleOrderPaid` does NOT call `CloverSyncService.syncOrder()`. Every Phase 1 order keeps `clover_sync_status = NOT_SENT` from creation through pickup, and that is the expected and correct state. Operational order management lives in the staff dashboard (`POST /admin/orders/:id/{accept,progress,ready,picked-up}`) — staff handle mobile orders directly there in Phase 1, no POS sync required.

**Stubs the workers depend on:**
- `TelegramService` — logs `[telegram-stub]`. Real bot delivery wires up with the notifications module. Used today for DEAD-event alerts only.

**Retained for Phase 2 (do not delete):**
- `CloverSyncService.syncOrder()` — exists, logs only, never called from `OrderWorker` in Phase 1.
- `CloverModule`.
- `clover_sync_status`, `clover_order_id`, `clover_item_id`, `clover_mod_id` columns.
- `clover_sync_log` table.
- `CloverSyncStatus` enum.

When Phase 2 starts, the change is one line in `OrderWorker.handleOrderPaid` (replace the deferral log with the real call) plus the actual `CloverSyncService` implementation. No migrations needed.

## Architecture in two sentences

Workers are NOT a separate ECS task family yet. They run inside the same Node process as the API via NestJS `OnModuleInit`. The `WORKERS_ENABLED` env gate exists so a future deployment can run one dedicated worker task and N API tasks without all of them polling.

There's no SQS in the path today. Earlier drafts of this doc described a fan-out via SQS queues; that turned out not to be necessary for Phase 1 — direct in-process dispatch from the outbox worker to the order worker is simpler and gives us the same delivery guarantees because the outbox transaction is what makes events durable. SQS reappears if/when we split workers across multiple processes.

## Concurrency model

```
                                     ┌──────────────────────────────┐
                                     │   outbox_events table        │
                                     │   (status, created_at) idx   │
                                     └──────────────┬───────────────┘
                                                    │
                  ┌─────────────────────────────────┼─────────────────────────────────┐
                  │                                 │                                 │
        ┌─────────▼──────────┐         ┌────────────▼────────┐         ┌──────────────▼──────┐
        │   pod 1 (worker)   │         │   pod 2 (worker)    │   …     │   pod N (worker)    │
        │  every 1s tick:    │         │  every 1s tick:     │         │  every 1s tick:     │
        │  BEGIN             │         │  BEGIN              │         │  BEGIN              │
        │  SELECT … FOR      │         │  SELECT … FOR       │         │  SELECT … FOR       │
        │  UPDATE SKIP       │         │  UPDATE SKIP        │         │  UPDATE SKIP        │
        │  LOCKED LIMIT 10   │         │  LOCKED LIMIT 10    │         │  LOCKED LIMIT 10    │
        │   ↓ rows {1..10}   │         │   ↓ rows {11..20}   │         │   ↓ rows {21..30}   │
        │  dispatch each     │         │  dispatch each      │         │  dispatch each      │
        │  UPDATE → PROCESSED│         │  UPDATE → PROCESSED │         │  UPDATE → PROCESSED │
        │  COMMIT            │         │  COMMIT             │         │  COMMIT             │
        └────────────────────┘         └─────────────────────┘         └─────────────────────┘
```

Each pod's transaction holds row-level locks on the rows it claimed. `SKIP LOCKED` makes locked rows invisible to the other pods' identical query — they grab the next batch instead. Two pods never see the same row.

The `isProcessing` flag inside each pod prevents a slow tick from overlapping with the next 1-second interval fire — purely intra-process; the multi-pod safety comes from the database lock.

**Trade-off:** dispatch happens INSIDE the txn, so the row locks are held for the duration of dispatch. For Phase 1's sub-second in-process work (one DB load, one DB update, one log line) this is invisible. When dispatch goes external (real Clover REST call with a 10-second timeout) we'll switch to a claim-then-process pattern — the `processing_started_at` column already supports stuck-row recovery for that future change.

## Env gates

| Variable | Default | Purpose |
|---|---|---|
| `WORKERS_ENABLED` | `true` | If `false`, `OutboxWorker.onModuleInit` skips starting the polling interval. The application boots normally, just without the worker. |
| `API_ENABLED` | `true` | If `false`, `main.ts` skips `app.listen` so the HTTP port stays closed but the Nest application initialises and `OnModuleInit`-driven workers run. |

**Typical deployments:**

```
single task (Phase 1, current dev)
  API_ENABLED=true   WORKERS_ENABLED=true   ← both run in the same process

API replicas (Phase 1, when desiredCount > 1)
  API tasks:    API_ENABLED=true   WORKERS_ENABLED=false
  Worker task:  API_ENABLED=false  WORKERS_ENABLED=true   ← exactly one
```

If you forget the gates and run two API replicas with both `WORKERS_ENABLED=true`, **the SKIP LOCKED query keeps you safe** — both pods will run, but they'll see disjoint row sets. The gates exist so we don't waste CPU running redundant pollers, not because correctness depends on them.

## The three event-handler tiers

### `outbox.worker.ts`

The poller. Doesn't know about Clover, push, or Telegram — it knows about `outbox_events` rows and the `OrderWorker` (and, eventually, sibling workers). The dispatch switch lives here.

For unimplemented event types the worker logs a warning and marks the row `PROCESSED`:

```
no handler registered for event type ORDER_READY; marking PROCESSED (event_id=…)
```

This matters operationally for `ORDER_READY` specifically — see "What's not active yet" below.

### `order.worker.ts`

`ORDER_PAID` handler. The payload carries only `orderId`; `customerId`/`locationId`/`totalCents` are loaded from the database so side effects always reflect the CURRENT state of the order, not whatever was true when the outbox row was written. This protects against race conditions where the order is amended (refund, status correction) between the outbox-write and the worker pickup.

Phase 1 side effects:
1. **No Clover call.** A single log line: `Clover sync deferred to Phase 2 for order {orderId}`. See decision log.
2. `customers.last_visit_at = NOW()` for the order's customer.
3. Structured analytics log (one JSON line, ready for CloudWatch Insights / PostHog).

Phase 2 will add the real `CloverSyncService.syncOrder()` call as step 1, replacing the deferral log.

### Future siblings (not yet built)

When the notifications module ships, it'll register handlers for `ORDER_READY`, `ORDER_CANCELLED`, `REFUND_CREATED`, `ITEM_OUT_OF_STOCK` directly in the dispatch switch (or via a registry pattern). Same `outbox_events` table, same worker, additional `case` branches.

## What's not active yet

These outbox events fire correctly (rows land in the table with `status=PENDING`) but their downstream side effect doesn't happen until the relevant module ships:

| Event | Currently | Becomes active when |
|---|---|---|
| `ORDER_PAID` | Customer's `last_visit_at` is updated. Analytics log emitted. **No Clover call** — Clover deferred to Phase 2. | Phase 2 starts → real Clover order created. |
| `ORDER_CANCELLED` | Marked `PROCESSED` with no side effect. | Notifications module ships → push + Telegram. |
| `ORDER_READY` | Marked `PROCESSED` with no side effect. **Customers do not get a "your coffee is ready" push.** They learn via polling `GET /orders/:id`. | Notifications module ships → APNs push. |
| `ORDER_PICKED_UP` | Marked `PROCESSED` with no side effect. | Analytics module — close-of-loop event for retention metrics. |
| `REFUND_CREATED` | Marked `PROCESSED` with no side effect. | Notifications module → confirmation push + Telegram. |
| `ITEM_OUT_OF_STOCK` | Marked `PROCESSED` with no side effect. (The menu cache is invalidated synchronously by the admin endpoint that toggled the item — this outbox event is for the future Telegram alert.) | Notifications module → Telegram. |

**The most operationally visible gap is `ORDER_READY`**: today's flow tells the barista to mark the order ready, the outbox row lands, the worker marks it processed, and the customer keeps polling. Once the notifications module exists, the same flow ends with a push.

## Retry sequence and DEAD

Same as before — `tick()` runs every second; each pickup either succeeds and is marked `PROCESSED`, or fails and the row's `attempts` counter increments with the error message in `last_error`. After 5 failed attempts the row becomes `DEAD`, the Telegram-stub alert fires, and the lifecycle is over until a human runs `OutboxWorker.retryDead(eventId)`.

`retryDead(eventId)` resets exactly four fields on the matching DEAD row: `status` back to `PENDING`, `attempts` to `0`, `last_error` to `null`, and `processed_at` to `null`. `processing_started_at` is intentionally left alone — it's historical forensic data showing when the failed attempt began. The next worker tick picks the row up like a fresh PENDING event. Run this only AFTER you've diagnosed and fixed the root cause; otherwise the row burns through five attempts and dies again within seconds.

The full state machine, with timing observations, is in `docs/diagrams/outbox-lifecycle.md`.

## Stuck-row recovery

`processing_started_at` is set the moment the worker picks up a row, BEFORE dispatch. A row with `status=PENDING, processing_started_at IS NOT NULL, processed_at IS NULL` for more than ~30 seconds means the worker picked it up but never finished — process crash, hung downstream call, etc. The recovery query is in `docs/diagrams/outbox-lifecycle.md`. Single-pod resolution: restart the worker. Multi-pod (with SKIP LOCKED) resolution: the in-flight transaction's locks are released on connection drop and another pod picks the row up.

## Why no SQS

The original spec described an SQS-based fan-out (`outbox.worker → SQS → order.worker / clover.worker`). We removed it because:

- For Phase 1 the producers and consumers are all in the same Node process. Adding SQS adds an external dependency and ~50ms of round-trip per event for no functional gain.
- The durability and at-least-once guarantee come from the `outbox_events` table, not from SQS. SQS is a transport, not a queue-of-record.
- When workers split into separate ECS tasks (Phase 2-ish), we re-evaluate. The decision-log will gain an entry at that point.

Multi-pod safety today comes from `FOR UPDATE SKIP LOCKED` on the table directly. That's enough.
