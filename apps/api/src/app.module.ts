import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { dataSourceOptions } from './database/data-source';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { AdminModule } from './modules/admin/admin.module';
import { CheckoutModule } from './modules/checkout/checkout.module';
import { CustomersModule } from './modules/customers/customers.module';
import { LocationsModule } from './modules/locations/locations.module';
import { MenuModule } from './modules/menu/menu.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { WorkersModule } from './workers/workers.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),

    TypeOrmModule.forRoot(dataSourceOptions),

    // Discovers @Cron decorators across all modules. Currently fires:
    //   - PendingPaymentCleanupTask (every 5 minutes) — modules/orders/
    // Each task self-gates on WORKERS_ENABLED so API-only ECS replicas skip
    // the side effect. forRoot() must be called exactly once.
    ScheduleModule.forRoot(),

    // Default short-window throttle. Per-endpoint stricter limits (login 5/min,
    // register 10/min, checkout 3/min, etc.) override this via @Throttle().
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 100 },
    ]),

    HealthModule,
    AuthModule,
    LocationsModule,
    MenuModule,
    PricingModule,
    PaymentsModule,
    CheckoutModule,
    CustomersModule,
    OrdersModule,
    AdminModule,
    WorkersModule,

    // Future modules (registered here as they're built):
    // InventoryModule (sold-out toggles currently live in AdminModule),
    // CheckoutModule, OrdersModule, PaymentsModule, RefundsModule,
    // LoyaltyModule, NotificationsModule, AdminModule, CloverModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  // Global request-ID middleware. Must run before anything else so logs,
  // workers, and downstream services share the same correlation ID end-to-end.
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
