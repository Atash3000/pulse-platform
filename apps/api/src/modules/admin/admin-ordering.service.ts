import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LocationSettings } from '../../database/entities';
import { StaffContext } from './staff-context';

@Injectable()
export class AdminOrderingService {
  private readonly logger = new Logger(AdminOrderingService.name);

  constructor(
    @InjectRepository(LocationSettings)
    private readonly settings: Repository<LocationSettings>,
  ) {}

  async pause(staff: StaffContext): Promise<LocationSettings> {
    return this.setPaused(staff, true);
  }

  async resume(staff: StaffContext): Promise<LocationSettings> {
    return this.setPaused(staff, false);
  }

  async setWaitTime(staff: StaffContext, minutes: number): Promise<LocationSettings> {
    const row = await this.requireSettings(staff.location_id);
    row.current_wait_minutes = minutes;
    const saved = await this.settings.save(row);
    this.logger.log(
      `wait time at ${staff.location_id} set to ${minutes}min by staff=${staff.staff_user_id}`,
    );
    return saved;
  }

  private async setPaused(staff: StaffContext, paused: boolean): Promise<LocationSettings> {
    const row = await this.requireSettings(staff.location_id);
    row.mobile_ordering_paused = paused;
    const saved = await this.settings.save(row);
    this.logger.log(
      `mobile ordering ${paused ? 'PAUSED' : 'RESUMED'} at ${staff.location_id} by staff=${staff.staff_user_id}`,
    );
    return saved;
  }

  private async requireSettings(locationId: string): Promise<LocationSettings> {
    const row = await this.settings.findOne({ where: { location_id: locationId } });
    if (!row) {
      // Should never happen — every location has a settings row from seed.
      throw new NotFoundException(`No settings row for location ${locationId}`);
    }
    return row;
  }
}
