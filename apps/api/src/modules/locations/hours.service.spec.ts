import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';

import {
  Location,
  LocationHours,
  LocationSettings,
  PickupType,
} from '../../database/entities';
import { HoursService } from './hours.service';

// =============================================================================
// HoursService.canAcceptOrders — timezone-aware integration tests.
//
// These tests pin the bug (server-tz reads) and the fix (location-tz reads)
// across multiple zones. They use `opts.now` to inject a specific UTC
// instant per test so behaviour is deterministic regardless of the test
// process's `TZ` env var or wall-clock time at run.
//
// Useful UTC reference points (post-DST, May 2026):
//
//   2026-05-11T22:00:00Z = Monday 18:00 New York (EDT)
//                       = Monday 15:00 Los Angeles (PDT)
//                       = Tuesday 07:00 Tokyo (JST)
//   2026-05-09T20:00:00Z = Saturday 16:00 UTC
//                       = Sunday 05:00 Tokyo (JST, day rollover)
//   2026-03-14T13:00:00Z = Saturday 09:00 New York (EDT, post spring-fwd)
// =============================================================================

const NY = 'America/New_York';
const LA = 'America/Los_Angeles';
const TYO = 'Asia/Tokyo';

interface BuildOpts {
  timezone?: string | null;
  active?: boolean;
  hoursRows?: Array<{
    day_of_week: number;
    open_time: string;
    close_time: string;
    is_closed?: boolean;
  }>;
  settings?: Partial<LocationSettings>;
}

async function buildService(opts: BuildOpts): Promise<{
  service: HoursService;
  warnSpy: jest.SpyInstance;
}> {
  const locationsFindOne = jest.fn().mockResolvedValue(
    opts.timezone === undefined
      ? null
      : ({
          id: 'loc-1',
          timezone: opts.timezone,
          active: opts.active ?? true,
        } as Partial<Location>),
  );

  const hoursFindOne = jest.fn().mockImplementation(({ where }: { where: { day_of_week: number } }) => {
    const row = (opts.hoursRows ?? []).find((r) => r.day_of_week === where.day_of_week);
    return Promise.resolve(
      row
        ? ({
            day_of_week: row.day_of_week,
            open_time: row.open_time,
            close_time: row.close_time,
            is_closed: row.is_closed ?? false,
          } as Partial<LocationHours>)
        : null,
    );
  });

  const settingsFindOne = jest.fn().mockResolvedValue(opts.settings ?? null);

  const moduleRef = await Test.createTestingModule({
    providers: [
      HoursService,
      { provide: getRepositoryToken(Location), useValue: { findOne: locationsFindOne } },
      { provide: getRepositoryToken(LocationHours), useValue: { findOne: hoursFindOne } },
      { provide: getRepositoryToken(LocationSettings), useValue: { findOne: settingsFindOne } },
    ],
  }).compile();

  const service = moduleRef.get(HoursService);
  const warnSpy = jest
    .spyOn(
      (service as unknown as { logger: { warn: (m: string) => void } }).logger,
      'warn',
    )
    .mockImplementation(() => {});

  return { service, warnSpy };
}

// `hoursRows` shorthand for a typical Mon-Fri 09-19 + closed weekend store.
const STANDARD_HOURS_MON_FRI_9_19 = [
  { day_of_week: 0, open_time: '00:00:00', close_time: '00:00:00', is_closed: true }, // Sun closed
  { day_of_week: 1, open_time: '09:00:00', close_time: '19:00:00' }, // Mon
  { day_of_week: 2, open_time: '09:00:00', close_time: '19:00:00' }, // Tue
  { day_of_week: 3, open_time: '09:00:00', close_time: '19:00:00' }, // Wed
  { day_of_week: 4, open_time: '09:00:00', close_time: '19:00:00' }, // Thu
  { day_of_week: 5, open_time: '09:00:00', close_time: '19:00:00' }, // Fri
  { day_of_week: 6, open_time: '00:00:00', close_time: '00:00:00', is_closed: true }, // Sat closed
];

// =============================================================================
// TC1-TC3: ASAP availability across timezones — the bug class
// =============================================================================

