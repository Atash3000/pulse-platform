import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import {
  Order,
  OrderEvent,
  OrderStatus,
  PaymentStatus,
} from '../../database/entities';
import { StripeService } from '../payments/stripe.service';
import { OrderStateMachine } from './order-state-machine';

// =============================================================================
// PendingPaymentCleanupTask
//
// Decision context: see decision-log entry "Abandoned-checkout cleanup:
// 30-minute threshold, FAILED state, no outbox event" for why this task
// exists, why 30 min, why FAILED (not CANCELLED), and why no outbox event
// is emitted. The block below summarizes the rationale for engineers
// reading this file in isolation.
//
// Sweeps orders abandoned at checkout. An order in PENDING_PAYMENT means we
// created a Stripe PaymentIntent and returned its clientSecret to iOS, but
// the customer never confirmed payment. If they close the app, lose network,
// or simply walk away, the order stays in PENDING_PAYMENT forever — Stripe
// expires the PaymentIntent on its side after ~24 hours but our database
// has no equivalent self-cleaning behaviour.
//
// Without this task, the consequences are operational:
//   - GET /orders/my shows ghost "in-flight" orders for life.
//   - iOS polling logic (every 10s while not in a terminal status) polls
//     forever, never stopping.
//   - Idempotency keys never get freed for retry of a fresh attempt.
//   - Stripe-vs-our-ledger reconciliation drifts (Stripe expires the PI
//     while our row stays PENDING_PAYMENT).
//   - The orders table accumulates zombie rows.
//
// Threshold: 30 minutes
// ---------------------
// Why 30 min, not 1 hour or 5 min?
//   - Stripe payment sheets typically time out around 10–15 minutes.
//   - A customer with a flaky network might legitimately take 5–10 min
//     to confirm payment. 30 min is a comfortable buffer.
//   - Anything older is almost certainly abandoned. Reaping it benefits
//     the customer (their iOS app stops polling).
//
// Why FAILED, not CANCELLED?
// --------------------------
// CANCELLED implies an explicit decision by the customer or a manager. An
// abandonment is neither — the customer simply didn't complete payment.
// FAILED captures the operational reality: "payment never happened, this
// order will never be fulfilled." Same terminal state Stripe-side errors
// produce. Keeps our enum semantics tight.
//
// Why no outbox event?
// --------------------
// ORDER_CANCELLED outbox events drive customer notifications and refund
// processing. Neither applies here:
//   - The customer never paid, so there's nothing to refund.
//   - Pinging "your order was cancelled" to a customer who never confirmed
//     in the first place is confusing — they may not even remember tapping
//     Checkout.
// We log the transition and rely on iOS's polling to discover the FAILED
// state on its next request.
//
// Concurrency
// -----------
// Same pattern as the outbox worker:
//   - SELECT FOR UPDATE SKIP LOCKED so multiple worker pods running this
//     task in parallel never grab the same row.
//   - Process-local `isRunning` flag prevents a slow sweep from overlapping
//     with the next 5-minute cron fire on the same pod.
//   - WORKERS_ENABLED env gate so API-only ECS tasks skip the cron.
//
// Trade-off: dispatch (the Stripe cancel call) happens INSIDE the txn, so
// row locks are held for the duration of the Stripe call. Same trade-off
// documented in the outbox-dispatch decision-log entry. Acceptable today;
// the upgrade path to claim-then-process is the same.
// =============================================================================

const STALE_AFTER_MINUTES = 30;
const BATCH_SIZE = 25;

