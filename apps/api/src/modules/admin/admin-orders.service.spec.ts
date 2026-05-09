import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';

import {
  Customer,
  LocationSettings,
  Order,
  OrderEvent,
  OrderItem,
  OrderStatus,
  OutboxEvent,
  OutboxEventType,
  Payment,
  PaymentStatus,
  PickupType,
  Refund,
} from '../../database/entities';
import { StripeService } from '../payments/stripe.service';
import { AdminOrdersService } from './admin-orders.service';
import type { StaffContext } from './staff-context';

// =============================================================================
// AdminOrdersService.accept — pickup-type-aware estimated_ready_at handling.
//
// Two invariants pinned by these tests:
//
//   ASAP       → estimated_ready_at MUST equal now + current_wait_minutes.
//                LocationSettings.findOne MUST be called exactly once.
//
//   SCHEDULED  → estimated_ready_at MUST be untouched (set once at checkout
//                from canAcceptOrders' scheduled-time branch).
//                LocationSettings.findOne MUST NOT be called.
//
// In both cases, an order_events row is still written — the fix is scoped
// to the estimated_ready_at field, not the audit trail.
// =============================================================================

const STAFF: StaffContext = {
  staff_user_id: 'staff-1',
  location_id: 'loc-1',
  role: 'BARISTA',
};

