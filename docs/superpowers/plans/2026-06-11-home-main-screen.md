# Home (Main Screen) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder Home tab with the v4 Home screen — greeting, "your usual" reorder hero, "order again" row, and food pairings — backed by real data, with a guarded reorder→checkout flow.

**Architecture:** One new customer-scoped backend endpoint `GET /home/summary` returns reorder *signatures* (menu item + modifier IDs + quantity + a baseline price), computed by aggregating the customer's paid order items in memory (most-frequent = "usual"). iOS joins those signatures against the already-cached menu to render names/prices, and reorder maps a signature into the existing `CartManager` → existing sacred checkout flow. Wait-minutes moves onto the location summary payload (it is location-scoped data). Loyalty is deferred entirely (no backend; mocked numbers forbidden by decision-log 2026-05-14).

**Tech Stack:** NestJS + TypeORM + Jest (backend); SwiftUI + async/await + XCTest, XcodeGen project (iOS).

**Spec:** `docs/superpowers/specs/2026-06-11-home-main-screen-design.md`

**Branch:** Work on `feat/api/home-main-screen` off `main` (per CLAUDE.md §8 — do not commit to `main`). The commit steps below print `git commit` commands; only run them once on a feature branch.

**Refinement vs. spec §4:** The spec's `GET /home/summary` JSON included `waitMinutes`. This plan moves wait-minutes onto the **location summary** payload (`GET /locations` already feeds iOS's `LocationSummary`), because it is per-location data and Home already loads a location. `GET /home/summary` is therefore purely `{ usual, recent }`. This is the "expose it on the public location payload" path the spec itself flagged.

---

## File Structure

**Backend (`apps/api`)**
- Modify `src/modules/locations/locations.service.ts` — add `currentWaitMinutes` to `PublicLocationSummary` + its mapping.
- Modify `src/modules/locations/locations.service.spec.ts` (create if absent) — test the new field.
- Create `src/modules/home/home.types.ts` — `ReorderSignature`, `HomeSummaryResponse`.
- Create `src/modules/home/home.service.ts` — `HomeService.getHomeSummary(customerId)`.
- Create `src/modules/home/home.service.spec.ts` — aggregation unit tests.
- Create `src/modules/home/home.controller.ts` — `GET /home/summary`.
- Create `src/modules/home/home.controller.spec.ts` — delegation + customer-guard test.
- Create `src/modules/home/home.module.ts`.
- Modify `src/app.module.ts` — register `HomeModule`.

**iOS (`apps/ios/PulseCoffeeApp`)**
- Modify `Models/Location.swift` — add `currentWaitMinutes`.
- Create `Models/HomeSummary.swift` — `ReorderSignature`, `HomeSummary`.
- Create `Services/HomeService.swift` — `GET /home/summary`.
- Create `Features/Home/ReorderResolver.swift` — pure signature→menu resolution + guard.
- Create `Features/Home/HomeViewModel.swift` — load/state machine.
- Modify `Features/Cart/CartView.swift` — additive `autoAdvanceToCheckout` + `reorderNotice` params.
- Create `Features/Home/HomeView.swift` — screen + section subviews + reorder coordinator.
- Modify `Features/Navigation/MainTabView.swift` — (no change needed; it already calls `HomeView()`).
- Modify `Features/Navigation/Placeholders.swift` — delete the placeholder `HomeView`.
- Create `PulseCoffeeAppTests/ReorderResolverTests.swift`, `PulseCoffeeAppTests/HomeViewModelTests.swift`.

---

# Phase A — Backend

### Task 1: Expose `currentWaitMinutes` on the location list summary

**Files:**
- Modify: `apps/api/src/modules/locations/locations.service.ts`
- Test: `apps/api/src/modules/locations/locations.service.spec.ts`

- [ ] **Step 1: Read the current shape**

Read `apps/api/src/modules/locations/locations.service.ts`. Confirm `PublicLocationSummary` (used by `GET /locations`, the array endpoint) and how `getAll()`/`list()` maps entities → summaries. Note that `PublicLocationDetail` already exposes `current_wait_minutes` from `LocationSettings` (default `5` when no settings row). You are lifting that same value onto the summary.

- [ ] **Step 2: Write the failing test**

