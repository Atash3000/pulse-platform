# Staff-Facing Celebration State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only, privacy-safe staff endpoint `GET /api/v1/admin/customers/:customerId/celebration-state` that returns a derived birthday state (`BIRTHDAY_TODAY` | `BIRTHDAY_THIS_WEEK` | `NONE`) and any live rewards, without ever exposing the customer's date of birth.

**Architecture:** A new, self-contained `CelebrationModule` in `apps/api`. A pure, DB-free date helper computes the state from `Customer.date_of_birth` in the staff's store timezone; the service orchestrates flag-check → customer load → state compute → reward mapping; the controller reuses the established `admin` staff-auth surface. The customer entity is never serialized into the response — the DTO is a plain class with exactly three explicitly-constructed fields, and a recursive build-failing test pins the absence of any PII key.

**Tech Stack:** NestJS 10, TypeORM, `date-fns` / `date-fns-tz` (already in use — see `apps/api/src/modules/locations/hours-tz.ts`), Jest + ts-jest.

---

## Key facts the implementer must know (verified against the repo)

- **All commands run from `apps/api/`.** Run a single spec with `npx jest <path-to-spec>`. Full suite: `npm test`. Build: `npm run build`. Lint (auto-fix): `npm run lint`.
- **Jest** uses `ts-jest`, `testRegex: ".*\\.spec\\.ts$"`, `testEnvironment: node`. Specs live next to source.
- **The birthday column is `Customer.date_of_birth`** — a Postgres `date` mapped by TypeORM to a `'YYYY-MM-DD'` **string** (or `null`). It is NOT named `birthday`. Defined in `apps/api/src/database/entities.ts` (~line 218).
- **`Location.timezone`** is `text`, default `'America/New_York'` (`entities.ts` ~line 124). The store timezone for the date math comes from the **staff JWT's `location_id`** (customers are not location-scoped, so the staff's location is the only and correct anchor).
- **`Offer` entity** (`entities.ts` ~line 942) fields: `id`, `customer_id`, `type`, `value_cents`, `description (string|null)`, `sent_at (Date|null)`, `opened_at`, `redeemed_at (Date|null)`, `expires_at (Date|null)`, `revenue_attributed_cents`. **No code writes to this table today** — so `active_rewards` will be empty in practice. We ship the mapping logic anyway.
- **`FeatureFlag` entity** (`entities.ts` ~line 1087): primary key `key` (text), `enabled` (boolean, default false), `rollout_pct` (int), `description`.
- **Staff auth** = `AuthGuard('jwt')` + `RolesGuard` (`modules/auth/roles.guard.ts`) + `@Roles(...)` (`modules/auth/roles.decorator.ts`). `requireStaff(req)` (`modules/admin/staff-context.ts`) returns `{ staff_user_id, location_id, role }` and throws `ForbiddenException` (→ HTTP 403) when `req.user.type !== 'staff'`. `StaffRole` enum = `OWNER | MANAGER | BARISTA`.
- **`resolveTimezone(raw)`** in `modules/locations/hours-tz.ts` safely resolves a tz string (defaults bad/empty values to `America/New_York`). Reuse it.
- **No global `ClassSerializerInterceptor`** is registered (`main.ts` only wires `ValidationPipe`). Therefore `@Exclude`/`@Expose` would have NO effect on the wire and would be dead code (violates CLAUDE.md §2.1). **Do not add them.** The privacy guarantee is structural: the DTO class holds only its three constructor-assigned fields, so `JSON.stringify` emits only those.
- **Controller unit-test pattern** (`modules/admin/admin-orders.controller.spec.ts`): build the controller via `Test.createTestingModule({ controllers, providers: [{ provide: Service, useValue: mock }] })`, then call controller methods directly passing a `Partial<Request>` whose `.user` carries the JWT subject. Guards/pipes are NOT exercised in these direct unit tests — the in-controller `requireStaff(req)` call is what enforces (and is tested for) the staff boundary.

---

## File structure

```
apps/api/src/modules/celebration/
  celebration-date.ts            # CREATE — pure state math + label (no DB, no Nest)
  celebration-date.spec.ts       # CREATE — the bulk of the unit tests
  dto/
    celebration-state.dto.ts     # CREATE — ActiveRewardDto + CelebrationStateDto (plain classes)
  celebration.service.ts         # CREATE — flag check, customer/location load, reward mapping
  celebration.service.spec.ts    # CREATE — service behavior + the privacy key-absence assertion
  celebration.controller.ts      # CREATE — route, guards, throttle, swagger, requireStaff
  celebration.controller.spec.ts # CREATE — 403 boundary + passthrough
  celebration.module.ts          # CREATE — wires repos + AuthModule

apps/api/src/app.module.ts                                 # MODIFY — register CelebrationModule
apps/api/src/database/seeds/feature-flags.seed.ts          # MODIFY — add birthday_celebration_state flag
docs/golden-rules.md                                       # MODIFY — add Golden Rule #16
docs/decision-log.md                                       # MODIFY — add decision entry
```

