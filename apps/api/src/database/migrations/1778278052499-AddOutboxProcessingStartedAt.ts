import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds outbox_events.processing_started_at — the timestamp the outbox worker
 * sets when it picks up a row, BEFORE dispatch. Splits queue latency from
 * processing latency in observability dashboards and exposes the "stuck"
 * state where processing_started_at IS NOT NULL but processed_at IS NULL.
 *
 * (The TypeORM generator also emitted no-op `SET DEFAULT` calls for jsonb
 * and array columns whose entity defaults round-trip slightly differently
 * from the database catalogue. They were stripped — known TypeORM 0.3 quirk
 * already documented in apps/api/README.md.)
 */
export class AddOutboxProcessingStartedAt1778278052499 implements MigrationInterface {
    name = 'AddOutboxProcessingStartedAt1778278052499'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "outbox_events" ADD "processing_started_at" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "outbox_events" DROP COLUMN "processing_started_at"`);
    }

}
