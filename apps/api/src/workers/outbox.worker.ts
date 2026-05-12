import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import {
  OutboxEvent,
  OutboxEventType,
  OutboxStatus,
} from '../database/entities';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { TelegramService } from '../modules/notifications/telegram.service';
import { OrderWorker } from './order.worker';

const POLL_INTERVAL_MS = 1_000;
const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 5;

/**
 * Polls outbox_events every 1 second and dispatches PENDING rows.
 *
 * Multi-pod safety
 * ----------------
 * Each tick opens a transaction and runs:
 *
 *     SELECT ... FROM outbox_events
 *     WHERE status = 'PENDING'
 *     ORDER BY created_at ASC
 *     LIMIT $1
 *     FOR UPDATE SKIP LOCKED
 *
 * The row-level locks held by one worker pod are invisible to another via
 * SKIP LOCKED — they grab a different batch. Dispatch runs INSIDE the
 * transaction so the locks persist until status flips to PROCESSED (or DEAD).
 * No second pod can pick up the same row, even if dispatch is slow.
 *
 * Trade-off: if dispatch becomes long-running (real Clover sync, push to
 * APNs, etc.) the txn holds row locks for that duration. For Phase 1's
 * sub-second in-process dispatch this is fine. When dispatch goes external,
 * switch to claim-then-process: lock-update-to-CLAIMED-commit, dispatch
 * outside the txn, then mark PROCESSED in a second txn. The
 * `processing_started_at` column already supports stuck-row recovery.
 *
 * Concurrency model (single-pod)
 * ------------------------------
 * The `isProcessing` flag prevents a slow tick from overlapping with the
 * next interval fire within the same process. Combined with SKIP LOCKED,
 * we're safe at any pod count.
 *
 * Resilience
 * ----------
 *  - One failed event NEVER affects the rest of the batch.
 *  - One failed batch NEVER kills the worker — the top-level catch swallows.
 *  - On shutdown we let the in-flight tick drain before unblocking destroy.
 *
 * Why we don't reset attempts on success
 * --------------------------------------
 * `attempts` is the count of FAILED tries. If a row failed twice and then
 * succeeded, attempts stays at 2 — that's useful forensic data. We do clear
 * `last_error` on success so the row reads cleanly.
 *
 * Env gate
 * --------
 * If WORKERS_ENABLED=false the worker does NOT start polling — useful for
 * API-only ECS tasks that share an image with a dedicated worker task.
 * Default behaviour: enabled (so single-task local dev still works).
 */
