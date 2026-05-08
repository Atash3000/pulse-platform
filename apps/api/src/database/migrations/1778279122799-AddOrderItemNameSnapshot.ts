import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the order_items.item_name snapshot column. Frozen at order time so
 * historical orders survive menu_items renames or deletes — matches the
 * snapshot semantics already in place for unit_price_cents and the modifiers
 * JSONB array. Documented as required in apps/api/src/modules/checkout/README.md
 * and docs/golden-rules.md (rule #15 — orders must be a complete record of
 * what was sold).
 *
 * Safe-NOT-NULL pattern for tables with existing rows:
 *   1. ADD COLUMN ... NULL
 *   2. UPDATE ... SET item_name = (SELECT name FROM menu_items WHERE id = order_items.menu_item_id)
 *   3. ALTER COLUMN ... SET NOT NULL
 *
 * (Spurious `SET DEFAULT` calls emitted by the TypeORM 0.3 generator were
 *  stripped — known quirk, see apps/api/README.md.)
 */
export class AddOrderItemNameSnapshot1778279122799 implements MigrationInterface {
    name = 'AddOrderItemNameSnapshot1778279122799'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "order_items" ADD "item_name" text`);
        await queryRunner.query(`
            UPDATE "order_items" oi
            SET item_name = COALESCE(
              (SELECT mi.name FROM "menu_items" mi WHERE mi.id = oi.menu_item_id),
              'Unknown Item'
            )
            WHERE oi.item_name IS NULL
        `);
        await queryRunner.query(`ALTER TABLE "order_items" ALTER COLUMN "item_name" SET NOT NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "order_items" DROP COLUMN "item_name"`);
    }

}
