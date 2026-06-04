# Reliability Hardening (Spec A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden four critical paths against ordinary failures (Redis blip, shared-NAT rate limits, slow-Stripe pool drain, slow queries from dropped indexes), sized for ~500 orders/day with headroom.

**Architecture:** Five independent, low-risk commits on one branch — cheapest/safest first, payment-adjacent throttle last. Each is TDD: failing test → minimal change → green → commit. No commit changes the checkout *logic* (Golden Rule #2); the throttle commit only changes the rate-limit *key* and exempts the signed webhook.

**Tech Stack:** NestJS 10 + TypeORM 0.3 + Postgres + ioredis 5 (`apps/api`); `@nestjs/throttler` 5.2.0; SwiftUI + `URLSession` actors (`apps/ios`). Tests: Jest (`apps/api`), XCTest (`apps/ios`).

**Source spec:** `docs/superpowers/specs/2026-06-03-reliability-hardening-design.md`

---

## Task 0: Branch setup (prep — gated per CLAUDE.md §8)

**Files:** none (git only).

- [ ] **Step 1: Create a tracking issue** (gives the branch its scope number)

```bash
gh issue create --title "Reliability hardening (Spec A): fail-open cache, throttle keying, pool, indexes, iOS timeout" \
  --body "Implements docs/superpowers/specs/2026-06-03-reliability-hardening-design.md. Five commits."
```

- [ ] **Step 2: Branch from latest main** (replace `<issue#>` with the number from Step 1)

```bash
git fetch origin                         # needs user OK per §8
git worktree add /Users/atamurad/Desktop/pulse-platform/.claude/worktrees/reliability \
  -b fix/<issue#>-reliability-hardening origin/main
```

> If you prefer to work in the current checkout instead of a worktree, ensure HEAD is reachable from `main` first (`git merge-base --is-ancestor main HEAD`). Do NOT commit to `main`. Move the already-written spec/plan docs onto this branch.

---

## Task 1: Redis fail-open on the menu cache (commit 1)

**Files:**
- Modify: `apps/api/src/modules/menu/menu.cache.ts`
- Modify: `apps/api/src/modules/health/health.module.ts:11-21`
- Test: `apps/api/src/modules/menu/menu.cache.spec.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/menu/menu.cache.spec.ts`:

```typescript
import { MenuCache } from './menu.cache';

// Minimal ioredis stand-in. Each test supplies the methods it needs.
function fakeRedis(overrides: Record<string, unknown> = {}) {
  return {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    smembers: jest.fn().mockResolvedValue([]),
    pipeline: jest.fn(),
    ...overrides,
  };
}

describe('MenuCache — fail-open on Redis errors', () => {
  it('getFullMenu returns null (does not throw) when redis.get rejects', async () => {
    const redis = fakeRedis({ get: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
    const cache = new MenuCache(redis as never);

    await expect(cache.getFullMenu('loc-1')).resolves.toBeNull();
  });

  it('getItem returns null (does not throw) when redis.get rejects', async () => {
    const redis = fakeRedis({ get: jest.fn().mockRejectedValue(new Error('timeout')) });
    const cache = new MenuCache(redis as never);

    await expect(cache.getItem('item-1')).resolves.toBeNull();
  });

  it('setFullMenu swallows a rejected redis.set (never breaks the caller)', async () => {
    const redis = fakeRedis({ set: jest.fn().mockRejectedValue(new Error('READONLY')) });
    const cache = new MenuCache(redis as never);

    await expect(cache.setFullMenu('loc-1', { ok: true })).resolves.toBeUndefined();
  });

  it('setItem swallows a rejected pipeline.exec', async () => {
    const redis = fakeRedis({
      pipeline: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnThis(),
        sadd: jest.fn().mockReturnThis(),
        expire: jest.fn().mockReturnThis(),
        exec: jest.fn().mockRejectedValue(new Error('down')),
      }),
    });
    const cache = new MenuCache(redis as never);

    await expect(cache.setItem('loc-1', 'item-1', { ok: true })).resolves.toBeUndefined();
  });

  it('still parses a valid hit', async () => {
    const redis = fakeRedis({ get: jest.fn().mockResolvedValue(JSON.stringify({ a: 1 })) });
    const cache = new MenuCache(redis as never);

    await expect(cache.getFullMenu('loc-1')).resolves.toEqual({ a: 1 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx jest src/modules/menu/menu.cache.spec.ts`
Expected: FAIL — `getFullMenu`/`getItem` reject (the unguarded `redis.get` throw propagates); `setFullMenu`/`setItem` reject.

- [ ] **Step 3: Make `menu.cache.ts` fail-open**

Replace the `readJson` and `writeJson` helpers and the `setItem` body. Add a rate-limited error logger (warns at most once per 30s so a sustained outage doesn't spam, but a *later* outage after recovery still logs — addresses spec §3 Fix 1).

Add this field + method to the `MenuCache` class (near the top, after `logger`):

```typescript
  private readonly logger = new Logger(MenuCache.name);

  // Rate-limit Redis-error warnings: at most one per window so a sustained
  // outage doesn't flood logs, but a NEW outage after recovery still logs
  // (not a permanent "warn once").
  private lastRedisErrorLogAt = 0;
  private static readonly REDIS_ERROR_LOG_WINDOW_MS = 30_000;

  private logRedisError(op: string, err: unknown): void {
    const now = Date.now();
    if (now - this.lastRedisErrorLogAt >= MenuCache.REDIS_ERROR_LOG_WINDOW_MS) {
      this.lastRedisErrorLogAt = now;
      this.logger.warn(
        `Redis ${op} failed; serving from DB (fail-open). ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
```

Replace `readJson`:

```typescript
  private async readJson<T>(key: string): Promise<T | null> {
    let raw: string | null;
    try {
      raw = await this.redis.get(key);
    } catch (err) {
      // Redis unreachable / timed out / failing over. Treat as a miss so the
      // caller falls back to Postgres — never 500 the menu (Golden Rules #1, #17).
      this.logRedisError(`GET ${key}`, err);
      return null;
    }
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Corrupted *value* (distinct from a failed *call* above). Drop and miss.
      this.logger.warn(`Corrupted cache entry at ${key}; dropping`);
      try {
        await this.redis.del(key);
      } catch (err) {
        this.logRedisError(`DEL ${key}`, err);
      }
      return null;
    }
  }
```

Replace `writeJson`:

```typescript
  private async writeJson(key: string, payload: unknown, ttl: number): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(payload), 'EX', ttl);
    } catch (err) {
      // A failed cache population must never break the request that triggered it.
      this.logRedisError(`SET ${key}`, err);
    }
  }
