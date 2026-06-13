import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LocationHours } from '../../database/entities';
import { SetHoursDto } from './dto/set-hours.dto';
import { StaffContext } from './staff-context';

@Injectable()
export class AdminHoursService {
  private readonly logger = new Logger(AdminHoursService.name);

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async setHours(staff: StaffContext, dto: SetHoursDto): Promise<LocationHours[]> {
    this.validate(dto);
    return this.ds.transaction(async (em) => {
      await em.delete(LocationHours, { location_id: staff.location_id });
      const rows = dto.hours.map((h) => ({
        location_id: staff.location_id,
        day_of_week: h.day_of_week,
        // Persist as HH:MM:SS to match the Postgres `time` column convention.
        open_time: `${h.open_time}:00`,
        close_time: `${h.close_time}:00`,
        is_closed: h.is_closed,
      }));
      await em.insert(LocationHours, rows);
      this.logger.log(`hours replaced at ${staff.location_id} by staff=${staff.staff_user_id}`);
      return em.find(LocationHours, {
        where: { location_id: staff.location_id },
        order: { day_of_week: 'ASC' },
      });
    });
  }

  /** Structural checks class-validator can't express per-field. */
  private validate(dto: SetHoursDto): void {
    const days = dto.hours.map((h) => h.day_of_week);
    const unique = new Set(days);
    if (unique.size !== 7 || [0, 1, 2, 3, 4, 5, 6].some((d) => !unique.has(d))) {
      throw new BadRequestException('hours must cover each day_of_week 0–6 exactly once');
    }
    for (const h of dto.hours) {
      if (!h.is_closed && h.open_time >= h.close_time) {
        throw new BadRequestException(
          `day ${h.day_of_week}: open_time must be earlier than close_time`,
        );
      }
    }
  }
}
