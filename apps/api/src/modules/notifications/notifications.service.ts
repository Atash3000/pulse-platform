import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Customer, MenuItem, Order, OutboxEventType } from '../../database/entities';

/**
 * Notifications router with stubbed handlers (C1).
 *
 * What this owns
 * --------------
 * Centralised dispatch from outbox event type → side-effect handler. The
 * outbox worker (apps/api/src/workers/outbox.worker.ts) currently routes
 * five of the six event types through a no-op WARN log; in C4 those five
 * cases collapse to a single `await this.notifications.dispatch(...)` call,
 * and ORDER_PAID gets a fan-out via a split-event design (see decision-log
 * entry "Notifications service: router pattern with stubbed handlers" for
 * the C4 wiring plan).
 *
 * What this does NOT own (yet)
 * ----------------------------
 * Real Telegram or APNs delivery. Every handler in C1 logs what it WOULD
 * send via a structured info-level log (or warn-level when the payload
 * carries `actionRequired` — see Concern C in the decision-log entry). C2
 * adds the iOS APNs stub (`PushNotificationService`); C3 extends
 * `TelegramService` with the staff/owner/customer-facing send methods and
 * wires both services into these handlers. C1 is intentionally a router
 * stub so it can land independently and be exercised by tests with no
 * external dependencies.
 *
 * Handler API surface
 * -------------------
 * The `handleX` methods are public for testability and called via
 * `dispatch()`. Production code paths must always go through `dispatch()` —
 * calling handlers directly skips the routing layer and any future
 * cross-cutting concerns (telemetry, fan-out, dedup) added there.
 *
 * The warn-not-throw asymmetry
 * ----------------------------
 * Notification handlers warn-and-return ONLY on the explicit row-not-found
 * condition (`findOne` returned null). Any other exception during DB access
 * — connection drops, query failures, type errors — propagates so the
 * outbox retries the event and eventually marks it DEAD if the failure is
 * persistent. Do NOT wrap handler bodies in `try/catch`; that pattern would
 * swallow real DB errors and silently lose notifications.
 *
 * The asymmetry vs `orderWorker.handleOrderPaid` (which throws on missing
 * order so the outbox retries toward DEAD) is intentional: notifications
 * are best-effort, retrying won't bring back a deleted order, and
 * DEAD-eventing a notification isn't actionable for the manager. See the
 * decision-log entry for the full reasoning.
 *
 * Malformed payloads (missing required fields like `orderId` / `itemId`)
 * still THROW — those are programming errors at the emitter, not transient
 * runtime conditions. The throw surfaces them to the outbox as DEAD with a
 * clear `last_error` so the operator can fix the emitter.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
    @InjectRepository(MenuItem) private readonly menuItems: Repository<MenuItem>,
  ) {}

  // ---------------------------------------------------------------------------
  // Router — single entry point. Add new event types here, not at call sites.
  //
  // Exhaustiveness: the `default` branch's `const _exhaustive: never =
  // eventType` line is a COMPILE-TIME check that every `OutboxEventType` enum
  // value has an explicit `case` above. If a future engineer adds a seventh
  // enum value (e.g., `ORDER_REFUNDED_VIA_DISPUTE` for Phase 2) to
  // `entities.ts` and forgets to add a corresponding case here, the build
  // FAILS with "Type 'X' is not assignable to type 'never'." That's the
  // signal to wire the new event type.
  //
  // The runtime warn-and-return is preserved as defence-in-depth for the
  // case where a malformed payload at runtime carries a string that isn't
  // even in the enum (e.g., a corrupted DB row, or an outbox row written
  // before the enum was renamed). C4 will replace this with `throw new
  // Error(...)` when wiring outbox.worker → notifications.dispatch — at
  // that point, an unknown runtime value should fail loudly toward DEAD,
  // not silently log-and-mark-PROCESSED.
  // ---------------------------------------------------------------------------

  async dispatch(
    eventType: OutboxEventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    switch (eventType) {
      case OutboxEventType.ORDER_PAID:
        await this.handleOrderPaid(payload);
        return;
      case OutboxEventType.ORDER_READY:
        await this.handleOrderReady(payload);
        return;
      case OutboxEventType.ORDER_CANCELLED:
        await this.handleOrderCancelled(payload);
        return;
      case OutboxEventType.ORDER_PICKED_UP:
        await this.handleOrderPickedUp(payload);
        return;
      case OutboxEventType.REFUND_CREATED:
        await this.handleRefundCreated(payload);
        return;
      case OutboxEventType.ITEM_OUT_OF_STOCK:
        await this.handleItemOutOfStock(payload);
        return;
      default: {
        // Compile-time exhaustiveness — if a new enum value is added to
        // `OutboxEventType` without a corresponding `case` above, the
        // following assignment fails to compile because `eventType` is no
        // longer narrowed to `never` here.
        const _exhaustive: never = eventType;
        this.logger.warn(
          `[notifications] no handler registered for event type ${String(_exhaustive)}; skipping`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // ORDER_PAID — manager "NEW ORDER" alert (Spec Part 9).
  //
  // NOT REACHABLE IN PRODUCTION UNTIL C4.
  //
  // Today's outbox.worker dispatch routes ORDER_PAID directly to
  // orderWorker.handleOrderPaid (analytics + last_visit_at). The notifications
  // dispatch is a separate concern that requires the C4 split-event design
  // (ORDER_PAID + ORDER_PAID_NOTIFICATION) before it can land — see
  // decision-log entry "Notifications service: router pattern with stubbed
  // handlers" Future C4 wiring subsection. Until C4 lands, this handler is
  // exercised only by the C1 unit tests; the Telegram alert does NOT fire
  // on real paid orders even after C3 adds real Telegram delivery.
  //
  // Payload shape (single emit site — webhook-orders.service.ts
  // markPaidFromWebhook outbox row): { orderId, customerId, locationId,
  // totalCents, stripePaymentId }.
  // ---------------------------------------------------------------------------

  async handleOrderPaid(payload: Record<string, unknown>): Promise<void> {
    const orderId = this.extractOrderId(payload, 'ORDER_PAID');
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order) {
      // Row not found — warn-and-return per the warn-not-throw contract.
      this.logger.warn(
        `[notifications] ORDER_PAID order ${orderId} not found in DB — skipping`,
      );
      return;
    }
    const customer = await this.customers.findOne({ where: { id: order.customer_id } });
    this.logStubMessage('ORDER_PAID', {
      event_type: 'ORDER_PAID',
      target_audience: 'manager',
      order_id: order.id,
      customer_id: order.customer_id,
      customer_name: customer?.full_name ?? null,
      location_id: order.location_id,
      total_cents: order.total_cents,
      pickup_type: order.pickup_type,
      scheduled_pickup_at: order.scheduled_pickup_at?.toISOString() ?? null,
    });
  }

  // ---------------------------------------------------------------------------
  // ORDER_READY — customer "your coffee is ready" push (Spec Part 9).
  //
  // Single emit site: admin-orders.service.ts markReady().
  // Payload: { orderId, customerId, locationId }.
  // ---------------------------------------------------------------------------

  async handleOrderReady(payload: Record<string, unknown>): Promise<void> {
    const orderId = this.extractOrderId(payload, 'ORDER_READY');
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order) {
      this.logger.warn(
        `[notifications] ORDER_READY order ${orderId} not found in DB — skipping`,
      );
      return;
    }
    const customer = await this.customers.findOne({ where: { id: order.customer_id } });
    this.logStubMessage('ORDER_READY', {
      event_type: 'ORDER_READY',
      target_audience: 'customer',
      order_id: order.id,
      customer_id: order.customer_id,
      customer_name: customer?.full_name ?? null,
      location_id: order.location_id,
      pickup_type: order.pickup_type,
      estimated_ready_at: order.estimated_ready_at?.toISOString() ?? null,
    });
  }

  // ---------------------------------------------------------------------------
  // ORDER_CANCELLED — customer cancellation notice + manager alert.
  //
  // Today's only emit site is admin-orders.service.ts cancelByManager(), which
  // emits ONLY when payment_status === SUCCEEDED. Future paths (customer-side
  // cancel, system-cancel) may add emit sites with different payload shapes;
  // this handler reads only validated fields defensively (Concern B in the
  // decision-log entry's defensive-payload-reading subsection) so future
  // emit-site additions don't silently regress this handler.
  //
  // Payload (cancelByManager): { orderId, customerId, locationId, totalCents,
  // cancelledBy, staffUserId, reason }.
  // ---------------------------------------------------------------------------

  async handleOrderCancelled(payload: Record<string, unknown>): Promise<void> {
    const orderId = this.extractOrderId(payload, 'ORDER_CANCELLED');
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order) {
      this.logger.warn(
        `[notifications] ORDER_CANCELLED order ${orderId} not found in DB — skipping`,
      );
      return;
    }
    const customer = await this.customers.findOne({ where: { id: order.customer_id } });
    // Defensive reads — these may be absent on future emit sites.
    const cancelledBy = typeof payload.cancelledBy === 'string' ? payload.cancelledBy : null;
    const staffUserId = typeof payload.staffUserId === 'string' ? payload.staffUserId : null;
    const reason = typeof payload.reason === 'string' ? payload.reason : null;
    this.logStubMessage('ORDER_CANCELLED', {
      event_type: 'ORDER_CANCELLED',
      target_audience: 'customer+manager',
      order_id: order.id,
      customer_id: order.customer_id,
      customer_name: customer?.full_name ?? null,
      location_id: order.location_id,
      total_cents: order.total_cents,
      cancelled_by: cancelledBy,
      staff_user_id: staffUserId,
      reason,
    });
  }

  // ---------------------------------------------------------------------------
  // ORDER_PICKED_UP — close-of-loop event (analytics-shaped, no customer push
  // expected — bundled with the future receipt path).
  //
  // Single emit site: admin-orders.service.ts markPickedUp() (the A9 fix).
  // Payload: { orderId, customerId, locationId, pickedUpAt }.
  // ---------------------------------------------------------------------------

  async handleOrderPickedUp(payload: Record<string, unknown>): Promise<void> {
    const orderId = this.extractOrderId(payload, 'ORDER_PICKED_UP');
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order) {
      this.logger.warn(
        `[notifications] ORDER_PICKED_UP order ${orderId} not found in DB — skipping`,
      );
      return;
    }
    const customer = await this.customers.findOne({ where: { id: order.customer_id } });
    const pickedUpAt = typeof payload.pickedUpAt === 'string' ? payload.pickedUpAt : null;
    this.logStubMessage('ORDER_PICKED_UP', {
      event_type: 'ORDER_PICKED_UP',
      target_audience: 'analytics',
      order_id: order.id,
      customer_id: order.customer_id,
      customer_name: customer?.full_name ?? null,
      location_id: order.location_id,
      total_cents: order.total_cents,
      picked_up_at: pickedUpAt,
    });
  }

  // ---------------------------------------------------------------------------
  // REFUND_CREATED — three emit sites with overlapping but distinct payload
  // shapes. Read only the cross-site common subset; everything else is
  // optional and read defensively.
  //
  // Common to all three:   orderId, customerId, locationId, amountCents
  // Admin-actored sites carry: staffUserId
  //   1. admin-orders.service.ts refund() committed arm
  //   2. admin-orders.service.ts refund() Phase 3 race branch
  // Webhook race carries instead: requestId
  //   3. webhook-orders.service.ts markPaidFromWebhook race detection
  //
  // Race-recorded sites (Phase 3, webhook) carry `actionRequired`. When
  // present, the handler logs at WARN level so operators can grep for
  // notifications that need their attention; otherwise INFO level. See
  // decision-log entry's log-level differentiation subsection.
  // ---------------------------------------------------------------------------

  async handleRefundCreated(payload: Record<string, unknown>): Promise<void> {
    const orderId = this.extractOrderId(payload, 'REFUND_CREATED');
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order) {
      this.logger.warn(
        `[notifications] REFUND_CREATED order ${orderId} not found in DB — skipping`,
      );
      return;
    }
    const customer = await this.customers.findOne({ where: { id: order.customer_id } });
    // staffUserId — present on the two admin-actored sites, ABSENT on the
    // webhook-race site. Read defensively; do not destructure.
    const staffUserId = typeof payload.staffUserId === 'string' ? payload.staffUserId : null;
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : null;
    const stripeRefundId = typeof payload.stripeRefundId === 'string' ? payload.stripeRefundId : null;
    const amountCents = typeof payload.amountCents === 'number' ? payload.amountCents : null;
    const refundType = typeof payload.refundType === 'string' ? payload.refundType : null;
    const actionRequired = typeof payload.actionRequired === 'string' ? payload.actionRequired : null;

    const context = {
      event_type: 'REFUND_CREATED',
      target_audience: actionRequired ? 'manager-action-required' : 'customer+manager',
      order_id: order.id,
      customer_id: order.customer_id,
      customer_name: customer?.full_name ?? null,
      location_id: order.location_id,
      amount_cents: amountCents,
      stripe_refund_id: stripeRefundId,
      refund_type: refundType,
      staff_user_id: staffUserId,
      request_id: requestId,
      action_required: actionRequired,
    };

    // Log-level differentiation (Concern C). Race-recorded refunds carry
    // `actionRequired` — these need operator attention, log at WARN. Normal
    // committed refunds carry no `actionRequired` — log at INFO (logger.log).
    // Explicit if/else preserves type safety on the Logger interface; NestJS
    // Logger has no `info` method, so dynamic dispatch via this.logger[level]
    // would have to map 'info' → 'log' anyway.
    if (actionRequired) {
      this.logger.warn(
        `[notifications-stub] REFUND_CREATED (action required): ${JSON.stringify(context)}`,
      );
    } else {
      this.logger.log(
        `[notifications-stub] REFUND_CREATED: ${JSON.stringify(context)}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // ITEM_OUT_OF_STOCK — manager alert + customer push for affected open carts.
  //
  // Single emit site: admin-items.service.ts markSoldOut().
  // Payload: { itemId, locationId, staffUserId, soldOutAt }.
  //
  // MenuItem is platform-wide in the schema — there is NO `MenuItem.location_id`.
  // Per-location availability lives in `Inventory`. We load MenuItem to get the
  // canonical item name (the alert message needs "Latte sold out at downtown")
  // and use payload.locationId for location context. This is the ONLY handler
  // that reads location from the payload rather than the loaded entity, by
  // necessity. Verified at apps/api/src/database/entities.ts:288.
  // ---------------------------------------------------------------------------

  async handleItemOutOfStock(payload: Record<string, unknown>): Promise<void> {
    const itemId = this.extractItemId(payload);
    const item = await this.menuItems.findOne({ where: { id: itemId } });
    if (!item) {
      this.logger.warn(
        `[notifications] ITEM_OUT_OF_STOCK item ${itemId} not found in DB — skipping`,
      );
      return;
    }
    const locationId = typeof payload.locationId === 'string' ? payload.locationId : null;
    const staffUserId = typeof payload.staffUserId === 'string' ? payload.staffUserId : null;
    const soldOutAt = typeof payload.soldOutAt === 'string' ? payload.soldOutAt : null;
    this.logStubMessage('ITEM_OUT_OF_STOCK', {
      event_type: 'ITEM_OUT_OF_STOCK',
      target_audience: 'manager+affected-carts',
      item_id: item.id,
      item_name: item.name,
      // location_id from payload, not the loaded entity (MenuItem has none)
      location_id: locationId,
      staff_user_id: staffUserId,
      sold_out_at: soldOutAt,
    });
  }

  // ---------------------------------------------------------------------------
  // Field validators — throw on missing field. Mirrors the extractOrderId
  // pattern in apps/api/src/workers/order.worker.ts. Validation failures are
  // programming errors at the emitter, not transient runtime conditions —
  // throwing surfaces them to the outbox as DEAD with a clear last_error so
  // the operator can fix the emit site.
  // ---------------------------------------------------------------------------

  private extractOrderId(
    payload: Record<string, unknown>,
    eventType: string,
  ): string {
    const orderId = payload.orderId;
    if (typeof orderId !== 'string' || orderId.length === 0) {
      throw new Error(
        `[notifications] ${eventType} payload missing required string field 'orderId' (got: ${JSON.stringify(payload)})`,
      );
    }
    return orderId;
  }

  private extractItemId(payload: Record<string, unknown>): string {
    const itemId = payload.itemId;
    if (typeof itemId !== 'string' || itemId.length === 0) {
      throw new Error(
        `[notifications] ITEM_OUT_OF_STOCK payload missing required string field 'itemId' (got: ${JSON.stringify(payload)})`,
      );
    }
    return itemId;
  }

  /**
   * Common stub-log emit. Used by the five info-level handlers (ORDER_PAID,
   * ORDER_READY, ORDER_CANCELLED, ORDER_PICKED_UP, ITEM_OUT_OF_STOCK).
   * REFUND_CREATED has its own emit because it conditionally upgrades to
   * warn-level when `actionRequired` is present (see handler comment).
   */
  private logStubMessage(
    eventType: string,
    context: Record<string, unknown>,
  ): void {
    this.logger.log(
      `[notifications-stub] ${eventType}: ${JSON.stringify(context)}`,
    );
  }
}
