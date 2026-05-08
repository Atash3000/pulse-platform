import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { PickupType } from '../../database/entities';
import { AvailabilityQueryDto } from './dto/availability-query.dto';
import { AvailabilityResult, HoursService } from './hours.service';
import {
  LocationsService,
  PublicLocationDetail,
  PublicLocationSummary,
} from './locations.service';

@ApiTags('locations')
@Controller('locations')
export class LocationsController {
  constructor(
    private readonly locations: LocationsService,
    private readonly hours: HoursService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List active locations',
    description: 'Public. Returns only active = true. Used by iOS on first launch to populate the location picker.',
  })
  @ApiResponse({ status: 200, description: 'Array of location summaries.' })
  list(): Promise<PublicLocationSummary[]> {
    return this.locations.listActive();
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Location detail with hours and settings',
    description: 'Public. Includes 7-day hours array and live settings (paused, wait minutes, scheduled-ordering toggle, max schedule days).',
  })
  @ApiParam({ name: 'id', description: 'Location UUID', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Location detail.' })
  @ApiResponse({ status: 400, description: 'id is not a valid UUID.' })
  @ApiResponse({ status: 404, description: 'Not found, or active = false.' })
  getOne(@Param('id', ParseUUIDPipe) id: string): Promise<PublicLocationDetail> {
    return this.locations.getById(id);
  }

  @Get(':id/availability')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check whether the location can accept an order right now',
    description:
      'Implements Part 5.5 of the spec exactly. Returns 200 with `{allowed: true|false}` plus a structured rejection reason. The same logic runs again inside POST /checkout — this endpoint is purely for UX.',
  })
  @ApiParam({ name: 'id', description: 'Location UUID', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Availability decision (allowed or rejected with reason).' })
  @ApiResponse({ status: 400, description: 'id not a UUID, pickupType invalid, or scheduledPickupAt not ISO 8601.' })
  @ApiResponse({ status: 404, description: 'Location not found.' })
  availability(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: AvailabilityQueryDto,
  ): Promise<AvailabilityResult> {
    return this.hours.canAcceptOrders(id, {
      pickupType: q.pickupType ?? PickupType.ASAP,
      scheduledTime: q.scheduledPickupAt ? new Date(q.scheduledPickupAt) : undefined,
    });
  }
}
