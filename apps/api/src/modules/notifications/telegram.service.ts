import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { OutboxEvent } from '../../database/entities';
import { isPermanentTelegramStatus } from './notification-error-classifier';
import {
  formatCents,
  formatCustomerName,
  formatItemList,
  formatOrderShortId,
} from './telegram-formatters';

/**
 * Telegram alert service — real Bot API delivery (C8) with stub fallback.
 *
 * Dual-mode behaviour
 * -------------------
 * When BOTH `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_CHAT_ID` are set,
 * `sendOrLog` posts a real `sendMessage` to `api.telegram.org` AND emits
 * the `[telegram] {...}` structured log line. When either env var is
 * empty, the service skips the fetch entirely and only emits the log
 * line — the same shape the C3 stub had. This graceful degradation is
 * the intentional pattern for local dev and pre-credential states.
 *
 * Log prefix rename (C8): the six dispatch methods now emit
 * `[telegram] {...}` (was `[telegram-stub]`). The `alertDeadOutboxEvent`
 * legacy plain-text format intentionally KEEPS the `[telegram-stub]`
 * prefix per the C3 decision-log entry's stance on not migrating that
 * format. Both prefixes are correct for their respective contexts; the
 * asymmetry is documented at the method.
 *
 * Bounded timeouts
 * ----------------
 * Every fetch uses `AbortSignal.timeout(FETCH_TIMEOUT_MS)`. The outbox
 * worker's `processOne` is called inside a SKIP-LOCKED transaction; an
 * unbounded fetch would hold the row lock indefinitely and block the
 * worker's poll loop on this pod. 5 seconds is the agreed upper bound
 * — see the C8 decision-log entry "Real Telegram Bot API + APNs
 * delivery (C8)" for the trade-off vs. the deferred claim-then-process
 * refactor.
 *
 * Public surface
 * --------------
 *
 *   - `alertDeadOutboxEvent` — DEAD outbox event alert. Uses a low-level
 *     real send (when configured) plus a [telegram-stub] log line.
 *     Inner catch-all swallows any send error; the OUTER catch in
 *     `outbox.worker.processOne` already prevents the DEAD-event
 *     transaction from rolling back, so this inner catch is defense-
 *     in-depth — see the C8 decision-log entry.
 *
 *   - Six event-driven alert methods (C3, C8 wires them to real send):
 *       newOrder                — Spec Part 9 "NEW ORDER" alert
 *       paymentFailed           — Spec Part 9 "PAYMENT FAILED" alert
 *       itemSoldOut             — Spec Part 9 "OAT MILK SOLD OUT" alert
 *       orderingPaused          — Spec Part 9 "MOBILE ORDERING PAUSED"
 *       orderCancelledByStaff   — Architectural extension (ORDER_CANCELLED)
 *       refundIssued            — Architectural extension (REFUND_CREATED)
 *
 *     Each method:
 *       1. Composes a Spec Part 9 message body.
 *       2. Emits `[telegram] {...}` via `sendOrLog`.
 *       3. When configured, additionally POSTs to api.telegram.org and
 *          classifies any non-2xx response via the classifier. Permanent
 *          errors log+return; transient errors throw (outbox retries).
 *
 *     The structured payload preserves the rendered Part 9 string in
 *     `body` and adds an `alert` discriminator + log `level` + `chat_id`
 *     label.
 *
 * Why dispatch methods throw on transient but alertDeadOutboxEvent does not
 * ----------------------------------------------------------------------
 * Dispatch methods are called from `NotificationsService` handlers
 * inside the outbox worker; a thrown transient error lets the outbox
 * retry the event and eventually DEAD it. `alertDeadOutboxEvent` is
 * called FROM the DEAD transition itself — a throw there would cascade
 * (a failed DEAD alert would trigger another DEAD, etc.) The outbox
 * worker already catches that throw at the call site; the inner catch
 * here is belt-and-suspenders and makes the method independently
 * testable.
 */
