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
   * Cancels a PaymentIntent that hasn't been confirmed yet. Used by the
   * customer cancel flow when an order is in PENDING_PAYMENT — we'd rather
   * not leave a confirmable PI alive in Stripe after the customer has told
   * us they don't want the order any more.
   *
   * Idempotent: if Stripe says the intent is already canceled (or already
   * succeeded, or in any non-cancellable terminal state), we swallow the
   * error and return. Our DB is the truth; Stripe-side cleanup is best
   * effort. The caller is expected to log the error and proceed.
   *
   * Throws on transient errors (network, 5xx) so the caller can decide
   * whether to retry — for the cancel flow today, the caller catches and
   * logs all errors regardless.
   */
  async cancelPaymentIntent(intentId: string): Promise<void> {
    try {
      await this.stripe.paymentIntents.cancel(intentId);
    } catch (err) {
      // Stripe returns StripeInvalidRequestError with code
      // 'payment_intent_unexpected_state' when the intent is already in a
      // state that doesn't accept a cancel (canceled, succeeded, etc.).
      // Treat that as success — the post-condition we want (intent is no
      // longer confirmable by the customer) holds.
      const code = (err as { code?: string })?.code;
      if (code === 'payment_intent_unexpected_state') {
        this.logger.log(
          `cancelPaymentIntent: intent ${intentId} already in terminal state — treating as success`,
        );
        return;
      }
      throw err;
    }
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
