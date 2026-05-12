import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';

import { Customer } from '../../database/entities';
import { PushNotificationService } from './push-notification.service';

// =============================================================================
// PushNotificationService — C8 dual-mode (real @parse/node-apn + stub).
//
// Uncovered surfaces (deferred):
//   - HTTP/2 connection-pool behaviour and re-use across many sends
//   - JWT auto-refresh timing inside the library (library owns this)
//   - Sandbox/production credential rotation testing (Provider is built
//     at boot and never rebuilt mid-process today)
//
// The apn module is mocked so the suite runs with no real keys/network.
// =============================================================================

// Mock @parse/node-apn before importing the service. Jest hoists
// jest.mock calls, so the variable used inside the factory must be
// referenced after the factory closes over it. We use a global handle
// the tests can manipulate.

const apnSendMock = jest.fn();
const apnShutdownMock = jest.fn().mockResolvedValue(undefined);
const apnProviderInstance = {
  send: apnSendMock,
  shutdown: apnShutdownMock,
};
let apnProviderConstructorMock: jest.Mock = jest.fn(() => apnProviderInstance);
let apnProviderConstructorOptions: unknown = null;

jest.mock('@parse/node-apn', () => {
  // Use an indirection so individual tests can replace
  // apnProviderConstructorMock between cases.
  return {
    __esModule: true,
    Provider: jest.fn().mockImplementation(function (this: unknown, options: unknown) {
      apnProviderConstructorOptions = options;
      return apnProviderConstructorMock(options);
    }),
    Notification: jest.fn().mockImplementation(function (this: { topic?: string; alert?: unknown; payload?: unknown; expiry?: number }) {
      this.topic = undefined;
      this.alert = undefined;
      this.payload = undefined;
      this.expiry = undefined;
      return this;
    }),
  };
});

const PUSH_TOKEN_VALUE =
  'ed5f44b51e9bdc5c7e5cef7afe05d9c9b1a6f0c2c0e1b04ff1234567890abcdef';

const FULL_APNS_CONFIG = {
  APNS_KEY_ID: 'KEY123',
  APNS_TEAM_ID: 'TEAM456',
  APNS_BUNDLE_ID: 'com.pulscoffee.app',
  APNS_PRIVATE_KEY_PATH: '/fake/path/AuthKey.p8',
  APNS_USE_SANDBOX: 'true',
};

async function buildService(
  configOverrides: Record<string, string | undefined> = {},
  customersFindOne: jest.Mock = jest.fn(),
): Promise<{
  service: PushNotificationService;
  customersFindOne: jest.Mock;
  log: jest.SpyInstance;
  warn: jest.SpyInstance;
  error: jest.SpyInstance;
}> {
  const cfg = { ...configOverrides };
  const moduleRef = await Test.createTestingModule({
    providers: [
      PushNotificationService,
      {
        provide: getRepositoryToken(Customer),
        useValue: { findOne: customersFindOne },
      },
      {
        provide: ConfigService,
        useValue: { get: (k: string) => cfg[k] },
      },
    ],
  }).compile();
  const service = moduleRef.get(PushNotificationService);
  const logger = (service as unknown as {
    logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };
  }).logger;
  const log = jest.spyOn(logger, 'log').mockImplementation(() => {});
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  const error = jest.spyOn(logger, 'error').mockImplementation(() => {});
  return { service, customersFindOne, log, warn, error };
}

