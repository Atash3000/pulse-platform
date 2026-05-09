import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { OutboxEvent } from '../../database/entities';
import {
  formatCents,
  formatCustomerName,
  formatItemList,
  formatOrderShortId,
} from './telegram-formatters';

/**
 * Telegram alert service — STUB until real Bot API delivery lands.
 *
 * Public surface (extended in C3):
 *
 *   - `alertDeadOutboxEvent` — DEAD outbox event, original method (C0).
 *     Logs at WARN with a multi-line plain-text body. Out of scope to
 *     migrate to the new hybrid format below; will be revisited when real
 *     Bot API delivery lands.
 *
 *   - Six event-driven alert methods (C3):
 *       newOrder                — Spec Part 9 "NEW ORDER" alert
 *       paymentFailed           — Spec Part 9 "PAYMENT FAILED" alert
 *       itemSoldOut             — Spec Part 9 "OAT MILK SOLD OUT" alert
 *       orderingPaused          — Spec Part 9 "MOBILE ORDERING PAUSED"
 *       orderCancelledByStaff   — Architectural extension beyond Part 9;
 *                                 covers C1's ORDER_CANCELLED outbox event.
 *       refundIssued            — Architectural extension beyond Part 9;
 *                                 covers C1's REFUND_CREATED outbox event.
 *
 *     Each new method takes a typed object literal of pre-formatted
 *     scalars (the caller is responsible for loading entities, calling
 *     the formatters in `telegram-formatters.ts`, and passing strings) —
 *     keeps `TelegramService` decoupled from TypeORM and easy to test.
 *
 *     Each method logs:
 *
 *         [telegram-stub] ${JSON.stringify({
 *           alert,    // discriminator: 'newOrder' | 'paymentFailed' | ...
 *           chat_id,  // resolved chat target ('owner' or null in dev)
 *           level,    // 'info' | 'warn' — matches the logger method used
 *           body,     // rendered Spec Part 9 message string
 *         })}
 *
 *     The hybrid format gives CloudWatch Logs Insights a structured
 *     payload to filter on AND preserves the rendered Spec Part 9 string
 *     as a `body` field for visual confirmation of message correctness.
 *     See decision-log entry "Telegram service extension: six alert
 *     methods for notification handlers" for the full rationale (the
 *     `alertDeadOutboxEvent` plain-text format is intentionally NOT
 *     migrated in C3).
 *
 *     Log levels:
 *       INFO (logger.log)  — newOrder, itemSoldOut, refundIssued
 *       WARN (logger.warn) — paymentFailed, orderingPaused,
 *                            orderCancelledByStaff
 *     Reasoning: WARN for operator-action signals (financial impact,
 *     manager-initiated cancellation, paused ordering); INFO for routine
 *     business alerts.
 *
 *     `chat_id` is the target Telegram chat. When `TELEGRAM_OWNER_CHAT_ID`
 *     is configured, this resolves to `'owner'` (we log a label rather
 *     than the raw chat ID — defense-in-depth, and the chat ID is
 *     non-credential so this is preference rather than necessity). When
 *     unconfigured (dev, tests), `chat_id` is `null` and the stub log
 *     itself is the entire alert delivery.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly botToken: string | undefined;
  private readonly ownerChatId: string | undefined;

  constructor(config: ConfigService) {
    this.botToken = config.get<string>('TELEGRAM_BOT_TOKEN') || undefined;
    this.ownerChatId = config.get<string>('TELEGRAM_OWNER_CHAT_ID') || undefined;
  }

  async alertDeadOutboxEvent(event: OutboxEvent, lastError: string): Promise<void> {
    const message = this.formatDeadEvent(event, lastError);

    if (!this.botToken || !this.ownerChatId) {
      // Local dev / staging without a bot configured — log loudly. Real
      // implementation will retain this fallback as the catch-all when
      // Telegram itself is unreachable.
      this.logger.warn(`[telegram-stub] would alert owner:\n${message}`);
      return;
    }

    // Real send will go here. Keeping the stub log so the message is visible
    // even in environments that have a token configured (until we trust
    // delivery).
    this.logger.warn(`[telegram-stub] alert (real send not yet implemented):\n${message}`);
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

  // ---------------------------------------------------------------------------
  // C3 alert methods — six event-driven Telegram alerts.
  //
  // Each method has the same shape:
  //   1. Compose the Spec Part 9 message body using the formatters.
  //   2. Build the structured stub payload.
  //   3. Log via `emitStub` (chooses logger.log / logger.warn by level).
  //
  // First-caller status (dead-code awareness for future engineers):
  //   newOrder                — first caller: C5 (handleOrderPaid wiring,
  //                              after the ORDER_PAID_NOTIFICATION split).
  //   itemSoldOut             — first caller: C4 (handleItemOutOfStock).
  //   orderCancelledByStaff   — first caller: C4 (handleOrderCancelled).
  //   refundIssued            — first caller: C4 (handleRefundCreated).
  //   paymentFailed           — NO CURRENT CALLER. Lands as dead code in
  //                              C3 because no outbox event exists for
  //                              payment failures yet (the
  //                              `markFailedFromWebhook` decision-log entry
  //                              explicitly defers this). When a future
  //                              turn adds a `PAYMENT_FAILED` outbox event
  //                              + handler, this method becomes reachable.
  //   orderingPaused          — NO CURRENT CALLER. No admin endpoint emits
  //                              an outbox event when ordering is paused
  //                              today. When a future turn adds the
  //                              pause/resume admin endpoint with an
  //                              outbox emit, this method becomes reachable.
  // ---------------------------------------------------------------------------

  /**
   * "NEW ORDER — Sarah M. — Oat Latte + Muffin — $10.00 — Main St"
   *
   * Logged at INFO level. First caller will be C5's
   * `handleOrderPaid` once the `ORDER_PAID_NOTIFICATION` split-event
   * lands (see decision-log "Notifications service: router pattern with
   * stubbed handlers" — Future C4 wiring subsection).
   */
  async newOrder(args: {
    orderId: string;
    customerName: string; // pre-formatted via formatCustomerName at call site
    items: ReadonlyArray<{ name: string; quantity: number }>;
    totalCents: number;
    locationName: string;
  }): Promise<void> {
    const body = `NEW ORDER — ${formatCustomerName(args.customerName)} — ${formatItemList(
      args.items,
    )} — ${formatCents(args.totalCents)} — ${args.locationName}`;
    this.emitStub('newOrder', 'info', body, { orderId: args.orderId });
  }

  /**
   * "PAYMENT FAILED — Order #abc12345 — $8.50 — Customer: Mike K."
   *
   * Logged at WARN — failed payments are operator-action signals. Dead
   * code in C3; first caller lands when a `PAYMENT_FAILED` outbox event
   * is added.
   */
  async paymentFailed(args: {
    orderId: string;
    totalCents: number;
    customerName: string;
  }): Promise<void> {
    const body = `PAYMENT FAILED — Order ${formatOrderShortId(args.orderId)} — ${formatCents(
      args.totalCents,
    )} — Customer: ${formatCustomerName(args.customerName)}`;
    this.emitStub('paymentFailed', 'warn', body, { orderId: args.orderId });
  }

  /**
   * "OAT MILK SOLD OUT — Auto-hidden from app — Main St"
   *
   * Item name is uppercased to match the Spec Part 9 example literal
   * ("OAT MILK"). The same item appears mixed-case in the `newOrder`
   * example ("Oat Latte"), so this is `itemSoldOut`-specific
   * banner-style formatting rather than a system-wide convention.
   *
   * Logged at INFO — sold-out alerts are routine inventory signals, not
   * operator-action emergencies.
   */
  async itemSoldOut(args: {
    itemId: string;
    itemName: string;
    locationName: string;
  }): Promise<void> {
    const body = `${args.itemName.toUpperCase()} SOLD OUT — Auto-hidden from app — ${args.locationName}`;
    this.emitStub('itemSoldOut', 'info', body, { itemId: args.itemId });
  }

  /**
   * "MOBILE ORDERING PAUSED — Main St — by: Manager Jane"
   *
   * Logged at WARN — paused ordering is operator-action-required (the
   * owner / regional manager probably wants to know one of their
   * locations is offline for new orders). Dead code in C3; first caller
   * lands when a pause/resume admin endpoint emits an outbox event.
   */
  async orderingPaused(args: {
    locationName: string;
    staffDisplayName: string; // e.g. "Manager Jane" — pre-composed at call site
  }): Promise<void> {
    const body = `MOBILE ORDERING PAUSED — ${args.locationName} — by: ${args.staffDisplayName}`;
    this.emitStub('orderingPaused', 'warn', body, { locationName: args.locationName });
  }

  /**
   * "ORDER CANCELLED — Order #abc12345 — $10.00 — Customer: Sarah M.
   *  — by: Manager Jane — Reason: spilled drink"
   *
   * Architectural extension beyond Part 9 — covers C1's
   * `ORDER_CANCELLED` outbox event when the cancellation comes from a
   * manager's `POST /admin/orders/:id/cancel` action. Logged at WARN
   * (manager-initiated cancellation of a paid order has financial impact;
   * the owner wants visibility).
   */
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
    this.emitStub('orderCancelledByStaff', 'warn', body, { orderId: args.orderId });
  }

  /**
   * "REFUND ISSUED — Order #abc12345 — $5.00 — Customer: Sarah M.
   *  — by: Manager Jane"
   *
   * Architectural extension beyond Part 9 — covers C1's `REFUND_CREATED`
   * outbox event. Logged at INFO for the routine commit case; the C1
   * handler's race-recorded variant (Phase 3 race) will continue to use
   * its own warn-level path with `actionRequired` set, separate from
   * this method.
   */
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
    this.emitStub('refundIssued', 'info', body, { orderId: args.orderId });
  }

  // ---------------------------------------------------------------------------
  // Stub emit — the single point that builds the JSON wrapper and chooses
  // the log level. Keeps the six methods one-liner-shaped.
  // ---------------------------------------------------------------------------

  private emitStub(
    alert: string,
    level: 'info' | 'warn',
    body: string,
    extra: Record<string, unknown>,
  ): void {
    // chat_id resolves to a label ('owner') when configured. We avoid
    // logging the raw chat ID — it's not a credential by itself, but
    // defense-in-depth. The label is enough to confirm targeting at
    // future-bot-wiring time.
    const chat_id = this.ownerChatId ? 'owner' : null;
    const payload = {
      alert,
      chat_id,
      level,
      body,
      ...extra,
    };
    const line = `[telegram-stub] ${JSON.stringify(payload)}`;
    if (level === 'warn') {
      this.logger.warn(line);
    } else {
      this.logger.log(line);
    }
  }
}
