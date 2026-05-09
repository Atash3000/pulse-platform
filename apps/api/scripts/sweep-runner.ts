import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PendingPaymentCleanupTask } from '../src/modules/orders/pending-payment-cleanup.task';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  const task = app.get(PendingPaymentCleanupTask);
  const reaped = await task.runOnce();
  console.log(`SWEEP_REAPED=${reaped}`);
  await app.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
