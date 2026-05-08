import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import {
  Order,
  OrderEvent,
  OrderItem,
  OrderItemModifierSnapshot,
  OrderStatus,
  OutboxEvent,
  OutboxEventType,
  OutboxStatus,
} from '../../database/entities';
import { OrderStateMachine } from './order-state-machine';

export interface OrderItemDetail {
  id: string;
  menu_item_id: string;
  item_name: string;
  quantity: number;
  unit_price_cents: number;
  modifiers: OrderItemModifierSnapshot[];
}

export interface OrderDetail {
  id: string;
  customer_id: string;
  location_id: string;
  location_name: string;
  order_status: string;
  payment_status: string;
  clover_sync_status: string;
  pickup_type: string;
  scheduled_pickup_at: string | null;
  estimated_ready_at: string | null;
  subtotal_cents: number;
  modifier_cents: number;
  discount_cents: number;
  tax_cents: number;
  tip_cents: number;
  total_cents: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
  items: OrderItemDetail[];
}

export interface OrderHistoryItem {
  id: string;
  order_status: string;
  total_cents: number;
  pickup_type: string;
  location_id: string;
  location_name: string;
  created_at: string;
}

export interface OrderHistoryResponse {
  items: OrderHistoryItem[];
  total: number;
  limit: number;
  offset: number;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
  ) {}

  // -------------------------------------------------------------------------
  // GET /orders/:id
  // -------------------------------------------------------------------------

  async getOrderForCustomer(customerId: string, orderId: string): Promise<OrderDetail> {
    const order = await this.orders.findOne({
      where: { id: orderId },
      relations: { location: true, items: true },
    });
    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    // Per spec: 403 (not 404) when the order belongs to someone else, so iOS
    // doesn't get to differentiate "doesn't exist" from "not yours" by error code.
    if (order.customer_id !== customerId) {
      throw new ForbiddenException('You can only view your own orders');
    }

    return this.toOrderDetail(order);
  }

  // -------------------------------------------------------------------------
  // GET /orders/my
  // -------------------------------------------------------------------------

  async getOrderHistory(
    customerId: string,
    limit: number,
    offset: number,
  ): Promise<OrderHistoryResponse> {
    const [rows, total] = await this.orders.findAndCount({
      where: { customer_id: customerId },
      order: { created_at: 'DESC' },
      take: limit,
      skip: offset,
      relations: { location: true },
    });

    return {
      total,
      limit,
      offset,
      items: rows.map((o) => ({
        id: o.id,
        order_status: o.order_status,
        total_cents: o.total_cents,
        pickup_type: o.pickup_type,
        location_id: o.location_id,
        location_name: o.location?.name ?? '',
        created_at: o.created_at.toISOString(),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // POST /orders/:id/cancel
  // -------------------------------------------------------------------------

  async cancelOrderAsCustomer(customerId: string, orderId: string): Promise<OrderDetail> {
    return this.ds.transaction(async (em) => {
      // SELECT FOR UPDATE so concurrent cancel + webhook can't race on this row.
      const order = await em
        .createQueryBuilder(Order, 'o')
        .setLock('pessimistic_write')
        .where('o.id = :id', { id: orderId })
        .getOne();

      if (!order) {
        throw new NotFoundException(`Order ${orderId} not found`);
      }
      if (order.customer_id !== customerId) {
        throw new ForbiddenException('You can only cancel your own orders');
      }

      // Spec: customers can only cancel orders in DRAFT.
      // The state machine throws ConflictException with `validNext` populated.
      OrderStateMachine.assertTransition(
        order.order_status,
        OrderStatus.CANCELLED,
        'customer',
      );

      const fromStatus = order.order_status;
      order.order_status = OrderStatus.CANCELLED;
      await em.save(order);

      await em.insert(OrderEvent, {
        order_id: order.id,
        from_status: fromStatus,
        to_status: OrderStatus.CANCELLED,
        reason: 'customer_requested_cancellation',
        created_by: customerId,
        metadata: { actor_type: 'customer' },
      });

      // Outbox event so the future notification handler can fire on cancel.
      await em.insert(OutboxEvent, {
        event_type: OutboxEventType.ORDER_CANCELLED,
        status: OutboxStatus.PENDING,
        payload: {
          orderId: order.id,
          customerId: order.customer_id,
          locationId: order.location_id,
          totalCents: order.total_cents,
          cancelledBy: 'customer',
        },
      });

      this.logger.log(`order ${order.id} → CANCELLED by customer ${customerId}`);

      // Re-load with relations so the response is the same shape as GET /:id.
      const reloaded = await em.findOne(Order, {
        where: { id: order.id },
        relations: { location: true, items: true },
      });
      return this.toOrderDetail(reloaded!);
    });
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private toOrderDetail(order: Order): OrderDetail {
    return {
      id: order.id,
      customer_id: order.customer_id,
      location_id: order.location_id,
      location_name: order.location?.name ?? '',
      order_status: order.order_status,
      payment_status: order.payment_status,
      clover_sync_status: order.clover_sync_status,
      pickup_type: order.pickup_type,
      scheduled_pickup_at: order.scheduled_pickup_at?.toISOString() ?? null,
      estimated_ready_at: order.estimated_ready_at?.toISOString() ?? null,
      subtotal_cents: order.subtotal_cents,
      modifier_cents: order.modifier_cents,
      discount_cents: order.discount_cents,
      tax_cents: order.tax_cents,
      tip_cents: order.tip_cents,
      total_cents: order.total_cents,
      notes: order.notes,
      created_at: order.created_at.toISOString(),
      updated_at: order.updated_at.toISOString(),
      items: (order.items ?? []).map((i: OrderItem) => ({
        id: i.id,
        menu_item_id: i.menu_item_id,
        item_name: i.item_name,
        quantity: i.quantity,
        unit_price_cents: i.unit_price_cents,
        modifiers: i.modifiers ?? [],
      })),
    };
  }
}