@Injectable()
export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorker.name);
  private interval: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private shuttingDown = false;
  private enabled = true;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(OutboxEvent)
    private readonly outboxRepo: Repository<OutboxEvent>,
    private readonly orderWorker: OrderWorker,
    private readonly telegram: TelegramService,
    // C4: NotificationsService for the six event-driven event types
    // (ORDER_PAID_NOTIFICATION + five non-PAID). ORDER_PAID stays on
    // orderWorker for analytics — see decision-log entry "Notifications
    // dispatch wiring (C4) + outbox-worker README update (C7)".
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    // Default ON. Set WORKERS_ENABLED=false on API-only ECS tasks so they
    // don't poll the outbox table — only the dedicated worker task should.
    this.enabled = this.config.get<string>('WORKERS_ENABLED') !== 'false';
    if (!this.enabled) {
      this.logger.log('WORKERS_ENABLED=false — outbox worker NOT starting (API-only mode)');
      return;
    }
    this.interval = setInterval(() => {
      // setInterval doesn't await; tick handles its own errors.
      void this.tick();
    }, POLL_INTERVAL_MS);
    this.logger.log(`outbox worker started — polling every ${POLL_INTERVAL_MS}ms`);
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (!this.enabled) return;
    // Drain in-flight tick. Worst-case: one batch of 10 events.
    const start = Date.now();
    while (this.isProcessing && Date.now() - start < 10_000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    this.logger.log('outbox worker stopped');
  }

  // ---------------------------------------------------------------------------
  // Tick — single transaction, FOR UPDATE SKIP LOCKED.
  // ---------------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (this.isProcessing || this.shuttingDown) return;
    this.isProcessing = true;
    try {
      await this.ds.transaction(async (em) => {
        const claimed = await this.claimBatch(em);
        for (const event of claimed) {
          if (this.shuttingDown) break;
          await this.processOne(em, event);
        }
      });
    } catch (err) {
      // DB unreachable, transient connection drop, etc. Don't kill the worker.
      this.logger.error(
        `outbox tick failed (will retry next interval): ${(err as Error).message}`,
        (err as Error).stack,
      );
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Locks up to BATCH_SIZE PENDING rows for this transaction. Other worker
   * pods running the identical query at the same instant see DIFFERENT rows
   * (or none) thanks to SKIP LOCKED.
   *
   * Raw SQL on purpose — TypeORM 0.3's QueryBuilder lock+take combination
   * has subtle gotchas across versions and drivers. The SQL is the contract.
   */
  private async claimBatch(em: EntityManager): Promise<OutboxEvent[]> {
    const rows = (await em.query(
      `SELECT id, event_type, payload, status, attempts, last_error,
              processing_started_at, processed_at, created_at
       FROM outbox_events
       WHERE status = $1
       ORDER BY created_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [OutboxStatus.PENDING, BATCH_SIZE],
    )) as Array<{
      id: string;
      event_type: OutboxEventType;
      payload: Record<string, unknown>;
      status: OutboxStatus;
      attempts: number;
      last_error: string | null;
      processing_started_at: Date | null;
      processed_at: Date | null;
      created_at: Date;
    }>;
    return rows as unknown as OutboxEvent[];
  }

  private async processOne(em: EntityManager, event: OutboxEvent): Promise<void> {
    this.logger.log(`outbox event picked up: id=${event.id} type=${event.event_type}`);

    // Mark pickup time BEFORE dispatch. Inside the same txn so it commits
    // alongside the eventual PROCESSED transition.
    await em.update(
      OutboxEvent,
      { id: event.id },
      { processing_started_at: new Date() },
    );

    try {
      await this.dispatch(event);
      await this.markProcessed(em, event.id);
    } catch (err) {
      await this.handleFailure(em, event, err as Error);
    }
  }

  // ---------------------------------------------------------------------------
  // Dispatch — route by event_type. Two destinations:
  //
  //   ORDER_PAID                  → orderWorker.handleOrderPaid (analytics:
  //                                  last_visit_at + structured log)
  //
  //   ORDER_PAID_NOTIFICATION  ┐
  //   ORDER_CANCELLED          │
  //   ORDER_READY              ├── notifications.dispatch(...) routes by
  //   ORDER_PICKED_UP          │   eventType to the matching handler in
  //   REFUND_CREATED           │   NotificationsService. Real Telegram/APNs
  //   ITEM_OUT_OF_STOCK        ┘   delivery is still stub-logged (C8 ships
  //                                that).
  //
  // C4 changed this from the previous warn-and-mark-PROCESSED fallback for
  // the five non-PAID events. After C4 the full dispatch chain is live:
  //
  //   real paid order → markPaidFromWebhook emits ORDER_PAID +
  //   ORDER_PAID_NOTIFICATION → worker tick picks them up → ORDER_PAID
  //   routes to orderWorker (last_visit_at), ORDER_PAID_NOTIFICATION
  //   routes to notifications.dispatch → handleOrderPaidNotification →
  //   telegramService.newOrder → [telegram-stub] log line in CloudWatch.
  //
  // Transaction-boundary note: NotificationsService handlers load entities
  // via injected repositories that use the global DataSource, NOT this
  // worker's locked transaction's EntityManager. Their reads see the
  // database state OUTSIDE this worker's lock. This is acceptable for
  // Phase 1 (sub-second dispatch latency, concurrent entity mutations
  // are vanishingly rare). When dispatch goes external (Phase 2 Clover/
  // APNs with real network I/O), claim-then-process moves dispatch
  // outside the worker's lock entirely. See decision-log entry "Outbox
  // dispatch happens INSIDE the SKIP LOCKED transaction (Phase 1
  // trade-off)" for the established pattern + the Phase 2 escape hatch.
  // ---------------------------------------------------------------------------

  private async dispatch(event: OutboxEvent): Promise<void> {
    switch (event.event_type) {
      case OutboxEventType.ORDER_PAID:
        await this.orderWorker.handleOrderPaid(event.payload);
        return;

      case OutboxEventType.ORDER_PAID_NOTIFICATION:
      case OutboxEventType.ORDER_CANCELLED:
      case OutboxEventType.ORDER_READY:
      case OutboxEventType.ORDER_PICKED_UP:
      case OutboxEventType.REFUND_CREATED:
      case OutboxEventType.ITEM_OUT_OF_STOCK:
        await this.notifications.dispatch(event.event_type, event.payload);
        return;

      default:
        // A new enum value showed up that we forgot to wire. Throw so the
        // event retries and surfaces as DEAD with a clear last_error.
        throw new Error(`Unknown outbox event type: ${String(event.event_type)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // State transitions — all use the txn-scoped EntityManager.
  // ---------------------------------------------------------------------------

  private async markProcessed(em: EntityManager, eventId: string): Promise<void> {
    await em.update(
      OutboxEvent,
      { id: eventId },
      {
        status: OutboxStatus.PROCESSED,
        processed_at: new Date(),
        last_error: null,
      },
    );
  }

  private async handleFailure(
    em: EntityManager,
    event: OutboxEvent,
    err: Error,
  ): Promise<void> {
    const attempts = event.attempts + 1;
    const lastError = (err.message ?? 'unknown error').slice(0, 1000);

    this.logger.warn(
      `outbox event failed: id=${event.id} type=${event.event_type} attempt=${attempts}/${MAX_ATTEMPTS} error=${lastError}`,
    );

    if (attempts >= MAX_ATTEMPTS) {
      await em.update(
        OutboxEvent,
        { id: event.id },
        { attempts, last_error: lastError, status: OutboxStatus.DEAD },
      );
      // Use the in-scope event object directly. Reflect the just-applied DB
      // changes onto it so the alert payload shows attempts=5 / status=DEAD
      // rather than the pre-update values. This avoids a redundant findOne
      // and the failure path that introduced.
      event.attempts = attempts;
      event.last_error = lastError;
      event.status = OutboxStatus.DEAD;
      // Telegram is best-effort. A failed alert MUST NOT roll back the DEAD
      // transition — catch and swallow.
      try {
        await this.telegram.alertDeadOutboxEvent(event, lastError);
      } catch (alertErr) {
        this.logger.error(
          `failed to send DEAD-event Telegram alert: ${(alertErr as Error).message}`,
        );
      }
      this.logger.error(`outbox event ${event.id} marked DEAD after ${attempts} attempts`);
    } else {
      await em.update(
        OutboxEvent,
        { id: event.id },
        { attempts, last_error: lastError },
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Public surface for tests / admin
  // ---------------------------------------------------------------------------

  /**
   * Resets a DEAD or stuck event back to PENDING so the worker retries. Used
   * by the admin module after a human resolves the underlying root cause.
   * Not wired to an endpoint yet; exposed here for the future admin call.
   */
  async retryDead(eventId: string): Promise<void> {
    await this.outboxRepo.update(
      { id: eventId, status: OutboxStatus.DEAD },
      {
        status: OutboxStatus.PENDING,
        attempts: 0,
        last_error: null,
        processed_at: null,
      },
    );
  }
}