```

Wrap the `setItem` pipeline:

```typescript
  async setItem<T>(locationId: string, itemId: string, payload: T): Promise<void> {
    try {
      const pipeline = this.redis.pipeline();
      pipeline.set(ITEM_KEY(itemId), JSON.stringify(payload), 'EX', MENU_TTL_SECONDS);
      pipeline.sadd(ITEMS_BY_LOC_KEY(locationId), itemId);
      pipeline.expire(ITEMS_BY_LOC_KEY(locationId), MENU_TTL_SECONDS);
      await pipeline.exec();
    } catch (err) {
      this.logRedisError(`PIPELINE setItem ${itemId}`, err);
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx jest src/modules/menu/menu.cache.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Harden the Redis client (fail-fast + observability)**

In `apps/api/src/modules/health/health.module.ts`, update the `useFactory` to add `commandTimeout` and an `on('error')` handler:

```typescript
  useFactory: (config: ConfigService): Redis => {
    const client = new Redis({
      host: config.get<string>('REDIS_HOST') ?? 'localhost',
      port: Number(config.get<string>('REDIS_PORT') ?? 6379),
      password: config.get<string>('REDIS_PASSWORD') || undefined,
      tls: config.get<string>('REDIS_TLS') === 'true' ? {} : undefined,
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      // Fail a command fast instead of hanging through the full retry budget,
      // so the menu falls back to Postgres quickly during a Redis blip.
      commandTimeout: 1000,
      enableReadyCheck: true,
    });
    // ioredis emits 'error' on connection trouble; without a listener Node logs
    // an unhandled error. Log it (warn) so a Redis outage is observable.
    const logger = new Logger('RedisClient');
    client.on('error', (err) => logger.warn(`Redis client error: ${err.message}`));
    return client;
  },
```

Add `Logger` to the existing `@nestjs/common` import at the top of the file:

```typescript
import { Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
```

- [ ] **Step 6: Verify the build compiles**

Run: `cd apps/api && npm run build`
Expected: no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/menu/menu.cache.ts apps/api/src/modules/menu/menu.cache.spec.ts apps/api/src/modules/health/health.module.ts
git commit -m "fix(api): menu cache fails open when Redis errors

Redis GET/SET errors degrade to a DB build instead of 500-ing the menu
(Golden Rules #1, #17). Adds commandTimeout + on('error') to the client
and rate-limited error logging.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Explicit DB connection-pool sizing (commit 2)

**Files:**
- Modify: `apps/api/src/database/data-source.ts:21-36`
- Modify: `.env.example`
- Test: `apps/api/src/database/data-source.spec.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/database/data-source.spec.ts`:

```typescript
describe('data-source pool sizing', () => {
  const ORIGINAL = process.env.DATABASE_POOL_MAX;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DATABASE_POOL_MAX;
    else process.env.DATABASE_POOL_MAX = ORIGINAL;
    jest.resetModules();
  });

  it('defaults extra.max to 20 when DATABASE_POOL_MAX is unset', () => {
    delete process.env.DATABASE_POOL_MAX;
    jest.isolateModules(() => {
      const { dataSourceOptions } = require('./data-source');
      expect((dataSourceOptions.extra as { max: number }).max).toBe(20);
    });
  });

  it('reads extra.max from DATABASE_POOL_MAX', () => {
    process.env.DATABASE_POOL_MAX = '33';
    jest.isolateModules(() => {
      const { dataSourceOptions } = require('./data-source');
      expect((dataSourceOptions.extra as { max: number }).max).toBe(33);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx jest src/database/data-source.spec.ts`
Expected: FAIL — `dataSourceOptions.extra` is `undefined`.

- [ ] **Step 3: Add the `extra` block to `data-source.ts`**

In `apps/api/src/database/data-source.ts`, inside `dataSourceOptions`, add `extra` after the `logging` line:

```typescript
  logging: process.env.DATABASE_LOGGING === 'true' ? ['error', 'warn', 'migration'] : ['error'],
  // node-postgres pool. Default 10 is too small once checkout holds a
  // connection across the in-transaction Stripe call. PRODUCTION must set
  // DATABASE_POOL_MAX = floor((postgres_max_connections - reserved) / api_instances).
  // 20 is a safe local/staging default, NOT a production value.
  extra: {
    max: Number(process.env.DATABASE_POOL_MAX ?? 20),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx jest src/database/data-source.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Document the env var in `.env.example`**

Add to `.env.example` near the other `DATABASE_*` vars:

```
# DB connection pool ceiling PER API INSTANCE. Production MUST set this to
# floor((postgres_max_connections - reserved_connections) / api_instance_count).
# Default 20 is for local/staging only.
DATABASE_POOL_MAX=20
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/database/data-source.ts apps/api/src/database/data-source.spec.ts .env.example
git commit -m "perf(api): explicit DB connection pool sizing (DATABASE_POOL_MAX)

Default pg pool of 10 is exhausted when checkout holds a connection across
the in-transaction Stripe call. Env-driven max (default 20) + connection/idle
timeouts. Production sizes via floor((max_connections - reserved)/instances).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: iOS network request/resource timeouts (commit 3)

**Files:**
- Create: `apps/ios/PulseCoffeeApp/Core/URLSessionConfiguration+Pulse.swift`
- Modify: `apps/ios/PulseCoffeeApp/Core/APIClient.swift:60` (init default)
- Modify: `apps/ios/PulseCoffeeApp/Core/TokenRefresher.swift:39` (init default)
- Test: `apps/ios/PulseCoffeeAppTests/PulseURLSessionTests.swift` (create)

> **XcodeGen:** the project is generated, `.pbxproj` is gitignored. After adding the new file run `make project` from `apps/ios/` so the file is in the target (per project memory "iOS uses XcodeGen").

- [ ] **Step 1: Write the failing test**

Create `apps/ios/PulseCoffeeAppTests/PulseURLSessionTests.swift`:

```swift
import XCTest
@testable import PulseCoffeeApp

final class PulseURLSessionTests: XCTestCase {
    func test_pulseDefault_hasRequestAndResourceTimeouts() {
        let config = URLSessionConfiguration.pulse
        XCTAssertEqual(config.timeoutIntervalForRequest, 15)
        XCTAssertEqual(config.timeoutIntervalForResource, 30)
        XCTAssertFalse(config.waitsForConnectivity)
    }

    func test_pulseSession_usesPulseConfiguration() {
        XCTAssertEqual(URLSession.pulse.configuration.timeoutIntervalForRequest, 15)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run (confirm the scheme/name from the Xcode project — the test target is `PulseCoffeeAppTests`):
`cd apps/ios && xcodebuild test -scheme PulseCoffeeApp -destination 'platform=iOS Simulator,name=iPhone 15' -only-testing:PulseCoffeeAppTests/PulseURLSessionTests`
Expected: FAIL to compile — `URLSessionConfiguration.pulse` / `URLSession.pulse` undefined.

- [ ] **Step 3: Create the shared configuration**

Create `apps/ios/PulseCoffeeApp/Core/URLSessionConfiguration+Pulse.swift`:

```swift
import Foundation

extension URLSessionConfiguration {
    /// Shared config for all Pulse backend traffic. Replaces the 60s
    /// `URLSession.shared` default that leaves the checkout button locked on
    /// flaky shop Wi-Fi (customer force-quits → re-taps → duplicate-looking
    /// state; backend idempotency still prevents a double charge).
    static var pulse: URLSessionConfiguration {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15   // per-request inactivity
        config.timeoutIntervalForResource = 30  // whole-transfer ceiling
        config.waitsForConnectivity = false     // fail fast, don't park the request
        return config
    }
}

extension URLSession {
    /// App-wide session built from `URLSessionConfiguration.pulse`.
    static let pulse = URLSession(configuration: .pulse)
}
```

- [ ] **Step 4: Point `APIClient` and `TokenRefresher` at the shared session**

In `apps/ios/PulseCoffeeApp/Core/APIClient.swift`, change the init default (line ~60):

```swift
        session: URLSession = .pulse,
```

In `apps/ios/PulseCoffeeApp/Core/TokenRefresher.swift`, change the init default (line ~39):

```swift
        session: URLSession = .pulse,
```

(Tests that inject their own `URLSession` with `URLProtocol` stubbing are unaffected — only the production default changes.)

- [ ] **Step 5: Regenerate the project and run the test**

```bash
cd apps/ios && make project
xcodebuild test -scheme PulseCoffeeApp -destination 'platform=iOS Simulator,name=iPhone 15' -only-testing:PulseCoffeeAppTests/PulseURLSessionTests
```
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Core/URLSessionConfiguration+Pulse.swift apps/ios/PulseCoffeeApp/Core/APIClient.swift apps/ios/PulseCoffeeApp/Core/TokenRefresher.swift apps/ios/PulseCoffeeAppTests/PulseURLSessionTests.swift
git commit -m "fix(ios): request/resource timeouts via shared URLSession config

URLSession.shared defaults to a 60s hang on flaky Wi-Fi, locking the
checkout button. Shared .pulse config: 15s request / 30s resource /
no connectivity wait. Injected into APIClient + TokenRefresher.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Hot-path index migration (commit 4)

**Files:**
- Modify: `apps/api/src/database/entities.ts` (add `@Index` decorators)
- Create: `apps/api/src/database/migrations/1780000000000-AddReliabilityHotPathIndexes.ts`
- Modify: `docs/decision-log.md` (append entry)

> Needs the dev DB up (per project memory: `pulse-postgres` on port 5433). Indexes are **additive** — the redundant single-column `IDX_orders_*` indexes are intentionally **kept** (spec §3 Fix 3 default = do not drop without a proven-redundant audit).

- [ ] **Step 1: Add composite/FK `@Index` decorators to entities**

In `apps/api/src/database/entities.ts`, add three class-level decorators above `export class Order` (alongside the existing single-column ones at ~557-560):

```typescript
@Index('IDX_orders_loc_status_created', ['location_id', 'order_status', 'created_at'])
@Index('IDX_orders_customer_created', ['customer_id', 'created_at'])
@Index('IDX_orders_status_created', ['order_status', 'created_at'])
```

Add one class-level decorator above each menu entity (property names confirmed in `entities.ts`):

```typescript
// above export class MenuCategory  (line ~335)
@Index('IDX_menu_categories_location', ['location_id'])

// above export class MenuItem  (line ~360)
@Index('IDX_menu_items_category', ['category_id'])

// above export class ModifierGroup  (line ~431)
@Index('IDX_modifier_groups_item', ['item_id'])

// above export class Modifier  (line ~459)
@Index('IDX_modifiers_group', ['group_id'])
```

(`Index` is already imported in `entities.ts`.)

- [ ] **Step 2: Write the migration**

Create `apps/api/src/database/migrations/1780000000000-AddReliabilityHotPathIndexes.ts`:

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

// Restores the order composites silently dropped by AddExplicitIndexes
// (1778273529985) and adds menu FK indexes (Postgres does NOT auto-index FKs).
// Additive: existing single-column IDX_orders_* indexes are kept.
export class AddReliabilityHotPathIndexes1780000000000 implements MigrationInterface {
  name = 'AddReliabilityHotPathIndexes1780000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_loc_status_created" ON "orders" ("location_id", "order_status", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_customer_created" ON "orders" ("customer_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_status_created" ON "orders" ("order_status", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_menu_categories_location" ON "menu_categories" ("location_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_menu_items_category" ON "menu_items" ("category_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_modifier_groups_item" ON "modifier_groups" ("item_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_modifiers_group" ON "modifiers" ("group_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_modifiers_group"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_modifier_groups_item"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_menu_items_category"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_menu_categories_location"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_orders_status_created"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_orders_customer_created"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_orders_loc_status_created"`);
  }
}
```

- [ ] **Step 3: Run the migration up**

Run: `cd apps/api && npm run migration:run`
Expected: 7 `CREATE INDEX` statements execute; "Migration AddReliabilityHotPathIndexes1780000000000 has been executed successfully."

- [ ] **Step 4: Verify down/up is clean (revert then re-apply)**

```bash
cd apps/api
npm run migration:revert   # expect 7 DROP INDEX, clean
npm run migration:run      # re-apply, clean — leaves it applied
```
Expected: revert drops all 7 without error; re-run recreates them.

- [ ] **Step 5: Verify the build (entities compile with new decorators)**

Run: `cd apps/api && npm run build`
Expected: no TypeScript errors. (Also confirms `migration:generate` won't re-add these — entity metadata now matches the DB.)

- [ ] **Step 6: Append the decision-log entry**

Add to `docs/decision-log.md`:

```markdown
## 2026-06-03 — [api/database] — Restore + add hot-path indexes