@Injectable()
export class PendingPaymentCleanupTask {
  private readonly logger = new Logger(PendingPaymentCleanupTask.name);
  private isRunning = false;
  private readonly enabled: boolean;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly stripe: StripeService,
    config: ConfigService,
  ) {
    // Default ON. Set WORKERS_ENABLED=false on API-only ECS tasks so they
    // don't fire scheduled side-effects — only the dedicated worker task
    // should. Same convention as the OutboxWorker.
    this.enabled = config.get<string>('WORKERS_ENABLED') !== 'false';
    if (!this.enabled) {
      this.logger.log(
        'WORKERS_ENABLED=false — pending-payment cleanup cron NOT firing (API-only mode)',
      );
    }
  }

  /**
   * Cron entry point. Fires every 5 minutes on every pod where the task is
   * registered. The first action checks `enabled` and `isRunning`; everything
   * else flows through `runOnce()` which is also exposed for unit tests.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'pending-payment-cleanup' })
  async sweep(): Promise<void> {
    if (!this.enabled) return;
    if (this.isRunning) {
      this.logger.warn('previous sweep still running — skipping this tick');
      return;
    }
    this.isRunning = true;
    try {
      const reaped = await this.runOnce();
      if (reaped > 0) {
        this.logger.log(
          `pending-payment cleanup: reaped ${reaped} abandoned order(s) (>${STALE_AFTER_MINUTES}m old)`,
        );
      }
    } catch (err) {
      // Never let a cron failure crash the process. Log and let the next
      // tick try again.
      this.logger.error(
        `pending-payment cleanup tick failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Test entry point. Performs one batch reap and returns the number of
   * orders processed. Public so e2e tests can drive the sweep deterministically
   * instead of waiting for the cron.
   */
  async runOnce(): Promise<number> {
    return this.ds.transaction(async (em) => {
      const stale = await this.claimStaleBatch(em);
      let count = 0;
      for (const order of stale) {
        await this.reapOne(em, order);
        count += 1;
      }
      return count;
    });
  }

  // ---------------------------------------------------------------------------
  // SELECT FOR UPDATE SKIP LOCKED so concurrent pods never grab the same row.
  // Raw SQL — TypeORM 0.3's QueryBuilder lock+limit composition has subtle
  // behaviour across versions; the SQL is explicit and version-independent.
  // ---------------------------------------------------------------------------

  private async claimStaleBatch(em: EntityManager): Promise<StaleOrderRow[]> {
    const rows = (await em.query(
      `SELECT id, customer_id, location_id, stripe_payment_id, idempotency_key, created_at
       FROM orders
       WHERE order_status = $1
         AND created_at < NOW() - ($2::int * INTERVAL '1 minute')
       ORDER BY created_at ASC
       LIMIT $3
       FOR UPDATE SKIP LOCKED`,
      [OrderStatus.PENDING_PAYMENT, STALE_AFTER_MINUTES, BATCH_SIZE],
    )) as StaleOrderRow[];
    return rows;
  }

  private async reapOne(em: EntityManager, order: StaleOrderRow): Promise<void> {
    // 1. Best-effort Stripe cancel. We don't roll back the local FAILED
    //    transition if Stripe is unreachable — Stripe will expire the PI
    //    on its own ~24h after creation, and our DB is the truth.
    if (order.stripe_payment_id) {
      try {
        await this.stripe.cancelPaymentIntent(order.stripe_payment_id);
      } catch (err) {
        this.logger.warn(
          `Stripe cancel failed for ${order.stripe_payment_id} (order=${order.id}): ${(err as Error).message}. Proceeding with FAILED transition.`,
        );
      }
    }

    // 2. Defence-in-depth: assert the transition is allowed. The state
    //    machine throws if PENDING_PAYMENT → FAILED is somehow disallowed
    //    (it isn't — actor 'system' is permitted) which would surface as
    //    a clear error rather than a silent miswrite.
    OrderStateMachine.assertTransition(
      OrderStatus.PENDING_PAYMENT,
      OrderStatus.FAILED,
      'system',
    );

    // 3. Flip both order_status and payment_status. Match the shape of
    //    markFailedFromWebhook so the row reads consistently with
    //    Stripe-driven failures.
    await em.update(
      Order,
      { id: order.id },
      {
        order_status: OrderStatus.FAILED,
        payment_status: PaymentStatus.FAILED,
      },
    );

    // 4. Audit trail. The reason field doubles as a search key — any future
    //    "show me all abandoned-at-checkout orders" report greps on this.
    await em.insert(OrderEvent, {
      order_id: order.id,
      from_status: OrderStatus.PENDING_PAYMENT,
      to_status: OrderStatus.FAILED,
      reason: 'abandoned at checkout',
      created_by: 'system',
      metadata: {
        actor_type: 'system',
        task: 'PendingPaymentCleanupTask',
        threshold_minutes: STALE_AFTER_MINUTES,
        order_age_minutes: this.ageInMinutes(order.created_at),
      },
    });

    this.logger.log(
      `order ${order.id} → FAILED (abandoned, age=${this.ageInMinutes(order.created_at)}m)`,
    );
  }

  private ageInMinutes(createdAt: Date): number {
    return Math.round((Date.now() - new Date(createdAt).getTime()) / 60_000);
  }
}

// Plain row shape from the raw SELECT — only the columns we touch.
interface StaleOrderRow {
  id: string;
  customer_id: string;
  location_id: string;
  stripe_payment_id: string | null;
  idempotency_key: string;
  created_at: Date;
}