describe('HoursService.canAcceptOrders — ASAP across timezones', () => {
  it('TC1: NY store, server UTC, real time = 6pm NY → allowed (pre-fix would reject as 22:00 UTC outside 09-19)', async () => {
    const { service } = await buildService({
      timezone: NY,
      hoursRows: STANDARD_HOURS_MON_FRI_9_19,
    });
    const result = await service.canAcceptOrders('loc-1', {
      pickupType: PickupType.ASAP,
      now: new Date('2026-05-11T22:00:00Z'), // Monday 18:00 NY EDT
    });
    expect(result.allowed).toBe(true);
  });

  it('TC2: LA store, server UTC, real time = 8am LA → allowed', async () => {
    const { service } = await buildService({
      timezone: LA,
      hoursRows: [
        { day_of_week: 1, open_time: '07:00:00', close_time: '17:00:00' }, // Mon 7am-5pm LA
      ],
    });
    const result = await service.canAcceptOrders('loc-1', {
      pickupType: PickupType.ASAP,
      now: new Date('2026-05-11T15:00:00Z'), // 08:00 LA PDT, Monday
    });
    expect(result.allowed).toBe(true);
  });

  it('TC3: Tokyo store, server UTC at Saturday 20:00 → Sunday 5am Tokyo. Tokyo is closed Sun, so reject CLOSED_TODAY (pre-fix would read Saturday\'s hours instead)', async () => {
    const { service } = await buildService({
      timezone: TYO,
      hoursRows: [
        { day_of_week: 0, open_time: '00:00:00', close_time: '00:00:00', is_closed: true }, // Tokyo Sun = closed
        { day_of_week: 6, open_time: '09:00:00', close_time: '17:00:00' }, // Tokyo Sat = open
      ],
    });
    const result = await service.canAcceptOrders('loc-1', {
      pickupType: PickupType.ASAP,
      now: new Date('2026-05-09T20:00:00Z'), // Sat 8pm UTC = Sun 5am Tokyo
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('CLOSED_TODAY');
    }
  });

  it('TC3 mirror: Tokyo store, Saturday 5am Tokyo (Friday 8pm UTC) → ALLOWED via Saturday hours', async () => {
    // The other half of the day-rollover proof: when UTC says Friday but
    // Tokyo says Saturday, the store should use Saturday's hours.
    const { service } = await buildService({
      timezone: TYO,
      hoursRows: [
        { day_of_week: 5, open_time: '00:00:00', close_time: '00:00:00', is_closed: true }, // Tokyo Fri closed (contrived)
        { day_of_week: 6, open_time: '04:00:00', close_time: '12:00:00' }, // Tokyo Sat 4am-noon
      ],
    });
    const result = await service.canAcceptOrders('loc-1', {
      pickupType: PickupType.ASAP,
      now: new Date('2026-05-08T20:00:00Z'), // Fri 8pm UTC = Sat 5am Tokyo
    });
    expect(result.allowed).toBe(true);
  });
});

// =============================================================================
// TC4: SCHEDULED pickup with tomorrow's calendar in tz
// =============================================================================

describe('HoursService.canAcceptOrders — SCHEDULED', () => {
  it('TC4: SCHEDULED for tomorrow 10am LA, server UTC past 10am today → allowed', async () => {
    const { service } = await buildService({
      timezone: LA,
      hoursRows: [
        { day_of_week: 1, open_time: '07:00:00', close_time: '20:00:00' }, // Mon 7am-8pm LA
        { day_of_week: 2, open_time: '07:00:00', close_time: '20:00:00' }, // Tue 7am-8pm LA
      ],
    });

    const result = await service.canAcceptOrders('loc-1', {
      pickupType: PickupType.SCHEDULED,
      now: new Date('2026-05-11T18:00:00Z'), // Mon 11am LA, past 10am today
      scheduledTime: new Date('2026-05-12T17:00:00Z'), // Tue 10am LA (UTC-7 PDT)
    });
    expect(result.allowed).toBe(true);
  });

  it('SCHEDULED in past relative to now → rejected', async () => {
    const { service } = await buildService({
      timezone: LA,
      hoursRows: STANDARD_HOURS_MON_FRI_9_19,
    });
    const result = await service.canAcceptOrders('loc-1', {
      pickupType: PickupType.SCHEDULED,
      now: new Date('2026-05-11T22:00:00Z'),
      scheduledTime: new Date('2026-05-11T21:00:00Z'), // 1 hour earlier
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('SCHEDULED_TIME_IN_PAST');
  });

  it('SCHEDULED too far → rejected (default max_schedule_days=7)', async () => {
    const { service } = await buildService({
      timezone: LA,
      hoursRows: STANDARD_HOURS_MON_FRI_9_19,
    });
    const result = await service.canAcceptOrders('loc-1', {
      pickupType: PickupType.SCHEDULED,
      now: new Date('2026-05-11T22:00:00Z'),
      scheduledTime: new Date('2026-05-30T22:00:00Z'), // 19 days out
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('SCHEDULED_TIME_TOO_FAR');
  });

  it('SCHEDULED time outside hours-of-day in tz → rejected', async () => {
    // 22:00 LA on a Mon (07-19 hours) — outside.
    const { service } = await buildService({
      timezone: LA,
      hoursRows: [
        { day_of_week: 1, open_time: '07:00:00', close_time: '19:00:00' },
        { day_of_week: 2, open_time: '07:00:00', close_time: '19:00:00' },
      ],
    });
    const result = await service.canAcceptOrders('loc-1', {
      pickupType: PickupType.SCHEDULED,
      now: new Date('2026-05-11T15:00:00Z'), // Mon 08:00 LA
      scheduledTime: new Date('2026-05-12T05:00:00Z'), // Mon 22:00 LA — outside the Mon window
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('SCHEDULED_TIME_OUTSIDE_HOURS');
  });

  it('SCHEDULED missing → rejected', async () => {
    const { service } = await buildService({
      timezone: LA,
      hoursRows: STANDARD_HOURS_MON_FRI_9_19,
    });
    const result = await service.canAcceptOrders('loc-1', {
      pickupType: PickupType.SCHEDULED,
      now: new Date('2026-05-11T22:00:00Z'),
      // no scheduledTime
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('SCHEDULED_TIME_REQUIRED');
  });
});

// =============================================================================
// TC5: DST handling via the underlying combineLocalDayAndTime helper
// =============================================================================

describe('HoursService.canAcceptOrders — DST handling', () => {
  it('TC5: post-spring-forward NY date (March 14 2026) — nextOpenAt uses EDT (UTC-4), not EST (UTC-5)', async () => {
    // Set "now" to early Saturday morning NY (before 09:00 open). The
    // CLOSED_TODAY branch shouldn't fire (Sat is open per the hours below),
    // but the OUTSIDE_HOURS branch fires and returns nextOpenAt = Sat 09:00 NY.
    // Post-DST in NY: Sat 09:00 EDT = 13:00 UTC.
    const { service } = await buildService({
      timezone: NY,
      hoursRows: [
        { day_of_week: 6, open_time: '09:00:00', close_time: '17:00:00' }, // Sat open
      ],
    });
    const result = await service.canAcceptOrders('loc-1', {
      pickupType: PickupType.ASAP,
      now: new Date('2026-03-14T11:00:00Z'), // Sat 07:00 NY EDT — before open
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('OUTSIDE_HOURS');
      expect(result.nextOpenAt?.toISOString()).toBe('2026-03-14T13:00:00.000Z');
      expect(result.message).toContain('09:00'); // rendered in NY tz, not UTC
    }
  });
});

// =============================================================================
// TC6: server-tz independence (no process.env.TZ shim needed — the fix uses
// explicit tz at every step. This test pins the absence of server-tz reads
// by running an identical NY fixture and asserting the same result.)
// =============================================================================

describe('HoursService.canAcceptOrders — server-tz independence', () => {
  it('TC6: fix does not depend on server tz — all calls thread an explicit tz', async () => {
    // The fix's contract is "every helper takes an explicit tz; none reads
    // process.env.TZ or server-local Date methods." We can't easily prove
    // this by mutating process.env.TZ at test time (V8 may have cached the
    // Date system), but we CAN verify behaviour is stable across a wide
    // range of UTC instants for the same store + same wall-clock-in-tz —
    // which it is, by construction.
    const { service } = await buildService({
      timezone: NY,
      hoursRows: STANDARD_HOURS_MON_FRI_9_19,
    });

    // Two different UTC instants that both correspond to "Monday 14:00 NY"
    // — one pre-DST (Mar 2 = EST, UTC-5 = 19:00 UTC), one post-DST (May 11
    // = EDT, UTC-4 = 18:00 UTC). Both should be ALLOWED via Mon's 09-19
    // window. A bug that reads server tz would give different results
    // depending on the date.
    const preDst = await service.canAcceptOrders('loc-1', {
      pickupType: PickupType.ASAP,
      now: new Date('2026-03-02T19:00:00Z'), // Mon 14:00 EST
    });
    const postDst = await service.canAcceptOrders('loc-1', {
      pickupType: PickupType.ASAP,
      now: new Date('2026-05-11T18:00:00Z'), // Mon 14:00 EDT
    });
    expect(preDst.allowed).toBe(true);
    expect(postDst.allowed).toBe(true);
  });
});

// =============================================================================
// Regression tests for pre-existing behaviour (closed, paused, etc.)
// =============================================================================

describe('HoursService.canAcceptOrders — pre-existing regression', () => {
  it('inactive location → rejected LOCATION_INACTIVE', async () => {
    const { service } = await buildService({
      timezone: NY,
      active: false,
      hoursRows: STANDARD_HOURS_MON_FRI_9_19,
    });
    const result = await service.canAcceptOrders('loc-1', {
      pickupType: PickupType.ASAP,
      now: new Date('2026-05-11T18:00:00Z'),
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('LOCATION_INACTIVE');
  });

  it('mobile_ordering_paused → rejected MOBILE_ORDERING_PAUSED', async () => {
    const { service } = await buildService({
      timezone: NY,
      hoursRows: STANDARD_HOURS_MON_FRI_9_19,
      settings: { mobile_ordering_paused: true } as Partial<LocationSettings>,
    });
    const result = await service.canAcceptOrders('loc-1', {
      pickupType: PickupType.ASAP,
      now: new Date('2026-05-11T18:00:00Z'),
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('MOBILE_ORDERING_PAUSED');
  });

  it('ASAP on a closed day → CLOSED_TODAY with nextOpenAt', async () => {
    // Saturday in the standard fixture is closed. nextOpenAt should walk
    // forward to Sunday (also closed) → Monday open 09:00 NY.
    const { service } = await buildService({
      timezone: NY,
      hoursRows: STANDARD_HOURS_MON_FRI_9_19,
    });
    const result = await service.canAcceptOrders('loc-1', {
      pickupType: PickupType.ASAP,
      now: new Date('2026-05-09T14:00:00Z'), // Sat 10:00 NY
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('CLOSED_TODAY');
      // Next open = Monday 09:00 NY EDT = 13:00 UTC
      expect(result.nextOpenAt?.toISOString()).toBe('2026-05-11T13:00:00.000Z');
    }
  });

  it('overnight hours range (open 22, close 02) — within at 23:00 NY', async () => {
    const { service } = await buildService({
      timezone: NY,
      hoursRows: [{ day_of_week: 1, open_time: '22:00:00', close_time: '02:00:00' }],
    });
    const result = await service.canAcceptOrders('loc-1', {
      pickupType: PickupType.ASAP,
      now: new Date('2026-05-12T03:00:00Z'), // Mon 23:00 NY EDT
    });
    expect(result.allowed).toBe(true);
  });

  it('scheduled_ordering disabled → SCHEDULED_ORDERING_DISABLED', async () => {
    const { service } = await buildService({
      timezone: NY,
      hoursRows: STANDARD_HOURS_MON_FRI_9_19,
      settings: { scheduled_ordering: false } as Partial<LocationSettings>,
    });
    const result = await service.canAcceptOrders('loc-1', {
      pickupType: PickupType.SCHEDULED,
      now: new Date('2026-05-11T18:00:00Z'),
      scheduledTime: new Date('2026-05-12T17:00:00Z'),
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('SCHEDULED_ORDERING_DISABLED');
  });
});

// =============================================================================
// Bad-timezone fallback (option b — log warn + default to NY)
// =============================================================================

describe('HoursService.canAcceptOrders — bad timezone fallback', () => {
  it('invalid IANA value falls back to NY and logs a structured WARN with the bad value', async () => {
    const { service, warnSpy } = await buildService({
      timezone: 'America/Newyork', // intentional typo
      hoursRows: STANDARD_HOURS_MON_FRI_9_19,
    });

    // Use a UTC instant that's "Mon 14:00 NY" so the fallback (NY) accepts
    // the order. If the fallback were buggy and used UTC instead, the
    // 18:00/19:00 UTC reading would also happen to be inside 09-19, so
    // pick a UTC time that crosses NY but not UTC: 23:00 UTC = 19:00 NY
    // (right at close) is exclusive → outside.
    const result = await service.canAcceptOrders('loc-1', {
      pickupType: PickupType.ASAP,
      now: new Date('2026-05-11T23:00:00Z'), // 19:00 NY (exclusive close) → outside
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/invalid timezone 'America\/Newyork'/);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/falling back to 'America\/New_York'/);

    // Behaviourally fell back to NY: 19:00 NY is the exclusive close, so
    // OUTSIDE_HOURS. (If we'd used UTC, 23:00 is also outside 09-19, so
    // this case can't fully distinguish. The warn-log assertion is the
    // discriminator.)
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('OUTSIDE_HOURS');
  });

  it('empty-string timezone uses NY without warning (treated as "not set")', async () => {
    const { service, warnSpy } = await buildService({
      timezone: '',
      hoursRows: STANDARD_HOURS_MON_FRI_9_19,
    });
    const result = await service.canAcceptOrders('loc-1', {
      pickupType: PickupType.ASAP,
      now: new Date('2026-05-11T18:00:00Z'), // Mon 14:00 NY
    });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(result.allowed).toBe(true);
  });
});