---

## Task 0: Branch setup

**Files:** none (git only)

- [ ] **Step 1: Create the feature branch from latest main**

The harness drops you on a `claude/<random>` branch. Confirm it's forked from `main`, then rename per CLAUDE.md §7–8:

```bash
git merge-base --is-ancestor main HEAD && echo "OK forked from main"
git branch -m "$(git branch --show-current)" feat/api/staff-celebration-state
git branch --show-current
```
Expected: prints `feat/api/staff-celebration-state`.

---

## Task 1: Pure date helper + label

**Files:**
- Create: `apps/api/src/modules/celebration/celebration-date.ts`
- Test: `apps/api/src/modules/celebration/celebration-date.spec.ts`

> **Note on `SHOW_DAYS_UNTIL_BIRTHDAY` (spec §5.2):** we deliberately do NOT add a config constant for this. With the default (`false`), the `THIS_WEEK` label is already vague — a `SHOW_DAYS_UNTIL_BIRTHDAY = false` constant that nothing reads would be dead code (CLAUDE.md §2.1), and the spec's own §11 lists the "in N days" variant as out-of-scope. The seam is documented in the `LABELS` comment; the constant lands with the feature that actually needs it.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/celebration/celebration-date.spec.ts`:

```ts
import { computeCelebrationState, labelForState } from './celebration-date';

const NY = 'America/New_York';

// Helper: build a UTC instant for a given NY wall-clock date at noon, so the
// store-local calendar day is unambiguous regardless of DST. Noon EST/EDT is
// the same calendar day in UTC, so `new Date('YYYY-MM-DDT12:00:00-04:00'-ish)`
// is safe; we use an explicit offset-free midday UTC which lands same-day in NY.
function nyNoon(dateIso: string): Date {
  // 16:00Z ~= 12:00 in America/New_York for both EST(-5) and EDT(-4) → 11:00/12:00,
  // always the same calendar day in NY. Good enough for day-resolution tests.
  return new Date(`${dateIso}T16:00:00Z`);
}

describe('computeCelebrationState', () => {
  it('returns NONE when dateOfBirth is null', () => {
    expect(computeCelebrationState(null, nyNoon('2026-05-26'), NY)).toBe('NONE');
  });

  it('returns BIRTHDAY_TODAY when month/day match today in store tz', () => {
    // dob year (1990) is irrelevant — only month/day matter.
    expect(computeCelebrationState('1990-05-26', nyNoon('2026-05-26'), NY)).toBe('BIRTHDAY_TODAY');
  });

  it('returns BIRTHDAY_THIS_WEEK when birthday is in 3 days', () => {
    expect(computeCelebrationState('1990-05-26', nyNoon('2026-05-23'), NY)).toBe('BIRTHDAY_THIS_WEEK');
  });

  it('returns NONE when birthday is 8 days out (outside the 7-day window)', () => {
    expect(computeCelebrationState('1990-05-26', nyNoon('2026-05-18'), NY)).toBe('NONE');
  });

  it('Feb 29 birthday resolves to BIRTHDAY_TODAY on Feb 28 in a non-leap year', () => {
    // 2027 is not a leap year.
    expect(computeCelebrationState('2000-02-29', nyNoon('2027-02-28'), NY)).toBe('BIRTHDAY_TODAY');
  });

  it('Feb 29 birthday is BIRTHDAY_TODAY on Feb 29 in a leap year', () => {
    // 2028 is a leap year.
    expect(computeCelebrationState('2000-02-29', nyNoon('2028-02-29'), NY)).toBe('BIRTHDAY_TODAY');
  });

  it('wraps across the year boundary: today Dec 30, birthday Jan 2 → THIS_WEEK', () => {
    expect(computeCelebrationState('1990-01-02', nyNoon('2026-12-30'), NY)).toBe('BIRTHDAY_THIS_WEEK');
  });

  it('resolves against the STORE day, not UTC, near midnight', () => {
    // 2026-05-27T02:00:00Z is still 2026-05-26 (22:00) in America/New_York.
    // Birthday May 26 must read as TODAY (store day), not May 27 (UTC day).
    const lateUtc = new Date('2026-05-27T02:00:00Z');
    expect(computeCelebrationState('1990-05-26', lateUtc, NY)).toBe('BIRTHDAY_TODAY');
  });
});

describe('labelForState', () => {
  it('TODAY → warm explicit label', () => {
    expect(labelForState('BIRTHDAY_TODAY')).toBe('Birthday today 🎂');
  });

  it('THIS_WEEK → vague label with no date and no day count', () => {
    const label = labelForState('BIRTHDAY_THIS_WEEK');
    expect(label).toBe('Birthday coming up');
    expect(label).not.toMatch(/\d/); // no digits → no day count, no date
  });

  it('NONE → empty string (client renders nothing)', () => {
    expect(labelForState('NONE')).toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api && npx jest src/modules/celebration/celebration-date.spec.ts
```
Expected: FAIL — `Cannot find module './celebration-date'`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/modules/celebration/celebration-date.ts`:

```ts
/**
 * Pure, DB-free birthday-state math for the staff celebration endpoint.
 *
 * Privacy note: this module computes a *derived state* and a display *label*
 * from a date of birth. The date itself never leaves the server (see
 * CelebrationStateDto). Only month/day are ever compared — the birth YEAR is
 * read for nothing and surfaced nowhere.
 *
 * Timezone: "today" is resolved in the store's IANA timezone via date-fns-tz,
 * mirroring the established pattern in modules/locations/hours-tz.ts. Calendar
 * arithmetic uses native Date field overflow (e.g. day 33 → next month), which
 * is DST-safe because we only read Y/M/D back, never a time-of-day.
 */
