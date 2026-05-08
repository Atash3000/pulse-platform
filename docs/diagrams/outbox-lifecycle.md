# Outbox event lifecycle

Operational reference for the on-call engineer at 2 AM. If a row in `outbox_events` is in a state you don't understand, this is the diagram.

## State machine

```
                              ┌──────────────────────────────────┐
                              │                                  │
                              │   (insert from inside same DB    │
                              │    transaction as the order      │
                              │    state change — atomic)        │
                              │                                  │
                              ▼                                  │
                       ┌──────────────┐                          │
                       │              │                          │
                       │   PENDING    │                          │
                       │   attempts=0 │                          │
                       │              │                          │
                       └──────┬───────┘                          │
                              │                                  │
              ┌───── poll tick (every 1s, picks up to 10) ───────┤
              │                                                  │
              ▼                                                  │
              ┌──────────────────────────────────────────────┐   │
              │ processOne(event):                           │   │
              │   1. UPDATE processing_started_at = NOW()    │   │
              │   2. dispatch(event)  ←──── may throw        │   │
              │   3. markProcessed OR handleFailure          │   │
              └──────────────┬───────────────────────────────┘   │
                             │                                   │
                ┌────────────┼────────────┐                      │
                │            │            │                      │
            success      failure      failure                    │
            (no throw)  (attempts<5) (attempts==5 after ++)      │
                │            │            │                      │
                ▼            ▼            ▼                      │
        ┌──────────────┐ ┌────────────┐ ┌──────────────────┐     │
        │              │ │            │ │                  │     │
        │  PROCESSED   │ │  PENDING   │ │      DEAD        │     │
        │  attempts=N  │ │  attempts++│ │   attempts=5     │     │
        │  processed_at│ │  last_error│ │   last_error set │     │
        │  last_error  │ │            │ │   Telegram alert │     │
        │  cleared     │ │            │ │                  │     │
        │              │ │            │ │                  │     │
        └──────────────┘ └─────┬──────┘ └────────┬─────────┘     │
            (terminal)         │                 │               │
                               └─ next tick ─────┘               │
                                                                 │
                                                  retryDead() ───┘
                                                  (admin action)
```

## States

### `PENDING`

The starting state. The Stripe webhook (or any future producer) inserted this row inside the same transaction as the state change it describes. The outbox worker has not yet picked it up — or has picked it up and a previous attempt failed without exhausting the retry budget.

| Field | Meaning |
|---|---|
| `attempts` | Number of failed attempts so far (0 on the very first pickup). |
| `processing_started_at` | NULL on first pickup; set to the timestamp of the most recent attempt on every retry. |
| `processed_at` | NULL. |
| `last_error` | NULL on first pickup; the error message from the most recent failed attempt thereafter. |

### `PROCESSED`

Terminal happy state. The dispatch ran cleanly, the side effects committed, the row is closed.

| Field | Meaning |
|---|---|
| `attempts` | The total count of *failed* attempts before the successful one. 0 means it succeeded on the first try. Non-zero means we recovered after some retries — useful forensics, retained intentionally. |
| `processing_started_at` | The pickup time of the successful attempt. |
| `processed_at` | The completion time of the successful attempt. |
| `last_error` | NULL — explicitly cleared on success. |

### `DEAD`

Terminal failure state. Five attempts have failed in a row. The on-call has been Telegram-alerted. **Manual intervention is required.**

| Field | Meaning |
|---|---|
| `attempts` | Always 5. |
| `processing_started_at` | The pickup time of the fifth (final) attempt. |
| `processed_at` | NULL (the work never completed). |
| `last_error` | The error message from the fifth attempt — usually the same as previous attempts. |

## Transition rules

