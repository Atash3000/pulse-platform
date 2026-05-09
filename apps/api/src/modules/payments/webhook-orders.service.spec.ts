import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import type Stripe from 'stripe';

import {
  Order,
  OrderEvent,
  OrderStatus,
  OutboxEvent,
  OutboxEventType,
  OutboxStatus,
  PaymentStatus,
} from '../../database/entities';
import { WebhookOrdersService } from './webhook-orders.service';

// =============================================================================
// WebhookOrdersService — race-condition tests for markPaidFromWebhook.
//
// Three races to defend against (see decision-log "Webhook-after-state-change
// races"). For each, the webhook handler MUST:
//
//   - return 200 to Stripe (no throw → Stripe stops retrying)
//   - log the race with full diagnostic detail
//   - emit a REFUND_CREATED outbox row for CANCELLED + FAILED only
//     (REFUNDED is terminal — already refunded, nothing to surface)
//   - leave order_status unchanged (the race-state IS the truth — manager
//     intervention via /admin/orders/:id/refund handles the refund)
//
// Without this defence, OrderStateMachine.assertTransition rejects the
// transition and the webhook returns 5xx → Stripe retries every few minutes
// for THREE DAYS. Real customer money sits unresolved while the outbox is
// silent.
// =============================================================================

describe('WebhookOrdersService — markPaidFromWebhook race detection', () => {
  let service: WebhookOrdersService;
  let txGetOne: jest.Mock;
  let mockSave: jest.Mock;
  let mockInsert: jest.Mock;
  let mockQbInsert: jest.Mock;
  let warnSpy: jest.SpyInstance;

  beforeEach(async () => {
    txGetOne = jest.fn();
    mockSave = jest.fn();
    mockInsert = jest.fn();
    mockQbInsert = jest.fn();

    // Mock the SELECT FOR UPDATE chain
    const fakeQbSelect = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: txGetOne,
    };
    // Mock the INSERT INTO Payment chain (.createQueryBuilder().insert().into().values().orIgnore().execute())
    const fakeQbInsert = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute: mockQbInsert,
    };
    const fakeEm = {
      // The service calls createQueryBuilder() two ways:
      //   1. createQueryBuilder(Order, 'o') → SELECT FOR UPDATE
      //   2. createQueryBuilder() (no args)  → INSERT INTO Payment
      createQueryBuilder: jest.fn().mockImplementation((arg?: unknown) =>
        arg === Order ? fakeQbSelect : fakeQbInsert,
      ),
      save: mockSave,
      insert: mockInsert,
    };
    const fakeDs = {
      transaction: jest
        .fn()
        .mockImplementation(async (cb: (em: typeof fakeEm) => unknown) => cb(fakeEm)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        WebhookOrdersService,
        { provide: getDataSourceToken(), useValue: fakeDs },
      ],
    }).compile();
    service = moduleRef.get(WebhookOrdersService);

    // Capture WARN logs for race-detection assertions. Restore in afterEach.
    warnSpy = jest
      .spyOn((service as unknown as { logger: { warn: (msg: string) => void } }).logger, 'warn')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Cancel-after-pay race (A1+A2 mitigation)
  // ---------------------------------------------------------------------------

  describe('cancel-after-pay race (order_status = CANCELLED)', () => {
    const cancelledOrder = makeOrder({
      order_status: OrderStatus.CANCELLED,
      // payment_status is REQUIRES_PAYMENT here — not SUCCEEDED — so the
      // existing idempotency early-return does NOT fire. The new race branch
      // is what catches us.
      payment_status: PaymentStatus.REQUIRES_PAYMENT,
    });

    it('does not throw — returns 200 to Stripe', async () => {
      txGetOne.mockResolvedValueOnce(cancelledOrder);
      await expect(
        service.markPaidFromWebhook(makeIntent(), makeEvent(), 'req-1'),
      ).resolves.toBeUndefined();
    });

    it('emits a structured warn log identifying the race', async () => {
      txGetOne.mockResolvedValueOnce(cancelledOrder);
      await service.markPaidFromWebhook(makeIntent(), makeEvent(), 'req-1');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logLine = warnSpy.mock.calls[0]![0] as string;
      expect(logLine).toContain('webhook race detected');
      expect(logLine).toContain('race=cancel-after-pay');
      expect(logLine).toContain('stripe_event=evt_test');
      expect(logLine).toContain('payment_intent=pi_test');
      expect(logLine).toContain('amount_received=825');
      expect(logLine).toContain('request_id=req-1');
    });

    it('inserts a REFUND_CREATED outbox row with the race metadata', async () => {
      txGetOne.mockResolvedValueOnce(cancelledOrder);
      await service.markPaidFromWebhook(makeIntent(), makeEvent(), 'req-1');

      // The single outbox insert is the only em.insert() call in this branch.
      expect(mockInsert).toHaveBeenCalledTimes(1);
      const [entity, payload] = mockInsert.mock.calls[0]!;
      expect(entity).toBe(OutboxEvent);
      expect(payload).toMatchObject({
        event_type: OutboxEventType.REFUND_CREATED,
        status: OutboxStatus.PENDING,
        attempts: 0,
      });
      expect(payload.payload).toMatchObject({
        orderId: cancelledOrder.id,
        customerId: cancelledOrder.customer_id,
        locationId: cancelledOrder.location_id,
        amountCents: 825,
        currency: 'usd',
        stripePaymentIntentId: 'pi_test',
        stripeEventId: 'evt_test',
        requestId: 'req-1',
        raceType: 'cancel-after-pay',
        orderStatusAtRace: OrderStatus.CANCELLED,
        paymentStatusAtRace: PaymentStatus.REQUIRES_PAYMENT,
        actionRequired: 'manager-refund-via-admin-endpoint',
      });
    });

    it('does NOT mutate the order or insert a payments row or order_event', async () => {
      txGetOne.mockResolvedValueOnce(cancelledOrder);
      await service.markPaidFromWebhook(makeIntent(), makeEvent(), 'req-1');

      // No order save (em.save) — order_status stays CANCELLED, payment_status untouched.
      expect(mockSave).not.toHaveBeenCalled();
      // The Payment INSERT path uses createQueryBuilder().insert()...execute().
      // execute() is mockQbInsert — should NOT have been called in the race branch.
      expect(mockQbInsert).not.toHaveBeenCalled();
      // The audit-trail OrderEvent insert isn't fired either; only the
      // outbox row was inserted.
      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockInsert.mock.calls[0]![0]).not.toBe(OrderEvent);
    });
  });

  // ---------------------------------------------------------------------------
  // Cleanup-after-pay race (A2 mitigation)
  // ---------------------------------------------------------------------------

  describe('cleanup-after-pay race (order_status = FAILED)', () => {
    const failedOrder = makeOrder({
      order_status: OrderStatus.FAILED,
      payment_status: PaymentStatus.FAILED,
    });

    it('does not throw — returns 200 to Stripe', async () => {
      txGetOne.mockResolvedValueOnce(failedOrder);
      await expect(
        service.markPaidFromWebhook(makeIntent(), makeEvent(), 'req-2'),
      ).resolves.toBeUndefined();
    });

    it('emits a structured warn log identifying the race', async () => {
      txGetOne.mockResolvedValueOnce(failedOrder);
      await service.markPaidFromWebhook(makeIntent(), makeEvent(), 'req-2');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logLine = warnSpy.mock.calls[0]![0] as string;
      expect(logLine).toContain('webhook race detected');
      expect(logLine).toContain('race=cleanup-after-pay');
    });

    it('inserts a REFUND_CREATED outbox row with raceType=cleanup-after-pay', async () => {
      txGetOne.mockResolvedValueOnce(failedOrder);
      await service.markPaidFromWebhook(makeIntent(), makeEvent(), 'req-2');

      expect(mockInsert).toHaveBeenCalledTimes(1);
      const payload = mockInsert.mock.calls[0]![1];
      expect(payload.event_type).toBe(OutboxEventType.REFUND_CREATED);
      expect(payload.payload.raceType).toBe('cleanup-after-pay');
      expect(payload.payload.orderStatusAtRace).toBe(OrderStatus.FAILED);
    });
  });

  // ---------------------------------------------------------------------------
  // Post-refund-success edge case
  // ---------------------------------------------------------------------------

  describe('post-refund-success race (order_status = REFUNDED)', () => {
    const refundedOrder = makeOrder({
      order_status: OrderStatus.REFUNDED,
      payment_status: PaymentStatus.REFUNDED,
    });

    it('does not throw and emits a warn log', async () => {
      txGetOne.mockResolvedValueOnce(refundedOrder);
      await expect(
        service.markPaidFromWebhook(makeIntent(), makeEvent(), 'req-3'),
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toContain('race=post-refund-success');
    });

    it('does NOT emit a REFUND_CREATED outbox row (already refunded — nothing to surface)', async () => {
      txGetOne.mockResolvedValueOnce(refundedOrder);
      await service.markPaidFromWebhook(makeIntent(), makeEvent(), 'req-3');
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Negative — the existing idempotency path is still preferred over the race
  // path. payment_status=SUCCEEDED + any order_status returns the simple
  // "already SUCCEEDED" no-op, NOT a race-detection log.
  // ---------------------------------------------------------------------------

  describe('idempotency vs race precedence', () => {
    it('payment_status=SUCCEEDED short-circuits BEFORE the race branch', async () => {
      // An order that's already SUCCEEDED but somehow ALSO CANCELLED could
      // theoretically exist if a manager cancel ran post-PAID without a refund.
      // The existing idempotency check should fire first and skip the race path.
      const cursedOrder = makeOrder({
        order_status: OrderStatus.CANCELLED,
        payment_status: PaymentStatus.SUCCEEDED,
      });
      txGetOne.mockResolvedValueOnce(cursedOrder);

      await service.markPaidFromWebhook(makeIntent(), makeEvent(), 'req-4');

      // No race log — the idempotent path emitted its own log.
      expect(warnSpy).not.toHaveBeenCalled();
      // No outbox insert.
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeOrder(overrides: Partial<Order> = {}): Order {
  return Object.assign(
    {
      id: 'order-id',
      customer_id: 'cust-1',
      location_id: 'loc-1',
      idempotency_key: 'idem-1',
      order_status: OrderStatus.PENDING_PAYMENT,
      payment_status: PaymentStatus.REQUIRES_PAYMENT,
      pickup_type: 'ASAP',
      subtotal_cents: 650,
      modifier_cents: 0,
      discount_cents: 0,
      tax_cents: 58,
      tip_cents: 117,
      total_cents: 825,
      stripe_payment_id: 'pi_test',
      created_at: new Date(),
      updated_at: new Date(),
    },
    overrides,
  ) as unknown as Order;
}

function makeIntent(overrides: Partial<Stripe.PaymentIntent> = {}): Stripe.PaymentIntent {
  return {
    id: 'pi_test',
    amount: 825,
    amount_received: 825,
    currency: 'usd',
    metadata: { orderId: 'order-id' },
    ...overrides,
  } as unknown as Stripe.PaymentIntent;
}

function makeEvent(): Stripe.Event {
  return {
    id: 'evt_test',
    type: 'payment_intent.succeeded',
  } as unknown as Stripe.Event;
}
