import { Controller, Get, HttpCode, HttpStatus, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { StaffRole } from '../../database/entities';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AdminDashboardService, OwnerDashboardSummary } from './admin-dashboard.service';
import { requireStaff } from './staff-context';

@ApiTags('admin-dashboard')
@ApiBearerAuth('jwt')
@Controller('admin')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class AdminDashboardController {
  constructor(private readonly dashboard: AdminDashboardService) {}

  @Get('dashboard')
  @HttpCode(HttpStatus.OK)
  @Roles(StaffRole.OWNER)
  @ApiOperation({
    summary: 'Today\'s operational summary (OWNER only)',
    description:
      'Order count, revenue, AOV, top 3 menu items, new customers. "Today" is midnight-to-now in the location\'s timezone.',
  })
  @ApiResponse({ status: 200, description: 'Owner dashboard summary.' })
  @ApiResponse({ status: 403, description: 'Caller is not an OWNER.' })
  summary(@Req() req: Request): Promise<OwnerDashboardSummary> {
    const staff = requireStaff(req);
    return this.dashboard.getSummary(staff);
  }
}
