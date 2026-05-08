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
import { Throttle } from '@nestjs/throttler';

import { MenuQueryDto } from './dto/menu-query.dto';
import { MenuService, PublicMenu, PublicMenuItem } from './menu.service';

@ApiTags('menu')
@Controller('menu')
// Spec Part 4.5: GET /menu — 60 / min per IP. Served from Redis so we can be
// generous; this is the customer-app's most-hit endpoint.
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class MenuController {
  constructor(private readonly menu: MenuService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Full menu for a location',
    description:
      'Public. Cached in Redis for 10 minutes per location. Includes categories, items, modifier groups, modifiers, and per-item availability composed from the inventory table.',
  })
  @ApiResponse({
    status: 200,
    description: 'Full menu tree. The cached_at field shows when this snapshot was assembled.',
  })
  @ApiResponse({ status: 400, description: 'locationId missing or not a UUID.' })
  @ApiResponse({ status: 404, description: 'Location not found or inactive.' })
  @ApiResponse({ status: 429, description: 'Too many requests (>60/min from this IP).' })
  getMenu(@Query() q: MenuQueryDto): Promise<PublicMenu> {
    return this.menu.getMenu(q.locationId);
  }

  @Get('items/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Single menu item with modifier groups',
    description:
      'Public. Cached in Redis for 10 minutes per item. Used by iOS for the item detail screen (modifier picker).',
  })
  @ApiParam({ name: 'id', description: 'Menu item UUID', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Item detail with modifier groups.' })
  @ApiResponse({ status: 400, description: 'id is not a valid UUID.' })
  @ApiResponse({ status: 404, description: 'Item not found or inactive.' })
  @ApiResponse({ status: 429, description: 'Too many requests (>60/min from this IP).' })
  getItem(@Param('id', ParseUUIDPipe) id: string): Promise<PublicMenuItem> {
    return this.menu.getItemById(id);
  }
}
