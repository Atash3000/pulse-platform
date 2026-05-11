import {
  combineLocalDayAndTime,
  dayOfWeekInTz,
  formatTimeInTz,
  isTimeWithinInTz,
  localMinutesInTz,
  resolveTimezone,
  startOfDayPlusDaysInTz,
  timeStringToMinutes,
} from './hours-tz';

// =============================================================================
// Timezone helpers — pure functions, each independently tested. The fixtures
// pin specific real-world UTC instants whose calendar interpretation differs
// across timezones, which is exactly the bug class this module fixes.
//
// Useful reference points:
//   2026-05-11T22:00:00Z = Monday 18:00 New York (EDT, UTC-4 after spring fwd)
//                       = Monday 15:00 Los Angeles (PDT)
//                       = Tuesday 07:00 Tokyo (JST)
//   2026-05-09T20:00:00Z = Saturday 16:00 UTC
//                       = Sunday 05:00 Tokyo (JST)
//   2026-03-08T07:00:00Z = US spring-forward day. Pre-DST in NY = 02:00 EST,
//                          post-DST in NY = 03:00 EDT. (US shifts at 02:00.)
//   2026-03-14T13:00:00Z = Saturday 09:00 New York (now firmly in EDT, UTC-4)
// =============================================================================

describe('resolveTimezone', () => {
  it('passes through a valid IANA timezone unchanged', () => {
    expect(resolveTimezone('America/New_York')).toEqual({
      tz: 'America/New_York',
      isFallback: false,
    });
  });

  it('passes through Asia/Tokyo', () => {
    expect(resolveTimezone('Asia/Tokyo')).toEqual({
      tz: 'Asia/Tokyo',
      isFallback: false,
    });
  });

  it('null input falls back to America/New_York', () => {
    expect(resolveTimezone(null)).toEqual({
      tz: 'America/New_York',
      isFallback: false,
    });
  });

  it('empty string falls back to America/New_York', () => {
    expect(resolveTimezone('')).toEqual({
      tz: 'America/New_York',
      isFallback: false,
    });
  });

  it('invalid IANA value (typo) falls back AND flags isFallback=true with originalTz', () => {
    expect(resolveTimezone('America/Newyork')).toEqual({
      tz: 'America/New_York',
      isFallback: true,
      originalTz: 'America/Newyork',
    });
  });
});

describe('dayOfWeekInTz', () => {
  it('Monday 18:00 NY (Mon 22:00 UTC) → 1 in both NY and UTC', () => {
    const when = new Date('2026-05-11T22:00:00Z');
    expect(dayOfWeekInTz(when, 'America/New_York')).toBe(1);
    expect(dayOfWeekInTz(when, 'UTC')).toBe(1);
  });

  it('Saturday 20:00 UTC → 6 in UTC, 0 (Sunday) in Tokyo (day rollover)', () => {
    // This is the smoking-gun bug case: the same UTC instant maps to
    // different calendar days in UTC vs Tokyo. The pre-fix code read
    // server-tz (presumably UTC in prod) and looked up Saturday's
    // LocationHours row even for a Tokyo store at 5am Sunday.
    const when = new Date('2026-05-09T20:00:00Z');
    expect(dayOfWeekInTz(when, 'UTC')).toBe(6);
    expect(dayOfWeekInTz(when, 'Asia/Tokyo')).toBe(0);
  });
});

describe('timeStringToMinutes', () => {
  it('"09:00:00" → 540', () => {
    expect(timeStringToMinutes('09:00:00')).toBe(540);
  });

  it('"00:00:00" → 0', () => {
    expect(timeStringToMinutes('00:00:00')).toBe(0);
  });

  it('"23:59:59" → 1439', () => {
    expect(timeStringToMinutes('23:59:59')).toBe(23 * 60 + 59);
  });

  it('accepts "HH:MM" without seconds', () => {
    expect(timeStringToMinutes('14:30')).toBe(14 * 60 + 30);
  });
});

