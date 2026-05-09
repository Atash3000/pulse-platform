# Troubleshooting

Diagnose-by-symptom runbook. Each section starts with what you'd see, then what to check.

---

## Stripe webhook succeeded but the order never reached Clover

> **Phase 1 status:** Clover integration is **deferred to Phase 2**. In Phase 1 every order keeps `clover_sync_status = NOT_SENT` from creation through pickup — that is the expected and correct state, not a bug. **Operational order management lives in the staff dashboard** (`POST /admin/orders/:id/{accept,progress,ready,picked-up}`); staff handle mobile orders directly from there with no POS sync involved. If a customer says "where's my order?" in Phase 1, the answer is in the dashboard, not the Clover terminal. See `docs/decision-log.md`.

The diagnosis steps below describe the **Phase 2** failure mode for when this section becomes relevant. Keep them for reference.

**What you'd see (Phase 2):** the customer paid, the iOS app shows the success screen, but the order isn't on the Clover terminal.

**Check, in order (Phase 2):**

1. **`outbox_events`** — was the `ORDER_PAID` row written?
   ```sql
   SELECT id, event_type, status, attempts, last_error, created_at, processed_at
   FROM outbox_events
   WHERE payload->>'orderId' = '<order-uuid>';
   ```
   - No row → the webhook handler's outbox transaction failed. Check Sentry for an exception inside `WebhookOrdersService.markPaidFromWebhook()`.
   - Row with `status = PENDING`, `attempts = 0` for >5 seconds → outbox worker isn't running. Check ECS task logs for the `outbox.worker` process.
   - Row with `status = DEAD` → the worker gave up after 5 attempts. `last_error` will tell you why. Owner has been Telegram-alerted.

2. **`clover_sync_log`** — did the Clover worker even try? *(Phase 2 only — table will be empty in Phase 1.)*
   ```sql
   SELECT attempt_number, sync_status, error_message, attempted_at
   FROM clover_sync_log
   WHERE order_id = '<order-uuid>'
   ORDER BY attempted_at;
   ```
   - No rows in Phase 2 → the outbox event was dispatched but `clover.worker` didn't pick it up. Check SQS queue depth and worker logs.
   - Rows showing all four attempts as FAILED, then `orders.clover_sync_status = MANUAL_REQUIRED` → Clover API was unreachable for >13 minutes total. Owner was Telegram-alerted; staff enter the order in the Clover terminal manually. **Do not refund or cancel.**

3. **Telegram alerts** — did the owner get an alert? *(Phase 2.)*
   ```
   CLOVER SYNC FAILED — MANUAL ACTION REQUIRED
   Order: <id> | Customer paid: YES | In Clover POS: NO
   ```
   - If yes, the system worked correctly. Manual entry is the resolution.
   - If no, check `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_CHAT_ID` in Parameter Store, and the `notifications.service` logs for delivery errors.

The customer's order is still valid. They paid; we owe them a coffee. Don't undo any state.

---

## Order is stuck in PENDING_PAYMENT

**What you'd see:** customer reports "I paid but the app still says processing." `SELECT order_status, payment_status FROM orders WHERE id=…` returns `(PENDING_PAYMENT, REQUIRES_PAYMENT)`.

> **Auto-cleanup expectation:** the `PendingPaymentCleanupTask` (`modules/orders/pending-payment-cleanup.task.ts`) runs every 5 minutes and transitions any `PENDING_PAYMENT` order older than **30 minutes** to `FAILED` with reason `"abandoned at checkout"`. So a stuck-PENDING_PAYMENT row that's <30 min old is the normal-but-still-pre-webhook case below; a row older than 30 min indicates the cleanup task isn't running or is misconfigured.

**Check, in order:**

1. **`payments` table** — is there a row for this order?
   ```sql
   SELECT stripe_payment_id, payment_status, created_at
   FROM payments WHERE order_id = '<order-uuid>';
   ```
   - No row → the Stripe webhook never fired. The customer may have abandoned the Stripe sheet, or the network may have failed before they confirmed.