In `apps/api/src/modules/locations/locations.service.spec.ts` (create the file if it does not exist; mirror the repo's mocked-repository style from `orders.service.spec.ts`):

```ts
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { Location, LocationSettings } from '../../database/entities';
import { LocationsService } from './locations.service';

describe('LocationsService.list — currentWaitMinutes on summary', () => {
  function makeService(opts: { locations: Partial<Location>[]; settings: Partial<LocationSettings>[] }) {
    const locRepo = { find: jest.fn().mockResolvedValue(opts.locations) };
    const settingsRepo = { find: jest.fn().mockResolvedValue(opts.settings) };
    return new LocationsService(locRepo as any, settingsRepo as any);
  }

  it('uses the per-location current_wait_minutes when a settings row exists', async () => {
    const svc = makeService({
      locations: [{ id: 'loc-1', name: 'Maiden Ln', address: '100 Maiden Ln', phone: null, timezone: 'America/New_York' }],
      settings: [{ location_id: 'loc-1', current_wait_minutes: 4 } as Partial<LocationSettings>],
    });
    const out = await svc.list();
    expect(out[0].current_wait_minutes).toBe(4);
  });

  it('defaults current_wait_minutes to 5 when no settings row exists', async () => {
    const svc = makeService({
      locations: [{ id: 'loc-2', name: 'Broadway', address: '1 Broadway', phone: null, timezone: 'America/New_York' }],
      settings: [],
    });
    const out = await svc.list();
    expect(out[0].current_wait_minutes).toBe(5);
  });
});
```

> If `LocationsService`'s constructor signature or the list method name differs from `list()`, adjust the test to match the real names you read in Step 1 — keep the two assertions identical.

- [ ] **Step 3: Run the test, verify it fails**

Run (from `apps/api`): `npm test -- locations.service.spec`
Expected: FAIL — `out[0].current_wait_minutes` is `undefined` (field not yet on the summary).

- [ ] **Step 4: Implement**

In `locations.service.ts`:
1. Add `current_wait_minutes: number;` to the `PublicLocationSummary` interface.
2. In the list method, batch-load settings for the returned locations (one `settings.find({ where: { location_id: In(ids) } })` — **no N+1**), build a `Map<location_id, current_wait_minutes>`, and set `current_wait_minutes: waitByLocation.get(loc.id) ?? 5` on each summary.

```ts
// inside list():
const ids = locations.map((l) => l.id);
const settingsRows = ids.length
  ? await this.settings.find({ where: { location_id: In(ids) } })
  : [];
const waitByLocation = new Map(settingsRows.map((s) => [s.location_id, s.current_wait_minutes]));
return locations.map((loc) => ({
  // ...existing summary fields...
  current_wait_minutes: waitByLocation.get(loc.id) ?? 5,
}));
```

Import `In` from `typeorm` and inject the `LocationSettings` repository in the constructor if it is not already present (match how `PublicLocationDetail`'s `getById` already reads settings).

- [ ] **Step 5: Run the test, verify it passes**

Run: `npm test -- locations.service.spec`
Expected: PASS (both cases).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/locations/locations.service.ts apps/api/src/modules/locations/locations.service.spec.ts
git commit -m "feat(api): expose current_wait_minutes on location list summary"
```

---

### Task 2: `HomeService.getHomeSummary` — most-frequent reorder aggregation

**Files:**
- Create: `apps/api/src/modules/home/home.types.ts`
- Create: `apps/api/src/modules/home/home.service.ts`
- Test: `apps/api/src/modules/home/home.service.spec.ts`

- [ ] **Step 1: Define the response types**

Create `apps/api/src/modules/home/home.types.ts`:

```ts
/** One reorderable drink configuration. Prices are NOT authoritative — iOS
 *  renders the live price from the cached menu and the server recomputes the
 *  real total at checkout (Golden Rule #8). `lastUnitPriceCents` is a
 *  change-detection baseline for the iOS reorder guard only. */
export interface ReorderSignature {
  menuItemId: string;
  modifierIds: string[];
  quantity: number;
  lastUnitPriceCents: number;
}

export interface HomeSummaryResponse {
  /** Most-frequently ordered config across PAID orders, or null for a customer with no paid orders. */
  usual: ReorderSignature | null;
  /** Next most-frequent DISTINCT configs after `usual` (most-recent tiebreak). */
  recent: ReorderSignature[];
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/modules/home/home.service.spec.ts`. The service loads paid order-items via a query builder (`createQueryBuilder('oi').innerJoinAndSelect('oi.order','o')...getMany()`) and aggregates in memory. Mock the query-builder chain (same approach as `orders.service.spec.ts`):

```ts
import { PaymentStatus } from '../../database/entities';
import { HomeService } from './home.service';

type FakeItem = {
  menu_item_id: string;
  quantity: number;
  unit_price_cents: number;
  modifiers: { modifierId: string; name: string; priceCents: number }[];
  order: { created_at: Date };
};

function makeService(items: FakeItem[]) {
  const qb: any = {
    innerJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(items),
  };
  const repo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
  return { service: new HomeService(repo as any), qb };
}

const d = (iso: string) => new Date(iso);
const item = (id: string, mods: string[], price: number, at: string, qty = 1): FakeItem => ({
  menu_item_id: id,
  quantity: qty,
  unit_price_cents: price,
  modifiers: mods.map((m) => ({ modifierId: m, name: m, priceCents: 0 })),
  order: { created_at: d(at) },
});

describe('HomeService.getHomeSummary', () => {
  it('returns null usual and empty recent when the customer has no paid items', async () => {
    const { service } = makeService([]);
    const out = await service.getHomeSummary('cust-1');
    expect(out).toEqual({ usual: null, recent: [] });
  });

  it('picks the most-frequent config as usual', async () => {
    const { service } = makeService([
      item('latte', [], 525, '2026-06-01'),
      item('matcha', [], 645, '2026-06-02'),
      item('latte', [], 525, '2026-06-03'),
      item('latte', [], 525, '2026-06-04'),
    ]);
    const out = await service.getHomeSummary('cust-1');
    expect(out.usual).toEqual({ menuItemId: 'latte', modifierIds: [], quantity: 1, lastUnitPriceCents: 525 });
    expect(out.recent.map((r) => r.menuItemId)).toEqual(['matcha']);
  });

  it('treats modifier order as irrelevant (set equality) when grouping', async () => {
    const { service } = makeService([
      item('matcha', ['oat', 'lightIce'], 645, '2026-06-01'),
      item('matcha', ['lightIce', 'oat'], 645, '2026-06-05'),
    ]);
    const out = await service.getHomeSummary('cust-1');
    // Both rows collapse to ONE config seen twice → usual, modifierIds normalized (sorted).
    expect(out.usual).toEqual({ menuItemId: 'matcha', modifierIds: ['lightIce', 'oat'], quantity: 1, lastUnitPriceCents: 645 });
    expect(out.recent).toEqual([]);
  });

  it('breaks frequency ties by most-recent and uses the most-recent price + quantity', async () => {
    const { service } = makeService([
      item('latte', [], 500, '2026-06-01', 1),
      item('mocha', [], 600, '2026-06-02', 1),
      item('latte', [], 550, '2026-06-10', 2), // latte tie with mocha (1 each before this) → latte now 2, most-recent price 550, qty 2
    ]);
    const out = await service.getHomeSummary('cust-1');
    expect(out.usual).toEqual({ menuItemId: 'latte', modifierIds: [], quantity: 2, lastUnitPriceCents: 550 });
  });

  it('caps recent to RECENT_LIMIT distinct configs', async () => {
    const many: FakeItem[] = [];
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) many.push(item(id, [], 100, '2026-06-0' + (many.length + 1)));
    const { service } = makeService(many);
    const out = await service.getHomeSummary('cust-1');
    expect(out.recent.length).toBe(4); // usual + 4 recent = 5 surfaced of 6 distinct
  });

  it('filters to PAID orders only via the query', async () => {
    const { service, qb } = makeService([item('latte', [], 525, '2026-06-01')]);
    await service.getHomeSummary('cust-1');
    const andWhereCalls = qb.andWhere.mock.calls.flat();
    expect(andWhereCalls.some((c: string) => typeof c === 'string' && c.includes('payment_status'))).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `npm test -- home.service.spec`
Expected: FAIL — `Cannot find module './home.service'`.

- [ ] **Step 4: Implement the service**

Create `apps/api/src/modules/home/home.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OrderItem, PaymentStatus } from '../../database/entities';
import { HomeSummaryResponse, ReorderSignature } from './home.types';

/** Most recent paid order-items scanned per customer. A customer's lifetime
 *  item count is tiny at MVP scale; 200 is generous headroom and bounds the
 *  in-memory aggregation. */
const MAX_ITEMS = 200;
/** Configs surfaced in the "Order again" row, after `usual`. */
const RECENT_LIMIT = 4;

interface Bucket {
  menuItemId: string;
  modifierIds: string[]; // normalized (sorted)
  quantity: number;      // from the most-recent occurrence
  lastUnitPriceCents: number;
  lastAt: number;        // epoch ms of most-recent occurrence
  frequency: number;
}

@Injectable()
export class HomeService {
  constructor(
    @InjectRepository(OrderItem)
    private readonly orderItems: Repository<OrderItem>,
  ) {}

  async getHomeSummary(customerId: string): Promise<HomeSummaryResponse> {
    const items = await this.orderItems
      .createQueryBuilder('oi')
      .innerJoinAndSelect('oi.order', 'o')
      .where('o.customer_id = :cid', { cid: customerId })
      .andWhere('o.payment_status = :paid', { paid: PaymentStatus.SUCCEEDED })
      .orderBy('o.created_at', 'DESC')
      .take(MAX_ITEMS)
      .getMany();

    const buckets = new Map<string, Bucket>();
    for (const it of items) {
      const modifierIds = (it.modifiers ?? []).map((m) => m.modifierId).sort();
      const key = `${it.menu_item_id}|${modifierIds.join(',')}`;
      const at = it.order.created_at.getTime();
      const existing = buckets.get(key);
      if (existing) {
        existing.frequency += 1;
        // Items arrive most-recent-first, so the FIRST time we see a key is the
        // most-recent occurrence — keep that one's price/quantity.
      } else {
        buckets.set(key, {
          menuItemId: it.menu_item_id,
          modifierIds,
          quantity: it.quantity,
          lastUnitPriceCents: it.unit_price_cents,
          lastAt: at,
          frequency: 1,
        });
      }
    }

    const ranked = [...buckets.values()].sort(
      (a, b) => b.frequency - a.frequency || b.lastAt - a.lastAt,
    );

    const toSignature = (b: Bucket): ReorderSignature => ({
      menuItemId: b.menuItemId,
      modifierIds: b.modifierIds,
      quantity: b.quantity,
      lastUnitPriceCents: b.lastUnitPriceCents,
    });

    return {
      usual: ranked.length ? toSignature(ranked[0]) : null,
      recent: ranked.slice(1, 1 + RECENT_LIMIT).map(toSignature),
    };
  }
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `npm test -- home.service.spec`
Expected: PASS (all six cases).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/home/home.types.ts apps/api/src/modules/home/home.service.ts apps/api/src/modules/home/home.service.spec.ts
git commit -m "feat(api): home summary aggregation (most-frequent reorder signatures)"
```

---

### Task 3: `GET /home/summary` controller + module wiring

**Files:**
- Create: `apps/api/src/modules/home/home.controller.ts`
- Create: `apps/api/src/modules/home/home.controller.spec.ts`
- Create: `apps/api/src/modules/home/home.module.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Write the failing controller test**

Create `apps/api/src/modules/home/home.controller.spec.ts`:

```ts
import { ForbiddenException } from '@nestjs/common';
import { HomeController } from './home.controller';

describe('HomeController', () => {
  function makeController(summary = { usual: null, recent: [] }) {
    const service = { getHomeSummary: jest.fn().mockResolvedValue(summary) };
    return { controller: new HomeController(service as any), service };
  }

  it('delegates to the service with the customer id from the JWT', async () => {
    const { controller, service } = makeController({ usual: null, recent: [] });
    const out = await controller.summary({ user: { sub: 'cust-9', type: 'customer' } } as any);
    expect(service.getHomeSummary).toHaveBeenCalledWith('cust-9');
    expect(out).toEqual({ usual: null, recent: [] });
  });

  it('rejects a staff token with 403', async () => {
    const { controller } = makeController();
    await expect(
      controller.summary({ user: { sub: 'staff-1', type: 'staff', role: 'OWNER' } } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a missing user with 403', async () => {
    const { controller } = makeController();
    await expect(controller.summary({} as any)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- home.controller.spec`
Expected: FAIL — `Cannot find module './home.controller'`.

- [ ] **Step 3: Implement the controller**

Create `apps/api/src/modules/home/home.controller.ts` (mirror the guard/throttle/customer-check pattern from `orders.controller.ts`):

```ts
import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import type { JwtPayload } from '../auth/jwt-payload';
import { HomeService } from './home.service';
import { HomeSummaryResponse } from './home.types';

interface AuthedRequest extends Request {
  user?: JwtPayload;
}

@ApiTags('home')
@ApiBearerAuth('jwt')
@Controller('home')
@UseGuards(AuthGuard('jwt'))
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class HomeController {
  constructor(private readonly home: HomeService) {}

  @Get('summary')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Home reorder summary — most-frequent ("usual") + recent configs',
    description:
      'Returns reorder signatures only (menu item + modifier IDs + quantity + a non-authoritative baseline price). iOS renders names/prices from the cached menu; the server recomputes the real price at checkout.',
  })
  @ApiResponse({ status: 200, description: 'Reorder summary.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid customer JWT.' })
  @ApiResponse({ status: 403, description: 'Token belongs to a staff user, not a customer.' })
  async summary(@Req() req: AuthedRequest): Promise<HomeSummaryResponse> {
    return this.home.getHomeSummary(this.requireCustomer(req));
  }

  private requireCustomer(req: AuthedRequest): string {
    const user = req.user;
    if (!user || user.type !== 'customer' || !user.sub) {
      throw new ForbiddenException('Customer credentials required');
    }
    return user.sub;
  }
}
```

- [ ] **Step 4: Create the module and register it**

Create `apps/api/src/modules/home/home.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OrderItem } from '../../database/entities';
import { AuthModule } from '../auth/auth.module';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([OrderItem]),
    AuthModule, // for AuthGuard('jwt')
  ],
  controllers: [HomeController],
  providers: [HomeService],
})
export class HomeModule {}
```

In `apps/api/src/app.module.ts`: import `HomeModule` and add it to the `imports` array (alphabetically near the other feature modules).

- [ ] **Step 5: Run controller test + full build**

Run: `npm test -- home.controller.spec`
Expected: PASS (all three cases).

Run: `npm run build`
Expected: build succeeds (HomeModule is wired, no type errors).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/home/home.controller.ts apps/api/src/modules/home/home.controller.spec.ts apps/api/src/modules/home/home.module.ts apps/api/src/app.module.ts
git commit -m "feat(api): GET /home/summary endpoint (customer-scoped reorder summary)"
```

---

# Phase B — iOS

> Per the project memory: iOS uses **XcodeGen**. After creating any new `.swift` file, run `make project` from `apps/ios/` before building. Run tests with `make test` from `apps/ios/`. The dev backend must be rebuilt+restarted to serve the new endpoint (see "Local API runtime staleness" memory) before manual verification.

### Task 4: Add `currentWaitMinutes` to `LocationSummary`

**Files:**
- Modify: `apps/ios/PulseCoffeeApp/Models/Location.swift`

- [ ] **Step 1: Implement (fail-safe decode)**

`LocationSummary` currently uses the synthesized `Decodable`. Add the field with a custom decoder so a backend that has not yet deployed Task 1 still decodes (defaults to `5`, matching the backend default):

```swift
struct LocationSummary: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let address: String
    let phone: String?
    let timezone: String
    /// Current estimated prep wait in minutes for this location. Drives the
    /// Home greeting ("no line" / "~N min") and hero "Ready in N min".
    /// Decoded fail-safe: missing key → 5 (the backend's own default).
    let currentWaitMinutes: Int

    enum CodingKeys: String, CodingKey {
        case id, name, address, phone, timezone
        case currentWaitMinutes = "current_wait_minutes"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.name = try c.decode(String.self, forKey: .name)
        self.address = try c.decode(String.self, forKey: .address)
        self.phone = try c.decodeIfPresent(String.self, forKey: .phone)
        self.timezone = try c.decode(String.self, forKey: .timezone)
        self.currentWaitMinutes = (try? c.decode(Int.self, forKey: .currentWaitMinutes)) ?? 5
    }

    /// Memberwise init for tests / previews.
    init(id: String, name: String, address: String, phone: String?, timezone: String, currentWaitMinutes: Int = 5) {
        self.id = id; self.name = name; self.address = address
        self.phone = phone; self.timezone = timezone; self.currentWaitMinutes = currentWaitMinutes
    }
}
```

> Adding a custom `init(from:)` removes the synthesized one; the memberwise `init` keeps any existing in-memory construction (previews/tests) working. After editing, grep for `LocationSummary(` to confirm no call site breaks; fix any to use the labeled init.

- [ ] **Step 2: Regenerate + build**

Run (from `apps/ios`): `make build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Models/Location.swift
git commit -m "feat(ios): decode current_wait_minutes on LocationSummary"
```

---

### Task 5: `HomeSummary` model + `HomeService`

**Files:**
- Create: `apps/ios/PulseCoffeeApp/Models/HomeSummary.swift`
- Create: `apps/ios/PulseCoffeeApp/Services/HomeService.swift`

- [ ] **Step 1: Implement the model**

Create `apps/ios/PulseCoffeeApp/Models/HomeSummary.swift`:

```swift
import Foundation

/// Maps to backend `GET /api/v1/home/summary` (`HomeSummaryResponse`).
/// Signatures carry IDs + a baseline price only — iOS renders the live
/// name/price by joining `menuItemId` against the cached menu, and the
/// server recomputes the authoritative price at checkout (Golden Rule #8).
struct ReorderSignature: Decodable, Equatable, Identifiable {
    let menuItemId: String
    let modifierIds: [String]
    let quantity: Int
    /// Change-detection baseline for the reorder guard only — never displayed.
    let lastUnitPriceCents: Int

    enum CodingKeys: String, CodingKey {
        case menuItemId = "menuItemId"
        case modifierIds = "modifierIds"
        case quantity
        case lastUnitPriceCents = "lastUnitPriceCents"
    }

    /// Stable identity for SwiftUI lists: item + normalized modifier set.
    var id: String { menuItemId + "|" + modifierIds.sorted().joined(separator: ",") }

    init(menuItemId: String, modifierIds: [String], quantity: Int, lastUnitPriceCents: Int) {
        self.menuItemId = menuItemId; self.modifierIds = modifierIds
        self.quantity = quantity; self.lastUnitPriceCents = lastUnitPriceCents
    }
}

struct HomeSummary: Decodable, Equatable {
    let usual: ReorderSignature?
    let recent: [ReorderSignature]
}
```

> The backend ships camelCase keys (`menuItemId`, `lastUnitPriceCents`) here because the `HomeSummaryResponse` interface uses camelCase property names and Nest serializes them verbatim — unlike the snake_case menu payload. CodingKeys are explicit above to make that intentional.

- [ ] **Step 2: Implement the service**

Create `apps/ios/PulseCoffeeApp/Services/HomeService.swift` (mirror `MenuService`):

```swift
import Foundation

/// Fetches the Home reorder summary (most-frequent "usual" + recent configs)
/// for the signed-in customer. Customer JWT is injected by `APIClient`.
actor HomeService {
    static let shared = HomeService()

    private let client: APIClient

    init(client: APIClient = .shared) {
        self.client = client
    }

    /// Throws `APIError` on transport/decoding failure. Callers degrade
    /// fail-safe (Home is a non-critical surface, Golden Rule #17).
    func fetchSummary() async throws -> HomeSummary {
        try await client.get("/home/summary", query: [])
    }
}
```

> Confirm `APIClient.get`'s label is `query:` and it accepts an empty array (it does — `MenuService` calls `client.get("/menu", query: [...])`). If `query` has a default, `query: []` is still valid.

- [ ] **Step 3: Regenerate + build**

Run (from `apps/ios`): `make build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Models/HomeSummary.swift apps/ios/PulseCoffeeApp/Services/HomeService.swift
git commit -m "feat(ios): HomeSummary model + HomeService (GET /home/summary)"
```

---

### Task 6: `ReorderResolver` — signature → menu resolution + guard (pure, TDD)

**Files:**
- Create: `apps/ios/PulseCoffeeApp/Features/Home/ReorderResolver.swift`
- Test: `apps/ios/PulseCoffeeAppTests/ReorderResolverTests.swift`

- [ ] **Step 1: Write the failing test**

Create `apps/ios/PulseCoffeeAppTests/ReorderResolverTests.swift`:

```swift
import XCTest
@testable import PulseCoffeeApp

final class ReorderResolverTests: XCTestCase {

    private func mod(_ id: String, _ price: Int) -> Modifier {
        Modifier(id: id, name: id, priceCents: price, sortOrder: 0)
    }

    private func item(_ id: String, base: Int, available: Bool = true, mods: [Modifier] = []) -> MenuItem {
        let group = ModifierGroup(id: id + "-g", name: "g", required: false, multiSelect: true, sortOrder: 0, modifiers: mods)
        return MenuItem(id: id, name: id.capitalized, description: nil, basePriceCents: base,
                        imageURL: nil, available: available, quantityLeft: nil,
                        modifierGroups: mods.isEmpty ? [] : [group])
    }

    private func index(_ items: [MenuItem]) -> [String: MenuItem] {
        Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
    }

    func test_resolve_availableSamePrice_isReady() {
        let items = index([item("latte", base: 525)])
        let sig = ReorderSignature(menuItemId: "latte", modifierIds: [], quantity: 1, lastUnitPriceCents: 525)
        let outcome = ReorderResolver.resolve(sig, in: items)
        guard case let .ready(r) = outcome else { return XCTFail("expected .ready") }
        XCTAssertEqual(r.item.id, "latte")
        XCTAssertEqual(r.liveUnitPriceCents, 525)
        XCTAssertEqual(r.quantity, 1)
    }

    func test_resolve_priceChanged_isReview() {
        let items = index([item("latte", base: 550)]) // was 525
        let sig = ReorderSignature(menuItemId: "latte", modifierIds: [], quantity: 1, lastUnitPriceCents: 525)
        guard case .review = ReorderResolver.resolve(sig, in: items) else { return XCTFail("expected .review") }
    }

    func test_resolve_unavailableItem_isUnavailable() {
        let items = index([item("latte", base: 525, available: false)])
        let sig = ReorderSignature(menuItemId: "latte", modifierIds: [], quantity: 1, lastUnitPriceCents: 525)
        guard case .unavailable = ReorderResolver.resolve(sig, in: items) else { return XCTFail("expected .unavailable") }
    }

    func test_resolve_missingItem_isUnavailable() {
        let sig = ReorderSignature(menuItemId: "ghost", modifierIds: [], quantity: 1, lastUnitPriceCents: 525)
        guard case .unavailable = ReorderResolver.resolve(sig, in: [:]) else { return XCTFail("expected .unavailable") }
    }

    func test_resolve_summsModifierDeltasIntoLivePrice() {
        // base 600 + oat(+50) + lightIce(0) = 650; baseline 650 → ready
        let items = index([item("matcha", base: 600, mods: [mod("oat", 50), mod("lightIce", 0)])])
        let sig = ReorderSignature(menuItemId: "matcha", modifierIds: ["lightIce", "oat"], quantity: 1, lastUnitPriceCents: 650)
        guard case let .ready(r) = ReorderResolver.resolve(sig, in: items) else { return XCTFail("expected .ready") }
        XCTAssertEqual(r.liveUnitPriceCents, 650)
        XCTAssertEqual(Set(r.modifierIds), Set(["oat", "lightIce"]))
    }

    func test_indexByID_flattensAllCategories() {
        let menu = Menu(locationId: "loc", categories: [
            MenuCategory(id: "c1", name: "Coffee", sortOrder: 0, items: [item("latte", base: 525)], displayStyle: .list),
            MenuCategory(id: "c2", name: "Matcha", sortOrder: 1, items: [item("matcha", base: 645)], displayStyle: .spotlight),
        ], cachedAt: "")
        let idx = ReorderResolver.indexByID(menu)
        XCTAssertEqual(Set(idx.keys), Set(["latte", "matcha"]))
    }
}
```

- [ ] **Step 2: Run the test, verify it fails**

Run (from `apps/ios`): `make test`
Expected: FAIL — `ReorderResolver` is undefined (compile failure in the test target).

- [ ] **Step 3: Implement**

Create `apps/ios/PulseCoffeeApp/Features/Home/ReorderResolver.swift`:

```swift
import Foundation

/// Pure logic that turns a backend `ReorderSignature` into a concrete cart
/// line against the *current* cached menu, and classifies whether it can go
/// straight to checkout or needs a cart review.
///
/// The guard is a UX courtesy only — the server recomputes the authoritative
/// price at checkout (Golden Rule #8). `liveUnitPriceCents` here is for the
/// same-price comparison, not for charging.
enum ReorderResolver {

    /// A signature successfully mapped onto a live, available menu item.
    struct Resolution: Equatable {
        let item: MenuItem
        let quantity: Int
        let modifierIds: [String]
        let liveUnitPriceCents: Int
    }

    enum Outcome: Equatable {
        /// Available and price unchanged → eligible for straight-to-checkout.
        case ready(Resolution)
        /// Available but live price differs from the baseline → review in cart.
        case review(Resolution)
        /// Item missing from the menu or not orderable → review in cart (dropped).
        case unavailable
    }

    /// Flattens every category's items into an id→item lookup.
    static func indexByID(_ menu: Menu) -> [String: MenuItem] {
        var out: [String: MenuItem] = [:]
        for category in menu.categories {
            for item in category.items { out[item.id] = item }
        }
        return out
    }

    static func resolve(_ signature: ReorderSignature, in itemsByID: [String: MenuItem]) -> Outcome {
        guard let item = itemsByID[signature.menuItemId], item.available else {
            return .unavailable
        }
        let live = liveUnitPriceCents(for: item, modifierIds: signature.modifierIds)
        let resolution = Resolution(item: item,
                                    quantity: signature.quantity,
                                    modifierIds: signature.modifierIds,
                                    liveUnitPriceCents: live)
        return live == signature.lastUnitPriceCents ? .ready(resolution) : .review(resolution)
    }

    /// base price + the price deltas of the selected modifiers found on the item.
    private static func liveUnitPriceCents(for item: MenuItem, modifierIds: [String]) -> Int {
        let selected = Set(modifierIds)
        let deltas = item.modifierGroups
            .flatMap { $0.modifiers }
            .filter { selected.contains($0.id) }
            .reduce(0) { $0 + $1.priceCents }
        return item.basePriceCents + deltas
    }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run (from `apps/ios`): `make test`
Expected: PASS (all `ReorderResolverTests`).

- [ ] **Step 5: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Home/ReorderResolver.swift apps/ios/PulseCoffeeAppTests/ReorderResolverTests.swift
git commit -m "feat(ios): ReorderResolver — map reorder signature to live menu + price guard"
```

---

### Task 7: `HomeViewModel` — load/state machine (TDD)

**Files:**
- Create: `apps/ios/PulseCoffeeApp/Features/Home/HomeViewModel.swift`
- Test: `apps/ios/PulseCoffeeAppTests/HomeViewModelTests.swift`

- [ ] **Step 1: Write the failing test**

Create `apps/ios/PulseCoffeeAppTests/HomeViewModelTests.swift`. The VM takes an injected async fetch closure so tests don't touch the network:

```swift
import XCTest
@testable import PulseCoffeeApp

@MainActor
final class HomeViewModelTests: XCTestCase {

    private let emptySummary = HomeSummary(usual: nil, recent: [])
    private let oneSummary = HomeSummary(
        usual: ReorderSignature(menuItemId: "latte", modifierIds: [], quantity: 1, lastUnitPriceCents: 525),
        recent: []
    )

    func test_guest_doesNotFetch_andIsFallback() async {
        var called = false
        let vm = HomeViewModel(fetch: { called = true; return self.emptySummary })
        await vm.load(isSignedIn: false)
        XCTAssertFalse(called, "guest must not hit the summary endpoint")
        XCTAssertEqual(vm.content, .fallback)
    }

    func test_signedIn_success_isSignedInWithSummary() async {
        let vm = HomeViewModel(fetch: { self.oneSummary })
        await vm.load(isSignedIn: true)
        XCTAssertEqual(vm.content, .signedIn(oneSummary))
    }

    func test_signedIn_emptyHistory_isSignedInWithEmptySummary() async {
        let vm = HomeViewModel(fetch: { self.emptySummary })
        await vm.load(isSignedIn: true)
        XCTAssertEqual(vm.content, .signedIn(emptySummary))
    }

    func test_signedIn_fetchFailure_degradesToFallback() async {
        struct Boom: Error {}
        let vm = HomeViewModel(fetch: { throw Boom() })
        await vm.load(isSignedIn: true)
        XCTAssertEqual(vm.content, .fallback) // fail-safe, Golden Rule #17
    }
}
```

- [ ] **Step 2: Run the test, verify it fails**

Run (from `apps/ios`): `make test`
Expected: FAIL — `HomeViewModel` undefined.

- [ ] **Step 3: Implement**

Create `apps/ios/PulseCoffeeApp/Features/Home/HomeViewModel.swift`:

```swift
import Foundation
import Sentry

/// Drives the Home tab's reorder sections. Home is a NON-critical surface
/// (Golden Rule #17): a guest, an empty history, or a failed fetch all resolve
/// to a usable screen — never an error wall. The View layer reads `content`
/// and renders the featured fallback whenever there is no `usual`.
@MainActor
final class HomeViewModel: ObservableObject {

    enum Content: Equatable {
        case loading
        /// Signed-in customer; `summary.usual` may be nil (no paid history yet).
        case signedIn(HomeSummary)
        /// Guest, or any fetch failure → featured + pairings layout.
        case fallback
    }

    @Published private(set) var content: Content = .loading

    private let fetch: () async throws -> HomeSummary

    /// Production injects the real service; tests inject a closure.
    init(fetch: @escaping () async throws -> HomeSummary = { try await HomeService.shared.fetchSummary() }) {
        self.fetch = fetch
    }

    func load(isSignedIn: Bool) async {
        content = .loading
        guard isSignedIn else { content = .fallback; return }
        do {
            content = .signedIn(try await fetch())
        } catch {
            SentrySDK.capture(error: error)
            content = .fallback
        }
    }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run (from `apps/ios`): `make test`
Expected: PASS (all `HomeViewModelTests`).

- [ ] **Step 5: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Home/HomeViewModel.swift apps/ios/PulseCoffeeAppTests/HomeViewModelTests.swift
git commit -m "feat(ios): HomeViewModel state machine (guest/empty/success/failure)"
```

---

### Task 8: Make `CartView` reusable for reorder (additive params)

**Files:**
- Modify: `apps/ios/PulseCoffeeApp/Features/Cart/CartView.swift`

- [ ] **Step 1: Read the current `CartView`**

Read `apps/ios/PulseCoffeeApp/Features/Cart/CartView.swift`. Note: it owns `@State private var showCheckout`, pushes `CheckoutView` via `.navigationDestination(isPresented: $showCheckout)`, and is constructed as `CartView(locationId:foodItems:)`. You are adding two **optional** parameters with defaults so existing call sites (MenuView) are untouched.

- [ ] **Step 2: Add the parameters + behavior**

Add stored properties and update the init. Add an `.onAppear` that auto-advances, and a notice banner. Concretely:

```swift
struct CartView: View {
    // ...existing stored properties...
    let locationId: String
    let foodItems: [MenuItem]
    /// When true (reorder straight-to-checkout path), the cart immediately
    /// pushes CheckoutView on appear. Default false keeps the normal flow.
    let autoAdvanceToCheckout: Bool
    /// Optional one-line banner shown atop the cart when a reorder was
    /// adjusted (item removed / price changed). nil = no banner.
    let reorderNotice: String?

    init(locationId: String,
         foodItems: [MenuItem],
         autoAdvanceToCheckout: Bool = false,
         reorderNotice: String? = nil) {
        self.locationId = locationId
        self.foodItems = foodItems
        self.autoAdvanceToCheckout = autoAdvanceToCheckout
        self.reorderNotice = reorderNotice
    }

    // ...existing @State/@EnvironmentObject...
```

Inside `body`, attach to the existing root (the same view that already has the `.navigationDestination(isPresented: $showCheckout)`):

```swift
.onAppear {
    if autoAdvanceToCheckout && !cart.isEmpty { showCheckout = true }
}
```

And render the banner at the top of the cart's content stack (above the line list), only when present:

```swift
if let reorderNotice {
    Text(reorderNotice)
        .font(.footnote)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(Color.secondary.opacity(0.08))
}
```

> Keep the banner above the existing list and below any title. Do not change the existing checkout push, the edit-line destination, or `foodItems` handling.

- [ ] **Step 3: Regenerate + build + run existing tests**

Run (from `apps/ios`): `make test`
Expected: build succeeds; existing tests still PASS (no behavior change for the default-arg call sites).

- [ ] **Step 4: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Cart/CartView.swift
git commit -m "feat(ios): CartView gains optional reorder auto-advance + notice (defaults preserve current flow)"
```

---

### Task 9: `HomeView` — screen, sections, and reorder coordinator

**Files:**
- Create: `apps/ios/PulseCoffeeApp/Features/Home/HomeView.swift`

This task has no unit test (the repo unit-tests logic, not SwiftUI views — see `MenuView` which has none). Verification is build + manual. All reorder *logic* is already tested in Tasks 6–7.

- [ ] **Step 1: Implement `HomeView` and its sections**

Create `apps/ios/PulseCoffeeApp/Features/Home/HomeView.swift`:

```swift
import SwiftUI

/// The v4 Home tab. Loads the cached menu (for names/prices/pairings/featured
/// and reorder resolution) plus the customer's reorder summary, then renders:
/// greeting → usual hero → order-again → pair-with, with a featured-drink
/// fallback for guests, empty history, or any failure (Golden Rule #17).
/// Loyalty is intentionally absent until the loyalty backend ships (no mocked
/// numbers — decision-log 2026-05-14).
struct HomeView: View {

    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var cart: CartManager

    @StateObject private var menuVM = MenuViewModel()
    @StateObject private var homeVM = HomeViewModel()

    // Reorder → cart sheet (reuses the existing CartView/Checkout flow).
    @State private var showCart = false
    @State private var autoAdvance = false
    @State private var reorderNotice: String?

    private var isSignedIn: Bool {
        if case .loggedIn = appState.authState { return true }
        return false
    }

    private var firstName: String? {
        if case let .loggedIn(profile) = appState.authState { return profile.firstName }
        return nil
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    GreetingHeader(firstName: firstName, location: loadedLocation)

                    switch menuVM.state {
                    case .idle, .loading:
                        ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                    case let .loaded(_, menu):
                        content(for: menu)
                    case .failed:
                        // Menu failed: still show a calm prompt, never an error wall.
                        FeaturedFallback(menu: nil, onBrowse: goToMenu)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 32)
            }
            .navigationTitle("Pulse Coffee")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) { AccountAvatarButton() }
            }
            .task {
                await menuVM.load()
                await homeVM.load(isSignedIn: isSignedIn)
            }
            .sheet(isPresented: $showCart) {
                NavigationStack {
                    CartView(locationId: loadedLocation?.id ?? "",
                             foodItems: foodItems(in: menuFromState),
                             autoAdvanceToCheckout: autoAdvance,
                             reorderNotice: reorderNotice)
                }
            }
        }
    }

    // MARK: - Composed content (menu available)

    @ViewBuilder
    private func content(for menu: Menu) -> some View {
        let itemsByID = ReorderResolver.indexByID(menu)
        switch homeVM.content {
        case let .signedIn(summary) where summary.usual != nil:
            if let usual = summary.usual, let item = itemsByID[usual.menuItemId] {
                UsualHero(signature: usual,
                          item: item,
                          waitMinutes: loadedLocation?.currentWaitMinutes ?? 5,
                          onReorder: { reorder(usual, in: itemsByID) })
            }
            if !summary.recent.isEmpty {
                OrderAgainRow(signatures: summary.recent,
                              itemsByID: itemsByID,
                              onReorder: { sig in reorder(sig, in: itemsByID) })
            }
        default:
            // Guest, empty history, or fetch failure → featured drink.
            FeaturedFallback(menu: menu, onBrowse: goToMenu)
        }

        PairWithRow(foodItems: foodItems(in: menu), onAdd: { cart.add(item: $0) })
    }

    // MARK: - Reorder coordinator

    private func reorder(_ signature: ReorderSignature, in itemsByID: [String: MenuItem]) {
        switch ReorderResolver.resolve(signature, in: itemsByID) {
        case let .ready(r):
            cart.add(item: r.item, quantity: r.quantity, modifierIds: r.modifierIds)
            reorderNotice = nil
            autoAdvance = true          // sub-10s path: straight to checkout
        case let .review(r):
            cart.add(item: r.item, quantity: r.quantity, modifierIds: r.modifierIds)
            reorderNotice = "We updated your order — the price changed since you last ordered this."
            autoAdvance = false         // let the customer review before paying
        case .unavailable:
            reorderNotice = "That drink isn't available right now. Browse the menu to build a new order."
            autoAdvance = false
        }
        showCart = true
    }

    private func goToMenu() { /* no-op hook; tab switch handled by MainTabView's bar */ }

    // MARK: - Derivations

    private var menuFromState: Menu? {
        if case let .loaded(_, menu) = menuVM.state { return menu }
        return nil
    }

    private var loadedLocation: LocationSummary? {
        if case let .loaded(location, _) = menuVM.state { return location }
        return nil
    }

    /// Items from the menu's "Food" category, if present (fail-safe: empty hides the row).
    private func foodItems(in menu: Menu?) -> [MenuItem] {
        guard let menu else { return [] }
        return menu.categories.first(where: { $0.name.lowercased().contains("food") })?.items ?? []
    }
}

// MARK: - Sections

private struct GreetingHeader: View {
    let firstName: String?
    let location: LocationSummary?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(greeting).font(.title2.weight(.semibold))
            if let location {
                Text("\(location.name) · \(waitPhrase(location.currentWaitMinutes))")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        let part = hour < 12 ? "Morning" : (hour < 17 ? "Afternoon" : "Evening")
        if let firstName { return "\(part), \(firstName)." }
        return "Good \(part.lowercased())."
    }

    private func waitPhrase(_ minutes: Int) -> String {
        minutes <= 2 ? "no line right now" : "~\(minutes) min wait"
    }
}

private struct UsualHero: View {
    let signature: ReorderSignature
    let item: MenuItem
    let waitMinutes: Int
    let onReorder: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 16) {
                DrinkArt(token: item.artToken, size: 84)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Your usual").font(.caption.weight(.semibold))
                        .foregroundStyle(AppTheme.Colors.accentWarm)
                    Text(item.name).font(.title3.weight(.semibold))
                    if let config = modifierSummary {
                        Text(config).font(.subheadline).foregroundStyle(.secondary)
                    }
                    Text("Ready in ~\(max(waitMinutes, 1)) min")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
            }
            Button(action: onReorder) {
                HStack {
                    Text("Reorder").fontWeight(.semibold)
                    Spacer()
                    Text(item.displayPrice).fontWeight(.semibold)
                }
                .padding(.vertical, 14).padding(.horizontal, 18)
                .frame(maxWidth: .infinity)
                .background(AppTheme.Colors.accentWarm, in: RoundedRectangle(cornerRadius: 12))
                .foregroundStyle(.white)
            }
            .accessibilityLabel("Reorder \(item.name), \(item.displayPrice)")
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: AppTheme.Metrics.cardCornerRadius).fill(Color(.secondarySystemBackground)))
    }

    /// Names of the selected modifiers, resolved from the live item. Empty → nil.
    private var modifierSummary: String? {
        let selected = Set(signature.modifierIds)
        let names = item.modifierGroups.flatMap { $0.modifiers }.filter { selected.contains($0.id) }.map(\.name)
        return names.isEmpty ? nil : names.joined(separator: " · ")
    }
}