**Decision:** New migration `AddReliabilityHotPathIndexes` adds `orders(location_id, order_status, created_at)`, `orders(customer_id, created_at)`, `orders(order_status, created_at)`, and FK indexes on `menu_categories(location_id)`, `menu_items(category_id)`, `modifier_groups(item_id)`, `modifiers(group_id)`. Additive — existing single-column `IDX_orders_*` indexes kept.

**Context:** Migration `AddExplicitIndexes1778273529985` silently dropped the composite indexes `(location_id, order_status)` and `(customer_id, created_at)` (visible in its own `down()`) with no decision-log entry, replacing them with single-column indexes. Those composites serve the admin live queue and customer history; Postgres also does not auto-index foreign keys, so the menu-build queries were sequential scans.

**Alternatives considered:** (1) Restore only the two dropped composites. (2) Re-add as the original 2-column shapes. (3) Drop the now-redundant single-column indexes in the same migration.

**Reasoning:** Framed as hot-path query safety, not just regression repair. `(location_id, order_status, created_at)` covers the live-queue filter AND its `created_at ASC` sort (a strict upgrade over the dropped 2-column). Kept additive to avoid removing an index a query still relies on without a proven-redundant audit.

**Trade-offs:** A few extra indexes add write cost — negligible at the ~500 orders/day target. A future audit may drop the redundant single-column `IDX_orders_*` indexes.
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/database/entities.ts "apps/api/src/database/migrations/1780000000000-AddReliabilityHotPathIndexes.ts" docs/decision-log.md
git commit -m "perf(api): restore + add hot-path indexes (order composites, menu FKs)

