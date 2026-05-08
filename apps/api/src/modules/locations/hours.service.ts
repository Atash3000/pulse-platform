import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  Location,
  LocationHours,
  LocationSettings,
  PickupType,
} from '../../database/entities';

export type AvailabilityRejectReason =
  | 'MOBILE_ORDERING_PAUSED'
  | 'CLOSED_TODAY'
  | 'OUTSIDE_HOURS'
  | 'SCHEDULED_ORDERING_DISABLED'
  | 'SCHEDULED_TIME_OUTSIDE_HOURS'
  | 'SCHEDULED_TIME_TOO_FAR'
  | 'SCHEDULED_TIME_IN_PAST'
  | 'SCHEDULED_TIME_REQUIRED'
  | 'LOCATION_INACTIVE';

export interface AvailabilityAllowed {
  allowed: true;
  estimatedReadyAt: Date;
  waitMinutes: number;
}

export interface AvailabilityRejected {
  allowed: false;
  reason: AvailabilityRejectReason;
  message: string;
  nextOpenAt?: Date;
}

export type AvailabilityResult = AvailabilityAllowed | AvailabilityRejected;

interface CanAcceptOptions {
  pickupType: PickupType;
  scheduledTime?: Date;
  /** Override "now" — used for tests. */
  now?: Date;
}

@Injectable()
export class HoursService {
  constructor(
    @InjectRepository(Location) private readonly locations: Repository<Location>,
    @InjectRepository(LocationHours) private readonly hours: Repository<LocationHours>,
    @InjectRepository(LocationSettings) private readonly settings: Repository<LocationSettings>,
  ) {}

  /**
   * Implements Part 5.5 of the spec exactly.
   *
   *   1. Mobile ordering paused?              → reject MOBILE_ORDERING_PAUSED
   *   2. is_closed today + ASAP?              → reject CLOSED_TODAY (with nextOpenAt)
   *   3. is_closed today + SCHEDULED?         → continue (tomorrow ordering OK)
   *   4. ASAP outside open..close?            → reject OUTSIDE_HOURS (with nextOpenAt)
   *   5. SCHEDULED:
   *        scheduled_ordering disabled?       → reject SCHEDULED_ORDERING_DISABLED
   *        scheduledTime outside hours?       → reject SCHEDULED_TIME_OUTSIDE_HOURS
   *        scheduledTime > max_schedule_days? → reject SCHEDULED_TIME_TOO_FAR
   *   → allowed, estimatedReadyAt = now + current_wait_minutes
   */
  async canAcceptOrders(
    locationId: string,
    opts: CanAcceptOptions,
  ): Promise<AvailabilityResult> {
    const location = await this.locations.findOne({ where: { id: locationId } });
    if (!location) {
      throw new NotFoundException(`Location ${locationId} not found`);
    }
    if (!location.active) {
      return rejected('LOCATION_INACTIVE', 'This location is not currently accepting orders.');
    }

    const settings = await this.settings.findOne({ where: { location_id: locationId } });
    const waitMinutes = settings?.current_wait_minutes ?? 5;
    const scheduledOrderingEnabled = settings?.scheduled_ordering ?? true;
    const maxScheduleDays = settings?.max_schedule_days ?? 7;

    // 1. Paused?
    if (settings?.mobile_ordering_paused) {
      return rejected('MOBILE_ORDERING_PAUSED', 'Mobile ordering is paused right now.');
    }

    const now = opts.now ?? new Date();
    const todayHours = await this.hoursForDate(locationId, now);

    // 2/3. Closed today
    if (!todayHours || todayHours.is_closed) {
      if (opts.pickupType === PickupType.ASAP) {
        const nextOpenAt = await this.findNextOpening(locationId, now);
        return rejected(
          'CLOSED_TODAY',
          nextOpenAt
            ? `We're closed today. We open at ${formatTime(nextOpenAt)}.`
            : "We're closed today.",
          nextOpenAt,
        );
      }
      // SCHEDULED orders for a closed day fall through to step 5 below.
    }

    if (opts.pickupType === PickupType.ASAP) {
      // 4. Outside hours?
      if (todayHours && !isTimeWithin(now, todayHours.open_time, todayHours.close_time)) {
        const nextOpenAt = await this.findNextOpening(locationId, now);
        return rejected(
          'OUTSIDE_HOURS',
          nextOpenAt
            ? `We open at ${formatTime(nextOpenAt)}.`
            : 'We are not currently open.',
          nextOpenAt,
        );
      }

      const estimatedReadyAt = new Date(now.getTime() + waitMinutes * 60_000);
      return { allowed: true, estimatedReadyAt, waitMinutes };
    }

    // ---- SCHEDULED branch ----
    if (!opts.scheduledTime) {
      return rejected('SCHEDULED_TIME_REQUIRED', 'A pickup time is required for scheduled orders.');
    }
    if (!scheduledOrderingEnabled) {
      return rejected('SCHEDULED_ORDERING_DISABLED', 'Scheduled ordering is unavailable right now.');
    }

    const scheduled = opts.scheduledTime;
    if (scheduled.getTime() <= now.getTime()) {
      return rejected('SCHEDULED_TIME_IN_PAST', 'Pickup time must be in the future.');
    }

    const maxFutureMs = maxScheduleDays * 24 * 60 * 60 * 1000;
    if (scheduled.getTime() - now.getTime() > maxFutureMs) {
      return rejected(
        'SCHEDULED_TIME_TOO_FAR',
        `Scheduled pickup must be within ${maxScheduleDays} days.`,
      );
    }

    const scheduledDayHours = await this.hoursForDate(locationId, scheduled);
    if (!scheduledDayHours || scheduledDayHours.is_closed) {
      return rejected(
        'SCHEDULED_TIME_OUTSIDE_HOURS',
        "We're closed at that time. Please pick a different pickup time.",
      );
    }
    if (!isTimeWithin(scheduled, scheduledDayHours.open_time, scheduledDayHours.close_time)) {
      return rejected(
        'SCHEDULED_TIME_OUTSIDE_HOURS',
        `Please pick a time between ${scheduledDayHours.open_time.slice(0, 5)} and ${scheduledDayHours.close_time.slice(0, 5)}.`,
      );
    }

    // For SCHEDULED orders, the "ready" time is the scheduled pickup time itself —
    // staff prep happens during the wait window leading up to it.
    return { allowed: true, estimatedReadyAt: scheduled, waitMinutes };
  }

