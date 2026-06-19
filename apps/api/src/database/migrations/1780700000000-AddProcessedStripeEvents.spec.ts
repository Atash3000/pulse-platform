import { QueryRunner } from 'typeorm';
import { AddProcessedStripeEvents1780700000000 } from './1780700000000-AddProcessedStripeEvents';

function buildRunner() {
  return { query: jest.fn().mockResolvedValue(undefined) } as unknown as QueryRunner;
}

describe('AddProcessedStripeEvents1780700000000', () => {
  it('up() creates processed_stripe_events with event_id PK, event_type, created_at', async () => {
    const runner = buildRunner();
    await new AddProcessedStripeEvents1780700000000().up(runner);

    const sql = (runner.query as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('CREATE TABLE "processed_stripe_events"');
    expect(sql[0]).toContain('"event_id" text NOT NULL');
    expect(sql[0]).toContain('"event_type" text NOT NULL');
    expect(sql[0]).toContain('"created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()');
    // event_id is the PK — the structural at-most-once guarantee.
    expect(sql[0]).toContain('PRIMARY KEY ("event_id")');
  });

  it('down() drops the table', async () => {
    const runner = buildRunner();
    await new AddProcessedStripeEvents1780700000000().down(runner);

    const sql = (runner.query as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('DROP TABLE "processed_stripe_events"');
  });
});
