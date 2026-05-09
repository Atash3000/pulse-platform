import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import type { OutboxEvent, OutboxEventType, OutboxStatus } from '../../database/entities';
import { TelegramService } from './telegram.service';

// =============================================================================
// TelegramService — alert methods (C3) plus the legacy alertDeadOutboxEvent
// (C0). Two configurations matter for testing the C3 extensions:
//
//   - With TELEGRAM_OWNER_CHAT_ID configured → chat_id resolves to 'owner'.
//   - Without it (dev / test default) → chat_id resolves to null.
//
// Most tests use the configured variant so we can assert chat_id: 'owner'.
// One test per branch flips the config to verify the null fallback.
// =============================================================================

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
} {
  const logger = (service as unknown as { logger: { log: jest.Mock; warn: jest.Mock } }).logger;
  const log = jest.spyOn(logger, 'log').mockImplementation(() => {});
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  return { log, warn };
}

// ---------------------------------------------------------------------------
// Helper to extract the JSON payload from a `[telegram-stub] {...}` line.
// Tests use this to assert structured fields without parsing strings by
// hand. If the prefix or JSON shape ever drifts, the helper throws and the
// failure points clearly at the convention regression.
// ---------------------------------------------------------------------------

function parseStub(line: string): Record<string, unknown> {
  const match = line.match(/^\[telegram-stub\] (\{.+\})$/);
  if (!match) throw new Error(`Not a [telegram-stub] line: ${line}`);
  return JSON.parse(match[1]!);
}

