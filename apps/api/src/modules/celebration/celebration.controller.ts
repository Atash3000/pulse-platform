import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { StaffRole } from '../../database/entities';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { requireStaff } from '../admin/staff-context';
import { CelebrationService } from './celebration.service';
import { CelebrationStateDto } from './dto/celebration-state.dto';

/**
 * Staff-facing celebration state. Reuses the established `admin` auth surface
 * (global prefix api/v1 -> /api/v1/admin/...). Read-only and privacy-safe: it
 * returns a derived state, never the customer's date of birth (Golden Rule #16).
 */
@ApiTags('admin-celebration')
@ApiBearerAuth('jwt')
@Controller('admin')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class CelebrationController {
  constructor(private readonly celebration: CelebrationService) {}

  @Get('customers/:customerId/celebration-state')
  @HttpCode(HttpStatus.OK)
  @Roles(StaffRole.BARISTA, StaffRole.MANAGER, StaffRole.OWNER)
  @ApiOperation({
    summary: 'Birthday/celebration state for a customer (derived; never exposes DOB)',
  })
  @ApiParam({ name: 'customerId', format: 'uuid' })
  @ApiResponse({ status: 200, type: CelebrationStateDto })
  async getCelebrationState(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Req() req: Request,
  ): Promise<CelebrationStateDto> {
    // The store timezone comes from the staff member's own location. This also
    // re-asserts the staff boundary at the code level (throws 403 for non-staff).
    const staff = requireStaff(req);
    return this.celebration.getCelebrationState(customerId, staff.location_id);
  }
}
