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
    if (offset === 0 && openAt.getTime() <= from.getTime()) continue;
    return openAt;
  }
  return null;
}

/**
 * Store status in the location's timezone. Pure — `now` is a parameter so
 * tests pin every branch. Closing-soon = within 60 min of close. Overnight
 * ranges (open > close) are treated as plain "open" (no closing-soon window)
 * since coffee shops don't use them.
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

  const openMin = timeStringToMinutes(today!.open_time);
  const closeMin = timeStringToMinutes(today!.close_time);
  const curMin = localMinutesInTz(now, tz);

  if (openMin < closeMin) {
    const dayAnchor = startOfDayPlusDaysInTz(now, 0, tz);
    const closeAt = combineLocalDayAndTime(dayAnchor, today!.close_time, tz);
    const minsToClose = closeMin - curMin;
    if (minsToClose <= CLOSING_SOON_MINUTES) {
      return { status: 'closing_soon', next_transition_at: closeAt.toISOString(), today_open, today_close };
    }
    const closingSoonAt = new Date(closeAt.getTime() - CLOSING_SOON_MINUTES * 60_000);
    return { status: 'open', next_transition_at: closingSoonAt.toISOString(), today_open, today_close };
  }

  return { status: 'open', next_transition_at: nextOpenIso, today_open, today_close };
}
