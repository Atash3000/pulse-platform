import { NotFoundException } from '@nestjs/common';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';

import { Order, OrderStatus, PaymentStatus } from '../../database/entities';
import { StripeService } from '../payments/stripe.service';
import { OrdersService } from './orders.service';

// =============================================================================
// Customer-facing OrdersService — exercises the privacy posture for the two
// customer-scoped read/write paths:
//   - GET /orders/:id  → getOrderForCustomer
//   - POST /orders/:id/cancel → cancelOrderAsCustomer
//
// The privacy invariant pinned by these tests:
//   When the order belongs to a different customer, the response MUST be
//   indistinguishable (status code AND error body) from the response when
//   the order doesn't exist at all. 403 here would let an attacker with a
//   guessed UUID determine "this ID is real and belongs to someone else."
// =============================================================================

describe('OrdersService — privacy posture', () => {
  let service: OrdersService;
  let findOne: jest.Mock;
  // For cancelOrderAsCustomer the service uses ds.transaction() and inside
  // it a createQueryBuilder().setLock().where().getOne() chain. We mock both.
  let txGetOne: jest.Mock;

  beforeEach(async () => {
    findOne = jest.fn();
    txGetOne = jest.fn();
    const fakeQb = {
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: txGetOne,
    };
    const fakeEm = {
      createQueryBuilder: jest.fn().mockReturnValue(fakeQb),
      save: jest.fn(),
      insert: jest.fn(),
    };
    const fakeDs = {
      transaction: jest.fn().mockImplementation(async (cb: (em: typeof fakeEm) => unknown) => cb(fakeEm)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: getDataSourceToken(), useValue: fakeDs },
        { provide: getRepositoryToken(Order), useValue: { findOne, findAndCount: jest.fn() } },
        // StripeService is consulted only on the happy-path PENDING_PAYMENT
        // cancel branch. Privacy tests exit before reaching it.
        { provide: StripeService, useValue: { cancelPaymentIntent: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(OrdersService);
  });

  // ---------------------------------------------------------------------------
  // getOrderForCustomer
  // ---------------------------------------------------------------------------

  describe('getOrderForCustomer', () => {
    it('returns 404 when the order does not exist', async () => {
      findOne.mockResolvedValueOnce(null);

      await expect(
        service.getOrderForCustomer('cust-A', 'missing-uuid'),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.getOrderForCustomer('cust-A', 'missing-uuid'),
      ).rejects.toThrow('Order missing-uuid not found');
    });

    it('returns 404 with the SAME message when the order exists but belongs to a different customer', async () => {
      const otherCustomersOrder = makeOrder({ customer_id: 'cust-A' });
      // Two calls expected because each `expect(...).rejects.toThrow()` re-invokes the function.
      findOne.mockResolvedValue(otherCustomersOrder);

      await expect(
        service.getOrderForCustomer('cust-B', otherCustomersOrder.id),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.getOrderForCustomer('cust-B', otherCustomersOrder.id),
      ).rejects.toThrow(`Order ${otherCustomersOrder.id} not found`);
    });

    it('does NOT throw ForbiddenException for cross-customer access', async () => {
      const otherCustomersOrder = makeOrder({ customer_id: 'cust-A' });
      findOne.mockResolvedValueOnce(otherCustomersOrder);

      try {
        await service.getOrderForCustomer('cust-B', otherCustomersOrder.id);
        fail('expected NotFoundException');
      } catch (err) {
        // Pin the type explicitly — a regression to ForbiddenException would
        // re-introduce the leak.
        expect(err).toBeInstanceOf(NotFoundException);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // cancelOrderAsCustomer (the A3-followup regression test)
  // ---------------------------------------------------------------------------

  describe('cancelOrderAsCustomer', () => {
    it('returns 404 when the order does not exist', async () => {
      txGetOne.mockResolvedValueOnce(null);

      await expect(
        service.cancelOrderAsCustomer('cust-A', 'missing-uuid'),
      ).rejects.toThrow(NotFoundException);
      txGetOne.mockResolvedValueOnce(null);
      await expect(
        service.cancelOrderAsCustomer('cust-A', 'missing-uuid'),
      ).rejects.toThrow('Order missing-uuid not found');
    });

    it('returns 404 with the SAME message when the order exists but belongs to a different customer', async () => {
      const otherCustomersOrder = makeOrder({ customer_id: 'cust-A' });
      txGetOne.mockResolvedValue(otherCustomersOrder);

      await expect(
        service.cancelOrderAsCustomer('cust-B', otherCustomersOrder.id),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.cancelOrderAsCustomer('cust-B', otherCustomersOrder.id),
      ).rejects.toThrow(`Order ${otherCustomersOrder.id} not found`);
    });

    it('throws NotFoundException (NOT ForbiddenException) for cross-customer cancel — regression for A3-followup', async () => {
      const otherCustomersOrder = makeOrder({ customer_id: 'cust-A' });
      txGetOne.mockResolvedValueOnce(otherCustomersOrder);

      try {
        await service.cancelOrderAsCustomer('cust-B', otherCustomersOrder.id);
        fail('expected NotFoundException');
      } catch (err) {
        expect(err).toBeInstanceOf(NotFoundException);
      }
    });

    it('the missing-order 404 and the cross-customer 404 produce response shapes whose ONLY difference is the UUID', async () => {
      // Same orderId in both branches → identical messages → byte-identical bodies.
      const SAME_ID = '11111111-1111-4111-8111-111111111111';

      txGetOne.mockResolvedValueOnce(null); // missing order branch
      let missingMsg: string | undefined;
      try {
        await service.cancelOrderAsCustomer('cust-B', SAME_ID);
      } catch (err) {
        missingMsg = (err as Error).message;
      }

      txGetOne.mockResolvedValueOnce(makeOrder({ id: SAME_ID, customer_id: 'cust-A' })); // cross-customer branch
      let crossMsg: string | undefined;
      try {
        await service.cancelOrderAsCustomer('cust-B', SAME_ID);
      } catch (err) {
        crossMsg = (err as Error).message;
      }

      expect(missingMsg).toBeDefined();
      expect(crossMsg).toBeDefined();
      // The privacy invariant — bytes match.
      expect(crossMsg).toEqual(missingMsg);
    });
  });
});

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------
function makeOrder(overrides: Partial<Order> = {}): Order {
  return Object.assign(
    {
      id: 'order-id',
      customer_id: 'cust-A',
      location_id: 'loc-1',
      idempotency_key: 'idem-1',
      order_status: OrderStatus.PAID,
      payment_status: PaymentStatus.SUCCEEDED,
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
