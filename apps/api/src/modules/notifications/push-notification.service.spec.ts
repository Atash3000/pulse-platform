import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';

import { Customer } from '../../database/entities';
import { PushNotificationService } from './push-notification.service';

// =============================================================================
// PushNotificationService — APNs stub (C2).
//
// Pinned invariants:
//
//   - Validator/finder split: empty customerId / title / body THROWS.
//     row-not-found WARNS-and-returns. Other DB errors propagate.
//   - Three log shapes by case:
//       [push-stub] — token present, would-send context as JSON
//       [push-skip] — token absent, customer has no push enabled
//       [push]      — warn-and-skip on missing customer (or other warning)
//   - Push token value NEVER appears in any log line — security invariant.
// =============================================================================

const PUSH_TOKEN_VALUE =
  'ed5f44b51e9bdc5c7e5cef7afe05d9c9b1a6f0c2c0e1b04ff1234567890abcdef';

describe('PushNotificationService', () => {
  let service: PushNotificationService;
  let customersFindOne: jest.Mock;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(async () => {
    customersFindOne = jest.fn();

    const moduleRef = await Test.createTestingModule({
      providers: [
        PushNotificationService,
        {
          provide: getRepositoryToken(Customer),
          useValue: { findOne: customersFindOne },
        },
      ],
    }).compile();

    service = moduleRef.get(PushNotificationService);

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

  // ---------------------------------------------------------------------------
  // Validator path — throws on malformed input. No DB call should happen.
  // ---------------------------------------------------------------------------

  describe('input validation', () => {
    it('throws when customerId is empty', async () => {
      await expect(
        service.send('', 'Title', 'Body'),
      ).rejects.toThrow(/required field 'customerId' must be a non-empty string/);
      expect(customersFindOne).not.toHaveBeenCalled();
    });

    it('throws when title is empty', async () => {
      await expect(
        service.send('cust-1', '', 'Body'),
      ).rejects.toThrow(/required field 'title' must be a non-empty string/);
      expect(customersFindOne).not.toHaveBeenCalled();
    });

    it('throws when body is empty', async () => {
      await expect(
        service.send('cust-1', 'Title', ''),
      ).rejects.toThrow(/required field 'body' must be a non-empty string/);
      expect(customersFindOne).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Finder path — warn-and-return on missing row, propagate other errors.
  // ---------------------------------------------------------------------------

  describe('customer lookup', () => {
    it('warns and returns when customer is not found', async () => {
      customersFindOne.mockResolvedValueOnce(null);

      await expect(
        service.send('cust-gone', 'Title', 'Body'),
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]![0]).toMatch(/customer cust-gone not found/);
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('propagates DB errors from findOne — does NOT warn-and-swallow', async () => {
      // Connection drops, query syntax errors, etc. should bubble up so the
      // outbox retries the event. This test pins that contract — a regression
      // that wraps the body in try/catch would silently lose pushes on
      // transient DB issues.
      customersFindOne.mockRejectedValueOnce(new Error('ECONNRESET on customers query'));

      await expect(
        service.send('cust-1', 'Title', 'Body'),
      ).rejects.toThrow(/ECONNRESET on customers query/);
    });
  });

  // ---------------------------------------------------------------------------
  // No-token path — INFO-level skip with the [push-skip] discriminator.
  // ---------------------------------------------------------------------------

  describe('customer has no push_token', () => {
    it('logs [push-skip] at INFO level and returns; does NOT log a [push-stub] line', async () => {
      customersFindOne.mockResolvedValueOnce({
        id: 'cust-no-token',
        push_token: null,
        full_name: 'Pushless Pete',
      });

      await service.send('cust-no-token', 'Order Ready', 'Your latte is ready');

      expect(logSpy).toHaveBeenCalledTimes(1);
      const logged = logSpy.mock.calls[0]![0] as string;
      expect(logged).toMatch(/^\[push-skip\] /);
      expect(logged).toMatch(/"push_token_present":false/);
      expect(logged).toMatch(/"customer_id":"cust-no-token"/);
      expect(logged).toMatch(/"reason":"customer has no push token registered"/);
      // No would-send line emitted on this path.
      expect(logged).not.toMatch(/\[push-stub\]/);
      // No warn either — no-token is an expected, common case.
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Token-present path — INFO-level [push-stub] with the would-send fields.
  // ---------------------------------------------------------------------------

  describe('customer has push_token', () => {
    it('logs [push-stub] with title/body/customer_id/push_token_present:true', async () => {
      customersFindOne.mockResolvedValueOnce({
        id: 'cust-1',
        push_token: PUSH_TOKEN_VALUE,
        full_name: 'Token Tina',
      });

      await service.send('cust-1', 'Order Ready', 'Your latte is ready');

      expect(logSpy).toHaveBeenCalledTimes(1);
      const logged = logSpy.mock.calls[0]![0] as string;
      expect(logged).toMatch(/^\[push-stub\] /);
      expect(logged).toMatch(/"customer_id":"cust-1"/);
      expect(logged).toMatch(/"push_token_present":true/);
      expect(logged).toMatch(/"title":"Order Ready"/);
      expect(logged).toMatch(/"body":"Your latte is ready"/);
      expect(logged).toMatch(/"data":null/); // no data passed
    });

    it('includes the data payload as JSON when provided', async () => {
      customersFindOne.mockResolvedValueOnce({
        id: 'cust-1',
        push_token: PUSH_TOKEN_VALUE,
      });

      await service.send('cust-1', 'Order Ready', 'Your latte is ready', {
        orderId: 'order-42',
        deepLink: 'pulse://orders/order-42',
      });

      const logged = logSpy.mock.calls[0]![0] as string;
      expect(logged).toMatch(/"data":\{"orderId":"order-42","deepLink":"pulse:\/\/orders\/order-42"\}/);
    });
  });

  // ---------------------------------------------------------------------------
  // Security regression guard — the push token value MUST NEVER appear in
  // any log line, regardless of which path the call took. Asserts across
  // all three log paths (warn, push-skip, push-stub) that the token value
  // is not serialised. A regression that adds the token to the log shape
  // for "easier debugging" gets caught here.
  // ---------------------------------------------------------------------------

  describe('security invariant — push token value is never logged', () => {
    it('does NOT log the push_token value on the [push-stub] path', async () => {
      customersFindOne.mockResolvedValueOnce({
        id: 'cust-1',
        push_token: PUSH_TOKEN_VALUE,
      });

      await service.send('cust-1', 'Title', 'Body');

      // Concatenate every log + warn call argument. The token value must
      // not appear anywhere across all of them.
      const allLogged = [
        ...logSpy.mock.calls.flat(),
        ...warnSpy.mock.calls.flat(),
      ].join('\n');
      expect(allLogged).not.toContain(PUSH_TOKEN_VALUE);
    });

    it('does NOT log the push_token value on the [push-skip] path (defensive — token is null here, but pin the invariant)', async () => {
      // The push-skip path triggers when push_token is null, so the token
      // value can't leak in this case by definition. Still, pin the
      // invariant — a future change that, say, falls back to a "default
      // token" or some such regression would surface here.
      customersFindOne.mockResolvedValueOnce({
        id: 'cust-1',
        push_token: null,
      });

      await service.send('cust-1', 'Title', 'Body');

      const allLogged = [
        ...logSpy.mock.calls.flat(),
        ...warnSpy.mock.calls.flat(),
      ].join('\n');
      expect(allLogged).not.toContain(PUSH_TOKEN_VALUE);
    });
  });
});
