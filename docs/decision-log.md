# Decision Log

Append-only. New decisions go at the bottom. Reversed decisions get an "Update" addendum below the original entry — never delete history.

Format:
```
## YYYY-MM-DD — Title
**Decision:** what we chose.
**Considered:** what we evaluated.
**Why this:** the reasoning that tipped it.
```

---

## 2026-05-08 — REST over GraphQL

**Decision:** REST/JSON over plain HTTP for the API. No GraphQL, no AppSync, no codegen.

**Considered:** AWS AppSync, Apollo Server, Hasura. Each adds a schema layer and a generated client.

**Why this:** REST is debuggable with `curl`. GraphQL queries that succeed in dev fail in prod from a missing N+1 batch loader, and you can't reproduce them without the same stack. For an MVP with one client (iOS) and one secondary client (the dashboard), REST is enough. We can revisit if a third client appears with very different data needs.

---

## 2026-05-08 — PostgreSQL over DynamoDB

**Decision:** PostgreSQL 15 (RDS) as the only datastore for transactional data.

**Considered:** DynamoDB single-table design, Aurora Serverless v2.

**Why this:** Order processing has joins (orders → order_items → menu_items → modifiers), reporting queries that need GROUP BY, and a small but real need for cross-row transactions (the outbox pattern). DynamoDB does all of those badly. Postgres does all of them with no ceremony, has the best free tooling (pgAdmin, psql), and the spec explicitly chose it. Aurora was overkill for current scale.

---

## 2026-05-08 — Outbox pattern for event delivery

**Decision:** Critical events (`ORDER_PAID`, `ORDER_CANCELLED`, etc.) are persisted in an `outbox_events` table inside the same DB transaction as the state change. A separate worker polls and dispatches.

**Considered:** Direct SQS publish from the request handler; transactional SNS; CDC on the orders table.

**Why this:** Direct publish silently loses events on every network blip — at the exact moment a customer just paid, when nothing is allowed to be silent. CDC adds a heavy moving part (Debezium / DMS) that's hard to operate. The outbox pattern is two SQL inserts and a 1-second-tick poller. Cost: ~1s event latency. Benefit: zero lost events. See `docs/architecture.md` flow #2.

---

## 2026-05-08 — Integer cents for all money

**Decision:** All monetary values stored and computed as integer cents. `650` means $6.50. `tax_rate_bps` (basis points) for percentages.

**Considered:** PostgreSQL `DECIMAL(10,2)`, JavaScript-side `Decimal.js` library.

**Why this:** Floats cause penny drift that compounds. `DECIMAL` would work but pulls a `decimal.js` dependency into iOS *and* dashboard for any client-side display, and TypeORM round-trips it as strings — which we'd then have to parse, which reintroduces the float problem if anyone slips a `parseFloat`. Integer cents is one rule, enforced by the column type. Display formatting (`(cents / 100).toFixed(2)`) happens once, in the UI.

---

## 2026-05-08 — `synchronize: false`, migrations only

**Decision:** TypeORM `synchronize` is permanently false in every environment. All schema changes go through generated migration files committed to the repo.

**Considered:** `synchronize: true` in dev only with migrations only in prod (the default NestJS template).

**Why this:** "Dev only" means dev and prod schemas drift the moment someone changes an entity locally and forgets to generate a migration. The first prod deploy after that produces a runtime error or worse — silent data loss. With `synchronize: false` everywhere, the migration is the contract: review it, run it, version it. The cost is one extra `npm run migration:generate` step in dev; the benefit is no surprises.

---

## 2026-05-08 — Three separate status enums

**Decision:** `OrderStatus`, `PaymentStatus`, `CloverSyncStatus` as independent columns on the `orders` table.

**Considered:** A single conflated `order_state` enum with values like `PAID_AWAITING_CLOVER` or `PAID_MANUAL_REQUIRED`.

**Why this:** A single field forces you to lie about one dimension when systems disagree. If Stripe says paid but Clover failed, the conflated enum has to pick one truth or invent a hybrid value — and the hybrid combinatorial explosion is what produces 30-state enums that nobody can reason about. Three independent fields let each subsystem tell its own truth, and the UI composes the right view per audience (customer sees only `OrderStatus`, staff see all three).

---

## 2026-05-08 — NestJS monolith over 20 Lambdas

**Decision:** Single NestJS service hosted on ECS Fargate. Three workers (outbox, order, clover) as separate processes in the same container image.

**Considered:** 20 Lambdas wired through EventBridge, each owning one endpoint or one event type.

**Why this:** Lambdas distribute the cold-start problem across every endpoint, make local development pure cosplay (no `serverless-offline` matches actual prod behaviour), and scatter shared code across deployable units in a way that turns a one-line shared bug fix into 20 deploys. NestJS gives us module isolation in code without the deployment fragmentation. ECS scales horizontally just fine for our load profile (≤ 5k orders/day at the upper bound of Phase 4).

---

## 2026-05-08 — Tracking set over `SCAN` for menu cache invalidation

**Decision:** A Redis SET (`menu:items:loc:{locationId}`) tracks which item-cache keys belong to which location. On invalidation, `SMEMBERS` then `DEL` each in a pipeline.

**Considered:** `SCAN MATCH menu:item:*` to find all per-item keys at invalidation time. Naming-scheme tricks like `menu:item:{locationId}:{itemId}`.

**Why this:** `SCAN` walks the entire keyspace. On a shared Redis at scale (100k+ keys: menus + sessions + idempotency), each `SCAN` becomes a noisy neighbour for every other tenant on the same instance. The naming-scheme alternative would prevent cross-location lookups (Clover menu import or admin tools that look up an item by id without knowing its location). The tracking set costs one `SADD` per item-cache write and one `SMEMBERS + DEL` pipeline per invalidation. O(N items cached) instead of O(N keyspace).

---

## 2026-05-08 — bcrypt + JWT over Cognito for Phase 1

**Decision:** Auth is local — bcrypt-hashed passwords in the `customers`/`staff_users` tables, signed JWTs from `@nestjs/jwt`. Cognito columns (`cognito_id`) exist in the schema for forward compatibility but are unused.

**Considered:** AWS Cognito user pools (one for customers, one for staff) per the spec's original recommendation.

**Why this:** Cognito ties local development to AWS — every dev environment needs a separate user pool, and the SDK doesn't run cleanly without configured AWS creds. For Phase 1 we're optimising for "real customer can order" speed, not for SSO/MFA. Cognito's value (federated identity, MFA flows, password reset templates) is real but not what's blocking launch. The schema reserves the migration path: when Cognito is added, set `cognito_id` and stop checking `password_hash`. No migration is required.

---

## 2026-05-08 — Outbox worker concurrency: single-instance `isProcessing` lock for Phase 1

**Decision:** The outbox worker uses a process-local boolean flag (`isProcessing`) to prevent overlapping poll cycles. There is no row-level lock in the database. The deployment assumption is **exactly one ECS task running the worker** at any time.

**Considered:**
- `SELECT ... FOR UPDATE SKIP LOCKED` on the `PENDING` query so multiple worker instances can run safely (the standard production-grade pattern).
- A Redis-backed distributed lock (`SET NX EX`) gating the entire poll cycle.
- Postgres advisory locks via `pg_try_advisory_xact_lock(<event_id_hash>)` per row.

**Why this:** The Phase 1 deployment topology is a single ECS Fargate task running the API and the workers in the same image. With one process, a process-local boolean is sufficient and trivially correct — no cross-process coordination, no failure modes from a Redis or DB lock service. Adding `FOR UPDATE SKIP LOCKED` now would require an ESLint exception for `find()` (TypeORM 0.3 needs raw `createQueryBuilder` for the lock clause), would need a follow-up migration to verify locking behaviour under load, and would solve a problem we don't have yet.

**The specific risk if this assumption is violated:** if a second ECS task is started by accident (deploy misconfiguration, manual `aws ecs update-service --desired-count 2` for "more throughput") **both tasks see the same `PENDING` rows** and process them concurrently. For `ORDER_PAID` that means:

