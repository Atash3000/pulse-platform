import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import Stripe from 'stripe';

import { STRIPE_CLIENT, STRIPE_WEBHOOK_SECRET } from './stripe.token';

export interface CreatePaymentIntentParams {
  /** Integer cents — backend-calculated, never iOS-supplied. */
  amountCents: number;
  /** Order UUID — included in PaymentIntent metadata so the webhook can find it. */
  orderId: string;
  /** Customer UUID — included for Stripe dashboard searchability + analytics. */
  customerId: string;
  /** ISO 4217, lowercased. We're USD-only for Phase 1. */
  currency?: string;
}

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);

  constructor(
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
    @Inject(STRIPE_WEBHOOK_SECRET) private readonly webhookSecret: string,
  ) {}

  /**
   * Creates a Stripe PaymentIntent. Called from inside the checkout DB
   * transaction (per spec 5.2). The order UUID lives in metadata so the
   * webhook can resolve back to our domain order.
   */
  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<Stripe.PaymentIntent> {
    if (!Number.isInteger(params.amountCents) || params.amountCents < 50) {
      // Stripe's USD minimum is $0.50; anything below is a programmer bug.
      throw new BadRequestException(`Invalid PaymentIntent amount: ${params.amountCents}`);
    }

    return this.stripe.paymentIntents.create({
      amount: params.amountCents,
      currency: params.currency ?? 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: {
        orderId: params.orderId,
        customerId: params.customerId,
      },
    });
  }

  /**
   * Creates a Stripe refund against an existing PaymentIntent. Used by the
   * admin refund flow. We pass the order UUID + staff user id in metadata so
   * Stripe's dashboard search can find the refund alongside the original PI.
   *
   * Throws whatever Stripe throws — caller wraps in BadGatewayException so
   * the DB does NOT get updated when Stripe fails.
   */
  async createRefund(params: {
    paymentIntentId: string;
    amountCents: number;
    metadata?: Record<string, string>;
  }): Promise<Stripe.Refund> {
    return this.stripe.refunds.create({
      payment_intent: params.paymentIntentId,
      amount: params.amountCents,
      reason: 'requested_by_customer',
      metadata: params.metadata,
    });
  }

  /**
   * Verifies the Stripe-Signature header against the raw request body.
   * MUST be called on every webhook request before any other processing.
   * Throws BadRequestException for any signature failure — the only valid
   * 400 response from /payments/webhook.
   */
  constructWebhookEvent(rawBody: Buffer | string, signatureHeader: string | undefined): Stripe.Event {
    if (!signatureHeader) {
      throw new BadRequestException('Missing Stripe-Signature header');
    }
    if (!this.webhookSecret) {
      // Programming error, not a request error — fail loud.
      this.logger.error('STRIPE_WEBHOOK_SECRET is not configured');
      throw new Error('Webhook secret missing');
    }
    try {
      return this.stripe.webhooks.constructEvent(rawBody, signatureHeader, this.webhookSecret);
    } catch (err) {
      this.logger.warn(`Stripe signature verification failed: ${(err as Error).message}`);
      throw new BadRequestException('Invalid Stripe signature');
    }
  }
}
