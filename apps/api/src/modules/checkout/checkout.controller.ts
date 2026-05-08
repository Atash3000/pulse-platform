import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import type { JwtPayload } from '../auth/jwt-payload';
import { CheckoutService, CheckoutResponse } from './checkout.service';
import { CheckoutRequestDto } from './dto/checkout-request.dto';

interface AuthedRequest extends Request {
  user?: JwtPayload;
}

@ApiTags('checkout')
@ApiBearerAuth('jwt')
@Controller('checkout')
@UseGuards(AuthGuard('jwt'))
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  // Spec Part 4.5: 3 requests / minute / user. The throttler keys by IP by
  // default, but we override the tracker via TTL key inside the limiter
  // configuration if/when we add a per-user tracker. For Phase 1 the IP
  // limit is acceptable — combined with per-user idempotency it's tight.
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Create order + Stripe PaymentIntent',
    description:
      'Customer JWT required. Implements spec section 5.2: idempotency check → location validation → item validation → pricing → atomic transaction (re-check inventory, insert order + items, create PaymentIntent, persist) → return clientSecret.',
  })
  @ApiResponse({
    status: 200,
    description: 'Order created (or safe replay of an already-paid order). Returns clientSecret for Stripe SDK.',
  })
  @ApiResponse({ status: 400, description: 'Validation failed, location closed, item unavailable, or invalid tip percent.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid customer JWT.' })
  @ApiResponse({ status: 409, description: 'Idempotency replay: in-flight payment, or key reused across customers.' })
  @ApiResponse({ status: 429, description: 'Too many requests (>3/min from this IP).' })
  async create(
    @Req() req: AuthedRequest,
    @Body() dto: CheckoutRequestDto,
  ): Promise<CheckoutResponse> {
    const user = req.user;
    if (!user || user.type !== 'customer' || !user.sub) {
      // Staff JWTs are valid tokens but they have no customer identity.
      throw new ForbiddenException('Customer credentials required');
    }
    return this.checkout.checkout(user.sub, dto);
  }
}
