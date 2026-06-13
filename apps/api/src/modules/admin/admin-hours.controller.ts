import { Body, Controller, HttpCode, HttpStatus, Put, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { StaffRole } from '../../database/entities';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AdminHoursService } from './admin-hours.service';
import { SetHoursDto } from './dto/set-hours.dto';
import { requireStaff } from './staff-context';

@ApiTags('admin-hours')
@ApiBearerAuth('jwt')
@Controller('admin')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class AdminHoursController {
  constructor(private readonly hours: AdminHoursService) {}

  @Put('hours')
  @HttpCode(HttpStatus.OK)
  @Roles(StaffRole.MANAGER, StaffRole.OWNER)
  @ApiOperation({
    summary: 'Replace the weekly hours for the staff member\'s location',
    description:
      'Whole-week replace (idempotent). The public location payload\'s open/closing-soon/closed status is recomputed from these on the next fetch.',
  })
  @ApiResponse({ status: 200, description: 'Hours replaced; returns the new weekly schedule.' })
  @ApiResponse({ status: 400, description: 'Invalid schedule (missing/dup day, open >= close, bad time).' })
  @ApiResponse({ status: 403, description: 'Requires MANAGER or OWNER at a location.' })
  setHours(@Req() req: Request, @Body() dto: SetHoursDto) {
    return this.hours.setHours(requireStaff(req), dto);
  }
}
