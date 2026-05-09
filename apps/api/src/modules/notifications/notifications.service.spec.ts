import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';

import {
  Customer,
  MenuItem,
  Order,
  OutboxEventType,
} from '../../database/entities';
import { NotificationsService } from './notifications.service';

// =============================================================================
// NotificationsService — router with stubbed handlers (C1).
//
// Pinned invariants:
//
//   - dispatch() routes by event type; unknown types log a warning and
//     return without throwing.
//   - Every handler validates required payload fields and THROWS on missing
//     fields (programming-error path, retried by outbox toward DEAD).
//   - Every handler WARN-and-RETURNS when the loaded row is missing
//     (best-effort path, notification dropped on purpose because retrying
//     won't bring back a deleted row).
//   - REFUND_CREATED reads three payload shapes defensively (the two
//     admin-actored emit sites carry staffUserId; the webhook race emit
//     carries requestId instead — and only the race emits carry
//     `actionRequired`).
//   - The presence of `actionRequired` on a payload upgrades the log line
//     from logger.log (info) to logger.warn — operator-facing signal that
//     manual intervention is needed.
// =============================================================================

describe('NotificationsService', () => {
  let service: NotificationsService;
  let ordersFindOne: jest.Mock;
  let customersFindOne: jest.Mock;
  let menuItemsFindOne: jest.Mock;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(async () => {
    ordersFindOne = jest.fn();
    customersFindOne = jest.fn();
    menuItemsFindOne = jest.fn();

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: getRepositoryToken(Order), useValue: { findOne: ordersFindOne } },
        { provide: getRepositoryToken(Customer), useValue: { findOne: customersFindOne } },
        { provide: getRepositoryToken(MenuItem), useValue: { findOne: menuItemsFindOne } },
      ],
    }).compile();

    service = moduleRef.get(NotificationsService);

    // Capture log calls. Both `log` (info-level analog) and `warn` are spied
    // so tests can differentiate the action-required vs no-action paths
    // without parsing log strings.
    logSpy = jest
      .spyOn(
        (service as unknown as { logger: { log: (msg: string) => void } }).logger,
        'log',
      )
      .mockImplementation(() => {});
    warnSpy = jest
      .spyOn(
        (service as unknown as { logger: { warn: (msg: string) => void } }).logger,
        'warn',
      )
      .mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  // ===========================================================================
  // Routing — dispatch() picks the right handler per event type.
  //
  // Pattern: spy on the public handler, call dispatch(), assert the spy was
  // called once. Routing logic is a single switch; one test per case is
  // enough to pin it.
  // ===========================================================================

  describe('dispatch()', () => {
    it('routes ORDER_PAID to handleOrderPaid', async () => {
      const spy = jest
        .spyOn(service, 'handleOrderPaid')
        .mockResolvedValue(undefined);
      await service.dispatch(OutboxEventType.ORDER_PAID, { orderId: 'o-1' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ orderId: 'o-1' });
    });

    it('routes ORDER_READY to handleOrderReady', async () => {
      const spy = jest
        .spyOn(service, 'handleOrderReady')
        .mockResolvedValue(undefined);
      await service.dispatch(OutboxEventType.ORDER_READY, { orderId: 'o-1' });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('routes ORDER_CANCELLED to handleOrderCancelled', async () => {
      const spy = jest
        .spyOn(service, 'handleOrderCancelled')
        .mockResolvedValue(undefined);
      await service.dispatch(OutboxEventType.ORDER_CANCELLED, { orderId: 'o-1' });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('routes ORDER_PICKED_UP to handleOrderPickedUp', async () => {
      const spy = jest
        .spyOn(service, 'handleOrderPickedUp')
        .mockResolvedValue(undefined);
      await service.dispatch(OutboxEventType.ORDER_PICKED_UP, { orderId: 'o-1' });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('routes REFUND_CREATED to handleRefundCreated', async () => {
      const spy = jest
        .spyOn(service, 'handleRefundCreated')
        .mockResolvedValue(undefined);
      await service.dispatch(OutboxEventType.REFUND_CREATED, { orderId: 'o-1' });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('routes ITEM_OUT_OF_STOCK to handleItemOutOfStock', async () => {
      const spy = jest
        .spyOn(service, 'handleItemOutOfStock')
        .mockResolvedValue(undefined);
      await service.dispatch(OutboxEventType.ITEM_OUT_OF_STOCK, { itemId: 'i-1' });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('logs a warning and does NOT throw on an unknown event type', async () => {
      // Cast a plainly-fake string into the enum slot to simulate a future
      // enum value that isn't yet wired here.
      await expect(
        service.dispatch(
          'TOTALLY_FAKE_EVENT' as unknown as OutboxEventType,
          { foo: 'bar' },
        ),
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toMatch(/no handler registered/);
      // None of the actual handlers ran.
      expect(ordersFindOne).not.toHaveBeenCalled();
      expect(menuItemsFindOne).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Order-centric handlers — happy-path: load order, load customer, log
  // structured info.
  // ===========================================================================

  describe('handleOrderPaid', () => {
    it('loads order + customer and logs ORDER_PAID context with the manager target', async () => {
      const order = makeOrder({
        id: 'o-paid-1',
        customer_id: 'cust-1',
        location_id: 'loc-1',
        total_cents: 825,
        pickup_type: 'ASAP',
      });
      ordersFindOne.mockResolvedValueOnce(order);
      customersFindOne.mockResolvedValueOnce({ id: 'cust-1', full_name: 'Alice' });

      await service.handleOrderPaid({
        orderId: 'o-paid-1',
        customerId: 'cust-1',
        locationId: 'loc-1',
        totalCents: 825,
      });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const logged = logSpy.mock.calls[0]![0] as string;
      expect(logged).toMatch(/ORDER_PAID/);
      expect(logged).toMatch(/"target_audience":"manager"/);
      expect(logged).toMatch(/"order_id":"o-paid-1"/);
      expect(logged).toMatch(/"customer_name":"Alice"/);
      expect(logged).toMatch(/"total_cents":825/);
    });

    it('warns and does NOT throw when order is not found in DB', async () => {
      ordersFindOne.mockResolvedValueOnce(null);

      await expect(
        service.handleOrderPaid({ orderId: 'o-gone' }),
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toMatch(/order o-gone not found/);
      // No structured log emitted — we returned before reaching it.
      expect(logSpy).not.toHaveBeenCalled();
      // Customer lookup never ran — the order-missing check short-circuited.
      expect(customersFindOne).not.toHaveBeenCalled();
    });

    it('THROWS on malformed payload (missing orderId) — programming error', async () => {
      // No mocks needed; the throw happens BEFORE any DB call.
      await expect(
        service.handleOrderPaid({ /* no orderId */ }),
      ).rejects.toThrow(/missing required string field 'orderId'/);
      expect(ordersFindOne).not.toHaveBeenCalled();
    });
  });

  describe('handleOrderReady', () => {
    it('loads order + customer and logs ORDER_READY context with the customer target', async () => {
      const order = makeOrder({
        id: 'o-ready-1',
        estimated_ready_at: new Date('2026-05-09T15:30:00.000Z'),
      });
      ordersFindOne.mockResolvedValueOnce(order);
      customersFindOne.mockResolvedValueOnce({ id: 'cust-1', full_name: 'Bob' });

      await service.handleOrderReady({
        orderId: 'o-ready-1',
        customerId: 'cust-1',
        locationId: 'loc-1',
      });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const logged = logSpy.mock.calls[0]![0] as string;
      expect(logged).toMatch(/"target_audience":"customer"/);
      expect(logged).toMatch(/"customer_name":"Bob"/);
      expect(logged).toMatch(/"estimated_ready_at":"2026-05-09T15:30:00.000Z"/);
    });

    it('warns and does NOT throw when order is not found', async () => {
      ordersFindOne.mockResolvedValueOnce(null);
      await expect(
        service.handleOrderReady({ orderId: 'o-gone' }),
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('THROWS on malformed payload (missing orderId)', async () => {
      await expect(
        service.handleOrderReady({ orderId: 42 } as unknown as Record<string, unknown>),
      ).rejects.toThrow(/missing required string field 'orderId'/);
    });
  });

  describe('handleOrderCancelled', () => {
    it('reads cancelledBy/staffUserId/reason defensively and logs the cancellation', async () => {
      const order = makeOrder({ id: 'o-cancel-1' });
      ordersFindOne.mockResolvedValueOnce(order);
      customersFindOne.mockResolvedValueOnce({ id: 'cust-1', full_name: 'Carol' });

      await service.handleOrderCancelled({
        orderId: 'o-cancel-1',
        customerId: 'cust-1',
        locationId: 'loc-1',
        totalCents: 825,
        cancelledBy: 'manager',
        staffUserId: 'staff-1',
        reason: 'spilled drink',
      });

      const logged = logSpy.mock.calls[0]![0] as string;
      expect(logged).toMatch(/"cancelled_by":"manager"/);
      expect(logged).toMatch(/"staff_user_id":"staff-1"/);
      expect(logged).toMatch(/"reason":"spilled drink"/);
    });

    it('handles a future system-cancel payload with no cancelledBy/staffUserId by logging null', async () => {
      // Defense-in-depth: a future emit site (e.g., abandoned-checkout
      // cleanup if it ever gets re-routed through ORDER_CANCELLED) might
      // omit these fields. The handler must not crash and must surface
      // their absence in the log.
      const order = makeOrder({ id: 'o-cancel-system' });
      ordersFindOne.mockResolvedValueOnce(order);
      customersFindOne.mockResolvedValueOnce(null);

      await service.handleOrderCancelled({
        orderId: 'o-cancel-system',
        // no cancelledBy, no staffUserId, no reason
      });

      const logged = logSpy.mock.calls[0]![0] as string;
      expect(logged).toMatch(/"cancelled_by":null/);
      expect(logged).toMatch(/"staff_user_id":null/);
      expect(logged).toMatch(/"reason":null/);
      expect(logged).toMatch(/"customer_name":null/);
    });

    it('warns and does NOT throw when order is not found', async () => {
      ordersFindOne.mockResolvedValueOnce(null);
      await expect(
        service.handleOrderCancelled({ orderId: 'o-gone' }),
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleOrderPickedUp', () => {
    it('logs the close-of-loop context with picked_up_at from the payload', async () => {
      const order = makeOrder({ id: 'o-pickup-1' });
      ordersFindOne.mockResolvedValueOnce(order);
      customersFindOne.mockResolvedValueOnce({ id: 'cust-1', full_name: 'Dave' });

      await service.handleOrderPickedUp({
        orderId: 'o-pickup-1',
        customerId: 'cust-1',
        locationId: 'loc-1',
        pickedUpAt: '2026-05-09T15:32:00.000Z',
      });

      const logged = logSpy.mock.calls[0]![0] as string;
      expect(logged).toMatch(/"target_audience":"analytics"/);
      expect(logged).toMatch(/"picked_up_at":"2026-05-09T15:32:00.000Z"/);
    });

    it('warns and does NOT throw when order is not found', async () => {
      ordersFindOne.mockResolvedValueOnce(null);
      await expect(
        service.handleOrderPickedUp({ orderId: 'o-gone' }),
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // REFUND_CREATED — three emit sites, log-level differentiation, defensive
  // payload reading.
  // ===========================================================================

  describe('handleRefundCreated', () => {
    it('committed-arm payload (admin-orders.service.ts refund happy path) → INFO log', async () => {
      const order = makeOrder({ id: 'o-refund-committed' });
      ordersFindOne.mockResolvedValueOnce(order);
      customersFindOne.mockResolvedValueOnce({ id: 'cust-1', full_name: 'Eve' });

      await service.handleRefundCreated({
        orderId: 'o-refund-committed',
        customerId: 'cust-1',
        locationId: 'loc-1',
        amountCents: 500,
        stripeRefundId: 're_committed',
        fullRefund: false,
        isCumulativelyFull: false,
        cumulativeRefundedCents: 500,
        refundType: 'partial',
        staffUserId: 'staff-1',
      });

      // No actionRequired → info-level via logger.log
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
      const logged = logSpy.mock.calls[0]![0] as string;
      expect(logged).toMatch(/"refund_type":"partial"/);
      expect(logged).toMatch(/"staff_user_id":"staff-1"/);
      expect(logged).toMatch(/"action_required":null/);
      expect(logged).toMatch(/"target_audience":"customer\+manager"/);
    });

    it('Phase 3 race payload (refund race-with-concurrent-refund) → WARN log', async () => {
      const order = makeOrder({ id: 'o-refund-race' });
      ordersFindOne.mockResolvedValueOnce(order);
      customersFindOne.mockResolvedValueOnce(null);

      await service.handleRefundCreated({
        orderId: 'o-refund-race',
        customerId: 'cust-1',
        locationId: 'loc-1',
        amountCents: 1000,
        stripeRefundId: 're_race',
        fullRefund: false,
        staffUserId: 'staff-1',
        error: 'race-with-concurrent-refund',
        phase1ExistingCents: 0,
        phase3ExistingCents: 1500,
        actionRequired: 'manual-reconciliation',
      });

      // actionRequired is set → warn-level via logger.warn
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).not.toHaveBeenCalled();
      const logged = warnSpy.mock.calls[0]![0] as string;
      expect(logged).toMatch(/"action_required":"manual-reconciliation"/);
      expect(logged).toMatch(/"target_audience":"manager-action-required"/);
    });

    it('webhook-race payload (markPaidFromWebhook) → WARN log; staffUserId absent reads as null', async () => {
      // Webhook race emit site is system-actored — it has requestId, NOT
      // staffUserId. The handler reads staffUserId defensively and logs null.
      const order = makeOrder({ id: 'o-refund-webhook' });
      ordersFindOne.mockResolvedValueOnce(order);
      customersFindOne.mockResolvedValueOnce(null);

      await service.handleRefundCreated({
        orderId: 'o-refund-webhook',
        customerId: 'cust-1',
        locationId: 'loc-1',
        amountCents: 825,
        currency: 'usd',
        stripePaymentIntentId: 'pi_xyz',
        stripeEventId: 'evt_xyz',
        requestId: 'req-abc',
        raceType: 'cancel-after-pay',
        orderStatusAtRace: 'CANCELLED',
        paymentStatusAtRace: 'SUCCEEDED',
        actionRequired: 'manager-refund-via-admin-endpoint',
        // NO staffUserId — webhook is system-actored
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logged = warnSpy.mock.calls[0]![0] as string;
      expect(logged).toMatch(/"staff_user_id":null/);
      expect(logged).toMatch(/"request_id":"req-abc"/);
      expect(logged).toMatch(/"action_required":"manager-refund-via-admin-endpoint"/);
      // stripe_refund_id absent on this emit → logged as null
      expect(logged).toMatch(/"stripe_refund_id":null/);
    });

    it('warns and does NOT throw when order is not found', async () => {
      ordersFindOne.mockResolvedValueOnce(null);
      await expect(
        service.handleRefundCreated({ orderId: 'o-gone' }),
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      // The warn we observe is the order-not-found warning, NOT the
      // action-required warning — assert by matching the message text.
      expect(warnSpy.mock.calls[0]![0]).toMatch(/not found in DB/);
    });
  });

  // ===========================================================================
  // ITEM_OUT_OF_STOCK — uses MenuItem, not Order. Location from payload.
  // ===========================================================================

  describe('handleItemOutOfStock', () => {
    it('loads MenuItem and logs the alert with the canonical item name and payload location', async () => {
      menuItemsFindOne.mockResolvedValueOnce({
        id: 'i-latte',
        name: 'Iced Latte',
      });

      await service.handleItemOutOfStock({
        itemId: 'i-latte',
        locationId: 'loc-1',
        staffUserId: 'staff-1',
        soldOutAt: '2026-05-09T16:00:00.000Z',
      });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const logged = logSpy.mock.calls[0]![0] as string;
      expect(logged).toMatch(/"item_id":"i-latte"/);
      expect(logged).toMatch(/"item_name":"Iced Latte"/);
      // location_id comes from the payload (MenuItem has no location_id).
      expect(logged).toMatch(/"location_id":"loc-1"/);
      expect(logged).toMatch(/"staff_user_id":"staff-1"/);
      expect(logged).toMatch(/"sold_out_at":"2026-05-09T16:00:00.000Z"/);
      // Order/customer lookups never ran for this handler.
      expect(ordersFindOne).not.toHaveBeenCalled();
      expect(customersFindOne).not.toHaveBeenCalled();
    });

    it('warns and does NOT throw when MenuItem is not found', async () => {
      menuItemsFindOne.mockResolvedValueOnce(null);

      await expect(
        service.handleItemOutOfStock({ itemId: 'i-gone', locationId: 'loc-1' }),
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toMatch(/item i-gone not found/);
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('THROWS on malformed payload (missing itemId) — programming error', async () => {
      await expect(
        service.handleItemOutOfStock({ /* no itemId */ }),
      ).rejects.toThrow(/missing required string field 'itemId'/);
      expect(menuItemsFindOne).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Test helper — minimal Order shape that matches the fields the handlers
// read from the loaded entity. Other fields can be added by tests via
// overrides.
// ---------------------------------------------------------------------------

function makeOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'o-default',
    customer_id: 'cust-1',
    location_id: 'loc-1',
    order_status: 'PAID',
    payment_status: 'SUCCEEDED',
    total_cents: 825,
    pickup_type: 'ASAP',
    scheduled_pickup_at: null,
    estimated_ready_at: null,
    notes: null,
    created_at: new Date('2026-05-09T14:00:00.000Z'),
    ...overrides,
  };
}