- Two Clover orders created for one customer order. Once Clover integration is real, the customer's POS receipt shows the same coffee twice and the barista makes two of them.
- Two Telegram "new order" alerts to the owner.
- Two PostHog `order_paid` events — analytics double-count.
- Loyalty points awarded twice when that handler lands.

The boolean lock cannot detect or prevent any of these. The DB row will be updated to `PROCESSED` by whichever task finishes last, but the side effects already fired in both.

**Upgrade path (no decision required, just execute when scaling demands it):**
1. Switch the `tick()` query to `createQueryBuilder('e').where('e.status = :p', {p: PENDING}).orderBy('e.created_at').take(BATCH_SIZE).setLock('pessimistic_write').setOnLocked('skip_locked').getMany()`.
2. Wrap the per-row `processOne` call in a transaction so the lock is held until either `markProcessed` or `handleFailure` commits.
3. Remove the `isProcessing` flag — no longer needed; concurrency control moves into Postgres.
4. Update `apps/api/src/workers/README.md` to remove the "single-pod" note.
5. ECS service `desiredCount` becomes safely > 1.

This upgrade is purely additive — `processing_started_at`, `attempts`, `last_error`, the `(status, created_at)` index, and the `OnModuleDestroy` drain logic all continue to work unchanged.

---

## 2026-05-08 — Centralised `OrderStateMachine` over per-endpoint status checks

**Decision:** A single static utility (`apps/api/src/modules/orders/order-state-machine.ts`) owns every valid `OrderStatus` transition with the actor types permitted to cause it. Every endpoint that updates `orders.order_status` calls `OrderStateMachine.assertTransition(from, to, actor)` before issuing the UPDATE. The transitions table lives nowhere else.

**Considered:**
- Per-endpoint inline status checks (`if (order.order_status !== 'PAID') throw …` in each accept/progress/ready/cancel handler).
- A `BeforeUpdate` TypeORM lifecycle subscriber that compares old vs new status.
- A database `CHECK` constraint or a stored function enforcing the transitions in SQL.

**Why this:** Per-endpoint checks scatter the same logic across ~10 call sites. When the spec adds a transition (a refunded-then-restored flow, say), every site needs an edit and the diff is easy to miss in review. We've already seen this kind of drift produce real bugs (the duplicate `CREATE TYPE` migration was a similar "scattered logic" pattern).

A centralised utility:

- **Single source of truth.** The transitions table is one literal data structure. iOS/dashboard chats read it (via the contract or `getValidTransitions`) without each consulting separate handlers.
- **Compile-time safety on values.** Both `from` and `to` are `OrderStatus` enums — typos can't sneak past TypeScript.
- **Actor permissions are explicit.** The same transition (`PAID → CANCELLED`) may be allowed for one actor (`manager`) and not another (`customer`). Encoding the matrix once means adding a new actor type (e.g., `auto-refund-job` later) is one diff, not ten.
- **Better error messages.** `assertTransition` throws `ConflictException` with a `validNext` array — clients can render "Cancel only" or "Cancel/Refund" labels off the wire response without a follow-up request.

A TypeORM subscriber would work but couples the rule to the ORM and runs *after* the controller has already started its transaction. Surfacing the error at the call site (before the TX opens) keeps stack traces clean and avoids partial side effects.

A SQL `CHECK` constraint can't model the actor dimension at all — Postgres doesn't know who's calling — and would force us back into hybrid checks (some-in-DB, some-in-app), which is worse than either pure approach.

**The specific failure modes this prevents:**

1. **Two staff accepting the same order.** Without the assertion, the second click silently overwrites the first transition with the same status. The audit trail then shows two PAID→ACCEPTED rows from different staff users — confusing and wrong. With the assertion, the second click sees `order_status=ACCEPTED` and 409s.
2. **Staff "fast-forwarding" status by clicking the wrong button.** A barista pressing Ready when the order is still PAID would, without the check, jump straight to READY without ever going through ACCEPTED → IN_PROGRESS. The customer's push notification fires for a coffee that nobody started making.
3. **A customer cancelling an order Stripe just paid for.** Mobile networks can deliver the customer's cancel request seconds after the webhook lands. Without the check, the cancel succeeds and the customer gets refunded for a coffee the barista has already started.
4. **Refund flow creating REFUNDED on a FAILED order.** Manager UI bug or stale state; the assertion catches it.

**Where it's wired in (as of this entry):**

- `OrdersService.cancelOrderAsCustomer` (DRAFT → CANCELLED, customer)
- `CheckoutService.checkout` (DRAFT → PENDING_PAYMENT, system)
- `WebhookOrdersService.markPaidFromWebhook` (PENDING_PAYMENT → PAID, stripe-webhook)
- `WebhookOrdersService.markFailedFromWebhook` (PENDING_PAYMENT → FAILED, stripe-webhook)
- `AdminOrdersService.transitionStaff` (PAID/ACCEPTED/IN_PROGRESS/READY transitions, staff)
- `AdminOrdersService.cancelByManager` (manager-initiated cancel, manager)
- `AdminOrdersService.refund` (full refund only — partial refunds change `payment_status`, not `order_status`, so no transition assertion)

The contract: any new code path that touches `order_status` must call `OrderStateMachine.assertTransition` before the UPDATE. This is enforceable in code review; we'll add a custom ESLint rule to flag direct `order_status =` assignments outside the state machine if drift becomes a real problem.

---

## 2026-05-08 — Clover POS integration deferred to Phase 2

**Decision:** Phase 1 ships without Clover sync. The staff web dashboard is the operational order management surface for Phase 1. Every order keeps `clover_sync_status = NOT_SENT` from creation to pickup, and that is the expected and correct state.

**Considered:**
- Build the full Clover integration now (REST POST + retry sequence `[0s, 30s, 2min, 10min]` + `MANUAL_REQUIRED` terminal state + Telegram alert).
- Build Clover as a stub now, real integration in Phase 2 (the prior plan).
- Defer Clover entirely to Phase 2 with a one-line acknowledgement in `OrderWorker` (this decision).

**Why this:** The dashboard module is now built. Staff can see paid orders in `GET /admin/orders`, transition them through `accept → progress → ready → picked-up`, cancel, refund, and view the full audit trail. None of those flows require Clover — the dashboard is itself the system of record for mobile orders during Phase 1.

The Clover REST integration is not blocking customer ordering or staff operations. It IS:
- ~1-2 weeks of careful work (retry sequence, idempotency, menu import, error handling, Stripe-vs-Clover reconciliation).
- A persistent operational tax (alerting on `MANUAL_REQUIRED`, debugging Clover API drift, key rotation).
- A non-trivial dependency on a third party we don't fully control.

Spending that effort now buys us "the order also appears on the in-store register," which the dashboard already does for mobile orders. The cost-benefit doesn't justify Phase 1 inclusion.

**The deferral is not a rip-out.** All Clover infrastructure stays on disk:

- `clover_sync_status`, `clover_order_id` columns on `orders`
- `clover_item_id`, `clover_mod_id` columns on menu/modifier tables
- `clover_sync_log` table
- `CloverSyncService` (logs only) and `CloverModule`
- `CloverSyncStatus` enum and all its values

When Phase 2 starts, the change set is small: replace the `OrderWorker.handleOrderPaid` log line with the real Clover call, build out `CloverSyncService.syncOrder()` with the retry sequence, and start populating `clover_sync_log`. No migrations, no new modules, no contract changes.

