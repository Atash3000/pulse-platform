import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds `ORDER_PAID_NOTIFICATION` to `outbox_event_type_enum` for the C5
 * split-event design: every successful payment now emits BOTH `ORDER_PAID`
 * (analytics — last_visit_at + structured log via orderWorker) AND
 * `ORDER_PAID_NOTIFICATION` (manager Telegram alert via NotificationsService).
 *
 * Each event retries independently at the outbox-worker level — a transient
 * failure in one dispatch path doesn't cause the other's side effect to
 * re-fire. This prevents the duplicate-Telegram-alert bug that naive
 * single-event fan-out would produce. See decision-log entry "ORDER_PAID
 * split-event design: analytics + notification retry independently" for
 * the full rationale and the C1 decision-log's "Future C4 wiring" subsection
 * for the original design analysis.
 *
 * up()
 * ----
 * Single PG `ALTER TYPE ... ADD VALUE`. PG 12+ permits this inside a
 * transaction so long as the new value isn't USED in the same transaction;
 * we only add it here, so we're safe. Spec deployment is PG 15.
 *
 * down()
 * ------
 * Real rollback (not a defensive throw) because this codebase is not yet
 * deployed to production — no live `outbox_events.event_type =
 * 'ORDER_PAID_NOTIFICATION'` rows can exist outside local dev.
 *
 * PG doesn't support removing an enum value directly. The standard 5-step
 * pattern below works:
 *
 *   1. DELETE any rows that use the value (safety net for local dev).
 *   2. CREATE a new enum type WITHOUT the value.
 *   3. ALTER the column to use the new type via a text cast.
 *   4. DROP the old type.
 *   5. RENAME the new type back to the original name.
 *
 * If `outbox_events.event_type` ever grows a DEFAULT or CHECK constraint
 * in a future migration, this down() will need to drop and re-add those
 * around step 3. Currently the column is a bare NOT NULL with no default
 * (verified against the initial schema migration at line 61).
 */
export class AddOrderPaidNotificationEnumValue1778625600000 implements MigrationInterface {
    name = 'AddOrderPaidNotificationEnumValue1778625600000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TYPE "public"."outbox_event_type_enum" ADD VALUE 'ORDER_PAID_NOTIFICATION'`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // WARNING: this DELETE assumes no production `ORDER_PAID_NOTIFICATION`
        // records exist that need to be preserved. The codebase is local-dev
        // only at the time this migration was written. If running this
        // rollback in production, FIRST audit `outbox_events.event_type`
        // and decide whether to migrate the rows to another event type
        // (e.g., update them to `ORDER_PAID`) before deleting. The DELETE
        // below will erase any in-flight notification rows.
        await queryRunner.query(
            `DELETE FROM "outbox_events" WHERE "event_type" = 'ORDER_PAID_NOTIFICATION'`,
        );

        // Standard PG "remove enum value" pattern: create a new type
        // without the value, retype the column via a text cast, drop the
        // old type, rename the new type back. All inside this migration's
        // transaction.
        await queryRunner.query(
            `CREATE TYPE "public"."outbox_event_type_enum_new" AS ENUM(` +
                `'ORDER_PAID', 'ORDER_CANCELLED', 'ORDER_READY', ` +
                `'ORDER_PICKED_UP', 'REFUND_CREATED', 'ITEM_OUT_OF_STOCK'` +
                `)`,
        );

        await queryRunner.query(
            `ALTER TABLE "outbox_events" ALTER COLUMN "event_type" TYPE ` +
                `"public"."outbox_event_type_enum_new" USING ` +
                `"event_type"::text::"public"."outbox_event_type_enum_new"`,
        );

        await queryRunner.query(`DROP TYPE "public"."outbox_event_type_enum"`);

        await queryRunner.query(
            `ALTER TYPE "public"."outbox_event_type_enum_new" RENAME TO "outbox_event_type_enum"`,
        );
    }
}
