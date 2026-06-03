import { MigrationInterface, QueryRunner } from 'typeorm';

// Restores the order composites silently dropped by AddExplicitIndexes
// (1778273529985) and adds menu FK indexes (Postgres does NOT auto-index FKs).
// Additive: existing single-column IDX_orders_* indexes are kept.
export class AddReliabilityHotPathIndexes1780500000000 implements MigrationInterface {
  name = 'AddReliabilityHotPathIndexes1780500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_loc_status_created" ON "orders" ("location_id", "order_status", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_customer_created" ON "orders" ("customer_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_status_created" ON "orders" ("order_status", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_menu_categories_location" ON "menu_categories" ("location_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_menu_items_category" ON "menu_items" ("category_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_modifier_groups_item" ON "modifier_groups" ("item_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_modifiers_group" ON "modifiers" ("group_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_modifiers_group"`);
    await queryRunner.query(`DROP INDEX "IDX_modifier_groups_item"`);
    await queryRunner.query(`DROP INDEX "IDX_menu_items_category"`);
    await queryRunner.query(`DROP INDEX "IDX_menu_categories_location"`);
    await queryRunner.query(`DROP INDEX "IDX_orders_status_created"`);
    await queryRunner.query(`DROP INDEX "IDX_orders_customer_created"`);
    await queryRunner.query(`DROP INDEX "IDX_orders_loc_status_created"`);
  }
}
