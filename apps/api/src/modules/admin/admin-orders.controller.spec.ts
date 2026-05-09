import { Test } from '@nestjs/testing';
import type { Request } from 'express';

import { OrderStatus, Refund, StaffRole } from '../../database/entities';
import { AdminOrdersController } from './admin-orders.controller';
import {
  AdminOrderDetail,
  AdminOrdersService,
  RefundResult,
} from './admin-orders.service';

// =============================================================================
// AdminOrdersController.refund — HTTP shape for the discriminated union.
//
// The service can answer in two shapes (see RefundResult). The controller's
// job is to (a) preserve the discriminator on the wire, and (b) attach an
// operator-facing message on the race-recorded branch so the staff dashboard
// has something human to render. These tests pin both shapes — the previous
// untyped passthrough silently wrapped a synthetic refund object.
// =============================================================================

// Shape required by requireStaff() — JWT subject with type='staff', sub,
// role and location_id. Anything else triggers ForbiddenException.
const STAFF_REQ: Partial<Request> = {
  user: {
    type: 'staff',
    sub: 'staff-1',
    role: StaffRole.MANAGER,
    location_id: 'loc-1',
  } as unknown as Express.User,
};

describe('AdminOrdersController.refund', () => {
  let controller: AdminOrdersController;
  let serviceRefund: jest.Mock;

  beforeEach(async () => {
    serviceRefund = jest.fn();
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminOrdersController],
      providers: [
        {
          provide: AdminOrdersService,
          useValue: { refund: serviceRefund },
        },
      ],
    }).compile();

    controller = moduleRef.get(AdminOrdersController);
  });

  it('committed: returns { status, order, refund } with mapped AdminOrderDetail', async () => {
    // Post-B2: the committed arm carries an AdminOrderDetail (the unified
    // admin response shape) rather than a raw Order entity. The service
    // does the reload-and-map; the controller just passes it through.
    const order: AdminOrderDetail = {
      id: 'order-1',
      customer_id: 'cust-1',
      customer_name: 'Refund Customer',
      order_status: OrderStatus.REFUNDED,
      payment_status: 'REFUNDED',
      clover_sync_status: 'NOT_SENT',
      total_cents: 825,
      pickup_type: 'ASAP',
      scheduled_pickup_at: null,
      estimated_ready_at: null,
      notes: null,
      created_at: '2026-05-09T14:00:00.000Z',
      items: [],
    };
    const refund = { id: 'refund-1', amount_cents: 825 } as Refund;
    const committed: RefundResult = { status: 'committed', order, refund };
    serviceRefund.mockResolvedValueOnce(committed);

    const result = await controller.refund(
      STAFF_REQ as Request,
      'order-1',
      { reason: 'duplicate', amount_cents: 825 },
    );

    expect(result).toEqual({
      status: 'committed',
      order,
      refund,
    });
  });

  it('race-recorded: returns reconciliation shape with operator-facing message', async () => {
    const raced: RefundResult = {
      status: 'race-recorded',
      stripeRefundId: 're_race_1',
      amountCents: 1000,
      requiresManualReconciliation: true,
    };
    serviceRefund.mockResolvedValueOnce(raced);

    const result = await controller.refund(
      STAFF_REQ as Request,
      'order-1',
      { reason: 'race scenario', amount_cents: 1000 },
    );

    expect(result).toEqual({
      status: 'race-recorded',
      stripeRefundId: 're_race_1',
      amountCents: 1000,
      requiresManualReconciliation: true,
      message:
        'Refund processed at Stripe but a database race was detected. ' +
        'Manager must reconcile this refund manually via Stripe dashboard.',
    });
  });
});
