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
- `OrdersService.markPaidFromWebhook` (PENDING_PAYMENT → PAID, stripe-webhook)
- `OrdersService.markFailedFromWebhook` (PENDING_PAYMENT → FAILED, stripe-webhook)
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

## 2026-05-08 — Documentation structure

**Decision:** A `docs/` folder with one document per concern (architecture, golden rules, glossary, troubleshooting, decision log) and per-module READMEs next to the code. Onboarding docs for each AI chat live under `docs/ai-onboarding/`.

**Considered:** A single `ARCHITECTURE.md` in the repo root, or a wiki, or no docs at all (lean on the spec PDF).

**Why this:** The PDF spec describes the destination but not the journey. AI chats start every session with no memory of prior decisions, and the per-domain split (one chat per app) means each chat needs its own focused entry point. Single-doc-in-root would grow into a 5k-line wall. A wiki is one more system to keep in sync. The current structure colocates module docs with their code so they get updated alongside it.