describe('localMinutesInTz', () => {
  it('Monday 22:00 UTC → 1080 minutes in UTC, 1080 minutes in NY (18:00)', () => {
    const when = new Date('2026-05-11T22:00:00Z');
    expect(localMinutesInTz(when, 'UTC')).toBe(22 * 60);
    expect(localMinutesInTz(when, 'America/New_York')).toBe(18 * 60);
  });

  it('Same UTC instant maps to different minutes in LA vs Tokyo', () => {
    const when = new Date('2026-05-11T22:00:00Z');
    expect(localMinutesInTz(when, 'America/Los_Angeles')).toBe(15 * 60); // 15:00 PDT
    expect(localMinutesInTz(when, 'Asia/Tokyo')).toBe(7 * 60); // 07:00 JST (next day)
  });
});

describe('isTimeWithinInTz', () => {
  it('Monday 18:00 NY within 09:00-19:00 NY hours → true', () => {
    const when = new Date('2026-05-11T22:00:00Z'); // 18:00 NY
    expect(isTimeWithinInTz(when, '09:00:00', '19:00:00', 'America/New_York')).toBe(true);
  });

  it('Monday 22:00 UTC interpreted by a UTC-server bug — falsely "outside hours"', () => {
    // This is what the pre-fix code did: read 22:00 UTC as "current minute"
    // and compared against the 09:00-19:00 window. We pin the FIX by
    // verifying the helper returns true when correctly interpreted in NY.
    const when = new Date('2026-05-11T22:00:00Z');
    // Buggy interpretation: 22:00 not within 09-19 → would reject.
    expect(isTimeWithinInTz(when, '09:00:00', '19:00:00', 'UTC')).toBe(false);
    // Correct interpretation: 18:00 NY within 09-19 → allow.
    expect(isTimeWithinInTz(when, '09:00:00', '19:00:00', 'America/New_York')).toBe(true);
  });

  it('exactly at open time is INCLUSIVE (allowed)', () => {
    // 09:00 NY = 13:00 UTC (EDT)
    const when = new Date('2026-05-11T13:00:00Z');
    expect(isTimeWithinInTz(when, '09:00:00', '19:00:00', 'America/New_York')).toBe(true);
  });

  it('exactly at close time is EXCLUSIVE (rejected)', () => {
    // 19:00 NY = 23:00 UTC (EDT)
    const when = new Date('2026-05-11T23:00:00Z');
    expect(isTimeWithinInTz(when, '09:00:00', '19:00:00', 'America/New_York')).toBe(false);
  });

  it('overnight range (open 22, close 02): 23:00 NY within range', () => {
    // 23:00 NY EDT = 03:00 UTC (next day)
    const when = new Date('2026-05-12T03:00:00Z');
    expect(isTimeWithinInTz(when, '22:00:00', '02:00:00', 'America/New_York')).toBe(true);
  });

  it('overnight range: 01:00 NY within range', () => {
    // 01:00 NY EDT = 05:00 UTC
    const when = new Date('2026-05-12T05:00:00Z');
    expect(isTimeWithinInTz(when, '22:00:00', '02:00:00', 'America/New_York')).toBe(true);
  });

  it('overnight range: 03:00 NY OUTSIDE range', () => {
    // 03:00 NY EDT = 07:00 UTC
    const when = new Date('2026-05-12T07:00:00Z');
    expect(isTimeWithinInTz(when, '22:00:00', '02:00:00', 'America/New_York')).toBe(false);
  });

  it('open === close → always false (degenerate range)', () => {
    const when = new Date('2026-05-11T14:00:00Z');
    expect(isTimeWithinInTz(when, '12:00:00', '12:00:00', 'America/New_York')).toBe(false);
  });
});

