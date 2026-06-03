import { QueryRunner } from 'typeorm';
import { AddReliabilityHotPathIndexes1780500000000 } from './1780500000000-AddReliabilityHotPathIndexes';

function buildRunner() {
  return { query: jest.fn().mockResolvedValue(undefined) } as unknown as QueryRunner;
}

describe('AddReliabilityHotPathIndexes1780500000000', () => {
  it('up() issues exactly 7 CREATE INDEX queries with correct names and columns', async () => {
    const runner = buildRunner();
    await new AddReliabilityHotPathIndexes1780500000000().up(runner);

    const sql = (runner.query as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(sql).toHaveLength(7);

    expect(sql).toEqual(
      expect.arrayContaining([
        expect.stringContaining('IDX_orders_loc_status_created'),
        expect.stringContaining('IDX_orders_customer_created'),
        expect.stringContaining('IDX_orders_status_created'),
        expect.stringContaining('IDX_menu_categories_location'),
        expect.stringContaining('IDX_menu_items_category'),
        expect.stringContaining('IDX_modifier_groups_item'),
        expect.stringContaining('IDX_modifiers_group'),
      ]),
    );

    // Column lists
    expect(sql.some((s) => s.includes('IDX_orders_loc_status_created') && s.includes('"location_id"') && s.includes('"order_status"') && s.includes('"created_at"'))).toBe(true);
    expect(sql.some((s) => s.includes('IDX_orders_customer_created') && s.includes('"customer_id"') && s.includes('"created_at"'))).toBe(true);
    expect(sql.some((s) => s.includes('IDX_orders_status_created') && s.includes('"order_status"') && s.includes('"created_at"'))).toBe(true);
    expect(sql.some((s) => s.includes('IDX_menu_categories_location') && s.includes('"location_id"'))).toBe(true);
    expect(sql.some((s) => s.includes('IDX_menu_items_category') && s.includes('"category_id"'))).toBe(true);
    expect(sql.some((s) => s.includes('IDX_modifier_groups_item') && s.includes('"item_id"'))).toBe(true);
    expect(sql.some((s) => s.includes('IDX_modifiers_group') && s.includes('"group_id"'))).toBe(true);
  });

  it('down() issues exactly 7 DROP INDEX queries in reverse order of up()', async () => {
    const runner = buildRunner();
    await new AddReliabilityHotPathIndexes1780500000000().down(runner);

    const sql = (runner.query as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(sql).toHaveLength(7);

    expect(sql).toEqual(
      expect.arrayContaining([
        expect.stringContaining('IDX_modifiers_group'),
        expect.stringContaining('IDX_modifier_groups_item'),
        expect.stringContaining('IDX_menu_items_category'),
        expect.stringContaining('IDX_menu_categories_location'),
        expect.stringContaining('IDX_orders_status_created'),
        expect.stringContaining('IDX_orders_customer_created'),
        expect.stringContaining('IDX_orders_loc_status_created'),
      ]),
    );

    // Reverse order: modifiers_group first, loc_status_created last
    const names = sql.map((s) => {
      const m = s.match(/"(IDX_[^"]+)"/);
      return m ? m[1] : '';
    });
    expect(names[0]).toBe('IDX_modifiers_group');
    expect(names[1]).toBe('IDX_modifier_groups_item');
    expect(names[2]).toBe('IDX_menu_items_category');
    expect(names[3]).toBe('IDX_menu_categories_location');
    expect(names[4]).toBe('IDX_orders_status_created');
    expect(names[5]).toBe('IDX_orders_customer_created');
    expect(names[6]).toBe('IDX_orders_loc_status_created');
  });
});
