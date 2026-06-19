import { MigrationInterface, QueryRunner } from 'typeorm';

// Structural webhook dedup: one row per Stripe event id, claimed via
// INSERT ... ON CONFLICT DO NOTHING at the top of each webhook handler
// transaction. The existing order-state guards in WebhookOrdersService stay
// in place (belt and braces); this table makes dedup structural for all
// FUTURE event types, and makes the documented "dedup on stripe_event_id"
// behavior actually true at the schema level.
//
// Retention note: the table is append-only. At the launch target
// (~50 orders/day → low hundreds of webhook events/day) growth is trivial;
// a pruning job (e.g. DELETE WHERE created_at < now() - interval '90 days')
// can be added later without any code change — Stripe stops retrying an
// event after 3 days, so old rows are never consulted again.
export class AddProcessedStripeEvents1780700000000 implements MigrationInterface {
  name = 'AddProcessedStripeEvents1780700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "processed_stripe_events" (` +
        `"event_id" text NOT NULL, ` +
        `"event_type" text NOT NULL, ` +
        `"created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), ` +
        `CONSTRAINT "PK_processed_stripe_events" PRIMARY KEY ("event_id"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "processed_stripe_events"`);
  }
}
