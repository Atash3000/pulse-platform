import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type Stripe from 'stripe';

import {
  Order,
  OrderEvent,
  OrderStatus,
  OutboxEvent,
  OutboxEventType,
  OutboxStatus,
  Payment,
  PaymentStatus,
} from '../../database/entities';
import { OrderStateMachine } from '../orders/order-state-machine';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /**
   * Spec section 5.2 step 13 — the atomic outbox transaction.
   *
   *   UPDATE orders SET order_status=PAID, payment_status=SUCCEEDED
   *   INSERT order_events from=PENDING_PAYMENT to=PAID by='stripe-webhook'
   *   INSERT payments (full Stripe response in JSONB)
   *   INSERT outbox_events type=ORDER_PAID status=PENDING
   *   COMMIT
   *
   * Idempotency: a duplicate webhook arriving for an already-PAID order is a
   * no-op return — we DO NOT insert a second outbox row. The outbox worker
   * can then process the original at-most-once on the downstream side.
   */
  async markPaidFromWebhook(
    intent: Stripe.PaymentIntent,
    event: Stripe.Event,
    requestId: string,
  ): Promise<void> {
    const orderId = intent.metadata?.orderId;
    if (!orderId) {
      throw new Error(`PaymentIntent ${intent.id} has no orderId in metadata`);
    }

    await this.ds.transaction(async (em) => {
      // SELECT FOR UPDATE prevents two concurrent webhook deliveries (Stripe
      // can send two of the same event a few ms apart) from both running the
      // body. The second one finds payment_status=SUCCEEDED and bails.
      const order = await em
        .createQueryBuilder(Order, 'o')
        .setLock('pessimistic_write')
        .where('o.id = :id', { id: orderId })
        .getOne();

      if (!order) {
        throw new NotFoundException(`Order ${orderId} not found from webhook`);
      }

      if (order.payment_status === PaymentStatus.SUCCEEDED) {
        // Idempotent return — nothing more to do.
        this.logger.log(
          `webhook idempotent: order ${orderId} already SUCCEEDED — no-op`,
        );
        return;
      }

      const fromStatus = order.order_status;

      // Validate the transition. Webhook is the only actor permitted to set PAID.
      OrderStateMachine.assertTransition(fromStatus, OrderStatus.PAID, 'stripe-webhook');

      // 1. Update the order itself.
      order.order_status = OrderStatus.PAID;
      order.payment_status = PaymentStatus.SUCCEEDED;
      order.stripe_payment_id = intent.id;
      await em.save(order);

      // 2. Audit trail.
      await em.insert(OrderEvent, {
        order_id: order.id,
        from_status: fromStatus,
        to_status: OrderStatus.PAID,
        reason: null,
        created_by: 'stripe-webhook',
        metadata: {
          stripe_event_id: event.id,
          payment_intent_id: intent.id,
          request_id: requestId,
        },
      });

      // 3. Payments row — full Stripe payload retained for debugging.
      // ON CONFLICT DO NOTHING handles the (extremely rare) duplicate where
      // the same PaymentIntent ID arrives twice and the SELECT FOR UPDATE
      // race is somehow lost.
      // Round-trip through JSON.parse so we end up with a plain object that
      // TypeORM's QueryBuilder partial type accepts as JSONB. Stripe's typed
      // shape is incompatible with TypeORM's _QueryDeepPartialEntity here.
      const stripeResponse = JSON.parse(JSON.stringify(intent)) as Record<string, unknown>;

      await em
        .createQueryBuilder()
        .insert()
        .into(Payment)
        .values({
          order_id: order.id,
          stripe_payment_id: intent.id,
          amount_cents: intent.amount_received ?? intent.amount,
          payment_status: PaymentStatus.SUCCEEDED,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stripe_response: stripeResponse as any,
        })
        .orIgnore()
        .execute();

      // 4. Outbox row — atomic with the order update. Workers pick this up.
      await em.insert(OutboxEvent, {
        event_type: OutboxEventType.ORDER_PAID,
        status: OutboxStatus.PENDING,
        attempts: 0,
        payload: {
          orderId: order.id,
          customerId: order.customer_id,
          locationId: order.location_id,
          totalCents: order.total_cents,
          stripePaymentId: intent.id,
        },
      });

      this.logger.log(
        `order ${order.id} → PAID (stripe_event=${event.id}, request_id=${requestId})`,
      );
    });
  }

  /**
   * payment_intent.payment_failed — set the order to FAILED and log the reason.
   * No outbox event for failures in Phase 1 (Telegram alerting comes later;
   * for now we surface the failure via order_events for the support flow).
   */
  async markFailedFromWebhook(
    intent: Stripe.PaymentIntent,
    event: Stripe.Event,
    requestId: string,
  ): Promise<void> {
    const orderId = intent.metadata?.orderId;
    if (!orderId) {
      this.logger.warn(`payment_failed webhook missing orderId metadata for PI ${intent.id}`);
      return;
    }

    await this.ds.transaction(async (em) => {
      const order = await em
        .createQueryBuilder(Order, 'o')
        .setLock('pessimistic_write')
        .where('o.id = :id', { id: orderId })
        .getOne();

      if (!order) {
        this.logger.warn(`payment_failed webhook for unknown order ${orderId}`);
        return;
      }

      if (order.order_status === OrderStatus.FAILED) {
        return; // idempotent
      }

      const fromStatus = order.order_status;
      const reason =
        intent.last_payment_error?.message ??
        intent.last_payment_error?.code ??
        'payment_intent.payment_failed';

      OrderStateMachine.assertTransition(fromStatus, OrderStatus.FAILED, 'stripe-webhook');
      order.order_status = OrderStatus.FAILED;
      order.payment_status = PaymentStatus.FAILED;
      await em.save(order);

      await em.insert(OrderEvent, {
        order_id: order.id,
        from_status: fromStatus,
        to_status: OrderStatus.FAILED,
        reason,
        created_by: 'stripe-webhook',
        metadata: {
          stripe_event_id: event.id,
          payment_intent_id: intent.id,
          request_id: requestId,
          ...(intent.last_payment_error
            ? { last_payment_error: JSON.parse(JSON.stringify(intent.last_payment_error)) }
            : {}),
        },
      });

      this.logger.log(`order ${order.id} → FAILED (${reason})`);
    });
  }
}
