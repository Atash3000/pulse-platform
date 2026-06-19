import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SentryExceptionFilter } from './common/filters/sentry-exception.filter';
import { CustomerAwareThrottlerGuard } from './common/throttle/customer-aware-throttler.guard';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { dataSourceOptions } from './database/data-source';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { AdminModule } from './modules/admin/admin.module';
import { CelebrationModule } from './modules/celebration/celebration.module';
import { CheckoutModule } from './modules/checkout/checkout.module';
import { CustomersModule } from './modules/customers/customers.module';
import { HomeModule } from './modules/home/home.module';
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
    HomeModule,
    LocationsModule,
    MenuModule,
    PricingModule,
    PaymentsModule,
    CheckoutModule,
    CustomersModule,
    OrdersModule,
    AdminModule,
    CelebrationModule,
    WorkersModule,

    // Future modules (registered here as they're built):
    // InventoryModule (sold-out toggles currently live in AdminModule),
    // CheckoutModule, OrdersModule, PaymentsModule, RefundsModule,
    // LoyaltyModule, NotificationsModule, AdminModule, CloverModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: CustomerAwareThrottlerGuard },
    // Golden Rule #10: Sentry must actually receive errors. Nest's exception
    // layer catches everything before Sentry's process-level hooks see it, so
    // this filter reports 5xx / unexpected errors then delegates to the
    // default handling (response shapes unchanged).
    { provide: APP_FILTER, useClass: SentryExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  // Global request-ID middleware. Must run before anything else so logs,
  // workers, and downstream services share the same correlation ID end-to-end.
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