**Documentation contract (every chat must follow):**
- Phase 1 implementations of `clover_sync_status` SHOULD show `NOT_SENT` for all orders.
- Backend chat MUST NOT implement Clover sync without an explicit Phase 2 kickoff message from the CTO chat.
- iOS and dashboard chats can ignore `clover_sync_status` in their UI for now (it'll always be `NOT_SENT`).
- Operational documentation that previously told on-call to "wait for `MANUAL_REQUIRED` Telegram alerts" now says "the dashboard is the source of truth for Phase 1."

The earlier decision-log entry implying Clover would be the next module after workers is superseded by this one.

---

## 2026-05-08 — Outbox dispatch happens INSIDE the SKIP LOCKED transaction (Phase 1 trade-off)

**Decision:** `OutboxWorker.tick()` opens a single transaction, claims a batch with `SELECT ... FOR UPDATE SKIP LOCKED`, runs `dispatch()` for each row, and updates the row to `PROCESSED`/`DEAD` — all within the same transaction. Row-level locks are therefore held for the entire dispatch duration.

**Considered:**
- **Claim-then-process** (the textbook pattern). Open txn 1: lock + update to a `CLAIMED` status, commit. Dispatch outside any transaction. Open txn 2: update to `PROCESSED` (or back to `PENDING` / forward to `DEAD`). Releases locks immediately, but introduces a new status, a new failure-recovery state ("rows stuck in CLAIMED if the worker crashes"), and a second migration.
- **Lock-during-dispatch** (this decision). One transaction; locks held until the row reaches a terminal state.
- **No locking, idempotent handlers** — relies entirely on each handler being safe to run twice. Brittle as side effects multiply.

**Why this for Phase 1:** dispatch today is purely in-process — one `findOne(Order)`, one `customers.update`, two log lines. Worst case is a few hundred milliseconds. Holding row-level locks for that duration produces zero contention because the very query that observes those locks is the one we're protecting against — `SELECT ... FOR UPDATE SKIP LOCKED` from another pod simply skips them and grabs different rows. We get multi-pod safety for free with one transaction and no extra status.

**The trade-off becomes a problem when dispatch goes external:**

- Real Clover REST: 10-second Stripe-style timeout. Locks held for up to 10 seconds × 10 batch rows = 100 seconds of locking per tick. Other pods skip past the locked range, but PostgreSQL's `idle_in_transaction_session_timeout` (often set to 30-60s in production) can cut us off mid-dispatch.
- APNs delivery: variable, occasionally seconds.
- Telegram Bot API: usually fast, occasionally rate-limited with backoff.

When the first of these handlers ships (real Telegram is the imminent candidate), the right move is to switch the worker to claim-then-process. The `processing_started_at` column already supports stuck-row detection for the new failure mode.

**Upgrade path (no decision required, just execute):**

1. Add `OutboxStatus.CLAIMED` (or reuse the existing `processing_started_at IS NOT NULL` predicate as the de-facto claim flag — no new enum value needed).
2. In `tick()`: `BEGIN; SELECT ... FOR UPDATE SKIP LOCKED; UPDATE ... SET processing_started_at = NOW(); COMMIT;` to claim a batch.
3. Run `dispatch()` for each claimed row OUTSIDE the transaction.
4. On success: `UPDATE ... SET status = PROCESSED, processed_at = NOW(), last_error = NULL` in its own short transaction.
5. On failure: `UPDATE ... SET attempts = attempts + 1, last_error = ?, status = (CASE WHEN attempts + 1 >= 5 THEN 'DEAD' ELSE 'PENDING' END)` in its own short transaction.
6. Add a stuck-row reaper: rows where `status = PENDING AND processing_started_at < NOW() - INTERVAL '10 minutes' AND processed_at IS NULL` get their `processing_started_at` cleared so the next tick picks them up again. (Generous timeout; real handlers should still be sub-30s in practice.)

This adds ~15 lines, no migration, and removes the locks-during-dispatch concern entirely.

**For now (Phase 1, all-in-process dispatch), the lock-during-dispatch model is correct and simpler. Documenting the upgrade so the future "why is this not claim-then-process?" question answers itself.**

---

## 2026-05-08 — Customer cancel during PENDING_PAYMENT

**Decision:** `POST /api/v1/orders/:id/cancel` is valid from `PENDING_PAYMENT` (in addition to `DRAFT`). The state machine's `PENDING_PAYMENT → CANCELLED` transition is allowed for the `customer` and `system` actors. Before flipping the DB status, the handler best-effort cancels the underlying Stripe `PaymentIntent` so the customer's open Stripe sheet can't accidentally complete the payment after our cancel commits.

**The bug this fixes:** the previous state machine only allowed `customer: DRAFT → CANCELLED`, but checkout creates DRAFT and updates to PENDING_PAYMENT inside a single transaction — DRAFT is never observable outside that transaction. So `POST /orders/:id/cancel` could only ever return 403/404/409. The endpoint was dead code.

**Considered:**
- Allow `customer: PENDING_PAYMENT → CANCELLED` only. Rejected — `'system'` is the same actor the abandoned-checkout cleanup task uses, and a future variant might want to cancel rather than mark FAILED. Adding both actors at once costs nothing.
- Allow staff/manager to cancel a PENDING_PAYMENT order. Rejected — payment is in flight; staff have no business deciding the customer's intent before Stripe confirms or fails it. Once PAID, the manager cancel/refund flow takes over.

**Why best-effort Stripe cancel before the DB flip:** the customer's iOS app may have an open Stripe payment sheet at the moment they tap our cancel. If we flip the DB first and Stripe takes the payment afterwards, we end up in a `cancel-after-pay` race (covered separately in the webhook race-mitigation entry). Cancelling the PaymentIntent first closes that window for nearly all cases. Stripe-side failure is non-fatal — the DB cancel still commits, and the race-mitigation branch handles the rare case where the payment lands anyway.

**Best-effort, not transactional:** the Stripe cancel call sits inside the locking DB transaction. If Stripe is unreachable, we log a warning and proceed with the DB cancel anyway — DB is the truth, Stripe will expire the PI on its own ~24h after creation.

**Tests:** `apps/api/src/modules/orders/order-state-machine.spec.ts` ("PENDING_PAYMENT → CANCELLED") covers actor permissions; `apps/api/src/modules/orders/orders.service.spec.ts` covers the cross-customer privacy posture; live curl verification confirmed the end-to-end flow.

---

## 2026-05-08 — Abandoned-checkout cleanup: 30-minute threshold, FAILED state, no outbox event

**Decision:** A `@Cron(EVERY_5_MINUTES)` scheduled task in `modules/orders/pending-payment-cleanup.task.ts` reaps orders left in `PENDING_PAYMENT` for more than **30 minutes**. Reaped orders transition to `order_status = FAILED, payment_status = FAILED` with `order_events.reason = "abandoned at checkout"`. **No outbox event is emitted.**

**Considered:**
- No cleanup at all — let abandoned PENDING_PAYMENT orders accumulate, accept the operational drift. This is what we shipped initially. The orders table grows, customer history shows ghosts, iOS polling never terminates.
- A shorter threshold (5 or 10 minutes). Faster cleanup but risks racing with slow customers — Stripe payment sheets can take a couple of minutes on flaky networks.
- A longer threshold (1–2 hours). Closer to Stripe's own ~24-hour PI expiry, but leaves a much larger window where iOS polls a permanently in-flight order.
- Transitioning to `CANCELLED` instead of `FAILED`. Discussed below.
- Transitioning to `CANCELLED` and emitting `ORDER_CANCELLED` so the customer gets a "your order was cancelled" notification.

**Why 30 minutes:** Stripe payment sheets typically time out at 10–15 minutes server-side. 30 min gives even a slow customer a comfortable buffer beyond that. Anything older is essentially certainly abandoned. We can tune this once we have real abandonment metrics.

**Why FAILED, not CANCELLED:** `CANCELLED` implies an explicit decision (customer cancel, manager cancel, refund flow). An abandonment is neither — the customer simply didn't complete payment. `FAILED` captures the operational reality cleanly: payment never happened, this order will never be fulfilled. It's the same terminal state Stripe-side payment errors produce, so reporting can treat both uniformly. Keeps enum semantics tight.

**Why no outbox event:** `ORDER_CANCELLED` outbox events drive customer notifications and refund processing. Neither applies:
- The customer never paid, so there's nothing to refund.
- A push to "your order was cancelled" lands hours after the customer already abandoned. They likely don't remember tapping Checkout. Worse-than-nothing UX.

iOS polling discovers the FAILED state on its next tick and stops polling. That's the cleanup, no notification needed.

**State machine extension:** `PENDING_PAYMENT → FAILED` was previously allowed only for the `stripe-webhook` actor. Extended to `[stripe-webhook, system]`. Pinned with a unit test in `order-state-machine.spec.ts`.

**Concurrency:** `SELECT FOR UPDATE SKIP LOCKED` for the claim, gated by `WORKERS_ENABLED` (same as the outbox worker). Two worker pods firing the cron simultaneously will grab disjoint batches; an API-only pod with `WORKERS_ENABLED=false` won't fire the cron at all. Same trade-off as the outbox worker (Stripe cancel call inside the locking transaction) and same upgrade path documented elsewhere — fine for Phase 1's low scheduled-task volume.

**Race condition with the Stripe webhook:** A customer who pays at minute 29 (Stripe webhook still in flight) while our cleanup task fires at minute 30 produces a race. Both transactions take pessimistic locks on the order row; whichever lands first wins. If the webhook lands first, the order is `PAID` and our cleanup's `WHERE order_status = 'PENDING_PAYMENT'` filter excludes it from the next batch — no harm. If the cleanup lands first, the order is `FAILED` when the webhook arrives; the webhook's `assertTransition(FAILED, PAID, 'stripe-webhook')` rejects it and Stripe retries. **This race is real but vanishingly rare** at a 30-minute threshold (a customer who took 30+ minutes to confirm is the population that abandons). Mitigation if it surfaces in practice: make `markPaidFromWebhook` idempotent against `FAILED` — log the late payment and trigger a refund.

---

## 2026-05-08 — Privacy: 404 over 403 for cross-customer order access (correction of earlier reasoning)

**Decision:** `GET /api/v1/orders/:id` returns **404** with an identical message both when the order doesn't exist and when it exists but belongs to a different customer. We do NOT use 403 here.

**Background — what we were doing wrong:** the original orders-module instruction in this thread argued for 403 with the rationale "returning 404 would leak that the order ID does not exist, which is a privacy concern." We implemented 403 accordingly. The reasoning is **inverted**:

- `404` collapses "doesn't exist" and "not yours" into the same response — caller cannot distinguish them.
- `403` confirms the resource exists and belongs to someone else — that IS the leak.

For a UUID-keyed resource the practical attack surface is small (UUID v4 has ~10³⁸ values), but the principle stands and the cost of doing it correctly is one line. There's no scenario where leaking "this ID belongs to someone else" is preferable to a uniform 404.

**Considered:**
- Keep 403 (status quo). Rejected — leaks existence.
- Return 404 only on missing rows, 403 on cross-customer (status quo). Same problem.
- Return 404 for both cases with identical body shape and message (this decision).
- Return 403 for both cases. Rejected — wrong semantically; clients (iOS especially) treat 404 as "give up polling, this resource is gone" which is exactly what a customer who doesn't own the order should be told.

**Why an iOS-aware framing matters:** iOS polls `GET /orders/:id` every 10 seconds while the status is non-terminal. The "stop polling" signal in our contract is "404 → resource gone for good." Returning 403 would invite a special-case branch on the client to also stop polling on 403 — fragile. With 404, the iOS poller's existing terminal-state handling does the right thing automatically.

**Impact on the cancel endpoint:** `POST /api/v1/orders/:id/cancel` currently has the same pattern (`ForbiddenException` on cross-customer access). It was NOT changed in this fix because the explicit instruction was scoped to `getOrderForCustomer`. The same privacy argument applies and the cancel endpoint should be updated when reviewed; flagged as a follow-up.

**Where the inverted note used to live:** the inline comment in `orders.service.ts:getOrderForCustomer` previously said "Per spec: 403 (not 404) when the order belongs to someone else, so iOS doesn't get to differentiate 'doesn't exist' from 'not yours' by error code." That was a confused paraphrase — the rationale described 404 behaviour but pointed at 403. Replaced with a clear explanation that names the leak.

**A3-followup (same day):** the same fix was applied to `cancelOrderAsCustomer` and its controller annotations. A regression test in `orders.service.spec.ts` pins the privacy invariant: the cross-customer 404 and the missing-order 404 produce byte-identical response bodies (apart from the UUID itself).

---

## 2026-05-09 — Webhook-after-state-change races: log + outbox, never throw

**Decision:** When `payment_intent.succeeded` arrives for an order that's already in a terminal state (`CANCELLED`, `FAILED`, or `REFUNDED`), `markPaidFromWebhook` returns 200 without throwing. For `CANCELLED` and `FAILED` it inserts a `REFUND_CREATED` outbox row carrying `amountCents`, the race-type label, and the order/payment status at race time. For `REFUNDED` it logs and returns. **Stripe's `refunds.create` is NOT called automatically.**

**The races covered:**

| race-type | trigger | how it produces the conflict |
|---|---|---|
| `cancel-after-pay` | A1 fix made `POST /orders/:id/cancel` work for `PENDING_PAYMENT`. | Customer hits cancel between confirming the Stripe sheet and our webhook landing. The cancel commits first; the webhook arrives saying "actually they paid." |
| `cleanup-after-pay` | A2 added `PendingPaymentCleanupTask` to reap `PENDING_PAYMENT` orders > 30 min old. | A 29-minute-old order whose Stripe webhook is delayed gets reaped at minute 30. The webhook arrives at minute 31 saying "actually they paid." |
| `post-refund-success` | Defensive — shouldn't normally happen. | Order is already `REFUNDED` (manager refunded earlier somehow) and a stale Stripe event redelivers. |

**Considered:**
- Keep the status-quo behavior — let `OrderStateMachine.assertTransition` throw `ConflictException`. The webhook controller doesn't catch it; Nest returns 409; **Stripe retries every few minutes for three days**, hammering us with 5xx the whole time. Customer's money sits in Stripe with no operational signal on our side.
- Auto-refund inline (call `stripe.refunds.create` from inside the webhook handler). Rejected — race detection should be a tripwire, not an irreversible action. "In case something is fishy" with the race (compromised account, replay attack, payload tampering), a human needs to look before money moves.
- Update `payment_status` to `SUCCEEDED` + insert a `payments` row in the race branch so the manager-refund endpoint works directly. Considered — would mean three-status invariants are stricter (always reflect Stripe truth on `payment_status`). Deferred for now to keep this fix minimal; the outbox row carries `amountCents` and `stripePaymentIntentId`, which is enough for the manager to drive a Stripe-dashboard refund or an extended admin endpoint later.

**Why this design wins:**

- **Stripe stops retrying immediately.** A 200 response means Stripe considers the event delivered. Without this, every race produces 3 days of webhook noise.
- **The liability is recorded in the outbox**, exactly the place built to surface things that need follow-through. The future notifications module gets one place to look — `outbox_events WHERE event_type='REFUND_CREATED' AND payload->>'raceType' IS NOT NULL` — for "owner alerts about money owed back to customers."
- **Manager keeps the refund decision.** The race could be benign (clock skew), but it could also indicate a tampered webhook or a replay. `/admin/orders/:id/refund` requires a manager + a written reason; the audit trail is intact.
- **No silent state corruption.** We don't promote a CANCELLED order to PAID just because Stripe says so — the customer's intent was to cancel; the order stays cancelled; the refund is the resolution.

**REFUNDED gets no outbox row** because the order is already terminal — there's nothing to surface, and emitting a `REFUND_CREATED` event for an already-refunded order would confuse the future handler.

**Operational signal for now:** until the notifications module ships, races appear in CloudWatch as a `[WebhookOrdersService] WARN webhook race detected` line. CloudWatch alarm on `race=cancel-after-pay OR race=cleanup-after-pay` count > 0 in any 1-hour window is the recommended Phase 1 monitor.

**Tests:** `apps/api/src/modules/payments/webhook-orders.service.spec.ts` covers all three race types with explicit assertions on: no-throw, structured warn log, REFUND_CREATED outbox emission for CANCELLED + FAILED only, no payments row / order_event in the race branch, and that the existing `payment_status=SUCCEEDED` idempotency path still wins precedence over the race branch.

---

## 2026-05-09 — Refund pre-validation before Stripe call: avoid money out with no DB record

**Decision:** `AdminOrdersService.refund()` runs as three explicit phases:

1. **Pre-validation** (no Stripe call, no row lock) — order existence + location scope, `stripe_payment_id` set, refund amount sane, **cumulative refund check** (existing refunds + this one ≤ total_cents), cumulative `isFullRefund` computation, state-machine assertion if full, payments-row existence.
2. **Stripe call** with an idempotency key `refund-{orderId}-{amountCents}-{floor(now/60000)}`. No DB lock held.
3. **Locked DB write** — re-runs the cumulative check inside the lock; if a concurrent refund landed between phases, log a structured ERROR, emit a REFUND_CREATED outbox row flagged with `error: 'race-with-concurrent-refund'`, and return success WITHOUT throwing (Stripe already moved money).

This bundles three related bugs:
- **A5** — pre-validation before Stripe.
- **A6** — cumulative refund tracking in the validation step.
- **A7** — cumulative `isFullRefund` computation.
- **A8** — Stripe idempotency key.

**The bug A5 fixes:** the previous flow called Stripe BEFORE the state-machine assertion. Refunding a FAILED order would call Stripe successfully, then the assertion would throw `ConflictException` because FAILED is terminal in the state machine. The transaction rolled back — Stripe had moved money but the DB had no `refunds` row, no `outbox_events` row, no `order_events` row. Money out, zero record. Reconciliation impossible without diffing Stripe's refund list against our table.

**The bug A6 fixes:** the previous validation only checked `refundAmount > total_cents`. A $20 order with a prior $5 partial refund would let a $20 refund attempt sail through validation; only Stripe's amount-too-large error would catch it (after the request). Worse — two managers issuing simultaneous partial refunds whose sum exceeded the total each saw a "valid" amount in their own request.

**The bug A7 fixes:** `isFullRefund` was computed as `refundAmount === total_cents`, which is the **non-cumulative** notion. A $5 partial on a $20 order followed by a $15 refund would leave the order's `payment_status = PARTIALLY_REFUNDED` forever and `order_status = PICKED_UP` (or wherever) instead of transitioning to `REFUNDED`. The new check is `existingRefundedCents + refundAmount === total_cents`.

**The bug A8 fixes:** no idempotency key was passed to Stripe. A retried request after a network blip would create a SECOND refund.

**Considered:**

- Keep the locked transaction but reorder operations within it — assertion before Stripe. Rejected — ties up row-level locks during the (up-to-10s) Stripe call. Cancel-with-state-machine-rejection still requires the same pre-flight check structure regardless.
- Auto-reverse the Stripe refund if the locked re-check fails. Rejected — Stripe doesn't have an "uncreate" for refunds. The money has already moved. Surfacing it via outbox is the only path.
- Throw on the Phase 3 race so the caller sees an error. Rejected — Stripe accepted the refund, the customer's money is en route to their card. Throwing here loses the record entirely; the manager has nothing to reconcile against. Mirroring the `markPaidFromWebhook` race pattern (log + outbox + don't throw) keeps the liability visible.

