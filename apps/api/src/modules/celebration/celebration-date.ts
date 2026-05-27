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
 * arithmetic uses native Date field overflow (e.g. day 33 -> next month), which
 * is DST-safe because we only read Y/M/D back, never a time-of-day.
 */
import { toZonedTime } from 'date-fns-tz';

export type CelebrationState = 'BIRTHDAY_TODAY' | 'BIRTHDAY_THIS_WEEK' | 'NONE';

const LABELS: Record<CelebrationState, string> = {
  // Vague by design: THIS_WEEK carries no date and no day count — warmer and
  // less surveillance-y. A future SHOW_DAYS_UNTIL_BIRTHDAY variant is a seam,
  // not shipped.
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
 * Feb 29 -> Feb 28 in non-leap years (consistent with the product spec).
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
  if (!dateOfBirth || dateOfBirth.length !== 10) return 'NONE'; // only accept 'YYYY-MM-DD'

  // Index 0 (year) is intentionally skipped — only month/day are compared,
  // and the birth year is never read or surfaced (privacy).
  const [, monthStr, dayStr] = dateOfBirth.split('-');
  const birthMonth = Number(monthStr);
  const birthDay = Number(dayStr);
  if (!birthMonth || !birthDay) return 'NONE';

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
