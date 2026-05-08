import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Customer, Order } from '../database/entities';
import { CloverSyncService } from '../modules/clover/clover-sync.service';

/**
 * Phase 1 ORDER_PAID side-effect handler.
 *
 *   1. Validate payload (only orderId is required).
 *   2. Load the order from the database — DB is the truth, payload is a hint.
 *   3. Log "Clover sync deferred to Phase 2" (no Clover call in Phase 1).
 *   4. Update customer.last_visit_at — supports Phase 2 retention/churn logic.
 *   5. Emit a structured analytics log line. PostHog wires up later.
 *
 * Phase 1 vs Phase 2
 * ------------------
 * Clover POS integration is deferred to Phase 2. In Phase 1, every order
 * keeps `clover_sync_status = NOT_SENT` and operational management happens
 * via the staff dashboard (`POST /admin/orders/:id/{accept,progress,ready,
 * picked-up}`). The CloverSyncService and CloverModule are intentionally
 * retained on disk so Phase 2 is a small wiring change rather than a rebuild.
 * Do NOT call CloverSyncService.syncOrder() unless Phase 2 is explicitly
 * started.
 *
 * Why we re-load the order
 * ------------------------
 * The outbox payload is a snapshot of what was true when the row was written.
 * If the order is amended between the write and the worker pickup (refund,
 * partial refund, status correction, etc.), the payload's customerId /
 * locationId / totalCents could be stale. Treating the DB as the source of
 * truth means side effects always reflect the CURRENT state.
 *
 * Throws on payload validation failure or missing order so the outbox worker
 * can retry the event and (after 5 attempts) mark it DEAD.
 */
@Injectable()
export class OrderWorker {
  private readonly logger = new Logger(OrderWorker.name);

  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(Customer) private readonly customers: Repository<Customer>,
    private readonly cloverSync: CloverSyncService,
  ) {}

  async handleOrderPaid(payload: Record<string, unknown> | null | undefined): Promise<void> {
    const orderId = this.extractOrderId(payload);

    // Load from DB — payload is just a pointer. If the order vanished between
    // outbox-write and now, this throws and the event retries → DEAD.
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order) {
      throw new Error(`ORDER_PAID handler: order ${orderId} not found in database`);
    }

    // 1. Clover sync — DEFERRED TO PHASE 2.
    // Phase 1 keeps clover_sync_status = NOT_SENT on every order; that is the
    // expected and correct state. Operational order management lives in the
    // staff dashboard (POST /admin/orders/:id/{accept,progress,ready,picked-up}).
    // Do not call CloverSyncService here unless Phase 2 is explicitly started.
    this.logger.log(`Clover sync deferred to Phase 2 for order ${orderId}`);

    // 2. Update last_visit_at using the customer_id from the LOADED order, not
    //    the payload. UTC now() in JS land matches the structured log timestamp.
    const result = await this.customers.update(order.customer_id, {
      last_visit_at: new Date(),
    });
    if (result.affected === 0) {
      this.logger.warn(
        `ORDER_PAID handler: no customer row matched id=${order.customer_id}; last_visit_at not updated`,
      );
    }

    // 3. Structured analytics log. Source values from the loaded row, not the
    //    payload — matches the real state of the order at side-effect time.
    this.logger.log(
      JSON.stringify({
        event_type: 'ORDER_PAID',
        order_id: order.id,
        customer_id: order.customer_id,
        location_id: order.location_id,
        total_cents: order.total_cents,
        order_status: order.order_status,
        payment_status: order.payment_status,
      }),
    );
  }

  /**
   * The minimum required field is `orderId` (string UUID). Other fields in
   * the payload are ignored — see class doc on why.
   */
  private extractOrderId(payload: Record<string, unknown> | null | undefined): string {
    if (!payload || typeof payload !== 'object') {
      throw new Error('ORDER_PAID payload missing or not an object');
    }
    const orderId = payload.orderId;
    if (typeof orderId !== 'string' || orderId.length === 0) {
      throw new Error(
        `ORDER_PAID payload missing required field "orderId" (got: ${JSON.stringify(payload)})`,
      );
    }
    return orderId;
  }
}
