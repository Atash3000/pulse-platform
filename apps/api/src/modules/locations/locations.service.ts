import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  Location,
  LocationHours,
  LocationSettings,
} from '../../database/entities';

export interface PublicLocationSummary {
  id: string;
  name: string;
  address: string;
  phone: string | null;
  timezone: string;
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
    return rows.map(toSummary);
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

    return {
      ...toSummary(location),
      hours: hours.map((h) => ({
        day_of_week: h.day_of_week,
        open_time: h.open_time,
        close_time: h.close_time,
        is_closed: h.is_closed,
      })),
      settings: {
        mobile_ordering_paused: settings?.mobile_ordering_paused ?? false,
        current_wait_minutes: settings?.current_wait_minutes ?? 5,
        scheduled_ordering: settings?.scheduled_ordering ?? true,
        max_schedule_days: settings?.max_schedule_days ?? 7,
      },
    };
  }
}

function toSummary(l: Location): PublicLocationSummary {
  return {
    id: l.id,
    name: l.name,
    address: l.address,
    phone: l.phone,
    timezone: l.timezone,
  };
}
