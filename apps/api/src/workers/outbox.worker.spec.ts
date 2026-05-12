import { ConfigService } from '@nestjs/config';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';

import { OutboxEvent, OutboxEventType } from '../database/entities';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { TelegramService } from '../modules/notifications/telegram.service';
import { OrderWorker } from './order.worker';
import { OutboxWorker } from './outbox.worker';

// =============================================================================
// OutboxWorker — dispatch routing tests (C4 wiring).
//
// SCOPE (intentionally narrow — focused on the C4 dispatch change):
//
//   - `dispatch()` routing decisions for every OutboxEventType.
//   - Error propagation from downstream handlers.
//   - Defensive-throw on unknown event types.
//
// UNCOVERED — known gaps left for follow-up test-coverage turns:
//
//   - The polling loop (`tick`, `setInterval`, `isProcessing` flag).
//   - `SELECT FOR UPDATE SKIP LOCKED` multi-pod safety.
//   - Batch processing semantics (one failed event doesn't affect the
//     rest of the batch).
//   - `attempts` lifecycle (increment on failure, retain on success).
//   - DEAD transition after MAX_ATTEMPTS retries.
//   - `processing_started_at` stuck-row recovery.
//   - `retryDead(eventId)` operator escape hatch.
//   - WORKERS_ENABLED env gate.
//   - Graceful shutdown (`shuttingDown` flag, in-flight tick drain).
//
// These deserve their own focused turn — the worker's tick logic is a
// substantial test surface in its own right, and conflating it with the
// dispatch routing change would dilute the C4 review. Same scope-narrowing
// pattern used in `checkout.service.spec.ts` (audit item #10 partial fix).
// =============================================================================

describe('OutboxWorker.dispatch — C4 routing', () => {
  let worker: OutboxWorker;
  let orderWorkerHandleOrderPaid: jest.Mock;
  let notificationsDispatch: jest.Mock;

  beforeEach(async () => {
    orderWorkerHandleOrderPaid = jest.fn().mockResolvedValue(undefined);
    notificationsDispatch = jest.fn().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        OutboxWorker,
        // The worker doesn't actually call the DataSource or the outbox
        // repo inside `dispatch()` (those are used by `tick()` which is
        // out of scope for this spec). Stubs are enough to satisfy DI.
        { provide: getDataSourceToken(), useValue: { transaction: jest.fn() } },
        { provide: getRepositoryToken(OutboxEvent), useValue: {} },
        {
          provide: OrderWorker,
          useValue: { handleOrderPaid: orderWorkerHandleOrderPaid },
        },
        {
          provide: TelegramService,
          useValue: { alertDeadOutboxEvent: jest.fn() },
        },
        {
          provide: NotificationsService,
          useValue: { dispatch: notificationsDispatch },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
      ],
    }).compile();

    worker = moduleRef.get(OutboxWorker);
  });

  // ---------------------------------------------------------------------------
  // Helper — invoke the private `dispatch(event)` method. Tests target the
  // routing logic directly rather than driving it via `tick()`, which would
  // require mocking the polling + batch + transaction layers (out of scope).
  // ---------------------------------------------------------------------------

  function callDispatch(eventType: OutboxEventType, payload: Record<string, unknown> = {}): Promise<void> {
    const event = {
      id: 'evt-1',
      event_type: eventType,
      payload,
      status: 'PENDING',
      attempts: 0,
    } as unknown as OutboxEvent;
    return (worker as unknown as { dispatch: (e: OutboxEvent) => Promise<void> }).dispatch(event);
  }

  // ---------------------------------------------------------------------------
  // ORDER_PAID — analytics route (unchanged by C4; regression guard).
  // ---------------------------------------------------------------------------

  describe('ORDER_PAID', () => {
    it('routes to orderWorker.handleOrderPaid with the payload (analytics path)', async () => {
      const payload = { orderId: 'o-1', customerId: 'c-1', totalCents: 825 };
      await callDispatch(OutboxEventType.ORDER_PAID, payload);

      expect(orderWorkerHandleOrderPaid).toHaveBeenCalledTimes(1);
      expect(orderWorkerHandleOrderPaid).toHaveBeenCalledWith(payload);
      // NotificationsService is NOT called for ORDER_PAID — that's
      // analytics-only. ORDER_PAID_NOTIFICATION is the alert sibling.
      expect(notificationsDispatch).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // ORDER_PAID_NOTIFICATION + the five non-PAID events route to
  // notifications.dispatch. Parameterized.
  // ---------------------------------------------------------------------------

  describe('notifications.dispatch routing', () => {
    const notificationEvents: OutboxEventType[] = [
      OutboxEventType.ORDER_PAID_NOTIFICATION,
      OutboxEventType.ORDER_CANCELLED,
      OutboxEventType.ORDER_READY,
      OutboxEventType.ORDER_PICKED_UP,
      OutboxEventType.REFUND_CREATED,
      OutboxEventType.ITEM_OUT_OF_STOCK,
    ];

    for (const eventType of notificationEvents) {
      it(`${eventType} routes to notifications.dispatch with the eventType + payload`, async () => {
        const payload = { orderId: 'o-1', some_field: 'value' };
        await callDispatch(eventType, payload);

        expect(notificationsDispatch).toHaveBeenCalledTimes(1);
        expect(notificationsDispatch).toHaveBeenCalledWith(eventType, payload);
        // orderWorker is NOT called for any of these. Analytics-vs-alert
        // separation is the point of the C5 split-event design.
        expect(orderWorkerHandleOrderPaid).not.toHaveBeenCalled();
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Unknown event type — defensive throw (existing behavior, regression
  // guard). The throw propagates up to `processOne` which increments
  // `attempts` → eventual DEAD transition.
  // ---------------------------------------------------------------------------

  describe('unknown event type', () => {
    it('throws so the outbox event retries and surfaces as DEAD', async () => {
      // Forced cast simulates a corrupted runtime value (e.g., a stale row
      // with an enum string that was removed in a later migration).
      await expect(
        callDispatch('TOTALLY_UNKNOWN_EVENT' as unknown as OutboxEventType),
      ).rejects.toThrow(/Unknown outbox event type: TOTALLY_UNKNOWN_EVENT/);

      // No downstream handler ran.
      expect(orderWorkerHandleOrderPaid).not.toHaveBeenCalled();
      expect(notificationsDispatch).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Error propagation — handler errors propagate so `processOne`'s try/catch
  // can run the retry/DEAD path. If dispatch silently swallowed errors,
  // broken handlers would never surface as DEAD events.
  // ---------------------------------------------------------------------------

  describe('error propagation', () => {
    it('notifications.dispatch errors propagate (so retry/DEAD path runs)', async () => {
      notificationsDispatch.mockRejectedValueOnce(
        new Error('Telegram API unreachable'),
      );

      await expect(
        callDispatch(OutboxEventType.ORDER_READY, { orderId: 'o-1' }),
      ).rejects.toThrow(/Telegram API unreachable/);
    });

    it('orderWorker.handleOrderPaid errors propagate (same retry contract)', async () => {
      orderWorkerHandleOrderPaid.mockRejectedValueOnce(
        new Error('analytics DB error'),
      );

      await expect(
        callDispatch(OutboxEventType.ORDER_PAID, { orderId: 'o-1' }),
      ).rejects.toThrow(/analytics DB error/);
    });
  });
});
