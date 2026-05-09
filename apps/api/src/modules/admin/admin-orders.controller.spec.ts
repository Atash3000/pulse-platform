import { Test } from '@nestjs/testing';
import type { Request } from 'express';

import { Order, OrderStatus, Refund, StaffRole } from '../../database/entities';
import { AdminOrdersController } from './admin-orders.controller';
import {
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

  it('committed: returns { status, order, refund } passthrough', async () => {
    const order = { id: 'order-1', order_status: OrderStatus.REFUNDED } as Order;
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