Restores composites silently dropped by AddExplicitIndexes and adds menu
FK indexes (Postgres does not auto-index FKs). Additive; single-column
indexes kept. Decision-log entry documents the regression.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Per-customer checkout throttle + skip throttle on signed webhook (commit 5)

**Payment-adjacent (§1.4): show this diff to the user before applying.**

**Files:**
- Create: `apps/api/src/common/throttle/throttle-by-customer.decorator.ts`
- Create: `apps/api/src/common/throttle/customer-aware-throttler.guard.ts`
- Modify: `apps/api/src/app.module.ts` (APP_GUARD class + import)
- Modify: `apps/api/src/modules/checkout/checkout.controller.ts` (add `@ThrottleByCustomer()`)
- Modify: `apps/api/src/modules/payments/payments.controller.ts` (`@Throttle` → `@SkipThrottle`)
- Test: `apps/api/src/common/throttle/customer-aware-throttler.guard.spec.ts`

> **Design note (verified):** `@nestjs/throttler@5.2.0` `getTracker(req)` receives only `req`, and the global `ThrottlerGuard` runs **before** the controller's `AuthGuard`, so `req.user` is undefined at throttle time. We therefore read the JWT `sub` directly from the `Authorization` header (decode only — no verification; it's just a bucket key, and `AuthGuard` still 401s a bad token downstream). Only the route decorated with `@ThrottleByCustomer()` changes; every other route keeps IP keying.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/common/throttle/customer-aware-throttler.guard.spec.ts`:

```typescript
import { Reflector } from '@nestjs/core';

