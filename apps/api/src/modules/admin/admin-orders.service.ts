import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import {
  Customer,
  LocationSettings,
  Order,
  OrderEvent,
  OrderItem,
  OrderStatus,
  OutboxEvent,
  OutboxEventType,
  OutboxStatus,
  Payment,
  PaymentStatus,
  PickupType,
  Refund,
} from '../../database/entities';
import { OrderStateMachine } from '../orders/order-state-machine';
import { StripeService } from '../payments/stripe.service';
import { StaffContext } from './staff-context';

const ACTIVE_QUEUE_STATUSES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.ACCEPTED,
  OrderStatus.IN_PROGRESS,
  OrderStatus.READY,
];

export interface AdminOrderListItem {
  id: string;
  customer_id: string;
  customer_name: string;
  order_status: string;
  clover_sync_status: string;
  total_cents: number;
  pickup_type: string;
  estimated_ready_at: string | null;
  notes: string | null;
  created_at: string;
  items: Array<{
    id: string;
    menu_item_id: string;
    item_name: string;
    quantity: number;
    modifiers: Array<{ name: string }>;
  }>;
}

export interface AdminOrderEventRow {
  id: string;
  from_status: string | null;
  to_status: string;
  reason: string | null;
  created_by: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/**
 * Discriminated return type for refund(). The two states cannot share a
 * shape because the race branch has no DB refund row to return — Stripe
 * moved money but the cumulative-refund check failed inside the lock, so
 * the liability lives in an outbox row instead. Forcing callers to switch
 * on `status` makes the manual-reconciliation case impossible to ignore at
 * the type level. See decision-log entry "Refund pre-validation before
 * Stripe call: avoid money out with no DB record" — Phase 3 race section.
 */
export type RefundResult =
  | { status: 'committed'; order: Order; refund: Refund }
  | {
      status: 'race-recorded';
      stripeRefundId: string;
      amountCents: number;
      requiresManualReconciliation: true;
    };

@Injectable()
export class AdminOrdersService {
  private readonly logger = new Logger(AdminOrdersService.name);

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(OrderItem) private readonly items: Repository<OrderItem>,
    @InjectRepository(OrderEvent) private readonly events: Repository<OrderEvent>,
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
    @InjectRepository(LocationSettings)
    private readonly settings: Repository<LocationSettings>,
    // Refund + Payment repos are used by refund() Phase 1 to validate
    // before any Stripe call (cumulative refund check + payments-row
    // existence). See decision-log entry "Refund pre-validation before
    // Stripe call: avoid money out with no DB record".
    @InjectRepository(Refund) private readonly refunds: Repository<Refund>,
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    private readonly stripe: StripeService,
  ) {}

  // ---------------------------------------------------------------------------
  // GET /admin/orders — live queue scoped to staff's location
  // ---------------------------------------------------------------------------

  async listActiveOrders(staff: StaffContext): Promise<AdminOrderListItem[]> {
    const orders = await this.orders.find({
      where: {
        location_id: staff.location_id,
        order_status: In(ACTIVE_QUEUE_STATUSES),
      },
      order: { created_at: 'ASC' }, // oldest first — gets attention first
      relations: { items: true },
    });
    if (orders.length === 0) return [];

    // One round trip for customer names — avoid 1+N.
    const customerIds = [...new Set(orders.map((o) => o.customer_id))];
    const customers = await this.customers.find({ where: { id: In(customerIds) } });
    const customerNameById = new Map(customers.map((c) => [c.id, c.full_name]));

    return orders.map((o) => ({
      id: o.id,
      customer_id: o.customer_id,
      customer_name: customerNameById.get(o.customer_id) ?? '',
      order_status: o.order_status,
      clover_sync_status: o.clover_sync_status,
      total_cents: o.total_cents,
      pickup_type: o.pickup_type,
      estimated_ready_at: o.estimated_ready_at?.toISOString() ?? null,
      notes: o.notes,
      created_at: o.created_at.toISOString(),
      items: (o.items ?? []).map((i) => ({
        id: i.id,
        menu_item_id: i.menu_item_id,
        item_name: i.item_name,
        quantity: i.quantity,
        modifiers: (i.modifiers ?? []).map((m) => ({ name: m.name })),
      })),
    }));
  }

