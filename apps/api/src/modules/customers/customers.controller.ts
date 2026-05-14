import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import type { JwtPayload } from '../auth/jwt-payload';
import { CustomersService } from './customers.service';
import { UpdatePushTokenDto } from './dto/update-push-token.dto';

interface AuthedRequest extends Request {
  user?: JwtPayload;
}

/**
 * Customer self-service endpoints (iOS-facing). Phase 1 surface:
 * just push-token registration.
 *
 * All routes require a CUSTOMER JWT (`type: 'customer'`). Staff JWTs
 * are rejected with 403 — staff have their own surfaces under /admin.
 */
@ApiTags('customers')
@ApiBearerAuth('jwt')
@Controller('customers')
@UseGuards(AuthGuard('jwt'))
// Push-token updates from a single device are infrequent (registration
// + on-token-rotation). 30/min is more than enough headroom and well
// below abuse thresholds.
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  // ---------------------------------------------------------------------------
  // PUT semantics: replace the customer's push token wholesale. The body
  // carries the new full token (or empty string to clear). PATCH would
  // also be defensible but PUT matches the "replace" semantics — there's
  // no partial-update concept for a single scalar field.
  //
  // iOS calls this on:
  //   - App launch after APNs registration completes (token may have
  //     rotated since last launch)
  //   - On user-initiated opt-out (sends empty string)
  // ---------------------------------------------------------------------------

  @Put('me/push-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Register or clear the authenticated customer’s APNs push token',
    description:
      'Submit the 64-char hex APNs device token to enable push, or submit an empty string to opt out. Idempotent — submitting the same token twice is fine. PUT semantics: the request body replaces whatever token (if any) was previously stored.',
  })
  @ApiBody({ type: UpdatePushTokenDto })
  @ApiResponse({
    status: 200,
    description: 'Token persisted (or cleared if empty string was submitted).',
    schema: { example: { success: true } },
  })
  @ApiResponse({
    status: 400,
    description:
      'PUSH_TOKEN_INVALID — token is not exactly 64 hex chars and is not the empty string.',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid customer JWT.' })
  @ApiResponse({ status: 403, description: 'Token belongs to a staff user, not a customer.' })
  async updatePushToken(
    @Req() req: AuthedRequest,
    @Body() dto: UpdatePushTokenDto,
  ): Promise<{ success: true }> {
    const customerId = this.requireCustomer(req);
    await this.customers.updatePushToken(customerId, dto.token);
    return { success: true };
  }

  private requireCustomer(req: AuthedRequest): string {
    const user = req.user;
    if (!user || user.type !== 'customer' || !user.sub) {
      throw new ForbiddenException('Customer credentials required');
    }
    return user.sub;
  }
}
