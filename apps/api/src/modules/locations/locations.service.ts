import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import {
  Location,
  LocationHours,
  LocationSettings,
} from '../../database/entities';
import { computeStoreStatus, StoreStatusResult } from './store-status';

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

export interface PublicLocationDetail extends PublicLocationSummary {
  hours: Array<{
    day_of_week: number;
    open_time: string;
    close_time: string;
    is_closed: boolean;
  }>;
  settings: {
    mobile_ordering_paused: boolean;
    current_wait_minutes: number;
    scheduled_ordering: boolean;
    max_schedule_days: number;
  };
}

@Injectable()
export class LocationsService {
  constructor(
    @InjectRepository(Location) private readonly locations: Repository<Location>,
    @InjectRepository(LocationHours) private readonly hours: Repository<LocationHours>,
    @InjectRepository(LocationSettings) private readonly settings: Repository<LocationSettings>,
  ) {}

  async listActive(): Promise<PublicLocationSummary[]> {
    const rows = await this.locations.find({
      where: { active: true },
      order: { name: 'ASC' },
    });

    // Batch the settings + hours lookups (no N+1): one query each for all
    // returned locations, then Map lookups per row. current_wait_minutes
    // defaults to 5 — same default getById uses — when a location has no
    // settings row. Store status is computed from the batched hours.
    const ids = rows.map((l) => l.id);
    const [settingsRows, hoursRows] = await Promise.all([
      ids.length ? this.settings.find({ where: { location_id: In(ids) } }) : Promise.resolve([]),
      ids.length ? this.hours.find({ where: { location_id: In(ids) } }) : Promise.resolve([]),
    ]);
    const waitByLocation = new Map(
      settingsRows.map((s) => [s.location_id, s.current_wait_minutes]),
    );
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
  }

  async getById(id: string): Promise<PublicLocationDetail> {
    const location = await this.locations.findOne({ where: { id } });
    if (!location || !location.active) {
      throw new NotFoundException(`Location ${id} not found`);
    }

    const [hours, settings] = await Promise.all([
      this.hours.find({
        where: { location_id: id },
        order: { day_of_week: 'ASC' },
      }),
      this.settings.findOne({ where: { location_id: id } }),
    ]);

    const currentWaitMinutes = settings?.current_wait_minutes ?? 5;
    const status = computeStoreStatus(hours, location.timezone, new Date());

    return {
      ...toSummary(location, currentWaitMinutes, status),
      hours: hours.map((h) => ({
        day_of_week: h.day_of_week,
        open_time: h.open_time,
        close_time: h.close_time,
        is_closed: h.is_closed,
      })),
      settings: {
        mobile_ordering_paused: settings?.mobile_ordering_paused ?? false,
        current_wait_minutes: currentWaitMinutes,
        scheduled_ordering: settings?.scheduled_ordering ?? true,
        max_schedule_days: settings?.max_schedule_days ?? 7,
      },
    };
  }
}

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