  // ---------------------------------------------------------------------------
  // POST /admin/orders/:id/accept — PAID → ACCEPTED
  // ---------------------------------------------------------------------------

  async accept(staff: StaffContext, orderId: string): Promise<Order> {
    return this.transitionStaff(
      staff,
      orderId,
      OrderStatus.ACCEPTED,
      async (em, order) => {
        // estimated_ready_at semantics differ by pickup_type:
        //
        //   ASAP       → recompute as now + current_wait_minutes when staff
        //                accept. This is the only authoritative input for
        //                ASAP orders.
        //
        //   SCHEDULED  → leave alone. The customer chose a specific pickup
        //                time at checkout; HoursService.canAcceptOrders()
        //                returned that time as estimatedReadyAt
        //                (modules/locations/hours.service.ts SCHEDULED
        //                branch), which checkout.service.ts step 5 persisted
        //                onto the order. Overwriting it here would silently
        //                shift the customer's pickup time and break the iOS
        //                countdown display, which polls /orders/:id and
        //                expects estimated_ready_at to match the time the
        //                customer chose.
        //
        // Do NOT "simplify" by always recomputing. The asymmetry is
        // intentional. See decision-log entry "Scheduled orders:
        // estimated_ready_at set once at checkout, never overwritten".
        if (order.pickup_type !== PickupType.ASAP) return;

        const settings = await em.findOne(LocationSettings, {
          where: { location_id: staff.location_id },
        });
        const waitMin = settings?.current_wait_minutes ?? 5;
        order.estimated_ready_at = new Date(Date.now() + waitMin * 60_000);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // POST /admin/orders/:id/progress — ACCEPTED → IN_PROGRESS
  // ---------------------------------------------------------------------------

  async progress(staff: StaffContext, orderId: string): Promise<Order> {
    return this.transitionStaff(staff, orderId, OrderStatus.IN_PROGRESS);
  }

  // ---------------------------------------------------------------------------
  // POST /admin/orders/:id/ready — IN_PROGRESS → READY (+ ORDER_READY outbox)
  // ---------------------------------------------------------------------------

  async markReady(staff: StaffContext, orderId: string): Promise<Order> {
    return this.transitionStaff(
      staff,
      orderId,
      OrderStatus.READY,
      async (em, order) => {
        await em.insert(OutboxEvent, {
          event_type: OutboxEventType.ORDER_READY,
          status: OutboxStatus.PENDING,
          payload: {
            orderId: order.id,
            customerId: order.customer_id,
            locationId: order.location_id,
          },
        });
      },
    );
  }

  // ---------------------------------------------------------------------------
  // POST /admin/orders/:id/picked-up — READY → PICKED_UP
  // ---------------------------------------------------------------------------

  async markPickedUp(staff: StaffContext, orderId: string): Promise<Order> {
    return this.transitionStaff(
      staff,
      orderId,
      OrderStatus.PICKED_UP,
      async (em, order) => {
        // ORDER_PICKED_UP is the close-of-loop event for analytics
        // (retention, time-to-pickup metrics) and any future receipt /
        // thank-you push. The outbox worker currently no-ops it (see
        // workers/outbox.worker.ts dispatch switch); when the analytics
        // module ships, the case branch picks it up without changes here.
        await em.insert(OutboxEvent, {
          event_type: OutboxEventType.ORDER_PICKED_UP,
          status: OutboxStatus.PENDING,
          payload: {
            orderId: order.id,
            customerId: order.customer_id,
            locationId: order.location_id,
            pickedUpAt: new Date().toISOString(),
          },
        });
      },
    );
  }

  // ---------------------------------------------------------------------------
  // POST /admin/orders/:id/cancel — manager+; PAID|ACCEPTED|IN_PROGRESS|READY → CANCELLED
  // ---------------------------------------------------------------------------

  async cancelByManager(staff: StaffContext, orderId: string, reason: string): Promise<Order> {
    return this.ds.transaction(async (em) => {
      const order = await this.lockedFetch(em, staff.location_id, orderId);
      const fromStatus = order.order_status;
      OrderStateMachine.assertTransition(fromStatus, OrderStatus.CANCELLED, 'manager');

      order.order_status = OrderStatus.CANCELLED;
      await em.save(order);

      await em.insert(OrderEvent, {
        order_id: order.id,
        from_status: fromStatus,
        to_status: OrderStatus.CANCELLED,
        reason,
        created_by: staff.staff_user_id,
        metadata: { actor_type: 'manager', role: staff.role },
      });

      // Only emit ORDER_CANCELLED outbox if money was actually taken.
      if (order.payment_status === PaymentStatus.SUCCEEDED) {
        await em.insert(OutboxEvent, {
          event_type: OutboxEventType.ORDER_CANCELLED,
          status: OutboxStatus.PENDING,
          payload: {
            orderId: order.id,
            customerId: order.customer_id,
            locationId: order.location_id,
            totalCents: order.total_cents,
            cancelledBy: 'manager',
            staffUserId: staff.staff_user_id,
            reason,
          },
        });
      }

      this.logger.log(
        `order ${order.id} → CANCELLED by staff=${staff.staff_user_id} (was ${fromStatus})`,
      );
      return order;
    });
  }

  // ---------------------------------------------------------------------------
  // POST /admin/orders/:id/refund — manager+; full or partial via Stripe
  // ---------------------------------------------------------------------------

  /**
   * Three-phase refund flow.
   *
   *   Phase 1 — pre-validation (NO Stripe call, NO row lock).
   *   Phase 2 — Stripe call with idempotency key (NO DB lock held).
   *   Phase 3 — locked DB write with race detection (mirrors the
   *             markPaidFromWebhook race pattern: log + outbox + don't
   *             throw if Stripe already moved money).
   *
   * Why three phases — decision-log entry "Refund pre-validation before
   * Stripe call: avoid money out with no DB record". Bundles fixes A6
   * (cumulative refund tracking), A7 (cumulative isFullRefund), A8
   * (Stripe idempotency key) into the same surface.
   */
  async refund(
    staff: StaffContext,
    orderId: string,
    reason: string,
    amountCents?: number,
  ): Promise<RefundResult> {
    // -------------------------------------------------------------------------
    // Phase 1 — pre-validation. Every reject path runs BEFORE Stripe is
    // touched. Previously the state-machine assertion sat AFTER the Stripe
    // call, which let money move out of the connected account on a refund
    // attempt that the DB then rolled back, leaving zero record of the
    // outflow.
    // -------------------------------------------------------------------------
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order || order.location_id !== staff.location_id) {
      // Same privacy posture as customer-side endpoints — see decision-log
      // entry "Privacy: 404 over 403 for cross-customer order access".
      throw new NotFoundException(`Order ${orderId} not found`);
    }
    if (!order.stripe_payment_id) {
      throw new BadRequestException('Order has no Stripe payment to refund');
    }

    const refundAmount = amountCents ?? order.total_cents;
    if (
      !Number.isInteger(refundAmount) ||
      refundAmount <= 0 ||
      refundAmount > order.total_cents
    ) {
      throw new BadRequestException(
        `amount_cents must be a positive integer between 1 and ${order.total_cents}`,
      );
    }

    // A6 — cumulative refund check. Sum prior refunds for this order; reject
    // if (existing + this) would exceed the order total. Without this guard,
    // a $5 partial on a $20 order followed by a $20 refund attempt sails
    // through validation and only gets caught by Stripe's amount-too-large
    // error after money has theoretically been requested.
    const existingRefundedCents = await this.sumRefundsForOrder(orderId);
    if (existingRefundedCents + refundAmount > order.total_cents) {
      const remaining = order.total_cents - existingRefundedCents;
      throw new BadRequestException(
        `Refund would exceed remaining refundable amount. ` +
          `Order total: ${order.total_cents}, already refunded: ${existingRefundedCents}, ` +
          `attempted: ${refundAmount}, remaining: ${remaining}.`,
      );
    }

    // A7 — cumulative isFullRefund. A previous partial of $5 on a $20 order
    // followed by a $15 refund here is a FULL refund — order_status must
    // transition to REFUNDED. Computing isFullRefund as
    // refundAmount === total_cents (the previous behaviour) missed this case
    // and left the order stuck in PARTIALLY_REFUNDED forever.
    const isFullRefund =
      existingRefundedCents + refundAmount === order.total_cents;

    // State machine assertion runs ONLY for full refunds — partial refunds
    // don't change order_status, so there's no transition to assert.
    if (isFullRefund) {
      OrderStateMachine.assertTransition(
        order.order_status,
        OrderStatus.REFUNDED,
        'manager',
      );
    }

    // Confirm the payments row exists. Doing this in Phase 1 catches the
    // missing-row case before Stripe; previously this check sat inside the
    // locked transaction, AFTER Stripe had already moved money.
    const payment = await this.payments.findOne({
      where: { stripe_payment_id: order.stripe_payment_id },
    });
    if (!payment) {
      throw new BadRequestException(
        'No payment row found for this order — cannot refund',
      );
    }

    // -------------------------------------------------------------------------
    // Phase 2 — Stripe call (A8: idempotent).
    //
    // Key format: refund-{orderId}-{amountCents}-{minute-bucket}.
    //
    //   - Two retries with the same arguments within the same minute get
    //     deduplicated by Stripe → at-most-one refund for transient
    //     network/server failures.
    //   - A deliberate second refund a minute later gets a fresh key →
    //     fresh refund, which is the correct semantic.
    //
    // The payment_intent + amount + minute composition keeps the key
    // collision-free for legitimate calls and stable for retries.
    // -------------------------------------------------------------------------
    const idempotencyKey = `refund-${orderId}-${refundAmount}-${Math.floor(
      Date.now() / 60_000,
    )}`;

    let stripeRefundId: string;
    try {
      const stripeRefund = await this.stripe.createRefund({
        paymentIntentId: order.stripe_payment_id,
        amountCents: refundAmount,
        idempotencyKey,
        metadata: {
          orderId: order.id,
          staffUserId: staff.staff_user_id,
          internalReason: reason,
        },
      });
      stripeRefundId = stripeRefund.id;
    } catch (err) {
      throw new BadGatewayException({
        reason: 'STRIPE_REFUND_FAILED',
        message: (err as Error).message ?? 'Stripe refund failed',
      });
    }

    // -------------------------------------------------------------------------
    // Phase 3 — locked DB write.
    //
    // Re-runs the cumulative refund check INSIDE the lock. Between Phase 1's
    // unlocked check and our lock acquisition here, another manager could
    // have issued a partial refund that pushes the cumulative over the
    // total. If that happens, Stripe has already moved money — we cannot
    // undo it. Mirror the markPaidFromWebhook race pattern: log a
    // structured ERROR with full diagnostics, emit a REFUND_CREATED outbox
    // event flagged with `error: 'race-with-concurrent-refund'`, and return
    // success to the client (the refund DID happen at Stripe; the manager
    // gets a notification once the notifications module ships and reconciles
    // by hand).
    // -------------------------------------------------------------------------
    return this.ds.transaction(async (em) => {
      const locked = await this.lockedFetch(em, staff.location_id, orderId);
      const lockedExistingCents = await this.sumRefundsForOrderInTx(em, orderId);

      if (lockedExistingCents + refundAmount > locked.total_cents) {
        // RACE — Phase 1 saw a smaller existing total than Phase 3 sees.
        // Stripe already accepted the refund; we cannot undo it. Surface
        // the liability via the outbox; do NOT throw to the caller.
        this.logger.error(
          `refund race detected: order=${locked.id} stripe_refund=${stripeRefundId} ` +
            `phase1_existing=${existingRefundedCents} phase3_existing=${lockedExistingCents} ` +
            `attempted=${refundAmount} total=${locked.total_cents}. ` +
            `Stripe accepted the refund; manual reconciliation required.`,
        );
        await em.insert(OutboxEvent, {
          event_type: OutboxEventType.REFUND_CREATED,
          status: OutboxStatus.PENDING,
          attempts: 0,
          payload: {
            orderId: locked.id,
            customerId: locked.customer_id,
            locationId: locked.location_id,
            amountCents: refundAmount,
            stripeRefundId,
            fullRefund: false,
            staffUserId: staff.staff_user_id,
            error: 'race-with-concurrent-refund',
            phase1ExistingCents: existingRefundedCents,
            phase3ExistingCents: lockedExistingCents,
            actionRequired: 'manual-reconciliation',
          },
        });
        // Stripe's refund IS real — but our DB has no `refunds` row for
        // it because the cumulative-refund check failed inside the lock.
        // The outbox row above carries the liability so the manager can
        // reconcile manually. Surface this to callers as a distinct
        // discriminator so HTTP / test code cannot accidentally treat it
        // as a normal commit.
        return {
          status: 'race-recorded',
          stripeRefundId,
          amountCents: refundAmount,
          requiresManualReconciliation: true,
        };
      }

      // Re-evaluate isFullRefund inside the lock. May differ from Phase 1
      // (rarely — if a concurrent partial landed but the total still fits).
      // If Phase 3 says full but Phase 1 didn't, run the state-machine
      // assertion now. If Phase 1 said full but Phase 3 says partial,
      // simply skip the order_status flip.
      const lockedIsFullRefund =
        lockedExistingCents + refundAmount === locked.total_cents;
      const fromStatus = locked.order_status;

      if (lockedIsFullRefund) {
        OrderStateMachine.assertTransition(
          fromStatus,
          OrderStatus.REFUNDED,
          'manager',
        );
      }

      const refundRow = em.create(Refund, {
        order_id: locked.id,
        payment_id: payment.id,
        stripe_refund_id: stripeRefundId,
        amount_cents: refundAmount,
        reason,
        created_by: staff.staff_user_id,
      });
      const savedRefund = await em.save(refundRow);

      if (lockedIsFullRefund) {
        locked.order_status = OrderStatus.REFUNDED;
        locked.payment_status = PaymentStatus.REFUNDED;
      } else {
        // Partial: order_status stays where it is — only payment_status
        // moves to PARTIALLY_REFUNDED to reflect that some money has been
        // refunded.
        locked.payment_status = PaymentStatus.PARTIALLY_REFUNDED;
      }
      await em.save(locked);

      await em.insert(OrderEvent, {
        order_id: locked.id,
        from_status: fromStatus,
        to_status: locked.order_status,
        reason: `refund: ${reason}`,
        created_by: staff.staff_user_id,
        metadata: {
          actor_type: 'manager',
          stripe_refund_id: stripeRefundId,
          amount_cents: refundAmount,
          full_refund: lockedIsFullRefund,
          cumulative_refunded_cents: lockedExistingCents + refundAmount,
        },
      });

      // Outbox payload carries enough information for downstream consumers
      // (notifications, analytics) to distinguish three semantically
      // different outcomes WITHOUT needing to re-query the refunds table:
      //
      //   single-full     — this one refund covers the whole order; no
      //                     prior partials existed.
      //   cumulative-full — this refund + prior partials sum to the order
      //                     total. The customer's overall position is
      //                     "fully refunded", but the receipt notification
      //                     should reflect that this was the LAST of N
      //                     partials, not a one-shot reversal.
      //   partial         — money is going back but the order is not yet
      //                     fully refunded; no terminal-state notification.
      //
      // `fullRefund` is kept as a backward-compatible alias for
      // `isCumulativelyFull` until any downstream subscriber stops reading
      // it. New subscribers SHOULD read `refundType`.
      const cumulativeRefundedCents = lockedExistingCents + refundAmount;
      const refundType: 'partial' | 'cumulative-full' | 'single-full' =
        !lockedIsFullRefund
          ? 'partial'
          : lockedExistingCents === 0
            ? 'single-full'
            : 'cumulative-full';

      await em.insert(OutboxEvent, {
        event_type: OutboxEventType.REFUND_CREATED,
        status: OutboxStatus.PENDING,
        payload: {
          orderId: locked.id,
          customerId: locked.customer_id,
          locationId: locked.location_id,
          amountCents: refundAmount,
          stripeRefundId,
          fullRefund: lockedIsFullRefund,
          isCumulativelyFull: lockedIsFullRefund,
          cumulativeRefundedCents,
          refundType,
          staffUserId: staff.staff_user_id,
        },
      });

      this.logger.log(
        `refund ${stripeRefundId}: order=${locked.id} amount_cents=${refundAmount} ` +
          `type=${refundType} cumulative=${cumulativeRefundedCents}/${locked.total_cents}`,
      );
      return { status: 'committed', order: locked, refund: savedRefund };
    });
  }

  /**
   * Sum of `amount_cents` across all refunds rows for one order. Used by
   * Phase 1 of the refund flow before Stripe is called. Returns 0 when no
   * prior refunds exist (COALESCE).
   *
   * Postgres returns SUM as numeric → string in the JS driver; we cast.
   */
  private async sumRefundsForOrder(orderId: string): Promise<number> {
    const result = await this.refunds
      .createQueryBuilder('r')
      .select('COALESCE(SUM(r.amount_cents), 0)', 'total')
      .where('r.order_id = :orderId', { orderId })
      .getRawOne<{ total: string }>();
    return Number(result?.total ?? 0);
  }

  /**
   * Same query as sumRefundsForOrder but using the transaction-scoped
   * EntityManager so it sees rows committed by other transactions but not
   * uncommitted-but-pending writes (default REPEATABLE READ behaviour for
   * a transaction taking a row lock on `orders`).
   *
   * Used by Phase 3 to detect a concurrent refund landed between Phase 1
   * and the lock acquisition.
   */
  private async sumRefundsForOrderInTx(
    em: import('typeorm').EntityManager,
    orderId: string,
  ): Promise<number> {
    const result = await em
      .createQueryBuilder(Refund, 'r')
      .select('COALESCE(SUM(r.amount_cents), 0)', 'total')
      .where('r.order_id = :orderId', { orderId })
      .getRawOne<{ total: string }>();
    return Number(result?.total ?? 0);
  }

  // ---------------------------------------------------------------------------
  // GET /admin/orders/:id/events — manager+; full audit trail
  // ---------------------------------------------------------------------------

  async getOrderEvents(staff: StaffContext, orderId: string): Promise<AdminOrderEventRow[]> {
    // Confirm the order is at this location before exposing its history.
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order || order.location_id !== staff.location_id) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }
    const rows = await this.events.find({
      where: { order_id: orderId },
      order: { created_at: 'ASC' },
    });
    return rows.map((e) => ({
      id: e.id,
      from_status: e.from_status,
      to_status: e.to_status,
      reason: e.reason,
      created_by: e.created_by,
      metadata: e.metadata,
      created_at: e.created_at.toISOString(),
    }));
  }

