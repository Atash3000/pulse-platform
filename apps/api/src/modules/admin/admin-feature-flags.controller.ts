import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { StaffRole } from '../../database/entities';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AdminFeatureFlagsService } from './admin-feature-flags.service';
import { FeatureFlagToggleDto } from './dto/feature-flag-toggle.dto';
import { requireStaff } from './staff-context';

@ApiTags('admin-feature-flags')
@ApiBearerAuth('jwt')
@Controller('admin/feature-flags')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class AdminFeatureFlagsController {
  constructor(private readonly flags: AdminFeatureFlagsService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @Roles(StaffRole.OWNER)
  @ApiOperation({ summary: 'List all feature flags (OWNER only).' })
  @ApiResponse({ status: 200, description: 'Array of feature flag rows.' })
  list() {
    return this.flags.list();
  }

  @Put(':key')
  @HttpCode(HttpStatus.OK)
  @Roles(StaffRole.OWNER)
  @ApiOperation({ summary: 'Toggle a feature flag on or off (OWNER only).' })
  @ApiParam({ name: 'key', description: 'feature_flags.key (string PK)' })
  @ApiResponse({ status: 200, description: 'Updated feature flag row.' })
  @ApiResponse({ status: 404, description: 'No flag with that key.' })
  toggle(
    @Req() req: Request,
    @Param('key') key: string,
    @Body() dto: FeatureFlagToggleDto,
  ) {
    const staff = requireStaff(req);
    return this.flags.toggle(key, dto.enabled, staff.staff_user_id);
  }
}
