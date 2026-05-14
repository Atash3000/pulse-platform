import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Customer } from '../../database/entities';
import { EXPECTED_PUSH_TOKEN_LENGTH } from './dto/update-push-token.dto';

/**
 * Customer service — owns customer-self-service operations from the iOS
 * app. Phase 1 surface is intentionally tiny: just push-token registration.
 * Future additions (profile updates, account deletion, etc.) land here
 * rather than at the auth controller, which owns credential operations
 * only.
 *
 * Security
 * --------
 * The push token is a privileged credential (anyone with the token AND
 * the bundle's APNs auth key can send arbitrary notifications to the
 * user's device). The service NEVER logs the token VALUE. The
 * `[customers]` log line carries a boolean `cleared` discriminator plus
 * the actor `customer_id`, which is enough for an operator to confirm
 * that a token update was processed without exposing the credential.
 *
 * The PushNotificationService's existing security regression test asserts
 * the same invariant on the OUTPUT side; this service enforces it on the
 * INPUT side.
 */
@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
  ) {}

  /**
   * Sets or clears a customer's APNs push token.
   *
   * Empty string → clear (NULL). Otherwise → must be exactly
   * EXPECTED_PUSH_TOKEN_LENGTH hex chars; defense-in-depth re-validation
   * here in case the DTO is bypassed (direct service call, future
   * non-HTTP entrypoint).
   *
   * Idempotency: submitting the same token twice produces the same DB
   * state — the second UPDATE is a no-op write. We don't short-circuit
   * (the cost is one row update, sub-ms) but we don't fail either.
   *
   * @throws BadRequestException if token shape is invalid (defense-in-
   *   depth — the DTO should have caught it first)
   * @throws NotFoundException if no customer row exists for customerId
   *   (shouldn't happen with a valid JWT, but defensive)
   */
  async updatePushToken(customerId: string, token: string): Promise<void> {
    const isClear = token.length === 0;
    if (!isClear) {
      // Defense in depth — DTO already validates this, but a future
      // direct caller (admin script, etc.) might bypass the DTO.
      if (token.length !== EXPECTED_PUSH_TOKEN_LENGTH || !/^[0-9a-fA-F]+$/.test(token)) {
        throw new BadRequestException({
          code: 'PUSH_TOKEN_INVALID',
          message: `token must be exactly ${EXPECTED_PUSH_TOKEN_LENGTH} hex chars or empty string`,
        });
      }
    }

    const result = await this.customers.update(
      { id: customerId },
      { push_token: isClear ? null : token },
    );
    if (!result.affected || result.affected === 0) {
      throw new NotFoundException({
        code: 'CUSTOMER_NOT_FOUND',
        message: 'No customer matches the authenticated subject',
      });
    }

    // Log without the token VALUE. `cleared: true` discriminates the
    // opt-out path; `cleared: false` confirms a token was set without
    // exposing it.
    this.logger.log(
      `[customers] push-token-updated ${JSON.stringify({
        customer_id: customerId,
        cleared: isClear,
      })}`,
    );
  }
}
