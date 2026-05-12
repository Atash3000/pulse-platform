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

/**
 * WebhookOrdersService owns the side effects triggered by Stripe webhooks:
 * marking orders PAID after successful payment, marking orders FAILED on
 * payment decline, and detecting post-payment race conditions. This service
 * does NOT handle customer-facing order reads or writes — those live in
 * `OrdersService` at `modules/orders/orders.service.ts`. The split exists
 * because webhook handling has different concurrency, error-handling, and
 * security characteristics than the read/write API: webhooks must be
 * idempotent under Stripe retries, must not throw on detected races (see
 * decision-log entry "Webhook-after-state-change races: log + outbox, never
 * throw"), and are authenticated by signature rather than JWT.
 */
@Injectable()
export class WebhookOrdersService {
  private readonly logger = new Logger(WebhookOrdersService.name);

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

      // ---------------------------------------------------------------------
      // Race detection — payment.succeeded arrived for an order that's
      // already been moved to a terminal state. See decision-log entry
      // "Webhook-after-state-change races: log + outbox, never throw" for
      // the full reasoning behind this branch.
      //
      // Three real-world races produce this:
      //
      //   cancel-after-pay:    customer hit POST /orders/:id/cancel between
      //                        their Stripe sheet confirmation and the webhook
      //                        landing. order_status = CANCELLED, but Stripe
      //                        actually took the money.
      //
      //   cleanup-after-pay:   PendingPaymentCleanupTask reaped the order at
      //                        minute 30 because the webhook was lagging.
      //                        order_status = FAILED, but Stripe actually
      //                        took the money.
      //
      //   post-refund-success: order was already REFUNDED somehow (operator
      //                        action, edge case). Shouldn't normally happen
      //                        but guarded for completeness.
      //
      // Without this branch, the OrderStateMachine.assertTransition below
      // would throw ConflictException — Stripe sees 5xx and retries the
      // webhook every few minutes for THREE DAYS. We instead:
      //   - log the race with full diagnostic detail
      //   - emit a REFUND_CREATED outbox row (CANCELLED/FAILED only) so the
      //     future notifications module can alert the owner
      //   - return without throwing → Stripe sees 200 and stops retrying
      //
      // We deliberately do NOT call stripe.refunds.create from here. The
      // refund needs a manager's eyes on it ("in case something is fishy
      // about the race") — they go through /admin/orders/:id/refund. The
      // outbox row is the liability ledger entry, not the refund itself.
      // ---------------------------------------------------------------------
      const raceType = this.detectPostPaymentRace(order.order_status);
      if (raceType) {
        const amountReceived = intent.amount_received ?? intent.amount;
        this.logger.warn(
          `webhook race detected: order ${order.id} is ${order.order_status} ` +
            `but payment_intent.succeeded arrived ` +
            `(race=${raceType}, stripe_event=${event.id}, payment_intent=${intent.id}, ` +
            `amount_received=${amountReceived}, request_id=${requestId}). ` +
            `Returning 200 to Stripe; manager intervention required for refund.`,
        );

        // Emit REFUND_CREATED outbox row for races where money was actually
        // received but the order is in a no-fulfilment state. The notifications
        // module surfaces this to the owner; the manager runs the refund via
        // POST /admin/orders/:id/refund. No outbox row for REFUNDED — already
        // refunded, nothing to surface.
        if (
          raceType === 'cancel-after-pay' ||
          raceType === 'cleanup-after-pay'
        ) {
          await em.insert(OutboxEvent, {
            event_type: OutboxEventType.REFUND_CREATED,
            status: OutboxStatus.PENDING,
            attempts: 0,
            payload: {
              orderId: order.id,
              customerId: order.customer_id,
              locationId: order.location_id,
              amountCents: amountReceived,
              currency: intent.currency,
              stripePaymentIntentId: intent.id,
              stripeEventId: event.id,
              requestId,
              raceType,
              orderStatusAtRace: order.order_status,
              paymentStatusAtRace: order.payment_status,
              actionRequired: 'manager-refund-via-admin-endpoint',
            },
          });
        }
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

      // 4. Outbox rows — atomic with the order update. Two events emitted
      // in the same transaction (C5 split-event design):
      //
      //   ORDER_PAID              → orderWorker.handleOrderPaid (analytics:
      //                              last_visit_at + structured log)
      //   ORDER_PAID_NOTIFICATION → notifications.dispatch → handleOrderPaidNotification
      //                              → telegramService.newOrder (manager alert)
      //
      // Each retries independently at the outbox-worker level. A transient
      // failure in the alert dispatch doesn't cause the analytics handler
      // to re-run; a transient failure in analytics doesn't cause duplicate
      // Telegram messages. Prevents the duplicate-alert bug that naive
      // single-event fan-out would produce — see decision-log entry
      // "ORDER_PAID split-event design: analytics + notification retry
      // independently" for the full rationale.
      //
      // Payload-as-pointer for both: the orderId resolves to the live row
      // in the handler. No snapshot in payload — `Order` is the source of
      // truth, the payload is a stable reference.
      const outboxPayload = {
        orderId: order.id,
        customerId: order.customer_id,
        locationId: order.location_id,
        totalCents: order.total_cents,
        stripePaymentId: intent.id,
      };

      await em.insert(OutboxEvent, {
        event_type: OutboxEventType.ORDER_PAID,
        status: OutboxStatus.PENDING,
        attempts: 0,
        payload: outboxPayload,
      });

      await em.insert(OutboxEvent, {
        event_type: OutboxEventType.ORDER_PAID_NOTIFICATION,
        status: OutboxStatus.PENDING,
        attempts: 0,
        payload: outboxPayload,
      });

      this.logger.log(
        `order ${order.id} → PAID (stripe_event=${event.id}, request_id=${requestId}); ` +
          `emitted ORDER_PAID + ORDER_PAID_NOTIFICATION outbox rows`,
      );
    });
  }

  /**
   * Identifies whether the current order_status corresponds to a known
   * post-payment race when a payment_intent.succeeded webhook arrives.
   *
   *   CANCELLED → 'cancel-after-pay'  — customer cancelled mid-flight
   *                                     (POST /orders/:id/cancel between
   *                                     Stripe sheet confirm and webhook)
   *   FAILED    → 'cleanup-after-pay' — PendingPaymentCleanupTask reaped the
   *                                     order before the webhook landed
   *   REFUNDED  → 'post-refund-success' — terminal, refund had already been
   *                                       issued; payment shouldn't have
   *                                       succeeded in the first place
   *
   * Returns null for PENDING_PAYMENT (the happy path) and any other status —
   * the caller treats null as "proceed with the normal PAID transition".
   */
  private detectPostPaymentRace(
    orderStatus: OrderStatus,
  ): 'cancel-after-pay' | 'cleanup-after-pay' | 'post-refund-success' | null {
    switch (orderStatus) {
      case OrderStatus.CANCELLED:
        return 'cancel-after-pay';
      case OrderStatus.FAILED:
        return 'cleanup-after-pay';
      case OrderStatus.REFUNDED:
        return 'post-refund-success';
      default:
        return null;
    }
  }

  /**
   * payment_intent.payment_failed — set the order to FAILED and log the reason.
   * No outbox event for failures in Phase 1 (Telegram alerting comes later;
   * for now we surface the failure via order_events for the support flow).
   *
   * Idempotency layers
   * ------------------
   * Three guards, in order:
   *
   *   1. `order_status === FAILED` → idempotent return. Duplicate webhook
   *      delivery for the already-failed case.
   *
   *   2. Post-payment race detection (via `detectPostFailureRace`) → log
   *      structured WARN + return 200. The order has moved beyond
   *      PENDING_PAYMENT (paid + downstream, refunded, or cancelled);
   *      the failure event is stale. No money moved, no operator action
   *      needed, no order mutation, no outbox emission. See decision-log
   *      entry "markFailedFromWebhook idempotency: stale failure webhook
   *      handling against post-payment states" for the full rationale.
   *
   *   3. `OrderStateMachine.assertTransition` → the remaining valid
   *      transition is `PENDING_PAYMENT → FAILED` for the `stripe-webhook`
   *      actor. Any other state at this point (currently only `DRAFT`,
   *      which would be anomalous — a PaymentIntent shouldn't exist for
   *      a DRAFT order) lets the assertion throw and surfaces as a
   *      real error.
   *
   * Without guard (2) — added by the bug-#3 fix — a stale failure webhook
   * for any post-payment state would throw `ConflictException`. Stripe
   * sees 5xx and retries every few minutes for 3 days, creating retry
   * storms in CloudWatch and the outbox-worker logs. Guard (2) returns
   * 200 to Stripe with a WARN log so the failed-webhook is observable
   * without action.
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
        return; // idempotent — duplicate webhook for already-failed order.
      }

      // ---------------------------------------------------------------------
      // Post-payment race detection — stale failure webhook arrived for an
      // order that's already moved past PENDING_PAYMENT. The order is
      // settled; the failure event is informational noise. Log WARN with
      // full diagnostic detail, return 200, do not throw.
      //
      // Three race types collapsed under three names (the operator
      // response is identical for the five `stale-failure-after-success`
      // sub-states; the log line retains the actual `order_status` for
      // diagnostic granularity). See `detectPostFailureRace` and the
      // decision-log entry.
      //
      // Deliberately NOT mutating order_status / payment_status / inserting
      // an order_events row — the order's truth is already correct;
      // recording a non-transition would pollute the audit trail.
      // ---------------------------------------------------------------------
      const failureRaceType = this.detectPostFailureRace(order.order_status);
      if (failureRaceType) {
        const lastPaymentError = intent.last_payment_error
          ? JSON.parse(JSON.stringify(intent.last_payment_error))
          : null;
        this.logger.warn(
          `payment_failed webhook race detected: order ${order.id} is ${order.order_status} ` +
            `but payment_intent.payment_failed arrived ` +
            `(race=${failureRaceType}, stripe_event=${event.id}, payment_intent=${intent.id}, ` +
            `payment_status=${order.payment_status}, request_id=${requestId}, ` +
            `last_payment_error=${JSON.stringify(lastPaymentError)}). ` +
            `Returning 200 to Stripe; no action required (order is settled).`,
        );
        return;
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

  /**
   * Identifies whether the current `order_status` corresponds to a known
   * post-payment race when a `payment_intent.payment_failed` webhook
   * arrives. Returns null for `PENDING_PAYMENT` (the happy path) and for
   * `DRAFT` (anomalous — a PaymentIntent shouldn't exist for a DRAFT
   * order; let the state-machine assertion throw so the bug is visible).
   *
   * Five "downstream of PAID" states (`PAID`, `ACCEPTED`, `IN_PROGRESS`,
   * `READY`, `PICKED_UP`) collapse under one race name —
   * `stale-failure-after-success` — because the operator response is
   * identical for all of them. The diagnostic granularity (which
   * specific sub-state) is preserved in the WARN log line.
   *
   * See also `detectPostPaymentRace` (the success-direction sibling). The
   * two are kept as parallel methods rather than merged into a shared
   * classifier — their response policies differ (markPaidFromWebhook
   * emits a `REFUND_CREATED` outbox for some races; this one emits
   * nothing because no money moved). Sharing the classifier would force
   * consumers to switch on caller-context anyway. See decision-log entry
   * "markFailedFromWebhook idempotency: stale failure webhook handling
   * against post-payment states" — comparison table.
   */
  private detectPostFailureRace(
    orderStatus: OrderStatus,
  ): 'stale-failure-after-success' | 'stale-failure-after-refund' | 'stale-failure-after-cancel' | null {
    switch (orderStatus) {
      case OrderStatus.PAID:
      case OrderStatus.ACCEPTED:
      case OrderStatus.IN_PROGRESS:
      case OrderStatus.READY:
      case OrderStatus.PICKED_UP:
        return 'stale-failure-after-success';
      case OrderStatus.REFUNDED:
        return 'stale-failure-after-refund';
      case OrderStatus.CANCELLED:
        return 'stale-failure-after-cancel';
      default:
        // PENDING_PAYMENT (happy path) and DRAFT (anomalous — should never
        // reach this handler with a PI) fall through.
        return null;
    }
  }
}