describe('combineLocalDayAndTime', () => {
  it('"09:00:00" on Monday NY → corresponding UTC instant (EDT = UTC-4)', () => {
    // dayAnchor: any UTC instant on Monday May 11 2026 in NY.
    const anchor = new Date('2026-05-11T18:00:00Z'); // 14:00 NY, still Monday
    const utcInstant = combineLocalDayAndTime(anchor, '09:00:00', 'America/New_York');
    expect(utcInstant.toISOString()).toBe('2026-05-11T13:00:00.000Z');
  });

  it('"09:00:00" on a post-DST NY day uses EDT (-4) not EST (-5)', () => {
    // Spring-forward in US 2026 was March 8. March 14 is firmly EDT.
    // 09:00 NY on March 14 = 13:00 UTC (not 14:00 UTC, which would be EST).
    const anchor = new Date('2026-03-14T15:00:00Z'); // 11:00 EDT — same day in NY
    const utcInstant = combineLocalDayAndTime(anchor, '09:00:00', 'America/New_York');
    expect(utcInstant.toISOString()).toBe('2026-03-14T13:00:00.000Z');
  });

  it('"09:00:00" on a pre-DST NY day uses EST (-5)', () => {
    // March 1 2026 is pre-spring-forward — NY is EST (UTC-5).
    // 09:00 NY = 14:00 UTC.
    const anchor = new Date('2026-03-01T15:00:00Z'); // 10:00 EST
    const utcInstant = combineLocalDayAndTime(anchor, '09:00:00', 'America/New_York');
    expect(utcInstant.toISOString()).toBe('2026-03-01T14:00:00.000Z');
  });

  it('respects the calendar day in tz, not in UTC (day-rollover)', () => {
    // Saturday 20:00 UTC = Sunday 05:00 Tokyo. The "calendar day in Tokyo"
    // is Sunday. Asking for "09:00 on the Tokyo calendar day of this
    // instant" should return Sunday 09:00 Tokyo = Sunday 00:00 UTC.
    const anchor = new Date('2026-05-09T20:00:00Z'); // Sun 05:00 Tokyo
    const utcInstant = combineLocalDayAndTime(anchor, '09:00:00', 'Asia/Tokyo');
    expect(utcInstant.toISOString()).toBe('2026-05-10T00:00:00.000Z');
  });

  it('accepts time string without seconds ("HH:MM")', () => {
    const anchor = new Date('2026-05-11T18:00:00Z');
    const utcInstant = combineLocalDayAndTime(anchor, '09:00', 'America/New_York');
    expect(utcInstant.toISOString()).toBe('2026-05-11T13:00:00.000Z');
  });
});

describe('startOfDayPlusDaysInTz', () => {
  it('+0 days: returns midnight on the same calendar day in tz', () => {
    const from = new Date('2026-05-11T22:00:00Z'); // 18:00 NY Monday
    const result = startOfDayPlusDaysInTz(from, 0, 'America/New_York');
    expect(result.toISOString()).toBe('2026-05-11T04:00:00.000Z'); // 00:00 NY = 04:00 UTC (EDT)
  });

  it('+1 day: NY perspective', () => {
    const from = new Date('2026-05-11T22:00:00Z'); // 18:00 NY Monday
    const result = startOfDayPlusDaysInTz(from, 1, 'America/New_York');
    expect(result.toISOString()).toBe('2026-05-12T04:00:00.000Z'); // 00:00 NY Tuesday
  });

  it('+1 day crossing a UTC day boundary in Tokyo', () => {
    // 20:00 UTC Saturday = 05:00 Sunday Tokyo. +1 day in Tokyo = Monday.
    const from = new Date('2026-05-09T20:00:00Z'); // Sun 05:00 Tokyo
    const result = startOfDayPlusDaysInTz(from, 1, 'Asia/Tokyo');
    expect(result.toISOString()).toBe('2026-05-10T15:00:00.000Z'); // 00:00 Mon Tokyo = 15:00 UTC Sun
  });
});

describe('formatTimeInTz', () => {
  it('renders HH:mm in the requested tz, not server tz', () => {
    const when = new Date('2026-05-11T13:00:00Z');
    expect(formatTimeInTz(when, 'America/New_York')).toBe('09:00');
    expect(formatTimeInTz(when, 'America/Los_Angeles')).toBe('06:00');
    expect(formatTimeInTz(when, 'Asia/Tokyo')).toBe('22:00');
  });

  it('zero-pads single-digit hours and minutes', () => {
    // 14:05 UTC = 10:05 EDT (NY). The fix-side helper pads both fields.
    const when = new Date('2026-05-11T14:05:00Z');
    expect(formatTimeInTz(when, 'America/New_York')).toBe('10:05');
  });
});
