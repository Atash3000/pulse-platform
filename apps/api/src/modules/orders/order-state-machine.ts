import { ConflictException } from '@nestjs/common';

import { OrderStatus } from '../../database/entities';

/**
 * Single source of truth for valid OrderStatus transitions.
 *
 * Every code path that updates orders.order_status MUST call assertTransition()
 * before issuing the UPDATE. The state machine catches programming errors at
 * the call site (READY → DRAFT, two staff accepting the same order, an admin
 * trying to cancel a PICKED_UP order) instead of producing corrupted rows.
 *
 * Actor types
 * -----------
 *  customer        — the JWT subject is type='customer'
 *  system          — backend code (CheckoutService, refund flow, etc.)
 *  stripe-webhook  — POST /api/v1/payments/webhook after signature verification
 *  staff           — staff JWT, ANY role (BARISTA, MANAGER, OWNER)
 *  manager         — staff JWT with role MANAGER or OWNER
 */
export type ActorType = 'customer' | 'system' | 'stripe-webhook' | 'staff' | 'manager';

const TRANSITIONS: ReadonlyMap<OrderStatus, ReadonlyMap<OrderStatus, readonly ActorType[]>> =
  new Map([
    [
      OrderStatus.DRAFT,
      new Map<OrderStatus, readonly ActorType[]>([
        [OrderStatus.PENDING_PAYMENT, ['system']],
        [OrderStatus.CANCELLED, ['customer']],
      ]),
    ],
    [
      OrderStatus.PENDING_PAYMENT,
      new Map<OrderStatus, readonly ActorType[]>([
        [OrderStatus.PAID, ['stripe-webhook']],
        // 'system' is the PendingPaymentCleanupTask reaping orders abandoned
        // mid-checkout (customer closed the app after the PaymentIntent was
        // created but before confirming payment). 'stripe-webhook' fires
        // when Stripe reports payment_intent.payment_failed. See decision-log
        // entry "Abandoned-checkout cleanup: 30-minute threshold, FAILED
        // state, no outbox event" for the full reasoning.
        [OrderStatus.FAILED, ['stripe-webhook', 'system']],
        // Customer can cancel BEFORE confirming payment in the Stripe sheet.
        // 'system' here is reserved for the same cleanup task if we later
        // decide abandoned checkouts should resolve to CANCELLED instead of
        // FAILED — currently they go to FAILED. (DRAFT → CANCELLED for
        // customer stays in place as defence in depth in case checkout ever
        // exposes a DRAFT row outside its transaction.) See decision-log
        // entry "Customer cancel during PENDING_PAYMENT" — without this
        // transition the cancel endpoint was dead code.
        [OrderStatus.CANCELLED, ['customer', 'system']],
      ]),
    ],
    [
      OrderStatus.PAID,
      new Map<OrderStatus, readonly ActorType[]>([
        [OrderStatus.ACCEPTED, ['staff']],
        [OrderStatus.CANCELLED, ['manager']],
        // Refund flow can mark a PAID order REFUNDED without going through CANCELLED.
        [OrderStatus.REFUNDED, ['manager']],
      ]),
    ],
    [
      OrderStatus.ACCEPTED,
      new Map<OrderStatus, readonly ActorType[]>([
        [OrderStatus.IN_PROGRESS, ['staff']],
        [OrderStatus.CANCELLED, ['manager']],
        [OrderStatus.REFUNDED, ['manager']],
      ]),
    ],
    [
      OrderStatus.IN_PROGRESS,
      new Map<OrderStatus, readonly ActorType[]>([
        [OrderStatus.READY, ['staff']],
        [OrderStatus.CANCELLED, ['manager']],
        [OrderStatus.REFUNDED, ['manager']],
      ]),
    ],
    [
      OrderStatus.READY,
      new Map<OrderStatus, readonly ActorType[]>([
        [OrderStatus.PICKED_UP, ['staff']],
        [OrderStatus.CANCELLED, ['manager']],
        [OrderStatus.REFUNDED, ['manager']],
      ]),
    ],
    [
      OrderStatus.PICKED_UP,
      new Map<OrderStatus, readonly ActorType[]>([
        // Customer received the order. Refunds are still possible (manager
        // discretion — bad coffee, customer complaint after pickup).
        [OrderStatus.REFUNDED, ['manager']],
      ]),
    ],
    [
      OrderStatus.CANCELLED,
      new Map<OrderStatus, readonly ActorType[]>([
        // A cancelled-but-paid order can still be marked refunded once Stripe
        // confirms. Driven by the refund flow, not the cancel endpoint.
        [OrderStatus.REFUNDED, ['manager']],
      ]),
    ],
    [OrderStatus.FAILED, new Map()],     // terminal
    [OrderStatus.REFUNDED, new Map()],   // terminal
  ]);

export class OrderStateMachine {
  /**
   * Throws ConflictException if (from → to) is not a permitted transition for
   * the supplied actor. The message names the offending pair AND lists what
   * IS allowed from the current state for that actor — so iOS / dashboard can
   * surface a useful error to the user without a second round trip.
   */
  static assertTransition(from: OrderStatus, to: OrderStatus, actor: ActorType): void {
    const fromMap = TRANSITIONS.get(from);
    if (!fromMap || fromMap.size === 0) {
      throw new ConflictException({
        reason: 'INVALID_TRANSITION',
        message: `Order is in terminal status ${from}; cannot transition to ${to}.`,
        from,
        to,
        actor,
        validNext: [],
      });
    }
    const allowedActors = fromMap.get(to);
    if (!allowedActors) {
      throw new ConflictException({
        reason: 'INVALID_TRANSITION',
        message: `Cannot transition order from ${from} to ${to}.`,
        from,
        to,
        actor,
        validNext: this.getValidTransitions(from, actor),
      });
    }
    if (!allowedActors.includes(actor)) {
      throw new ConflictException({
        reason: 'TRANSITION_NOT_ALLOWED_FOR_ACTOR',
        message: `Actor "${actor}" is not permitted to transition order from ${from} to ${to}. Required actor: ${allowedActors.join(' or ')}.`,
        from,
        to,
        actor,
        requiredActors: [...allowedActors],
      });
    }
  }

  /**
   * Returns the list of OrderStatus values this actor may transition the
   * order to from `from`. Empty array means terminal-for-this-actor.
   */
  static getValidTransitions(from: OrderStatus, actor: ActorType): OrderStatus[] {
    const fromMap = TRANSITIONS.get(from);
    if (!fromMap) return [];
    const out: OrderStatus[] = [];
    for (const [to, actors] of fromMap.entries()) {
      if (actors.includes(actor)) out.push(to);
    }
    return out;
  }

  /** True if there are no possible outgoing transitions for any actor. */
  static isTerminal(from: OrderStatus): boolean {
    const m = TRANSITIONS.get(from);
    return !m || m.size === 0;
  }
}
