import { QueryRunner } from 'typeorm';
import { AddMenuItemBadgeType1780300000000 } from './1780300000000-AddMenuItemBadgeType';

function buildRunner() {
  return { query: jest.fn().mockResolvedValue(undefined) } as unknown as QueryRunner;
}

describe('AddMenuItemBadgeType1780300000000', () => {
  it('up() adds a nullable badge_type text column (no NOT NULL, no default row backfill)', async () => {
    const runner = buildRunner();
    await new AddMenuItemBadgeType1780300000000().up(runner);

    const sql = (runner.query as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(sql.some((s) => /ALTER TABLE "menu_items" ADD "badge_type" text/.test(s))).toBe(true);
    // Fail-safe: nullable, no NOT NULL constraint (GR#17 — a row with no badge is the norm).
    expect(sql.some((s) => /badge_type" text NOT NULL/.test(s))).toBe(false);
  });

  it('down() drops the badge_type column', async () => {
    const runner = buildRunner();
    await new AddMenuItemBadgeType1780300000000().down(runner);

    const sql = (runner.query as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(sql).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/ALTER TABLE "menu_items" DROP COLUMN "badge_type"/),
      ]),
    );
  });
});
