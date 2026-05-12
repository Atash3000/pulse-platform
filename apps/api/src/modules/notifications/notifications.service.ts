import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  Customer,
  Location,
  MenuItem,
  Order,
  OutboxEventType,
} from '../../database/entities';
import { TelegramService } from './telegram.service';

/**
 * Notifications router with stubbed handlers (C1).
 *
 * What this owns
 * --------------
 * Centralised dispatch from outbox event type → side-effect handler. The
 * outbox worker (apps/api/src/workers/outbox.worker.ts) routes six event
 * types here (`ORDER_PAID_NOTIFICATION`, `ORDER_CANCELLED`, `ORDER_READY`,
 * `ORDER_PICKED_UP`, `REFUND_CREATED`, `ITEM_OUT_OF_STOCK`) — post-C4 the
 * full dispatch chain is wired. `ORDER_PAID` stays on `orderWorker` for
 * analytics; this service handles `ORDER_PAID_NOTIFICATION` for the
 * Telegram alert side.
 *
 * ORDER_PAID is split between two services post-C5: orderWorker handles
 * the analytics side (`ORDER_PAID` → `handleOrderPaid` →
 * `last_visit_at` + structured log), NotificationsService handles the
 * alert side (`ORDER_PAID_NOTIFICATION` → `handleOrderPaidNotification`
 * → `telegramService.newOrder`). Both events are emitted atomically in
 * the same webhook transaction and retry independently — see
 * decision-log entry "ORDER_PAID split-event design: analytics +
 * notification retry independently" for the rationale.
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
    // C5: Location repo needed by handleOrderPaidNotification to resolve
    // the location's display name for the Telegram "NEW ORDER — {customer} — ...
    // — {locationName}" message body.
    @InjectRepository(Location) private readonly locations: Repository<Location>,
    // C5: TelegramService for the manager "NEW ORDER" alert. C3 added the
    // six alert methods as stubs; C5 wires `newOrder` into the
    // ORDER_PAID_NOTIFICATION handler. Real Bot API delivery is still
    // stubbed — the [telegram-stub] log line confirms the right data is
    // being passed through.
    private readonly telegram: TelegramService,
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
        // Defensive: orderWorker is the routing authority for ORDER_PAID
        // (analytics — last_visit_at + structured log). NotificationsService
        // handles ORDER_PAID_NOTIFICATION (Telegram alert). If outbox.worker
        // ever routes ORDER_PAID here by mistake, silently return rather
        // than throw — analytics will have run via orderWorker. See C5
        // decision-log entry "ORDER_PAID split-event design: analytics +
        // notification retry independently".
        //
        // The case is kept (rather than removed) so the `_exhaustive: never`
        // check below still compiles — ORDER_PAID remains in the
        // OutboxEventType enum.
        return;
      case OutboxEventType.ORDER_PAID_NOTIFICATION:
        await this.handleOrderPaidNotification(payload);
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
        //
        // Runtime: C4 flipped this branch from warn-and-return to throw.
        // The default now only fires for corrupted runtime values that
        // bypass the type system (e.g., a stale outbox row with an
        // enum string that was removed from `OutboxEventType`). Throwing
        // propagates up to `outbox.worker.processOne`, which catches and
        // increments `attempts` — the row eventually transitions to DEAD
        // and `TelegramService.alertDeadOutboxEvent` fires for operator
        // attention. Better than silent skip-and-mark-PROCESSED.
        const _exhaustive: never = eventType;
        throw new Error(
          `[notifications] no handler registered for event type ${String(_exhaustive)}`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // ORDER_PAID_NOTIFICATION — manager "NEW ORDER" Telegram alert (Spec Part 9).
  //
  // C5 wired this handler to call `telegramService.newOrder(...)` with the
  // pre-formatted scalars TelegramService expects. Loads:
  //
  //   - Order with `relations: { items: true }` for the item summary.
  //   - Customer for the displayed name.
  //   - Location for the displayed name.
  //
  // Missing customer / location fall back to empty string (TelegramService
  // signatures require non-nullable strings; `formatCustomerName('')`
  // returns empty, gracefully producing a message body with a missing slot
  // rather than crashing).
  //
  // Post-C4: REACHABLE via outbox.worker → notifications.dispatch routing.
  // Every successful payment emits ORDER_PAID_NOTIFICATION, the worker
  // dispatches it here, this handler loads the entities and calls
  // telegramService.newOrder (still stub-logged via [telegram-stub] until
  // C8 ships real Bot API delivery).
  //
  // Payload shape (one of two emit sites — webhook-orders.service.ts
  // markPaidFromWebhook ORDER_PAID_NOTIFICATION row, identical to the
  // sibling ORDER_PAID row): { orderId, customerId, locationId,
  // totalCents, stripePaymentId }. Payload is a pointer — Order is the
  // source of truth, the handler resolves the live state.
  // ---------------------------------------------------------------------------

  async handleOrderPaidNotification(payload: Record<string, unknown>): Promise<void> {
    const orderId = this.extractOrderId(payload, 'ORDER_PAID_NOTIFICATION');
    const order = await this.orders.findOne({
      where: { id: orderId },
      // Load items eagerly — TelegramService.newOrder needs the per-line
      // {name, quantity} for the message body's item summary
      // ("Oat Latte + Muffin"). The OrderItem entity stores `item_name` as
      // a frozen snapshot at order time (per the spec), so the displayed
      // name matches what the customer saw at checkout.
      relations: { items: true },
    });
    if (!order) {
      this.logger.warn(
        `[notifications] ORDER_PAID_NOTIFICATION order ${orderId} not found in DB — skipping`,
      );
      return;
    }
    const customer = await this.customers.findOne({ where: { id: order.customer_id } });
    const location = await this.locations.findOne({ where: { id: order.location_id } });

    // Call TelegramService.newOrder with pre-formatted scalars. The
    // formatters live in telegram-formatters.ts; TelegramService applies
    // them to assemble the Spec Part 9 message body. Missing
    // customer/location fall back to empty strings — `formatCustomerName`
    // and the body template degrade gracefully.
    await this.telegram.newOrder({
      orderId: order.id,
      customerName: customer?.full_name ?? '',
      items: (order.items ?? []).map((it) => ({
        name: it.item_name,
        quantity: it.quantity,
      })),
      totalCents: order.total_cents,
      locationName: location?.name ?? '',
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