**Idempotency key format rationale:**

`refund-{orderId}-{amountCents}-{floor(now/60000)}`

- `orderId` + `amountCents` — semantic uniqueness per intended refund operation.
- `floor(now/60000)` — minute bucket. A retry within the same minute (network blip, server crash mid-flight) gets the same key → Stripe deduplicates → at-most-one refund. A deliberate second refund a minute later gets a fresh key → Stripe creates the second refund as intended.

The minute bucket is a conscious trade-off: it could let two distinct intended refunds for the same amount within the same minute collide. In practice that requires a manager to issue two identical-amount refunds within 60 seconds — extremely rare for a single human; if it happens, Stripe's de-duplication does the right thing semantically (the second is treated as a retry of the first, no duplicate refund).

**Why no auto-refund on the Phase 3 race:** the same logic as `markPaidFromWebhook` race-mitigation — when the system detects an unsafe state, manager intervention is the resolution path, not automated money movement. The outbox row carries enough metadata (`stripeRefundId`, `phase1ExistingCents`, `phase3ExistingCents`, `actionRequired: 'manual-reconciliation'`) for the future notifications module to surface the discrepancy to the owner.

**Tests:** `apps/api/src/modules/admin/admin-orders.service.spec.ts` extends with 10 refund-specific tests covering: FAILED order rejected without Stripe call (A5), amount-exceeds-total rejected without Stripe call, cumulative exceeds total rejected without Stripe call (A6), cumulative full refund flips order_status to REFUNDED (A7), cumulative partial refund leaves order_status unchanged, idempotency key format with `jest.useFakeTimers` (A8), Phase 3 race produces log + outbox + no-throw + synthetic refund object, plus three negative-coverage cases for the privacy guards and missing-payment-row branch.