import { toZonedTime } from 'date-fns-tz';

export type CelebrationState = 'BIRTHDAY_TODAY' | 'BIRTHDAY_THIS_WEEK' | 'NONE';

const LABELS: Record<CelebrationState, string> = {
  // Vague by design: THIS_WEEK carries no date and no day count — warmer and
  // less surveillance-y. A future SHOW_DAYS_UNTIL_BIRTHDAY variant is a seam,
  // not shipped (see plan §out-of-scope).
  BIRTHDAY_TODAY: 'Birthday today 🎂',
  BIRTHDAY_THIS_WEEK: 'Birthday coming up',
  NONE: '',
};

/** Server-built, pre-localized display string. Safe to render verbatim. */
export function labelForState(state: CelebrationState): string {
  return LABELS[state];
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * The birthday's effective month/day in a given calendar year, collapsing
 * Feb 29 → Feb 28 in non-leap years (consistent with the product spec).
 */
function resolveBirthdayMonthDay(
  birthMonth: number,
  birthDay: number,
  year: number,
): { month: number; day: number } {
  if (birthMonth === 2 && birthDay === 29 && !isLeapYear(year)) {
    return { month: 2, day: 28 };
  }
  return { month: birthMonth, day: birthDay };
}

/**
 * Maps a customer to a celebration state relative to `now` in `timezone`.
 *
 * @param dateOfBirth 'YYYY-MM-DD' (Postgres `date`) or null
 * @param now         the current instant (injected for deterministic tests)
 * @param timezone    IANA store timezone, e.g. 'America/New_York'
 * @param thisWeekDays size of the BIRTHDAY_THIS_WEEK look-ahead window (default 7)
 */
export function computeCelebrationState(
  dateOfBirth: string | null,
  now: Date,
  timezone: string,
  thisWeekDays = 7,
): CelebrationState {
  if (!dateOfBirth) return 'NONE';

  const [, monthStr, dayStr] = dateOfBirth.split('-');
  const birthMonth = Number(monthStr);
  const birthDay = Number(dayStr);
  if (!birthMonth || !birthDay) return 'NONE';

  // "Today" as wall-clock fields in the store timezone.
  const zonedNow = toZonedTime(now, timezone);
  const year = zonedNow.getFullYear();
  const month = zonedNow.getMonth(); // 0-based
  const day = zonedNow.getDate();

  // Walk today (+0) through +thisWeekDays; the first calendar day whose
  // month/day equals the birthday (resolved for THAT day's year) wins. This
  // naturally handles year/month wrap and Feb-29 collapse per candidate year.
  for (let offset = 0; offset <= thisWeekDays; offset++) {
    const candidate = new Date(year, month, day + offset);
    const eff = resolveBirthdayMonthDay(birthMonth, birthDay, candidate.getFullYear());
    if (candidate.getMonth() + 1 === eff.month && candidate.getDate() === eff.day) {
      return offset === 0 ? 'BIRTHDAY_TODAY' : 'BIRTHDAY_THIS_WEEK';
    }
  }
  return 'NONE';
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/api && npx jest src/modules/celebration/celebration-date.spec.ts
```
Expected: PASS — all 11 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/celebration/celebration-date.ts apps/api/src/modules/celebration/celebration-date.spec.ts
git commit -m "feat(api): pure birthday celebration-state date helper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Privacy DTOs

**Files:**
- Create: `apps/api/src/modules/celebration/dto/celebration-state.dto.ts`

No standalone test — the DTO has no logic. Its privacy guarantee is verified by the service spec in Task 3 (Step 1's recursive key-absence assertion).

- [ ] **Step 1: Write the DTOs**

Create `apps/api/src/modules/celebration/dto/celebration-state.dto.ts`:

```ts
import { CelebrationState } from '../celebration-date';

/**
 * A reward live for redemption RIGHT NOW, mapped from the generic `offers`
 * table. Deliberately NOT birthday-specific — anniversary/referral reward
 * types flow through unchanged. Staff-safe: carries no customer PII.
 */
export class ActiveRewardDto {
  constructor(
    readonly reward_id: string,
    readonly type: string,
    readonly title: string,
    readonly requires_purchase: boolean,
    readonly expires_at: string | null,
  ) {}
}

/**
 * The ENTIRE staff-facing payload. Contains a derived state, a pre-localized
 * label, and any live rewards — and NOTHING else.
 *
 * Privacy contract (the reason this class exists): the customer's date of
 * birth / age / birth year are STRUCTURALLY ABSENT. This is a plain class with
 * exactly three constructor-assigned fields; JSON serialization emits only
 * those three keys. The Customer entity is never spread into it. The build-
 * failing key-absence test in celebration.service.spec.ts pins this invariant.
 *
 * Note: we intentionally do NOT use class-transformer @Exclude/@Expose — no
 * global ClassSerializerInterceptor is registered, so those decorators would
 * be inert dead code. The structural guarantee above is the real defense.
 */
export class CelebrationStateDto {
  constructor(
    readonly state: CelebrationState,
    readonly label: string,
    readonly active_rewards: ActiveRewardDto[],
  ) {}
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
```
Expected: no errors (or only pre-existing unrelated ones — this file adds none).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/celebration/dto/celebration-state.dto.ts
git commit -m "feat(api): staff-safe celebration-state DTOs

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Celebration service (flag, load, reward mapping, privacy assertion)

**Files:**
- Create: `apps/api/src/modules/celebration/celebration.service.ts`
- Test: `apps/api/src/modules/celebration/celebration.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/celebration/celebration.service.spec.ts`:

```ts
import { Customer, Location, Offer } from '../../database/entities';
import { CelebrationService, CELEBRATION_FLAG_KEY } from './celebration.service';

// Forbidden keys that must NEVER appear in the staff payload, at any depth.
// Includes snake_case + camelCase variants as defense against a future field
// being spread in under a different naming convention.
const FORBIDDEN_KEYS = [
  'birthday', 'date_of_birth', 'dateOfBirth', 'birth_date', 'birthDate',
  'age', 'year', 'birth_year', 'birthYear', 'dob',
];

function assertNoForbiddenKeys(value: unknown): void {
  const json = JSON.parse(JSON.stringify(value));
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        expect(FORBIDDEN_KEYS).not.toContain(k);
        walk(v);
      }
    }
  };
  walk(json);
}

