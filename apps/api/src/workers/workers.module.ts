import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Customer, Order, OutboxEvent } from '../database/entities';
import { CloverModule } from '../modules/clover/clover.module';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { OrderWorker } from './order.worker';
import { OutboxWorker } from './outbox.worker';

/**
 * Workers run inside the same Nest application instance as the API for now.
 * Once load justifies it, they get split into their own ECS task definition
 * by setting WORKERS_ENABLED / API_ENABLED env flags and gating the providers
 * here. Same image, different entrypoints.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([OutboxEvent, Order, Customer]),
    ConfigModule, // OutboxWorker reads WORKERS_ENABLED via ConfigService
    CloverModule,
    NotificationsModule,
  ],
  providers: [OutboxWorker, OrderWorker],
  exports: [OutboxWorker, OrderWorker],
})
export class WorkersModule {}