---

## 2026-05-09 — Scheduled orders: estimated_ready_at set once at checkout, never overwritten

**Decision:** `AdminOrdersService.accept()` only recomputes `estimated_ready_at` for `pickup_type = ASAP`. For `SCHEDULED` orders, the field set at checkout is the source of truth and is never modified by staff transitions. `LocationSettings.findOne` is not consulted on the SCHEDULED branch — `current_wait_minutes` is irrelevant when the customer chose a specific pickup time.

**Authoritative source for each pickup type:**

| pickup_type | who sets `estimated_ready_at` | when |
|---|---|---|
| `ASAP` | `HoursService.canAcceptOrders()` returns `now + current_wait_minutes` (from `location_settings`); recomputed by `AdminOrdersService.accept()` at staff-accept time using the same formula with the wait-minutes value current as of accept | initially at checkout, then again at accept |
| `SCHEDULED` | `HoursService.canAcceptOrders()` returns `scheduledTime` (the pickup time the customer chose). Persisted by `CheckoutService` at checkout step 5. **Never touched again.** | once, at checkout |

**Considered:**
- Always recompute on accept (status quo before the fix). Rejected — silently shifts the customer's pickup time. A 2pm pickup that staff accepts at 8:50am would become a 8:55am pickup. Customer's countdown display in iOS goes haywire.
- Recompute on accept but cap at `scheduled_pickup_at` for SCHEDULED. Rejected — adds branching to the time math without a clear semantic improvement; the value at checkout is already correct.
- Skip the `accept` recompute entirely and trust whatever was set at checkout for both types. Rejected — for ASAP, `current_wait_minutes` may have been adjusted (`PUT /admin/wait-time`) between checkout and accept; the staff-accept moment is the right moment to refresh that value.

**Why this asymmetry is correct:** `current_wait_minutes` is a forward-looking estimate that staff own and adjust as the queue grows. For ASAP, the "right" wait-minutes is the one in effect at accept time. For SCHEDULED, the pickup time was negotiated with the customer at checkout — there's no "current" wait-minutes notion that applies; the customer doesn't care how busy you are at 8:50am if their pickup is at 2pm.

**iOS dependency:** the customer-facing `OrderStatusView` polls `GET /orders/:id` every 10 seconds and displays a countdown to `estimated_ready_at`. The countdown jumps backwards or forwards if the field changes between polls. For SCHEDULED orders this would be especially jarring — the customer is shown "Pickup at 2:00 PM" at checkout, then "Pickup at 8:55 AM" after the barista accepts at 8:50, then back to 2:00 if the field is touched again. Pinning the field once removes this class of UI bug entirely.

**Don't "simplify" by removing the branch.** A future engineer reading `accept()` may notice the asymmetry and consider it accidental complexity. It isn't. The inline comment in `admin-orders.service.ts` cites this entry; the test in `admin-orders.service.spec.ts` ("SCHEDULED: does NOT call LocationSettings.findOne") will fail loudly if the branch is removed.

**Tests:** `apps/api/src/modules/admin/admin-orders.service.spec.ts` — 7 tests covering ASAP exact-arithmetic with `jest.useFakeTimers()`, SCHEDULED unchanged from the original timestamp, `LocationSettings.findOne` call-count assertions per branch, default-wait-minutes behaviour when no settings row exists, and `order_events` audit row written in both branches.

