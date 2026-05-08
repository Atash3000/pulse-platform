import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import Stripe from 'stripe';

import {
  Order,
  OrderEvent,
  OutboxEvent,
  Payment,
} from '../../database/entities';
import { OrdersService } from './orders.service';
import { PaymentsController } from './payments.controller';
import { StripeService } from './stripe.service';
import { STRIPE_CLIENT, STRIPE_WEBHOOK_SECRET } from './stripe.token';

const stripeClientProvider = {
  provide: STRIPE_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Stripe => {
    const apiKey = config.get<string>('STRIPE_SECRET_KEY');
    if (!apiKey) {
      // Hard fail — checkout requires Stripe. In dev, point to a Stripe test key.
      throw new Error('STRIPE_SECRET_KEY is not configured');
    }
    const apiVersion = config.get<string>('STRIPE_API_VERSION') ?? '2024-06-20';
    return new Stripe(apiKey, {
      apiVersion: apiVersion as Stripe.LatestApiVersion,
      typescript: true,
      // 10-second timeout matches the Stripe webhook expectation (Stripe will
      // retry if our side doesn't respond in 10s) — keeps PI creation tight.
      timeout: 10_000,
    });
  },
};

const webhookSecretProvider = {
  provide: STRIPE_WEBHOOK_SECRET,
  inject: [ConfigService],
  useFactory: (config: ConfigService): string => {
    const secret = config.get<string>('STRIPE_WEBHOOK_SECRET');
    if (!secret) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
    }
    return secret;
  },
};

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([Order, OrderEvent, Payment, OutboxEvent]),
  ],
  controllers: [PaymentsController],
  providers: [
    stripeClientProvider,
    webhookSecretProvider,
    StripeService,
    OrdersService,
  ],
  // StripeService is exported so CheckoutService can inject it for
  // PaymentIntent creation. The raw client and the secret are not exported —
  // callers go through StripeService.
  exports: [StripeService],
})
export class PaymentsModule {}