const TELEGRAM_API_BASE = 'https://api.telegram.org';
const FETCH_TIMEOUT_MS = 5_000;
// Telegram's hard cap on sendMessage text is 4096. We truncate to 4000
// to leave room for the appended "... (truncated, ...)" suffix on the
// DEAD-event alert path.
const TELEGRAM_TEXT_SAFE_MAX = 4_000;

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly botToken: string | undefined;
  private readonly ownerChatId: string | undefined;

  constructor(config: ConfigService) {
    this.botToken = config.get<string>('TELEGRAM_BOT_TOKEN') || undefined;
    this.ownerChatId = config.get<string>('TELEGRAM_OWNER_CHAT_ID') || undefined;
  }

  // ---------------------------------------------------------------------------
  // alertDeadOutboxEvent — legacy plain-text format, [telegram-stub] prefix.
  //
  // Intentionally NOT migrated to the [telegram] {...} JSON format per the
  // C3 decision-log entry. The plain-text multi-line body is designed to
  // be human-readable directly in CloudWatch when an operator greps for
  // DEAD events. C8 adds the real send call but the log format and prefix
  // stay.
  //
  // Catch-all defense in depth: the OUTER catch in outbox.worker.processOne
  // (the call site) already prevents this method from rolling back the
  // DEAD transition. The inner catch here is so the method can be unit-
  // tested independently and so a direct caller (future admin tool, etc.)
  // gets safe semantics. See the C8 decision-log entry.
  // ---------------------------------------------------------------------------

  async alertDeadOutboxEvent(event: OutboxEvent, lastError: string): Promise<void> {
    const message = this.formatDeadEvent(event, lastError);

    if (!this.botToken || !this.ownerChatId) {
      // Stub-only path. Same shape as the pre-C8 stub.
      this.logger.warn(`[telegram-stub] would alert owner:\n${message}`);
      return;
    }

    // Real send + log. The log line uses the legacy [telegram-stub] prefix
    // intentionally (see method comment); a future "unify the prefix"
    // refactor is an explicit decision.
    this.logger.warn(`[telegram-stub] alert owner:\n${message}`);
    try {
      const safeText = this.truncateForTelegram(message);
      await this.sendToTelegram(this.botToken, this.ownerChatId, safeText);
    } catch (err) {
      // Critical marker: a DEAD-event alert failure is now findable only
      // via CloudWatch grep for this exact string. The trade-off (no
      // further Telegram cascade) is documented in the C8 decision-log
      // entry.
      this.logger.error(
        `[telegram] dead-event-alert-failed: ${(err as Error).message}`,
      );
    }
  }

  private formatDeadEvent(event: OutboxEvent, lastError: string): string {
    return [
      'DEAD OUTBOX EVENT — manual intervention required',
      `event_id:    ${event.id}`,
      `event_type:  ${event.event_type}`,
      `attempts:    ${event.attempts}`,
      `created_at:  ${event.created_at?.toISOString?.() ?? event.created_at}`,
      `last_error:  ${lastError}`,
      `payload:     ${JSON.stringify(event.payload)}`,
    ].join('\n');
  }

  private truncateForTelegram(text: string): string {
    if (text.length <= TELEGRAM_TEXT_SAFE_MAX) return text;
    return (
      text.slice(0, TELEGRAM_TEXT_SAFE_MAX) +
      '\n... (truncated, see CloudWatch [telegram] dead-event-alert-failed for full payload)'
    );
  }

  // ---------------------------------------------------------------------------
  // C3 alert methods — six event-driven Telegram alerts.
  //
  // C8 wires sendOrLog to also perform a real Bot API send when the bot
  // token + chat ID env vars are configured. The log line shape is
  // unchanged from C3 (the JSON payload is identical) — only the prefix
  // is renamed from [telegram-stub] to [telegram] to reflect that this is
  // a real dispatch attempt, not stub-only.
  //
  // First-caller status (unchanged from C3):
  //   newOrder                — wired via C5 (handleOrderPaidNotification)
  //   itemSoldOut             — wired via C4 (handleItemOutOfStock)
  //   orderCancelledByStaff   — wired via C4 (handleOrderCancelled)
  //   refundIssued            — wired via C4 (handleRefundCreated)
  //   paymentFailed           — NO LIVE CALLER. PAYMENT_FAILED outbox
  //                              event not yet added.
  //   orderingPaused          — NO LIVE CALLER. No pause/resume admin
  //                              endpoint yet.
  // ---------------------------------------------------------------------------

  async newOrder(args: {
    orderId: string;
    customerName: string;
    items: ReadonlyArray<{ name: string; quantity: number }>;
    totalCents: number;
    locationName: string;
  }): Promise<void> {
    const body = `NEW ORDER — ${formatCustomerName(args.customerName)} — ${formatItemList(
      args.items,
    )} — ${formatCents(args.totalCents)} — ${args.locationName}`;
    await this.sendOrLog('newOrder', 'info', body, { orderId: args.orderId });
  }

  async paymentFailed(args: {
    orderId: string;
    totalCents: number;
    customerName: string;
  }): Promise<void> {
    const body = `PAYMENT FAILED — Order ${formatOrderShortId(args.orderId)} — ${formatCents(
      args.totalCents,
    )} — Customer: ${formatCustomerName(args.customerName)}`;
    await this.sendOrLog('paymentFailed', 'warn', body, { orderId: args.orderId });
  }

  async itemSoldOut(args: {
    itemId: string;
    itemName: string;
    locationName: string;
  }): Promise<void> {
    const body = `${args.itemName.toUpperCase()} SOLD OUT — Auto-hidden from app — ${args.locationName}`;
    await this.sendOrLog('itemSoldOut', 'info', body, { itemId: args.itemId });
  }

  async orderingPaused(args: {
    locationName: string;
    staffDisplayName: string;
  }): Promise<void> {
    const body = `MOBILE ORDERING PAUSED — ${args.locationName} — by: ${args.staffDisplayName}`;
    await this.sendOrLog('orderingPaused', 'warn', body, { locationName: args.locationName });
  }

  async orderCancelledByStaff(args: {
    orderId: string;
    totalCents: number;
    customerName: string;
    staffDisplayName: string;
    reason: string;
  }): Promise<void> {
    const body =
      `ORDER CANCELLED — Order ${formatOrderShortId(args.orderId)} — ` +
      `${formatCents(args.totalCents)} — ` +
      `Customer: ${formatCustomerName(args.customerName)} — ` +
      `by: ${args.staffDisplayName} — Reason: ${args.reason}`;
    await this.sendOrLog('orderCancelledByStaff', 'warn', body, { orderId: args.orderId });
  }

  async refundIssued(args: {
    orderId: string;
    refundAmountCents: number;
    customerName: string;
    staffDisplayName: string;
  }): Promise<void> {
    const body =
      `REFUND ISSUED — Order ${formatOrderShortId(args.orderId)} — ` +
      `${formatCents(args.refundAmountCents)} — ` +
      `Customer: ${formatCustomerName(args.customerName)} — ` +
      `by: ${args.staffDisplayName}`;
    await this.sendOrLog('refundIssued', 'info', body, { orderId: args.orderId });
  }

  // ---------------------------------------------------------------------------
  // sendOrLog — dual-mode dispatch.
  //
  //   1. ALWAYS emit the [telegram] {...} structured log line. Operators
  //      need a CloudWatch record of every dispatch attempt regardless of
  //      whether the real send is configured.
  //
  //   2. When the bot is configured (TELEGRAM_BOT_TOKEN and
  //      TELEGRAM_OWNER_CHAT_ID both non-empty), POST to api.telegram.org.
  //      - 2xx response → success, return.
  //      - 4xx permanent (400, 401, 403, 404) → log warn, return.
  //      - 4xx transient (429) / 5xx / network error → THROW so the
  //        outbox retries the event.
  //
  //   3. When unconfigured, the log line is the entire dispatch. No fetch.
  //
  // Permanent errors are absorbed because retrying won't fix them; the
  // log line still shows what was attempted. Transient errors propagate
  // up through the handler to the outbox worker, which increments
  // attempts and eventually marks the row DEAD.
  // ---------------------------------------------------------------------------

  private async sendOrLog(
    alert: string,
    level: 'info' | 'warn',
    body: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const chat_id = this.ownerChatId ? 'owner' : null;
    const payload = {
      alert,
      chat_id,
      level,
      body,
      ...extra,
    };
    const line = `[telegram] ${JSON.stringify(payload)}`;
    if (level === 'warn') {
      this.logger.warn(line);
    } else {
      this.logger.log(line);
    }

    if (!this.botToken || !this.ownerChatId) {
      // Stub-only fallback. The log line above IS the entire delivery
      // in this mode. No fetch is performed.
      return;
    }

    await this.sendToTelegram(this.botToken, this.ownerChatId, body);
  }

  /**
   * Low-level Telegram Bot API send. Throws on transient errors so the
   * caller (the outbox via the handler) retries. Returns silently on 2xx
   * and on permanent 4xx errors (after a warn log).
   *
   * Uses AbortSignal.timeout for bounded latency — see class JSDoc.
   */
  private async sendToTelegram(
    botToken: string,
    chatId: string,
    text: string,
  ): Promise<void> {
    const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      // Network error, DNS failure, AbortError (timeout), etc. All
      // transient by default — throw so the outbox retries.
      throw new Error(
        `[telegram] network error sending to chat: ${(err as Error).message}`,
      );
    }

    if (response.ok) return;

    // Best-effort: read description for log enrichment. Some Telegram
    // error responses are JSON {ok:false, error_code, description}.
    let description: string | undefined;
    try {
      const parsed = (await response.json()) as { description?: unknown };
      if (typeof parsed?.description === 'string') {
        description = parsed.description;
      }
    } catch {
      // body wasn't JSON; ignore — status code alone classifies.
    }

    if (isPermanentTelegramStatus(response.status, description)) {
      // Permanent — log warn and swallow. Retrying won't help.
      this.logger.warn(
        `[telegram] permanent send error (status ${response.status}): ${
          description ?? '(no description)'
        }`,
      );
      return;
    }

    // Transient — throw so the outbox retries the event.
    throw new Error(
      `[telegram] transient send error (status ${response.status}): ${
        description ?? '(no description)'
      }`,
    );
  }
}