---

## 2026-05-08 — Documentation structure

**Decision:** A `docs/` folder with one document per concern (architecture, golden rules, glossary, troubleshooting, decision log) and per-module READMEs next to the code. Onboarding docs for each AI chat live under `docs/ai-onboarding/`.

**Considered:** A single `ARCHITECTURE.md` in the repo root, or a wiki, or no docs at all (lean on the spec PDF).

**Why this:** The PDF spec describes the destination but not the journey. AI chats start every session with no memory of prior decisions, and the per-domain split (one chat per app) means each chat needs its own focused entry point. Single-doc-in-root would grow into a 5k-line wall. A wiki is one more system to keep in sync. The current structure colocates module docs with their code so they get updated alongside it.

---

## 2026-05-09 — Dashboard arithmetic: net revenue and unit sales semantics

**Decision:** `AdminDashboardService.getSummary()` reports

- `revenue_cents_today` = SUM(`orders.total_cents` − COALESCE(SUM(`refunds.amount_cents`), 0)) over today's orders in `REVENUE_STATUSES`. Net of partial refunds, computed via a `LEFT JOIN` against a per-order refund subquery.
- `top_items[].units_sold` = SUM(`order_items.quantity`) per `menu_item_id`, ordered by `units_sold DESC`. Units sold, not order_items rows.

This bundles two adjacent bugs in the dashboard query surface:

- **A10** — top items mis-ranked. The previous `COUNT(*)::int AS order_count` counted the **number of `order_items` rows** containing each menu item, not the **quantity** sold. A catering order of 12 lattes (one `order_items` row, `quantity = 12`) ranked equal to twelve separate single-latte orders. The owner's view of "what sold today" was wrong by however much the day's catering or office orders weighed.
- **A11** — revenue gross instead of net. The previous aggregate summed `total_cents` over the day's orders. An order with a $5 partial refund still contributed its full $20 to revenue. AOV inherited the same gross figure.

**Why SUM(quantity) is the correct semantic for top items:** the field is "what items did we sell today, ranked by demand". A latte sold as 12 in one transaction satisfies the same demand as 12 lattes sold in 12 transactions — the kitchen made 12 drinks either way; the inventory drained 12 units of milk and 12 shots. The line-count answer treats the catering order as a single data point, which is wrong both for the operational view (how many drinks did we make?) and the inventory view (how much did we deplete?). The two test counterexamples — a `quantity=12` catering order ranking against `quantity=1`, and the same item appearing across multiple orders summing to 5 — pin both halves of the regression.

**Why LEFT JOIN over a denormalized `net_revenue_cents` column on `orders`:**

- Considered: maintain `net_revenue_cents` on `orders` itself, updated transactionally whenever a refund row is inserted. Rejected — adds a write path that the existing refund flow doesn't have, with its own failure modes (transaction rollback semantics, ordering with the `payment_status` mutation, what-if-the-update-fails-but-the-refund-row-committed). The LEFT JOIN approach is correct **by construction** — there is no way for the read query to drift from the source-of-truth `refunds` table because it computes net at read time. The query plan is simple (subquery aggregates per `order_id` then joins on the indexed FK); if it ever shows up as slow on a real dataset, an index on `refunds(order_id)` already exists.
- Considered: subtract refunds in application code after fetching gross. Rejected — turns one query into N (or two with a separate refunds-by-order query), and every caller of dashboard data would need to remember to net out. SQL keeps the semantic in one place.

**Why the subquery and not a direct JOIN on `refunds`:** `LEFT JOIN refunds r ON r.order_id = o.id` would multiply rows when an order has multiple refund rows — a $20 order with two $5 refunds would appear twice in the JOIN, once per refund. `SUM(o.total_cents - r.amount_cents)` would then be `(20 - 5) + (20 - 5) = 30`, not the correct `20 - 10 = 10`, and `COUNT(*)` would over-report by the refund-row factor. Pre-aggregating refunds per `order_id` in the subquery collapses that to one row per order before the join, so `COUNT(*)` stays clean and the subtraction is correct. A test with two partial refunds against the same order pins this.

**Cross-day refund limitation (deliberate Phase 1 simplification):** today's dashboard reports today's orders with all their refunds netted out, NOT "today's transactions" (orders + refunds keyed on their own `created_at`). Concretely:

- Order created yesterday, refunded today: yesterday's revenue is unchanged in the dashboard's eyes; today's revenue does not show the refund (the order isn't in today's window). The refund effectively vanishes from the dashboard.
- Order created today, refunded today: handled correctly. This is the dominant case for a coffee shop — the customer comes back the same day to complain, the manager refunds within minutes.

**Why we accept the cross-day limitation in Phase 1:**

- Coffee-shop refunds are overwhelmingly same-day. The owner who notices that yesterday's spilled-latte refund didn't reduce yesterday's reported revenue is rare in absolute terms.
- A correct cross-day report would require a second card on the dashboard ("Transactions today: gross $X, refunds $Y, net $Z") rather than retroactively mutating yesterday's headline number — owners look at the dashboard for a snapshot of *today*, and changing yesterday's number under their feet creates more confusion than it fixes.
- The fix would touch the SQL surface twice (once for `revenue_cents_today`, once for the new transactions card) and add a fourth time-window concept; not warranted while we have one location and same-day-refund parity.

**When to revisit:** Phase 2 multi-location dashboards or any owner asking "where did yesterday's $5 go" both push this onto the table. The fix is a separate "transactions" report card keyed on `refunds.created_at`, not a retroactive mutation of historical revenue.

**Tests:** `apps/api/src/modules/admin/admin-dashboard.service.spec.ts` — 6 tests covering catering quantity-12 ranking, same-item quantity summing across orders, $20 minus $5 partial refund, two partial refunds stacking on one order, fully-refunded order excluded by status filter, and AOV using net rather than gross.

---

## 2026-05-09 — Admin response shape: AdminOrderDetail as the unified DTO

**Decision:** every admin-orders endpoint that returns an order — `GET /admin/orders` (list) and the six transition endpoints (`accept`, `progress`, `ready`, `picked-up`, `cancel`, `refund` committed-arm) — returns the same `AdminOrderDetail` shape:

```ts
interface AdminOrderDetail {
  id: string;
  customer_id: string;
  customer_name: string | null;
  order_status: string;
  payment_status: string;
  clover_sync_status: string;
  total_cents: number;
  pickup_type: string;
  scheduled_pickup_at: string | null;
  estimated_ready_at: string | null;
  notes: string | null;
  created_at: string;
  items: Array<{
    id: string;
    menu_item_id: string;
    item_name: string;
    quantity: number;
    unit_price_cents: number;
    modifiers: Array<{ modifierId: string; name: string; priceCents: number }>;
  }>;
}
```

The previous `AdminOrderListItem` is preserved as a deprecated alias so existing imports keep compiling.

**Why list and transitions diverged historically:** the list endpoint always projected (`customer_name` joined in, `items` loaded, raw enums stringified). Transitions returned `lockedFetch`'s raw `Order` directly — that's a TypeORM entity with no relations loaded (the lock query is bare for performance), no customer name attached, and JS `Date` objects rather than ISO strings. Admin clients had to either (a) ignore the transition response and wait for the next 5-second list poll to learn what happened, or (b) reconcile two different shapes for the same logical resource.

**Why this is worth fixing:** contract drift compounds. Two clients (today's dashboard, tomorrow's hypothetical second admin client) parsing two shapes makes type errors ship as runtime bugs. The Swagger surface was misleading too — `@ApiResponse` didn't pin a schema, so generated SDKs typed transition responses as the raw `Order` entity, exposing internal columns the API shouldn't promise.

**Why we kept the discriminated union on the refund endpoint despite unification:** the `race-recorded` arm reflects a genuinely different outcome than a normal commit. The DB has no refund row, no order mutation occurred, and the manager needs an operator-facing message + the Stripe refund ID for manual reconciliation. Forcing this into the same shape as the committed arm would either drop information the manager needs or pad the committed shape with optional reconciliation fields that are confusing in the success case. Two distinct discriminator arms is the type system saying "these are different kinds of things; handle them differently."

