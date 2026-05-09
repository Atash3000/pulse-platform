import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';

import {
  Customer,
  LocationSettings,
  Order,
  OrderEvent,
  OrderItem,
  OrderStatus,
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
