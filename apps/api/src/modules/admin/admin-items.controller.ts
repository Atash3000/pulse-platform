import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
import { AdminItemsService } from './admin-items.service';
import { requireStaff } from './staff-context';

@ApiTags('admin-items')
@ApiBearerAuth('jwt')
@Controller('admin/items')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class AdminItemsController {
  constructor(private readonly items: AdminItemsService) {}

  @Post(':id/sold-out')
  @HttpCode(HttpStatus.OK)
  @Roles(StaffRole.BARISTA, StaffRole.MANAGER, StaffRole.OWNER)
  @ApiOperation({
    summary: 'Toggle item sold-out at the staff member\'s location',
    description:
      'Sets inventory.available=false, updates sold_out_at + updated_by. Invalidates the menu cache so customers see the change within seconds. Inserts an ITEM_OUT_OF_STOCK outbox event.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'menu_items.id' })
  @ApiResponse({ status: 200, description: 'Inventory row updated.' })
  @ApiResponse({ status: 404, description: 'Item does not belong to this location.' })
  soldOut(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    const staff = requireStaff(req);
    return this.items.markSoldOut(staff, id);
  }

  @Post(':id/available')
  @HttpCode(HttpStatus.OK)
  @Roles(StaffRole.BARISTA, StaffRole.MANAGER, StaffRole.OWNER)
  @ApiOperation({
    summary: 'Restore item availability at the staff member\'s location',
    description: 'Inverse of /sold-out. Clears sold_out_at and invalidates the menu cache.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'menu_items.id' })
  @ApiResponse({ status: 200, description: 'Inventory row updated.' })
  @ApiResponse({ status: 404, description: 'Item does not belong to this location.' })
  available(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    const staff = requireStaff(req);
    return this.items.markAvailable(staff, id);
  }
}
