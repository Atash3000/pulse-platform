import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Customer } from '../../database/entities';

/**
 * Push-notification stub for the iOS APNs path (C2).
 *
 * What this is
 * ------------
 * The interface that the NotificationsService handlers will eventually call
 * to deliver customer-facing iOS push notifications ("your coffee is ready",
 * "your order was cancelled", etc.). C2 lands the service shape, the
 * customer-and-token lookup, and a structured stub log; real APNs delivery
 * is a Phase 2 Week 5 deliverable.
 *
 * Why a stub now
 * --------------
 * C1's notification handlers log the would-be push payload but don't yet
 * call anything; C2 introduces the service those handlers will eventually
 * inject and call. Keeping the stub-log shape rich (every field a real APNs
 * payload would carry) means when the real send() implementation lands, we
 * can verify in CloudWatch that the right data is being passed through
 * without re-checking every emit site.
 *
 * Wiring status
 * -------------
 * NOT YET CALLED IN PRODUCTION. The C1 NotificationsService handlers
 * (handleOrderReady, handleOrderPickedUp, etc.) currently log their would-be
 * push context inline and do not yet inject this service. A later turn
 * (after C3 — Telegram extension — lands) wires send() into those
 * handlers. Until then, this service is exercised only by its own unit
 * tests.
 *
 * Security: do NOT log the push_token itself
 * ------------------------------------------
 * APNs push tokens are device identifiers. Anyone who has both a token AND
 * the bundle's APNs auth key can send arbitrary notifications to the user's
 * device — that's a privilege-escalation vector for anyone with read access
 * to CloudWatch logs. The stub log carries `push_token_present` as a boolean
 * (true / false) so an operator can see whether a customer has push enabled,
 * without ever serialising the token value.
 *
 * Future engineers MUST NOT "improve" the logging by adding the token value,
 * even temporarily for debugging — use a debugger or a one-off script that
 * doesn't write to persistent logs instead. See the decision-log entry
 * "Push-notification service: APNs stub for deferred C-series wiring".
 *
 * The warn-not-throw asymmetry
 * ----------------------------
 * Mirrors `NotificationsService` (C1):
 *
 *   - Malformed input (empty / non-string customerId / title / body) THROWS.
 *     The caller is buggy; the caller's caller — typically the outbox — gets
 *     a DEAD event with a clear last_error so the operator can fix the
 *     emitter.
 *   - Customer row missing → WARN-AND-RETURN. Pushes are best-effort; if
 *     the customer was deleted, retrying won't bring them back, and a DEAD
 *     event for "couldn't push to a deleted customer" isn't actionable.
 *   - Customer found but no push_token → INFO-LEVEL SKIP. Most customers
 *     don't have push enabled; this is the common path, not an error.
 *   - Other DB errors (connection drops, query failures) PROPAGATE so the
 *     outbox retries. Do NOT wrap the body in try/catch.
 *
 * See decision-log entry "Notifications service: router pattern with
 * stubbed handlers" — warn-not-throw subsection — for the full reasoning.
 */
@Injectable()
export class PushNotificationService {
  private readonly logger = new Logger(PushNotificationService.name);

  constructor(
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
  ) {}

  /**
   * Send (stub) a push notification to a single customer.
   *
   * @param customerId — UUID of the recipient. Must be a non-empty string.
   * @param title      — Notification title (shown bold on iOS lockscreen).
   *                     Must be a non-empty string.
   * @param body       — Notification body. Must be a non-empty string.
   * @param data       — Optional opaque payload forwarded to the iOS app via
   *                     APNs `data` field. iOS reads this on tap to deep-link
   *                     into the right view (e.g., the order detail screen).
   */
  async send(
    customerId: string,
    title: string,
    body: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    // Validator/finder split — exact mirror of NotificationsService's
    // extractOrderId + findOne pattern. Validation throws (programming
    // error); row-not-found warns (best-effort).
    this.assertNonEmptyString(customerId, 'customerId');
    this.assertNonEmptyString(title, 'title');
    this.assertNonEmptyString(body, 'body');

    const customer = await this.customers.findOne({ where: { id: customerId } });
    if (!customer) {
      // Row missing — warn and return. Other exceptions from findOne (DB
      // connection drops, etc.) propagate naturally; we catch ONLY the
      // explicit not-found case.
      this.logger.warn(
        `[push] customer ${customerId} not found in DB — skipping push`,
      );
      return;
    }

    if (customer.push_token === null) {
      // Common path: customer hasn't enabled push on iOS or has signed out.
      // Log at INFO level (logger.log) — this is normal, not an error.
      this.logger.log(
        `[push-skip] ${JSON.stringify({
          customer_id: customerId,
          push_token_present: false,
          reason: 'customer has no push token registered',
        })}`,
      );
      return;
    }

    // Push token IS present. Stub-log the would-be APNs payload. The token
    // value itself is NEVER logged — see the class-level security rationale
    // and the decision-log entry. We surface only `push_token_present: true`
    // so an operator can confirm the customer has push enabled without
    // exposing the credential.
    this.logger.log(
      `[push-stub] ${JSON.stringify({
        customer_id: customerId,
        push_token_present: true,
        title,
        body,
        data: data ?? null,
      })}`,
    );
  }

  /**
   * Validates a string field is present and non-empty. Throws on failure
   * with a clear message naming the field. Mirrors the
   * extractOrderId / extractItemId pattern in NotificationsService.
   */
  private assertNonEmptyString(value: unknown, fieldName: string): void {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `[push] required field '${fieldName}' must be a non-empty string (got: ${JSON.stringify(value)})`,
      );
    }
  }
}