  private async hoursForDate(locationId: string, when: Date): Promise<LocationHours | null> {
    const dow = when.getDay(); // 0=Sunday, 6=Saturday — matches spec
    return this.hours.findOne({
      where: { location_id: locationId, day_of_week: dow },
    });
  }

  /**
   * Walks forward up to 7 days looking for the next open period. Returns the
   * concrete Date of the next open time (so iOS can display "We open at 7:00 AM"
   * with the correct day implied).
   */
  private async findNextOpening(locationId: string, from: Date): Promise<Date | undefined> {
    for (let offset = 0; offset < 7; offset++) {
      const day = new Date(from);
      day.setDate(day.getDate() + offset);
      const rec = await this.hoursForDate(locationId, day);
      if (!rec || rec.is_closed) continue;

      const openAt = combineDateAndTime(day, rec.open_time);
      if (offset === 0 && openAt.getTime() <= from.getTime()) {
        // Already past today's open time — keep walking.
        continue;
      }
      return openAt;
    }
    return undefined;
  }
}

// ---- pure helpers --------------------------------------------------------

function rejected(
  reason: AvailabilityRejectReason,
  message: string,
  nextOpenAt?: Date,
): AvailabilityRejected {
  return { allowed: false, reason, message, nextOpenAt };
}

/** "HH:MM:SS" → minutes since midnight. */
function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m ?? 0);
}

function dateToMinutes(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Inclusive of open_time, exclusive of close_time. Handles overnight ranges
 * (e.g. open 22:00, close 02:00) — most coffee shops won't, but the data
 * model permits it.
 */
function isTimeWithin(when: Date, openT: string, closeT: string): boolean {
  const cur = dateToMinutes(when);
  const open = timeToMinutes(openT);
  const close = timeToMinutes(closeT);
  if (open === close) return false;
  if (open < close) return cur >= open && cur < close;
  // overnight
  return cur >= open || cur < close;
}

function combineDateAndTime(day: Date, time: string): Date {
  const [h, m, s] = time.split(':').map(Number);
  const d = new Date(day);
  d.setHours(h, m ?? 0, s ?? 0, 0);
  return d;
}

function formatTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