describe('TelegramService — C3 alert methods', () => {
  describe('newOrder', () => {
    it('logs the Spec Part 9 NEW ORDER body at INFO level with chat_id="owner"', async () => {
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
      const payload = parseStub(log.mock.calls[0]![0] as string);
      expect(payload.alert).toBe('newOrder');
      expect(payload.chat_id).toBe('owner');
      expect(payload.level).toBe('info');
      expect(payload.body).toBe(
        'NEW ORDER — Sarah M. — Oat Latte + Muffin — $10.00 — Main St',
      );
      expect(payload.orderId).toBe('abc12345-6789-4def-89ab-cdef01234567');
    });

    it('chat_id is null when TELEGRAM_OWNER_CHAT_ID is not configured (dev / test default)', async () => {
      const service = await buildService({ /* no chat id */ });
      const { log } = spyOnLogger(service);

      await service.newOrder({
        orderId: 'order-1',
        customerName: 'Sarah Mitchell',
        items: [{ name: 'Latte', quantity: 1 }],
        totalCents: 500,
        locationName: 'Main St',
      });

      const payload = parseStub(log.mock.calls[0]![0] as string);
      expect(payload.chat_id).toBeNull();
    });
  });

  describe('paymentFailed', () => {
    it('logs the Spec Part 9 PAYMENT FAILED body at WARN level', async () => {
      const service = await buildService();
      const { log, warn } = spyOnLogger(service);

      await service.paymentFailed({
        orderId: 'abc12345-6789-4def-89ab-cdef01234567',
        totalCents: 850,
        customerName: 'Mike K',
      });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
      const payload = parseStub(warn.mock.calls[0]![0] as string);
      expect(payload.alert).toBe('paymentFailed');
      expect(payload.level).toBe('warn');
      expect(payload.chat_id).toBe('owner');
      expect(payload.body).toBe(
        'PAYMENT FAILED — Order #abc12345 — $8.50 — Customer: Mike K.',
      );
    });
  });

  describe('itemSoldOut', () => {
    it('logs at INFO with the item name UPPERCASED to match Spec Part 9 example', async () => {
      const service = await buildService();
      const { log, warn } = spyOnLogger(service);

      await service.itemSoldOut({
        itemId: 'item-oat-milk',
        itemName: 'Oat Milk',
        locationName: 'Main St',
      });

      expect(log).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
      const payload = parseStub(log.mock.calls[0]![0] as string);
      expect(payload.alert).toBe('itemSoldOut');
      expect(payload.level).toBe('info');
      expect(payload.body).toBe(
        'OAT MILK SOLD OUT — Auto-hidden from app — Main St',
      );
      expect(payload.itemId).toBe('item-oat-milk');
    });
  });

  describe('orderingPaused', () => {
    it('logs at WARN — paused ordering is operator-visible', async () => {
      const service = await buildService();
      const { log, warn } = spyOnLogger(service);

      await service.orderingPaused({
        locationName: 'Main St',
        staffDisplayName: 'Manager Jane',
      });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
      const payload = parseStub(warn.mock.calls[0]![0] as string);
      expect(payload.alert).toBe('orderingPaused');
      expect(payload.level).toBe('warn');
      expect(payload.body).toBe(
        'MOBILE ORDERING PAUSED — Main St — by: Manager Jane',
      );
    });
  });

  describe('orderCancelledByStaff', () => {
    it('logs at WARN with the manager + reason — extension beyond Part 9', async () => {
      const service = await buildService();
      const { log, warn } = spyOnLogger(service);

      await service.orderCancelledByStaff({
        orderId: 'abc12345-6789-4def-89ab-cdef01234567',
        totalCents: 1000,
        customerName: 'Sarah Mitchell',
        staffDisplayName: 'Manager Jane',
        reason: 'spilled drink',
      });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
      const payload = parseStub(warn.mock.calls[0]![0] as string);
      expect(payload.alert).toBe('orderCancelledByStaff');
      expect(payload.level).toBe('warn');
      expect(payload.body).toBe(
        'ORDER CANCELLED — Order #abc12345 — $10.00 — Customer: Sarah M. — by: Manager Jane — Reason: spilled drink',
      );
    });
  });

  describe('refundIssued', () => {
    it('logs at INFO for the routine commit-arm refund', async () => {
      const service = await buildService();
      const { log, warn } = spyOnLogger(service);

      await service.refundIssued({
        orderId: 'abc12345-6789-4def-89ab-cdef01234567',
        refundAmountCents: 500,
        customerName: 'Sarah Mitchell',
        staffDisplayName: 'Manager Jane',
      });

      expect(log).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
      const payload = parseStub(log.mock.calls[0]![0] as string);
      expect(payload.alert).toBe('refundIssued');
      expect(payload.level).toBe('info');
      expect(payload.body).toBe(
        'REFUND ISSUED — Order #abc12345 — $5.00 — Customer: Sarah M. — by: Manager Jane',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Convention test — every C3 method emits a `[telegram-stub] ${JSON}` line
  // with the four canonical fields (alert, chat_id, level, body). Pinned
  // once here so a regression that drops one of the fields fails fast
  // regardless of which method introduced it.
  // ---------------------------------------------------------------------------

  describe('hybrid log-format convention', () => {
    it('every C3 method produces a [telegram-stub] {alert,chat_id,level,body,...} payload', async () => {
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
        const payload = parseStub(line);
        expect(payload).toMatchObject({
          alert: expect.any(String),
          chat_id: 'owner',
          level: expect.stringMatching(/^(info|warn)$/),
          body: expect.any(String),
        });
      }
    });
  });
});

// =============================================================================
// Legacy alertDeadOutboxEvent — preserved unchanged in C3. Pinned here so a
// future "let's migrate to the hybrid format" change is an explicit decision
// rather than a silent regression.
// =============================================================================

describe('TelegramService — alertDeadOutboxEvent (legacy, plain-text)', () => {
  it('logs the multi-line plain-text DEAD-EVENT body at WARN', async () => {
    const service = await buildService();
    const { warn } = spyOnLogger(service);

    const event = {
      id: 'evt-1',
      event_type: 'ORDER_PAID' as unknown as OutboxEventType,
      attempts: 5,
      created_at: new Date('2026-05-09T14:00:00.000Z'),
      payload: { orderId: 'order-1' },
      status: 'DEAD' as unknown as OutboxStatus,
      processed_at: null,
      processing_started_at: null,
      last_error: 'connection refused',
    } as unknown as OutboxEvent;

    await service.alertDeadOutboxEvent(event, 'connection refused');

    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]![0] as string;
    // Format is intentionally NOT JSON-wrapped (out of scope for C3 to
    // migrate). Assert the prefix + multi-line body shape so a regression
    // that "improves" this to JSON gets caught here.
    expect(line).toMatch(/^\[telegram-stub\] (would alert owner|alert \(real send not yet implemented\)):\n/);
    expect(line).toMatch(/DEAD OUTBOX EVENT/);
    expect(line).toMatch(/event_id:\s+evt-1/);
    expect(line).toMatch(/attempts:\s+5/);
    expect(line).toMatch(/last_error:\s+connection refused/);
  });
});
