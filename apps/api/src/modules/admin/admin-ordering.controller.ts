import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { StaffRole } from '../../database/entities';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { WaitTimeDto } from './dto/wait-time.dto';
import { AdminOrderingService } from './admin-ordering.service';
import { requireStaff } from './staff-context';

@ApiTags('admin-ordering')
@ApiBearerAuth('jwt')
@Controller('admin')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class AdminOrderingController {
  constructor(private readonly ordering: AdminOrderingService) {}

  @Post('ordering/pause')
  @HttpCode(HttpStatus.OK)
  @Roles(StaffRole.MANAGER, StaffRole.OWNER)
  @ApiOperation({
    summary: 'Pause mobile ordering at this location',
    description:
      'canAcceptOrders() will reject all subsequent ASAP and SCHEDULED orders with reason MOBILE_ORDERING_PAUSED until resume is called. Existing orders are unaffected.',
  })
  @ApiResponse({ status: 200, description: 'Mobile ordering paused.' })
  pause(@Req() req: Request) {
    const staff = requireStaff(req);
    return this.ordering.pause(staff);
  }

  @Post('ordering/resume')
  @HttpCode(HttpStatus.OK)
  @Roles(StaffRole.MANAGER, StaffRole.OWNER)
  @ApiOperation({ summary: 'Resume mobile ordering at this location.' })
  @ApiResponse({ status: 200, description: 'Mobile ordering resumed.' })
  resume(@Req() req: Request) {
    const staff = requireStaff(req);
    return this.ordering.resume(staff);
  }

  @Put('wait-time')
  @HttpCode(HttpStatus.OK)
  @Roles(StaffRole.BARISTA, StaffRole.MANAGER, StaffRole.OWNER)
  @ApiOperation({
    summary: 'Update current wait minutes for new ASAP orders',
    description:
      'Affects estimated_ready_at calculated when staff accept the next order. Does not retroactively change existing orders.',
  })
  @ApiResponse({ status: 200, description: 'Wait time updated.' })
  @ApiResponse({ status: 400, description: 'current_wait_minutes outside [1, 120].' })
  setWait(@Req() req: Request, @Body() dto: WaitTimeDto) {
    const staff = requireStaff(req);
    return this.ordering.setWaitTime(staff, dto.current_wait_minutes);
  }
}
