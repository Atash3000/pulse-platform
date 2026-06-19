import { MigrationInterface, QueryRunner } from 'typeorm';

// Neither refunds(order_id) nor payments(order_id) was indexed — Postgres does
// NOT auto-index FK columns. refunds(order_id) is the hotter gap: it is scanned
// twice per refund (AdminOrdersService.sumRefundsForOrder in Phase 1 + the
// in-lock Phase-3 sum, the latter while holding the orders row lock) and once
// per owner dashboard open (the revenue subquery's
// `SELECT order_id, SUM(amount_cents) FROM refunds GROUP BY order_id`). Without
// the index both do a full Seq Scan that grows unbounded with refund volume.
// payments(order_id) is added in the same migration: it is latent today (the
// hot lookups go through stripe_payment_id, which is unique-indexed) but every
// "payments for this order" query — receipts, reconciliation — would seq-scan
// without it. Both additive; companion to AddOrderItemsOrderIdIndex.
export class AddRefundPaymentOrderIdIndexes1780800000000 implements MigrationInterface {
  name = 'AddRefundPaymentOrderIdIndexes1780800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_refunds_order_id" ON "refunds" ("order_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_payments_order_id" ON "payments" ("order_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_payments_order_id"`);
    await queryRunner.query(`DROP INDEX "IDX_refunds_order_id"`);
  }
}
