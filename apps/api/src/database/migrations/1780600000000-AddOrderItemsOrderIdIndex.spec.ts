import { QueryRunner } from 'typeorm';
import { AddOrderItemsOrderIdIndex1780600000000 } from './1780600000000-AddOrderItemsOrderIdIndex';

function buildRunner() {
  return { query: jest.fn().mockResolvedValue(undefined) } as unknown as QueryRunner;
}

describe('AddOrderItemsOrderIdIndex1780600000000', () => {
  it('up() creates IDX_order_items_order_id on order_items(order_id)', async () => {
    const runner = buildRunner();
    await new AddOrderItemsOrderIdIndex1780600000000().up(runner);

    const sql = (runner.query as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('CREATE INDEX "IDX_order_items_order_id"');
    expect(sql[0]).toContain('"order_items"');
    expect(sql[0]).toContain('"order_id"');
  });

  it('down() drops IDX_order_items_order_id', async () => {
    const runner = buildRunner();
    await new AddOrderItemsOrderIdIndex1780600000000().down(runner);

    const sql = (runner.query as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('DROP INDEX "IDX_order_items_order_id"');
  });
});
