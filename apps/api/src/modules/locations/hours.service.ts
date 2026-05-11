import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  Location,
  LocationHours,
  LocationSettings,
  PickupType,
} from '../../database/entities';
import {
  combineLocalDayAndTime,
  dayOfWeekInTz,
  formatTimeInTz,
  isTimeWithinInTz,
  resolveTimezone,
  startOfDayPlusDaysInTz,
} from './hours-tz';

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
  private readonly logger = new Logger(HoursService.name);

  constructor(
    @InjectRepository(Location) private readonly locations: Repository<Location>,
    @InjectRepository(LocationHours) private readonly hours: Repository<LocationHours>,
    @InjectRepository(LocationSettings) private readonly settings: Repository<LocationSettings>,
  ) {}

  /**
   * Implements Part 5.5 of the spec, timezone-aware.
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
   *
   * All day-of-week and time-of-day reads use `Location.timezone`, NOT
   * server time. Server can be UTC, store can be in America/New_York or
   * Asia/Tokyo, all checks behave the same. See `hours-tz.ts` for the
   * helper module + decision-log entry "Timezone-aware hours and
   * scheduled pickup validation" for the rationale.
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

    // Resolve the timezone ONCE at entry. The helper absorbs three failure
    // modes (null/empty → default NY; invalid IANA → log warn + fall back
    // to NY; valid → pass through). All subsequent helper calls use the
    // resolved `tz`, never server local.
    const resolved = resolveTimezone(location.timezone);
    if (resolved.isFallback) {
      this.logger.warn(
        `[hours-service] location ${locationId} has invalid timezone ` +
          `'${resolved.originalTz}'; falling back to '${resolved.tz}'. ` +
          `Operator should fix the Location row.`,
      );
    }
    const tz = resolved.tz;

    const settings = await this.settings.findOne({ where: { location_id: locationId } });
    const waitMinutes = settings?.current_wait_minutes ?? 5;
    const scheduledOrderingEnabled = settings?.scheduled_ordering ?? true;
    const maxScheduleDays = settings?.max_schedule_days ?? 7;

    // 1. Paused?
    if (settings?.mobile_ordering_paused) {
      return rejected('MOBILE_ORDERING_PAUSED', 'Mobile ordering is paused right now.');
    }

    const now = opts.now ?? new Date();
    const todayHours = await this.hoursForDayOfWeek(locationId, dayOfWeekInTz(now, tz));

    // 2/3. Closed today
    if (!todayHours || todayHours.is_closed) {
      if (opts.pickupType === PickupType.ASAP) {
        const nextOpenAt = await this.findNextOpening(locationId, now, tz);
        return rejected(
          'CLOSED_TODAY',
          nextOpenAt
            ? `We're closed today. We open at ${formatTimeInTz(nextOpenAt, tz)}.`
            : "We're closed today.",
          nextOpenAt,
        );
      }
      // SCHEDULED orders for a closed day fall through to step 5 below.
    }

    if (opts.pickupType === PickupType.ASAP) {
      // 4. Outside hours?
      if (
        todayHours &&
        !isTimeWithinInTz(now, todayHours.open_time, todayHours.close_time, tz)
      ) {
        const nextOpenAt = await this.findNextOpening(locationId, now, tz);
        return rejected(
          'OUTSIDE_HOURS',
          nextOpenAt
            ? `We open at ${formatTimeInTz(nextOpenAt, tz)}.`
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

    const scheduledDayHours = await this.hoursForDayOfWeek(
      locationId,
      dayOfWeekInTz(scheduled, tz),
    );
    if (!scheduledDayHours || scheduledDayHours.is_closed) {
      return rejected(
        'SCHEDULED_TIME_OUTSIDE_HOURS',
        "We're closed at that time. Please pick a different pickup time.",
      );
    }
    if (
      !isTimeWithinInTz(
        scheduled,
        scheduledDayHours.open_time,
        scheduledDayHours.close_time,
        tz,
      )
    ) {
      return rejected(
        'SCHEDULED_TIME_OUTSIDE_HOURS',
        `Please pick a time between ${scheduledDayHours.open_time.slice(0, 5)} and ${scheduledDayHours.close_time.slice(0, 5)}.`,
      );
    }

    // For SCHEDULED orders, the "ready" time is the scheduled pickup time itself —
    // staff prep happens during the wait window leading up to it.
    return { allowed: true, estimatedReadyAt: scheduled, waitMinutes };
  }

  /**
   * Load the `LocationHours` row for the given day-of-week. Index on
   * `(location_id, day_of_week)` makes this a single-row lookup.
   *
   * Renamed from `hoursForDate(when: Date)` — callers now pass the
   * day-of-week computed in the location's timezone, not a Date that
   * implicitly reads server tz.
   */
  private async hoursForDayOfWeek(
    locationId: string,
    dayOfWeek: number,
  ): Promise<LocationHours | null> {
    return this.hours.findOne({
      where: { location_id: locationId, day_of_week: dayOfWeek },
    });
  }

  /**
   * Walks forward up to 7 days (in the location's tz) looking for the next
   * open period. Returns the concrete UTC `Date` instant of the next open
   * time so iOS can display "We open at 7:00 AM" with the correct day
   * implied via its own tz-aware formatter.
   */
  private async findNextOpening(
    locationId: string,
    from: Date,
    tz: string,
  ): Promise<Date | undefined> {
    const todayDow = dayOfWeekInTz(from, tz);
    for (let offset = 0; offset < 7; offset++) {
      const dow = (todayDow + offset) % 7;
      const rec = await this.hoursForDayOfWeek(locationId, dow);
      if (!rec || rec.is_closed) continue;

      // Compute the UTC instant of the open-time on (today + offset) in tz.
      const dayAnchor = startOfDayPlusDaysInTz(from, offset, tz);
      const openAt = combineLocalDayAndTime(dayAnchor, rec.open_time, tz);
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