private struct OrderAgainRow: View {
    let signatures: [ReorderSignature]
    let itemsByID: [String: MenuItem]
    let onReorder: (ReorderSignature) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Order again").font(.headline)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(resolvable, id: \.0.id) { sig, item in
                        Button { onReorder(sig) } label: {
                            VStack(spacing: 6) {
                                DrinkArt(token: item.artToken, size: 56)
                                Text(item.name).font(.caption).lineLimit(1)
                                Text(item.displayPrice).font(.caption2).foregroundStyle(.secondary)
                            }
                            .frame(width: 88)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Reorder \(item.name), \(item.displayPrice)")
                    }
                }
            }
        }
    }

    /// Only signatures whose item still exists render (fail-safe).
    private var resolvable: [(ReorderSignature, MenuItem)] {
        signatures.compactMap { sig in itemsByID[sig.menuItemId].map { (sig, $0) } }
    }
}

private struct PairWithRow: View {
    let foodItems: [MenuItem]
    let onAdd: (MenuItem) -> Void

    var body: some View {
        if !foodItems.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("Pair with").font(.headline)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(foodItems) { food in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(food.name).font(.caption).lineLimit(1)
                                HStack {
                                    Text(food.displayPrice).font(.caption2).foregroundStyle(.secondary)
                                    Spacer()
                                    Button { onAdd(food) } label: { Image(systemName: "plus") }
                                        .accessibilityLabel("Add \(food.name)")
                                }
                            }
                            .padding(10)
                            .frame(width: 140)
                            .background(RoundedRectangle(cornerRadius: 10).fill(Color(.secondarySystemBackground)))
                        }
                    }
                }
            }
        }
    }
}