// Minimal repo doubles. Each test sets the return values it needs.
function makeService(opts: {
  flagEnabled?: boolean;
  customer?: Partial<Customer> | null;
  location?: Partial<Location> | null;
  offers?: Partial<Offer>[];
}) {
  const flags = { findOne: jest.fn().mockResolvedValue(
    opts.flagEnabled === undefined ? { key: CELEBRATION_FLAG_KEY, enabled: true } :
    { key: CELEBRATION_FLAG_KEY, enabled: opts.flagEnabled },
  ) };
  const customers = { findOne: jest.fn().mockResolvedValue(opts.customer ?? null) };
  const locations = { findOne: jest.fn().mockResolvedValue(opts.location ?? { timezone: 'America/New_York' }) };
  const offersRepo = { find: jest.fn().mockResolvedValue(opts.offers ?? []) };

  const service = new CelebrationService(
    customers as never,
    locations as never,
    offersRepo as never,
    flags as never,
  );
  return { service, flags, customers, locations, offersRepo };
}

const TODAY = new Date('2026-05-26T16:00:00Z'); // May 26 in America/New_York

describe('CelebrationService.getCelebrationState', () => {
  it('returns NONE/empty when the feature flag is OFF, regardless of birthday', async () => {
    const { service, customers } = makeService({
      flagEnabled: false,
      customer: { id: 'c1', date_of_birth: '1990-05-26' },
    });
    const result = await service.getCelebrationState('c1', 'loc1', TODAY);
    expect(result).toEqual({ state: 'NONE', label: '', active_rewards: [] });
    // Short-circuits before touching the customer row.
    expect(customers.findOne).not.toHaveBeenCalled();
  });

  it('birthday today, no live offers → BIRTHDAY_TODAY + empty rewards', async () => {
    const { service } = makeService({
      customer: { id: 'c1', date_of_birth: '1990-05-26' },
      offers: [],
    });
    const result = await service.getCelebrationState('c1', 'loc1', TODAY);
    expect(result.state).toBe('BIRTHDAY_TODAY');
    expect(result.label).toBe('Birthday today 🎂');
    expect(result.active_rewards).toEqual([]);
  });

  it('maps a live birthday_drink offer into active_rewards', async () => {
    const expires = new Date('2026-05-30T23:59:59Z');
    const { service } = makeService({
      customer: { id: 'c1', date_of_birth: '1990-05-26' },
      offers: [
        { id: 'o1', type: 'birthday_drink', description: 'Birthday drink — on us',
          sent_at: new Date('2026-05-26T08:00:00Z'), redeemed_at: null, expires_at: expires },
      ],
    });
    const result = await service.getCelebrationState('c1', 'loc1', TODAY);
    expect(result.active_rewards).toEqual([
      {
        reward_id: 'o1',
        type: 'birthday_drink',
        title: 'Birthday drink — on us',
        requires_purchase: true,
        expires_at: expires.toISOString(),
      },
    ]);
  });

  it('excludes redeemed, expired, and unsent offers from active_rewards', async () => {
    const { service } = makeService({
      customer: { id: 'c1', date_of_birth: '1990-05-26' },
      offers: [
        { id: 'redeemed', type: 'birthday_drink', description: null,
          sent_at: new Date('2026-05-01T00:00:00Z'), redeemed_at: new Date('2026-05-02T00:00:00Z'), expires_at: null },
        { id: 'expired', type: 'birthday_drink', description: null,
          sent_at: new Date('2026-05-01T00:00:00Z'), redeemed_at: null, expires_at: new Date('2026-05-10T00:00:00Z') },
        { id: 'unsent', type: 'birthday_drink', description: null,
          sent_at: null, redeemed_at: null, expires_at: null },
      ],
    });
    const result = await service.getCelebrationState('c1', 'loc1', TODAY);
    expect(result.active_rewards).toEqual([]);
  });

  it('unknown customer → NONE/empty, no throw (anti-enumeration)', async () => {
    const { service } = makeService({ customer: null });
    const result = await service.getCelebrationState('does-not-exist', 'loc1', TODAY);
    expect(result).toEqual({ state: 'NONE', label: '', active_rewards: [] });
  });

  it('degrades to NONE (never throws) when a DB lookup fails (Golden Rule #17)', async () => {
    const { service, customers } = makeService({ customer: { id: 'c1', date_of_birth: '1990-05-26' } });
    customers.findOne.mockRejectedValueOnce(new Error('db down'));
    const result = await service.getCelebrationState('c1', 'loc1', TODAY);
    expect(result).toEqual({ state: 'NONE', label: '', active_rewards: [] });
  });

  it('PRIVACY: payload contains no DOB/age/year key under any state', async () => {
    // TODAY state, with a real DOB on the loaded customer.
    const today = await makeService({ customer: { id: 'c1', date_of_birth: '1990-05-26' } })
      .service.getCelebrationState('c1', 'loc1', TODAY);
    // THIS_WEEK state.
    const thisWeek = await makeService({ customer: { id: 'c2', date_of_birth: '1990-05-29' } })
      .service.getCelebrationState('c2', 'loc1', TODAY);
    // NONE state (no birthday).
    const none = await makeService({ customer: { id: 'c3', date_of_birth: null } })
      .service.getCelebrationState('c3', 'loc1', TODAY);

    expect(today.state).toBe('BIRTHDAY_TODAY');
    expect(thisWeek.state).toBe('BIRTHDAY_THIS_WEEK');
    expect(none.state).toBe('NONE');
    assertNoForbiddenKeys(today);
    assertNoForbiddenKeys(thisWeek);
    assertNoForbiddenKeys(none);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api && npx jest src/modules/celebration/celebration.service.spec.ts
```
Expected: FAIL — `Cannot find module './celebration.service'`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/modules/celebration/celebration.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Customer, FeatureFlag, Location, Offer } from '../../database/entities';
import { resolveTimezone } from '../locations/hours-tz';
import { computeCelebrationState, labelForState } from './celebration-date';
import { ActiveRewardDto, CelebrationStateDto } from './dto/celebration-state.dto';

/** Feature flag gating the entire endpoint (Golden Rule #12). */
export const CELEBRATION_FLAG_KEY = 'birthday_celebration_state';

/** The safe default returned when the flag is off / customer is unknown. */
const NONE_STATE = (): CelebrationStateDto => new CelebrationStateDto('NONE', '', []);

/**
 * Reward types attached to a purchase (never standalone giveaways). Default is
 * `true` — a reward applies to an order, per the product rule.
 */
function requiresPurchaseForType(_type: string): boolean {
  return true;
}

/** Display title when an offer has no description of its own. */
function defaultTitleForType(type: string): string {
  if (type === 'birthday_drink') return 'Birthday drink — on us';
  return 'Reward';
}

/**
 * Computes the staff-facing celebration state for a customer. Read-only:
 * issues nothing, claims nothing, mutates nothing. The customer's date of
 * birth is read here and turned into a derived state — it never appears in the
 * returned DTO (see CelebrationStateDto).
 */
@Injectable()
export class CelebrationService {
  private readonly logger = new Logger(CelebrationService.name);

  constructor(
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
    @InjectRepository(Location) private readonly locations: Repository<Location>,
    @InjectRepository(Offer) private readonly offers: Repository<Offer>,
    @InjectRepository(FeatureFlag) private readonly flags: Repository<FeatureFlag>,
  ) {}

  /**
   * @param customerId   the customer the order is attached to
   * @param staffLocationId the staff member's location (from the JWT) — supplies
   *                        the store timezone for the date math
   * @param now           injected for deterministic tests; defaults to real time
   */
  async getCelebrationState(
    customerId: string,
    staffLocationId: string,
    now: Date = new Date(),
  ): Promise<CelebrationStateDto> {
    try {
      const flag = await this.flags.findOne({ where: { key: CELEBRATION_FLAG_KEY } });
      if (!flag?.enabled) return NONE_STATE();

      const customer = await this.customers.findOne({ where: { id: customerId } });
      // Unknown customer → NONE, never 404: prevents customer-UUID enumeration.
      if (!customer) return NONE_STATE();

      const location = await this.locations.findOne({ where: { id: staffLocationId } });
      const { tz } = resolveTimezone(location?.timezone);

      const state = computeCelebrationState(customer.date_of_birth, now, tz);
      const label = labelForState(state);
      const active_rewards = await this.mapActiveRewards(customerId, now);

      return new CelebrationStateDto(state, label, active_rewards);
    } catch (err) {
      // Golden Rule #17 — a non-critical surface fails safe. This endpoint is
      // off the order/checkout path; a warm gesture is never worth a 500 to the
      // staff client. Degrade silently to NONE and log (Sentry, GR#10).
      this.logger.error(
        `[celebration] degraded to NONE for customer=${customerId}: ${String(err)}`,
      );
      return NONE_STATE();
    }
  }

  /**
   * Live rewards from the generic `offers` table: unredeemed, already sent, and
   * not past expiry. Independent of birthday state — a BIRTHDAY_TODAY customer
   * whose reward is already claimed correctly returns an empty array.
   *
   * Reality: nothing writes `offers` yet, so this is empty in practice. The
   * mapping + shape ship now; issuance is deferred.
   *
   * All liveness filtering is done in code (not a SQL `where`) so the single
   * predicate is unit-testable and lives in one place; per-customer offer rows
   * are few, so fetching by customer_id and filtering in memory is fine.
   */
  private async mapActiveRewards(customerId: string, now: Date): Promise<ActiveRewardDto[]> {
    const candidates = await this.offers.find({ where: { customer_id: customerId } });
    return candidates
      .filter(
        (o) => o.redeemed_at == null && o.sent_at != null && (o.expires_at == null || o.expires_at > now),
      )
      .map(
        (o) =>
          new ActiveRewardDto(
            o.id,
            o.type,
            o.description ?? defaultTitleForType(o.type),
            requiresPurchaseForType(o.type),
            o.expires_at ? o.expires_at.toISOString() : null,
          ),
      );
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/api && npx jest src/modules/celebration/celebration.service.spec.ts
```
Expected: PASS — all 7 tests green, including the PRIVACY assertion and the degrade-to-NONE resilience test.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/celebration/celebration.service.ts apps/api/src/modules/celebration/celebration.service.spec.ts
git commit -m "feat(api): celebration service with flag gate, reward mapping, privacy test

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Controller (staff boundary + passthrough)

**Files:**
- Create: `apps/api/src/modules/celebration/celebration.controller.ts`
- Test: `apps/api/src/modules/celebration/celebration.controller.spec.ts`

> **Note on `ParseUUIDPipe` (400 on malformed id) and `@Throttle` (30/min):** these are declarative, framework-enforced decorators. The repo's existing controller unit tests (e.g. `admin-orders.controller.spec.ts`) do NOT exercise pipes/guards in direct method-call tests, and neither do we — they fire only through the full HTTP pipeline. They are verified by reading the decorators on the route, consistent with repo convention. The spec's "malformed → 400" and "throttle smoke" items are covered by these decorators, not by a unit test.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/celebration/celebration.controller.spec.ts`:

```ts
import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';

import { StaffRole } from '../../database/entities';
import { CelebrationController } from './celebration.controller';
import { CelebrationService } from './celebration.service';
import { CelebrationStateDto } from './dto/celebration-state.dto';

const STAFF_REQ: Partial<Request> = {
  user: {
    type: 'staff',
    sub: 'staff-1',
    role: StaffRole.BARISTA,
    location_id: 'loc-1',
  } as unknown as Express.User,
};

const CUSTOMER_REQ: Partial<Request> = {
  user: { type: 'customer', sub: 'cust-9' } as unknown as Express.User,
};

describe('CelebrationController.getCelebrationState', () => {
  let controller: CelebrationController;
  let getState: jest.Mock;

  beforeEach(async () => {
    getState = jest.fn();
    const moduleRef = await Test.createTestingModule({
      controllers: [CelebrationController],
      providers: [{ provide: CelebrationService, useValue: { getCelebrationState: getState } }],
    }).compile();
    controller = moduleRef.get(CelebrationController);
  });

  it('passes the customerId and the staff location to the service and returns its DTO', async () => {
    const dto = new CelebrationStateDto('BIRTHDAY_TODAY', 'Birthday today 🎂', []);
    getState.mockResolvedValue(dto);

    const result = await controller.getCelebrationState('cust-1', STAFF_REQ as Request);

    expect(getState).toHaveBeenCalledWith('cust-1', 'loc-1');
    expect(result).toBe(dto);
  });

  it('throws ForbiddenException (403) for a non-staff (customer) token', async () => {
    await expect(
      controller.getCelebrationState('cust-1', CUSTOMER_REQ as Request),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(getState).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api && npx jest src/modules/celebration/celebration.controller.spec.ts
```
Expected: FAIL — `Cannot find module './celebration.controller'`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/modules/celebration/celebration.controller.ts`:

```ts
import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { StaffRole } from '../../database/entities';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { requireStaff } from '../admin/staff-context';
import { CelebrationService } from './celebration.service';
import { CelebrationStateDto } from './dto/celebration-state.dto';

/**
 * Staff-facing celebration state. Reuses the established `admin` auth surface
 * (global prefix api/v1 → /api/v1/admin/...). Read-only and privacy-safe: it
 * returns a derived state, never the customer's date of birth (Golden Rule #16).
 */
@ApiTags('admin-celebration')
@ApiBearerAuth('jwt')
@Controller('admin')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class CelebrationController {
  constructor(private readonly celebration: CelebrationService) {}

  @Get('customers/:customerId/celebration-state')
  @HttpCode(HttpStatus.OK)
  @Roles(StaffRole.BARISTA, StaffRole.MANAGER, StaffRole.OWNER)
  @ApiOperation({
    summary: 'Birthday/celebration state for a customer (derived; never exposes DOB)',
  })
  @ApiParam({ name: 'customerId', format: 'uuid' })
  @ApiResponse({ status: 200, type: CelebrationStateDto })
  async getCelebrationState(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Req() req: Request,
  ): Promise<CelebrationStateDto> {
    // The store timezone comes from the staff member's own location. This also
    // re-asserts the staff boundary at the code level (throws 403 for non-staff).
    const staff = requireStaff(req);
    return this.celebration.getCelebrationState(customerId, staff.location_id);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd apps/api && npx jest src/modules/celebration/celebration.controller.spec.ts
```
Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/celebration/celebration.controller.ts apps/api/src/modules/celebration/celebration.controller.spec.ts
git commit -m "feat(api): celebration-state staff controller

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Module wiring + feature-flag seed + full build/test

**Files:**
- Create: `apps/api/src/modules/celebration/celebration.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/database/seeds/feature-flags.seed.ts`

- [ ] **Step 1: Write the module**

Create `apps/api/src/modules/celebration/celebration.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Customer, FeatureFlag, Location, Offer } from '../../database/entities';
import { AuthModule } from '../auth/auth.module';
import { CelebrationController } from './celebration.controller';
import { CelebrationService } from './celebration.service';

/**
 * Staff-facing birthday/celebration state. A deliberately small, single-purpose
 * module: it is the ONLY staff-side reader of Customer.date_of_birth, which
 * keeps the privacy audit boundary tight (cf. AdminModule's breadth).
 *
 * AuthGuard('jwt') is provided via AuthModule; RolesGuard is used directly on
 * the controller. Repos are registered locally (TypeORM tolerates the same
 * entity in multiple forFeature calls across modules).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Customer, Location, Offer, FeatureFlag]),
    AuthModule,
  ],
  controllers: [CelebrationController],
  providers: [CelebrationService],
})
export class CelebrationModule {}
```

- [ ] **Step 2: Register the module in AppModule**

In `apps/api/src/app.module.ts`, add the import near the other module imports (alphabetical-ish, after `AdminModule`):

```ts
import { AdminModule } from './modules/admin/admin.module';
import { CelebrationModule } from './modules/celebration/celebration.module';
```

And add `CelebrationModule` to the `imports:` array, right after `AdminModule,`:

```ts
    OrdersModule,
    AdminModule,
    CelebrationModule,
    WorkersModule,
```

- [ ] **Step 3: Add the feature flag to the seed**

In `apps/api/src/database/seeds/feature-flags.seed.ts`, add this entry to the `FLAGS` array (after the last entry, before the closing `]`):

```ts
  { key: 'birthday_celebration_state', enabled: false, description: 'Staff-facing birthday/celebration state endpoint' },
```

- [ ] **Step 4: Build the whole API to verify wiring**

```bash
cd apps/api && npm run build
```
Expected: `nest build` completes with no TypeScript errors.

- [ ] **Step 5: Run the full celebration suite + lint**

```bash
cd apps/api && npx jest src/modules/celebration && npm run lint
```
Expected: all celebration specs PASS; lint reports no errors on the new files.

- [ ] **Step 6: Run the FULL test suite (no regressions)**

```bash
cd apps/api && npm test
```
Expected: the entire suite passes (celebration specs included). If any pre-existing unrelated test was already failing on `main`, note it but do not fix it here (scope discipline, CLAUDE.md §1.6).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/celebration/celebration.module.ts apps/api/src/app.module.ts apps/api/src/database/seeds/feature-flags.seed.ts
git commit -m "feat(api): wire CelebrationModule + birthday_celebration_state flag

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Docs — Golden Rules #16/#17 + decision-log entry

**Files:**
- Modify: `docs/golden-rules.md` — **already applied during planning**
- Modify: `CLAUDE.md` (§3) — **already applied during planning**
- Modify: `docs/decision-log.md` — **already applied during planning**

> **Pre-applied:** The manager approved Golden Rules #16 and #17 and asked for the governance docs to be updated during planning. So these edits **already exist in the working tree** — this task is verify-and-commit, not author-from-scratch. Do NOT re-add them (you'll create duplicates).

- [ ] **Step 1: Verify the doc edits are present**

```bash
cd /Users/atamurad/Desktop/pulse-platform
grep -n "16. Staff see derived state" docs/golden-rules.md
grep -n "17. Non-critical surfaces fail safe" docs/golden-rules.md
grep -n "16. Staff see derived state" CLAUDE.md
grep -n "Staff celebration-state endpoint" docs/decision-log.md
```
Expected: each grep returns a line. If any is missing, add it (content lives in this plan's `git diff` history and the spec §9) — otherwise proceed.

- [ ] **Step 2: Commit the docs as their own concern (§1.6)**

This commit also carries the spec + plan files (they were written during planning and are part of the same documentation concern).

```bash
git add docs/golden-rules.md CLAUDE.md docs/decision-log.md \
  docs/superpowers/specs/2026-05-26-birthday-staff-celebration-state-design.md \
  docs/superpowers/plans/2026-05-26-staff-celebration-state.md
git commit -m "docs: Golden Rules #16/#17 + celebration-state spec, plan, decision-log

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (before handing back / pushing)

- [ ] **All celebration specs pass:** `cd apps/api && npx jest src/modules/celebration` → green.
- [ ] **Full suite green:** `cd apps/api && npm test` → no new failures.
- [ ] **Build clean:** `cd apps/api && npm run build` → no errors.
- [ ] **Manual smoke (optional, if a local stack is running):** with the flag enabled, a staff JWT calling `GET /api/v1/admin/customers/<uuid>/celebration-state` returns `{ state, label, active_rewards }` and a customer JWT gets 403. (See memory: dev API runs `start:prod`; rebuild + restart after changes.)
- [ ] **Stop here.** Do not push or open a PR until the manager says "push it" (CLAUDE.md §8). Print the commit log and the publish commands for review.

---

## Out of scope (do NOT build — deferred, no rewrite needed later)

- Barista **badge UI** and one-tap **redemption** (no POS/dashboard client exists).
- The generic **`rewards` table** (we use `offers`; a future migration swaps the mapping source without changing the endpoint contract).
- The **daily issuance worker** (until it exists, `active_rewards` is empty).
- The **`SHOW_DAYS_UNTIL_BIRTHDAY` "in N days"** label variant (seam exists; default stays vague).
- Anniversary / referral reward **types** (flow into `active_rewards` automatically via the generic offer→reward mapping).
