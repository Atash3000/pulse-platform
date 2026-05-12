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

**Decision:** introduce `apps/api/src/modules/notifications/notifications.service.ts` with a single public entry point `dispatch(eventType, payload)` and six private-by-convention handler methods (`handleOrderPaid`, `handleOrderReady`, `handleOrderCancelled`, `handleOrderPickedUp`, `handleRefundCreated`, `handleItemOutOfStock`). C1 lands the router and the handler stubs; the iOS APNs stub (C2) and the Telegram extension (C3) are separate, downstream turns; the wiring point that has the outbox worker call `notifications.dispatch(...)` is C4.

> **Sequence note (post-C2 retroactive correction):** an earlier draft of this entry described C2 as Telegram and C3 as APNs. That ordering was inverted at C2-instruction time — the actual sequence is **C2 = APNs stub, C3 = Telegram extension**. References in this entry below are written to the corrected sequence; the C2 commit (`feat(notifications): add push-notification stub service (C2)`) updated this entry in-place rather than appending a follow-up note.

**Why a router rather than direct dispatch from `outbox.worker`:**

- Single point of testing for routing logic. Adding a new event type means one new case in `dispatch()` and one new handler — no change to the worker.
- `outbox.worker.ts` currently maintains its own dispatch switch. After C4 collapses the five no-op cases into a single `await this.notifications.dispatch(...)` call, future event types are added in one place (`NotificationsService.dispatch`), not two.
- Cross-cutting concerns (telemetry, fan-out, dedup) can land in the router without touching the worker or the handlers individually.

**Why handler stubs that do the DB loads but not the actual sending:**

- Decouples C1 from C2 (iOS APNs stub: `PushNotificationService`) and C3 (Telegram extension: send methods on `TelegramService`). C1 lands independently, exercised by tests with no external dependencies.
- Each handler logs a structured info-level (or warn-level — see log-level differentiation below) line containing every field a future Telegram or APNs payload would carry. When C2 + C3 land, we'll have a paper trail in CloudWatch confirming the right data is being passed through.
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

Until C4, the C1 `handleOrderPaid` is **NOT REACHABLE in production** — it's exercised only by C1's unit tests. A future C3 engineer wiring real Telegram delivery should not assume this handler fires on real paid orders; it doesn't, until C4 lands the split. An inline comment at the top of `handleOrderPaid` flags this for visibility.

**Compile-time exhaustiveness is now in place** (added in a small post-C2 cleanup commit, `fix(notifications): code-review cleanups in dispatch and logStubMessage`). The `default` branch contains `const _exhaustive: never = eventType` which causes the build to fail if a future `OutboxEventType` enum value is added without a corresponding `case` in the switch. This catches the "added an enum value, forgot to wire it" class of bug at compile time rather than letting it ship as silent notification loss.

**Also in C4: flip `NotificationsService.dispatch`'s `default` branch from warn-and-return to throw.** Compile-time exhaustiveness catches the static case (known enum values), but the runtime warn-and-return is still a defensive layer for *truly* unknown values (a malformed payload at runtime carrying a string that isn't even in the enum — corrupted DB row, outbox row written before an enum rename, etc.). Pre-C4, this is OK because the router isn't called in production. Once C4 wires `outbox.worker → notifications.dispatch`, an unknown runtime value reaching the default branch silently returns PROCESSED to the outbox — meaning a corrupted enum value loses its notification. Throwing instead surfaces the bad row as DEAD with a clear `last_error`, matching `outbox.worker`'s existing throw-on-unknown pattern (`outbox.worker.ts:227`). The C1 unit test asserting "warns and does not throw on unknown event type" needs to be inverted to "throws on unknown event type" at the same time — both changes land together in C4. The `_exhaustive: never` line stays — it's complementary, not a replacement.

**Handler API surface — public for testability:**

The `handleX` methods are public on `NotificationsService` so that `dispatch()` can call them and so that unit tests can spy on routing. Production code paths must always go through `dispatch()` — calling handlers directly skips the routing layer and any future cross-cutting concerns added there. A class-level JSDoc comment documents the convention.

**Tests:** `apps/api/src/modules/notifications/notifications.service.spec.ts` — 25 tests covering: routing for all six event types + unknown-type warn, happy-path load+log for each handler with the expected target_audience and structured fields, missing-row warn-and-return for each order-centric handler and for ITEM_OUT_OF_STOCK, malformed-payload throw for representative handlers (validator pattern), three REFUND_CREATED payload shapes (committed → INFO, Phase 3 race → WARN, webhook race → WARN with `staff_user_id: null`), and a defensive-future-emit test for ORDER_CANCELLED (no `cancelledBy` / `staffUserId` → logs as `null` rather than crashing).

---

## 2026-05-09 — Push-notification service: APNs stub for deferred C-series wiring

**Decision:** introduce `apps/api/src/modules/notifications/push-notification.service.ts` exposing `PushNotificationService.send(customerId, title, body, data?)`. C2 lands the service shape, the validator/finder split, and the structured stub log; real APNs delivery is a Phase 2 Week 5 deliverable. The C1 `NotificationsService` handlers do NOT yet inject this service — wiring lands together with C3 (Telegram extension), so the C-series order is: C1 (router) → C2 (APNs stub, this entry) → C3 (Telegram extension + wire both into handlers) → C4 (outbox.worker → notifications.dispatch wiring + ORDER_PAID split).

**C-series sequence renumbering:** the C1 decision-log entry originally described C2 as Telegram and C3 as APNs. That ordering was inverted at C2-instruction time. The C1 entry has been updated in-place (same commit as this C2 entry) so the on-disk sequence matches reality. References in this entry assume the corrected sequence.

**Why a stub now rather than the real APNs send:**

- APNs requires the production-shaped infra: an APNs auth key (`.p8` file) loaded into the secret manager, a JWT signer per request, an HTTP/2 connection pool to `api.push.apple.com`, and per-token retry/backoff handling. None of that is needed to design and validate the call-site contract that `NotificationsService.handleOrderReady` (and friends) will eventually use.
- A stub with the right shape lets us land the service interface, the validator/finder split, and the testing pattern in C2 without standing up an APNs sandbox. C3's Telegram extension lands the same week and wires both services into the existing C1 handlers; the real APNs implementation slots into C2's stub later without changing the call sites.
- Keeping C2 as a stub also means **C2 has no external runtime dependencies**, so its tests run in CI without secrets and without network access — same property C1 relies on for its router tests.

**The `send()` contract — validator/finder split mirrors C1:**

```ts
async send(
  customerId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void>
```

