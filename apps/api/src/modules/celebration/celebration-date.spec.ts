import { computeCelebrationState, labelForState } from './celebration-date';

const NY = 'America/New_York';

// 16:00Z is the same calendar day in America/New_York for both EST(-5) and
// EDT(-4), so day-resolution tests are unambiguous.
function nyNoon(dateIso: string): Date {
  return new Date(`${dateIso}T16:00:00Z`);
}

describe('computeCelebrationState', () => {
  it('returns NONE when dateOfBirth is null', () => {
    expect(computeCelebrationState(null, nyNoon('2026-05-26'), NY)).toBe('NONE');
  });

  it('returns BIRTHDAY_TODAY when month/day match today in store tz', () => {
    expect(computeCelebrationState('1990-05-26', nyNoon('2026-05-26'), NY)).toBe('BIRTHDAY_TODAY');
  });

  it('returns BIRTHDAY_THIS_WEEK when birthday is in 3 days', () => {
    expect(computeCelebrationState('1990-05-26', nyNoon('2026-05-23'), NY)).toBe('BIRTHDAY_THIS_WEEK');
  });

  it('returns NONE when birthday is 8 days out (outside the 7-day window)', () => {
    expect(computeCelebrationState('1990-05-26', nyNoon('2026-05-18'), NY)).toBe('NONE');
  });

  it('returns BIRTHDAY_THIS_WEEK when birthday is exactly 7 days out (inclusive boundary)', () => {
    expect(computeCelebrationState('1990-06-02', nyNoon('2026-05-26'), NY)).toBe('BIRTHDAY_THIS_WEEK');
  });

  it('Feb 29 birthday resolves to BIRTHDAY_TODAY on Feb 28 in a non-leap year', () => {
    expect(computeCelebrationState('2000-02-29', nyNoon('2027-02-28'), NY)).toBe('BIRTHDAY_TODAY');
  });

  it('Feb 29 birthday is BIRTHDAY_TODAY on Feb 29 in a leap year', () => {
    expect(computeCelebrationState('2000-02-29', nyNoon('2028-02-29'), NY)).toBe('BIRTHDAY_TODAY');
  });

  it('wraps across the year boundary: today Dec 30, birthday Jan 2 -> THIS_WEEK', () => {
    expect(computeCelebrationState('1990-01-02', nyNoon('2026-12-30'), NY)).toBe('BIRTHDAY_THIS_WEEK');
  });

  it('resolves against the STORE day, not UTC, near midnight', () => {
    // 2026-05-27T02:00:00Z is still 2026-05-26 (22:00) in America/New_York.
    const lateUtc = new Date('2026-05-27T02:00:00Z');
    expect(computeCelebrationState('1990-05-26', lateUtc, NY)).toBe('BIRTHDAY_TODAY');
  });
});

describe('labelForState', () => {
  it('TODAY -> warm explicit label', () => {
    expect(labelForState('BIRTHDAY_TODAY')).toBe('Birthday today 🎂');
  });

  it('THIS_WEEK -> vague label with no date and no day count', () => {
    const label = labelForState('BIRTHDAY_THIS_WEEK');
    expect(label).toBe('Birthday coming up');
    expect(label).not.toMatch(/\d/);
  });

  it('NONE -> empty string', () => {
    expect(labelForState('NONE')).toBe('');
  });
});
