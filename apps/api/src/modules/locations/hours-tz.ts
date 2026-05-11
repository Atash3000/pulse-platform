/**
 * Timezone-aware helpers for `HoursService`.
 *
 * Why this file exists
 * --------------------
 * The original `hours.service.ts` computed open/closed state and
 * scheduled-pickup validity using **server-local** `Date` methods
 * (`getDay()`, `getHours()`, `getMinutes()`). On an ECS task running in UTC
 * serving a store in `America/New_York` or `Asia/Tokyo`, the day-of-week
 * and time-of-day reads were systematically wrong — most visibly around
 * server-midnight UTC, where the calendar day in the location's tz
 * differs from UTC's.
 *
 * Every helper in this module takes an explicit `tz` parameter (an IANA
 * timezone string like `America/New_York`). None reads `process.env.TZ`,
 * server `Date` methods, or any ambient state. The helpers are pure and
 * deterministic given (input, tz). DST handling is delegated to
 * `date-fns-tz`, which handles spring-forward / fall-back boundaries
 * correctly.
 *
 * See decision-log entry "Timezone-aware hours and scheduled pickup
 * validation" for the full rationale.
 */

import { addDays } from 'date-fns';
import { formatInTimeZone, fromZonedTime, toZonedTime } from 'date-fns-tz';

const DEFAULT_TIMEZONE = 'America/New_York';

/**
 * Resolves a raw timezone string into a usable IANA timezone. Two failure
 * modes are absorbed:
 *
 *   - Empty / null / undefined → default to `America/New_York` (mirrors
 *     the existing `location.timezone || 'America/New_York'` pattern
 *     used in `admin-dashboard.service.ts:79`).
 *
 *   - Invalid IANA values (typo like `America/Newyork`) → `Intl`
 *     construction throws `RangeError`. We catch, mark `isFallback: true`,
 *     and return the default. The caller is expected to log a structured
 *     WARN with the original bad value + locationId so an operator can
 *     fix the Location row.
 *
 * This is the read-time defensive fallback (option (b) in the C-series
 * reconnaissance). Write-time validation (option (c)) — rejecting bad
 * timezones at the Location create/update path or via a Postgres CHECK
 * constraint — is a deferred follow-up.
 */
export function resolveTimezone(
  rawTz: string | null | undefined,
): { tz: string; isFallback: boolean; originalTz?: string } {
  const candidate = rawTz || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return { tz: candidate, isFallback: false };
  } catch (err) {
    if (err instanceof RangeError) {
      return { tz: DEFAULT_TIMEZONE, isFallback: true, originalTz: candidate };
    }
    // Anything other than RangeError is unexpected — let it propagate.
    throw err;
  }
}

/**
 * Day-of-week of `when` in the given timezone. 0 = Sunday … 6 = Saturday,
 * matching `LocationHours.day_of_week` (which itself matches `Date.getDay()`
 * semantics, just server-tz). For `when = 2026-05-10T20:00:00Z` (Saturday
 * 8pm UTC) and `tz = Asia/Tokyo`, returns `0` (Sunday) because that instant
 * is Sunday 05:00 in Tokyo — even though UTC still thinks it's Saturday.
 */
export function dayOfWeekInTz(when: Date, tz: string): number {
  return toZonedTime(when, tz).getDay();
}

/**
 * Minute-of-day of `when` in the given timezone (0..1439). The buggy
 * pre-fix helper read `when.getHours() * 60 + when.getMinutes()` which is
 * server-tz. After fix: `toZonedTime(when, tz)` returns a `Date` whose
 * `.getHours()` / `.getMinutes()` report the location-local values.
 */
export function localMinutesInTz(when: Date, tz: string): number {
  const zoned = toZonedTime(when, tz);
  return zoned.getHours() * 60 + zoned.getMinutes();
}

/**
 * `"HH:MM:SS"` → minutes since midnight. Unchanged from the pre-fix
 * implementation — the LocationHours columns are tz-independent (HH:MM:SS
 * relative to whatever the store's tz is).
 */
