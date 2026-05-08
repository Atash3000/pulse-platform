import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  Inventory,
  MenuItem,
  Modifier,
  Order,
  OrderEvent,
  OrderItem,
} from '../../database/entities';
import { AuthModule } from '../auth/auth.module';
import { LocationsModule } from '../locations/locations.module';
import { PaymentsModule } from '../payments/payments.module';
import { PricingModule } from '../pricing/pricing.module';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, OrderItem, OrderEvent, MenuItem, Modifier, Inventory]),
    AuthModule,         // for JwtStrategy / AuthGuard('jwt')
    LocationsModule,    // for HoursService.canAcceptOrders()
    PricingModule,      // for PricingService
    PaymentsModule,     // for StripeService
  ],
  controllers: [CheckoutController],
  providers: [CheckoutService],
  exports: [CheckoutService],
})
export class CheckoutModule {}