private struct FeaturedFallback: View {
    let menu: Menu?
    let onBrowse: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let featured {
                HStack(spacing: 16) {
                    DrinkArt(token: featured.artToken, size: 72)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Featured").font(.caption.weight(.semibold)).foregroundStyle(AppTheme.Colors.accentWarm)
                        Text(featured.name).font(.title3.weight(.semibold))
                        Text(featured.displayPrice).font(.subheadline).foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .padding(16)
                .background(RoundedRectangle(cornerRadius: AppTheme.Metrics.cardCornerRadius).fill(Color(.secondarySystemBackground)))
            }
            Text("Sign in to reorder your usual in seconds.")
                .font(.subheadline).foregroundStyle(.secondary)
        }
    }

    /// First `featured` item across the menu, else the first item overall. nil if no menu.
    private var featured: MenuItem? {
        guard let menu else { return nil }
        let all = menu.categories.flatMap { $0.items }
        return all.first(where: { $0.featured }) ?? all.first
    }
}

#Preview("Home — guest") {
    HomeView()
        .environmentObject(AppState())
        .environmentObject(CartManager())
}
```

> Notes for the implementer:
> - `goToMenu()` is a deliberate no-op hook — tab switching is owned by `MainTabView`'s bar; the fallback's sign-in nudge is copy-only here. If a "Browse menu" button is wanted later, it routes through `TabBarVisibility`/selection, which is out of scope for this plan.
> - All color/metric tokens used (`AppTheme.Colors.accentWarm`, `AppTheme.Metrics.cardCornerRadius`) exist in `Core/AppTheme.swift`. `DrinkArt(token:size:)` and `MenuItem.displayPrice` exist. If a token name differs, grep `AppTheme.swift` and use the nearest existing semantic token rather than inventing one.

- [ ] **Step 2: Regenerate + build**

Run (from `apps/ios`): `make build`
Expected: build succeeds. (`make project` is invoked by `make build`; if you hit "cannot find type" for the new file, run `make project` explicitly first.)

- [ ] **Step 3: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Home/HomeView.swift
git commit -m "feat(ios): v4 Home screen — greeting, usual hero, order-again, pair-with, featured fallback"
```

