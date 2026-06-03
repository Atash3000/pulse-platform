import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds menu_items.sort_order — an integer display-order key within a
 * category. Items are returned ORDER BY sort_order ASC, name ASC, so the
 * v4 Menu's spotlight sub-heros are curated (the seed puts signature
 * drinks first) instead of alphabetical.
 *
 * NOT NULL DEFAULT 0: every existing/un-curated item sorts by the
 * secondary `name` key, so the column is safe to add without a backfill.
 * The value is NOT exposed in the public menu DTO — the service returns
 * items already ordered, so the cache payload shape is unchanged (no
 * cache-namespace bump needed).
 *
 * down() drops the column.
 */
export class AddMenuItemSortOrder1780400000000 implements MigrationInterface {
    name = 'AddMenuItemSortOrder1780400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "menu_items" ADD "sort_order" integer NOT NULL DEFAULT 0`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "menu_items" DROP COLUMN "sort_order"`);
    }
}
