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

// =============================================================================
// WebhookOrdersService — markFailedFromWebhook idempotency tests.
//
// Three guards layered in order:
//
//   1. order_status === FAILED → idempotent return (duplicate webhook
//      for already-failed order).
//   2. Post-payment race → log structured WARN + return 200 (stale
//      failure webhook for a settled order — no money moved, no
//      operator action needed).
//   3. State-machine assertion → throws on truly anomalous states
//      (DRAFT with a stripe_payment_id, which shouldn't happen).
//
// Pre-fix, only guard (1) existed. Guards (2) was missing — stale failure
// webhooks for PAID/ACCEPTED/REFUNDED/CANCELLED orders triggered the
// state-machine throw, returning 5xx to Stripe and triggering 3-day
// retry storms. Tests below pin guard (2) for each race sub-state.
// =============================================================================

describe('WebhookOrdersService — markFailedFromWebhook idempotency', () => {
  let service: WebhookOrdersService;
  let txGetOne: jest.Mock;
  let mockSave: jest.Mock;
  let mockInsert: jest.Mock;
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(async () => {
    txGetOne = jest.fn();
    mockSave = jest.fn().mockImplementation(async (entity) => entity);
    mockInsert = jest.fn().mockResolvedValue(undefined);

    const fakeQbSelect = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: txGetOne,
    };
    const fakeEm = {
      createQueryBuilder: jest.fn().mockImplementation(() => fakeQbSelect),
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

    warnSpy = jest
      .spyOn((service as unknown as { logger: { warn: (msg: string) => void } }).logger, 'warn')
      .mockImplementation(() => {});
    logSpy = jest
      .spyOn((service as unknown as { logger: { log: (msg: string) => void } }).logger, 'log')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Happy path — PENDING_PAYMENT → FAILED. No race fires.
  // ---------------------------------------------------------------------------

  describe('happy path: PENDING_PAYMENT → FAILED', () => {
    it('transitions the order, saves it, inserts order_events, logs info', async () => {
      const pendingOrder = makeOrder({
        order_status: OrderStatus.PENDING_PAYMENT,
        payment_status: PaymentStatus.REQUIRES_PAYMENT,
      });
      txGetOne.mockResolvedValueOnce(pendingOrder);

      const intent = makeFailedIntent({ code: 'card_declined', message: 'Your card was declined.' });
      await service.markFailedFromWebhook(intent, makeFailedEvent(), 'req-happy');

      // Order mutated to FAILED.
      expect(pendingOrder.order_status).toBe(OrderStatus.FAILED);
      expect(pendingOrder.payment_status).toBe(PaymentStatus.FAILED);
      expect(mockSave).toHaveBeenCalledWith(pendingOrder);

      // OrderEvent insert with the reason from last_payment_error.message.
      const orderEventCall = mockInsert.mock.calls.find((c) => c[0] === OrderEvent);
      expect(orderEventCall).toBeDefined();
      expect(orderEventCall![1]).toMatchObject({
        order_id: pendingOrder.id,
        from_status: OrderStatus.PENDING_PAYMENT,
        to_status: OrderStatus.FAILED,
        reason: 'Your card was declined.',
        created_by: 'stripe-webhook',
      });

      // No race WARN — happy path emits INFO via logger.log.
      expect(warnSpy).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Existing idempotency — FAILED → FAILED. Already-failed orders no-op.
  // ---------------------------------------------------------------------------

  describe('idempotency: order_status=FAILED', () => {
    it('returns early without mutating, saving, inserting, or warning', async () => {
      const alreadyFailed = makeOrder({
        order_status: OrderStatus.FAILED,
        payment_status: PaymentStatus.FAILED,
      });
      txGetOne.mockResolvedValueOnce(alreadyFailed);

      await service.markFailedFromWebhook(makeFailedIntent(), makeFailedEvent(), 'req-idem');

      expect(mockSave).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
      // No race log — this is the older guard, not the new post-payment one.
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // The fix — post-payment race detection. Five "after-success" sub-states
  // collapse under one race name; REFUNDED and CANCELLED each get their own.
  // ---------------------------------------------------------------------------

  describe('stale-failure-after-success race', () => {
    // The five downstream-of-PAID states. Operator response is identical
    // for all of them ("ignore the stale failure"), but the log line
    // preserves which sub-state the order was in for diagnostics.
    const subStates = [
      OrderStatus.PAID,
      OrderStatus.ACCEPTED,
      OrderStatus.IN_PROGRESS,
      OrderStatus.READY,
      OrderStatus.PICKED_UP,
    ];

    for (const subState of subStates) {
      it(`order_status=${subState}: no throw, structured WARN with stale-failure-after-success, no mutation, no outbox`, async () => {
        const settledOrder = makeOrder({
          order_status: subState,
          payment_status: PaymentStatus.SUCCEEDED,
        });
        txGetOne.mockResolvedValueOnce(settledOrder);

        await expect(
          service.markFailedFromWebhook(
            makeFailedIntent({ code: 'card_declined' }),
            makeFailedEvent(),
            'req-stale-success',
          ),
        ).resolves.toBeUndefined();

        // Single WARN log with the race details + actual sub-state preserved.
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const logged = warnSpy.mock.calls[0]![0] as string;
        expect(logged).toMatch(/race=stale-failure-after-success/);
        expect(logged).toMatch(new RegExp(`order ${settledOrder.id} is ${subState}`));
        expect(logged).toMatch(/stripe_event=evt_failed_test/);
        expect(logged).toMatch(/payment_intent=pi_test/);
        expect(logged).toMatch(/payment_status=SUCCEEDED/);
        expect(logged).toMatch(/request_id=req-stale-success/);

        // No order mutation, no DB writes — the order's truth is already correct.
        expect(settledOrder.order_status).toBe(subState);
        expect(settledOrder.payment_status).toBe(PaymentStatus.SUCCEEDED);
        expect(mockSave).not.toHaveBeenCalled();
        // No outbox emission (decision: no money moved, no operator action).
        expect(mockInsert).not.toHaveBeenCalled();
      });
    }
  });

  describe('stale-failure-after-refund race (REFUNDED)', () => {
    it('no throw, WARN with stale-failure-after-refund, no mutation, no outbox', async () => {
      const refundedOrder = makeOrder({
        order_status: OrderStatus.REFUNDED,
        payment_status: PaymentStatus.REFUNDED,
      });
      txGetOne.mockResolvedValueOnce(refundedOrder);

      await service.markFailedFromWebhook(makeFailedIntent(), makeFailedEvent(), 'req-refund');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toMatch(/race=stale-failure-after-refund/);
      expect(mockSave).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });

  describe('stale-failure-after-cancel race (CANCELLED)', () => {
    it('no throw, WARN with stale-failure-after-cancel, no mutation, no outbox', async () => {
      // CANCELLED can be either customer-cancel-during-PENDING_PAYMENT (per
      // A1, payment_status=REQUIRES_PAYMENT) or manager-cancel-after-PAID
      // (payment_status=SUCCEEDED). Either way the failure event is stale.
      const cancelledOrder = makeOrder({
        order_status: OrderStatus.CANCELLED,
        payment_status: PaymentStatus.REQUIRES_PAYMENT,
      });
      txGetOne.mockResolvedValueOnce(cancelledOrder);

      await service.markFailedFromWebhook(makeFailedIntent(), makeFailedEvent(), 'req-cancel');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toMatch(/race=stale-failure-after-cancel/);
      expect(mockSave).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Negative-coverage: missing orderId metadata + missing order row.
  // Both are pre-existing behaviors; pinned to prevent regression.
  // ---------------------------------------------------------------------------

  describe('negative coverage (pre-existing behavior)', () => {
    it('missing orderId metadata: warns and returns without entering the transaction', async () => {
      const intent = makeFailedIntent({});
      // Force metadata to {} to simulate the missing-orderId case.
      (intent as unknown as { metadata: Record<string, string> }).metadata = {};

      await service.markFailedFromWebhook(intent, makeFailedEvent(), 'req-no-id');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toMatch(/missing orderId metadata/);
      // No DS interactions at all — the early return short-circuits everything.
      expect(txGetOne).not.toHaveBeenCalled();
    });

    it('order not found: warns and returns without throwing', async () => {
      txGetOne.mockResolvedValueOnce(null);

      await service.markFailedFromWebhook(makeFailedIntent(), makeFailedEvent(), 'req-no-order');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toMatch(/unknown order/);
      expect(mockSave).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Test helpers (extended for failure tests)
// ---------------------------------------------------------------------------

function makeFailedIntent(
  errorOverrides: { code?: string; message?: string } = {},
): Stripe.PaymentIntent {
  return {
    id: 'pi_test',
    amount: 825,
    amount_received: 0,
    currency: 'usd',
    metadata: { orderId: 'order-id' },
    last_payment_error: errorOverrides.code || errorOverrides.message
      ? {
          code: errorOverrides.code ?? 'card_declined',
          message: errorOverrides.message ?? 'Generic decline',
          type: 'card_error',
        }
      : null,
    status: 'requires_payment_method',
  } as unknown as Stripe.PaymentIntent;
}

function makeFailedEvent(): Stripe.Event {
  return {
    id: 'evt_failed_test',
    type: 'payment_intent.payment_failed',
  } as unknown as Stripe.Event;
}

// ---------------------------------------------------------------------------
// Test helpers (existing — used by markPaidFromWebhook tests above)
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
