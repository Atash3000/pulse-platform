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
        // estimated_ready_at = now + current_wait_minutes from this location's settings
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
    return this.transitionStaff(staff, orderId, OrderStatus.PICKED_UP);
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

  async refund(
    staff: StaffContext,
    orderId: string,
    reason: string,
    amountCents?: number,
  ): Promise<{ order: Order; refund: Refund }> {
    // Stripe call happens FIRST, outside the DB transaction. Two reasons:
    //   1. We don't hold row-level locks while waiting on Stripe (10s timeout).
    //   2. If Stripe fails, we don't write a refund row — DB stays consistent.
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);
    if (order.location_id !== staff.location_id) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }
    if (!order.stripe_payment_id) {
      throw new BadRequestException('Order has no Stripe payment to refund');
    }

    const refundAmount = amountCents ?? order.total_cents;
    if (refundAmount <= 0 || refundAmount > order.total_cents) {
      throw new BadRequestException(
        `amount_cents must be between 1 and ${order.total_cents}`,
      );
    }

    let stripeRefundId: string;
    try {
      const stripeRefund = await this.stripe.createRefund({
        paymentIntentId: order.stripe_payment_id,
        amountCents: refundAmount,
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

    return this.ds.transaction(async (em) => {
      const locked = await this.lockedFetch(em, staff.location_id, orderId);
      const isFullRefund = refundAmount === locked.total_cents;

      // Need the payment row id for the FK.
      const payment = await em.findOne(Payment, {
        where: { stripe_payment_id: locked.stripe_payment_id! },
      });
      if (!payment) {
        throw new BadRequestException('No payment row found for this order — cannot refund');
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

      const fromStatus = locked.order_status;
      if (isFullRefund) {
        OrderStateMachine.assertTransition(fromStatus, OrderStatus.REFUNDED, 'manager');
        locked.order_status = OrderStatus.REFUNDED;
        locked.payment_status = PaymentStatus.REFUNDED;
      } else {
        // Partial: order_status stays where it is. Only payment_status moves.
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
          full_refund: isFullRefund,
        },
      });

      await em.insert(OutboxEvent, {
        event_type: OutboxEventType.REFUND_CREATED,
        status: OutboxStatus.PENDING,
        payload: {
          orderId: locked.id,
          customerId: locked.customer_id,
          locationId: locked.location_id,
          amountCents: refundAmount,
          stripeRefundId,
          fullRefund: isFullRefund,
          staffUserId: staff.staff_user_id,
        },
      });

      this.logger.log(
        `refund ${stripeRefundId}: order=${locked.id} amount_cents=${refundAmount} full=${isFullRefund}`,
      );
      return { order: locked, refund: savedRefund };
    });
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