---

### Task 10: Retire the placeholder `HomeView` and verify end-to-end

**Files:**
- Modify: `apps/ios/PulseCoffeeApp/Features/Navigation/Placeholders.swift`

- [ ] **Step 1: Delete the placeholder `HomeView`**

In `apps/ios/PulseCoffeeApp/Features/Navigation/Placeholders.swift`, delete the `struct HomeView { ... }` definition (lines 13–26) **and** its `#Preview("Home")` line at the bottom. Leave `OrdersView`, `RewardsView`, `AccountView`, and `PlaceholderContent` untouched. `MainTabView` already calls `HomeView()` — it now resolves to the real screen in `Features/Home/HomeView.swift`.

> If the compiler complains that `PlaceholderContent`'s `tab:` init is now unused for Home, ignore it — `OrdersView`/`RewardsView` still use it.

- [ ] **Step 2: Regenerate, build, full test suite**

Run (from `apps/ios`): `make test`
Expected: build succeeds; entire suite PASSES (including `ReorderResolverTests` and `HomeViewModelTests`). There must be exactly one `HomeView` symbol now.

- [ ] **Step 3: Manual verification (real backend)**

Per the "Local API runtime staleness" memory, rebuild + migrate + restart the dev API so `GET /home/summary` and the location `current_wait_minutes` field are served. Then in the Simulator:
1. **Guest:** launch logged-out → Home shows greeting + featured drink + "Sign in to reorder" + pair-with. No crash, no spinner lock.
2. **Signed-in, no orders:** featured fallback (no usual hero), pair-with present.
3. **Signed-in with paid history:** usual hero shows the most-frequent drink + config; "Order again" row populated; tapping Reorder on an unchanged item jumps straight to Checkout; tapping a reorder whose price changed opens Cart with the notice banner.