beforeEach(() => {
  apnSendMock.mockReset();
  apnShutdownMock.mockClear();
  apnProviderConstructorMock = jest.fn(() => apnProviderInstance);
  apnProviderConstructorOptions = null;
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Input validation — throws on malformed input. No DB call should happen.
// ---------------------------------------------------------------------------

describe('input validation', () => {
  it('throws when customerId is empty', async () => {
    const findOne = jest.fn();
    const { service } = await buildService({}, findOne);
    await expect(service.send('', 'Title', 'Body')).rejects.toThrow(
      /required field 'customerId'/,
    );
    expect(findOne).not.toHaveBeenCalled();
  });

  it('throws when title is empty', async () => {
    const findOne = jest.fn();
    const { service } = await buildService({}, findOne);
    await expect(service.send('cust-1', '', 'Body')).rejects.toThrow(
      /required field 'title'/,
    );
    expect(findOne).not.toHaveBeenCalled();
  });

  it('throws when body is empty', async () => {
    const findOne = jest.fn();
    const { service } = await buildService({}, findOne);
    await expect(service.send('cust-1', 'Title', '')).rejects.toThrow(
      /required field 'body'/,
    );
    expect(findOne).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Customer lookup — warn on missing, propagate DB errors.
// ---------------------------------------------------------------------------

describe('customer lookup', () => {
  it('warns [push] missing-customer and returns when row not found', async () => {
    const findOne = jest.fn().mockResolvedValueOnce(null);
    const { service, warn, log } = await buildService({}, findOne);

    await expect(
      service.send('cust-gone', 'Title', 'Body'),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/^\[push\] missing-customer:/);
    expect(warn.mock.calls[0]![0]).toMatch(/cust-gone not found/);
    expect(log).not.toHaveBeenCalled();
  });

  it('propagates DB errors from findOne — does NOT warn-and-swallow', async () => {
    const findOne = jest.fn().mockRejectedValueOnce(new Error('ECONNRESET on customers query'));
    const { service } = await buildService({}, findOne);

    await expect(service.send('cust-1', 'Title', 'Body')).rejects.toThrow(
      /ECONNRESET on customers query/,
    );
  });
});

// ---------------------------------------------------------------------------
// No-token path — [push-skip] PRESERVED unchanged from C2.
// ---------------------------------------------------------------------------

describe('customer has no push_token', () => {
  it('logs [push-skip] (PRESERVED prefix) and returns; no dispatch line', async () => {
    const findOne = jest.fn().mockResolvedValueOnce({
      id: 'cust-no-token',
      push_token: null,
      full_name: 'Pushless Pete',
    });
    const { service, log, warn } = await buildService({}, findOne);

    await service.send('cust-no-token', 'Order Ready', 'Your latte is ready');

    expect(log).toHaveBeenCalledTimes(1);
    const logged = log.mock.calls[0]![0] as string;
    expect(logged).toMatch(/^\[push-skip\] /);
    expect(logged).toMatch(/"push_token_present":false/);
    expect(logged).toMatch(/"customer_id":"cust-no-token"/);
    expect(logged).toMatch(/"reason":"customer has no push token registered"/);
    expect(logged).not.toMatch(/\[push\]/); // dispatch prefix shouldn't appear
    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Token-present path — [push] dispatch prefix (renamed from [push-stub]).
// ---------------------------------------------------------------------------

describe('customer has push_token (stub-only mode)', () => {
  it('logs [push] dispatch with title/body/customer_id/push_token_present:true', async () => {
    const findOne = jest.fn().mockResolvedValueOnce({
      id: 'cust-1',
      push_token: PUSH_TOKEN_VALUE,
    });
    const { service, log } = await buildService({}, findOne);

    await service.send('cust-1', 'Order Ready', 'Your latte is ready');

    expect(log).toHaveBeenCalledTimes(1);
    const logged = log.mock.calls[0]![0] as string;
    expect(logged).toMatch(/^\[push\] \{/);
    expect(logged).toMatch(/"customer_id":"cust-1"/);
    expect(logged).toMatch(/"push_token_present":true/);
    expect(logged).toMatch(/"title":"Order Ready"/);
    expect(logged).toMatch(/"body":"Your latte is ready"/);
    expect(logged).toMatch(/"data":null/);
    // No fetch / APNs send in stub-only mode.
    expect(apnSendMock).not.toHaveBeenCalled();
  });

  it('includes the data payload as JSON when provided', async () => {
    const findOne = jest.fn().mockResolvedValueOnce({
      id: 'cust-1',
      push_token: PUSH_TOKEN_VALUE,
    });
    const { service, log } = await buildService({}, findOne);

    await service.send('cust-1', 'Order Ready', 'Your latte is ready', {
      orderId: 'order-42',
      deepLink: 'pulse://orders/order-42',
    });

    const logged = log.mock.calls[0]![0] as string;
    expect(logged).toMatch(
      /"data":\{"orderId":"order-42","deepLink":"pulse:\/\/orders\/order-42"\}/,
    );
  });
});

// ---------------------------------------------------------------------------
// Security invariant — token value NEVER appears in any log line.
// ---------------------------------------------------------------------------

describe('security invariant — push token value never logged', () => {
  it('token value absent on the [push] dispatch path', async () => {
    const findOne = jest.fn().mockResolvedValueOnce({
      id: 'cust-1',
      push_token: PUSH_TOKEN_VALUE,
    });
    const { service, log, warn, error } = await buildService({}, findOne);

    await service.send('cust-1', 'Title', 'Body');

    const allLogged = [
      ...log.mock.calls.flat(),
      ...warn.mock.calls.flat(),
      ...error.mock.calls.flat(),
    ].join('\n');
    expect(allLogged).not.toContain(PUSH_TOKEN_VALUE);
  });

  it('token value absent on the [push-skip] path', async () => {
    const findOne = jest.fn().mockResolvedValueOnce({
      id: 'cust-1',
      push_token: null,
    });
    const { service, log, warn, error } = await buildService({}, findOne);

    await service.send('cust-1', 'Title', 'Body');

    const allLogged = [
      ...log.mock.calls.flat(),
      ...warn.mock.calls.flat(),
      ...error.mock.calls.flat(),
    ].join('\n');
    expect(allLogged).not.toContain(PUSH_TOKEN_VALUE);
  });
});

// =============================================================================
// C8 NEW — Provider construction guard
// =============================================================================

describe('Provider construction', () => {
  it('stub-only mode when APNS env is missing (no Provider constructed)', async () => {
    const findOne = jest.fn();
    await buildService({}, findOne);
    // Constructor mock should not have run because env values are absent.
    // The jest.mock factory's Provider constructor only fires when called
    // by the service; here it should NOT be called.
    expect(apnProviderConstructorOptions).toBeNull();
  });

  it('builds Provider when all APNS env is present', async () => {
    const findOne = jest.fn();
    await buildService(FULL_APNS_CONFIG, findOne);
    expect(apnProviderConstructorOptions).toEqual(
      expect.objectContaining({
        token: {
          key: '/fake/path/AuthKey.p8',
          keyId: 'KEY123',
          teamId: 'TEAM456',
        },
        production: false, // sandbox=true → production=false
        requestTimeout: 5000,
      }),
    );
  });

  it('APNS_USE_SANDBOX=true → production: false (sandbox endpoint)', async () => {
    await buildService({ ...FULL_APNS_CONFIG, APNS_USE_SANDBOX: 'true' }, jest.fn());
    expect((apnProviderConstructorOptions as { production: boolean }).production).toBe(false);
  });

  it('APNS_USE_SANDBOX=false → production: true (production endpoint)', async () => {
    await buildService({ ...FULL_APNS_CONFIG, APNS_USE_SANDBOX: 'false' }, jest.fn());
    expect((apnProviderConstructorOptions as { production: boolean }).production).toBe(true);
  });

  it('falls back to stub-only when Provider constructor throws (missing .p8 file)', async () => {
    apnProviderConstructorMock = jest.fn(() => {
      throw new Error('ENOENT: no such file');
    });
    const findOne = jest.fn().mockResolvedValueOnce({
      id: 'cust-1',
      push_token: PUSH_TOKEN_VALUE,
    });
    const { service, log, error } = await buildService(FULL_APNS_CONFIG, findOne);

    // Boot-time error log (this fires DURING constructor, BEFORE the
    // logger spy is attached; so we just assert that a subsequent send
    // works in stub-only mode without calling APNs).
    expect(error).not.toHaveBeenCalled(); // spy attached after constructor

    await service.send('cust-1', 'Title', 'Body');

    expect(apnSendMock).not.toHaveBeenCalled();
    // The [push] dispatch line still fires.
    expect(log.mock.calls.some((c) => /^\[push\] \{/.test(c[0] as string))).toBe(true);
  });
});

// =============================================================================
// C8 NEW — real APNs send paths
// =============================================================================

describe('configured mode — real APNs send', () => {
  it('calls provider.send with the customer push_token on happy path', async () => {
    apnSendMock.mockResolvedValueOnce({ sent: [{ device: PUSH_TOKEN_VALUE }], failed: [] });
    const findOne = jest.fn().mockResolvedValueOnce({
      id: 'cust-1',
      push_token: PUSH_TOKEN_VALUE,
    });
    const { service } = await buildService(FULL_APNS_CONFIG, findOne);

    await service.send('cust-1', 'Order Ready', 'Your latte is ready');

    expect(apnSendMock).toHaveBeenCalledTimes(1);
    const [notification, recipient] = apnSendMock.mock.calls[0]!;
    expect(recipient).toBe(PUSH_TOKEN_VALUE);
    expect(notification.topic).toBe('com.pulscoffee.app');
    expect(notification.alert).toEqual({ title: 'Order Ready', body: 'Your latte is ready' });
  });

  it('BadDeviceToken in failed[] → permanent, swallows', async () => {
    apnSendMock.mockResolvedValueOnce({
      sent: [],
      failed: [
        {
          device: PUSH_TOKEN_VALUE,
          status: 400,
          response: { reason: 'BadDeviceToken' },
        },
      ],
    });
    const findOne = jest.fn().mockResolvedValueOnce({
      id: 'cust-1',
      push_token: PUSH_TOKEN_VALUE,
    });
    const { service, warn } = await buildService(FULL_APNS_CONFIG, findOne);

    await expect(service.send('cust-1', 'T', 'B')).resolves.toBeUndefined();
    expect(warn.mock.calls.some((c) => /permanent-send-error/.test(c[0] as string))).toBe(true);
  });

  it('Unregistered in failed[] → permanent, swallows', async () => {
    apnSendMock.mockResolvedValueOnce({
      sent: [],
      failed: [
        {
          device: PUSH_TOKEN_VALUE,
          status: 410,
          response: { reason: 'Unregistered' },
        },
      ],
    });
    const findOne = jest.fn().mockResolvedValueOnce({
      id: 'cust-1',
      push_token: PUSH_TOKEN_VALUE,
    });
    const { service } = await buildService(FULL_APNS_CONFIG, findOne);

    await expect(service.send('cust-1', 'T', 'B')).resolves.toBeUndefined();
  });

  it('status 410 with empty reason → permanent (Unregistered shorthand)', async () => {
    apnSendMock.mockResolvedValueOnce({
      sent: [],
      failed: [{ device: PUSH_TOKEN_VALUE, status: 410, response: { reason: '' } }],
    });
    const findOne = jest.fn().mockResolvedValueOnce({
      id: 'cust-1',
      push_token: PUSH_TOKEN_VALUE,
    });
    const { service } = await buildService(FULL_APNS_CONFIG, findOne);

    await expect(service.send('cust-1', 'T', 'B')).resolves.toBeUndefined();
  });

  it('DeviceTokenNotForTopic → permanent, swallows', async () => {
    apnSendMock.mockResolvedValueOnce({
      sent: [],
      failed: [
        {
          device: PUSH_TOKEN_VALUE,
          status: 400,
          response: { reason: 'DeviceTokenNotForTopic' },
        },
      ],
    });
    const findOne = jest.fn().mockResolvedValueOnce({
      id: 'cust-1',
      push_token: PUSH_TOKEN_VALUE,
    });
    const { service } = await buildService(FULL_APNS_CONFIG, findOne);

    await expect(service.send('cust-1', 'T', 'B')).resolves.toBeUndefined();
  });

  it('TooManyRequests → transient, throws', async () => {
    apnSendMock.mockResolvedValueOnce({
      sent: [],
      failed: [
        {
          device: PUSH_TOKEN_VALUE,
          status: 429,
          response: { reason: 'TooManyRequests' },
        },
      ],
    });
    const findOne = jest.fn().mockResolvedValueOnce({
      id: 'cust-1',
      push_token: PUSH_TOKEN_VALUE,
    });
    const { service } = await buildService(FULL_APNS_CONFIG, findOne);

    await expect(service.send('cust-1', 'T', 'B')).rejects.toThrow(/transient send error/);
  });

  it('ServiceUnavailable → transient, throws', async () => {
    apnSendMock.mockResolvedValueOnce({
      sent: [],
      failed: [
        {
          device: PUSH_TOKEN_VALUE,
          status: 503,
          response: { reason: 'ServiceUnavailable' },
        },
      ],
    });
    const findOne = jest.fn().mockResolvedValueOnce({
      id: 'cust-1',
      push_token: PUSH_TOKEN_VALUE,
    });
    const { service } = await buildService(FULL_APNS_CONFIG, findOne);

    await expect(service.send('cust-1', 'T', 'B')).rejects.toThrow(/transient send error/);
  });

  it('provider.send rejection (library-level error) → throws as dispatch-failed', async () => {
    apnSendMock.mockRejectedValueOnce(new Error('HTTP/2 stream failure'));
    const findOne = jest.fn().mockResolvedValueOnce({
      id: 'cust-1',
      push_token: PUSH_TOKEN_VALUE,
    });
    const { service } = await buildService(FULL_APNS_CONFIG, findOne);

    await expect(service.send('cust-1', 'T', 'B')).rejects.toThrow(/dispatch-failed/);
  });

  it('still logs [push] dispatch line on the real-send happy path (operators need CloudWatch record)', async () => {
    apnSendMock.mockResolvedValueOnce({ sent: [{ device: PUSH_TOKEN_VALUE }], failed: [] });
    const findOne = jest.fn().mockResolvedValueOnce({
      id: 'cust-1',
      push_token: PUSH_TOKEN_VALUE,
    });
    const { service, log } = await buildService(FULL_APNS_CONFIG, findOne);

    await service.send('cust-1', 'Title', 'Body');

    expect(log.mock.calls.some((c) => /^\[push\] \{/.test(c[0] as string))).toBe(true);
  });
});

describe('onModuleDestroy', () => {
  it('calls provider.shutdown when Provider is configured', async () => {
    const { service } = await buildService(FULL_APNS_CONFIG, jest.fn());
    await service.onModuleDestroy();
    expect(apnShutdownMock).toHaveBeenCalledTimes(1);
  });

  it('is safe to call in stub-only mode (no Provider to close)', async () => {
    const { service } = await buildService({}, jest.fn());
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(apnShutdownMock).not.toHaveBeenCalled();
  });
});
