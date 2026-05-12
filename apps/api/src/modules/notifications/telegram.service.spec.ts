import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import type { OutboxEvent, OutboxEventType, OutboxStatus } from '../../database/entities';
import { TelegramService } from './telegram.service';

// =============================================================================
// TelegramService — C8 dual-mode (real Bot API + stub fallback).
//
// Two configurations matter:
//
//   - Configured (TELEGRAM_BOT_TOKEN + TELEGRAM_OWNER_CHAT_ID both set):
//     ALL six dispatch methods emit [telegram] {...} log AND call fetch.
//     alertDeadOutboxEvent emits [telegram-stub] log AND calls fetch.
//
//   - Unconfigured (either env empty): log lines emitted, NO fetch call.
//     Manager's pre-Apple-verification state runs Telegram configured
//     but APNs empty — that's just the push side, independent of this.
//
// Uncovered surfaces (out of scope for this spec — pin for future work):
//   - fetch connection-pool behaviour under sustained load
//   - Bot API rate-limit Retry-After header handling (today we treat 429
//     as a transient throw; the outbox retry interval is fixed, not
//     Retry-After-aware)
//   - Production credential rotation (no test covers a mid-process
//     token rotation; Provider is constructed at boot)
// =============================================================================

type FetchMock = jest.Mock<Promise<Partial<Response>>, [string, RequestInit?]>;

async function buildService(
  config: { TELEGRAM_OWNER_CHAT_ID?: string; TELEGRAM_BOT_TOKEN?: string } = {
    TELEGRAM_OWNER_CHAT_ID: 'owner-chat-123',
    TELEGRAM_BOT_TOKEN: 'bot-token-abc',
  },
): Promise<TelegramService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      TelegramService,
      {
        provide: ConfigService,
        useValue: { get: (k: string) => config[k as keyof typeof config] },
      },
    ],
  }).compile();
  return moduleRef.get(TelegramService);
}

function spyOnLogger(service: TelegramService): {
  log: jest.SpyInstance;
  warn: jest.SpyInstance;
  error: jest.SpyInstance;
} {
  const logger = (service as unknown as {
    logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };
  }).logger;
  const log = jest.spyOn(logger, 'log').mockImplementation(() => {});
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  const error = jest.spyOn(logger, 'error').mockImplementation(() => {});
  return { log, warn, error };
}

// Helper to extract the JSON payload from a `[telegram] {...}` line.
function parseDispatch(line: string): Record<string, unknown> {
  const match = line.match(/^\[telegram\] (\{.+\})$/);
  if (!match) throw new Error(`Not a [telegram] dispatch line: ${line}`);
  return JSON.parse(match[1]!);
}

function makeOkResponse(): Partial<Response> {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
  };
}

function makeErrorResponse(status: number, description?: string): Partial<Response> {
  return {
    ok: false,
    status,
    json: async () => ({ ok: false, error_code: status, description }),
  };
}

