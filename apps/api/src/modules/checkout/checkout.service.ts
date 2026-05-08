import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';

import {
  Inventory,
  MenuItem,
  Modifier,
  Order,
  OrderEvent,
  OrderItem,
  OrderItemModifierSnapshot,
  OrderStatus,
  PaymentStatus,
  PickupType,
} from '../../database/entities';
import { HoursService } from '../locations/hours.service';
import { OrderStateMachine } from '../orders/order-state-machine';
import { StripeService } from '../payments/stripe.service';
import {
  CalculateOrderItem,
  PricingService,
} from '../pricing/pricing.service';
import { CartItemDto, CheckoutRequestDto } from './dto/checkout-request.dto';

export interface CheckoutResponse {
  orderId: string;
  clientSecret: string;
  totalCents: number;
  display: {
    subtotal: string;
    modifier: string;
    discount: string;
    tax: string;
    tip: string;
    total: string;
  };
}

interface ValidatedCartItem extends CalculateOrderItem {
  modifierIds: string[];
}

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(MenuItem) private readonly items: Repository<MenuItem>,
    @InjectRepository(Modifier) private readonly modifiers: Repository<Modifier>,
    @InjectRepository(Inventory) private readonly inventory: Repository<Inventory>,
    private readonly hours: HoursService,
    private readonly pricing: PricingService,
    private readonly stripe: StripeService,
  ) {}

  /**
   * The single, indivisible checkout flow.
   * Implements spec section 5.2 step-by-step.
   */
  async checkout(customerId: string, dto: CheckoutRequestDto): Promise<CheckoutResponse> {
    // -----------------------------------------------------------------------
    // Step 1: Idempotency check (BEFORE any other work, per spec).
    // -----------------------------------------------------------------------
    const cached = await this.tryReturnCachedResponse(customerId, dto);
    if (cached) return cached;

    // -----------------------------------------------------------------------
    // Step 2: Location validation.
    // -----------------------------------------------------------------------
    const availability = await this.hours.canAcceptOrders(dto.locationId, {
      pickupType: dto.pickupType,
      scheduledTime: dto.scheduledPickupAt ? new Date(dto.scheduledPickupAt) : undefined,
    });
    if (!availability.allowed) {
      throw new BadRequestException({
        reason: availability.reason,
        message: availability.message,
        ...(availability.nextOpenAt ? { nextOpenAt: availability.nextOpenAt.toISOString() } : {}),
      });
    }
    const estimatedReadyAt = availability.estimatedReadyAt;

    // -----------------------------------------------------------------------
    // Step 3: Item + modifier validation. Backend prices replace iOS prices.
    // -----------------------------------------------------------------------
    const validatedItems = await this.validateCartItems(dto.items, dto.locationId);

    // -----------------------------------------------------------------------
    // Step 3.5: Tip-percent must match this location's pricing rule.
    // -----------------------------------------------------------------------
    await this.pricing.validateTipPercent(dto.locationId, dto.tipPercent);

    // -----------------------------------------------------------------------
    // Step 4: Price calculation.
    // -----------------------------------------------------------------------
    const calculation = await this.pricing.calculateOrder({
      locationId: dto.locationId,
      items: validatedItems.map(({ modifierIds: _ids, ...rest }) => rest),
      tipPercent: dto.tipPercent,
    });

    // -----------------------------------------------------------------------
    // Step 5: Atomic transaction — re-check inventory, create order + items,
    // create Stripe PaymentIntent, persist its id, commit. ALL OR NOTHING.
    // -----------------------------------------------------------------------
    const result = await this.ds.transaction(async (em) => {
      // Re-check inventory inside the transaction. Another customer or a staff
      // sold-out toggle could have flipped between step 3 and now.
      await this.assertItemsStillAvailable(
        em.getRepository(Inventory),
        dto.locationId,
        validatedItems.map((i) => i.menuItemId),
      );

      // Insert the order in DRAFT/REQUIRES_PAYMENT. The webhook will flip to PAID.
      const draft = em.create(Order, {
        customer_id: customerId,
        location_id: dto.locationId,
        idempotency_key: dto.idempotencyKey,
        order_status: OrderStatus.DRAFT,
        payment_status: PaymentStatus.REQUIRES_PAYMENT,
        pickup_type: dto.pickupType,
        scheduled_pickup_at: dto.scheduledPickupAt ? new Date(dto.scheduledPickupAt) : null,
        estimated_ready_at: estimatedReadyAt,
        subtotal_cents: calculation.subtotalCents,
        modifier_cents: calculation.modifierCents,
        discount_cents: calculation.discountCents,
        tax_cents: calculation.taxCents,
        tip_cents: calculation.tipCents,
        total_cents: calculation.totalCents,
        notes: dto.notes ?? null,
      });
      const order = await em.save(draft);

      // Frozen snapshots: if the menu changes later, this row still shows what
      // the customer actually paid for.
      await em.save(
        OrderItem,
        validatedItems.map((vi) =>
          em.create(OrderItem, {
            order_id: order.id,
            menu_item_id: vi.menuItemId,
            // Frozen snapshot — survives renames/deletes of the menu_item.
            item_name: vi.itemName,
            quantity: vi.quantity,
            unit_price_cents: vi.unitPriceCents,
            modifiers: vi.modifiers.map<OrderItemModifierSnapshot>((m) => ({
              modifierId: m.modifierId,
              name: m.name,
              priceCents: m.priceCents,
            })),
          }),
        ),
      );

      // Audit row: DRAFT created.
      await em.insert(OrderEvent, {
        order_id: order.id,
        from_status: null,
        to_status: OrderStatus.DRAFT,
        reason: null,
        created_by: 'customer',
        metadata: { idempotency_key: dto.idempotencyKey },
      });

      // Stripe call from inside the transaction (per spec 5.2 step 8). 10s
      // Stripe timeout caps how long we hold these row-level locks.
      const intent = await this.stripe.createPaymentIntent({
        amountCents: calculation.totalCents,
        orderId: order.id,
        customerId,
      });

      if (!intent.client_secret) {
        // Should never happen for new intents, but the type is nullable.
        throw new Error('Stripe returned PaymentIntent with no client_secret');
      }

      // Move to PENDING_PAYMENT and persist the PaymentIntent id.
      OrderStateMachine.assertTransition(
        order.order_status,
        OrderStatus.PENDING_PAYMENT,
        'system',
      );
      order.stripe_payment_id = intent.id;
      order.order_status = OrderStatus.PENDING_PAYMENT;
      await em.save(order);

      await em.insert(OrderEvent, {
        order_id: order.id,
        from_status: OrderStatus.DRAFT,
        to_status: OrderStatus.PENDING_PAYMENT,
        reason: null,
        created_by: 'system',
        metadata: { payment_intent_id: intent.id },
      });

      this.logger.log(
        `checkout order=${order.id} customer=${customerId} location=${dto.locationId} total=${calculation.totalCents} pi=${intent.id}`,
      );

      return {
        orderId: order.id,
        clientSecret: intent.client_secret,
        totalCents: calculation.totalCents,
      };
    });

    // -----------------------------------------------------------------------
    // Step 6: Return.
    // -----------------------------------------------------------------------
    return {
      orderId: result.orderId,
      clientSecret: result.clientSecret,
      totalCents: result.totalCents,
      display: calculation.display,
    };
  }

  // ---------------------------------------------------------------------------
  // Step 1 helper.
  // ---------------------------------------------------------------------------

  private async tryReturnCachedResponse(
    customerId: string,
    dto: CheckoutRequestDto,
  ): Promise<CheckoutResponse | null> {
    const existing = await this.orders.findOne({
      where: { idempotency_key: dto.idempotencyKey },
    });
    if (!existing) return null;

    // Belt-and-braces: a new customer must NEVER reuse another customer's key.
    if (existing.customer_id !== customerId) {
      throw new ConflictException('idempotencyKey already used by a different customer');
    }

    if (existing.payment_status === PaymentStatus.SUCCEEDED) {
      // Safe duplicate — replay the success payload. We re-derive display
      // strings from the persisted cents.
      return {
        orderId: existing.id,
        clientSecret: '',
        totalCents: existing.total_cents,
        display: {
          subtotal: fmtCents(existing.subtotal_cents),
          modifier: fmtCents(existing.modifier_cents),
          discount: fmtCents(existing.discount_cents),
          tax: fmtCents(existing.tax_cents),
          tip: fmtCents(existing.tip_cents),
          total: fmtCents(existing.total_cents),
        },
      };
    }

    if (
      existing.payment_status === PaymentStatus.REQUIRES_PAYMENT ||
      existing.payment_status === PaymentStatus.PROCESSING
    ) {
      throw new ConflictException({
        reason: 'PAYMENT_IN_FLIGHT',
        message:
          'A payment for this order is already in progress. Wait for confirmation rather than retrying.',
        orderId: existing.id,
      });
    }

    // FAILED or REFUNDED on a known idempotency key: do not allow reuse.
    throw new ConflictException({
      reason: 'IDEMPOTENCY_REPLAY_BLOCKED',
      message: `Cannot replay an idempotency key whose order is in payment_status=${existing.payment_status}.`,
    });
  }

  // ---------------------------------------------------------------------------
  // Step 3 helper — validate every item and every modifier against the DB.
  // ---------------------------------------------------------------------------

  private async validateCartItems(
    cart: CartItemDto[],
    locationId: string,
  ): Promise<ValidatedCartItem[]> {
    const itemIds = [...new Set(cart.map((c) => c.menuItemId))];
    const dbItems = await this.items.find({
      where: { id: In(itemIds), active: true },
      relations: { category: true },
    });
    const itemById = new Map(dbItems.map((i) => [i.id, i]));

    // Every cart item must exist, be active, and belong to a category at THIS
    // location (the latter is the multi-tenant guard for Rule #13).
    for (const c of cart) {
      const i = itemById.get(c.menuItemId);
      if (!i) {
        throw new BadRequestException(`Item ${c.menuItemId} not found or inactive`);
      }
      if (!i.category || i.category.location_id !== locationId) {
        throw new BadRequestException(`Item ${c.menuItemId} does not belong to this location`);
      }
    }

    // Inventory pre-check (the transaction in step 5 will re-check).
    await this.assertItemsStillAvailable(this.inventory, locationId, itemIds);

    // Look up every requested modifier in one shot, then verify each one
    // belongs to a modifier_group of the cart item it was attached to.
    const allModifierIds = [...new Set(cart.flatMap((c) => c.modifierIds))];
    const dbModifiers = allModifierIds.length
      ? await this.modifiers.find({
          where: { id: In(allModifierIds), active: true },
          relations: { group: true },
        })
      : [];
    const modById = new Map(dbModifiers.map((m) => [m.id, m]));

    return cart.map((c) => {
      const item = itemById.get(c.menuItemId)!;
      const modifiers = c.modifierIds.map((modifierId) => {
        const m = modById.get(modifierId);
        if (!m || !m.group) {
          throw new BadRequestException(`Modifier ${modifierId} not found or inactive`);
        }
        if (m.group.item_id !== item.id) {
          throw new BadRequestException(
            `Modifier ${modifierId} does not belong to item ${item.id}`,
          );
        }
        return { modifierId: m.id, name: m.name, priceCents: m.price_cents };
      });
      return {
        menuItemId: item.id,
        itemName: item.name,
        unitPriceCents: item.base_price_cents,
        quantity: c.quantity,
        modifiers,
        modifierIds: c.modifierIds,
      };
    });
  }

  /**
   * Treats missing inventory rows as available (matches MenuService default).
   * The IN-clause handles the case of multiple unique items per cart in one query.
   */
  private async assertItemsStillAvailable(
    repo: Repository<Inventory>,
    locationId: string,
    itemIds: string[],
  ): Promise<void> {
    if (itemIds.length === 0) return;
    const rows = await repo.find({
      where: { location_id: locationId, item_id: In(itemIds) },
    });
    for (const inv of rows) {
      if (!inv.available) {
        throw new BadRequestException({
          reason: 'ITEM_UNAVAILABLE',
          message: `Item ${inv.item_id} is currently sold out`,
          itemId: inv.item_id,
        });
      }
      if (inv.quantity_left !== null && inv.quantity_left <= 0) {
        throw new BadRequestException({
          reason: 'ITEM_OUT_OF_STOCK',
          message: `Item ${inv.item_id} is out of stock`,
          itemId: inv.item_id,
        });
      }
    }
  }
}

function fmtCents(cents: number): string {
  return (cents / 100).toFixed(2);
}