| From → To | Trigger | What changes |
|---|---|---|
| `(insert)` → `PENDING` | Producer transaction commits with the outbox row. | Row exists, `status=PENDING`, `attempts=0`, all other fields NULL. |
| `PENDING` → `PENDING` (attempts++) | `dispatch()` threw and `attempts < 5`. | `attempts += 1`, `last_error = error.message[:1000]`. `processing_started_at` was already set this tick. |
| `PENDING` → `PROCESSED` | `dispatch()` returned without throwing. | `status=PROCESSED`, `processed_at=NOW()`, `last_error=NULL`. |
| `PENDING` → `DEAD` | `dispatch()` threw and the new `attempts == 5`. | `status=DEAD`, `attempts=5`, `last_error` set. Telegram alert fires (best-effort; alert failure does NOT undo DEAD). |
| `DEAD` → `PENDING` | `OutboxWorker.retryDead(eventId)` after a human resolves the underlying issue. | `status=PENDING`, `attempts=0`, `last_error=NULL`, `processed_at=NULL`. `processing_started_at` is left alone — historical forensic data. |
| `PROCESSED` → anything | Never. `PROCESSED` is terminal. | A new event with a new id is inserted if the work needs to happen again. |

## Latency observation

With `processing_started_at` populated, you can split the total delivery latency into two components for monitoring:

```sql
SELECT
  ROUND(AVG(EXTRACT(EPOCH FROM (processing_started_at - created_at))            * 1000)) AS avg_queue_latency_ms,
  ROUND(AVG(EXTRACT(EPOCH FROM (processed_at         - processing_started_at)) * 1000)) AS avg_processing_latency_ms,
  ROUND(MAX(EXTRACT(EPOCH FROM (processed_at         - created_at))            * 1000)) AS p100_total_latency_ms,
  COUNT(*)                                                                              AS sample_size
FROM outbox_events
WHERE status = 'PROCESSED'
  AND created_at > NOW() - INTERVAL '1 hour';
```

Healthy numbers (single-pod, 1s poll interval, low load):
- queue latency: 0–1000 ms (typical: 300–600 ms).
- processing latency: 5–50 ms for `ORDER_PAID` (Clover stub + one UPDATE + one log line).

If queue latency creeps up while processing latency stays low → the worker isn't getting CPU time, or there's a query cost on the `(status, created_at)` index that didn't exist before. Run `EXPLAIN` on the `tick()` query.

If processing latency spikes → look at downstream timing. The Clover sync stub doesn't take 50ms today, but the real one will, and that's the line that goes red first when Clover is degraded.

## Stuck-row detection

A row in `PENDING` with `processing_started_at` set but `processed_at` still NULL for more than ~30 seconds means the worker picked it up but never finished — probably crashed mid-process or hung. Detection query:

```sql
SELECT id, event_type, attempts, processing_started_at,
       NOW() - processing_started_at AS stuck_for
FROM outbox_events
WHERE status = 'PENDING'
  AND processing_started_at IS NOT NULL
  AND processed_at IS NULL
  AND processing_started_at < NOW() - INTERVAL '30 seconds';
```

Resolution: in single-pod operation, restart the worker — `OnModuleInit` will resume polling and the row will be retried (since `dispatch()` was never confirmed, the next pickup re-runs it; the side effects need to be idempotent, which they are by design — see `apps/api/src/modules/payments/README.md` on idempotency). When multi-pod ships with `FOR UPDATE SKIP LOCKED`, this query returns the empty set under normal operation because a crashed task's transaction rolls back and another task picks the row up immediately.

## What `DEAD` is NOT

- **Not "the order failed."** The customer's payment is in the `orders` and `payments` tables, status `PAID` / `SUCCEEDED`. The DEAD outbox row only means the *side effects* (Clover sync, push notification, etc.) didn't fire.
- **Not "automatically retryable."** The worker has decided this row needs human eyes. Set `status='PENDING', attempts=0` only after diagnosing the root cause, or you'll thrash through the retry budget again in 5 seconds.
- **Not safe to delete.** Each DEAD row is a documented promise the platform made and didn't keep. Keep them for ledger reconciliation.