describe('AdminOrdersService.accept', () => {
  let service: AdminOrdersService;
  let txGetOne: jest.Mock;
  let mockSave: jest.Mock;
  let mockInsert: jest.Mock;
  let settingsFindOne: jest.Mock;

  beforeEach(async () => {
    txGetOne = jest.fn();
    mockSave = jest.fn().mockImplementation(async (entity) => entity);
    mockInsert = jest.fn().mockResolvedValue(undefined);
    settingsFindOne = jest.fn();

    // SELECT FOR UPDATE chain used by lockedFetch
    const fakeSelectQb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: txGetOne,
    };

    // The service's afterUpdate callback uses em.findOne(LocationSettings, ...)
    // to read current_wait_minutes. We expose findOne on the fake em and
    // delegate to settingsFindOne so the test can assert call count.
    const fakeEm = {
      createQueryBuilder: jest.fn().mockReturnValue(fakeSelectQb),
      save: mockSave,
      insert: mockInsert,
      findOne: jest.fn().mockImplementation((entity: unknown) => {
        if (entity === LocationSettings) return settingsFindOne();
        return Promise.resolve(null);
      }),
    };
    const fakeDs = {
      transaction: jest.fn().mockImplementation(
        async (cb: (em: typeof fakeEm) => unknown) => cb(fakeEm),
      ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminOrdersService,
        { provide: getDataSourceToken(), useValue: fakeDs },
        // The other repos are required by the constructor but unused by accept().
        { provide: getRepositoryToken(Order), useValue: {} },
        { provide: getRepositoryToken(OrderItem), useValue: {} },
        { provide: getRepositoryToken(OrderEvent), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(Customer), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(LocationSettings), useValue: {} },
        { provide: getRepositoryToken(Payment), useValue: {} },
        { provide: getRepositoryToken(Refund), useValue: {} },
        { provide: StripeService, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(AdminOrdersService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ---------------------------------------------------------------------------
  // Test 1: ASAP path — recompute estimated_ready_at = now + wait_minutes.
  // jest.useFakeTimers() pins "now" so the assertion is exact.
  // ---------------------------------------------------------------------------

  it('ASAP: sets estimated_ready_at to exactly now + current_wait_minutes', async () => {
    const fixedNow = new Date('2026-05-09T14:00:00.000Z');
    jest.useFakeTimers();
    jest.setSystemTime(fixedNow);

    const orderRef = makeOrder({
      pickup_type: PickupType.ASAP,
      estimated_ready_at: null, // ASAP orders may have null at this point
    });
    txGetOne.mockResolvedValueOnce(orderRef);
    settingsFindOne.mockResolvedValueOnce({ current_wait_minutes: 7 });

    const returned = await service.accept(STAFF, orderRef.id);

    // Exact arithmetic — fake timers pin Date.now().
    const expectedReadyAt = new Date('2026-05-09T14:07:00.000Z');
    expect(orderRef.estimated_ready_at).toEqual(expectedReadyAt);
    expect(returned.estimated_ready_at).toEqual(expectedReadyAt);

    // Status flipped, save called with the mutated order.
    expect(orderRef.order_status).toBe(OrderStatus.ACCEPTED);
    expect(mockSave).toHaveBeenCalledWith(orderRef);
  });

  it('ASAP: defaults to 5-minute wait when LocationSettings row is missing', async () => {
    const fixedNow = new Date('2026-05-09T14:00:00.000Z');
    jest.useFakeTimers();
    jest.setSystemTime(fixedNow);

    const orderRef = makeOrder({ pickup_type: PickupType.ASAP });
    txGetOne.mockResolvedValueOnce(orderRef);
    settingsFindOne.mockResolvedValueOnce(null); // no settings row

    await service.accept(STAFF, orderRef.id);

    expect(orderRef.estimated_ready_at).toEqual(new Date('2026-05-09T14:05:00.000Z'));
  });

  // ---------------------------------------------------------------------------
  // Test 2: SCHEDULED path — leave estimated_ready_at untouched.
  // ---------------------------------------------------------------------------

  it('SCHEDULED: leaves estimated_ready_at exactly as it was set at checkout', async () => {
    // The customer chose a 2pm pickup at checkout. Staff is accepting at
    // 8:50am (early prep). The buggy code would overwrite to 8:55am.
    const fixedNow = new Date('2026-05-09T08:50:00.000Z');
    const scheduledTime = new Date('2026-05-09T14:00:00.000Z');
    jest.useFakeTimers();
    jest.setSystemTime(fixedNow);

    const orderRef = makeOrder({
      pickup_type: PickupType.SCHEDULED,
      scheduled_pickup_at: scheduledTime,
      estimated_ready_at: scheduledTime,
    });
    txGetOne.mockResolvedValueOnce(orderRef);

    await service.accept(STAFF, orderRef.id);

    // Field equals the original timestamp exactly — not overwritten.
    expect(orderRef.estimated_ready_at).toEqual(scheduledTime);
    // Status still flipped to ACCEPTED.
    expect(orderRef.order_status).toBe(OrderStatus.ACCEPTED);
  });

  // ---------------------------------------------------------------------------
  // Test 3: SCHEDULED short-circuits BEFORE LocationSettings lookup. The
  // findOne call is the smoking gun for the bug — if the branch is removed
  // or inverted, this assertion catches it even if estimated_ready_at
  // happens to land on the same value by coincidence.
  // ---------------------------------------------------------------------------

  it('SCHEDULED: does NOT call LocationSettings.findOne (current_wait_minutes is irrelevant)', async () => {
    const orderRef = makeOrder({
      pickup_type: PickupType.SCHEDULED,
      scheduled_pickup_at: new Date('2026-05-09T14:00:00.000Z'),
      estimated_ready_at: new Date('2026-05-09T14:00:00.000Z'),
    });
    txGetOne.mockResolvedValueOnce(orderRef);

    await service.accept(STAFF, orderRef.id);

    expect(settingsFindOne).not.toHaveBeenCalled();
  });

  it('ASAP: calls LocationSettings.findOne exactly once', async () => {
    const orderRef = makeOrder({ pickup_type: PickupType.ASAP });
    txGetOne.mockResolvedValueOnce(orderRef);
    settingsFindOne.mockResolvedValueOnce({ current_wait_minutes: 5 });

    await service.accept(STAFF, orderRef.id);

    expect(settingsFindOne).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Test 4: order_events audit row is still inserted for both pickup types.
  // The fix is scoped to estimated_ready_at; the audit trail must NOT regress.
  // ---------------------------------------------------------------------------

  describe('order_events audit row is written for both pickup types', () => {
    it('ASAP — inserts order_events with from=PAID to=ACCEPTED', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-05-09T14:00:00.000Z'));

      const orderRef = makeOrder({ pickup_type: PickupType.ASAP });
      txGetOne.mockResolvedValueOnce(orderRef);
      settingsFindOne.mockResolvedValueOnce({ current_wait_minutes: 5 });

      await service.accept(STAFF, orderRef.id);

      expect(mockInsert).toHaveBeenCalledWith(
        OrderEvent,
        expect.objectContaining({
          order_id: orderRef.id,
          from_status: OrderStatus.PAID,
          to_status: OrderStatus.ACCEPTED,
          created_by: STAFF.staff_user_id,
        }),
      );
    });

    it('SCHEDULED — also inserts order_events with from=PAID to=ACCEPTED', async () => {
      const orderRef = makeOrder({
        pickup_type: PickupType.SCHEDULED,
        scheduled_pickup_at: new Date('2026-05-09T14:00:00.000Z'),
        estimated_ready_at: new Date('2026-05-09T14:00:00.000Z'),
      });
      txGetOne.mockResolvedValueOnce(orderRef);

      await service.accept(STAFF, orderRef.id);

      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockInsert).toHaveBeenCalledWith(
        OrderEvent,
        expect.objectContaining({
          order_id: orderRef.id,
          from_status: OrderStatus.PAID,
          to_status: OrderStatus.ACCEPTED,
          created_by: STAFF.staff_user_id,
        }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Test helper — minimal Order matching what lockedFetch returns. The fields
// not listed are unused by accept().
// ---------------------------------------------------------------------------

function makeOrder(overrides: Partial<Order> = {}): Order {
  return Object.assign(
    {
      id: 'order-1',
      customer_id: 'cust-1',
      location_id: STAFF.location_id, // matches staff so lockedFetch passes
      idempotency_key: 'idem-1',
      // accept() is only valid from PAID per the state machine.
      order_status: OrderStatus.PAID,
      payment_status: PaymentStatus.SUCCEEDED,
      clover_sync_status: 'NOT_SENT',
      pickup_type: PickupType.ASAP,
      scheduled_pickup_at: null,
      estimated_ready_at: null,
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

// =============================================================================
// AdminOrdersService.refund — three-phase flow.
//
// Pinned invariants (see decision-log entry "Refund pre-validation before
// Stripe call: avoid money out with no DB record"):
//
//   - Every reject path runs in Phase 1, BEFORE Stripe is touched. Tests
//     explicitly assert Stripe.createRefund was NEVER called on rejection.
//   - Cumulative refund tracking: existing refunds + this refund must not
//     exceed total_cents (A6). isFullRefund is the cumulative version (A7).
//   - Stripe call carries an idempotency key
//     `refund-{orderId}-{amount}-{floor(now/60000)}` (A8).
//   - A race between Phase 1's unlocked check and Phase 3's locked re-check
//     produces a logged + outboxed REFUND_CREATED with
//     metadata.error='race-with-concurrent-refund' and DOES NOT throw to
//     the caller (Stripe already moved money).
// =============================================================================

describe('AdminOrdersService.refund', () => {
  let service: AdminOrdersService;
  let txGetOneOrder: jest.Mock;        // lockedFetch order
  let mockSave: jest.Mock;
  let mockInsert: jest.Mock;
  let phase1SumGetRawOne: jest.Mock;   // Phase 1 cumulative refund sum
  let phase3SumGetRawOne: jest.Mock;   // Phase 3 in-tx cumulative refund sum
  let ordersFindOne: jest.Mock;        // Phase 1 order load
  let paymentsFindOne: jest.Mock;      // Phase 1 payments row check
  let createRefundMock: jest.Mock;
  let logErrorSpy: jest.SpyInstance;

  beforeEach(async () => {
    txGetOneOrder = jest.fn();
    mockSave = jest.fn().mockImplementation(async (entity) => entity);
    mockInsert = jest.fn().mockResolvedValue(undefined);
    phase1SumGetRawOne = jest.fn();
    phase3SumGetRawOne = jest.fn();
    ordersFindOne = jest.fn();
    paymentsFindOne = jest.fn();
    createRefundMock = jest.fn();

    // Phase 1's sumRefundsForOrder uses this.refunds.createQueryBuilder('r')
    // → select → where → getRawOne. Mock the chain.
    const phase1RefundsQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: phase1SumGetRawOne,
    };

    // Phase 3 SELECT FOR UPDATE on Order via em.createQueryBuilder(Order, 'o')
    const fakeOrderSelectQb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: txGetOneOrder,
    };
    // Phase 3 sumRefundsForOrderInTx via em.createQueryBuilder(Refund, 'r')
    const phase3RefundsQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getRawOne: phase3SumGetRawOne,
    };
    // The em's createQueryBuilder is overloaded — branch on the first arg.
    const fakeEm = {
      createQueryBuilder: jest.fn().mockImplementation((entity?: unknown) => {
        if (entity === Refund) return phase3RefundsQb;
        // default: assume Order (lockedFetch)
        return fakeOrderSelectQb;
      }),
      save: mockSave,
      insert: mockInsert,
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((_entity: unknown, dto: unknown) => dto),
    };
    const fakeDs = {
      transaction: jest.fn().mockImplementation(
        async (cb: (em: typeof fakeEm) => unknown) => cb(fakeEm),
      ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminOrdersService,
        { provide: getDataSourceToken(), useValue: fakeDs },
        { provide: getRepositoryToken(Order), useValue: { findOne: ordersFindOne } },
        { provide: getRepositoryToken(OrderItem), useValue: {} },
        { provide: getRepositoryToken(OrderEvent), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(Customer), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(LocationSettings), useValue: {} },
        {
          provide: getRepositoryToken(Refund),
          useValue: { createQueryBuilder: jest.fn().mockReturnValue(phase1RefundsQb) },
        },
        {
          provide: getRepositoryToken(Payment),
          useValue: { findOne: paymentsFindOne },
        },
        { provide: StripeService, useValue: { createRefund: createRefundMock } },
      ],
    }).compile();

    service = moduleRef.get(AdminOrdersService);

    logErrorSpy = jest
      .spyOn(
        (service as unknown as { logger: { error: (msg: string) => void } }).logger,
        'error',
      )
      .mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    logErrorSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Test 1 — Pre-validation rejects refund on a FAILED order.
  //
  // FAILED is terminal in the state machine (no outgoing transitions).
  // A full refund attempt should run the assertTransition check in Phase 1
  // and throw BEFORE Stripe is called.
  // ---------------------------------------------------------------------------

  it('Phase 1 rejects refund on a FAILED order without calling Stripe', async () => {
    const order = makeOrder({
      order_status: OrderStatus.FAILED,
      payment_status: PaymentStatus.FAILED,
    });
    ordersFindOne.mockResolvedValueOnce(order);
    phase1SumGetRawOne.mockResolvedValueOnce({ total: '0' });
    paymentsFindOne.mockResolvedValueOnce({ id: 'pay-1', stripe_payment_id: order.stripe_payment_id });

    await expect(
      service.refund(STAFF, order.id, 'fraud claim', order.total_cents),
    ).rejects.toThrow(/INVALID_TRANSITION|terminal|cannot transition/i);

    expect(createRefundMock).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Test 2 — refundAmount > total_cents.
  // ---------------------------------------------------------------------------

  it('Phase 1 rejects refund whose amount exceeds total_cents without calling Stripe', async () => {
    const order = makeOrder({
      order_status: OrderStatus.PAID,
      total_cents: 825,
    });
    ordersFindOne.mockResolvedValueOnce(order);

    await expect(
      service.refund(STAFF, order.id, 'overcharge', 900),
    ).rejects.toThrow(/positive integer between 1 and 825/);

    expect(createRefundMock).not.toHaveBeenCalled();
    // amount check happens before sumRefundsForOrder, so the sum query
    // should not have been executed either
    expect(phase1SumGetRawOne).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Test 3 — Cumulative refund check (A6).
  //
  // Order total $20, prior refunds $15. Attempt $10 → cumulative $25 > $20.
  // Reject in Phase 1 with no Stripe call.
  // ---------------------------------------------------------------------------

  it('Phase 1 rejects refund where existing + attempted exceeds total_cents', async () => {
    const order = makeOrder({
      order_status: OrderStatus.PICKED_UP,
      total_cents: 2000,
    });
    ordersFindOne.mockResolvedValueOnce(order);
    phase1SumGetRawOne.mockResolvedValueOnce({ total: '1500' }); // $15 already refunded

    await expect(
      service.refund(STAFF, order.id, 'spillage', 1000),
    ).rejects.toThrow(/exceed remaining refundable.*already refunded: 1500.*remaining: 500/s);

    expect(createRefundMock).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Test 4 — Cumulative full refund (A7).
  //
  // Order total $20, prior $10 partial refund. Manager submits $10. The
  // CUMULATIVE total reaches $20 → isFullRefund=true → order_status flips
  // to REFUNDED. Without A7, the previous code would have computed
  // isFullRefund as (10 === 2000) which is false, leaving the order stuck
  // in PARTIALLY_REFUNDED forever.
  // ---------------------------------------------------------------------------

  it('Cumulative full refund: prior $10 partial + new $10 on a $20 order → order_status flips to REFUNDED', async () => {
    const order = makeOrder({
      id: 'order-A7-full',
      order_status: OrderStatus.PICKED_UP,
      payment_status: PaymentStatus.PARTIALLY_REFUNDED,
      total_cents: 2000,
    });
    ordersFindOne.mockResolvedValueOnce(order);
    phase1SumGetRawOne.mockResolvedValueOnce({ total: '1000' });
    paymentsFindOne.mockResolvedValueOnce({ id: 'pay-1', stripe_payment_id: order.stripe_payment_id });
    createRefundMock.mockResolvedValueOnce({ id: 're_full_test' });
    txGetOneOrder.mockResolvedValueOnce(order);
    phase3SumGetRawOne.mockResolvedValueOnce({ total: '1000' }); // unchanged in lock

    const result = await service.refund(STAFF, order.id, 'final refund', 1000);

    // Order mutated to REFUNDED
    expect(order.order_status).toBe(OrderStatus.REFUNDED);
    expect(order.payment_status).toBe(PaymentStatus.REFUNDED);
    // Returned object reflects the same — narrow the discriminated union first.
    if (result.status !== 'committed') {
      throw new Error(
        `expected status='committed' but got status='${result.status}'`,
      );
    }
    expect(result.order.order_status).toBe(OrderStatus.REFUNDED);
    // The Phase 3 OrderEvent insert should record full_refund=true and the
    // cumulative total.
    const orderEventInsert = mockInsert.mock.calls.find(
      (c) => c[0] === OrderEvent,
    );
    expect(orderEventInsert?.[1].metadata).toMatchObject({
      full_refund: true,
      cumulative_refunded_cents: 2000,
    });

    // Outbox payload semantics for cumulative-full: refundType must
    // distinguish this from a one-shot full refund so downstream notifications
    // can word the receipt correctly ("your final refund" vs "your refund").
    const refundOutboxInsert = mockInsert.mock.calls.find(
      (c) =>
        c[0] === OutboxEvent &&
        c[1].event_type === OutboxEventType.REFUND_CREATED,
    );
    expect(refundOutboxInsert).toBeDefined();
    expect(refundOutboxInsert![1].payload).toMatchObject({
      orderId: order.id,
      amountCents: 1000,
      stripeRefundId: 're_full_test',
      isCumulativelyFull: true,
      cumulativeRefundedCents: 2000,
      refundType: 'cumulative-full',
      // backward-compatible alias retained until downstream subscribers cut
      // over to refundType / isCumulativelyFull
      fullRefund: true,
    });
  });

  // ---------------------------------------------------------------------------
  // Test 4b — Single-full refund (no priors).
  //
  // Order $20, no prior refunds, manager refunds $20 → refundType=single-full.
  // Pinned alongside the cumulative-full test so the two cases cannot
  // accidentally produce the same outbox shape.
  // ---------------------------------------------------------------------------

  it('Single-full refund: refundType="single-full" when no prior partials existed', async () => {
    const order = makeOrder({
      id: 'order-single-full',
      order_status: OrderStatus.PICKED_UP,
      payment_status: PaymentStatus.SUCCEEDED,
      total_cents: 2000,
    });
    ordersFindOne.mockResolvedValueOnce(order);
    phase1SumGetRawOne.mockResolvedValueOnce({ total: '0' });
    paymentsFindOne.mockResolvedValueOnce({ id: 'pay-1', stripe_payment_id: order.stripe_payment_id });
    createRefundMock.mockResolvedValueOnce({ id: 're_single_full' });
    txGetOneOrder.mockResolvedValueOnce(order);
    phase3SumGetRawOne.mockResolvedValueOnce({ total: '0' });

    await service.refund(STAFF, order.id, 'whole-order refund', 2000);

    const refundOutboxInsert = mockInsert.mock.calls.find(
      (c) =>
        c[0] === OutboxEvent &&
        c[1].event_type === OutboxEventType.REFUND_CREATED,
    );
    expect(refundOutboxInsert![1].payload).toMatchObject({
      isCumulativelyFull: true,
      cumulativeRefundedCents: 2000,
      refundType: 'single-full',
      fullRefund: true,
    });
  });

  // ---------------------------------------------------------------------------
  // Test 5 — Cumulative partial refund.
  //
  // Order total $20, prior $5 partial. Manager submits another $5. Cumulative
  // is $10, still < $20 → isFullRefund=false. order_status STAYS at its
  // prior value (PICKED_UP); only payment_status moves to PARTIALLY_REFUNDED
  // (which it already was, but harmless re-write).
  // ---------------------------------------------------------------------------

  it('Cumulative partial refund: order_status does NOT change for partial', async () => {
    const order = makeOrder({
      order_status: OrderStatus.PICKED_UP,
      payment_status: PaymentStatus.PARTIALLY_REFUNDED,
      total_cents: 2000,
    });
    ordersFindOne.mockResolvedValueOnce(order);
    phase1SumGetRawOne.mockResolvedValueOnce({ total: '500' });
    paymentsFindOne.mockResolvedValueOnce({ id: 'pay-1', stripe_payment_id: order.stripe_payment_id });
    createRefundMock.mockResolvedValueOnce({ id: 're_partial_test' });
    txGetOneOrder.mockResolvedValueOnce(order);
    phase3SumGetRawOne.mockResolvedValueOnce({ total: '500' });

    await service.refund(STAFF, order.id, 'extra small refund', 500);

    // order_status untouched
    expect(order.order_status).toBe(OrderStatus.PICKED_UP);
    // payment_status remains PARTIALLY_REFUNDED
    expect(order.payment_status).toBe(PaymentStatus.PARTIALLY_REFUNDED);
    // The OrderEvent records full_refund=false
    const orderEventInsert = mockInsert.mock.calls.find(
      (c) => c[0] === OrderEvent,
    );
    expect(orderEventInsert?.[1].metadata.full_refund).toBe(false);

    // Outbox payload semantics for partial: refundType MUST be 'partial' so
    // the notifications module doesn't accidentally send a "fully refunded"
    // receipt for a partial.
    const refundOutboxInsert = mockInsert.mock.calls.find(
      (c) =>
        c[0] === OutboxEvent &&
        c[1].event_type === OutboxEventType.REFUND_CREATED,
    );
    expect(refundOutboxInsert).toBeDefined();
    expect(refundOutboxInsert![1].payload).toMatchObject({
      orderId: order.id,
      amountCents: 500,
      stripeRefundId: 're_partial_test',
      isCumulativelyFull: false,
      cumulativeRefundedCents: 1000,
      refundType: 'partial',
      fullRefund: false,
    });
  });

  // ---------------------------------------------------------------------------
  // Test 6 — Stripe idempotency key (A8).
  //
  // Pin Date.now() with fake timers so the minute bucket is deterministic.
  // Assert createRefund is called with the expected idempotencyKey format.
  // ---------------------------------------------------------------------------

  it('passes a deterministic idempotency key to stripe.createRefund', async () => {
    // 2026-05-09T14:23:45Z → epoch 1778394225000 → minute bucket
    // floor(1778394225000 / 60000) = 29639903
    const fixedNow = new Date('2026-05-09T14:23:45.000Z');
    jest.useFakeTimers();
    jest.setSystemTime(fixedNow);
    const expectedMinute = Math.floor(fixedNow.getTime() / 60_000);

    const order = makeOrder({
      id: 'order-idem-test',
      order_status: OrderStatus.PAID,
      total_cents: 825,
    });
    ordersFindOne.mockResolvedValueOnce(order);
    phase1SumGetRawOne.mockResolvedValueOnce({ total: '0' });
    paymentsFindOne.mockResolvedValueOnce({ id: 'pay-1', stripe_payment_id: order.stripe_payment_id });
    createRefundMock.mockResolvedValueOnce({ id: 're_idem_test' });
    txGetOneOrder.mockResolvedValueOnce(order);
    phase3SumGetRawOne.mockResolvedValueOnce({ total: '0' });

    await service.refund(STAFF, order.id, 'idempotency test', 200);

    expect(createRefundMock).toHaveBeenCalledTimes(1);
    const call = createRefundMock.mock.calls[0]![0];
    expect(call.idempotencyKey).toBe(`refund-${order.id}-200-${expectedMinute}`);
    expect(call.amountCents).toBe(200);
    expect(call.paymentIntentId).toBe(order.stripe_payment_id);
  });

  // ---------------------------------------------------------------------------
  // Test 7 — Phase 3 race.
  //
  // Phase 1 sees existing=0, validation passes, Stripe call goes through.
  // Phase 3's in-lock re-check sees existing=1500 (concurrent partial
  // landed). Order total is 2000, attempted is 1000 → cumulative would be
  // 2500 > 2000.
  //
  // Expected:
  //   - No exception thrown to the caller (Stripe already moved money;
  //     throwing would lose the record).
  //   - REFUND_CREATED outbox row inserted with
  //     metadata.error='race-with-concurrent-refund'.
  //   - Structured ERROR log emitted.
  //   - Result is the discriminated union's `race-recorded` shape — callers
  //     cannot accidentally treat this as a normal commit at the type level.
  //   - No order mutation, no refunds row insert.
  // ---------------------------------------------------------------------------

  it('Phase 3 race: log + outbox + return race-recorded shape without throwing', async () => {
    const order = makeOrder({
      id: 'order-race-test',
      order_status: OrderStatus.PICKED_UP,
      payment_status: PaymentStatus.SUCCEEDED,
      total_cents: 2000,
    });
    ordersFindOne.mockResolvedValueOnce(order);
    phase1SumGetRawOne.mockResolvedValueOnce({ total: '0' });    // Phase 1: nothing refunded
    paymentsFindOne.mockResolvedValueOnce({ id: 'pay-1', stripe_payment_id: order.stripe_payment_id });
    createRefundMock.mockResolvedValueOnce({ id: 're_race_test' });
    txGetOneOrder.mockResolvedValueOnce(order);
    phase3SumGetRawOne.mockResolvedValueOnce({ total: '1500' }); // Phase 3: someone refunded $15 in between

    const result = await service.refund(STAFF, order.id, 'race scenario', 1000);

    // No exception thrown — refund completed at Stripe, surfaced via outbox
    expect(createRefundMock).toHaveBeenCalledTimes(1);

    // Outbox row with race metadata
    const outboxInsert = mockInsert.mock.calls.find(
      (c) => c[0] === OutboxEvent,
    );
    expect(outboxInsert).toBeDefined();
    expect(outboxInsert![1].event_type).toBe(OutboxEventType.REFUND_CREATED);
    expect(outboxInsert![1].payload).toMatchObject({
      orderId: order.id,
      amountCents: 1000,
      stripeRefundId: 're_race_test',
      error: 'race-with-concurrent-refund',
      phase1ExistingCents: 0,
      phase3ExistingCents: 1500,
      actionRequired: 'manual-reconciliation',
    });

    // Structured ERROR log emitted naming the race
    expect(logErrorSpy).toHaveBeenCalledTimes(1);
    expect(logErrorSpy.mock.calls[0]![0]).toMatch(/refund race detected/);

    // Discriminated return — the `race-recorded` branch carries only
    // operator-facing reconciliation info; there is no `refund` row to
    // hand back because none was persisted.
    expect(result).toEqual({
      status: 'race-recorded',
      stripeRefundId: 're_race_test',
      amountCents: 1000,
      requiresManualReconciliation: true,
    });

    // Order NOT mutated (order_status / payment_status unchanged from input)
    expect(order.order_status).toBe(OrderStatus.PICKED_UP);
    expect(order.payment_status).toBe(PaymentStatus.SUCCEEDED);

    // No refunds row insert — em.save was NOT called for a Refund entity.
    // (em.save in this code path is only called for the order on the happy
    // branch; the race branch skips that too.)
    expect(mockSave).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Negative-coverage helpers — confirm the order/customer/location guards
  // still fire in the new flow.
  // ---------------------------------------------------------------------------

  it('returns 404 when the order does not exist (privacy posture preserved)', async () => {
    ordersFindOne.mockResolvedValueOnce(null);
    await expect(
      service.refund(STAFF, 'missing-uuid', 'whatever', 100),
    ).rejects.toThrow(/Order missing-uuid not found/);
    expect(createRefundMock).not.toHaveBeenCalled();
  });

  it('returns 404 (NOT a separate code) when the order belongs to a different location', async () => {
    const otherLocOrder = makeOrder({ location_id: 'OTHER-LOCATION' });
    ordersFindOne.mockResolvedValueOnce(otherLocOrder);
    await expect(
      service.refund(STAFF, otherLocOrder.id, 'cross-location', 100),
    ).rejects.toThrow(/not found/);
    expect(createRefundMock).not.toHaveBeenCalled();
  });

  it('rejects refund when no payments row exists for the order', async () => {
    const order = makeOrder({ order_status: OrderStatus.PAID });
    ordersFindOne.mockResolvedValueOnce(order);
    phase1SumGetRawOne.mockResolvedValueOnce({ total: '0' });
    paymentsFindOne.mockResolvedValueOnce(null);

    await expect(
      service.refund(STAFF, order.id, 'no payment row', 100),
    ).rejects.toThrow(/No payment row found/);

    expect(createRefundMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// AdminOrdersService.markPickedUp — close-of-loop transition.
//
// Pinned invariant: ORDER_PICKED_UP outbox row inserted alongside the
// READY → PICKED_UP transition, mirroring the markReady → ORDER_READY shape.
// The outbox worker currently no-ops this event, but the analytics module
// (retention, time-to-pickup) will subscribe later — the row must be there
// from day one or the event is lost forever.
// =============================================================================

describe('AdminOrdersService.markPickedUp', () => {
  let service: AdminOrdersService;
  let txGetOne: jest.Mock;
  let mockSave: jest.Mock;
  let mockInsert: jest.Mock;

  beforeEach(async () => {
    txGetOne = jest.fn();
    mockSave = jest.fn().mockImplementation(async (entity) => entity);
    mockInsert = jest.fn().mockResolvedValue(undefined);

    const fakeSelectQb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: txGetOne,
    };
    const fakeEm = {
      createQueryBuilder: jest.fn().mockReturnValue(fakeSelectQb),
      save: mockSave,
      insert: mockInsert,
      findOne: jest.fn().mockResolvedValue(null),
    };
    const fakeDs = {
      transaction: jest.fn().mockImplementation(
        async (cb: (em: typeof fakeEm) => unknown) => cb(fakeEm),
      ),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminOrdersService,
        { provide: getDataSourceToken(), useValue: fakeDs },
        { provide: getRepositoryToken(Order), useValue: {} },
        { provide: getRepositoryToken(OrderItem), useValue: {} },
        { provide: getRepositoryToken(OrderEvent), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(Customer), useValue: { find: jest.fn() } },
        { provide: getRepositoryToken(LocationSettings), useValue: {} },
        { provide: getRepositoryToken(Refund), useValue: {} },
        { provide: getRepositoryToken(Payment), useValue: {} },
        { provide: StripeService, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(AdminOrdersService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('READY → PICKED_UP: inserts ORDER_PICKED_UP outbox row with full payload', async () => {
    const fixedNow = new Date('2026-05-09T15:30:00.000Z');
    jest.useFakeTimers();
    jest.setSystemTime(fixedNow);

    const orderRef = makeOrder({
      id: 'order-pickup-test',
      order_status: OrderStatus.READY,
      payment_status: PaymentStatus.SUCCEEDED,
    });
    txGetOne.mockResolvedValueOnce(orderRef);

    await service.markPickedUp(STAFF, orderRef.id);

    // Status flipped
    expect(orderRef.order_status).toBe(OrderStatus.PICKED_UP);

    // ORDER_PICKED_UP outbox row inserted with the full close-of-loop payload.
    // pickedUpAt is the wall-clock instant the staff confirmed pickup (the
    // transition is the close-of-loop event for retention metrics).
    const outboxInsert = mockInsert.mock.calls.find(
      (c) => c[0] === OutboxEvent,
    );
    expect(outboxInsert).toBeDefined();
    expect(outboxInsert![1].event_type).toBe(OutboxEventType.ORDER_PICKED_UP);
    expect(outboxInsert![1].payload).toEqual({
      orderId: orderRef.id,
      customerId: orderRef.customer_id,
      locationId: orderRef.location_id,
      pickedUpAt: fixedNow.toISOString(),
    });

    // OrderEvent audit row also inserted (regression guard for the shared
    // transitionStaff helper).
    const orderEventInsert = mockInsert.mock.calls.find(
      (c) => c[0] === OrderEvent,
    );
    expect(orderEventInsert?.[1]).toMatchObject({
      order_id: orderRef.id,
      from_status: OrderStatus.READY,
      to_status: OrderStatus.PICKED_UP,
      created_by: STAFF.staff_user_id,
    });
  });
});
