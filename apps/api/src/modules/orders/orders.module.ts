import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Order, OrderEvent, OrderItem, OutboxEvent } from '../../database/entities';
import { AuthModule } from '../auth/auth.module';
import { PaymentsModule } from '../payments/payments.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PendingPaymentCleanupTask } from './pending-payment-cleanup.task';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, OrderItem, OrderEvent, OutboxEvent]),
    AuthModule,     // for AuthGuard('jwt')
    PaymentsModule, // for StripeService.cancelPaymentIntent (customer cancel + cleanup task)
  ],
  controllers: [OrdersController],
  // PendingPaymentCleanupTask carries an @Cron decorator. ScheduleModule.forRoot()
  // is registered globally in AppModule — that's what discovers and fires this.
  providers: [OrdersService, PendingPaymentCleanupTask],
  exports: [OrdersService, PendingPaymentCleanupTask],
})
export class OrdersModule {}
