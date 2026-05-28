import { QueryRunner } from 'typeorm';
import { AddMenuPresentationFields1780099200000 } from './1780099200000-AddMenuPresentationFields';

function buildRunner() {
  return { query: jest.fn().mockResolvedValue(undefined) } as unknown as QueryRunner;
}

describe('AddMenuPresentationFields1780099200000', () => {
  it('up() adds display_style + temperature + featured + art_token with safe defaults', async () => {
    const runner = buildRunner();
    await new AddMenuPresentationFields1780099200000().up(runner);

    const sql = (runner.query as jest.Mock).mock.calls.map((c) => c[0] as string);

    // Schema additions
    expect(sql.some((s) => /ALTER TABLE "menu_categories" ADD "display_style" text NOT NULL DEFAULT 'list'/.test(s))).toBe(true);
    expect(sql.some((s) => /ALTER TABLE "menu_items" ADD "temperature" text NOT NULL DEFAULT 'both'/.test(s))).toBe(true);
    expect(sql.some((s) => /ALTER TABLE "menu_items" ADD "featured" boolean NOT NULL DEFAULT false/.test(s))).toBe(true);
    expect(sql.some((s) => /ALTER TABLE "menu_items" ADD "art_token" text/.test(s))).toBe(true);

    // Backfill: existing Matcha-category becomes spotlight; featured Strawberry Matcha; iced temperatures.
    // We assert the *intent* (a backfill UPDATE touching the seed names) rather than exact whitespace.
    const backfills = sql.filter((s) => /^\s*UPDATE/i.test(s));
    expect(backfills.length).toBeGreaterThanOrEqual(2);
    expect(backfills.some((s) => /display_style\s*=\s*'spotlight'/.test(s) && /Matcha/.test(s))).toBe(true);
    expect(backfills.some((s) => /featured\s*=\s*true/.test(s) && /Strawberry Matcha/.test(s))).toBe(true);
  });

  it('down() drops all four columns', async () => {
    const runner = buildRunner();
    await new AddMenuPresentationFields1780099200000().down(runner);

    const sql = (runner.query as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(sql).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/ALTER TABLE "menu_items" DROP COLUMN "art_token"/),
        expect.stringMatching(/ALTER TABLE "menu_items" DROP COLUMN "featured"/),
        expect.stringMatching(/ALTER TABLE "menu_items" DROP COLUMN "temperature"/),
        expect.stringMatching(/ALTER TABLE "menu_categories" DROP COLUMN "display_style"/),
      ]),
    );
  });
});
