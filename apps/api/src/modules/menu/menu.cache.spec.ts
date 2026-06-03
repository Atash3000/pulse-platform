import { MenuCache } from './menu.cache';

// Minimal ioredis stand-in. Each test supplies the methods it needs.
function fakeRedis(overrides: Record<string, unknown> = {}) {
  return {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    smembers: jest.fn().mockResolvedValue([]),
    pipeline: jest.fn(),
    ...overrides,
  };
}

describe('MenuCache — fail-open on Redis errors', () => {
  it('getFullMenu returns null (does not throw) when redis.get rejects', async () => {
    const redis = fakeRedis({ get: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
    const cache = new MenuCache(redis as never);

    await expect(cache.getFullMenu('loc-1')).resolves.toBeNull();
  });

  it('getItem returns null (does not throw) when redis.get rejects', async () => {
    const redis = fakeRedis({ get: jest.fn().mockRejectedValue(new Error('timeout')) });
    const cache = new MenuCache(redis as never);

    await expect(cache.getItem('item-1')).resolves.toBeNull();
  });

  it('setFullMenu swallows a rejected redis.set (never breaks the caller)', async () => {
    const redis = fakeRedis({ set: jest.fn().mockRejectedValue(new Error('READONLY')) });
    const cache = new MenuCache(redis as never);

    await expect(cache.setFullMenu('loc-1', { ok: true })).resolves.toBeUndefined();
  });

  it('setItem swallows a rejected pipeline.exec', async () => {
    const redis = fakeRedis({
      pipeline: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnThis(),
        sadd: jest.fn().mockReturnThis(),
        expire: jest.fn().mockReturnThis(),
        exec: jest.fn().mockRejectedValue(new Error('down')),
      }),
    });
    const cache = new MenuCache(redis as never);

    await expect(cache.setItem('loc-1', 'item-1', { ok: true })).resolves.toBeUndefined();
  });

  it('still parses a valid hit', async () => {
    const redis = fakeRedis({ get: jest.fn().mockResolvedValue(JSON.stringify({ a: 1 })) });
    const cache = new MenuCache(redis as never);

    await expect(cache.getFullMenu('loc-1')).resolves.toEqual({ a: 1 });
  });
});

describe('MenuCache — Redis-error logging is rate-limited (not warn-once-forever)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('logs once per 30s window, then again after the window elapses', async () => {
    const redis = {
      get: jest.fn().mockRejectedValue(new Error('down')),
      set: jest.fn(),
      del: jest.fn(),
      smembers: jest.fn(),
      pipeline: jest.fn(),
    };
    const cache = new MenuCache(redis as never);
    const warn = jest
      .spyOn((cache as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn')
      .mockImplementation(() => undefined);

    // Two failures inside the same window → one warn.
    await cache.getFullMenu('loc-1');
    await cache.getFullMenu('loc-1');
    expect(warn).toHaveBeenCalledTimes(1);

    // Advance past the 30s window → next failure logs again.
    jest.setSystemTime(Date.now() + 30_001);
    await cache.getFullMenu('loc-1');
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
