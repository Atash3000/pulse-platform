import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import type { JwtPayload } from '../auth/jwt-payload';
import { ThrottleByCustomer } from '../../common/throttle/throttle-by-customer.decorator';
import { HomeSummaryQueryDto } from './dto/home-summary-query.dto';
import { HomeService } from './home.service';
import { HomeSummaryResponse } from './home.types';

interface AuthedRequest extends Request {
  user?: JwtPayload;
}

@ApiTags('home')
@ApiBearerAuth('jwt')
@Controller('home')
@UseGuards(AuthGuard('jwt'))
// 60/min — fetched on every Home appearance. @ThrottleByCustomer() keys the
// bucket by authenticated customer id (decoded from the Authorization header
// by CustomerAwareThrottlerGuard) instead of IP, so customers behind one
// NAT / Render proxy hop don't share one bucket.
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@ThrottleByCustomer()
export class HomeController {
  constructor(private readonly home: HomeService) {}

  @Get('summary')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Home reorder summary — most-frequent ("usual") + recent configs',
    description:
      'Returns reorder signatures only (menu item + modifier IDs + quantity + a non-authoritative baseline price). iOS renders names/prices from the cached menu; the server recomputes the real price at checkout. Optional locationId query param scopes the summary to one location.',
  })
  @ApiResponse({ status: 200, description: 'Reorder summary.' })
  @ApiResponse({ status: 400, description: 'locationId present but not a UUID.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid customer JWT.' })
  @ApiResponse({ status: 403, description: 'Token belongs to a staff user, not a customer.' })
  async summary(
    @Req() req: AuthedRequest,
    @Query() q: HomeSummaryQueryDto,
  ): Promise<HomeSummaryResponse> {
    return this.home.getHomeSummary(this.requireCustomer(req), q?.locationId);
  }

  private requireCustomer(req: AuthedRequest): string {
    const user = req.user;
    if (!user || user.type !== 'customer' || !user.sub) {
      throw new ForbiddenException('Customer credentials required');
    }
    return user.sub;
  }
}
