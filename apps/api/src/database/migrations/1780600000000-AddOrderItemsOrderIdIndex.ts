import { MigrationInterface, QueryRunner } from 'typeorm';

// order_items had no index beyond its PK — Postgres does NOT auto-index FKs.
// order_items(order_id) serves every items-by-order join: customer order
// detail (GET /orders/:id, polled every 10s while an order is active), the
// home reorder summary (order_items JOIN orders), and the admin queue/
// dashboard item loads. Additive; companion to AddReliabilityHotPathIndexes.
export class AddOrderItemsOrderIdIndex1780600000000 implements MigrationInterface {
  name = 'AddOrderItemsOrderIdIndex1780600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_order_items_order_id" ON "order_items" ("order_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_order_items_order_id"`);
  }
}
