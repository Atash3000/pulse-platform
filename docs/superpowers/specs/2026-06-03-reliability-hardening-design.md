# Reliability Hardening (Spec A) — Design

**Date:** 2026-06-03
**Status:** Approved design — ready for implementation planning
**Surface:** `apps/api` (NestJS) + `apps/ios` (SwiftUI)
**Audience:** the `/superpowers:writing-plans` planner and the implementing engineer.

---

## 1. Goal & gap

A read/QA audit of the platform surfaced four small failures in critical paths. None is about handling more orders — each is a way the app can glitch, slow, or break under ordinary conditions (a Redis blip, shared-NAT Wi-Fi, a slow Stripe minute, slow queries as data grows). This spec hardens those paths.

**Design target.** Build for **~500 orders/day with headroom**, not the original 50/day. At 500/day the load is ~0.35 orders/min average with peak-hour bursts of ~5–8/min — comfortably handled, but we size the fixes (pool, indexes) for roughly an order of magnitude beyond that so we don't revisit. The one change that would be required at *genuinely* high sustained concurrency — moving the Stripe call out of the checkout DB transaction — is **deliberately deferred** and tracked separately (see §6); the connection-pool sizing here is the interim safeguard.

The four issues, each confirmed against live code:

| # | Issue | Confirmed at |
|---|---|---|
| 1 | Menu cache is **not fail-open** — a Redis error 500s the menu | `menu.cache.ts:100` (unguarded `redis.get`); `health.module.ts` (no `commandTimeout`, no `on('error')`) |
| 2 | **IP-based rate limits** — shared-NAT customers block each other; webhook capped per shared Stripe IP | `checkout.controller.ts:37` (3/min/IP); `payments.controller.ts:45` (100/min/IP) |
| 3 | **Hot-path indexes missing** — order composites silently dropped; menu FK columns unindexed | `AddExplicitIndexes1778273529985.ts` (`up()` drops two composites); FK-only on menu tables |
| 4 | **No DB pool sizing & no iOS network timeout** — slow-Stripe drains the default 10-conn pool; `URLSession.shared` hangs 60s | `data-source.ts` (no `extra.max`); `APIClient` / `TokenRefresher` use `URLSession.shared` |

---

## 2. Scope

### In scope (4 fixes → 5 commits, one branch)
1. **Redis fail-open** on the menu read/write path + client `commandTimeout` + `on('error')`.
2. **Checkout-only** customer-aware throttle key + `@SkipThrottle()` on the Stripe webhook.
3. **One index migration** — restore/upgrade order composites **and** add the 4 menu FK indexes (framed as hot-path query safety), plus a decision-log entry.
4. **DB pool sizing** (env-driven, `data-source.ts`) and **iOS `URLSessionConfiguration` timeouts** (`apps/ios`) — two commits, split by surface.

### Out of scope (named so the plan doesn't drift)
- Cache **stampede / single-flight** on menu rebuild (separate future work).
- **Redis-backed throttler storage** (limits stay in-memory / per-replica — fine at 1 instance).
- **Global** throttler-key redesign (staff-by-id / customer-by-id / public-by-IP) — this spec touches **only checkout**.
- **Stripe-out-of-transaction** checkout redesign (§6 — tracked, deferred).
- **Table retention/pruning** of `outbox_events` / `order_events`.
- **iOS disk menu cache** — that is **Spec B**, its own brainstorm → spec → plan cycle.

---

## 3. Design by fix

### Fix 1 — Redis fail-open (commit 1, backend)

**Files:** `apps/api/src/modules/menu/menu.cache.ts`, `apps/api/src/modules/health/health.module.ts`.

