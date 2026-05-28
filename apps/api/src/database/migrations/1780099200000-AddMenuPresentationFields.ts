import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the v4 Menu screen presentation fields to the menu tables:
 *
 *   menu_categories.display_style  ('spotlight' | 'list', default 'list')
 *   menu_items.temperature         ('hot' | 'iced' | 'both', default 'both')
 *   menu_items.featured            (boolean, default false)
 *   menu_items.art_token           (text, nullable)
 *
 * Defaults are fail-safe (Golden Rule #17) — a row without any
 * presentation data renders as a plain list item that shows under
 * every temperature filter, and iOS draws a neutral symbol for a
 * null art_token. The Public types in menu.service.ts surface the
 * new fields verbatim.
 *
 * Backfill: the seed:menu dev catalog already contains a 'Matcha'
 * category seeded by an earlier version of this work — we promote it
 * to display_style='spotlight', mark 'Strawberry Matcha' featured,
 * and set the existing matcha items' temperature to 'iced'. Any DB
 * that doesn't have those rows (fresh seed:dev only, or a prod-like
 * environment) is unaffected by the UPDATEs.
 *
 * down() drops the four columns in reverse order.
 */
export class AddMenuPresentationFields1780099200000 implements MigrationInterface {
    name = 'AddMenuPresentationFields1780099200000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // 1. Schema additions — all NOT NULL with fail-safe defaults except art_token.
        await queryRunner.query(`ALTER TABLE "menu_categories" ADD "display_style" text NOT NULL DEFAULT 'list'`);
        await queryRunner.query(`ALTER TABLE "menu_items" ADD "temperature" text NOT NULL DEFAULT 'both'`);
        await queryRunner.query(`ALTER TABLE "menu_items" ADD "featured" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "menu_items" ADD "art_token" text`);

        // 2. Backfill existing dev seed (no-op on environments that don't have a Matcha category).
        await queryRunner.query(`
            UPDATE "menu_categories"
            SET display_style = 'spotlight'
            WHERE "name" = 'Matcha'
        `);
        await queryRunner.query(`
            UPDATE "menu_items" mi
            SET temperature = 'iced'
            FROM "menu_categories" mc
            WHERE mi."category_id" = mc."id" AND mc."name" = 'Matcha'
        `);
        await queryRunner.query(`
            UPDATE "menu_items" mi
            SET featured = true
            FROM "menu_categories" mc
            WHERE mi."category_id" = mc."id"
              AND mc."name" = 'Matcha'
              AND mi."name" = 'Strawberry Matcha'
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "menu_items" DROP COLUMN "art_token"`);
        await queryRunner.query(`ALTER TABLE "menu_items" DROP COLUMN "featured"`);
        await queryRunner.query(`ALTER TABLE "menu_items" DROP COLUMN "temperature"`);
        await queryRunner.query(`ALTER TABLE "menu_categories" DROP COLUMN "display_style"`);
    }
}
