import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';

import type { JwtPayload } from '../auth/jwt-payload';
import { OrderHistoryQueryDto } from './dto/order-history-query.dto';
import {
  OrderDetail,
  OrderHistoryResponse,
  OrdersService,
} from './orders.service';

interface AuthedRequest extends Request {
  user?: JwtPayload;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_OFFSET = 0;

@ApiTags('orders')
@ApiBearerAuth('jwt')
@Controller('orders')
@UseGuards(AuthGuard('jwt'))
// 60/min/IP — iOS polls GET /orders/:id every 10s while the order is active.
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get('my')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Customer order history (paginated, most recent first)',
    description: 'Returns summary fields only — full item lists are loaded on demand via GET /orders/:id.',
  })
  @ApiResponse({ status: 200, description: 'Paginated order history.' })
  @ApiResponse({ status: 400, description: 'Invalid limit or offset.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid customer JWT.' })
  @ApiResponse({ status: 403, description: 'Token belongs to a staff user, not a customer.' })
  async listMyOrders(
    @Req() req: AuthedRequest,
    @Query() q: OrderHistoryQueryDto,
  ): Promise<OrderHistoryResponse> {
    const customerId = this.requireCustomer(req);
    return this.orders.getOrderHistory(
      customerId,
      q.limit ?? DEFAULT_LIMIT,
      q.offset ?? DEFAULT_OFFSET,
    );
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Customer order detail',
    description:
      'Polled by iOS every 10s while the order is active. For privacy, the response code does NOT distinguish "order does not exist" from "order belongs to a different customer" — both return 404 with an identical message. iOS should treat 404 as a terminal "stop polling" signal regardless of the underlying cause.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Order UUID' })
  @ApiResponse({ status: 200, description: 'Full order detail with items + modifier snapshots.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid customer JWT.' })
  @ApiResponse({
    status: 404,
    description: 'Order does not exist or does not belong to you.',
  })
  async getOrder(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OrderDetail> {
    const customerId = this.requireCustomer(req);
    return this.orders.getOrderForCustomer(customerId, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel an order (customer)',
    description:
      'Valid from DRAFT or PENDING_PAYMENT (i.e. before the customer confirms payment in the Stripe sheet). For PENDING_PAYMENT orders the server also asks Stripe to cancel the underlying PaymentIntent. After the webhook flips the order to PAID, only a manager can cancel.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Order UUID' })
  @ApiResponse({ status: 200, description: 'Order cancelled. Returns the updated order detail.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid customer JWT.' })
  @ApiResponse({
    status: 404,
    description: 'Order does not exist or does not belong to you.',
  })
  @ApiResponse({ status: 409, description: 'Order is not in a state where it can be cancelled by the customer.' })
  async cancelOrder(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OrderDetail> {
    const customerId = this.requireCustomer(req);
    return this.orders.cancelOrderAsCustomer(customerId, id);
  }

  private requireCustomer(req: AuthedRequest): string {
    const user = req.user;
    if (!user || user.type !== 'customer' || !user.sub) {
      throw new ForbiddenException('Customer credentials required');
    }
    return user.sub;
  }
}