import { CustomerAwareThrottlerGuard, customerSubFromAuthHeader } from './customer-aware-throttler.guard';

function bearerFor(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `Bearer header.${body}.sig`;
}

describe('customerSubFromAuthHeader', () => {
  it('returns sub for a customer token', () => {
    expect(customerSubFromAuthHeader(bearerFor({ sub: 'cust-1', type: 'customer' }))).toBe('cust-1');
  });

  it('returns null for a non-customer token (e.g. staff)', () => {
    expect(customerSubFromAuthHeader(bearerFor({ sub: 'staff-1', type: 'staff' }))).toBeNull();
  });

  it('returns null for garbage / missing header', () => {
    expect(customerSubFromAuthHeader('Bearer not-a-jwt')).toBeNull();
    expect(customerSubFromAuthHeader(undefined)).toBeNull();
  });
});

describe('CustomerAwareThrottlerGuard.getTracker', () => {
  const guard = new CustomerAwareThrottlerGuard({ throttlers: [] } as never, {} as never, new Reflector());
  const track = (req: Record<string, unknown>) =>
    (guard as unknown as { getTracker(r: Record<string, unknown>): Promise<string> }).getTracker(req);

  it('keys by customer sub when the route opted in', async () => {
    const req = { __throttleByCustomer: true, headers: { authorization: bearerFor({ sub: 'cust-9', type: 'customer' }) }, ip: '1.2.3.4' };
    await expect(track(req)).resolves.toBe('customer:cust-9');
  });

  it('gives two customers behind one IP independent keys', async () => {
    const a = { __throttleByCustomer: true, headers: { authorization: bearerFor({ sub: 'A', type: 'customer' }) }, ip: '1.2.3.4' };
    const b = { __throttleByCustomer: true, headers: { authorization: bearerFor({ sub: 'B', type: 'customer' }) }, ip: '1.2.3.4' };
    expect(await track(a)).not.toBe(await track(b));
  });

  it('falls back to IP when the route did not opt in', async () => {
    const req = { headers: { authorization: bearerFor({ sub: 'cust-1', type: 'customer' }) }, ip: '9.9.9.9' };
    await expect(track(req)).resolves.toBe('9.9.9.9');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx jest src/common/throttle/customer-aware-throttler.guard.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the decorator**

Create `apps/api/src/common/throttle/throttle-by-customer.decorator.ts`:

```typescript
import { SetMetadata } from '@nestjs/common';

/** Metadata key marking a route as "throttle by authenticated customer id". */
export const THROTTLE_BY_CUSTOMER = 'throttle_by_customer';

/**
 * Marks a route so the global throttler keys its bucket by customer id instead
 * of IP — so customers behind one NAT/Wi-Fi IP don't share a rate-limit bucket.
 * Apply ONLY to customer-authenticated routes (e.g. checkout).
 */
export const ThrottleByCustomer = () => SetMetadata(THROTTLE_BY_CUSTOMER, true);
```

- [ ] **Step 4: Create the guard**

Create `apps/api/src/common/throttle/customer-aware-throttler.guard.ts`:

```typescript
import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

import { THROTTLE_BY_CUSTOMER } from './throttle-by-customer.decorator';

/**
 * Decodes (does NOT verify) the JWT in an Authorization header and returns its
 * `sub` iff it is a customer token. Used only to build a throttle bucket key —
 * the route's AuthGuard still verifies and rejects bad tokens downstream.
 */
export function customerSubFromAuthHeader(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const parts = match[1].split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(json) as { sub?: unknown; type?: unknown };
    if (payload.type === 'customer' && typeof payload.sub === 'string' && payload.sub.length > 0) {
      return payload.sub;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Global throttler guard that keys routes marked with @ThrottleByCustomer() by
 * customer id, and every other route by IP (unchanged base behaviour).
 *
 * Why decode the header instead of using req.user: the global guard runs BEFORE
 * the controller's AuthGuard, so req.user is not populated yet (verified against
 * @nestjs/throttler@5.2.0, whose getTracker only receives `req`).
 */
@Injectable()
export class CustomerAwareThrottlerGuard extends ThrottlerGuard {
  // getRequestResponse is the one override with the ExecutionContext that also
  // returns the req getTracker will receive — stash the per-route flag here.
  protected getRequestResponse(context: ExecutionContext) {
    const result = super.getRequestResponse(context);
    const byCustomer = this.reflector.getAllAndOverride<boolean>(THROTTLE_BY_CUSTOMER, [
      context.getHandler(),
      context.getClass(),
    ]);
    (result.req as Record<string, unknown>).__throttleByCustomer = byCustomer === true;
    return result;
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    if (req.__throttleByCustomer === true) {
      const sub = customerSubFromAuthHeader(req.headers?.authorization);
      if (sub) return `customer:${sub}`;
    }
    const ips = req.ips as string[] | undefined;
    return ips && ips.length > 0 ? ips[0] : req.ip;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd apps/api && npx jest src/common/throttle/customer-aware-throttler.guard.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Register the guard globally**

In `apps/api/src/app.module.ts`, replace the import of `ThrottlerGuard` usage in the provider. Update the throttler import line and the provider:

```typescript
import { ThrottlerModule } from '@nestjs/throttler';
import { CustomerAwareThrottlerGuard } from './common/throttle/customer-aware-throttler.guard';
```

```typescript
  providers: [
    { provide: APP_GUARD, useClass: CustomerAwareThrottlerGuard },
  ],
```

(`ThrottlerGuard` is no longer referenced in `app.module.ts` — remove it from the `@nestjs/throttler` import.)

- [ ] **Step 7: Opt the checkout route into customer keying**

In `apps/api/src/modules/checkout/checkout.controller.ts`, import and apply the decorator, and fix the stale comment:

```typescript
import { ThrottleByCustomer } from '../../common/throttle/throttle-by-customer.decorator';
```

```typescript
  @Post()
  @HttpCode(HttpStatus.OK)
  // Spec Part 4.5: 3 requests / minute / customer. @ThrottleByCustomer makes the
  // global throttler key this route by authenticated customer id (not IP) so
  // customers on shared NAT/Wi-Fi don't block each other.
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ThrottleByCustomer()
```

Also update the 429 `@ApiResponse` description from "(>3/min from this IP)" to "(>3/min for this customer)".

- [ ] **Step 8: Skip throttle on the signed webhook**

In `apps/api/src/modules/payments/payments.controller.ts`, replace `Throttle` with `SkipThrottle`:

```typescript
import { SkipThrottle } from '@nestjs/throttler';
```

```typescript
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  // No rate cap: the Stripe signature IS the auth (an unsigned/forged request
  // is rejected at constructWebhookEvent regardless of rate), and all Stripe
  // deliveries share one source IP — an IP cap would 429 valid events on retry
  // bursts. Stripe's own retry schedule bounds the rate.
  @SkipThrottle()
```

Update the doc comment above the method (the "Spec Part 4.5 caps this at 100 req/min" line) to reflect the skip.

- [ ] **Step 9: Build and run the full API test suite**

```bash
cd apps/api && npm run build && npm test
```
Expected: compiles; all tests pass (including existing checkout/payments specs).

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/common/throttle/ apps/api/src/app.module.ts apps/api/src/modules/checkout/checkout.controller.ts apps/api/src/modules/payments/payments.controller.ts
git commit -m "fix(api): per-customer checkout throttle; skip throttle on signed webhook

Checkout is keyed by authenticated customer id (decoded from the JWT in the
guard, since the global throttler runs before AuthGuard) so shared-NAT
customers don't block each other. Webhook uses @SkipThrottle — the Stripe
signature is the auth and an IP cap would 429 valid retry bursts. Only the
checkout route's keying changes; all other routes keep IP semantics.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (whole branch)

- [ ] **Backend:** `cd apps/api && npm run build && npm test` — all green.
- [ ] **iOS:** `cd apps/ios && make project && xcodebuild test -scheme PulseCoffeeApp -destination 'platform=iOS Simulator,name=iPhone 15'` — all green.
- [ ] **Migration applied:** `cd apps/api && npm run migration:show` lists `AddReliabilityHotPathIndexes` as run.
- [ ] **Manual smoke (optional):** start the API with Redis stopped → `GET /api/v1/menu/:locationId` returns the menu from Postgres (not 500). Restart Redis → subsequent reads are cached again.
- [ ] **Publish:** print push/PR commands for the user; nothing reaches `origin` without explicit approval (§8). One PR is fine; may split iOS (commit 3) into a second PR if Xcode review is easier separately.

## Self-review notes (coverage vs spec)
- Spec §3 Fix 1 → Task 1 (reads, writes, setItem, commandTimeout, on('error'), rate-limited log). ✓
- Spec §3 Fix 2 → Task 5 (checkout-only customer key, webhook SkipThrottle, no global semantic change). ✓
- Spec §3 Fix 3 → Task 4 (3 order composites + 4 menu FK, additive, decision-log). ✓
- Spec §3 Fix 4 → Task 2 (pool, env-driven, deploy note) + Task 3 (iOS 15s/30s). ✓
- Out-of-scope items (stampede, Redis-backed throttler storage, Stripe-out-of-txn, retention, iOS disk cache) → not touched. ✓