describe('TelegramService — C8 dual-mode dispatch', () => {
  let fetchMock: FetchMock;
  const realFetch = global.fetch;

  beforeEach(() => {
    fetchMock = jest.fn(async () => makeOkResponse() as Response) as unknown as FetchMock;
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    (global as { fetch: typeof fetch }).fetch = realFetch;
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Log-shape regression — each dispatch method emits [telegram] {alert, chat_id,
  // level, body, ...}. C8 renamed the prefix from [telegram-stub] to [telegram];
  // these tests pin the new shape.
  // ---------------------------------------------------------------------------

  describe('newOrder', () => {
    it('logs [telegram] dispatch line at INFO with chat_id="owner"', async () => {
      const service = await buildService();
      const { log, warn } = spyOnLogger(service);

      await service.newOrder({
        orderId: 'abc12345-6789-4def-89ab-cdef01234567',
        customerName: 'Sarah Mitchell',
        items: [
          { name: 'Oat Latte', quantity: 1 },
          { name: 'Muffin', quantity: 1 },
        ],
        totalCents: 1000,
        locationName: 'Main St',
      });

      expect(log).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
      const payload = parseDispatch(log.mock.calls[0]![0] as string);
      expect(payload.alert).toBe('newOrder');
      expect(payload.chat_id).toBe('owner');
      expect(payload.level).toBe('info');
      expect(payload.body).toBe(
        'NEW ORDER — Sarah M. — Oat Latte + Muffin — $10.00 — Main St',
      );
      expect(payload.orderId).toBe('abc12345-6789-4def-89ab-cdef01234567');
    });

    it('chat_id is null when TELEGRAM_OWNER_CHAT_ID is not configured', async () => {
      const service = await buildService({ /* no chat id, no token */ });
      const { log } = spyOnLogger(service);

      await service.newOrder({
        orderId: 'order-1',
        customerName: 'Sarah Mitchell',
        items: [{ name: 'Latte', quantity: 1 }],
        totalCents: 500,
        locationName: 'Main St',
      });

      const payload = parseDispatch(log.mock.calls[0]![0] as string);
      expect(payload.chat_id).toBeNull();
      // No fetch in unconfigured mode.
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('paymentFailed', () => {
    it('logs Part 9 PAYMENT FAILED body at WARN level', async () => {
      const service = await buildService();
      const { log, warn } = spyOnLogger(service);

      await service.paymentFailed({
        orderId: 'abc12345-6789-4def-89ab-cdef01234567',
        totalCents: 850,
        customerName: 'Mike K',
      });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
      const payload = parseDispatch(warn.mock.calls[0]![0] as string);
      expect(payload.alert).toBe('paymentFailed');
      expect(payload.level).toBe('warn');
      expect(payload.body).toBe(
        'PAYMENT FAILED — Order #abc12345 — $8.50 — Customer: Mike K.',
      );
    });
  });

  describe('itemSoldOut', () => {
    it('uppercases the item name to match Spec Part 9 example', async () => {
      const service = await buildService();
      const { log } = spyOnLogger(service);

      await service.itemSoldOut({
        itemId: 'item-oat-milk',
        itemName: 'Oat Milk',
        locationName: 'Main St',
      });

      const payload = parseDispatch(log.mock.calls[0]![0] as string);
      expect(payload.body).toBe('OAT MILK SOLD OUT — Auto-hidden from app — Main St');
    });
  });

  describe('orderingPaused', () => {
    it('logs at WARN — paused ordering is operator-visible', async () => {
      const service = await buildService();
      const { warn } = spyOnLogger(service);

      await service.orderingPaused({
        locationName: 'Main St',
        staffDisplayName: 'Manager Jane',
      });

      const payload = parseDispatch(warn.mock.calls[0]![0] as string);
      expect(payload.body).toBe('MOBILE ORDERING PAUSED — Main St — by: Manager Jane');
    });
  });

  describe('orderCancelledByStaff', () => {
    it('logs at WARN with manager + reason', async () => {
      const service = await buildService();
      const { warn } = spyOnLogger(service);

      await service.orderCancelledByStaff({
        orderId: 'abc12345-6789-4def-89ab-cdef01234567',
        totalCents: 1000,
        customerName: 'Sarah Mitchell',
        staffDisplayName: 'Manager Jane',
        reason: 'spilled drink',
      });

      const payload = parseDispatch(warn.mock.calls[0]![0] as string);
      expect(payload.body).toBe(
        'ORDER CANCELLED — Order #abc12345 — $10.00 — Customer: Sarah M. — by: Manager Jane — Reason: spilled drink',
      );
    });
  });

  describe('refundIssued', () => {
    it('logs at INFO for routine commit-arm refund', async () => {
      const service = await buildService();
      const { log } = spyOnLogger(service);

      await service.refundIssued({
        orderId: 'abc12345-6789-4def-89ab-cdef01234567',
        refundAmountCents: 500,
        customerName: 'Sarah Mitchell',
        staffDisplayName: 'Manager Jane',
      });

      const payload = parseDispatch(log.mock.calls[0]![0] as string);
      expect(payload.body).toBe(
        'REFUND ISSUED — Order #abc12345 — $5.00 — Customer: Sarah M. — by: Manager Jane',
      );
    });
  });

  describe('dispatch log-format convention', () => {
    it('every dispatch method emits [telegram] {alert,chat_id,level,body,...}', async () => {
      const service = await buildService();
      const { log, warn } = spyOnLogger(service);

      await service.newOrder({
        orderId: 'a',
        customerName: 'A B',
        items: [{ name: 'X', quantity: 1 }],
        totalCents: 100,
        locationName: 'L',
      });
      await service.paymentFailed({ orderId: 'b', totalCents: 100, customerName: 'A B' });
      await service.itemSoldOut({ itemId: 'i', itemName: 'X', locationName: 'L' });
      await service.orderingPaused({ locationName: 'L', staffDisplayName: 'Manager M' });
      await service.orderCancelledByStaff({
        orderId: 'c',
        totalCents: 100,
        customerName: 'A B',
        staffDisplayName: 'Manager M',
        reason: 'r',
      });
      await service.refundIssued({
        orderId: 'd',
        refundAmountCents: 50,
        customerName: 'A B',
        staffDisplayName: 'Manager M',
      });

      const allLines = [
        ...log.mock.calls.map((c) => c[0] as string),
        ...warn.mock.calls.map((c) => c[0] as string),
      ];
      expect(allLines).toHaveLength(6);

      for (const line of allLines) {
        const payload = parseDispatch(line);
        expect(payload).toMatchObject({
          alert: expect.any(String),
          chat_id: 'owner',
          level: expect.stringMatching(/^(info|warn)$/),
          body: expect.any(String),
        });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // C8 real-send paths — fetch is mocked. Verify configured mode performs
  // the POST, and verify the classifier-routed permanent/transient split.
  // ---------------------------------------------------------------------------

  describe('configured mode — real Bot API POST', () => {
    it('calls fetch to api.telegram.org with chat_id and text on happy path', async () => {
      const service = await buildService();
      spyOnLogger(service);

      await service.newOrder({
        orderId: 'abc12345',
        customerName: 'Sarah Mitchell',
        items: [{ name: 'Latte', quantity: 1 }],
        totalCents: 500,
        locationName: 'Main St',
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://api.telegram.org/botbot-token-abc/sendMessage');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string) as { chat_id: string; text: string };
      expect(body.chat_id).toBe('owner-chat-123');
      expect(body.text).toContain('NEW ORDER');
      expect(body.text).toContain('Sarah M.');
    });

    it('does NOT call fetch when bot token is missing (stub-only fallback)', async () => {
      const service = await buildService({ TELEGRAM_OWNER_CHAT_ID: 'owner-chat-123' });
      const { log } = spyOnLogger(service);

      await service.newOrder({
        orderId: 'x',
        customerName: 'A B',
        items: [{ name: 'X', quantity: 1 }],
        totalCents: 100,
        locationName: 'L',
      });

      expect(fetchMock).not.toHaveBeenCalled();
      // Log line is the entire delivery.
      expect(log).toHaveBeenCalledTimes(1);
    });

    it('does NOT call fetch when chat id is missing (stub-only fallback)', async () => {
      const service = await buildService({ TELEGRAM_BOT_TOKEN: 'bot-token-abc' });
      spyOnLogger(service);

      await service.newOrder({
        orderId: 'x',
        customerName: 'A B',
        items: [{ name: 'X', quantity: 1 }],
        totalCents: 100,
        locationName: 'L',
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('still emits the [telegram] log line on the real-send happy path', async () => {
      const service = await buildService();
      const { log } = spyOnLogger(service);

      await service.itemSoldOut({ itemId: 'i', itemName: 'Latte', locationName: 'L' });

      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]![0]).toMatch(/^\[telegram\] /);
    });
  });

  describe('configured mode — error handling', () => {
    it('400 Bad Request → permanent, swallows + warns', async () => {
      const service = await buildService();
      const { warn } = spyOnLogger(service);
      fetchMock.mockResolvedValueOnce(makeErrorResponse(400, 'Bad Request: chat not found') as Response);

      await expect(
        service.newOrder({
          orderId: 'x',
          customerName: 'A',
          items: [{ name: 'X', quantity: 1 }],
          totalCents: 100,
          locationName: 'L',
        }),
      ).resolves.toBeUndefined();

      // The dispatch log line + the permanent-error warn line.
      expect(warn.mock.calls.some((c) => /permanent send error.*status 400/.test(c[0] as string))).toBe(true);
    });

    it('401 Unauthorized → permanent, swallows', async () => {
      const service = await buildService();
      spyOnLogger(service);
      fetchMock.mockResolvedValueOnce(makeErrorResponse(401, 'Unauthorized') as Response);

      await expect(
        service.itemSoldOut({ itemId: 'i', itemName: 'X', locationName: 'L' }),
      ).resolves.toBeUndefined();
    });

    it('403 Forbidden → permanent, swallows', async () => {
      const service = await buildService();
      spyOnLogger(service);
      fetchMock.mockResolvedValueOnce(makeErrorResponse(403, 'Bot was blocked') as Response);

      await expect(
        service.itemSoldOut({ itemId: 'i', itemName: 'X', locationName: 'L' }),
      ).resolves.toBeUndefined();
    });

    it('404 Not Found → permanent, swallows', async () => {
      const service = await buildService();
      spyOnLogger(service);
      fetchMock.mockResolvedValueOnce(makeErrorResponse(404, 'Chat not found') as Response);

      await expect(
        service.itemSoldOut({ itemId: 'i', itemName: 'X', locationName: 'L' }),
      ).resolves.toBeUndefined();
    });

    it('429 Too Many Requests → transient, throws', async () => {
      const service = await buildService();
      spyOnLogger(service);
      fetchMock.mockResolvedValueOnce(makeErrorResponse(429, 'Retry after 30') as Response);

      await expect(
        service.itemSoldOut({ itemId: 'i', itemName: 'X', locationName: 'L' }),
      ).rejects.toThrow(/transient send error.*status 429/);
    });

    it('500 server error → transient, throws', async () => {
      const service = await buildService();
      spyOnLogger(service);
      fetchMock.mockResolvedValueOnce(makeErrorResponse(500) as Response);

      await expect(
        service.itemSoldOut({ itemId: 'i', itemName: 'X', locationName: 'L' }),
      ).rejects.toThrow(/transient send error.*status 500/);
    });

    it('network error (fetch rejection) → throws as transient', async () => {
      const service = await buildService();
      spyOnLogger(service);
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));

      await expect(
        service.itemSoldOut({ itemId: 'i', itemName: 'X', locationName: 'L' }),
      ).rejects.toThrow(/network error.*ECONNRESET/);
    });

    it('AbortError (timeout) → throws as transient', async () => {
      const service = await buildService();
      spyOnLogger(service);
      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      fetchMock.mockRejectedValueOnce(abortErr);

      await expect(
        service.itemSoldOut({ itemId: 'i', itemName: 'X', locationName: 'L' }),
      ).rejects.toThrow(/network error/);
    });

    it('non-JSON error response is still classified by status code alone', async () => {
      const service = await buildService();
      spyOnLogger(service);
      const badJsonResponse: Partial<Response> = {
        ok: false,
        status: 502,
        json: async () => {
          throw new Error('not json');
        },
      };
      fetchMock.mockResolvedValueOnce(badJsonResponse as Response);

      await expect(
        service.itemSoldOut({ itemId: 'i', itemName: 'X', locationName: 'L' }),
      ).rejects.toThrow(/transient send error.*status 502/);
    });
  });
});

// =============================================================================
// alertDeadOutboxEvent — KEEPS legacy [telegram-stub] prefix per C3 entry.
// C8 wires real-send when configured; the inner catch swallows any send
// failure and emits the [telegram] dead-event-alert-failed marker.
// =============================================================================

describe('TelegramService — alertDeadOutboxEvent', () => {
  let fetchMock: FetchMock;
  const realFetch = global.fetch;

  beforeEach(() => {
    fetchMock = jest.fn(async () => makeOkResponse() as Response) as unknown as FetchMock;
    (global as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    (global as { fetch: typeof fetch }).fetch = realFetch;
    jest.restoreAllMocks();
  });

  function makeDeadEvent(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
    return {
      id: 'evt-1',
      event_type: 'ORDER_PAID' as unknown as OutboxEventType,
      attempts: 5,
      created_at: new Date('2026-05-09T14:00:00.000Z'),
      payload: { orderId: 'order-1' },
      status: 'DEAD' as unknown as OutboxStatus,
      processed_at: null,
      processing_started_at: null,
      last_error: 'connection refused',
      ...overrides,
    } as unknown as OutboxEvent;
  }

  it('unconfigured: logs [telegram-stub] would alert owner without fetch', async () => {
    const service = await buildService({ /* no creds */ });
    const { warn } = spyOnLogger(service);

    await service.alertDeadOutboxEvent(makeDeadEvent(), 'connection refused');

    expect(fetchMock).not.toHaveBeenCalled();
    const line = warn.mock.calls[0]![0] as string;
    expect(line).toMatch(/^\[telegram-stub\] would alert owner:\n/);
    expect(line).toMatch(/DEAD OUTBOX EVENT/);
    expect(line).toMatch(/event_id:\s+evt-1/);
    expect(line).toMatch(/last_error:\s+connection refused/);
  });

  it('configured: logs [telegram-stub] alert owner AND performs fetch', async () => {
    const service = await buildService();
    const { warn } = spyOnLogger(service);

    await service.alertDeadOutboxEvent(makeDeadEvent(), 'connection refused');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]![0] as string;
    expect(line).toMatch(/^\[telegram-stub\] alert owner:\n/);
  });

  it('inner catch: fetch failure logs [telegram] dead-event-alert-failed and does NOT throw', async () => {
    const service = await buildService();
    const { error } = spyOnLogger(service);
    fetchMock.mockRejectedValueOnce(new Error('boom'));

    await expect(
      service.alertDeadOutboxEvent(makeDeadEvent(), 'connection refused'),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toMatch(/dead-event-alert-failed/);
  });

  it('inner catch: HTTP 5xx (transient) also swallowed at this method (no cascade)', async () => {
    // The outer outbox.worker catch already prevents cascade; this inner
    // catch is belt-and-suspenders so direct callers get safe semantics.
    const service = await buildService();
    const { error } = spyOnLogger(service);
    fetchMock.mockResolvedValueOnce(makeErrorResponse(500) as Response);

    await expect(
      service.alertDeadOutboxEvent(makeDeadEvent(), 'boom'),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('truncates message body when it exceeds Telegram safe-cap', async () => {
    const service = await buildService();
    spyOnLogger(service);
    const bigPayload: Record<string, string> = {};
    for (let i = 0; i < 200; i++) bigPayload[`k${i}`] = 'x'.repeat(40);
    const event = makeDeadEvent({ payload: bigPayload });

    await service.alertDeadOutboxEvent(event, 'big');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1];
    const body = JSON.parse(init!.body as string) as { text: string };
    expect(body.text.length).toBeLessThanOrEqual(4096);
    expect(body.text).toMatch(/\.\.\. \(truncated, see CloudWatch/);
  });
});
