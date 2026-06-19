import { QueryRunner } from 'typeorm';
import { AddRefundPaymentOrderIdIndexes1780800000000 } from './1780800000000-AddRefundPaymentOrderIdIndexes';

function buildRunner() {
  return { query: jest.fn().mockResolvedValue(undefined) } as unknown as QueryRunner;
}

describe('AddRefundPaymentOrderIdIndexes1780800000000', () => {
  it('up() creates the order_id index on both refunds and payments', async () => {
    const runner = buildRunner();
    await new AddRefundPaymentOrderIdIndexes1780800000000().up(runner);

    const sql = (runner.query as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(sql).toHaveLength(2);
    expect(sql[0]).toContain('CREATE INDEX "IDX_refunds_order_id"');
    expect(sql[0]).toContain('"refunds"');
    expect(sql[0]).toContain('"order_id"');
    expect(sql[1]).toContain('CREATE INDEX "IDX_payments_order_id"');
    expect(sql[1]).toContain('"payments"');
    expect(sql[1]).toContain('"order_id"');
  });

  it('down() drops both indexes', async () => {
    const runner = buildRunner();
    await new AddRefundPaymentOrderIdIndexes1780800000000().down(runner);

    const sql = (runner.query as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(sql).toHaveLength(2);
    expect(sql.some((s) => s.includes('DROP INDEX "IDX_payments_order_id"'))).toBe(true);
    expect(sql.some((s) => s.includes('DROP INDEX "IDX_refunds_order_id"'))).toBe(true);
  });
});