- [ ] **Step 4: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Navigation/Placeholders.swift
git commit -m "feat(ios): swap placeholder Home for the real v4 Home screen"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** greeting+location+wait (Tasks 1,4,9 `GreetingHeader`); usual hero + reorder (Tasks 2,3,5,6,9); order-again (Tasks 2,9 `OrderAgainRow`); pair-with (Task 9 `PairWithRow`); guest/no-history/failure states (Task 7 + Task 9 `FeaturedFallback`); guarded reorder→checkout (Task 6 outcomes + Task 8 CartView + Task 9 `reorder()`); loyalty deferred (no task — intentional, spec §7). ✅ All §1–§9 spec sections map to a task.
- **Type consistency:** `ReorderSignature`/`HomeSummary` field names identical across backend (`home.types.ts`) and iOS (`HomeSummary.swift`); `ReorderResolver.Outcome` cases (`ready`/`review`/`unavailable`) used identically in tests (Task 6) and the coordinator (Task 9); `HomeViewModel.Content` (`loading`/`signedIn`/`fallback`) consistent across Tasks 7 and 9; `CartView` new params (`autoAdvanceToCheckout`, `reorderNotice`) consistent across Tasks 8 and 9.
- **Placeholders:** none — every code step shows complete code; every test step shows full assertions; every run step states the command + expected result.
- **Known soft spots flagged inline:** `LocationsService` constructor/method names (Task 1 Step 2 note), `APIClient.get` `query:` label (Task 5 Step 2 note), `AppTheme` token names (Task 9 note) — each tells the implementer how to adapt if the real symbol differs.
