import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Splits the single `customers.full_name` column into `first_name` +
 * `last_name`, and adds the optional `nickname` (barista-facing) and
 * `date_of_birth` (birthday-loyalty) columns.
 *
 * Driven by the richer registration form (see decision-log) and the open
 * 2026-05-24 product question on the birthday perk ("if yes, add a birthday
 * column on customers"). The barista-facing nickname feeds the staff order
 * surfaces (Telegram alerts, admin order list) via Customer.baristaName.
 *
 * staff_users.full_name is intentionally NOT touched — staff are a separate
 * surface and out of scope for this change.
 *
 * Safe-NOT-NULL pattern for tables with existing rows (mirrors
 * AddOrderItemNameSnapshot):
 *   1. ADD COLUMN ... NULL
 *   2. backfill from full_name (split on first whitespace run)
 *   3. ALTER COLUMN ... SET NOT NULL
 *   4. DROP the old full_name column
 *
 * down() reverses it: re-derive full_name from first + last, then drop the
 * four new columns.
 */
export class AddCustomerProfileFields1779835200000 implements MigrationInterface {
    name = 'AddCustomerProfileFields1779835200000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "customers" ADD "first_name" text`);
        await queryRunner.query(`ALTER TABLE "customers" ADD "last_name" text`);
        await queryRunner.query(`ALTER TABLE "customers" ADD "nickname" text`);
        await queryRunner.query(`ALTER TABLE "customers" ADD "date_of_birth" date`);

        // Split full_name on the first run of whitespace: the first token
        // becomes first_name, everything after becomes last_name. Single-word
        // names ("Madonna") leave last_name = '' (allowed: NOT NULL only bars
        // NULL). Empty/whitespace names fall back to 'Customer'.
        await queryRunner.query(`
            UPDATE "customers"
            SET
              "first_name" = COALESCE(
                NULLIF((regexp_split_to_array(trim("full_name"), '\\s+'))[1], ''),
                'Customer'
              ),
              "last_name" = COALESCE(
                array_to_string(
                  (regexp_split_to_array(trim("full_name"), '\\s+'))[2:cardinality(regexp_split_to_array(trim("full_name"), '\\s+'))],
                  ' '
                ),
                ''
              )
            WHERE "first_name" IS NULL
        `);

        await queryRunner.query(`ALTER TABLE "customers" ALTER COLUMN "first_name" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "customers" ALTER COLUMN "last_name" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN "full_name"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "customers" ADD "full_name" text`);
        await queryRunner.query(`
            UPDATE "customers"
            SET "full_name" = trim("first_name" || ' ' || COALESCE("last_name", ''))
            WHERE "full_name" IS NULL
        `);
        await queryRunner.query(`ALTER TABLE "customers" ALTER COLUMN "full_name" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN "date_of_birth"`);
        await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN "nickname"`);
        await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN "last_name"`);
        await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN "first_name"`);
    }

}