- **Reads** (`getFullMenu`, `getItem`, and the internal `redis.get` at `menu.cache.ts:100`): catch a thrown Redis error → log (rate-limited so a sustained outage doesn't spam, but **not** a permanent "warn once" that would hide a *later* outage after recovery) → return `null`. `menu.service.ts` already treats `null` as a cache miss and builds from the DB, so **the service layer is unchanged**. This is separate from the existing JSON-corruption `catch` at `menu.cache.ts:102` (that handles a bad *value*; this handles a failed *call*).
- **Writes** (`setFullMenu`, `setItem`): a failed `SET` is caught, logged, and ignored — a cache-population failure must never break the request that triggered it.
- **Client** (`health.module.ts`): add `commandTimeout: 1000` (fail fast instead of hanging through the `maxRetriesPerRequest: 3` budget) and a `redis.on('error', (e) => logger.warn(...))` handler (observability; removes unhandled-error noise).
- **Outcome:** a Redis outage degrades the menu to direct-DB reads instead of 500-ing every customer. Satisfies Golden Rule #1 (menu loads) and #17 (non-critical surface fails safe).

### Fix 2 — Rate limiting (commit 2, backend, **payment-adjacent → diff shown before applying, §1.4**)

**Files:** a checkout-specific throttler guard/keying mechanism (new, under `apps/api/src/common/`; exact Nest `@nestjs/throttler` extension point — custom guard vs. tracker override — to be confirmed against the installed version during planning), `apps/api/src/modules/checkout/checkout.controller.ts`, `apps/api/src/modules/payments/payments.controller.ts`.

- **Checkout key:** apply a customer-aware throttle **only to the checkout route**. The key is resolved from the authenticated `req.user` customer id; if absent, falls back to IP. Limit stays `3/min`, now per customer — shared-NAT customers no longer block each other. **No other authenticated route's limiter semantics change.**
- **Webhook:** replace `@Throttle({ limit: 100, ttl: 60_000 })` with **`@SkipThrottle()`** on the webhook route. Stripe signature verification in the handler is the authentication gate; an IP/count cap is the wrong tool for a signature-authenticated endpoint and the shared-Stripe-IP bucket is what caused the 429 risk.
- Storage stays **in-memory** (decided — per-replica limits are moot at 1 instance; revisit with horizontal scaling).

### Fix 3 — Hot-path indexes (commit 3, migration + decision-log)

**Files:** new migration in `apps/api/src/database/migrations/`, `docs/decision-log.md`.

Add, in one migration — named indexes with a clean `up`/`down` (normal TypeORM run-once migration; no `IF NOT EXISTS` needed):

| Index | Serves |
|---|---|
| `orders(location_id, order_status, created_at)` | Admin live queue — filter **+** the `created_at ASC` sort (strict upgrade over the dropped 2-col `(location_id, order_status)`) |
| `orders(customer_id, created_at)` | Customer order history (restores the dropped composite) |
| `orders(order_status, created_at)` | `PendingPaymentCleanup` sweep (global, no location filter) |
| `menu_categories(location_id)` | Menu build — categories by location |
| `menu_items(category_id)` | Menu build — items by category |
| `modifier_groups(item_id)` | Menu build — groups by item |
| `modifiers(group_id)` | Menu build — modifiers by group |

- **Framing:** hot-path query safety, not merely regression repair. The order composites bite as `orders` grows; the menu FK indexes are cheap insurance that bites during a cache miss/stampede.
- **Redundancy check at implementation:** the four single-column `IDX_orders_*` indexes from `AddExplicitIndexes` may now be partly redundant (their leading columns are covered by the new composites). **Default = do NOT drop them — keep this an additive migration (safer).** Only drop a single-column index if a query audit *proves* it is redundant and unused; otherwise leave it. The small write-amplification cost is acceptable versus the risk of removing an index some query still relies on.
- **Decision-log entry:** document that `AddExplicitIndexes1778273529985` silently dropped `(location_id, order_status)` and `(customer_id, created_at)` with no rationale, why composites matter for these queries, and what this migration restores/upgrades.

### Fix 4 — Pool sizing + iOS timeout (commits 4 & 5 — split by surface, §1.6)

**Commit 4 — backend pool** (`apps/api/src/database/data-source.ts`):
- Add `extra: { max: Number(process.env.DATABASE_POOL_MAX ?? 20), connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 }`.
- **Deploy note (also added to `.env.example` + a README/devops doc):** production must set `DATABASE_POOL_MAX` intentionally as
  `floor((postgres_max_connections − reserved_connections) / api_instance_count)`.
  Default `20` is for local/staging only.

**Commit 5 — iOS timeout** (`apps/ios/PulseCoffeeApp/.../APIClient.swift`, `TokenRefresher.swift`):
- Build a shared `URLSessionConfiguration` with `timeoutIntervalForRequest = 15`, `timeoutIntervalForResource = 30`, `waitsForConnectivity = false`; inject the resulting `URLSession` into `APIClient` and `TokenRefresher` in place of `URLSession.shared`.
- Removes the 60s default hang that leaves the checkout button locked → force-quit → re-tap (the duplicate-*looking* state; backend idempotency still prevents a double charge).

---

## 4. Testing (§2.5 — each fix gets a test)

- **Fix 1:** unit — `MenuCache.getFullMenu`/`getItem` return `null` (do **not** throw) when the injected Redis client's `get` rejects; `setFullMenu` swallows a rejected `set`. Service-level: menu endpoint returns the DB-built menu when the cache layer errors.
- **Fix 2:** unit — the tracker yields **different** keys for two different authenticated customers (independent buckets) and the **same** key for one customer across calls; the webhook route is not throttled. (Regression for the shared-NAT block.)
- **Fix 3:** migration `up` then `down` runs clean on a test DB; existing order/menu query tests still pass. (Optional: an `EXPLAIN` assertion is overkill — skip.)
- **Fix 4:** backend — `DATABASE_POOL_MAX` is parsed into `extra.max` (config test). iOS — `APIClient`/`TokenRefresher` accept an injected session and use the configured timeouts (the session is no longer hard-wired to `.shared`).

---

## 5. Delivery

- **Branch:** create a GitHub issue ("Reliability hardening — Spec A"), then `fix/<issue#>-reliability-hardening` off the latest `main` (§7/§8). Five commits in the order below.
- **Commit order (cheapest-safest first):**
  1. Redis fail-open (low risk)
  2. DB pool sizing (low risk)
  3. iOS `URLSession` timeout (low risk)
  4. Index migration + decision-log entry (**migration shown before running**, §1.4)
  5. Checkout/webhook throttle (**payment-adjacent — diff shown before applying**, §1.4)
- **PR:** one PR is fine; may split iOS commits into a second PR if Xcode review is easier separately. Nothing reaches `origin` without explicit approval (§8).

---

## 6. Tracked follow-ups (NOT this spec)

- **Stripe-out-of-transaction** checkout redesign — the real fix for connection-hold under high sustained concurrency. Pool sizing (Fix 4) is the interim safeguard; this becomes necessary only well beyond the 500/day target. Path B (touches the sacred checkout flow). → its own brainstorm.
- **iOS disk menu cache (Spec B)** — Golden Rule #1's "instant from disk" half; the biggest *user-facing* gap, but a build, not a same-day fix.
- **Cache stampede / single-flight**, **Redis-backed throttler storage**, **`outbox`/`order_events` retention**, **staff dashboard** — all logged in the audit, none in Spec A.
