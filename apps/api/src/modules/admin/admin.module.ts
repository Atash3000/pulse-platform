import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  Customer,
  FeatureFlag,
  Inventory,
  Location,
  LocationHours,
  LocationSettings,
  MenuCategory,
  MenuItem,
  Order,
  OrderEvent,
  OrderItem,
  OutboxEvent,
  Payment,
  Refund,
} from '../../database/entities';
import { AuthModule } from '../auth/auth.module';
import { MenuModule } from '../menu/menu.module';
import { PaymentsModule } from '../payments/payments.module';

import { AdminDashboardController } from './admin-dashboard.controller';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminFeatureFlagsController } from './admin-feature-flags.controller';
import { AdminFeatureFlagsService } from './admin-feature-flags.service';
import { AdminHoursController } from './admin-hours.controller';
import { AdminHoursService } from './admin-hours.service';
import { AdminItemsController } from './admin-items.controller';
import { AdminItemsService } from './admin-items.service';
import { AdminOrderingController } from './admin-ordering.controller';
import { AdminOrderingService } from './admin-ordering.service';
import { AdminOrdersController } from './admin-orders.controller';
import { AdminOrdersService } from './admin-orders.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Order,
      OrderItem,
      OrderEvent,
      OutboxEvent,
      Payment,
      Refund,
      Customer,
      Location,
      LocationHours,
      LocationSettings,
      MenuItem,
      MenuCategory,
      Inventory,
      FeatureFlag,
    ]),
    AuthModule,    // AuthGuard('jwt'), RolesGuard provider
    MenuModule,    // MenuService.invalidate() for sold-out / available toggles
    PaymentsModule, // StripeService.createRefund()
  ],
  controllers: [
    AdminOrdersController,
    AdminItemsController,
    AdminOrderingController,
    AdminDashboardController,
    AdminFeatureFlagsController,
    AdminHoursController,
  ],
  providers: [
    AdminOrdersService,
    AdminItemsService,
    AdminOrderingService,
    AdminDashboardService,
    AdminFeatureFlagsService,
    AdminHoursService,
  ],
})
export class AdminModule {}
