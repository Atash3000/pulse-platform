# Backend-Driven Store Hours & Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the store open/closing-soon/closed badge server-authoritative (computed in the shop's timezone, auto-updating), add a staff-authed endpoint to edit a location's weekly hours, and rename the seed location to "Pulse Coffee — Park Slope."

**Architecture:** A pure backend `computeStoreStatus(hours, timezone, now)` reuses the existing tz helpers in `hours-tz.ts` to return `{ status, next_transition_at, today_open, today_close }`. Those four fields ride on the public location payload (`GET /locations` + `/locations/:id`). iOS decodes them, deletes its hard-coded hours, and flips the badge locally at `next_transition_at`. A `PUT /admin/hours` endpoint (OWNER/MANAGER, scoped to the caller's own location) replaces the weekly schedule.

**Tech Stack:** NestJS + TypeORM + Jest + `date-fns-tz` (backend); SwiftUI + XCTest, XcodeGen (iOS).

**Spec:** `docs/superpowers/specs/2026-06-12-store-hours-status-design.md`

**Branch:** Work on `feat/api/store-hours-status` off `main` (CLAUDE.md §8 — don't commit to `main`). The commit steps print `git commit`; run them only on the feature branch.

**iOS workflow notes (from project memory):** XcodeGen — after adding a Swift file run `make project`. `make test` uses a generic destination xcodebuild rejects; run tests on a concrete sim: `xcodebuild test -scheme PulseCoffeeApp -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -project apps/ios/PulseCoffeeApp.xcodeproj`. Harness SourceKit "cannot find type" diagnostics on new files are stale-index false positives — trust a green build.

---

## File Structure

**Backend (`apps/api`)**
- Create `src/modules/locations/store-status.ts` — pure `computeStoreStatus` + types.
- Create `src/modules/locations/store-status.spec.ts` — exhaustive branch tests.
- Modify `src/modules/locations/locations.service.ts` — add the 4 fields to `PublicLocationSummary`/`PublicLocationDetail`, batch-load hours in `listActive` (no N+1), compute in both paths.
- Modify `src/modules/locations/locations.service.spec.ts` — wiring assertions.
- Create `src/modules/admin/dto/set-hours.dto.ts` — request DTO.
- Create `src/modules/admin/admin-hours.service.ts` + `.spec.ts` — validate + replace hours.
- Create `src/modules/admin/admin-hours.controller.ts` — `PUT /admin/hours`.
- Modify `src/modules/admin/admin.module.ts` — register the above + add `LocationHours` to `forFeature`.
- Modify `apps/api/scripts/seed-dev-data.ts` — rename to Park Slope, idempotent on the existing row.

**iOS (`apps/ios/PulseCoffeeApp`)**
- Modify `Models/Location.swift` — decode the 4 fields + wire-status mapping.
- Modify `Features/Menu/StoreStatus.swift` — delete hard-coded hours; keep the enum.
- Create `Features/Menu/StoreStatusRefreshClock.swift` — pure `secondsUntilNextTransition`.
- Modify `Features/Menu/MenuView.swift` — feed the dot from `location.storeStatus`, hide when nil, schedule the live refresh.
- Modify `Services/LocationService.swift` (+ `Features/Menu/MenuViewModel.swift`) — a location-only refresh for the live flip.
- Tests: `PulseCoffeeAppTests/LocationSummaryStatusTests.swift`, `StoreStatusRefreshClockTests.swift`.

---

# Phase A — Backend

### Task 1: `computeStoreStatus` pure function

**Files:**
- Create: `apps/api/src/modules/locations/store-status.ts`
- Test: `apps/api/src/modules/locations/store-status.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/locations/store-status.spec.ts`:

```ts
import { computeStoreStatus, HoursRow } from './store-status';

// All times are America/New_York. June 2026 is EDT (UTC-4).
const TZ = 'America/New_York';

// Mon–Fri 07:00–18:00, Sat 08:00–16:00, Sun closed (the seed schedule).
const WEEK: HoursRow[] = [
  { day_of_week: 0, open_time: '00:00:00', close_time: '00:00:00', is_closed: true },
  { day_of_week: 1, open_time: '07:00:00', close_time: '18:00:00', is_closed: false },
  { day_of_week: 2, open_time: '07:00:00', close_time: '18:00:00', is_closed: false },
  { day_of_week: 3, open_time: '07:00:00', close_time: '18:00:00', is_closed: false },
  { day_of_week: 4, open_time: '07:00:00', close_time: '18:00:00', is_closed: false },
  { day_of_week: 5, open_time: '07:00:00', close_time: '18:00:00', is_closed: false },
  { day_of_week: 6, open_time: '08:00:00', close_time: '16:00:00', is_closed: false },
];

// Helper: a UTC instant for a given NY wall-clock time on a known weekday.
// 2026-06-15 is a Monday. EDT = UTC-4, so NY 10:00 = 14:00Z.
const nyMondayAt = (hhmmZ: string) => new Date(`2026-06-15T${hhmmZ}:00Z`);

describe('computeStoreStatus', () => {
  it('returns null fields when the location has no hours', () => {
    expect(computeStoreStatus([], TZ, nyMondayAt('14:00'))).toEqual({
      status: null, next_transition_at: null, today_open: null, today_close: null,
    });
  });

  it('is open mid-day with the close-60m boundary as the next transition', () => {
    // Mon 10:00 NY (14:00Z). Close 18:00, closing-soon boundary 17:00 NY = 21:00Z.
    const r = computeStoreStatus(WEEK, TZ, nyMondayAt('14:00'));
    expect(r.status).toBe('open');
    expect(r.today_open).toBe('07:00');
    expect(r.today_close).toBe('18:00');
    expect(r.next_transition_at).toBe('2026-06-15T21:00:00.000Z'); // 17:00 NY
  });

  it('is closing_soon within 60 minutes of close, transition at close', () => {
    // Mon 17:30 NY = 21:30Z. Close 18:00 NY = 22:00Z.
    const r = computeStoreStatus(WEEK, TZ, nyMondayAt('21:30'));
    expect(r.status).toBe('closing_soon');
    expect(r.next_transition_at).toBe('2026-06-15T22:00:00.000Z'); // 18:00 NY
  });

  it('is closed before open, transition at today open', () => {
    // Mon 06:00 NY = 10:00Z. Opens 07:00 NY = 11:00Z.
    const r = computeStoreStatus(WEEK, TZ, nyMondayAt('10:00'));
    expect(r.status).toBe('closed');
    expect(r.today_open).toBe('07:00'); // operating day → still surfaced
    expect(r.next_transition_at).toBe('2026-06-15T11:00:00.000Z');
  });

  it('is closed after close, transition at the next day open', () => {
    // Mon 19:00 NY = 23:00Z. Closed; next open Tue 07:00 NY = 2026-06-16T11:00Z.
    const r = computeStoreStatus(WEEK, TZ, nyMondayAt('23:00'));
    expect(r.status).toBe('closed');
    expect(r.next_transition_at).toBe('2026-06-16T11:00:00.000Z');
  });

  it('is closed all day on a closed day, today_open/close null, next open is the following day', () => {
    // 2026-06-14 is a Sunday (closed). Sun 12:00 NY = 16:00Z. Next open Mon 07:00 = 2026-06-15T11:00Z.
    const sunNoon = new Date('2026-06-14T16:00:00Z');
    const r = computeStoreStatus(WEEK, TZ, sunNoon);
    expect(r.status).toBe('closed');
    expect(r.today_open).toBeNull();
    expect(r.today_close).toBeNull();
    expect(r.next_transition_at).toBe('2026-06-15T11:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run (from `apps/api`): `npm test -- store-status.spec`
Expected: FAIL — `Cannot find module './store-status'`.

- [ ] **Step 3: Implement**

Create `apps/api/src/modules/locations/store-status.ts`:

```ts
import {
  combineLocalDayAndTime,
  dayOfWeekInTz,
  isTimeWithinInTz,
  localMinutesInTz,
  resolveTimezone,
  startOfDayPlusDaysInTz,
  timeStringToMinutes,
} from './hours-tz';

export interface HoursRow {
  day_of_week: number;
  open_time: string; // "HH:MM:SS"
  close_time: string;
  is_closed: boolean;
}

export type StoreStatusValue = 'open' | 'closing_soon' | 'closed';

export interface StoreStatusResult {
  status: StoreStatusValue | null;
  next_transition_at: string | null; // ISO instant
  today_open: string | null; // "HH:mm" shop-local
  today_close: string | null;
}

const CLOSING_SOON_MINUTES = 60;

const NULL_RESULT: StoreStatusResult = {
  status: null,
  next_transition_at: null,
  today_open: null,
  today_close: null,
};

/** "07:00:00" → "07:00" */
function hm(time: string): string {
  return time.slice(0, 5);
}

/**
 * Walks forward up to 7 days (in tz) to the next open instant. Pure
 * array-based mirror of `HoursService.findNextOpening` (which is DB-backed).
 */
function nextOpenInstant(hours: HoursRow[], from: Date, tz: string): Date | null {
  const todayDow = dayOfWeekInTz(from, tz);
  for (let offset = 0; offset < 7; offset++) {
    const dow = (todayDow + offset) % 7;
    const row = hours.find((h) => h.day_of_week === dow);
    if (!row || row.is_closed) continue;
    const dayAnchor = startOfDayPlusDaysInTz(from, offset, tz);
    const openAt = combineLocalDayAndTime(dayAnchor, row.open_time, tz);
    if (offset === 0 && openAt.getTime() <= from.getTime()) continue; // already past today's open
    return openAt;
  }
  return null;
}

/**
 * Store status in the location's timezone. Pure — `now` is a parameter so
 * tests pin every branch. Closing-soon = within 60 min of close. Overnight
 * ranges (open > close) are treated as plain "open" (no closing-soon window)
 * since coffee shops don't use them; the data model permits them but the
 * badge stays simple.
 */
export function computeStoreStatus(
  hours: HoursRow[],
  timezone: string,
  now: Date,
): StoreStatusResult {
  if (!hours.length) return NULL_RESULT;

  const { tz } = resolveTimezone(timezone);
  const todayDow = dayOfWeekInTz(now, tz);
  const today = hours.find((h) => h.day_of_week === todayDow) ?? null;

  const operatingToday = !!today && !today.is_closed;
  const today_open = operatingToday ? hm(today!.open_time) : null;
  const today_close = operatingToday ? hm(today!.close_time) : null;

  const nextOpen = nextOpenInstant(hours, now, tz);
  const nextOpenIso = nextOpen ? nextOpen.toISOString() : null;

  if (!operatingToday || !isTimeWithinInTz(now, today!.open_time, today!.close_time, tz)) {
    return { status: 'closed', next_transition_at: nextOpenIso, today_open, today_close };
  }

  // Open right now. Decide open vs closing_soon and the next boundary.
  const openMin = timeStringToMinutes(today!.open_time);
  const closeMin = timeStringToMinutes(today!.close_time);
  const curMin = localMinutesInTz(now, tz);

  // Only the simple (open < close) case gets a closing-soon window + precise
  // boundary; overnight stays plain open with the next-open as the transition.
  if (openMin < closeMin) {
    const dayAnchor = startOfDayPlusDaysInTz(now, 0, tz);
    const closeAt = combineLocalDayAndTime(dayAnchor, today!.close_time, tz);
    const minsToClose = closeMin - curMin;
    if (minsToClose <= CLOSING_SOON_MINUTES) {
      return {
        status: 'closing_soon',
        next_transition_at: closeAt.toISOString(),
        today_open,
        today_close,
      };
    }
    const closingSoonAt = new Date(closeAt.getTime() - CLOSING_SOON_MINUTES * 60_000);
    return {
      status: 'open',
      next_transition_at: closingSoonAt.toISOString(),
      today_open,
      today_close,
    };
  }

  return { status: 'open', next_transition_at: nextOpenIso, today_open, today_close };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -- store-status.spec`
Expected: PASS (all six cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/locations/store-status.ts apps/api/src/modules/locations/store-status.spec.ts
git commit -m "feat(api): computeStoreStatus — tz-aware open/closing-soon/closed + next transition

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Expose status on the location payload

**Files:**
- Modify: `apps/api/src/modules/locations/locations.service.ts`
- Test: `apps/api/src/modules/locations/locations.service.spec.ts`

- [ ] **Step 1: Read the current service**

Read `apps/api/src/modules/locations/locations.service.ts`. Note: `PublicLocationSummary`/`PublicLocationDetail` interfaces; the module-level `toSummary(location, currentWaitMinutes)` helper; `listActive()` already batch-loads settings via `In(ids)`; `getById()` already loads `hours` + `settings`. The `hours` repo is already injected (`private readonly hours: Repository<LocationHours>`).

- [ ] **Step 2: Write the failing wiring test**

Add to `apps/api/src/modules/locations/locations.service.spec.ts` (mirror the existing mocked-repo style; the existing file builds the service via `new LocationsService(locRepo, hoursRepo, settingsRepo)`):

```ts
describe('LocationsService — store status on payload', () => {
  const WEEK = [
    { day_of_week: 1, open_time: '07:00:00', close_time: '18:00:00', is_closed: false },
  ];
  function makeService(opts: { locations: any[]; hours: any[]; settings: any[] }) {
    const locRepo = { find: jest.fn().mockResolvedValue(opts.locations) };
    const hoursRepo = { find: jest.fn().mockResolvedValue(opts.hours) };
    const settingsRepo = { find: jest.fn().mockResolvedValue(opts.settings) };
    return { svc: new LocationsService(locRepo as any, hoursRepo as any, settingsRepo as any), hoursRepo };
  }

  it('includes status + next_transition_at + today fields on each summary, hours batch-loaded once', async () => {
    const { svc, hoursRepo } = makeService({
      locations: [{ id: 'loc-1', name: 'P', address: 'a', phone: null, timezone: 'America/New_York' }],
      hours: WEEK.map((h) => ({ ...h, location_id: 'loc-1' })),
      settings: [],
    });
    const out = await svc.list ? await (svc as any).listActive() : await (svc as any).listActive();
    expect(Object.keys(out[0])).toEqual(
      expect.arrayContaining(['status', 'next_transition_at', 'today_open', 'today_close']),
    );
    // Batch-loaded: exactly one hours query for all locations (no N+1).
    expect(hoursRepo.find).toHaveBeenCalledTimes(1);
  });
});
```

> Adjust the constructor arg order / method name to whatever the real file uses (the existing spec already calls `listActive()`); keep the two assertions (fields present; hours loaded once) intact. Do NOT assert the concrete status value here — that's time-dependent and is covered exhaustively by `store-status.spec.ts`.

- [ ] **Step 3: Run the test, verify it fails**

Run: `npm test -- locations.service.spec`
Expected: FAIL — the summary lacks the four keys.

- [ ] **Step 4: Implement**

In `locations.service.ts`:
1. Import: `import { computeStoreStatus, StoreStatusResult } from './store-status';`
2. Extend the interfaces:

```ts
export interface PublicLocationSummary {
  id: string;
  name: string;
  address: string;
  phone: string | null;
  timezone: string;
  current_wait_minutes: number;
  status: 'open' | 'closing_soon' | 'closed' | null;
  next_transition_at: string | null;
  today_open: string | null;
  today_close: string | null;
}
```

3. Update the `toSummary` helper to take the status result and spread it:

```ts
function toSummary(
  l: Location,
  currentWaitMinutes: number,
  status: StoreStatusResult,
): PublicLocationSummary {
  return {
    id: l.id,
    name: l.name,
    address: l.address,
    phone: l.phone,
    timezone: l.timezone,
    current_wait_minutes: currentWaitMinutes,
    status: status.status,
    next_transition_at: status.next_transition_at,
    today_open: status.today_open,
    today_close: status.today_close,
  };
}
```

4. In `listActive()`, batch-load hours alongside settings and group them, then compute per location:

```ts
const ids = rows.map((l) => l.id);
const [settingsRows, hoursRows] = await Promise.all([
  ids.length ? this.settings.find({ where: { location_id: In(ids) } }) : Promise.resolve([]),
  ids.length ? this.hours.find({ where: { location_id: In(ids) } }) : Promise.resolve([]),
]);
const waitByLocation = new Map(settingsRows.map((s) => [s.location_id, s.current_wait_minutes]));
const hoursByLocation = new Map<string, typeof hoursRows>();
for (const h of hoursRows) {
  const list = hoursByLocation.get(h.location_id) ?? [];
  list.push(h);
  hoursByLocation.set(h.location_id, list);
}
const now = new Date();
return rows.map((l) =>
  toSummary(
    l,
    waitByLocation.get(l.id) ?? 5,
    computeStoreStatus(hoursByLocation.get(l.id) ?? [], l.timezone, now),
  ),
);
```

5. In `getById()`, compute from the already-loaded `hours` and pass to `toSummary`:

```ts
const status = computeStoreStatus(hours, location.timezone, new Date());
return {
  ...toSummary(location, currentWaitMinutes, status),
  hours: hours.map((h) => ({ /* ...existing mapping... */ })),
  settings: { /* ...existing... */ },
};
```

> `computeStoreStatus` accepts the `LocationHours` entity rows directly — they carry `day_of_week`/`open_time`/`close_time`/`is_closed` (the `HoursRow` shape).

- [ ] **Step 5: Run the test, verify it passes + full suite**

Run: `npm test -- locations.service.spec` (PASS). Then `npm test` (full suite) and `npm run build`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/locations/locations.service.ts apps/api/src/modules/locations/locations.service.spec.ts
git commit -m "feat(api): expose store status + next transition on location payload

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `PUT /admin/hours`

**Files:**
- Create: `apps/api/src/modules/admin/dto/set-hours.dto.ts`
- Create: `apps/api/src/modules/admin/admin-hours.service.ts`
- Create: `apps/api/src/modules/admin/admin-hours.service.spec.ts`
- Create: `apps/api/src/modules/admin/admin-hours.controller.ts`
- Modify: `apps/api/src/modules/admin/admin.module.ts`

- [ ] **Step 1: Create the DTO**

Create `apps/api/src/modules/admin/dto/set-hours.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/; // HH:mm 00:00–23:59

export class HoursDayDto {
  @ApiProperty({ minimum: 0, maximum: 6, description: '0=Sun … 6=Sat' })
  @IsInt()
  @Min(0)
  @Max(6)
  day_of_week!: number;

  @ApiProperty({ example: '07:00', description: 'HH:mm, shop-local' })
  @Matches(TIME_RE, { message: 'open_time must be HH:mm' })
  open_time!: string;

  @ApiProperty({ example: '18:00', description: 'HH:mm, shop-local' })
  @Matches(TIME_RE, { message: 'close_time must be HH:mm' })
  close_time!: string;

  @ApiProperty()
  @IsBoolean()
  is_closed!: boolean;
}

export class SetHoursDto {
  @ApiProperty({ type: [HoursDayDto], description: 'Exactly 7 entries, one per day_of_week 0–6.' })
  @IsArray()
  @ArrayMinSize(7)
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => HoursDayDto)
  hours!: HoursDayDto[];
}
```

- [ ] **Step 2: Write the failing service test**

Create `apps/api/src/modules/admin/admin-hours.service.spec.ts`:

```ts
import { BadRequestException } from '@nestjs/common';
import { AdminHoursService } from './admin-hours.service';

const STAFF = { staff_user_id: 's1', location_id: 'loc-1', role: 'OWNER' };
const fullWeek = (overrides: any[] = []) => {
  const base = Array.from({ length: 7 }, (_, d) => ({
    day_of_week: d, open_time: '07:00', close_time: '18:00', is_closed: false,
  }));
  for (const o of overrides) base[o.day_of_week] = { ...base[o.day_of_week], ...o };
  return base;
};

function makeService() {
  const saved: any[] = [];
  const manager = {
    delete: jest.fn().mockResolvedValue({}),
    insert: jest.fn().mockImplementation((_e, rows) => { saved.push(...rows); return {}; }),
    find: jest.fn().mockImplementation(async () => saved),
  };
  const ds = { transaction: jest.fn().mockImplementation(async (cb: any) => cb(manager)) };
  return { service: new AdminHoursService(ds as any), manager, saved };
}

describe('AdminHoursService.setHours', () => {
  it('replaces all hours for the staff location in a transaction', async () => {
    const { service, manager } = makeService();
    await service.setHours(STAFF as any, { hours: fullWeek() });
    expect(manager.delete).toHaveBeenCalledWith(expect.anything(), { location_id: 'loc-1' });
    expect(manager.insert).toHaveBeenCalledTimes(1);
    const inserted = manager.insert.mock.calls[0][1];
    expect(inserted).toHaveLength(7);
    expect(inserted.every((r: any) => r.location_id === 'loc-1')).toBe(true);
  });

  it('rejects a missing/duplicate day (must cover 0–6 exactly once)', async () => {
    const { service } = makeService();
    const dupSunday = fullWeek().map((h, i) => (i === 6 ? { ...h, day_of_week: 0 } : h));
    await expect(service.setHours(STAFF as any, { hours: dupSunday })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects open_time >= close_time on an operating day', async () => {
    const { service } = makeService();
    const bad = fullWeek([{ day_of_week: 1, open_time: '18:00', close_time: '07:00', is_closed: false }]);
    await expect(service.setHours(STAFF as any, { hours: bad })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows open == close when the day is closed', async () => {
    const { service } = makeService();
    const week = fullWeek([{ day_of_week: 0, open_time: '00:00', close_time: '00:00', is_closed: true }]);
    await expect(service.setHours(STAFF as any, { hours: week })).resolves.toBeDefined();
  });
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `npm test -- admin-hours.service.spec`
Expected: FAIL — `Cannot find module './admin-hours.service'`.

- [ ] **Step 4: Implement the service**

Create `apps/api/src/modules/admin/admin-hours.service.ts`:

```ts
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LocationHours } from '../../database/entities';
import { SetHoursDto } from './dto/set-hours.dto';
import { StaffContext } from './staff-context';

@Injectable()
export class AdminHoursService {
  private readonly logger = new Logger(AdminHoursService.name);

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async setHours(staff: StaffContext, dto: SetHoursDto): Promise<LocationHours[]> {
    this.validate(dto);
    return this.ds.transaction(async (em) => {
      await em.delete(LocationHours, { location_id: staff.location_id });
      const rows = dto.hours.map((h) => ({
        location_id: staff.location_id,
        day_of_week: h.day_of_week,
        // Persist as HH:MM:SS to match the Postgres `time` column convention.
        open_time: `${h.open_time}:00`,
        close_time: `${h.close_time}:00`,
        is_closed: h.is_closed,
      }));
      await em.insert(LocationHours, rows);
      this.logger.log(`hours replaced at ${staff.location_id} by staff=${staff.staff_user_id}`);
      return em.find(LocationHours, {
        where: { location_id: staff.location_id },
        order: { day_of_week: 'ASC' },
      });
    });
  }

  /** Structural checks class-validator can't express per-field. */
  private validate(dto: SetHoursDto): void {
    const days = dto.hours.map((h) => h.day_of_week);
    const unique = new Set(days);
    if (unique.size !== 7 || [0, 1, 2, 3, 4, 5, 6].some((d) => !unique.has(d))) {
      throw new BadRequestException('hours must cover each day_of_week 0–6 exactly once');
    }
    for (const h of dto.hours) {
      if (!h.is_closed && h.open_time >= h.close_time) {
        throw new BadRequestException(
          `day ${h.day_of_week}: open_time must be earlier than close_time`,
        );
      }
    }
  }
}
```

> String comparison `h.open_time >= h.close_time` is correct for zero-padded `HH:mm`. Overnight ranges are intentionally rejected — coffee shops don't need them and the badge logic assumes `open < close`.

- [ ] **Step 5: Run the service test, verify it passes**

Run: `npm test -- admin-hours.service.spec`
Expected: PASS (all four cases).

- [ ] **Step 6: Create the controller + wire the module**

Create `apps/api/src/modules/admin/admin-hours.controller.ts` (mirror `admin-ordering.controller.ts`):

```ts
import { Body, Controller, HttpCode, HttpStatus, Put, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { StaffRole } from '../../database/entities';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AdminHoursService } from './admin-hours.service';
import { SetHoursDto } from './dto/set-hours.dto';
import { requireStaff } from './staff-context';

@ApiTags('admin-hours')
@ApiBearerAuth('jwt')
@Controller('admin')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class AdminHoursController {
  constructor(private readonly hours: AdminHoursService) {}

  @Put('hours')
  @HttpCode(HttpStatus.OK)
  @Roles(StaffRole.MANAGER, StaffRole.OWNER)
  @ApiOperation({
    summary: 'Replace the weekly hours for the staff member\'s location',
    description:
      'Whole-week replace (idempotent). The public location payload\'s open/closing-soon/closed status is recomputed from these on the next fetch.',
  })
  @ApiResponse({ status: 200, description: 'Hours replaced; returns the new weekly schedule.' })
  @ApiResponse({ status: 400, description: 'Invalid schedule (missing/dup day, open >= close, bad time).' })
  @ApiResponse({ status: 403, description: 'Requires MANAGER or OWNER at a location.' })
  setHours(@Req() req: Request, @Body() dto: SetHoursDto) {
    return this.hours.setHours(requireStaff(req), dto);
  }
}
```

In `apps/api/src/modules/admin/admin.module.ts`: add `LocationHours` to the `TypeOrmModule.forFeature([...])` array, add `AdminHoursController` to `controllers`, and `AdminHoursService` to `providers`. (Import both at the top.) `AdminHoursService` uses `@InjectDataSource()` — no extra `forFeature` entry is strictly required for the DataSource, but adding `LocationHours` keeps the entity registered for the module.

- [ ] **Step 7: Full build + test**

Run: `npm test -- admin-hours` then `npm test` (full) and `npm run build`.
Expected: PASS; build clean (controller wired, DI valid).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/admin/dto/set-hours.dto.ts apps/api/src/modules/admin/admin-hours.service.ts apps/api/src/modules/admin/admin-hours.service.spec.ts apps/api/src/modules/admin/admin-hours.controller.ts apps/api/src/modules/admin/admin.module.ts
git commit -m "feat(api): PUT /admin/hours — replace a location's weekly hours (OWNER/MANAGER)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Rename the seed location to Park Slope

**Files:**
- Modify: `apps/api/scripts/seed-dev-data.ts`

- [ ] **Step 1: Read the seed**

Read `apps/api/scripts/seed-dev-data.ts`. Note the `LOCATION` const (`name`, `address`, `timezone`) and that the upsert keys on `name` (`locationRepo.findOne({ where: { name: LOCATION.name } })`). The `HOURS` array (Mon–Fri 07:00–18:00, Sat 08:00–16:00, Sun closed) is fine — keep it.

- [ ] **Step 2: Rename + make the lookup rename-safe**

Change the `LOCATION` const:

```ts
const LOCATION = {
  name: 'Pulse Coffee — Park Slope',
  address: '200 5th Avenue, Brooklyn, NY 11215',
  timezone: 'America/New_York',
};
```

Then change the location lookup so renaming updates the **existing single location** instead of creating a duplicate (the current `where: { name }` would no longer match the old "Main St" row). Replace:

```ts
let location = await locationRepo.findOne({ where: { name: LOCATION.name } });
```

with:

```ts
// Single-location MVP: update the lone existing location (whatever its old
// name) so a rename is idempotent and never creates a duplicate. Multi-
// location seeding is revisited in the nearest-location sub-project.
let location = (await locationRepo.find({ order: { created_at: 'ASC' }, take: 1 }))[0] ?? null;
```

Keep the rest of the upsert (it already sets `location.name`/`address`/`timezone` on the found row, or creates one when none exists).

- [ ] **Step 3: Run the seed against the dev DB**

Per the "Local API runtime staleness" memory, the dev Postgres is on `pulse-postgres:5433`. From `apps/api`: `npm run seed:dev`
Expected: completes; the location row is renamed to "Pulse Coffee — Park Slope". Verify:
`curl -s http://localhost:3000/api/v1/locations | head -c 300` → name shows "Park Slope" (after the API is rebuilt/restarted per Task 2's deploy; if the running API is stale, the DB row is still renamed and a restart surfaces it).

- [ ] **Step 4: Commit**

```bash
git add apps/api/scripts/seed-dev-data.ts
git commit -m "chore(api): rename seed location to Pulse Coffee — Park Slope (rename-safe lookup)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# Phase B — iOS

> Rebuild + restart the dev API (per the staleness memory) so `/locations` serves the new `status`/`next_transition_at`/`today_open`/`today_close` fields before manual verification.

### Task 5: Decode store status on `LocationSummary`

**Files:**
- Modify: `apps/ios/PulseCoffeeApp/Models/Location.swift`
- Test: `apps/ios/PulseCoffeeAppTests/LocationSummaryStatusTests.swift`

- [ ] **Step 1: Write the failing test**

Create `apps/ios/PulseCoffeeAppTests/LocationSummaryStatusTests.swift`:

```swift
import XCTest
@testable import PulseCoffeeApp

final class LocationSummaryStatusTests: XCTestCase {
    private func decode(_ json: String) throws -> LocationSummary {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return try d.decode(LocationSummary.self, from: Data(json.utf8))
    }

    func test_decodesStatusAndTransitionAndTodayFields() throws {
        let loc = try decode("""
        { "id":"l1","name":"Pulse Coffee — Park Slope","address":"a","phone":null,
          "timezone":"America/New_York","current_wait_minutes":4,
          "status":"closing_soon","next_transition_at":"2026-06-15T22:00:00Z",
          "today_open":"07:00","today_close":"18:00" }
        """)
        XCTAssertEqual(loc.storeStatus, .closingSoon)
        XCTAssertEqual(loc.todayOpen, "07:00")
        XCTAssertEqual(loc.todayClose, "18:00")
        XCTAssertNotNil(loc.nextTransitionAt)
    }

    func test_nullStatus_decodesToNil_hiddenBadge() throws {
        let loc = try decode("""
        { "id":"l1","name":"P","address":"a","phone":null,"timezone":"America/New_York",
          "current_wait_minutes":5,"status":null,"next_transition_at":null,
          "today_open":null,"today_close":null }
        """)
        XCTAssertNil(loc.storeStatus)
        XCTAssertNil(loc.nextTransitionAt)
    }

    func test_unknownStatusString_decodesToNil_failSafe() throws {
        let loc = try decode("""
        { "id":"l1","name":"P","address":"a","phone":null,"timezone":"America/New_York",
          "current_wait_minutes":5,"status":"on_fire","next_transition_at":null,
          "today_open":null,"today_close":null }
        """)
        XCTAssertNil(loc.storeStatus)
    }

    func test_missingStatusFields_decodeWithoutThrowing() throws {
        // A backend that hasn't deployed yet omits the keys entirely.
        let loc = try decode("""
        { "id":"l1","name":"P","address":"a","phone":null,"timezone":"America/New_York",
          "current_wait_minutes":5 }
        """)
        XCTAssertNil(loc.storeStatus)
        XCTAssertNil(loc.todayOpen)
    }
}
```

- [ ] **Step 2: Regenerate + run, verify it fails**

Run (from `apps/ios`): `make project` then the concrete-sim test command. Expected: FAIL — `storeStatus`/`nextTransitionAt`/`todayOpen`/`todayClose` are undefined.

- [ ] **Step 3: Implement**

In `apps/ios/PulseCoffeeApp/Models/Location.swift`, add the four properties + decode to `LocationSummary` (it already has a custom `init(from:)` and a memberwise init for `currentWaitMinutes` — extend both):

```swift
struct LocationSummary: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let address: String
    let phone: String?
    let timezone: String
    let currentWaitMinutes: Int
    /// Server-computed badge state in the shop's timezone. nil → hide the badge.
    let storeStatus: StoreStatus?
    /// Instant the status next changes; drives the iOS live flip. nil → no timer.
    let nextTransitionAt: Date?
    /// Today's scheduled hours ("HH:mm"), nil on a closed day / no hours.
    let todayOpen: String?
    let todayClose: String?

    enum CodingKeys: String, CodingKey {
        case id, name, address, phone, timezone
        case currentWaitMinutes = "current_wait_minutes"
        case status
        case nextTransitionAt = "next_transition_at"
        case todayOpen = "today_open"
        case todayClose = "today_close"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.name = try c.decode(String.self, forKey: .name)
        self.address = try c.decode(String.self, forKey: .address)
        self.phone = try c.decodeIfPresent(String.self, forKey: .phone)
        self.timezone = try c.decode(String.self, forKey: .timezone)
        self.currentWaitMinutes = (try? c.decode(Int.self, forKey: .currentWaitMinutes)) ?? 5
        self.storeStatus = StoreStatus(wire: try? c.decodeIfPresent(String.self, forKey: .status) ?? nil)
        self.nextTransitionAt = (try? c.decodeIfPresent(Date.self, forKey: .nextTransitionAt)) ?? nil
        self.todayOpen = (try? c.decodeIfPresent(String.self, forKey: .todayOpen)) ?? nil
        self.todayClose = (try? c.decodeIfPresent(String.self, forKey: .todayClose)) ?? nil
    }

    init(id: String, name: String, address: String, phone: String?, timezone: String,
         currentWaitMinutes: Int = 5, storeStatus: StoreStatus? = nil,
         nextTransitionAt: Date? = nil, todayOpen: String? = nil, todayClose: String? = nil) {
        self.id = id; self.name = name; self.address = address
        self.phone = phone; self.timezone = timezone; self.currentWaitMinutes = currentWaitMinutes
        self.storeStatus = storeStatus; self.nextTransitionAt = nextTransitionAt
        self.todayOpen = todayOpen; self.todayClose = todayClose
    }
}
```

Add the wire mapping to `StoreStatus` (Task 6 keeps the enum in `StoreStatus.swift`; add this initializer there, or inline in `Location.swift` if you prefer — keep it next to the enum):

```swift
extension StoreStatus {
    /// Maps the backend wire string to the badge enum. Unknown / nil → nil
    /// (badge hidden, Golden Rule #17 — never assert "open" on bad data).
    init?(wire: String?) {
        switch wire {
        case "open": self = .open
        case "closing_soon": self = .closingSoon
        case "closed": self = .closed
        default: return nil
        }
    }
}
```

> `APIClient`'s decoder uses `.iso8601` for dates (confirmed in `APIClient.swift`), so `next_transition_at` decodes into `Date`. The test sets the same strategy.

- [ ] **Step 4: Run, verify it passes**

Run the concrete-sim test command. Expected: all `LocationSummaryStatusTests` PASS. Run the full suite too.

- [ ] **Step 5: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Models/Location.swift apps/ios/PulseCoffeeApp/Features/Menu/StoreStatus.swift apps/ios/PulseCoffeeAppTests/LocationSummaryStatusTests.swift
git commit -m "feat(ios): decode server store status + next transition on LocationSummary

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Consume server status + live flip; delete hard-coded hours

**Files:**
- Modify: `apps/ios/PulseCoffeeApp/Features/Menu/StoreStatus.swift`
- Create: `apps/ios/PulseCoffeeApp/Features/Menu/StoreStatusRefreshClock.swift`
- Test: `apps/ios/PulseCoffeeAppTests/StoreStatusRefreshClockTests.swift`
- Modify: `apps/ios/PulseCoffeeApp/Features/Menu/MenuView.swift`
- Modify: `apps/ios/PulseCoffeeApp/Features/Menu/MenuViewModel.swift`
- Modify: `apps/ios/PulseCoffeeApp/Services/LocationService.swift`

- [ ] **Step 1: Write the failing refresh-clock test**

Create `apps/ios/PulseCoffeeAppTests/StoreStatusRefreshClockTests.swift`:

```swift
import XCTest
@testable import PulseCoffeeApp

final class StoreStatusRefreshClockTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_000_000)

    func test_nilTransition_returnsNil() {
        XCTAssertNil(StoreStatusRefreshClock.secondsUntilNextTransition(nil, now: now))
    }

    func test_pastTransition_returnsZero_soRefreshFiresImmediately() {
        let past = now.addingTimeInterval(-30)
        XCTAssertEqual(StoreStatusRefreshClock.secondsUntilNextTransition(past, now: now), 0)
    }

    func test_futureTransition_returnsPositiveDelay() {
        let future = now.addingTimeInterval(120)
        XCTAssertEqual(StoreStatusRefreshClock.secondsUntilNextTransition(future, now: now), 120, accuracy: 0.001)
    }
}
```

- [ ] **Step 2: Regenerate + run, verify it fails**

Run `make project` then the concrete-sim test command. Expected: FAIL — `StoreStatusRefreshClock` undefined.

- [ ] **Step 3: Implement the refresh clock**

Create `apps/ios/PulseCoffeeApp/Features/Menu/StoreStatusRefreshClock.swift`:

```swift
import Foundation

/// Pure helper for the store-status live flip. The badge state is valid until
/// `nextTransitionAt`; at that instant the view refetches the location to get
/// the fresh status. This computes how long to wait. Extracted so the timing
/// logic is unit-tested without a running view.
enum StoreStatusRefreshClock {
    /// Seconds to wait before refreshing. nil when there's no transition to
    /// schedule. A past instant returns 0 (refresh now).
    static func secondsUntilNextTransition(_ nextTransitionAt: Date?, now: Date = Date()) -> TimeInterval? {
        guard let next = nextTransitionAt else { return nil }
        return max(0, next.timeIntervalSince(now))
    }
}
```

- [ ] **Step 4: Run, verify it passes**

Run the concrete-sim test command. Expected: `StoreStatusRefreshClockTests` PASS.

- [ ] **Step 5: Delete the hard-coded hours from `StoreStatus.swift`**

In `apps/ios/PulseCoffeeApp/Features/Menu/StoreStatus.swift`, **delete** `closingSoonWindow`, `HardcodedHours`, `hardcodedHours`, and the entire `currentStoreStatus(now:calendar:)` function. **Keep** the `enum StoreStatus { case open; case closingSoon; case closed }` and the `init?(wire:)` extension added in Task 5. The file becomes just the enum + wire mapping.

- [ ] **Step 6: Feed the dot from the location + schedule the live flip in `MenuView`**

In `apps/ios/PulseCoffeeApp/Features/Menu/MenuView.swift`, find the topbar usage `StoreStatusDot(status: currentStoreStatus())` (around line 74). The topbar already has the loaded `location` (it renders `location.name`). Replace the unconditional dot with a conditional one driven by the server status, and attach the live-flip task:

```swift
if let status = location.storeStatus {
    StoreStatusDot(status: status)
        .task(id: location.nextTransitionAt) {
            guard let delay = StoreStatusRefreshClock.secondsUntilNextTransition(location.nextTransitionAt)
            else { return }
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await menuVM.refreshLocation()
        }
}
```

> If the exact local name for the menu view-model in `MenuView` differs (e.g. `vm` vs `menuVM`), use the real one. `location` is the `LocationSummary` from `menuVM.state`'s `.loaded(location, menu)`. When `storeStatus` is nil the dot (and its pulsing animation) is simply not rendered — the topbar shows just the location name.

- [ ] **Step 7: Add `refreshLocation()` to the view-model + a location-only fetch**

In `apps/ios/PulseCoffeeApp/Services/LocationService.swift`, the existing `firstLocation()` already returns the current location summary — reuse it. In `apps/ios/PulseCoffeeApp/Features/Menu/MenuViewModel.swift`, add a light refresh that re-pulls only the location and updates `.loaded` in place (preserving the menu):

```swift
/// Re-fetch only the location (for the store-status live flip). Preserves the
/// already-loaded menu; on failure leaves the current state untouched
/// (the badge keeps its last value — Golden Rule #17 fail-safe).
func refreshLocation() async {
    guard case let .loaded(_, menu) = state else { return }
    do {
        let location = try await locations.firstLocation()
        state = .loaded(location, menu)
    } catch {
        // Non-critical: keep showing the last-known status.
    }
}
```

> Confirm the view-model's stored dependency is named `locations` (matching the existing `init(locations:menus:)`); use the real name.

- [ ] **Step 8: Regenerate, build, full suite**

Run `make project` then `make build`, then the full concrete-sim test command.
Expected: build clean; entire suite PASSES (incl. the new tests). Confirm `currentStoreStatus` has no remaining references: `grep -rn "currentStoreStatus" apps/ios/PulseCoffeeApp` → no results.

- [ ] **Step 9: Manual verification**

With the rebuilt backend serving the new fields, launch on the simulator: the Menu topbar dot color matches the server status (green open / amber closing-soon / red closed), and the location reads "Pulse Coffee — Park Slope". (Live flip at `next_transition_at` is hard to observe in a short manual run; the timing logic is unit-tested.)

- [ ] **Step 10: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Menu/StoreStatus.swift apps/ios/PulseCoffeeApp/Features/Menu/StoreStatusRefreshClock.swift apps/ios/PulseCoffeeAppTests/StoreStatusRefreshClockTests.swift apps/ios/PulseCoffeeApp/Features/Menu/MenuView.swift apps/ios/PulseCoffeeApp/Features/Menu/MenuViewModel.swift apps/ios/PulseCoffeeApp/Services/LocationService.swift
git commit -m "feat(ios): drive store badge from server status + live flip; delete hard-coded hours

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** §4 computeStoreStatus → Task 1; §5 payload fields + no-N+1 → Task 2; §6 `PUT /admin/hours` (whole-week, OWNER/MANAGER, scoped, validation) → Task 3; §5/§1 Park Slope rename → Task 4; §7 iOS decode → Task 5; §7 delete hard-coded hours + live flip + feed dot → Task 6; §8 error handling (null→hidden, 400/403, fail-safe decode) → Tasks 1/3/5/6; §9 testing → each task's tests. All spec sections map to a task.
- **Type consistency:** `StoreStatusResult { status, next_transition_at, today_open, today_close }` is identical across Task 1 (definition), Task 2 (consumption), and the iOS wire keys in Task 5. `StoreStatusValue` union matches the iOS `StoreStatus` enum via `init?(wire:)`. `computeStoreStatus(hours, timezone, now)` signature is stable across Tasks 1–2. `secondsUntilNextTransition(_:now:)` matches between Task 6 test and impl.
- **Placeholder scan:** none — every code step is complete; every run step has a command + expected result.
- **Soft spots flagged inline:** `LocationsService` constructor arg order / method name (Task 2), the menu view-model's local name in `MenuView` and its dependency name (Task 6) — each tells the implementer to use the real symbol.
