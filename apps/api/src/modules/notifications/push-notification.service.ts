import {
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as apn from '@parse/node-apn';
import { Repository } from 'typeorm';

import { Customer } from '../../database/entities';
import { isPermanentApnsResponse } from './notification-error-classifier';

/**
 * Push-notification service (C8) — real APNs delivery + stub fallback.
 *
 * Dual-mode behaviour
 * -------------------
 * When ALL four `APNS_*` env vars are set AND the `.p8` key file is
 * readable, the constructor builds an `@parse/node-apn` Provider and
 * `send()` performs a real APNs request (in addition to the `[push]
 * {...}` log line). When ANY env var is empty or the Provider fails to
 * construct (missing file, malformed key), the service falls back to
 * stub-only mode: it logs `[push] {...}` on every send() with no APNs
 * request. This is the intentional graceful-degradation pattern for
 * local dev and pre-Apple-verification states.
 *
 * Log prefixes (C8 rename)
 * ------------------------
 *   [push]              — would-send / dispatch attempt (was [push-stub])
 *   [push-skip]         — customer has no push_token (unchanged from C2;
 *                          semantically distinct, operationally useful)
 *   [push] missing-customer — warn when customer row not found
 *                          (collision-avoidance discriminator)
 *   [push] provider-init-failed — boot-time fallback when Provider
 *                          constructor throws
 *   [push] permanent-send-error — APNs returned a permanent reason
 *   [push] dispatch-failed       — caught general APNs error before throw
 *
 * Bounded timeouts
 * ----------------
 * The Provider is constructed with `requestTimeout: 5000` so a stuck
 * APNs call cannot indefinitely hold the outbox worker's row lock. See
 * the C8 decision-log entry for the trade-off vs. the deferred
 * claim-then-process refactor.
 *
 * Security: do NOT log the push_token value
 * -----------------------------------------
 * APNs push tokens are device identifiers. The structured log line
 * carries `push_token_present` as a boolean only; the token value is
 * NEVER serialised. A regression test in the spec asserts this across
 * every log path.
 *
 * Permanent-error writeback deferral
 * ----------------------------------
 * APNs returning `BadDeviceToken` / `Unregistered` / status 410 means
 * the customer's stored push_token is dead. The clean fix is to write
 * `push_token = null` so future sends skip the dead token. C8 defers
 * this writeback as post-launch tech debt — the operational cost of
 * one wasted notification per uninstalled device is low. The C8
 * decision-log entry tracks this deferral.
 *
 * Wiring status — NOT YET CALLED IN PRODUCTION
 * --------------------------------------------
 * C1's NotificationsService handlers (handleOrderReady, etc.) log
 * their would-be push context inline; they do not yet inject this
 * service or call send(). A future turn wires `pushNotifications.send`
 * into the relevant handlers. C8 makes real APNs delivery work for any
 * future caller without code change — just env vars + restart.
 */
const FETCH_TIMEOUT_MS = 5_000;

@Injectable()
export class PushNotificationService implements OnModuleDestroy {
  private readonly logger = new Logger(PushNotificationService.name);
  private readonly provider: apn.Provider | null;
  private readonly stubOnly: boolean;
  private readonly bundleId: string | undefined;

  constructor(
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
    config: ConfigService,
  ) {
    const keyId = config.get<string>('APNS_KEY_ID') || '';
    const teamId = config.get<string>('APNS_TEAM_ID') || '';
    const bundleId = config.get<string>('APNS_BUNDLE_ID') || '';
    const privateKeyPath = config.get<string>('APNS_PRIVATE_KEY_PATH') || '';
    const useSandbox = config.get<string>('APNS_USE_SANDBOX') !== 'false';

    this.bundleId = bundleId || undefined;

    const allRequiredPresent =
      keyId.length > 0 &&
      teamId.length > 0 &&
      bundleId.length > 0 &&
      privateKeyPath.length > 0;

    if (!allRequiredPresent) {
      // Pre-verification / local-dev path. Stub-only mode is the
      // intentional fallback.
      this.provider = null;
      this.stubOnly = true;
      return;
    }

    // All env present — try to construct the Provider. The constructor
    // reads the .p8 file synchronously; if the file is missing or
    // malformed, it throws. We catch and fall back to stub-only rather
    // than crashing app boot, which would block the entire API.
    try {
      this.provider = new apn.Provider({
        token: {
          key: privateKeyPath,
          keyId,
          teamId,
        },
        production: !useSandbox,
        // Bounded latency — see class JSDoc. Default is 5000 but pinned
        // explicitly so a future library default change can't silently
        // raise the lock-hold ceiling.
        requestTimeout: FETCH_TIMEOUT_MS,
      });
      this.stubOnly = false;
    } catch (err) {
      this.logger.error(
        `[push] provider-init-failed: ${(err as Error).message} — falling back to stub-only mode`,
      );
      this.provider = null;
      this.stubOnly = true;
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Provider holds open HTTP/2 connections — close them so the Node
    // process can exit cleanly. Safe to call when provider is null.
    if (this.provider) {
      await this.provider.shutdown();
    }
  }

  /**
   * Send a push notification to a single customer. The validator/finder
   * split mirrors C1's NotificationsService:
   *
   *   - Empty customerId / title / body → THROW (programming error).
   *   - Customer row not found → WARN + return (best-effort, not retry-worthy).
   *   - Customer has no push_token → INFO [push-skip] + return.
   *   - Push token present:
   *       - stubOnly mode → log [push] dispatch attempt + return.
   *       - Provider configured → log + send via APNs. Classify failed[]
   *         via classifier helper; permanent reasons log+return,
   *         transient reasons throw (outbox retries).
   */
  async send(
    customerId: string,
    title: string,
    body: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    this.assertNonEmptyString(customerId, 'customerId');
    this.assertNonEmptyString(title, 'title');
    this.assertNonEmptyString(body, 'body');

    const customer = await this.customers.findOne({ where: { id: customerId } });
    if (!customer) {
      this.logger.warn(
        `[push] missing-customer: ${customerId} not found in DB — skipping push`,
      );
      return;
    }

    if (customer.push_token === null) {
      this.logger.log(
        `[push-skip] ${JSON.stringify({
          customer_id: customerId,
          push_token_present: false,
          reason: 'customer has no push token registered',
        })}`,
      );
      return;
    }

    // Token present — always log the dispatch attempt. The token VALUE
    // is never logged; only `push_token_present: true`.
    const logPayload = {
      customer_id: customerId,
      push_token_present: true,
      title,
      body,
      data: data ?? null,
    };
    this.logger.log(`[push] ${JSON.stringify(logPayload)}`);

    if (this.stubOnly || !this.provider || !this.bundleId) {
      // Stub-only fallback. The log line IS the entire delivery in
      // this mode.
      return;
    }

    // Real APNs send. The Provider handles HTTP/2 connection pooling
    // and JWT auto-refresh internally.
    const notification = new apn.Notification();
    notification.topic = this.bundleId;
    notification.alert = { title, body };
    if (data) notification.payload = data;
    notification.expiry = Math.floor(Date.now() / 1000) + 3600; // 1h relevancy

    let result: apn.Responses<apn.ResponseSent, apn.ResponseFailure>;
    try {
      result = await this.provider.send(notification, customer.push_token);
    } catch (err) {
      // Library-level error before APNs round-trip (e.g., HTTP/2 stream
      // failure, JWT signing failure). Throw transient — outbox retries.
      throw new Error(
        `[push] dispatch-failed: ${(err as Error).message}`,
      );
    }

    if (result.failed.length === 0) {
      return;
    }

    // Single-recipient send — there is at most one failed[] entry.
    const failure = result.failed[0]!;
    const reason = failure.response?.reason;
    const status = failure.status;
    if (isPermanentApnsResponse(reason, status)) {
      // Permanent — log warn and swallow. Writeback deferral noted in
      // class JSDoc.
      this.logger.warn(
        `[push] permanent-send-error: status=${status ?? '?'} reason=${reason ?? '(none)'} customer_id=${customerId}`,
      );
      return;
    }

    // Transient — throw so the outbox retries the event.
    throw new Error(
      `[push] transient send error: status=${status ?? '?'} reason=${reason ?? '(none)'}`,
    );
  }

  private assertNonEmptyString(value: unknown, fieldName: string): void {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `[push] required field '${fieldName}' must be a non-empty string (got: ${JSON.stringify(value)})`,
      );
    }
  }
}