2. **Stripe dashboard** — look up the PaymentIntent ID (it's in `orders.stripe_payment_id`).
   - PaymentIntent status `requires_payment_method` → customer never confirmed. The order naturally times out or can be cancelled by support.
   - PaymentIntent status `succeeded` but no webhook → the webhook delivery failed. Check Stripe dashboard → Developers → Webhooks for delivery attempts and error codes.
     - Common cause: `STRIPE_WEBHOOK_SECRET` mismatch. Each environment (local, staging, prod) uses a different secret. The Stripe CLI prints a brand new secret every time you run `stripe listen` — the dev `.env` must match the *currently running* listener.

3. **Manually replay the webhook** from Stripe dashboard → Developers → Events → "Resend" on the relevant `payment_intent.succeeded`. The handler is idempotent; safe to do.

---

## Menu shows stale prices after a price change

**What you'd see:** staff updated a `menu_items.base_price_cents` (or sold-out toggle) in the admin tool, iOS still shows the old value.

**Check, in order:**

1. **Did `MenuService.invalidate(locationId)` get called?**
   ```bash
   docker exec pulse-redis redis-cli KEYS 'menu:*'
   ```
   - If `menu:full:{locationId}` is still present, invalidation didn't run.
   - The admin endpoint that changes prices/inventory must call `MenuService.invalidate()` after the DB commit. If it doesn't, that's the bug — fix it at the source.

2. **TTL** — even without explicit invalidation, the cache expires after 600s.
   ```bash
   docker exec pulse-redis redis-cli TTL menu:full:<location-uuid>
   ```
   - If TTL is positive, you're inside the 10-minute stale window. Manually `DEL` the key to force a refresh, then add the missing `invalidate()` call so it doesn't recur.

3. **Item-detail cache** — also drop per-item keys:
   ```bash
   docker exec pulse-redis redis-cli SMEMBERS menu:items:loc:<location-uuid>
   ```
   These are the per-item cache entries for that location. `MenuService.invalidate()` clears them automatically; if you're DELing manually, `DEL menu:item:{x}` for each id and then `DEL menu:items:loc:{location}`.

---

## Migration fails on deploy

**What you'd see:** `npm run migration:run` exits with `error: type "..." already exists` (most commonly `payment_status_enum`) or fails on a `DROP TYPE` during rollback.

**Cause:** TypeORM 0.3's `migration:generate` emits **duplicate `CREATE TYPE`** for shared enums (an enum referenced by more than one column). The first migration to introduce a shared enum fails because `CREATE TYPE` runs twice; the rollback fails because `DROP TYPE` fires while a referencing table still uses it.

**Fix:**

1. Open the generated migration file under `apps/api/src/database/migrations/`.
2. In the `up()` method, find the duplicate `CREATE TYPE "public"."<enum>_enum" AS ENUM (...)` lines. Keep the **first** one; replace the duplicate with a `// already created above` comment.
3. In the `down()` method, find the early `DROP TYPE "public"."<enum>_enum"` calls that fire mid-flow (before all referencing tables are dropped). Move them to the very end so they run only after every referencing table is gone.
4. `1778273424632-InitialSchema.ts` shows the corrected pattern with explanatory comments — copy that approach.

**Prevention:** always read the generated migration before running it. Treat `migration:generate` as a first draft, never a finished artifact.

---

## Abandoned-checkout cleanup task isn't running

**What you'd see:** `PENDING_PAYMENT` orders older than 30 minutes are accumulating in the database. The task should reap them on a 5-minute cadence; if you see >100 of them, something is wrong.

**Check, in order:**

1. **Is the cleanup running on this pod?**
   - Look for `[PendingPaymentCleanupTask]` log lines. The task only logs when it actually reaps something (`reaped N abandoned order(s)`) or when there's an error. A silent worker is a worker that found nothing — that's normal during quiet periods.
   - On startup, if `WORKERS_ENABLED=false`, you'll see `WORKERS_ENABLED=false — pending-payment cleanup cron NOT firing (API-only mode)`. If the pod is supposed to run cleanup, fix the env var.

2. **Are there multiple pods with `WORKERS_ENABLED=true`?**
   - If yes, that's fine — the SKIP LOCKED claim ensures they don't double-process. But if `WORKERS_ENABLED=true` is set on every API replica plus the worker task, every API request shares CPU with the cron.
   - Recommended: `WORKERS_ENABLED=true` on exactly one ECS task family (the worker task), `WORKERS_ENABLED=false` on the rest.

3. **Manual force-sweep** (incident response):
   ```sql
   UPDATE orders
   SET order_status = 'FAILED', payment_status = 'FAILED'
   WHERE order_status = 'PENDING_PAYMENT'
     AND created_at < NOW() - INTERVAL '30 minutes'
   RETURNING id;

   INSERT INTO order_events (order_id, from_status, to_status, reason, created_by, metadata)
   SELECT id, 'PENDING_PAYMENT', 'FAILED', 'abandoned at checkout (manual sweep)', 'system', '{"manual": true}'::jsonb
   FROM orders WHERE order_status = 'FAILED' AND created_at < NOW() - INTERVAL '30 minutes' AND id NOT IN (
     SELECT order_id FROM order_events WHERE reason LIKE 'abandoned at checkout%'
   );
   ```
   Run inside a transaction. The `RETURNING` clause tells you how many were affected.

4. **Stripe-side cleanup of orphan PaymentIntents** (cosmetic):
   - The cleanup task tries to cancel the PI before transitioning. If Stripe was unreachable when the task ran, the order is FAILED in our DB but the PI is still confirmable in Stripe.
   - Stripe expires the PI on its own ~24 hours after creation; nothing to do unless Stripe-vs-our-ledger reconciliation flags it.

---

## Outbox event stuck or DEAD

**What you'd see:** a row in `outbox_events` with `status` other than `PROCESSED` more than a few seconds after it was created. Possibly a `[telegram-stub] DEAD OUTBOX EVENT` log line.

**Check, in order:**

1. **Current state.**
   ```sql
   SELECT id, event_type, status, attempts, last_error,
          created_at, processed_at,
          NOW() - created_at AS age
   FROM outbox_events
   WHERE id = '<event-uuid>';
   ```

2. **Status interpretation.**
   - `PENDING`, `attempts=0`, `age < 2s` → normal — worker hasn't ticked yet (poll interval 1s + jitter).
   - `PENDING`, `attempts=0`, `age > 5s` → **the worker isn't running.** Check the API container logs for the `outbox worker started` line. If it's missing, `WorkersModule` isn't loaded; if it's there but no `outbox event picked up` lines appear, the DB query inside `tick()` is failing — look for `outbox tick failed` ERROR logs.
   - `PENDING`, `attempts > 0` → in retry loop. `last_error` tells you why each attempt failed. If `attempts` keeps climbing across multiple ticks, the failure is permanent (bad payload, missing FK target, etc.) and the row will become DEAD soon.
   - `DEAD` → manual intervention required. Don't ignore.

3. **Worker logs around `attempted_at` / `created_at`.**
   ```
   grep -E '\[OutboxWorker\]|\[OrderWorker\]' apps/api/log
   ```
   For every retry you should see one `outbox event failed: id=… attempt=N/5` line. The fifth attempt is followed by a `[telegram-stub] DEAD OUTBOX EVENT` block and a `marked DEAD after 5 attempts` ERROR.

4. **Resolution paths.**
   - **Bad payload (most common).** Fix the producer (whatever inserted the row). For ORDER_PAID specifically, the only required payload field is `orderId`. The Stripe webhook handler is the authoritative producer; if it's emitting bad payloads, that's the bug to fix.
   - **Downstream outage.** Once the downstream is back, manually reset DEAD rows via the admin retry endpoint (or directly: `UPDATE outbox_events SET status='PENDING', attempts=0, last_error=NULL WHERE id='…'`). The worker will pick them up on the next tick.
   - **DEAD row that's no longer needed.** If the underlying business state has been reconciled by hand (e.g., the customer was refunded out-of-band), leave the row as DEAD for audit. Don't delete.

   **Never ignore a DEAD row without a matching ledger entry.** Each one represents a side effect we promised the customer that didn't happen.

---

## `/health` returns 503

**What you'd see:**
```json
{"status":"degraded","postgres":"up","redis":"down","timestamp":"..."}
```

**Check, in order:**

1. **Container health.**
   ```bash
   docker compose ps
   ```
   Both `pulse-postgres` and `pulse-redis` should show `running (healthy)`. If one is `(unhealthy)` or `restarting`, look at its logs:
   ```bash
   docker compose logs --tail=50 postgres
   docker compose logs --tail=50 redis
   ```

2. **Port conflicts.**
   ```bash
   lsof -nP -iTCP:5433 -sTCP:LISTEN
   lsof -nP -iTCP:6379 -sTCP:LISTEN
   ```
   The pulse stack expects Postgres on host **5433** (to avoid colliding with other local Postgres instances on 5432). Make sure `apps/api/.env` matches `docker-compose.yml`.

3. **ioredis ready state.** During boot, `ioredis` connects asynchronously and may take a couple of seconds to become "ready." A `/health` call within the first 1-2 seconds after the API starts may show `redis:down` even though Redis itself is healthy. This self-resolves; ECS handles it via `startPeriod` in the task definition.

4. **The 2-second per-check timeout.** If a dependency is up but very slow, `/health` returns 503 with the slow one as `down`. That's intentional — a hung dependency must produce a fast 503 instead of letting `/health` itself hang past Stripe's 10-second webhook timeout. The fix is to address the underlying slowness, not to raise the cap.
