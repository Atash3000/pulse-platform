import { ConflictException } from '@nestjs/common';

import { OrderStatus } from '../../database/entities';
import { ActorType, OrderStateMachine } from './order-state-machine';

describe('OrderStateMachine', () => {
  // ---------------------------------------------------------------------------
  // The transition that triggered this spec being written: customer cancel of
  // a PENDING_PAYMENT order. Before the fix, the state machine only allowed
  // customer:DRAFT → CANCELLED, but checkout never exposes DRAFT outside its
  // transaction, so the customer cancel endpoint was dead code.
  // ---------------------------------------------------------------------------

  describe('PENDING_PAYMENT → CANCELLED', () => {
    it('is allowed for the customer actor (the live cancellation path)', () => {
      expect(() =>
        OrderStateMachine.assertTransition(
          OrderStatus.PENDING_PAYMENT,
          OrderStatus.CANCELLED,
          'customer',
        ),
      ).not.toThrow();
    });

    it('is allowed for the system actor (reserved for the cleanup job that GCs stale PENDING_PAYMENT orders)', () => {
      expect(() =>
        OrderStateMachine.assertTransition(
          OrderStatus.PENDING_PAYMENT,
          OrderStatus.CANCELLED,
          'system',
        ),
      ).not.toThrow();
    });

    it('is rejected for the stripe-webhook actor (webhook never cancels — only PAID/FAILED transitions)', () => {
      expect(() =>
        OrderStateMachine.assertTransition(
          OrderStatus.PENDING_PAYMENT,
          OrderStatus.CANCELLED,
          'stripe-webhook',
        ),
      ).toThrow(ConflictException);
    });

    it('is rejected for the staff and manager actors (those can only act on PAID+ orders)', () => {
      for (const actor of ['staff', 'manager'] as const) {
        expect(() =>
          OrderStateMachine.assertTransition(
            OrderStatus.PENDING_PAYMENT,
            OrderStatus.CANCELLED,
            actor,
          ),
        ).toThrow(ConflictException);
      }
    });

    it('appears in getValidTransitions(PENDING_PAYMENT, "customer")', () => {
      const valid = OrderStateMachine.getValidTransitions(
        OrderStatus.PENDING_PAYMENT,
        'customer',
      );
      expect(valid).toContain(OrderStatus.CANCELLED);
    });

    it('appears in getValidTransitions(PENDING_PAYMENT, "system")', () => {
      const valid = OrderStateMachine.getValidTransitions(
        OrderStatus.PENDING_PAYMENT,
        'system',
      );
      expect(valid).toContain(OrderStatus.CANCELLED);
    });
  });

  // ---------------------------------------------------------------------------
  // PENDING_PAYMENT → FAILED — webhook fires for actual Stripe failures, the
  // PendingPaymentCleanupTask fires for abandoned checkouts. Both must work;
  // customers / staff must NOT be able to drive this transition.
  // ---------------------------------------------------------------------------

  describe('PENDING_PAYMENT → FAILED', () => {
    it('is allowed for stripe-webhook (Stripe-reported payment failure)', () => {
      expect(() =>
        OrderStateMachine.assertTransition(
          OrderStatus.PENDING_PAYMENT,
          OrderStatus.FAILED,
          'stripe-webhook',
        ),
      ).not.toThrow();
    });

    it('is allowed for system (PendingPaymentCleanupTask reaping abandoned checkouts)', () => {
      expect(() =>
        OrderStateMachine.assertTransition(
          OrderStatus.PENDING_PAYMENT,
          OrderStatus.FAILED,
          'system',
        ),
      ).not.toThrow();
    });

    it('is rejected for the customer actor (customers cancel, they do not fail)', () => {
      expect(() =>
        OrderStateMachine.assertTransition(
          OrderStatus.PENDING_PAYMENT,
          OrderStatus.FAILED,
          'customer',
        ),
      ).toThrow(ConflictException);
    });

    it('is rejected for staff and manager (FAILED is not a staff-driven state)', () => {
      for (const actor of ['staff', 'manager'] as const) {
        expect(() =>
          OrderStateMachine.assertTransition(
            OrderStatus.PENDING_PAYMENT,
            OrderStatus.FAILED,
            actor,
          ),
        ).toThrow(ConflictException);
      }
    });

    it('appears in getValidTransitions(PENDING_PAYMENT, "system") alongside CANCELLED', () => {
      const valid = OrderStateMachine.getValidTransitions(
        OrderStatus.PENDING_PAYMENT,
        'system',
      );
      expect(valid).toEqual(expect.arrayContaining([OrderStatus.FAILED, OrderStatus.CANCELLED]));
    });
  });

  // ---------------------------------------------------------------------------
  // DRAFT → CANCELLED stays in place as defence-in-depth even though checkout
  // currently doesn't expose DRAFT outside its transaction. If checkout ever
  // moves the Stripe call out of the txn, DRAFT becomes observable and the
  // customer must still be able to cancel. This test pins that down.
  // ---------------------------------------------------------------------------

  describe('DRAFT → CANCELLED (defence-in-depth)', () => {
    it('is still allowed for the customer actor', () => {
      expect(() =>
        OrderStateMachine.assertTransition(
          OrderStatus.DRAFT,
          OrderStatus.CANCELLED,
          'customer',
        ),
      ).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // The rest of the matrix — covers the spec section 5.1 transitions plus the
  // refund flow's expanded transitions. One assertion per (from, to, actor)
  // tuple for everything in the spec; one negative for each terminal.
  // ---------------------------------------------------------------------------

  describe('full happy-path lifecycle', () => {
    const happyPath: Array<[OrderStatus, OrderStatus, ActorType]> = [
      [OrderStatus.DRAFT, OrderStatus.PENDING_PAYMENT, 'system'],
      [OrderStatus.PENDING_PAYMENT, OrderStatus.PAID, 'stripe-webhook'],
      [OrderStatus.PAID, OrderStatus.ACCEPTED, 'staff'],
      [OrderStatus.ACCEPTED, OrderStatus.IN_PROGRESS, 'staff'],
      [OrderStatus.IN_PROGRESS, OrderStatus.READY, 'staff'],
      [OrderStatus.READY, OrderStatus.PICKED_UP, 'staff'],
    ];

    it.each(happyPath)('%s → %s is allowed for actor=%s', (from, to, actor) => {
      expect(() => OrderStateMachine.assertTransition(from, to, actor)).not.toThrow();
    });
  });

  describe('manager refund transitions (full refund only)', () => {
    const refundFromAny: OrderStatus[] = [
      OrderStatus.PAID,
      OrderStatus.ACCEPTED,
      OrderStatus.IN_PROGRESS,
      OrderStatus.READY,
      OrderStatus.PICKED_UP,
      OrderStatus.CANCELLED,
    ];

    it.each(refundFromAny)('manager can transition %s → REFUNDED', (from) => {
      expect(() =>
        OrderStateMachine.assertTransition(from, OrderStatus.REFUNDED, 'manager'),
      ).not.toThrow();
    });

    it('staff (BARISTA) cannot trigger a refund', () => {
      expect(() =>
        OrderStateMachine.assertTransition(OrderStatus.PAID, OrderStatus.REFUNDED, 'staff'),
      ).toThrow(ConflictException);
    });
  });

  describe('manager cancellations (mid-flight)', () => {
    const managerCancellable: OrderStatus[] = [
      OrderStatus.PAID,
      OrderStatus.ACCEPTED,
      OrderStatus.IN_PROGRESS,
      OrderStatus.READY,
    ];

    it.each(managerCancellable)('manager can cancel a %s order', (from) => {
      expect(() =>
        OrderStateMachine.assertTransition(from, OrderStatus.CANCELLED, 'manager'),
      ).not.toThrow();
    });

    it('manager cannot cancel a DRAFT order (customer territory)', () => {
      expect(() =>
        OrderStateMachine.assertTransition(OrderStatus.DRAFT, OrderStatus.CANCELLED, 'manager'),
      ).toThrow(ConflictException);
    });

    it('manager cannot cancel a PENDING_PAYMENT order (Stripe owns that state)', () => {
      expect(() =>
        OrderStateMachine.assertTransition(
          OrderStatus.PENDING_PAYMENT,
          OrderStatus.CANCELLED,
          'manager',
        ),
      ).toThrow(ConflictException);
    });

    it('manager cannot cancel an already-PICKED_UP order', () => {
      expect(() =>
        OrderStateMachine.assertTransition(
          OrderStatus.PICKED_UP,
          OrderStatus.CANCELLED,
          'manager',
        ),
      ).toThrow(ConflictException);
    });
  });

  describe('terminal states', () => {
    it.each([OrderStatus.FAILED, OrderStatus.REFUNDED])(
      '%s is terminal — no transitions for any actor',
      (status) => {
        expect(OrderStateMachine.isTerminal(status)).toBe(true);
        for (const actor of ['customer', 'system', 'stripe-webhook', 'staff', 'manager'] as ActorType[]) {
          expect(OrderStateMachine.getValidTransitions(status, actor)).toEqual([]);
        }
      },
    );

    it('PICKED_UP allows only manager refund (terminal-for-most-actors)', () => {
      expect(OrderStateMachine.getValidTransitions(OrderStatus.PICKED_UP, 'staff')).toEqual([]);
      expect(OrderStateMachine.getValidTransitions(OrderStatus.PICKED_UP, 'customer')).toEqual([]);
      expect(OrderStateMachine.getValidTransitions(OrderStatus.PICKED_UP, 'manager')).toEqual([
        OrderStatus.REFUNDED,
      ]);
    });
  });

  describe('error response shape', () => {
    it('includes from, to, actor, and validNext when the destination is unreachable', () => {
      try {
        OrderStateMachine.assertTransition(
          OrderStatus.READY,
          OrderStatus.PENDING_PAYMENT,
          'staff',
        );
        fail('expected ConflictException');
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        const body = (err as ConflictException).getResponse() as Record<string, unknown>;
        expect(body.reason).toBe('INVALID_TRANSITION');
        expect(body.from).toBe(OrderStatus.READY);
        expect(body.to).toBe(OrderStatus.PENDING_PAYMENT);
        expect(body.actor).toBe('staff');
        expect(Array.isArray(body.validNext)).toBe(true);
        // staff valid next from READY = [PICKED_UP]
        expect(body.validNext).toContain(OrderStatus.PICKED_UP);
      }
    });

    it('includes requiredActors when the destination is reachable but only by a different actor', () => {
      try {
        OrderStateMachine.assertTransition(
          OrderStatus.PAID,
          OrderStatus.CANCELLED,
          'staff', // BARISTA can't cancel; manager+ can
        );
        fail('expected ConflictException');
      } catch (err) {
        const body = (err as ConflictException).getResponse() as Record<string, unknown>;
        expect(body.reason).toBe('TRANSITION_NOT_ALLOWED_FOR_ACTOR');
        expect(body.requiredActors).toContain('manager');
      }
    });
  });
});
