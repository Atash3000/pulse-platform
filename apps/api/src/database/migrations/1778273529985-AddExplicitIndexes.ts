import { MigrationInterface, QueryRunner } from "typeorm";

export class AddExplicitIndexes1778273529985 implements MigrationInterface {
    name = 'AddExplicitIndexes1778273529985'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_744315ba30953a7651688720c6"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_11fefa35e3ef25881234b8b89a"`);
        await queryRunner.query(`ALTER TABLE "pricing_rules" ALTER COLUMN "tip_options" SET DEFAULT '{15,18,20,25}'::int[]`);
        await queryRunner.query(`ALTER TABLE "order_items" ALTER COLUMN "modifiers" SET DEFAULT '[]'::jsonb`);
        await queryRunner.query(`ALTER TABLE "customer_ai_profiles" ALTER COLUMN "disliked_items" SET DEFAULT '{}'::text[]`);
        await queryRunner.query(`ALTER TABLE "customer_ai_profiles" ALTER COLUMN "dietary_flags" SET DEFAULT '{}'::text[]`);
        await queryRunner.query(`ALTER TABLE "customer_ai_profiles" ALTER COLUMN "usual_order_days" SET DEFAULT '{}'::int[]`);
        await queryRunner.query(`CREATE INDEX "IDX_orders_created_at" ON "orders" ("created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_orders_order_status" ON "orders" ("order_status") `);
        await queryRunner.query(`CREATE INDEX "IDX_orders_location_id" ON "orders" ("location_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_orders_customer_id" ON "orders" ("customer_id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_orders_customer_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_orders_location_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_orders_order_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_orders_created_at"`);
        await queryRunner.query(`ALTER TABLE "customer_ai_profiles" ALTER COLUMN "usual_order_days" SET DEFAULT '{}'`);
        await queryRunner.query(`ALTER TABLE "customer_ai_profiles" ALTER COLUMN "dietary_flags" SET DEFAULT '{}'`);
        await queryRunner.query(`ALTER TABLE "customer_ai_profiles" ALTER COLUMN "disliked_items" SET DEFAULT '{}'`);
        await queryRunner.query(`ALTER TABLE "order_items" ALTER COLUMN "modifiers" SET DEFAULT '[]'`);
        await queryRunner.query(`ALTER TABLE "pricing_rules" ALTER COLUMN "tip_options" SET DEFAULT '{15,18,20,25}'`);
        await queryRunner.query(`CREATE INDEX "IDX_11fefa35e3ef25881234b8b89a" ON "orders" ("customer_id", "created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_744315ba30953a7651688720c6" ON "orders" ("location_id", "order_status") `);
    }

}