export function timeStringToMinutes(t: string): number {
  const parts = t.split(':').map(Number);
  const h = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  return h * 60 + m;
}

/**
 * Is `when` (a UTC instant) within `[openTime, closeTime)` interpreted as
 * local time in `tz`? Inclusive of `openTime`, exclusive of `closeTime`.
 * Handles overnight ranges (open 22:00, close 02:00) — most coffee shops
 * won't, but the LocationHours data model permits it.
 */
export function isTimeWithinInTz(
  when: Date,
  openTime: string,
  closeTime: string,
  tz: string,
): boolean {
  const cur = localMinutesInTz(when, tz);
  const open = timeStringToMinutes(openTime);
  const close = timeStringToMinutes(closeTime);
  if (open === close) return false;
  if (open < close) return cur >= open && cur < close;
  // Overnight: open before midnight, close after.
  return cur >= open || cur < close;
}

/**
 * Combine "the calendar day of `dayAnchor` in `tz`" with `time` ("HH:MM:SS"
 * interpreted as local time in `tz`) → UTC `Date` instant.
 *
 * Used by `HoursService.findNextOpening` to compute the absolute UTC instant
 * for "the next time this store opens." iOS receives this as an ISO string
 * and displays it via its own tz-aware formatter — typically matching the
 * customer's device tz, which usually matches the location tz for a
 * single-shop deployment. The backend's job is producing the correct UTC
 * instant; rendering is the client's problem.
 *
 * DST is handled by `fromZonedTime` — for example, `2026-03-08T02:30:00`
 * in `America/New_York` (spring-forward day, 2am skipped) maps to the
 * 3am-EDT instant rather than the (nonexistent) 2:30am.
 */
export function combineLocalDayAndTime(
  dayAnchor: Date,
  time: string,
  tz: string,
): Date {
  // Extract the calendar year/month/day in tz.
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = dtf.formatToParts(dayAnchor);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const d = parts.find((p) => p.type === 'day')!.value;

  // Pad time parts defensively — `LocationHours.open_time` ships as
  // "HH:MM:SS" from Postgres `TIME` columns but the helper accepts any
  // colon-separated triple.
  const tparts = time.split(':');
  const hh = (tparts[0] ?? '00').padStart(2, '0');
  const mm = (tparts[1] ?? '00').padStart(2, '0');
  const ss = (tparts[2] ?? '00').padStart(2, '0');

  // Construct an unanchored local-time ISO string (no Z, no offset).
  // `fromZonedTime` interprets this as "local time in tz" and returns the
  // corresponding UTC `Date`.
  const localIso = `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
  return fromZonedTime(localIso, tz);
}

/**
 * `from` + `days` calendar days, where "calendar day" is interpreted in
 * `tz`. Returns a UTC `Date` representing midnight (start of day) on the
 * target calendar day in `tz` — used by `findNextOpening` as the anchor
 * for the subsequent `combineLocalDayAndTime` call.
 *
 * Calendar-day addition (not millisecond addition) means DST boundaries
 * don't shift the result by ±1 hour. Adding 1 day to "March 7 in
 * America/New_York" lands on "March 8 in America/New_York" regardless of
 * the spring-forward transition.
 */
export function startOfDayPlusDaysInTz(from: Date, days: number, tz: string): Date {
  const zoned = toZonedTime(from, tz);
  const advanced = addDays(zoned, days);
  // Build a "YYYY-MM-DDT00:00:00" local string and convert to UTC.
  const y = advanced.getFullYear();
  const m = String(advanced.getMonth() + 1).padStart(2, '0');
  const d = String(advanced.getDate()).padStart(2, '0');
  return fromZonedTime(`${y}-${m}-${d}T00:00:00`, tz);
}

/**
 * Render `HH:mm` for a UTC `Date` instant in `tz`. Used in rejection
 * messages like `"We open at 09:00"` so the customer sees the local open
 * time of their store, not a server-tz translation that's correct only by
 * coincidence.
 */
export function formatTimeInTz(d: Date, tz: string): string {
  return formatInTimeZone(d, tz, 'HH:mm');
}