- **Validation FIRST**, before any DB call. `customerId`, `title`, and `body` must be non-empty strings — `assertNonEmptyString` throws on failure with a clear field name. The throw is caught upstream by the outbox-worker dispatch and surfaces as a DEAD event with a clear `last_error` so the operator can fix the buggy emit site. Validation failure is a programming error at the caller, not a transient runtime condition.
- **Customer lookup via `customers.findOne({where:{id}})`**. If `findOne` returns `null`, log a `[push]` WARN and return — best-effort, mirrors `NotificationsService` (C1) row-not-found handling. Other exceptions from `findOne` (DB connection drops, type errors) propagate naturally.
- **`customer.push_token === null`** is the common path (most customers haven't enabled iOS push or have signed out): log a `[push-skip]` line at INFO level and return. This is normal, not an error — log level reflects that. The `push-skip` event shape carries `push_token_present: false` and a human-readable `reason`.
- **`customer.push_token` is present**: log a `[push-stub]` line at INFO level with the would-be APNs payload (customer_id, push_token_present: true, title, body, data). Real APNs delivery will replace this log with a real send call; the structured payload remains the same so downstream consumers (analytics, metrics) get a stable shape.

**The warn-not-throw asymmetry vs `orderWorker.handleOrderPaid`:**

Same logic as the C1 `NotificationsService`. Pushes are best-effort; if the customer was deleted, retrying won't bring them back; DEAD-eventing a notification isn't actionable for the manager. Notifications log-and-return on missing rows; analytics-and-state handlers retry-toward-DEAD because durable state mutation does need eventual consistency.

**Security: do NOT log push tokens. Ever.**

APNs push tokens are device identifiers. Anyone who has both a token AND the bundle's APNs auth key can send arbitrary notifications to the user's device — that is a privilege-escalation vector for anyone with read access to CloudWatch logs. The structured log line carries `push_token_present: true | false` as a boolean indicating whether a token exists; the token value itself is **never** logged.

Future engineers MUST NOT "improve" the logging by adding the token value, even temporarily for debugging — use a debugger or a one-off script that doesn't write to persistent logs instead. The class-level JSDoc on `PushNotificationService` documents this constraint at the call site so a casual reader can't miss it. A regression test in `push-notification.service.spec.ts` asserts the push token value is absent from every log line, including the WARN and skip paths.

**Wiring status — NOT YET CALLED IN PRODUCTION:**

C1's `NotificationsService` handlers (`handleOrderReady`, `handleOrderPickedUp`, etc.) currently log their would-be push context inline; they do not yet inject `PushNotificationService`. C3 (Telegram extension) bundles the wiring step: at C3 time the relevant handlers gain a constructor injection of `PushNotificationService` and call `pushNotifications.send(...)` after their structured stub log (or in place of it).

Until C3, this service is exercised only by its own unit tests. A class-level JSDoc comment on `PushNotificationService` flags the wiring status so a Phase 2 engineer arriving at the file doesn't assume the customer-facing push is live.

**Module wiring:**

`PushNotificationService` is added to `notifications.module.ts` providers + exports list. `TypeOrmModule.forFeature([Order, Customer, MenuItem])` already includes `Customer` from C1 — no additional `forFeature` entries needed. `app.module.ts` is unchanged.

**Tests:** `apps/api/src/modules/notifications/push-notification.service.spec.ts` — 10 tests covering: validator throws on empty `customerId` / empty `title` / empty `body`, `findOne` returning null produces a WARN log and returns, a DB-error propagation test (findOne throws → send() throws, not warned-and-returned), customer with `push_token: null` produces an INFO `[push-skip]` log, customer with a populated `push_token` produces an INFO `[push-stub]` log with the expected fields, the `data` payload is included when provided and surfaces as `null` when omitted, and the push token value itself is NEVER present in any log line (security regression guard, asserts across both the `[push-stub]` and `[push-skip]` paths).

---

## 2026-05-09 — Telegram service extension: six alert methods for notification handlers

**Decision:** extend `apps/api/src/modules/notifications/telegram.service.ts` with six event-driven alert methods (`newOrder`, `paymentFailed`, `itemSoldOut`, `orderingPaused`, `orderCancelledByStaff`, `refundIssued`), three pure formatting helpers in a co-located `telegram-formatters.ts` (`formatCustomerName`, `formatCents`, `formatItemList`, plus `formatOrderShortId` for UUID → display ID), and a hybrid `[telegram-stub] {alert,chat_id,level,body,...}` log shape. C3 lands the public surface and the stub format; real Bot API delivery is deferred to a consolidated turn after C5 + C4 prove the dispatch logic.

**Source-mapping — four methods are direct Spec Part 9, two are architectural extensions:**

| Method | Spec Part 9? | First caller (planned) |
|---|---|---|
| `newOrder` | ✅ direct match | C5 — `handleOrderPaid` after the `ORDER_PAID_NOTIFICATION` split-event lands. |
| `paymentFailed` | ✅ direct match | NO CURRENT CALLER. Lands as dead code in C3; first caller arrives when a `PAYMENT_FAILED` outbox event + handler is added. The decision-log entry on `markFailedFromWebhook` explicitly defers this. |
| `itemSoldOut` | ✅ direct match | C4 — `handleItemOutOfStock`. |
| `orderingPaused` | ✅ direct match | NO CURRENT CALLER. Lands as dead code in C3; first caller arrives when a pause/resume admin endpoint emits an outbox event. No current schedule for that endpoint. |
| `orderCancelledByStaff` | ❌ extension | C4 — `handleOrderCancelled`. The architectural need is real (C1's `ORDER_CANCELLED` outbox event must dispatch somewhere when wired); the Part 9 spec table just doesn't enumerate it. |
| `refundIssued` | ❌ extension | C4 — `handleRefundCreated` (committed arm only; race-recorded variants stay on the C1 handler's existing warn-level path with `actionRequired`). |

**Why the two extensions are added now in C3 rather than later:** the C1 outbox events `ORDER_CANCELLED` and `REFUND_CREATED` already exist on disk and need a Telegram-side method to call when C4 wires the handlers. Adding the methods in C3 alongside the four Part-9-direct ones keeps the Telegram public surface coherent (one cluster of event-driven alerts, all in one place) rather than splitting it across two turns. The decision-log entry's commit message and the file-level JSDoc both flag the extensions as architectural-not-Part-9 so a future reader doesn't go looking for them in the spec.

**`dailySummary` and `weeklySummary` are deferred** to a separate scheduled-summary turn. They're cron-driven (9pm daily, Sunday weekly) rather than event-driven and warrant their own architecture (a `@Cron` task, aggregate queries against `orders` / `refunds` for the relevant window, idempotency under multi-pod deployments, retry semantics). Bundling them with C3's event-driven alerts would conflate two different concerns.

**Hybrid log format — `[telegram-stub] ${JSON.stringify({...})}`:**

The C3 alert methods log via:

```ts
[telegram-stub] ${JSON.stringify({
  alert,    // discriminator: 'newOrder' | 'paymentFailed' | ...
  chat_id,  // 'owner' | null  — label, not the raw chat ID
  level,    // 'info' | 'warn' — matches the logger method used
  body,     // rendered Spec Part 9 message string
  ...extra, // e.g. orderId, itemId, locationName for log-correlation queries
})}
```

This is **option (c)** from the C3 reconnaissance — the body field preserves the Part 9 message string verbatim (visible in CloudWatch for spec-compliance verification), the JSON wrapper gives a queryable structure, and the alert field discriminates for filtering.

The pre-existing `alertDeadOutboxEvent` method uses a multi-line plain-text format (header line + key-value pairs joined with newlines) — intentionally NOT migrated in C3. That format was designed to be human-readable directly in CloudWatch when DEAD events fire (the message body itself is the operator alert), and changing it is out of scope. A regression test in `telegram.service.spec.ts` pins the legacy plain-text shape so a future "let's unify" refactor is an explicit decision rather than a silent change.

**Why we don't dynamic-dispatch via `this.logger[level]`:** NestJS default `Logger` has `log`, `warn`, `error`, `debug`, `verbose` — there is no `info` method. Dynamic dispatch with `level: 'info'` would crash at runtime. The `emitStub` private helper uses an explicit `if (level === 'warn') logger.warn(line) else logger.log(line)` branch, preserving type safety on the Logger interface and matching C1 / C2's existing convention.

**Scalar argument shape — TelegramService is decoupled from TypeORM:**

Each new method takes a typed object literal of pre-formatted scalars rather than entity references. The caller (currently the C1 handlers, via C4 / C5 wiring) is responsible for:

1. Loading the relevant entities from the database.
2. Calling the formatters in `telegram-formatters.ts` (`formatCustomerName`, etc.).
3. Passing pre-formatted strings + cents + IDs to the Telegram method.

`TelegramService` is now pure presentation — no TypeORM imports, no `findOne` calls, no relation loading. Two concrete benefits:

- **Testability**: a CLI tool, a one-off script, or a unit test can call `telegramService.newOrder({customerName: 'Test', ...})` with no database. The C3 spec file exercises this directly.
- **Schema-rename robustness**: a future `Customer.full_name` rename ripples into the C1 handler and the formatter only — `TelegramService` is unaffected because it never touches the entity shape.

The trade-off is slightly more verbose call sites (C5 will assemble `{ customerName: formatCustomerName(customer.full_name), itemSummary: formatItemList(items), ... }` rather than just passing `customer` and `order`). For Phase 1 the verbosity is fine; the alternative would have couples that bite later.

**Log levels — INFO for routine, WARN for operator-action:**

| Level | Methods | Reasoning |
|---|---|---|
| INFO (`logger.log`) | `newOrder`, `itemSoldOut`, `refundIssued` | Routine business alerts. Owner / staff want to see them but no immediate action required. |
| WARN (`logger.warn`) | `paymentFailed`, `orderingPaused`, `orderCancelledByStaff` | Operator-action signals. Failed payments need follow-up; paused ordering means a location is offline; manager-initiated cancellation of a paid order has financial impact and warrants visibility. |

`refundIssued` is INFO for the routine commit-arm refund. The race-recorded variants (`refund() Phase 3 race` and `markPaidFromWebhook` race-detection) carry `actionRequired` in their outbox payload and are handled by C1's existing `handleRefundCreated` warn-level path — they don't go through `refundIssued`.

**`chat_id` is logged as a label, not the raw chat ID:**

When `TELEGRAM_OWNER_CHAT_ID` is configured, the stub log shows `chat_id: 'owner'` rather than the raw chat-ID string. The chat ID alone isn't a credential (the bot token is), but defense-in-depth is cheap here and the label is enough to confirm targeting at future-bot-wiring time. When the env var is unset (dev / tests), `chat_id` is `null` and the stub log itself is the entire alert delivery.

**Spec Part 9 deviation — UUID order display IDs:**

Part 9 shows `Order #124` — a short numeric identifier. Pulse Coffee orders are UUID-keyed at the schema level (no `order_number` column). `formatOrderShortId` truncates a UUID to its first 8 chars and prefixes `#` — `#abc12345` is unique enough for visual correlation in a Telegram alert and short enough to match the Part 9 "compact ID" feel. The owner can paste the full UUID into the dashboard URL for disambiguation. If Phase 2 adds a sequential public order ID, this formatter swaps to use it.

**Spec Part 9 deviation — `itemSoldOut` uppercases the item name:**

The Part 9 example reads `OAT MILK SOLD OUT — Auto-hidden from app — Main St`, but the same item appears mixed-case in the `newOrder` example (`Oat Latte`). Either the Part 9 spec is inconsistent or `itemSoldOut` is banner-style formatting. The C3 implementation matches the spec literal — `itemName.toUpperCase()` is applied in `itemSoldOut` only. Easy to revert if the real-Bot delivery turn determines the spec author meant something else.

**Real Bot API delivery considerations:**

The actual Telegram Bot API send (HTTPS POST to `api.telegram.org`, JWT-style retry handling, reply-error introspection) is not in C3. The deferral lets the dispatch wiring (C4 — outbox.worker → notifications.dispatch) and the call-site shape (C5 — `handleOrderPaid` calling `newOrder` with real loaded fields) prove the routing logic is correct in CloudWatch via the stub log lines BEFORE we add network I/O. When real delivery lands, swapping the body of `emitStub` to "POST to Telegram + log on failure" is a localized change with no surface-area impact on the six methods or their tests.

Open question to revisit at that turn: the C3 stub logs `chat_id: 'owner'` as a label rather than the raw chat-ID string (defense-in-depth — see the `chat_id` paragraph above). The real-delivery turn needs to decide whether the production log line should continue using the label or surface the resolved chat-ID for debuggability when a Telegram send fails — the latter helps an operator diagnose "is this hitting the wrong chat" without inspecting Parameter Store, but reintroduces the chat-ID into log persistence. This decision-log entry names the question rather than answering it; the real-delivery turn will pick a side with full context.

**Tests:**

- `apps/api/src/modules/notifications/telegram-formatters.spec.ts` — 17 tests covering the four formatters with edge cases (single-name customers, three-word names, whitespace handling, `formatCents` zero / odd-cents / large values, `formatItemList` quantity-extension, `formatOrderShortId` short / empty UUID inputs).
- `apps/api/src/modules/notifications/telegram.service.spec.ts` — 12 tests covering: one happy-path per C3 method asserting the rendered Part 9 body string + alert / level / chat_id / orderId fields, a chat_id-null branch test for the `TELEGRAM_OWNER_CHAT_ID`-not-set fallback, a hybrid-log-convention test that asserts every C3 method emits the four canonical fields, and a regression test pinning the legacy `alertDeadOutboxEvent` plain-text format so a future "let's unify" change is explicit.

---

## 2026-05-11 — Timezone-aware hours and scheduled pickup validation

**Decision:** rewrite `HoursService.canAcceptOrders` and every supporting helper to read day-of-week, time-of-day, and DST transitions from the **location's** `IANA timezone` rather than the **server's** local timezone. Adds `date-fns-tz@^3.2.0` + `date-fns@^4.1.0` as production dependencies. Extracts the timezone math into a pure-function helper module (`hours-tz.ts`) so each helper is independently unit-testable without standing up the full service.

**The bug:**

Every helper in the pre-fix `hours.service.ts` read server-local time:

| Line (pre-fix) | Code | What it produced |
|---|---|---|
| `:167` | `when.getDay()` (in `hoursForDate`) | Day-of-week 0–6 in **server** tz. |
| `:213` | `d.getHours() * 60 + d.getMinutes()` (in `dateToMinutes`) | Minute-of-day in **server** tz. |
| `:230` | `d.setHours(h, m, s)` (in `combineDateAndTime`) | Sets HH:MM:SS in **server** tz on a given calendar day. |
| `:239`/`:240` | `d.getHours()` / `d.getMinutes()` (in `formatTime`) | Renders HH:MM in **server** tz for the rejection message. |

Deployed on ECS Fargate (server tz = UTC) serving a store in `America/New_York`, the bug surfaced most visibly around server-midnight UTC:

- A store with hours `Mon 09:00–19:00` would report "outside hours" at 6pm New York (22:00 UTC) because the helper read hour `22`, not `18`. Rejected legitimate orders.
- A Tokyo store at Sunday 5am JST would read Saturday's hours (server tz UTC saw `Saturday 20:00`), looking up the wrong row entirely. Wrong day-of-week.
- Rejection messages rendered `"We open at 14:00"` (UTC of 09:00 NY) — correct only by coincidence in the server's tz.

Other places in the codebase that read `Date.now()` / `new Date()` were audited and confirmed TZ-safe (they compute relative durations or absolute UTC instants, not calendar parts). **Only `hours.service.ts` was affected.** The full audit table:

| File:line | Use | TZ-affected? |
|---|---|---|
| `pending-payment-cleanup.task.ts:236` | `Date.now() - createdAt` for age check | ❌ Relative duration. |
| `admin-orders.service.ts:316` | `new Date(Date.now() + waitMin*60_000)` for `estimated_ready_at` | ❌ Absolute instant + offset. |
| `admin-orders.service.ts:374` | `new Date().toISOString()` for `pickedUpAt` | ❌ UTC ISO string. |
| `admin-orders.service.ts:544` | `Date.now() / 60_000` for refund idempotency key minute-bucket | ❌ Relative. |
| `admin-items.service.ts:38` | `new Date()` for sold-out timestamp | ❌ Absolute UTC instant. |
| `hours.service.ts` (entire file) | day-of-week + time-of-day reads | ✅ **The bug surface.** |

This audit table is load-bearing documentation. Future engineers worrying that the fix should ripple to other files can read this table and confirm no — the fix is correctly scoped to one file.

**Library choice: `date-fns-tz`.**

Three options were considered:

| Option | Pros | Cons |
|---|---|---|
| **`date-fns-tz`** (~10KB) | Small, focused. `fromZonedTime`, `toZonedTime`, `formatInTimeZone` — exactly what we need. Battle-tested DST handling (spring-forward "2am doesn't exist", fall-back "1am happens twice"). | New dependency. |
| **`luxon`** (~70KB) | Comprehensive `DateTime` + tz. | Heavier; we'd use ~5% of it. |
| **Native `Intl.DateTimeFormat`** | Zero deps. | The forward direction (UTC → calendar parts in tz) is easy via `formatToParts`; the **inverse direction** (calendar parts in tz → UTC instant — needed by `combineLocalDayAndTime` for `nextOpenAt`) requires manual offset math with subtle DST edge cases. Possible but error-prone. |

**Chosen: `date-fns-tz`** at v3.2.0 (with `date-fns@^4.1.0` as a peer dep). v3.x renamed the helpers — `zonedTimeToUtc` is now `fromZonedTime`, `utcToZonedTime` is now `toZonedTime`. The fix uses the v3 API.

**Bad-timezone fallback (option `b`):**

`Location.timezone` is `text NOT NULL DEFAULT 'America/New_York'` at the schema level — no `CHECK` constraint validates IANA strings. A typo like `'America/Newyork'` would store and break silently when `new Intl.DateTimeFormat({timeZone: 'America/Newyork'})` throws `RangeError`.

The `resolveTimezone` helper in `hours-tz.ts` absorbs this:

```ts
export function resolveTimezone(rawTz: string | null | undefined):
  { tz: string; isFallback: boolean; originalTz?: string } {
  const candidate = rawTz || 'America/New_York';  // empty/null → default
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return { tz: candidate, isFallback: false };
  } catch (err) {
    if (err instanceof RangeError) {
      return { tz: 'America/New_York', isFallback: true, originalTz: candidate };
    }
    throw err;
  }
}
```

`HoursService.canAcceptOrders` calls this once at entry and logs a structured WARN with the bad value + `locationId` when `isFallback` is true. The fallback is defensive at read time; the customer-facing flow keeps working with a sensible default while the WARN log surfaces the bad row for an operator to fix.

The `||` pattern (`location.timezone || 'America/New_York'`) handles the empty-string case before `Intl` even tries; matches the existing convention in `admin-dashboard.service.ts:79`. The `try/catch` then handles the invalid-IANA case. Both failure modes converge on the same fallback with the same logging contract.

**Deferred to a follow-up turn — write-time validation (option `c`):**

The read-time fallback prevents customer-facing crashes but doesn't prevent bad data from entering the system. A follow-up turn should add:

1. **Validation at the Location create/update path** (admin endpoint) that rejects bad IANA strings with a 400 response — fail fast at write time.
2. **Ideally, a Postgres `CHECK` constraint** that enforces IANA validity at the DB level. (Implementation note: PG doesn't natively validate IANA; the practical version is a constraint that checks the value is in `pg_timezone_names`. This is doable but version-dependent.)

The read-time fallback + write-time validation are complementary. Both should exist. Tracked as future work.

**DST handling:**

The library handles US spring-forward / fall-back correctly. The pinned example test (TC5 in `hours.service.spec.ts`): "Saturday March 14 2026 09:00 NY" — one calendar week after the March 8 2026 spring-forward — resolves to `2026-03-14T13:00:00Z` (EDT = UTC-4), not `14:00:00Z` (EST = UTC-5). A separate helper test pins the pre-DST case (March 1 2026 = EST) to confirm both directions of the transition.

**Tokyo / day-rollover edge case:**

The most subtle bug case the pre-fix code shipped: a store in `Asia/Tokyo`, server UTC at Saturday 20:00 UTC = Sunday 05:00 JST. Pre-fix read `when.getDay() = 6` (Saturday) and looked up Saturday's `LocationHours` row, applying Saturday's open/close window to a Sunday morning Tokyo customer. Post-fix reads `dayOfWeekInTz(when, 'Asia/Tokyo') = 0` (Sunday) — correct. Pinned by tests TC3 and TC3 mirror.

**`formatTimeInTz` rendering:**

The rejection message strings (`"We open at 09:00"`) now render the open time in the **location's** tz, not server tz. Pre-fix, an NY store with hours `09:00–19:00` returned `"We open at 14:00"` when the server was UTC and the rejection happened at 4am NY — the message was technically the right UTC instant but useless for the customer. Post-fix, `formatInTimeZone(nextOpenAt, 'America/New_York', 'HH:mm')` renders `"09:00"` — what the customer expects.

**Tests:**

- `apps/api/src/modules/locations/hours-tz.spec.ts` — 31 unit tests for the seven helpers (`resolveTimezone`, `dayOfWeekInTz`, `localMinutesInTz`, `timeStringToMinutes`, `isTimeWithinInTz`, `combineLocalDayAndTime`, `startOfDayPlusDaysInTz`, `formatTimeInTz`). Edge cases: day-rollover (UTC Saturday → Tokyo Sunday), pre-DST vs post-DST NY conversions, overnight hours ranges (open 22, close 02), inclusive-open / exclusive-close boundaries, zero-padding, single-digit hours, empty timezone fallback, invalid-IANA fallback.

- `apps/api/src/modules/locations/hours.service.spec.ts` (new) — 18 integration tests for `canAcceptOrders` covering: TC1 NY 6pm ASAP, TC2 LA 8am ASAP, TC3 Tokyo day-rollover (and its mirror), TC4 SCHEDULED pickup tomorrow LA, TC5 post-DST `nextOpenAt` UTC instant, TC6 server-tz independence (same store result across pre-DST + post-DST UTC instants), plus pre-existing regression (LOCATION_INACTIVE, MOBILE_ORDERING_PAUSED, CLOSED_TODAY with `nextOpenAt`, overnight hours range, SCHEDULED_ORDERING_DISABLED, SCHEDULED_TIME_IN_PAST, SCHEDULED_TIME_TOO_FAR, SCHEDULED_TIME_OUTSIDE_HOURS, SCHEDULED_TIME_REQUIRED), plus bad-timezone fallback (`America/Newyork` typo triggers WARN log + falls back to NY; empty string falls back silently).

**Future work — write-time timezone validation:**

`Location.timezone` needs a write-time validation at the admin endpoint (and ideally a Postgres CHECK constraint or trigger that validates against `pg_timezone_names`) to prevent typos like `'America/Newyork'` from entering the system. The current read-time fallback in `HoursService` is defensive but not preventive. A future turn should add validation at the Location create/update path to fail fast on bad input. The read-time fallback stays as defense-in-depth.

---

## 2026-05-11 — markFailedFromWebhook idempotency: stale failure webhook handling against post-payment states

**Decision:** add post-payment race detection to `WebhookOrdersService.markFailedFromWebhook`, mirroring the existing `detectPostPaymentRace` pattern in `markPaidFromWebhook`. When a `payment_intent.payment_failed` webhook arrives for an order that's already past `PENDING_PAYMENT`, log a structured WARN, return 200 to Stripe, and **do not throw** — preventing the 3-day Stripe retry storm the pre-fix code triggered.

**The bug:**

`markFailedFromWebhook` had only one idempotency guard (`order.order_status === FAILED → return`). Every other `order_status` reached `OrderStateMachine.assertTransition(fromStatus, FAILED, 'stripe-webhook')`, which only allows `PENDING_PAYMENT → FAILED` and throws `ConflictException` for everything else.

Real Stripe traffic delivers `payment_intent.payment_failed` events for already-settled orders in several scenarios:

- Stripe re-delivers an earlier failure event after the customer retried with a different payment method and succeeded.
- Out-of-order delivery: success and failure events for the same PaymentIntent arrive in opposite order.
- Manager-replays from the Stripe dashboard for testing or audit.
- Disputes that fire as `payment_failed` after the order has already shipped.

Pre-fix, every one of these returned 5xx to Stripe → retry every few minutes → up to 3 days of retries per event → CloudWatch noise + outbox-worker log spam + potential alert fatigue.

**Three race names — five sub-states collapsed:**

```ts
private detectPostFailureRace(orderStatus): RaceType | null {
  switch (orderStatus) {
    case PAID:
    case ACCEPTED:
    case IN_PROGRESS:
    case READY:
    case PICKED_UP:
      return 'stale-failure-after-success';
    case REFUNDED:   return 'stale-failure-after-refund';
    case CANCELLED:  return 'stale-failure-after-cancel';
    default:         return null;  // PENDING_PAYMENT, DRAFT
  }
}
```

The five "downstream of PAID" states collapse under one race name because the operator response is identical for all of them ("ignore the stale failure, the order is fine"). Granular names would multiply documentation without operational value — the operator doesn't care whether the order was ACCEPTED or IN_PROGRESS when the stale failure arrived; they care that no action is required.

The WARN log line **preserves the actual `order_status`** for diagnostic granularity:

```
payment_failed webhook race detected: order {id} is IN_PROGRESS but
payment_intent.payment_failed arrived (race=stale-failure-after-success,
stripe_event=evt_xxx, payment_intent=pi_xxx, payment_status=SUCCEEDED,
request_id=req-xxx, last_payment_error={...}). Returning 200 to Stripe;
no action required (order is settled).
```

No information is lost — the operator can grep by `race=` to filter by category and by the order's actual state for diagnosis.

**DRAFT state — let the assertion throw:**

`DRAFT` returns `null` from the detector and falls through to the existing state-machine assertion, which throws. This is intentional: a `payment_failed` webhook arriving for a DRAFT order means a PaymentIntent exists for an order that's still in DRAFT — which shouldn't happen in normal flow (checkout transitions DRAFT → PENDING_PAYMENT in the same transaction that creates the PI). If it does happen, it's possibly bug #5 territory (orphan PaymentIntent from a checkout transaction rollback). Letting the assertion throw surfaces it as a 5xx so operators see the anomaly. A silent return would mask a real bug.

**No outbox emission — the asymmetry with markPaidFromWebhook:**

`markPaidFromWebhook` emits a `REFUND_CREATED` outbox row for `cancel-after-pay` and `cleanup-after-pay` races (real money sitting in Stripe needs manager reconciliation). `markFailedFromWebhook` emits **nothing**.

Three reasons:

- No money moved. `payment_intent.payment_failed` means the customer's payment method declined; if the order is already settled, the success path already won. No liability.
- Not actionable. A "stale failure webhook arrived" alert isn't something a manager can or should act on. Unlike money-in-Stripe-limbo, this race is benign.
- Volume risk. If Stripe ever has a delivery issue and re-delivers failure webhooks for thousands of paid orders, we'd flood the outbox with thousands of useless rows.

The WARN log line is the operational signal. Operators grep CloudWatch for `stale-failure-after-` if patterns emerge.

**Parallel methods, not shared classifier — comparison table:**

The two webhook race-detection systems share the broad pattern (detect → log → return 200) but differ in semantics and response policy. Kept as **two parallel methods** rather than merged into a shared classifier. A one-line cross-reference in `detectPostFailureRace` points to `detectPostPaymentRace` so future readers find the sibling.

| Aspect | `markPaidFromWebhook` | `markFailedFromWebhook` |
|---|---|---|
| **Race shape** | Order state changed first, webhook arrived second | Order settled, webhook is late or duplicated |
| **Money implication** | Money moved at Stripe; some races need manager reconciliation | No money moved |
| **Outbox emission** | Yes for `cancel-after-pay` + `cleanup-after-pay`; no for `post-refund-success` | None |
| **Named races** | 3 (`cancel-after-pay`, `cleanup-after-pay`, `post-refund-success`) | 3 (`stale-failure-after-success`, `stale-failure-after-refund`, `stale-failure-after-cancel`) |
| **Sub-state collapsing** | None — each state has its own race name | Five sub-states under one name (`stale-failure-after-success`) |
| **Sharing strategy** | Parallel methods + cross-reference comment | Parallel methods + cross-reference comment |

The "Sharing strategy" row exists to preempt the "why don't these share a base class?" question. The answer: the response policies differ (one emits outbox, one doesn't), so a shared classifier would force consumers to switch on caller-context anyway. Parallel methods keep each handler's policy readable in one place; ~15 lines of similar-looking switch logic is the cost of clarity.

**Race detection runs BEFORE the state-machine assertion:**

Matches the `markPaidFromWebhook` structure. The flow inside the locked transaction:

1. `order.order_status === FAILED` → idempotent return (pre-existing).
2. `detectPostFailureRace(order.order_status)` → if non-null, WARN-log + return 200 (the fix).
3. `OrderStateMachine.assertTransition(...)` → only reached for `PENDING_PAYMENT` (happy path) or `DRAFT` (anomalous — let it throw).

Running detection before the assertion means we never call `assertTransition` on a known-race state, so the throw simply doesn't happen for the bug's failure modes. This is cleaner than `try/catch`-around-the-assertion which would translate the throw — the detector pattern keeps the assertion as the "unexpected state" signal.

**`payment_status` is NOT mutated:**

When a stale failure webhook arrives for a PAID order, `payment_status` is `SUCCEEDED`. The race branch must NOT touch it — the order's truth is already correct. Similarly for REFUNDED (payment_status=REFUNDED) and CANCELLED (payment_status may be REQUIRES_PAYMENT or SUCCEEDED depending on cancel-during-PENDING vs cancel-after-PAID — either way, the failure event doesn't change it). The race branch leaves `payment_status` alone, leaves `order_status` alone, leaves the order audit trail (`order_events`) alone — no transition occurred, so nothing is written.

**Tests:** `apps/api/src/modules/payments/webhook-orders.service.spec.ts` adds 11 tests in a new `markFailedFromWebhook` describe block (the existing file covered only `markPaidFromWebhook`):

- 1 happy-path: `PENDING_PAYMENT → FAILED` transitions correctly, saves, inserts OrderEvent, logs info.
- 1 existing idempotency: `FAILED → FAILED` returns early.
- 5 `stale-failure-after-success` sub-states (PAID, ACCEPTED, IN_PROGRESS, READY, PICKED_UP) — parameterized as 5 it-cases asserting: no throw, single WARN log with the actual sub-state preserved, no order mutation, no outbox row, no order_events row.
- 1 `stale-failure-after-refund` (REFUNDED).
- 1 `stale-failure-after-cancel` (CANCELLED).
- 2 negative-coverage (missing orderId metadata, order not found in DB).

Total test count: 228 → 239 (+11).

---

## 2026-05-11 — Modifier validation: required, multi-select, and duplicate enforcement

**Decision:** rewrite `CheckoutService.validateCartItems` to enforce three previously-missing validation rules: per-item modifier deduplication, `modifier_groups.required` enforcement, and `modifier_groups.multi_select` enforcement. Every cart-validation rejection — both the three new rules and the four pre-existing ones — now throws `BadRequestException` carrying a structured `CartValidationRejectReason` code + human message + meta (item/group names), mirroring the `AvailabilityRejectReason` pattern from `HoursService`.

**The three bugs:**

| Bug | Damage | Fix |
|---|---|---|
| **No per-item modifier dedup** | Customer can post `modifierIds: ['oat-milk', 'oat-milk']` for one line item. Both copies flow into pricing → upcharge applied twice → customer overcharged. | Per-cart-item duplicate check via `Set(modifierIds).size !== modifierIds.length`. Throws `MODIFIER_DUPLICATE`. |
| **No `required` group enforcement** | A drink with `modifier_groups.required = true` for a "Size" group can be ordered with no size selected. Barista has no idea what to make. | Per-group check: if `required && selectedFromGroup.length === 0` → throw `MODIFIER_GROUP_REQUIRED`. |
| **No `multi_select` group enforcement** | Customer picks "Small" + "Large" on a single-choice group. Two upcharges, no clear answer for the barista. | Per-group check: if `!multi_select && selectedFromGroup.length > 1` → throw `MODIFIER_GROUP_SINGLE_SELECT`. |

**The (required × multi_select) matrix:**

| `required` | `multi_select` | Rule | Test case |
|---|---|---|---|
| `false` | `false` | 0 or 1 selection | TC1 (0 OK), TC2 (1 OK), TC3 (2 reject SINGLE_SELECT) |
| `false` | `true` | 0 or more selections | TC4 (0 OK), TC5 (2 OK) |
| `true` | `false` | exactly 1 selection | TC6 (0 reject REQUIRED), TC7 (1 OK), TC8 (2 reject SINGLE_SELECT) |
| `true` | `true` | 1 or more selections | TC9 (0 reject REQUIRED), TC10 (1 OK), TC11 (3 OK) |

All 4 combinations × all relevant counts → 11 explicit test cases. The matrix is canonical — every (required, multi_select, count) tuple has exactly one defined outcome.

**Structured error codes — `CartValidationRejectReason`:**

```ts
type CartValidationRejectReason =
  | 'ITEM_NOT_FOUND'              // item doesn't exist or is inactive
  | 'ITEM_WRONG_LOCATION'         // item belongs to a different location's category
  | 'MODIFIER_NOT_FOUND'          // (reserved — see note below)
  | 'MODIFIER_NOT_ON_ITEM'        // modifier not present on this item's groups
  | 'MODIFIER_DUPLICATE'          // same modifierId listed twice on one line item
  | 'MODIFIER_GROUP_REQUIRED'     // required group has zero selections
  | 'MODIFIER_GROUP_SINGLE_SELECT';  // single-select group has 2+ selections
```

The pre-existing item/modifier checks moved to structured codes too — the validation layer now speaks one language. Every rejection carries:

- `reason`: machine-readable code (one of the union members).
- `message`: human-readable English string (operator-facing fallback).
- `meta`: optional `{itemId, itemName, modifierId, groupId, groupName}` for client-side i18n.

iOS clients can map `reason` → localized strings using `meta.itemName` / `meta.groupName` interpolation. The English `message` matches the localization-key default.

**`MODIFIER_NOT_FOUND` is reserved but not currently emitted.** The post-refactor flow loads modifiers via the nested `MenuItem.modifier_groups.modifiers` relation — meaning the lookup is scoped to the item being validated. A modifierId that exists but belongs to a different item registers as `MODIFIER_NOT_ON_ITEM`, not as "not found." A modifierId that doesn't exist anywhere similarly registers as `MODIFIER_NOT_ON_ITEM` (the customer's response is the same either way: "that modifier isn't available on this item"). `MODIFIER_NOT_FOUND` is kept in the enum for forward-compat with future flows that might do a global-modifier lookup.

**Throw vs silent dedup — decided: throw.**

Considered silently deduplicating `modifierIds` (running `new Set(...)` and continuing). Rejected. Reasons:

- A client sending duplicates is buggy. Silent dedup masks the client bug and lets it ship; the dev team finds out months later when production reports start showing patterns.
- Consistent with Golden Rule #8 (iOS prices are ignored). The backend doesn't accommodate client malformation; it surfaces malformation as 400.
- The error is recoverable (client retries with a corrected cart). It doesn't break the user experience to fail-fast.

`MODIFIER_DUPLICATE` is the right code. iOS client logic that builds the cart array should dedupe at the UI layer; backend doesn't do that work.

**DRAFT-style coverage gap — checkout (`#10`):**

Audit item #10 flagged that `CheckoutService` had zero spec coverage. This turn adds the spec file `apps/api/src/modules/checkout/checkout.service.spec.ts` covering the modifier-validation surface (16 tests) plus one end-to-end happy-path smoke test. **The smoke test is intentionally one test, not a full integration suite.** A top-of-file comment in the spec lists the deliberately-uncovered surfaces:

- Idempotency cache paths (Step 1): cache HIT, cache MISS, same-key-different-customer ConflictException.
- HoursService rejection passthrough (Step 2).
- Inventory race (Step 5): the in-transaction inventory re-check has no row lock (audit item #8 — separate turn).
- Transaction rollback / Stripe error path: audit item #5 — separate turn.
- Tip-percent validation (Step 3.5) and pricing service integration (Step 4): delegate-tested at their respective service levels.

The end-to-end smoke pins the test scaffold (mocked DataSource, repos, delegate services) so future `test(checkout): ...` commits can add specific scenarios without re-doing the harness. Splitting `#10` into a focused-tests-now-plus-broader-coverage-later approach was deliberate; comprehensive checkout coverage in this turn would have ballooned to ~30 tests and conflated two concerns.

**Module wiring side effect — `Modifier` repo no longer injected:**

The pre-fix `validateCartItems` injected `@InjectRepository(Modifier)` for a flat `modifiers.find({where: {id: In(allModifierIds)}})` call. The post-fix path loads modifiers via the nested `MenuItem.modifier_groups.modifiers` relation, which is required anyway to enumerate `required` / `multi_select` groups for a given item. The `Modifier` repo injection becomes unused → removed from `CheckoutService` constructor and from `checkout.module.ts`'s `TypeOrmModule.forFeature` list. The `Modifier` type import stays (still referenced inline as a type in the `modifierLookup` map's value type).

**Tests:** `apps/api/src/modules/checkout/checkout.service.spec.ts` — 16 tests:

- 11 (required × multi_select) matrix tests (TC1–TC11), one per cell of the cross-product where the rule has a different outcome.
- 1 `MODIFIER_DUPLICATE` test (TC12).
- 3 preserved-behavior tests with structured codes (TC13 `MODIFIER_NOT_ON_ITEM`, TC14 `ITEM_NOT_FOUND` for inactive items, TC15 `ITEM_WRONG_LOCATION`).
- 1 end-to-end happy-path smoke (TC16) — exercises the full `checkout()` flow with all delegate services mocked, asserts the response shape (`{orderId, clientSecret, totalCents, display}`).

Test count: 239 → 255 (+16). Build clean.

**Future work:**

- Audit item #8 (inventory race no row lock) — separate turn, would also touch `validateCartItems` adjacent code but for a different concern.
- Audit item #5 (orphan PaymentIntent on transaction rollback) — separate turn, Step 5 transaction structure.
- Full `CheckoutService` test coverage (idempotency cache paths, HoursService rejection passthrough, Stripe error paths) — incrementally added as `test(checkout): ...` commits when each is needed.

---

## 2026-05-11 — ORDER_PAID split-event design: analytics + notification retry independently

**Decision:** every successful `markPaidFromWebhook` transaction now emits **two** outbox events atomically — `ORDER_PAID` (routes to `orderWorker.handleOrderPaid` for analytics: `last_visit_at` + structured log) and `ORDER_PAID_NOTIFICATION` (routes to `NotificationsService.dispatch` → `handleOrderPaidNotification` → `telegramService.newOrder` for the manager "NEW ORDER" Telegram alert). Both rows are inserted in the same webhook transaction so they either both commit or both roll back, but they retry independently at the outbox-worker level.

**The bug this prevents — duplicate Telegram alerts under transient failure:**

The C1 decision-log entry's "Future C4 wiring" subsection flagged this risk explicitly. Naive single-event fan-out would route `ORDER_PAID` to BOTH `orderWorker.handleOrderPaid` (analytics) AND `notifications.dispatch` (alert) from a single outbox-worker dispatch tick. Any transient failure in the second handler causes the outbox to retry the whole event — the first handler's idempotent re-run is fine (`last_visit_at = now` written twice is harmless), but the second handler's external side effect (Telegram message) fires **twice**. Owner gets duplicate "NEW ORDER" alerts every time a transient blip hits the analytics side.

Splitting the event at the emit site means each outbox row tracks its own dispatch state. `ORDER_PAID` retries are bounded to the analytics handler; `ORDER_PAID_NOTIFICATION` retries are bounded to the alert handler. Cross-contamination eliminated.

**Atomicity of the emit:**

Both rows go in the same `ds.transaction(async (em) => { ... })` block in `markPaidFromWebhook`, after the order's `UPDATE` to `PAID` + the Payment row insert. If anything throws between the two inserts (extremely unlikely — they're back-to-back `em.insert(OutboxEvent, ...)` calls with no intermediate logic), the transaction rolls back and neither row is committed. Either both events ship or none does. The webhook idempotency layer (the `payment_status === SUCCEEDED` early-return at the top of `markPaidFromWebhook`) ensures Stripe retries don't re-emit the pair.

**Payload-as-pointer design:**

Both events share an identical payload: `{orderId, customerId, locationId, totalCents, stripePaymentId}`. The handlers load the live `Order` from the database via the `orderId`; the rest of the payload is operational context for the dispatch (currently unused by handlers, retained for future log correlation).

Alternative considered — **payload contains a full snapshot** (orderId + items + customerName + locationName + totalCents inline). Rejected for three reasons:

- **Payload size grows with order item count.** A 30-item catering order would write a 5–10KB JSON blob to `outbox_events.payload`. Unbounded in principle.
- **Snapshot can diverge from live entity state.** If the order is amended between emit and dispatch (refund, partial refund, status correction, item-name snapshot correction at `OrderItem.item_name`), the snapshot in the payload is stale. The handler would surface wrong data in the Telegram alert.
- **Order.items already exists in the DB.** Duplicating it in the payload is denormalization with two sources of truth — the canonical place for "what items did this order have" is `order_items` joined on `order_id`.

The pointer design — payload as a stable reference, handler resolves live state — is the canonical event-sourcing pattern. It matches `orderWorker.handleOrderPaid`'s existing approach (the analytics side already loads `Order` from DB via `orderId`; it ignores the rest of the payload).

**`handleOrderPaid` → `handleOrderPaidNotification` rename:**

Pre-C5, `NotificationsService.handleOrderPaid` was a C1 stub that fired on the `ORDER_PAID` enum case. Post-C5:

- `ORDER_PAID` is **not** a NotificationsService concern — analytics is `orderWorker`'s job. The dispatch switch keeps `case ORDER_PAID:` as a defensive no-op (`return`), retained for compile-time exhaustiveness check compatibility (ORDER_PAID is still in the enum).
- `ORDER_PAID_NOTIFICATION` is NotificationsService's concern — the new alert event. The handler `handleOrderPaidNotification` lives at the case label.

The rename makes the method name match what NotificationsService does for the event, not which enum value triggered it. Cleaner contract. The C1 spec's "handleOrderPaid logs the would-be Telegram payload" stub became "handleOrderPaidNotification calls telegramService.newOrder with the loaded scalars" — the spec evolved alongside the method's responsibility.

**Defensive `case ORDER_PAID: return;` rationale:**

A load-bearing inline comment in the switch documents this case so a future engineer doesn't:

- **Delete it** — the `_exhaustive: never` check (added in the post-C2 cleanup) requires every enum member to have a case. Deleting this case fails the build.
- **Add logic to it** — analytics belongs in `orderWorker`; adding work here would re-introduce the duplicate-alert bug we just split events to prevent.

The comment names both pitfalls and points to this decision-log entry.

**Migration — `AddOrderPaidNotificationEnumValue` (timestamp 1778625600000):**

- **`up()`**: single `ALTER TYPE "public"."outbox_event_type_enum" ADD VALUE 'ORDER_PAID_NOTIFICATION'`. PG 12+ permits this inside a transaction so long as the new value isn't used in the same transaction; we don't, so we're safe. Spec deployment is PG 15.

- **`down()`**: real rollback (not a defensive throw) because the codebase is not yet deployed to production — no live `ORDER_PAID_NOTIFICATION` rows can exist outside local dev. The 5-step pattern:
  1. `DELETE FROM outbox_events WHERE event_type = 'ORDER_PAID_NOTIFICATION'` (safety net; should be a no-op in clean local DBs).
  2. `CREATE TYPE outbox_event_type_enum_new AS ENUM(...without ORDER_PAID_NOTIFICATION...)`.
  3. `ALTER TABLE outbox_events ALTER COLUMN event_type TYPE outbox_event_type_enum_new USING event_type::text::outbox_event_type_enum_new`.
  4. `DROP TYPE outbox_event_type_enum`.
  5. `ALTER TYPE outbox_event_type_enum_new RENAME TO outbox_event_type_enum`.

  A `WARNING` comment in `down()` explicitly tells future engineers running this rollback in production to FIRST audit `outbox_events.event_type` and decide whether to migrate rows to another event type before the DELETE. The DELETE assumes local-dev semantics.

  If `outbox_events.event_type` ever grows a `DEFAULT` or `CHECK` constraint in a future migration, the `down()` will need to drop and re-add those around step 3. Currently the column is bare `NOT NULL` with no default (verified against initial-schema migration line 61).

**C4 timing — what's still missing:**

After C5, `ORDER_PAID_NOTIFICATION` rows are being emitted but **not yet routed** by `outbox.worker`. The existing dispatch switch at `outbox.worker.ts:206-222` collapses five event types (now six counting `ORDER_PAID_NOTIFICATION`) into the warn-and-return-PROCESSED fallback. C4 will replace that fallback with `await this.notifications.dispatch(event.event_type, event.payload)` and flip the `NotificationsService.dispatch` default from warn-and-return to throw (matches `outbox.worker.ts:227`'s existing throw-on-unknown pattern, per the C1 decision-log).

Until C4 lands, the Telegram alert does **not** fire on real paid orders. The `handleOrderPaidNotification` handler exists and is exercised by the C5 unit tests; production traffic just doesn't reach it yet.

**Module wiring — `Location` added to `NotificationsModule.forFeature`:**

The handler loads `Location` to resolve the display name for the Telegram message body (`NEW ORDER — ... — Main St`). `NotificationsService` constructor now takes `@InjectRepository(Location)` alongside the existing `Order` / `Customer` / `MenuItem` repos, plus `TelegramService` from the same module. `app.module.ts` is unchanged.

**Tests:** `apps/api/src/modules/payments/webhook-orders.service.spec.ts` adds 2 tests in a new `markPaidFromWebhook happy path (C5 split-event)` describe block — one asserts BOTH outbox rows are inserted with identical payloads, one asserts the inserts happen inside the same transaction callback (both calls go through the same mocked `em.insert`, proving atomicity). `apps/api/src/modules/notifications/notifications.service.spec.ts` renames + restructures the `handleOrderPaid` describe block: 5 tests cover the load → call-telegram happy path, fallback-empty-string for missing customer, fallback-empty-string for missing location, warn-and-return when order is missing (no telegram call), and throw on malformed payload. Plus a new dispatch test asserting `ORDER_PAID` reaching NotificationsService is a defensive no-op (no handler invoked).

Total test count: 255 → 260 (+5 net, +7 new minus -2 renamed-and-restructured).

---

## 2026-05-11 — Notifications dispatch wiring (C4) + outbox-worker README update (C7)

**Decision:** wire `outbox.worker.ts`'s dispatch switch to call `NotificationsService.dispatch` for the six event-driven event types (`ORDER_PAID_NOTIFICATION` + the five non-PAID types previously no-op'd). Flip `NotificationsService.dispatch`'s `default` branch from warn-and-return to throw. After C4, the full dispatch chain is live end-to-end — real paid order → outbox row → worker pickup → notifications.dispatch → handleX → stub-logged alert (real Bot API + APNs delivery is C8).

**The dispatch routing change:**

Pre-C4 (`outbox.worker.ts:200-228`):

```ts
case ORDER_PAID:                 → orderWorker.handleOrderPaid
case ORDER_CANCELLED:        ┐
case ORDER_READY:            │
case ORDER_PICKED_UP:        ├── logger.warn('no handler') → return (marks PROCESSED)
case REFUND_CREATED:         │
case ITEM_OUT_OF_STOCK:      ┘
default:                         → throw new Error('Unknown outbox event type')
```

Post-C4:

```ts
case ORDER_PAID:                 → orderWorker.handleOrderPaid
case ORDER_PAID_NOTIFICATION: ┐
case ORDER_CANCELLED:         │
case ORDER_READY:             ├── await this.notifications.dispatch(eventType, payload)
case ORDER_PICKED_UP:         │
case REFUND_CREATED:          │
case ITEM_OUT_OF_STOCK:       ┘
default:                         → throw new Error('Unknown outbox event type')
```

The five non-PAID cases collapsed from "warn-and-skip" to "actually dispatch." The new `ORDER_PAID_NOTIFICATION` (added by C5) sits alongside them — same routing destination, different handler inside `NotificationsService`.

**The default-branch flip (warn → throw) — operational rationale:**

Pre-C4, `NotificationsService.dispatch`'s default was a warn-and-return — defensive, but harmless because no production code path called it. Post-C4, `outbox.worker → notifications.dispatch` runs on every event. A warn-and-return on an unknown runtime event type (e.g., a corrupted DB enum value or a stale outbox row whose event type was removed in a later migration) would mark the row as PROCESSED and silently drop the notification.

The throw flip changes the failure mode: an unknown event type now propagates up to `outbox.worker.processOne`'s try/catch → increments `attempts` → after 5 attempts the row transitions to DEAD → `TelegramService.alertDeadOutboxEvent` fires with the original payload. Operator gets a Telegram alert containing the bad event type + full payload — exactly the diagnostic they need.

The compile-time `_exhaustive: never` check stays as a complementary guard for the static case. Pre-C4 it was the only line of defense; post-C4 it's the first line, the throw is the second.

The C1 unit test that asserted `dispatch` warns on unknown event type is inverted to assert it throws. Single-test update.

**Operational behavior change — `[telegram-stub]` logs on every paid order:**

After C4 deploys, every successful Stripe webhook will produce a `[telegram-stub] {alert: 'newOrder', chat_id: 'owner', level: 'info', body: 'NEW ORDER — ...'}` log line in CloudWatch — via the `ORDER_PAID_NOTIFICATION` dispatch chain. This is the operational signal that the wiring works end-to-end. No real Telegram messages fire yet (`TelegramService.newOrder` is still in stub-log mode) — that's C8's job.

Similarly, every `ORDER_READY`, `ORDER_CANCELLED`, `ORDER_PICKED_UP`, `REFUND_CREATED`, `ITEM_OUT_OF_STOCK` outbox event produces a `[notifications-stub] ...` log line. These confirm the routing chain for the customer-facing events even though no real APNs push fires yet.

If the `[telegram-stub]` and `[notifications-stub]` log lines DON'T appear in CloudWatch on a paid order, the dispatch chain is broken — operator should grep CloudWatch for the absence as the regression signal.

**Transaction-boundary discussion — handler reads vs worker's locked transaction:**

The outbox worker dispatches inside a `SELECT FOR UPDATE SKIP LOCKED` transaction on the `outbox_events` row (see decision-log entry **"Outbox dispatch happens INSIDE the SKIP LOCKED transaction (Phase 1 trade-off)"** for the full pattern + the Phase 2 escape hatch). C4 introduces a new pattern in this picture: `NotificationsService.dispatch` and its downstream handlers (`handleOrderPaidNotification`, `handleOrderReady`, etc.) perform meaningful entity reads — `Order` with `items` relation, `Customer`, `Location`, `MenuItem`.

**Important:** these reads use the injected repositories (`@InjectRepository(Order)`, etc.), which go through the **global DataSource**, NOT the worker's locked transaction's `EntityManager`. The handler sees the database state OUTSIDE the worker's lock — there's no shared transaction context across the boundary.

Why this is acceptable for Phase 1:

- Dispatch latency is sub-second (in-process repository call → indexed by-id query → return). The window for concurrent entity mutation between the worker's pickup and the handler's read is microseconds.
- The handlers are read-only against `Order`/`Customer`/`Location`/`MenuItem` — they don't mutate. So even if they read a slightly-newer state than the worker's snapshot, no write-write conflict can occur.
- Notifications are best-effort. The C1 decision-log entry's warn-not-throw asymmetry already accepts that "the order moved between the outbox-write and the dispatch" is a benign condition — the handler logs what it sees and returns; the message reflects current state.

Why this becomes a concern in Phase 2 (cross-reference for future engineers):

- When dispatch goes external (Clover sync, real APNs network call, real Telegram Bot API), the worker's row lock is held for the duration of network I/O. This serializes outbox processing per row and risks timeout-induced rollback under load.
- The Phase 2 escape hatch is **claim-then-process**: lock the row, update its status to `CLAIMED`, commit. Dispatch runs OUTSIDE the lock. Mark `PROCESSED` in a second short transaction. The `processing_started_at` column already supports stuck-row recovery for this pattern.
- See the existing decision-log entry **"Outbox dispatch happens INSIDE the SKIP LOCKED transaction (Phase 1 trade-off)"** for the full design and the trade-offs that led to the Phase 1 in-lock pattern.

Future engineers reading "after C4 the handler loads entities outside the worker's lock" can find the answer here in one click instead of re-deriving it from scratch.

**C8 timing — what's still missing:**

After C4, the full event-driven dispatch chain is live but stub-logged:

- `ORDER_PAID_NOTIFICATION` → `TelegramService.newOrder` → `[telegram-stub]` log line. Real Telegram Bot API send: **C8**.
- `ORDER_READY`, `ORDER_CANCELLED`, `ORDER_PICKED_UP`, `REFUND_CREATED`, `ITEM_OUT_OF_STOCK` → `NotificationsService.handleX` → `[notifications-stub]` log line. Real APNs push + Telegram routing: **C8**.

C8 is the consolidated turn that swaps the stub logs for real network calls. The dispatch chain stays unchanged; only the inner send-method bodies (and their idempotency mechanics) change.

**C7 — workers/README.md updates:**

The intro paragraph for `outbox.worker.ts` ("for unimplemented event types the worker logs a warning and marks the row PROCESSED") is replaced with the explicit routing description (ORDER_PAID → orderWorker; six events → notifications.dispatch; unknown → throw). The "What's not active yet" table is rewritten — every row that previously said "Marked PROCESSED with no side effect. Becomes active when notifications module ships" is updated to say "Routes to NotificationsService.handleX (stub-logged). Becomes active when C8 ships real delivery." A new row for `ORDER_PAID_NOTIFICATION` is added. The "Future siblings (not yet built)" subsection is removed — the notifications module DID ship, and the past-tense replacement section describes the current wiring + the C8 gap.

**Tests:**

`apps/api/src/workers/outbox.worker.spec.ts` (NEW) — 10 tests covering the C4 dispatch surface:
- 1 ORDER_PAID → orderWorker routing test (regression guard).
- 6 parameterized notifications.dispatch routing tests (one per event type).
- 1 unknown-event-type throws test.
- 2 error-propagation tests (notifications.dispatch errors propagate; orderWorker errors propagate).

Top-of-file comment lists deliberately-uncovered surfaces (polling loop, SKIP LOCKED, batch processing, attempts lifecycle, DEAD transition, processing_started_at recovery, retryDead operator escape, WORKERS_ENABLED gate, graceful shutdown) for follow-up test-coverage turns. Same scope-narrowing pattern used in `checkout.service.spec.ts` (audit item #10 partial fix).

`apps/api/src/modules/notifications/notifications.service.spec.ts` — 1 inverted test: the existing "logs a warning and does NOT throw on an unknown event type" inverts to "THROWS on an unknown event type." Forced-cast pattern stays; the assertion flips from `resolves.toBeUndefined()` + `warnSpy.toHaveBeenCalled()` to `rejects.toThrow(/no handler registered for event type/)`.

Total test count: 260 → 270 (+10 net: +10 new worker tests + 0 net on notifications since one test inverted).

---

## 2026-05-12 — Real Telegram Bot API + APNs delivery (C8)

**Decision:** wire `TelegramService` to perform real `sendMessage` POSTs to `api.telegram.org` when credentials are configured, and wire `PushNotificationService` to dispatch via `@parse/node-apn` when the four `APNS_*` env vars are set and the `.p8` key file is readable. Both services preserve their structured log lines on every dispatch attempt and degrade gracefully to stub-only mode when credentials are absent (intentional pattern for local dev and pre-Apple-verification production states).

**Library choices:**

| Service | Chosen | Rejected | Reason |
|---|---|---|---|
| Telegram | Native `fetch` (Node ≥ 18) | `axios` | Bot API is a single POST to `/sendMessage`. `fetch` + JSON body covers it. Adding a dependency just to send one POST inflates the install footprint with no behavioural gain. |
| Telegram | Native `fetch` (Node ≥ 18) | `node-fetch@3` | Node ≥ 18 has fetch built in. The new `engines.node: ">=18"` field in `apps/api/package.json` pins this; production builds on older Node will refuse to install. |
| APNs | `@parse/node-apn@^8.1.0` | `apns2` | `@parse/node-apn` is the actively maintained Parse-foundation fork with the broader production install base. `apns2` is well-regarded but smaller community. Library is interchangeable behind the service interface if a future incident forces a swap. |
| APNs | `@parse/node-apn` | Hand-rolled HTTP/2 + JWT | APNs uses HTTP/2 with a per-request JWT signed by a `.p8` key, plus stream multiplexing and connection re-use. The wire protocol has subtle quirks (token expiry every 1h, stream limits, GOAWAY handling) that the library covers. Hand-rolling is a maintenance liability for negligible upside. |

**Failure-handling classification:**

Telegram (HTTP status → permanent/transient):

| Status | Verdict | Reason |
|---|---|---|
| 200–299 | success | normal happy path |
| 400 | permanent | malformed body / unknown parse mode / chat-not-found |
| 401 | permanent | bot token revoked or wrong |
| 403 | permanent | bot blocked by the user / kicked from the chat |
| 404 | permanent | chat ID does not resolve to a real chat |
| 429 | transient | rate limited; outbox retries on its own cadence (no Retry-After honour today — deferred) |
| 5xx | transient | Telegram-side outage |
| network / `AbortError` | transient | DNS failure, connection drop, 5s timeout |

APNs (reason field + status fallback):

| Signal | Verdict | Reason |
|---|---|---|
| `BadDeviceToken`, `Unregistered`, `DeviceTokenNotForTopic` | permanent | token is dead or for the wrong bundle |
| `BadCertificate`, `BadCertificateEnvironment` | permanent | bundle/sandbox mismatch (would need a fresh deploy to fix) |
| `ExpiredProviderToken`, `InvalidProviderToken`, `MissingProviderToken` | permanent for this call | library auto-refreshes; if it failed the call is dead |
| `BadTopic`, `TopicDisallowed`, `MissingDeviceToken`, `PayloadTooLarge` | permanent | call-site bug |
| `BadMessageId`, `BadExpirationDate`, `BadPriority`, `BadCollapseId`, `IdleTimeout` | permanent | request shape issue |
| status 410 (any reason, including empty) | permanent | Apple's canonical Unregistered signal; older payloads ship 410 with empty reason — classifier handles both |
| `TooManyRequests`, `ServiceUnavailable`, `InternalServerError`, `Shutdown` | transient | Apple-side or rate-limit issue |
| library-level throw (HTTP/2 stream, JWT sign failure, etc.) | transient | the outbox retries |
| unrecognised reason | transient (fail-open to retry) | allow-list classifier; missing a notification is worse than wasting a retry |

The classifier lives in `apps/api/src/modules/notifications/notification-error-classifier.ts` with the signatures `isPermanentTelegramStatus(status, description?)` and `isPermanentApnsResponse(reason, status?)`. Both are pure functions with no I/O. The 410-with-empty-reason case is the only nontrivial branch and is unit-tested with three input shapes (empty string, undefined, null).

**Outbox-lock decision (deferral, not solution):**

Going with bounded timeouts, NOT the claim-then-process refactor that `outbox.worker.ts:42-48` and the decision-log entry **"Outbox dispatch happens INSIDE the SKIP LOCKED transaction (Phase 1 trade-off)"** name as the long-term fix for going external.

Reasoning:
- Phase 1 traffic ceiling is ~50 orders/day. A 5-second worst-case lock hold caps at ~12 events/minute per pod, still far above the ceiling.
- Claim-then-process is a substantial refactor with its own risk surface (mid-claim crash recovery, claim-staleness sweeper, second-transaction PROCESSED transition). Adding it to C8 doubles the change footprint.
- Bounded timeouts solve the immediate "stuck worker" risk while leaving the established lock-hold pattern documented and intact.

Bounded-timeout implementation:
- Every Telegram `fetch` uses `AbortSignal.timeout(5000)`. `AbortError` is caught and rethrown as a transient send error.
- The APNs Provider is constructed with `requestTimeout: 5000`. The library handles the abort internally and surfaces an error to the `send()` promise.
- Worst-case per-event dispatch: ~5s. Worst-case lock hold per row: ~5s. At 50 orders/day this is invisible to the system.

The pre-existing entry **"Outbox dispatch happens INSIDE the SKIP LOCKED transaction (Phase 1 trade-off)"** remains the canonical reference for the Phase 2 claim-then-process refactor. C8 explicitly defers it.

**APNs Provider construction guard:**

`@parse/node-apn`'s `Provider` constructor reads the `.p8` key file synchronously. If the path is set but the file is missing or unreadable (the manager's exact early-Apple-verification scenario: paste `APNS_PRIVATE_KEY_PATH` before the file lands on disk), the constructor throws. Without a guard, this throw propagates out of `PushNotificationService`'s constructor and prevents the entire NestJS app from booting.

C8 wraps the constructor in try/catch:
- Success → store provider, `stubOnly = false`.
- Throw → log `[push] provider-init-failed: <error>`, set provider to null, `stubOnly = true`. The service runs in fallback mode and a backend restart with a valid path activates real delivery without code change.

This pattern matches the empty-env fallback: real delivery requires both env values AND a usable Provider; anything else is stub-only. The pattern composes — operators get one clear failure mode regardless of whether the gap is config absence or file absence.

**Log-prefix rename:**

C3 used `[telegram-stub]` and `[push-stub]` to signal "no real delivery, this log line IS the entire dispatch." Post-C8 the same log line represents a real dispatch ATTEMPT (or a stub fallback when credentials are absent). The `-stub` suffix is now misleading. C8 renames:

- `[telegram-stub]` → `[telegram]` on the six dispatch methods. The legacy `alertDeadOutboxEvent` plain-text format KEEPS its `[telegram-stub]` prefix per the C3 decision-log entry's stance on not migrating it. The asymmetry is intentional and documented in `telegram.service.ts`.
- `[push-stub]` → `[push]` on the dispatch path. `[push-skip]` is PRESERVED — it's operationally meaningful for "how many customers have push disabled" CloudWatch queries. The customer-not-found warn line is renamed `[push] missing-customer:` to avoid colliding with the dispatch prefix.

**`alertDeadOutboxEvent` body truncation:**

Telegram's `sendMessage` text cap is 4096 chars. A DEAD event whose `payload` JSON is large (e.g., a REFUND_CREATED with many embedded refund objects) could exceed this and return permanent 400. C8 truncates to 4000 chars before send, appending `... (truncated, see CloudWatch [telegram] dead-event-alert-failed for full payload)`. The truncated body fits inside the 4096 cap with safety margin. CloudWatch retains the full message (the `logger.warn` line is unaffected by the truncation).

**`alertDeadOutboxEvent` catch-all — defense in depth, not load-bearing safety:**

C8 catches any error from `sendToTelegram` inside `alertDeadOutboxEvent` and emits a `[telegram] dead-event-alert-failed` marker. This is belt-and-suspenders: the OUTER catch at [outbox.worker.ts:302](apps/api/src/workers/outbox.worker.ts:302) already wraps the call site and prevents a failed Telegram alert from rolling back the DEAD transition. The inner catch is so the method can be tested independently (the spec asserts non-propagation directly) and so a future direct caller (an admin tool, a manual replay script) gets safe semantics without re-deriving the cascade reasoning.

The earlier instruction-draft language claiming the inner catch as "critical safety preventing failure-loop cascade" was misleading; the outer catch already provides that. C8's commit message and this decision-log entry call it belt-and-suspenders honestly.

**Idempotency — accept-duplicates for Phase 1:**

If a Telegram send succeeds but the outbox transaction fails to commit (rare: DB connection drops between dispatch return and PROCESSED update), a retry would resend. Three reasons to defer dedup table to a follow-up:
1. Low operational impact: owner gets a duplicate "NEW ORDER" once-in-a-blue-moon, not a real complaint.
2. Infrastructure cost (an extra table + lookup per send) is disproportionate to the duplicate frequency.
3. Probability is low: the outbox worker holds the row lock during dispatch, so the window for "succeeded but didn't commit" is the post-fetch-return-pre-COMMIT slice — milliseconds.

The C1 decision-log entry's warn-not-throw subsection accepts the same idempotency stance for the load-the-entities side. C8 inherits it on the send side.

**Graceful degradation — empty env → stub-only:**

The same pattern across both services:

- Telegram: if `TELEGRAM_BOT_TOKEN` OR `TELEGRAM_OWNER_CHAT_ID` is empty, the service skips fetch and only logs.
- APNs: if any of the four required env vars is empty, OR the Provider constructor throws, the service skips `provider.send()` and only logs.

This is the right pattern for two reasons. (1) Local dev: developers run the service without any credentials and still get the structured log line for verification that the call-site contract is correct. (2) Pre-credential production: the manager's current state has Telegram credentials but APNs still in Apple verification — Telegram alerts work, APNs falls back to stub. When Apple verifies, populating the env vars + restart activates real delivery with no code change.

**`BadDeviceToken`/`Unregistered` writeback deferral:**

When APNs returns BadDeviceToken or Unregistered, the customer's stored `push_token` is dead. The clean fix is to write `customer.push_token = null` so future sends skip the dead token entirely. C8 defers this writeback as post-launch tech debt:
- Operational cost of not fixing: one wasted send per uninstalled-device customer per future notification. Negligible at Phase 1 volume.
- The fix touches the customer entity and the send() method's transaction boundary, expanding C8's scope.
- The C8 commit is already large; adding writeback would make the diff and review surface harder to reason about.

A future turn (likely the same one that wires `pushNotifications.send()` into `handleOrderReady` and friends) can add the writeback as a focused change.

**Push service has no live call sites — honest about this:**

`PushNotificationService.send()` is currently exercised only by its own unit tests. No `NotificationsService` handler injects or calls it. C1 / C2 explicitly deferred wiring to a future turn (C3 was supposed to wire both Telegram and Push; only Telegram was wired in C5 for the ORDER_PAID_NOTIFICATION path).

C8 enables real APNs delivery for any future caller. When `handleOrderReady` / `handleOrderPickedUp` / `handleRefundCreated` (etc.) are wired to call `pushNotifications.send(...)`, real APNs delivery starts working without any code change here — just env + restart.

**`Provider.shutdown()` on app destroy:**

`@parse/node-apn`'s Provider holds persistent HTTP/2 sockets. Without an explicit `.shutdown()` call, the Node process can hang on exit (most visible in CI: jest reports "open handles" and forces a `--forceExit`). `PushNotificationService` now implements `OnModuleDestroy`, which Nest calls during shutdown; the hook calls `this.provider?.shutdown()`. Safe to call when the service is in stub-only mode (provider is null).

**`engines.node >= 18` added to `apps/api/package.json`:**

The project previously had no `engines` declaration. C8 depends on native `fetch`, available in Node ≥ 18. Pinning the engine field prevents a production-build regression on an older Node from silently breaking Telegram delivery (the build would still succeed, but `fetch` would be undefined at runtime, throwing on the first send). With `engines`, the `npm install` step on Node < 18 will warn (or fail with `--engine-strict`).

**`.env.example` and `.gitignore` additions:**

The pre-existing `.env.example` already had `APNS_*` and `TELEGRAM_*` placeholders. C8 updates it IN PLACE — never copies from the manager's `.env`, which now contains real Telegram credentials — adding inline comments that explain the empty-env → stub-only graceful-degradation pattern.

The `.gitignore` already covered `*.p8`, `*.pem`, `*.key`, `.env`, `.env.*`. C8 adds one line: `apps/api/secrets/`. The conventional location for the .p8 file is `apps/api/secrets/AuthKey_<KeyID>.p8`; the directory-level entry is belt-and-suspenders with the existing `*.p8` glob and protects against a future engineer naming the file without the `.p8` extension.

**Tests:**

- `apps/api/src/modules/notifications/notification-error-classifier.spec.ts` (NEW) — 21 tests covering each error-code branch for both classifiers, plus the 410-with-empty-reason edge case (three input shapes: empty string, undefined, null).
- `apps/api/src/modules/notifications/telegram.service.spec.ts` — rebuilt for the prefix rename and the new fetch-mocked dispatch paths. 26 tests covering: every dispatch method emits the `[telegram]` shape; configured-mode fetch is performed with the right URL + JSON body; unconfigured mode skips fetch; each permanent status (400/401/403/404) swallows; each transient status (429/500/502) throws; network errors and AbortError throw; non-JSON error responses are still classified by status; `alertDeadOutboxEvent` KEEPS `[telegram-stub]` prefix in both modes; its inner catch swallows network errors and HTTP 5xx without cascade; oversized payload is truncated to ≤4096 chars.
- `apps/api/src/modules/notifications/push-notification.service.spec.ts` — rebuilt for the prefix rename, new env-driven Provider construction, and apn-mocked send paths. 26 tests covering: input validation throws; missing-customer warn now emits `[push] missing-customer:`; `[push-skip]` PRESERVED; `[push]` dispatch line shape; security regression (token value absent from every log path); Provider construction skipped when env is incomplete; Provider constructed with the right `token`/`production`/`requestTimeout` options when env is complete; sandbox flag inversion (true → production: false); Provider constructor throw triggers stubOnly fallback; real apn `send()` happy path + each permanent reason (BadDeviceToken, Unregistered, 410-with-empty-reason, DeviceTokenNotForTopic) swallows; each transient reason (TooManyRequests, ServiceUnavailable, library-level throw) throws; `[push]` dispatch line emitted alongside real send; `onModuleDestroy` calls `provider.shutdown()` and is safe in stub-only mode.

Top-of-file comments name uncovered surfaces (HTTP/2 connection-pool behaviour under sustained load, JWT auto-refresh timing inside the library, sandbox/production credential rotation, Retry-After-aware backoff for 429s) for future work.

Total test count: 270 → 324 (+54 net: +21 classifier + +17 telegram + +16 push). The earlier instruction-draft number of "~300 expected" was a rough estimate; the actual delta is larger because the C8 spec rebuilds add coverage for the dual-mode paths (real-send happy-path, each permanent code, each transient code) that the pre-C8 stub specs did not exercise.
