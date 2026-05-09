import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import { StaffRole } from '../../database/entities';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CancelOrderDto } from './dto/cancel-order.dto';
import { RefundOrderDto } from './dto/refund-order.dto';
import {
  AdminOrderEventRow,
  AdminOrderListItem,
  AdminOrdersService,
  RefundResult,
} from './admin-orders.service';
import { requireStaff } from './staff-context';

// Admin endpoints: 30 req/min/IP per spec Part 4.5.
@ApiTags('admin-orders')
@ApiBearerAuth('jwt')
@Controller('admin')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class AdminOrdersController {
  constructor(private readonly orders: AdminOrdersService) {}

  // ---- Live queue ---------------------------------------------------------

  @Get('orders')
  @HttpCode(HttpStatus.OK)
  @Roles(StaffRole.BARISTA, StaffRole.MANAGER, StaffRole.OWNER)
  @ApiOperation({
    summary: 'Live order queue for the staff member\'s location',
    description:
      'Returns active orders only (PAID, ACCEPTED, IN_PROGRESS, READY) for the location in the staff JWT. Polled by the staff dashboard every 5 seconds.',
  })
  @ApiResponse({ status: 200, description: 'Active orders, oldest first.' })
  list(@Req() req: Request): Promise<AdminOrderListItem[]> {
    const staff = requireStaff(req);
    return this.orders.listActiveOrders(staff);
  }

  // ---- Transitions (BARISTA+) --------------------------------------------

  @Post('orders/:id/accept')
  @HttpCode(HttpStatus.OK)
  @Roles(StaffRole.BARISTA, StaffRole.MANAGER, StaffRole.OWNER)
  @ApiOperation({ summary: 'PAID → ACCEPTED. Sets estimated_ready_at.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Order transitioned to ACCEPTED.' })
  @ApiResponse({ status: 404, description: 'Order not at this location.' })
  @ApiResponse({ status: 409, description: 'Order not in PAID status.' })
  accept(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    const staff = requireStaff(req);
    return this.orders.accept(staff, id);
  }

  @Post('orders/:id/progress')
  @HttpCode(HttpStatus.OK)
  @Roles(StaffRole.BARISTA, StaffRole.MANAGER, StaffRole.OWNER)
  @ApiOperation({ summary: 'ACCEPTED → IN_PROGRESS.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Order transitioned to IN_PROGRESS.' })
  @ApiResponse({ status: 409, description: 'Order not in ACCEPTED status.' })
  progress(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    const staff = requireStaff(req);
    return this.orders.progress(staff, id);
  }

  @Post('orders/:id/ready')
  @HttpCode(HttpStatus.OK)
  @Roles(StaffRole.BARISTA, StaffRole.MANAGER, StaffRole.OWNER)
  @ApiOperation({
    summary: 'IN_PROGRESS → READY. Inserts an ORDER_READY outbox event for push delivery.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Order transitioned to READY.' })
  @ApiResponse({ status: 409, description: 'Order not in IN_PROGRESS status.' })
  ready(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    const staff = requireStaff(req);
    return this.orders.markReady(staff, id);
  }

  @Post('orders/:id/picked-up')
  @HttpCode(HttpStatus.OK)
  @Roles(StaffRole.BARISTA, StaffRole.MANAGER, StaffRole.OWNER)
  @ApiOperation({ summary: 'READY → PICKED_UP. Closes the order.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Order transitioned to PICKED_UP.' })
  @ApiResponse({ status: 409, description: 'Order not in READY status.' })
  pickedUp(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    const staff = requireStaff(req);
    return this.orders.markPickedUp(staff, id);
  }

  // ---- Cancel + Refund (MANAGER+) ----------------------------------------

  @Post('orders/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(StaffRole.MANAGER, StaffRole.OWNER)
  @ApiOperation({
    summary: 'Cancel an active order (manager+).',
    description:
      'Valid from PAID, ACCEPTED, IN_PROGRESS, or READY. DRAFT and PENDING_PAYMENT cancellations are not the manager\'s territory. Inserts ORDER_CANCELLED outbox event only when payment_status=SUCCEEDED.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Order cancelled.' })
  @ApiResponse({ status: 400, description: 'reason missing or too short.' })
  @ApiResponse({ status: 403, description: 'Insufficient role.' })
  @ApiResponse({ status: 409, description: 'Order is in a status managers may not cancel.' })
  cancel(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelOrderDto,
  ) {
    const staff = requireStaff(req);
    return this.orders.cancelByManager(staff, id, dto.reason);
  }

  @Post('orders/:id/refund')
  @HttpCode(HttpStatus.OK)
  @Roles(StaffRole.MANAGER, StaffRole.OWNER)
  @ApiOperation({
    summary: 'Issue a full or partial refund (manager+).',
    description:
      'amount_cents omitted = full refund. Stripe is pre-validated, then called, then the DB write happens under a row lock. If Stripe accepts the refund but a concurrent refund races us inside the lock, the response carries status="race-recorded" with a manual-reconciliation flag — the money DID move at Stripe, but no DB refund row was created.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({
    status: 200,
    description:
      'Two shapes by discriminator. status="committed": refund persisted, order updated. status="race-recorded": Stripe refunded but a DB race blocked persistence; manager must reconcile via Stripe dashboard.',
  })
  @ApiResponse({ status: 400, description: 'reason missing/short, or amount_cents out of bounds.' })
  @ApiResponse({ status: 403, description: 'Insufficient role.' })
  @ApiResponse({ status: 404, description: 'Order not at this location.' })
  @ApiResponse({ status: 502, description: 'Stripe refund call failed; database unchanged.' })
  async refund(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RefundOrderDto,
  ) {
    const staff = requireStaff(req);
    const result: RefundResult = await this.orders.refund(
      staff,
      id,
      dto.reason,
      dto.amount_cents,
    );

    if (result.status === 'race-recorded') {
      // Surface the race outcome to the caller with the same discriminator
      // the service uses, plus an operator-facing message. Don't drop the
      // race shape into the generic { order, refund } response — callers
      // would silently treat it as a successful commit.
      return {
        status: result.status,
        stripeRefundId: result.stripeRefundId,
        amountCents: result.amountCents,
        requiresManualReconciliation: result.requiresManualReconciliation,
        message:
          'Refund processed at Stripe but a database race was detected. ' +
          'Manager must reconcile this refund manually via Stripe dashboard.',
      };
    }
    return {
      status: result.status,
      order: result.order,
      refund: result.refund,
    };
  }

  // ---- Audit trail (MANAGER+) --------------------------------------------

  @Get('orders/:id/events')
  @HttpCode(HttpStatus.OK)
  @Roles(StaffRole.MANAGER, StaffRole.OWNER)
  @ApiOperation({
    summary: 'Full audit trail of order_events for one order',
    description: 'First-line support tool when a customer asks where their order is.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Chronological array of events.' })
  @ApiResponse({ status: 403, description: 'Insufficient role.' })
  @ApiResponse({ status: 404, description: 'Order not at this location.' })
  events(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminOrderEventRow[]> {
    const staff = requireStaff(req);
    return this.orders.getOrderEvents(staff, id);
  }
}
