import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import type { JwtPayload } from '../auth/jwt-payload';
import { HomeService } from './home.service';
import { HomeSummaryResponse } from './home.types';

interface AuthedRequest extends Request {
  user?: JwtPayload;
}

@ApiTags('home')
@ApiBearerAuth('jwt')
@Controller('home')
@UseGuards(AuthGuard('jwt'))
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class HomeController {
  constructor(private readonly home: HomeService) {}

  @Get('summary')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Home reorder summary — most-frequent ("usual") + recent configs',
    description:
      'Returns reorder signatures only (menu item + modifier IDs + quantity + a non-authoritative baseline price). iOS renders names/prices from the cached menu; the server recomputes the real price at checkout.',
  })
  @ApiResponse({ status: 200, description: 'Reorder summary.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid customer JWT.' })
  @ApiResponse({ status: 403, description: 'Token belongs to a staff user, not a customer.' })
  async summary(@Req() req: AuthedRequest): Promise<HomeSummaryResponse> {
    return this.home.getHomeSummary(this.requireCustomer(req));
  }

  private requireCustomer(req: AuthedRequest): string {
    const user = req.user;
    if (!user || user.type !== 'customer' || !user.sub) {
      throw new ForbiddenException('Customer credentials required');
    }
    return user.sub;
  }
}