  // ---------------------------------------------------------------------------
  // Shared transition helper for accept / progress / ready / picked-up
  // ---------------------------------------------------------------------------

  private async transitionStaff(
    staff: StaffContext,
    orderId: string,
    to: OrderStatus,
    afterUpdate?: (em: import('typeorm').EntityManager, order: Order) => Promise<void>,
  ): Promise<Order> {
    return this.ds.transaction(async (em) => {
      const order = await this.lockedFetch(em, staff.location_id, orderId);
      const fromStatus = order.order_status;
      OrderStateMachine.assertTransition(fromStatus, to, 'staff');

      order.order_status = to;

      // afterUpdate may mutate the order (e.g. set estimated_ready_at) and/or
      // insert outbox rows. It runs BEFORE we save so any field changes commit
      // alongside the status change.
      if (afterUpdate) {
        await afterUpdate(em, order);
      }
      await em.save(order);

      await em.insert(OrderEvent, {
        order_id: order.id,
        from_status: fromStatus,
        to_status: to,
        reason: null,
        created_by: staff.staff_user_id,
        metadata: { actor_type: 'staff', role: staff.role },
      });

      this.logger.log(`order ${order.id}: ${fromStatus} → ${to} by staff=${staff.staff_user_id}`);
      return order;
    });
  }

  /**
   * Locks the order row for update AND verifies it belongs to this staff
   * member's location. 404 (not 403) when out of scope — staff don't get to
   * differentiate "doesn't exist" from "different location" by error code.
   */
  private async lockedFetch(
    em: import('typeorm').EntityManager,
    locationId: string,
    orderId: string,
  ): Promise<Order> {
    const order = await em
      .createQueryBuilder(Order, 'o')
      .setLock('pessimistic_write')
      .where('o.id = :id', { id: orderId })
      .getOne();
    if (!order || order.location_id !== locationId) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }
    return order;
  }
}
