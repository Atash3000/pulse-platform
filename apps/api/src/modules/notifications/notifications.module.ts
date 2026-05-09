import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Customer, MenuItem, Order } from '../../database/entities';
import { NotificationsService } from './notifications.service';
import { PushNotificationService } from './push-notification.service';
import { TelegramService } from './telegram.service';

/**
 * NotificationsModule — exports `NotificationsService` (the C1 router with
 * stubbed handlers) and `TelegramService` (DEAD-event alert stub).
 *
 * Already imported by `WorkersModule` (transitively wired via `app.module.ts`
 * → `WorkersModule` → here). Do NOT add a direct import to `app.module.ts` —
 * that creates a duplicate module registration.
 */
@Module({
  imports: [
    ConfigModule,
    // Repositories required by NotificationsService handlers. MenuItem is
    // for the ITEM_OUT_OF_STOCK handler, which loads the menu item by id to
    // surface the canonical name in the alert message.
    TypeOrmModule.forFeature([Order, Customer, MenuItem]),
  ],
  providers: [NotificationsService, PushNotificationService, TelegramService],
  exports: [NotificationsService, PushNotificationService, TelegramService],
})
export class NotificationsModule {}
