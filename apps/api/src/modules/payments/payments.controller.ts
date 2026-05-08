import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type Stripe from 'stripe';

import { OrdersService } from './orders.service';
import { StripeService } from './stripe.service';

// The webhook is excluded from the Swagger document — it's not a client-facing
// API; Stripe is the only authorised caller. We keep the contract documented
// in source.
@ApiExcludeController()
@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    private readonly stripe: StripeService,
    private readonly orders: OrdersService,
  ) {}

  /**
   * Stripe webhook endpoint. NO JWT — Stripe authenticates via signature.
   *
   * Golden Rule #3: "iOS NEVER marks an order paid. Only POST
   * /payments/webhook with a valid Stripe-Signature sets payment_status =
   * SUCCEEDED."
   *
   * Spec Part 4.5 caps this at 100 req/min — Stripe may burst on retries.
   * Signature failures still return 400 (the only 400 we ever return here).
   */
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 100, ttl: 60_000 } })
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true; type: string }> {
    if (!req.rawBody) {
      // rawBody must be wired in main.ts. If we get here, it's a misconfig.
      this.logger.error('rawBody not present on webhook request — check main.ts rawBody:true');
      throw new BadRequestException('Webhook body unavailable');
    }

    // Signature verification — throws BadRequestException on failure.
    const event = this.stripe.constructWebhookEvent(req.rawBody, signature);
    const requestId = req.requestId;

    this.logger.log(
      `webhook event=${event.type} stripe_event_id=${event.id} request_id=${requestId}`,
    );

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const intent = event.data.object as Stripe.PaymentIntent;
        await this.orders.markPaidFromWebhook(intent, event, requestId);
        break;
      }
      case 'payment_intent.payment_failed': {
        const intent = event.data.object as Stripe.PaymentIntent;
        await this.orders.markFailedFromWebhook(intent, event, requestId);
        break;
      }
      default:
        // Unknown events get 200 so Stripe stops retrying them. We just don't act.
        this.logger.debug(`webhook ignoring event type=${event.type}`);
    }

    return { received: true, type: event.type };
  }
}
