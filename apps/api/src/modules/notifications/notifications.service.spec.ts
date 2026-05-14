import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';

import {
  Customer,
  Location,
  MenuItem,
  Order,
  OutboxEventType,
} from '../../database/entities';
import { NotificationsService } from './notifications.service';
import { PushNotificationService } from './push-notification.service';
import { TelegramService } from './telegram.service';

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
  // C5: locations + telegram added for handleOrderPaidNotification.
  let locationsFindOne: jest.Mock;
  let telegramNewOrder: jest.Mock;
  // Post-C8 push wiring: handleOrderReady and handleRefundCreated (committed
  // arm only) call pushNotifications.send(). The spec exposes the mock so
  // each test can assert call count and args.
  let pushSend: jest.Mock;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(async () => {
    ordersFindOne = jest.fn();
    customersFindOne = jest.fn();
    menuItemsFindOne = jest.fn();
    locationsFindOne = jest.fn();
    telegramNewOrder = jest.fn().mockResolvedValue(undefined);
    pushSend = jest.fn().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: getRepositoryToken(Order), useValue: { findOne: ordersFindOne } },
        { provide: getRepositoryToken(Customer), useValue: { findOne: customersFindOne } },
        { provide: getRepositoryToken(MenuItem), useValue: { findOne: menuItemsFindOne } },
        { provide: getRepositoryToken(Location), useValue: { findOne: locationsFindOne } },
        {
          provide: TelegramService,
          useValue: {
            newOrder: telegramNewOrder,
            // Stub the other methods so any future cross-method tests don't
            // break the mock — they're not called by handleOrderPaidNotification.
            paymentFailed: jest.fn(),
            itemSoldOut: jest.fn(),
            orderingPaused: jest.fn(),
            orderCancelledByStaff: jest.fn(),
            refundIssued: jest.fn(),
            alertDeadOutboxEvent: jest.fn(),
          },
        },
        {
          provide: PushNotificationService,
          useValue: { send: pushSend },
        },
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
    it('ORDER_PAID is a defensive no-op (orderWorker is the routing authority for analytics)', async () => {
      // Post-C5: NotificationsService no longer handles ORDER_PAID — that
      // event is routed to orderWorker.handleOrderPaid by outbox.worker
      // for the analytics side effect. The case stays in the switch for
      // exhaustiveness-check compatibility (ORDER_PAID is still an
      // OutboxEventType member). If outbox.worker ever routes ORDER_PAID
      // here by mistake, this case silently returns — no throw, no work,
      // no telegram call.
      const newOrderSpy = telegramNewOrder; // alias for clarity
      await expect(
        service.dispatch(OutboxEventType.ORDER_PAID, { orderId: 'o-1' }),
      ).resolves.toBeUndefined();
      expect(newOrderSpy).not.toHaveBeenCalled();
      expect(ordersFindOne).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('routes ORDER_PAID_NOTIFICATION to handleOrderPaidNotification', async () => {
      const spy = jest
        .spyOn(service, 'handleOrderPaidNotification')
        .mockResolvedValue(undefined);
      await service.dispatch(OutboxEventType.ORDER_PAID_NOTIFICATION, { orderId: 'o-1' });
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

    it('THROWS on an unknown event type (C4 flip — propagates to outbox.worker → retry → DEAD)', async () => {
      // Cast a plainly-fake string into the enum slot to simulate a
      // corrupted runtime value (e.g., a stale outbox row whose enum
      // string was removed from `OutboxEventType` in a later migration).
      // C4 flipped the dispatch default from warn-and-return to throw so
      // these surface as DEAD events for operator attention rather than
      // being silently marked PROCESSED.
      await expect(
        service.dispatch(
          'TOTALLY_FAKE_EVENT' as unknown as OutboxEventType,
          { foo: 'bar' },
        ),
      ).rejects.toThrow(/no handler registered for event type TOTALLY_FAKE_EVENT/);
      // None of the actual handlers ran — throw happened in the default
      // branch before any case executed.
      expect(ordersFindOne).not.toHaveBeenCalled();
      expect(menuItemsFindOne).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // Order-centric handlers — happy-path: load order, load customer, log
  // structured info.
  // ===========================================================================

  describe('handleOrderPaidNotification (post-C5: calls telegramService.newOrder)', () => {
    it('loads order with items + customer + location, calls telegram.newOrder with mapped scalars', async () => {
      const order = makeOrder({
        id: 'o-paid-1',
        customer_id: 'cust-1',
        location_id: 'loc-1',
        total_cents: 1000,
        pickup_type: 'ASAP',
      });
      // The handler loads Order with `relations: { items: true }`. Attach
      // an items array directly to the makeOrder result so the mock
      // resolves with the full shape.
      (order as Record<string, unknown>).items = [
        { id: 'oi-1', item_name: 'Oat Latte', quantity: 1 },
        { id: 'oi-2', item_name: 'Muffin', quantity: 2 },
      ];
      ordersFindOne.mockResolvedValueOnce(order);
      customersFindOne.mockResolvedValueOnce({ id: 'cust-1', full_name: 'Alice Mitchell' });
      locationsFindOne.mockResolvedValueOnce({ id: 'loc-1', name: 'Main St' });

      await service.handleOrderPaidNotification({
        orderId: 'o-paid-1',
        customerId: 'cust-1',
        locationId: 'loc-1',
        totalCents: 1000,
      });

      // TelegramService.newOrder was called with pre-formatted scalars.
      // Pre-formatting (`formatCustomerName` etc.) happens inside
      // TelegramService — we just pass raw strings.
      expect(telegramNewOrder).toHaveBeenCalledTimes(1);
      expect(telegramNewOrder).toHaveBeenCalledWith({
        orderId: 'o-paid-1',
        customerName: 'Alice Mitchell',
        items: [
          { name: 'Oat Latte', quantity: 1 },
          { name: 'Muffin', quantity: 2 },
        ],
        totalCents: 1000,
        locationName: 'Main St',
      });
    });

    it('falls back to empty-string customerName when customer row is missing', async () => {
      const order = makeOrder({ id: 'o-paid-1', customer_id: 'cust-missing', location_id: 'loc-1' });
      (order as Record<string, unknown>).items = [];
      ordersFindOne.mockResolvedValueOnce(order);
      customersFindOne.mockResolvedValueOnce(null); // orphaned-customer scenario
      locationsFindOne.mockResolvedValueOnce({ id: 'loc-1', name: 'Main St' });

      await service.handleOrderPaidNotification({ orderId: 'o-paid-1' });

      expect(telegramNewOrder).toHaveBeenCalledWith(
        expect.objectContaining({ customerName: '' }),
      );
    });

    it('falls back to empty-string locationName when location row is missing', async () => {
      const order = makeOrder({ id: 'o-paid-1' });
      (order as Record<string, unknown>).items = [];
      ordersFindOne.mockResolvedValueOnce(order);
      customersFindOne.mockResolvedValueOnce({ id: 'cust-1', full_name: 'Alice' });
      locationsFindOne.mockResolvedValueOnce(null);

      await service.handleOrderPaidNotification({ orderId: 'o-paid-1' });

      expect(telegramNewOrder).toHaveBeenCalledWith(
        expect.objectContaining({ locationName: '' }),
      );
    });

    it('warns and does NOT throw when order is not found in DB; does NOT call telegram', async () => {
      ordersFindOne.mockResolvedValueOnce(null);

      await expect(
        service.handleOrderPaidNotification({ orderId: 'o-gone' }),
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toMatch(/order o-gone not found/);
      // Customer + location lookups never ran — short-circuited.
      expect(customersFindOne).not.toHaveBeenCalled();
      expect(locationsFindOne).not.toHaveBeenCalled();
      // Telegram never fired.
      expect(telegramNewOrder).not.toHaveBeenCalled();
    });

    it('THROWS on malformed payload (missing orderId) — programming error', async () => {
      await expect(
        service.handleOrderPaidNotification({ /* no orderId */ }),
      ).rejects.toThrow(/missing required string field 'orderId'/);
      expect(ordersFindOne).not.toHaveBeenCalled();
      expect(telegramNewOrder).not.toHaveBeenCalled();
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

    // -------------------------------------------------------------------------
    // Post-C8 push wiring — customer "Your coffee is ready!" push.
    // -------------------------------------------------------------------------

    it('calls pushNotifications.send with the spec Part 9 title/body and location name', async () => {
      const order = makeOrder({
        id: 'o-ready-push',
        customer_id: 'cust-push-1',
        location: { id: 'loc-1', name: 'Main St' },
      });
      ordersFindOne.mockResolvedValueOnce(order);
      customersFindOne.mockResolvedValueOnce({ id: 'cust-push-1', full_name: 'Bob' });

      await service.handleOrderReady({ orderId: 'o-ready-push' });

      expect(pushSend).toHaveBeenCalledTimes(1);
      const [customerId, title, body, data] = pushSend.mock.calls[0]!;
      expect(customerId).toBe('cust-push-1');
      expect(title).toBe('Your coffee is ready!');
      expect(body).toBe('Pickup is waiting for you at Main St');
      expect(data).toEqual({
        orderId: 'o-ready-push',
        deepLink: 'pulse://orders/o-ready-push',
      });
    });

    it('falls back to "the shop" when location relation is missing (defensive)', async () => {
      // Defensive against a rare race where the location row is deleted
      // between order creation and the ORDER_READY dispatch. The push
      // body degrades gracefully — operator-visible but non-fatal.
      const order = makeOrder({ id: 'o-ready-noloc', location: null });
      ordersFindOne.mockResolvedValueOnce(order);
      customersFindOne.mockResolvedValueOnce({ id: 'cust-1', full_name: 'Bob' });

      await service.handleOrderReady({ orderId: 'o-ready-noloc' });

      const body = pushSend.mock.calls[0]![2] as string;
      expect(body).toBe('Pickup is waiting for you at the shop');
    });

    it('loads order with location relation (single JOINed query)', async () => {
      // Efficiency sanity-check pinned by the C8.5 decision-log entry:
      // adding the location-name lookup did NOT add a separate query.
      // findOne is called with relations: { location: true }.
      const order = makeOrder({ id: 'o-rel', location: { id: 'loc-1', name: 'Main St' } });
      ordersFindOne.mockResolvedValueOnce(order);
      customersFindOne.mockResolvedValueOnce(null);

      await service.handleOrderReady({ orderId: 'o-rel' });

      const findOneCall = ordersFindOne.mock.calls[0]![0] as Record<string, unknown>;
      expect(findOneCall.relations).toEqual({ location: true });
    });

    it('propagates transient push errors so the outbox retries', async () => {
      // The PushNotificationService's contract: permanent reasons swallow,
      // transient reasons throw. The handler does not catch — the throw
      // surfaces to the outbox.
      const order = makeOrder({ id: 'o-transient', location: { id: 'l', name: 'L' } });
      ordersFindOne.mockResolvedValueOnce(order);
      customersFindOne.mockResolvedValueOnce(null);
      pushSend.mockRejectedValueOnce(new Error('[push] transient send error: TooManyRequests'));

      await expect(
        service.handleOrderReady({ orderId: 'o-transient' }),
      ).rejects.toThrow(/transient send error/);
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

    // -------------------------------------------------------------------------
    // Post-C8 push wiring — customer "Refund processed" push on COMMITTED ARM
    // ONLY. The actionRequired gate is critical correctness: the race-recorded
    // variants record an outbox event for staff investigation; no card refund
    // has actually moved. Sending the customer "Your refund of $X.XX is on
    // its way" on those paths would be factually false. See decision-log
    // entry "Push handler wiring (Phase 1 subset)".
    // -------------------------------------------------------------------------

    it('committed-arm: calls pushNotifications.send with title="Refund processed" and $X.XX in body', async () => {
      const order = makeOrder({ id: 'o-refund-push', customer_id: 'cust-refund-1' });
      ordersFindOne.mockResolvedValueOnce(order);
      customersFindOne.mockResolvedValueOnce({ id: 'cust-refund-1', full_name: 'Eve' });

      await service.handleRefundCreated({
        orderId: 'o-refund-push',
        amountCents: 500,
        stripeRefundId: 're_committed',
        refundType: 'partial',
        staffUserId: 'staff-1',
      });

      expect(pushSend).toHaveBeenCalledTimes(1);
      const [customerId, title, body, data] = pushSend.mock.calls[0]!;
      expect(customerId).toBe('cust-refund-1');
      expect(title).toBe('Refund processed');
      expect(body).toBe('Your refund of $5.00 is on its way back to your card');
      expect(data).toEqual({
        orderId: 'o-refund-push',
        refundType: 'partial',
        stripeRefundId: 're_committed',
      });
    });

    it('actionRequired (Phase 3 race) → DOES NOT push (money has not moved)', async () => {
      // The race-recorded arm records an outbox event for STAFF to
      // investigate. No card refund has occurred yet. A customer push
      // saying "Your refund of $X is on its way back" would be a lie
      // and damage trust the moment the customer checks their bank.
      const order = makeOrder({ id: 'o-refund-race' });
      ordersFindOne.mockResolvedValueOnce(order);
      customersFindOne.mockResolvedValueOnce(null);

      await service.handleRefundCreated({
        orderId: 'o-refund-race',
        amountCents: 1000,
        staffUserId: 'staff-1',
        actionRequired: 'manual-reconciliation',
      });

      expect(pushSend).not.toHaveBeenCalled();
    });

    it('webhook-race payload (actionRequired set, no staffUserId) → DOES NOT push', async () => {
      // System-actored webhook race — actionRequired present, no
      // staffUserId. Push must also be gated off this path.
      const order = makeOrder({ id: 'o-refund-webhook-race' });
      ordersFindOne.mockResolvedValueOnce(order);
      customersFindOne.mockResolvedValueOnce(null);

      await service.handleRefundCreated({
        orderId: 'o-refund-webhook-race',
        amountCents: 825,
        requestId: 'req-abc',
        actionRequired: 'manager-refund-via-admin-endpoint',
      });

      expect(pushSend).not.toHaveBeenCalled();
    });

    it('missing amountCents → DOES NOT push (defensive against malformed payload)', async () => {
      // The log line above already records the malformed payload; pushing
      // "$NaN" would be operator-visible noise on the customer side.
      const order = makeOrder({ id: 'o-malformed' });
      ordersFindOne.mockResolvedValueOnce(order);
      customersFindOne.mockResolvedValueOnce(null);

      await service.handleRefundCreated({
        orderId: 'o-malformed',
        // no amountCents
      });

      expect(pushSend).not.toHaveBeenCalled();
    });

    it('non-positive amountCents → DOES NOT push (defensive)', async () => {
      const order = makeOrder({ id: 'o-zero' });
      ordersFindOne.mockResolvedValueOnce(order);
      customersFindOne.mockResolvedValueOnce(null);

      await service.handleRefundCreated({
        orderId: 'o-zero',
        amountCents: 0,
      });

      expect(pushSend).not.toHaveBeenCalled();
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
