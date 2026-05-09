import { ConfigService } from '@nestjs/config';
import { getDataSourceToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';

import { OrderStatus, PaymentStatus } from '../../database/entities';
import { StripeService } from '../payments/stripe.service';
import { PendingPaymentCleanupTask } from './pending-payment-cleanup.task';

// Helper — make a stale order row matching the SELECT projection.
// `Object.assign` so explicit `null` overrides (e.g. stripe_payment_id: null)
// land instead of being clobbered by the default via `??`.
const staleRow = (override: Partial<{
  id: string;
  customer_id: string;
  location_id: string;
  stripe_payment_id: string | null;
  idempotency_key: string;
  created_at: Date;
}> = {}) =>
  Object.assign(
    {
      id: 'order-1',
      customer_id: 'cust-1',
      location_id: 'loc-1',
      stripe_payment_id: 'pi_test_123' as string | null,
      idempotency_key: 'idem-1',
      created_at: new Date(Date.now() - 31 * 60_000),
    },
    override,
  );

describe('PendingPaymentCleanupTask', () => {
  // The task talks to the DB through em.query() and em.update()/em.insert().
  // We mock the EntityManager with a pair of controllable jest.fn()s and run
  // ds.transaction(callback) by invoking the callback synchronously with
  // our mock em.

  let mockQuery: jest.Mock;
  let mockUpdate: jest.Mock;
  let mockInsert: jest.Mock;
  let cancelPaymentIntent: jest.Mock;

  const buildTask = async (overrides: { workersEnabled?: string } = {}) => {
    mockQuery = jest.fn().mockResolvedValue([]);
    mockUpdate = jest.fn().mockResolvedValue({ affected: 1 });
    mockInsert = jest.fn().mockResolvedValue({});
    cancelPaymentIntent = jest.fn().mockResolvedValue(undefined);

    const fakeEm = { query: mockQuery, update: mockUpdate, insert: mockInsert };
    const fakeDs = {
      transaction: jest.fn().mockImplementation(async (cb: (em: typeof fakeEm) => unknown) => cb(fakeEm)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PendingPaymentCleanupTask,
        { provide: getDataSourceToken(), useValue: fakeDs },
        { provide: StripeService, useValue: { cancelPaymentIntent } },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => (key === 'WORKERS_ENABLED' ? overrides.workersEnabled : undefined),
          },
        },
      ],
    }).compile();
    return moduleRef.get(PendingPaymentCleanupTask);
  };

  // ---------------------------------------------------------------------------

  describe('runOnce — happy path', () => {
    it('reaps a single stale order: cancels Stripe PI, transitions to FAILED, inserts audit event', async () => {
      const task = await buildTask();
      const row = staleRow();
      mockQuery.mockResolvedValueOnce([row]);

      const reaped = await task.runOnce();

      expect(reaped).toBe(1);

      // Stripe cancel was called with the right PI id
      expect(cancelPaymentIntent).toHaveBeenCalledTimes(1);
      expect(cancelPaymentIntent).toHaveBeenCalledWith('pi_test_123');

      // Order updated to FAILED + payment_status FAILED
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.anything(),
        { id: 'order-1' },
        expect.objectContaining({
          order_status: OrderStatus.FAILED,
          payment_status: PaymentStatus.FAILED,
        }),
      );

      // Audit event inserted with reason "abandoned at checkout"
      expect(mockInsert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          order_id: 'order-1',
          from_status: OrderStatus.PENDING_PAYMENT,
          to_status: OrderStatus.FAILED,
          reason: 'abandoned at checkout',
          created_by: 'system',
          metadata: expect.objectContaining({
            actor_type: 'system',
            task: 'PendingPaymentCleanupTask',
            threshold_minutes: 30,
          }),
        }),
      );
    });

    it('processes multiple stale orders in one batch', async () => {
      const task = await buildTask();
      mockQuery.mockResolvedValueOnce([
        staleRow({ id: 'order-a', stripe_payment_id: 'pi_a' }),
        staleRow({ id: 'order-b', stripe_payment_id: 'pi_b' }),
        staleRow({ id: 'order-c', stripe_payment_id: 'pi_c' }),
      ]);

      const reaped = await task.runOnce();

      expect(reaped).toBe(3);
      expect(cancelPaymentIntent).toHaveBeenCalledTimes(3);
      expect(mockUpdate).toHaveBeenCalledTimes(3);
      expect(mockInsert).toHaveBeenCalledTimes(3);
    });

    it('returns 0 when there are no stale orders', async () => {
      const task = await buildTask();
      mockQuery.mockResolvedValueOnce([]);

      const reaped = await task.runOnce();

      expect(reaped).toBe(0);
      expect(cancelPaymentIntent).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('skips Stripe cancel when stripe_payment_id is null but still transitions the order', async () => {
      const task = await buildTask();
      mockQuery.mockResolvedValueOnce([staleRow({ stripe_payment_id: null })]);

      await task.runOnce();

      expect(cancelPaymentIntent).not.toHaveBeenCalled();
      // The order still transitions to FAILED — DB is the truth.
      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(mockInsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('runOnce — error handling', () => {
    it('proceeds with FAILED transition when Stripe cancel throws', async () => {
      const task = await buildTask();
      mockQuery.mockResolvedValueOnce([staleRow()]);
      cancelPaymentIntent.mockRejectedValueOnce(new Error('stripe is down'));

      const reaped = await task.runOnce();

      expect(reaped).toBe(1);
      // Stripe cancel was attempted but failed — we still transitioned.
      expect(cancelPaymentIntent).toHaveBeenCalledTimes(1);
      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(mockInsert).toHaveBeenCalledTimes(1);
    });
  });

  describe('SQL contract', () => {
    it('uses SELECT FOR UPDATE SKIP LOCKED with the 30-minute threshold and BATCH_SIZE limit', async () => {
      const task = await buildTask();
      await task.runOnce();

      const sql = mockQuery.mock.calls[0]?.[0] as string;
      const params = mockQuery.mock.calls[0]?.[1];
      expect(sql).toMatch(/SELECT/i);
      expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/i);
      expect(sql).toMatch(/order_status = \$1/);
      // The 30-minute threshold and the BATCH_SIZE are query parameters
      expect(params).toEqual([OrderStatus.PENDING_PAYMENT, 30, 25]);
    });
  });

  describe('WORKERS_ENABLED gate', () => {
    it('sweep() short-circuits when WORKERS_ENABLED=false', async () => {
      const task = await buildTask({ workersEnabled: 'false' });
      // Call the @Cron entry point directly — same effect as the cron firing.
      await task.sweep();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('sweep() runs normally when WORKERS_ENABLED is unset (default ON)', async () => {
      const task = await buildTask({ workersEnabled: undefined });
      mockQuery.mockResolvedValueOnce([]);
      await task.sweep();
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('sweep() runs normally when WORKERS_ENABLED=true', async () => {
      const task = await buildTask({ workersEnabled: 'true' });
      mockQuery.mockResolvedValueOnce([]);
      await task.sweep();
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe('overlap protection', () => {
    it('skips the sweep when isRunning is already true', async () => {
      const task = await buildTask();
      // Make the first sweep hang so the second sweep starts while it's still
      // in flight.
      let resolveFirst: () => void = () => {};
      mockQuery.mockImplementationOnce(
        () => new Promise<unknown[]>((r) => { resolveFirst = () => r([]); }),
      );

      const first = task.sweep();
      // Second tick lands while first is in flight
      const second = task.sweep();
      // Let the first one finish
      resolveFirst();
      await Promise.all([first, second]);

      // Only the first sweep ran a query; the second was skipped.
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe('crash safety', () => {
    it('sweep() catches errors so the cron tick does not crash the process', async () => {
      const task = await buildTask();
      mockQuery.mockRejectedValueOnce(new Error('db gone'));
      // Should NOT throw — error is caught and logged.
      await expect(task.sweep()).resolves.toBeUndefined();
    });
  });
});
