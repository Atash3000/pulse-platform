import { QueryRunner } from 'typeorm';
import { AddMenuItemSortOrder1780400000000 } from './1780400000000-AddMenuItemSortOrder';

function buildRunner() {
  return { query: jest.fn().mockResolvedValue(undefined) } as unknown as QueryRunner;
}

describe('AddMenuItemSortOrder1780400000000', () => {
  it('up() adds sort_order integer NOT NULL DEFAULT 0', async () => {
    const runner = buildRunner();
    await new AddMenuItemSortOrder1780400000000().up(runner);
    const sql = (runner.query as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(sql.some((s) => /ALTER TABLE "menu_items" ADD "sort_order" integer NOT NULL DEFAULT 0/.test(s))).toBe(true);
  });

  it('down() drops the sort_order column', async () => {
    const runner = buildRunner();
    await new AddMenuItemSortOrder1780400000000().down(runner);
    const sql = (runner.query as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(sql).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/ALTER TABLE "menu_items" DROP COLUMN "sort_order"/),
      ]),
    );
  });
});
