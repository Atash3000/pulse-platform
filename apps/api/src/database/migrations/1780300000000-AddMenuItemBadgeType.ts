import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds menu_items.badge_type — an optional monochrome merchandising
 * badge surfaced on the iOS product detail screen.
 *
 *   menu_items.badge_type  ('signature' | 'staff_pick' | 'seasonal' | NULL)
 *
 * Nullable with NO default and NO backfill: the overwhelming majority of
 * items carry no badge, and "no badge" is the fail-safe rendering
 * (Golden Rule #17 — iOS shows nothing when the value is null/unknown).
 * The allowed value set is enforced in application code, not a DB CHECK,
 * to match the existing text-enum columns (temperature, display_style)
 * which also rely on app-level validation + fail-safe decoding.
 *
 * PublicMenuItem in menu.service.ts surfaces the field verbatim; the
 * menu cache namespace is bumped to v3 in the same slice because the
 * cached payload shape gains a field (see decision-log 2026-05-28).
 *
 * down() drops the column.
 */
export class AddMenuItemBadgeType1780300000000 implements MigrationInterface {
    name = 'AddMenuItemBadgeType1780300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "menu_items" ADD "badge_type" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "menu_items" DROP COLUMN "badge_type"`);
    }
}