**Why fields were preserved alongside the additions:** the existing `AdminOrderListItem` carried `customer_id` and `clover_sync_status` that the proposed redesign omitted. Both stay on `AdminOrderDetail` — `customer_id` is used by admin clients to key follow-up lookups (without it, a UI showing a customer-scoped action panel has to do an extra lookup), and `clover_sync_status` is the Phase 2 hook for the upcoming Clover POS integration. Removing them would have been an unforced wire-format break.

**`customer_name` is nullable on `AdminOrderDetail` even though `Order.customer_id` is `NOT NULL`:** the schema enforces every order has a `customer_id`, but the customer row itself could in principle be hard-deleted (orphaned-order scenario). The codebase doesn't currently DELETE customers, so the null path is dead code under normal operation — but exposing it in the type system makes a future engineer's life better when soft-delete or hard-delete eventually lands. The list path's batched customer lookup also produces `null` when a customer is missing from the batch result; same defensive behaviour.

**Items shape expansion (`unit_price_cents`, modifier `modifierId` + `priceCents`):** the data was always there on `OrderItem.unit_price_cents` and the `OrderItemModifierSnapshot` JSONB shape. The pre-B2 list mapper just dropped these fields. They're useful to admin dashboards rendering line-by-line breakdowns ("$4.50 latte + $0.50 oat milk"), and they're admin-role-gated, so exposing them is a contract expansion rather than a leak.

**Migration plan for `AdminOrderListItem`:** the alias points to `AdminOrderDetail`; the two are identical at the type level. Consumers can rename their imports at any pace. We'll remove the alias once all internal consumers have migrated; external admin clients (the staff dashboard) drive the real timeline.

**Tests:** `apps/api/src/modules/admin/admin-orders.service.spec.ts` and `admin-orders.controller.spec.ts` extend the existing transition tests in place to assert the `AdminOrderDetail` shape (id, customer_id, customer_name, order_status, payment_status, items, scheduled_pickup_at, estimated_ready_at as ISO strings). One new nullable-customer test in the accept describe block covers the orphaned-customer path. The race-recorded refund test is unchanged because that arm wasn't reshaped.

---

## 2026-05-09 — Reload outside the locked transaction for admin transition responses

**Decision:** every admin transition method (`accept`, `progress`, `ready`, `picked-up`, `cancel`, `refund` committed-arm) does the same two-phase pattern:

1. **Inside the locked transaction:** acquire `SELECT FOR UPDATE` on the order, validate via `OrderStateMachine.assertTransition`, mutate, save, insert audit + outbox rows, commit.
2. **After the transaction commits:** call `loadAdminOrderDetail(orderId)`, which does `orders.findOne({ where: { id }, relations: { items: true } })` + `customers.findOne(...)` + `toAdminOrderDetail(...)`. Return the mapped shape.

The reload runs OUTSIDE the lock. The locked transaction itself never returns a mapped DTO — for non-refund transitions the helper returns `void`, for refund the transaction returns an internal `RefundOutcome` discriminator that the outer method translates to `RefundResult`.

**Why we don't return the in-memory post-transition order:** considered. After `await em.save(order)` inside the locked block, the in-memory `order` has the just-committed state; we could attach freshly-fetched items + customer and skip the reload. Rejected — the in-memory snapshot is THIS request's view, not the DB's current view. If a concurrent transition lands between our commit and our response (microscopic but non-zero window), the in-memory approach would tell the staff member "your action set this to ACCEPTED" while the actual current state is IN_PROGRESS. The reload approach tells them "the order is currently IN_PROGRESS" — which matches what the dashboard will show on the next 5-second list poll anyway. Returning the current DB state is more useful to the staff member's UI than a possibly-stale post-transition snapshot.

**The microscopic race window between commit and reload is acceptable for Phase 1:**

- Phase 1 is single-location with single-digit baristas. Concurrent transitions on the same order are rare in absolute terms.
- The dashboard's 5-second polling resyncs either way — the response is informational, not authoritative.
- The audit trail (`order_events`) is always correct because it's written inside the locked transaction. The wire response is best-effort current-state; the durable record is the events table.

**Phase 2 considerations:** if multi-staff or multi-location concurrent operations get heavy, two paths re-open: switch to the in-memory pattern (simpler under load), or take a SHARED lock for the reload. Neither is needed today.

**Lock-contention savings that motivated reloading outside the transaction at all:** holding the `SELECT FOR UPDATE` row lock through an items-relation JOIN + a customers lookup serialises every concurrent admin operation on the same order behind one slow read. Even a 50–100ms read holds the lock long enough to back up several concurrent staff actions. The reshape (lock → mutate → commit → release; then reload) keeps the critical section to the state-machine work alone. The cost is two extra round-trips per transition (one for the order+items reload, one for the customer); for a Phase 1 coffee shop with single-digit transitions per minute, this is invisible.

**Defensive guard against post-commit reload returning null:** `loadAdminOrderDetail` throws `InternalServerErrorException` if the order is missing. This requires a DELETE between commit and reload, and the codebase doesn't issue order DELETEs anywhere. The throw is a "this can never happen" guard rather than an expected branch — preferred over a silent map-to-an-empty-shape that would mask a real bug.

**Tests:** `apps/api/src/modules/admin/admin-orders.service.spec.ts` — every transition test mocks both `txGetOne` (locked SELECT) and `ordersFindOne` (post-commit reload), plus `customersFindOne` (mapper input). The nullable-customer test covers the `customers.findOne → null` defensive path. No test currently exercises the "order disappears between commit and reload" case because it requires bypassing the assumption that orders are never DELETEd; the `InternalServerErrorException` guard is defensive code by design.

---

## 2026-05-09 — Notifications service: router pattern with stubbed handlers

**Decision:** introduce `apps/api/src/modules/notifications/notifications.service.ts` with a single public entry point `dispatch(eventType, payload)` and six private-by-convention handler methods (`handleOrderPaid`, `handleOrderReady`, `handleOrderCancelled`, `handleOrderPickedUp`, `handleRefundCreated`, `handleItemOutOfStock`). C1 lands the router and the handler stubs; real Telegram delivery (C2) and APNs delivery (C3) are separate, downstream turns; the wiring point that has the outbox worker call `notifications.dispatch(...)` is C4.

**Why a router rather than direct dispatch from `outbox.worker`:**

- Single point of testing for routing logic. Adding a new event type means one new case in `dispatch()` and one new handler — no change to the worker.
- `outbox.worker.ts` currently maintains its own dispatch switch. After C4 collapses the five no-op cases into a single `await this.notifications.dispatch(...)` call, future event types are added in one place (`NotificationsService.dispatch`), not two.
- Cross-cutting concerns (telemetry, fan-out, dedup) can land in the router without touching the worker or the handlers individually.

**Why handler stubs that do the DB loads but not the actual sending:**

- Decouples C1 from C2 (Telegram methods on `TelegramService`) and C3 (iOS APNs path). C1 lands independently, exercised by tests with no external dependencies.
- Each handler logs a structured info-level (or warn-level — see log-level differentiation below) line containing every field a future Telegram or APNs payload would carry. When C2 lands, we'll have a paper trail in CloudWatch confirming the right data is being passed through.
- Handlers mirror `orderWorker.handleOrderPaid`'s DB-load pattern: load the entity from the database (DB is truth, payload is hint) and read the canonical fields from the loaded row. If the order is amended between the outbox write and the worker pickup (refund, partial refund, status correction), the loaded row reflects the current state, not a stale snapshot.

**The warn-not-throw asymmetry vs `orderWorker.handleOrderPaid`:**

Notification handlers warn-and-return ONLY on the explicit row-not-found condition (`findOne` returned `null`). Any other exception during DB access — connection drops, query failures, type errors — must propagate so the outbox retries the event and eventually marks it DEAD if the failure is persistent.

The intended pattern at every warn-and-return site:

```ts
const order = await this.orders.findOne({ where: { id: orderId } });
if (!order) {
  this.logger.warn(`[notifications] order ${orderId} not found in DB — skipping`);
  return;
}
// continue — any throw above this point propagates naturally, only the
// explicit row-not-found case warns
```

Do NOT wrap handler bodies in `try/catch`. That pattern would swallow real DB errors and silently lose notifications.

The asymmetry vs `orderWorker.handleOrderPaid` (which throws on missing order so the outbox retries toward DEAD) is intentional:

- Notifications are best-effort. If the order has been deleted, retrying won't bring it back.
- DEAD-eventing a notification isn't actionable for the manager — there's no remedial action they can take from a "your customer 'your coffee is ready' push didn't fire because the order vanished" alert.
- Analytics-and-state handlers retry-toward-DEAD because the customer-state mutation (`last_visit_at`) is a durable record that DOES need eventual consistency.
- Notification handlers log-and-return on missing rows because the alert is best-effort and lossy by nature.

**Malformed payloads still throw.** The validator pattern (mirrors `orderWorker.handleOrderPaid`'s `extractOrderId`) throws on a missing required string field (`orderId` for the five order-centric handlers, `itemId` for `handleItemOutOfStock`). Validation failure is a programming error at the emit site, not a transient runtime condition — the throw surfaces it to the outbox as DEAD with a clear `last_error` so the operator can fix the emitter. This is distinct from the row-not-found case (`findOne` returning null), which warns and returns.

**Defensive payload reading — REFUND_CREATED has three emit sites:**

- `apps/api/src/modules/admin/admin-orders.service.ts` `refund()` committed arm
- `apps/api/src/modules/admin/admin-orders.service.ts` `refund()` Phase 3 race branch
- `apps/api/src/modules/payments/webhook-orders.service.ts` `markPaidFromWebhook` race detection

The cross-site **common subset is four fields** — `orderId`, `customerId`, `locationId`, `amountCents`. `staffUserId` is present only on the two admin-actored sites; the webhook race emit is system-actored and carries `requestId` instead. The handler reads `staffUserId` defensively (`typeof payload.staffUserId === 'string' ? payload.staffUserId : null`) so the webhook-race log line surfaces `staffUserId: null` rather than crashing or surfacing `undefined`.

The defensive-reading pattern is applied uniformly across handlers (Concern B from the C1 reconnaissance refinements — defense in depth). Future emit-site additions for `ORDER_CANCELLED` (e.g., a customer-side cancel path with no `staffUserId` / no `cancelledBy`) won't silently regress the handler. A test exercises this future-emit path to pin the contract.

**Log-level differentiation:**

When the payload carries an `actionRequired` field (set on the two race emit sites: `'manual-reconciliation'` for the Phase 3 race, `'manager-refund-via-admin-endpoint'` for the webhook race), the handler logs at WARN level. Otherwise INFO (`logger.log` — NestJS `Logger` has no `info` method, so dynamic dispatch via `this.logger[level]` would crash; explicit `if (actionRequired) this.logger.warn(...) else this.logger.log(...)` preserves type safety on the Logger interface).

The operator-facing benefit: greppable WARN-level signal in CloudWatch when a refund needs manual reconciliation, distinct from the routine INFO-level signal on a normal committed refund.

**ITEM_OUT_OF_STOCK uses MenuItem, not Order:**

`MenuItem` is platform-wide in the schema — verified: there is no `MenuItem.location_id`. Per-location availability lives in `Inventory` (a separate row keyed on `(item_id, location_id)`). The `handleItemOutOfStock` handler:

- Loads `MenuItem` from `payload.itemId` to get the canonical item name (the alert message needs "Iced Latte sold out at downtown").
- Uses `payload.locationId` for location context (because the loaded entity has none).

This is the only handler that reads location from the payload rather than the loaded entity, by necessity. An inline comment in the handler documents the asymmetry.

**Future C4 wiring:**

The C4 turn modifies **`apps/api/src/workers/outbox.worker.ts:200-228`** (NOT `order.worker.ts` — which only has `handleOrderPaid`, the analytics + `last_visit_at` handler). The current outbox.worker dispatch switch has five no-op cases (`ORDER_CANCELLED`, `ORDER_READY`, `ORDER_PICKED_UP`, `REFUND_CREATED`, `ITEM_OUT_OF_STOCK`) that warn-and-return-PROCESSED. C4 collapses those into a single `await this.notifications.dispatch(event.event_type, event.payload)` call.

**`ORDER_PAID` requires fan-out and a split-event design:**

`ORDER_PAID` already has an existing handler (`orderWorker.handleOrderPaid`, doing analytics + `last_visit_at`) that must continue running on every paid order. The C1 spec (Part 9) also calls for a manager "NEW ORDER" Telegram alert on every paid order, which `notifications.handleOrderPaid` will own once C4 wires it.

Naive fan-out — calling both handlers from one dispatch tick and succeeding only if both succeed — creates a duplicate-alert bug: any transient failure in the second handler causes the outbox to retry the whole event, the first handler's idempotent re-run is fine but the second handler's external side effect (Telegram message) fires twice. Owner gets duplicate "NEW ORDER" alerts on every transient failure.

**Recommended C4 design: split into two atomic outbox events at the emit site —** `ORDER_PAID` (analytics, retried by `orderWorker.handleOrderPaid`) and `ORDER_PAID_NOTIFICATION` (alert, retried by `notifications.dispatch`). Each retries independently. The split adds emit-site changes in `webhook-orders.service.ts` `markPaidFromWebhook` (write two outbox rows in the same transaction) plus a new `OutboxEventType` enum value `ORDER_PAID_NOTIFICATION` (requires a Postgres enum migration), but this is a smaller surface than retrofitting per-handler idempotency tracking.

**C4 must implement this split before fan-out lands; do not implement single-event-fan-out as an interim step.** The duplicate-alert bug is an externally-visible regression that's hard to debug after the fact.

Until C4, the C1 `handleOrderPaid` is **NOT REACHABLE in production** — it's exercised only by C1's unit tests. A future C2 engineer wiring real Telegram delivery should not assume this handler fires on real paid orders; it doesn't, until C4 lands the split. An inline comment at the top of `handleOrderPaid` flags this for visibility.

**Also in C4: flip `NotificationsService.dispatch`'s `default` branch from warn-and-return to throw.** C1 leaves the default as a warn-and-return because the router isn't called in production yet. Once C4 wires `outbox.worker → notifications.dispatch`, an unknown event type reaching the default branch silently returns PROCESSED to the outbox — meaning if a future engineer adds an `OutboxEventType` enum value, wires it into the emit path, but forgets to add the `case` in `NotificationsService.dispatch`, the notification is lost without trace. Throwing instead surfaces the missing handler as DEAD with a clear `last_error`, matching `outbox.worker`'s existing throw-on-unknown pattern (`outbox.worker.ts:227`). The C1 unit test asserting "warns and does not throw on unknown event type" needs to be inverted to "throws on unknown event type" at the same time — both changes land together in C4.

**Handler API surface — public for testability:**

The `handleX` methods are public on `NotificationsService` so that `dispatch()` can call them and so that unit tests can spy on routing. Production code paths must always go through `dispatch()` — calling handlers directly skips the routing layer and any future cross-cutting concerns added there. A class-level JSDoc comment documents the convention.

**Tests:** `apps/api/src/modules/notifications/notifications.service.spec.ts` — 25 tests covering: routing for all six event types + unknown-type warn, happy-path load+log for each handler with the expected target_audience and structured fields, missing-row warn-and-return for each order-centric handler and for ITEM_OUT_OF_STOCK, malformed-payload throw for representative handlers (validator pattern), three REFUND_CREATED payload shapes (committed → INFO, Phase 3 race → WARN, webhook race → WARN with `staff_user_id: null`), and a defensive-future-emit test for ORDER_CANCELLED (no `cancelledBy` / `staffUserId` → logs as `null` rather than crashing).
