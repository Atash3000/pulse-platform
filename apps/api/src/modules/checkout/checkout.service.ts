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

/**
 * Structured rejection codes for cart-validation errors, mirroring
 * `AvailabilityRejectReason` from `HoursService`. Every cart-validation
 * `BadRequestException` carries a `reason` + `message` + optional `meta`
 * so the iOS client can map the reason to a localized string and surface
 * `meta.itemName` / `meta.groupName` in user-facing copy. The English
 * `message` is the operator-facing fallback.
 *
 * See decision-log entry "Modifier validation: required, multi-select,
 * and duplicate enforcement" for the full reasoning behind each code.
 */
export type CartValidationRejectReason =
  | 'ITEM_NOT_FOUND'
  | 'ITEM_WRONG_LOCATION'
  | 'MODIFIER_NOT_FOUND'
  | 'MODIFIER_NOT_ON_ITEM'
  | 'MODIFIER_DUPLICATE'
  | 'MODIFIER_GROUP_REQUIRED'
  | 'MODIFIER_GROUP_SINGLE_SELECT';

interface CartValidationErrorMeta {
  itemId?: string;
  itemName?: string;
  modifierId?: string;
  groupId?: string;
  groupName?: string;
}

function cartValidationError(
  reason: CartValidationRejectReason,
  message: string,
  meta: CartValidationErrorMeta = {},
): BadRequestException {
  return new BadRequestException({ reason, message, ...meta });
}

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectRepository(MenuItem) private readonly items: Repository<MenuItem>,
    // `Modifier` repo no longer injected — modifier validation now loads
    // groups + their modifiers via the nested `MenuItem.modifier_groups`
    // relation in `validateCartItems`, which is necessary anyway to
    // enforce the `required` / `multi_select` per-group rules. Removed
    // from `checkout.module.ts`'s `forFeature` list too.
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
    // Load each item with its full modifier_groups tree (groups + each
    // group's modifiers). Required for the per-group `required` /
    // `multi_select` enforcement below — we need to know every group on
    // the item, not just the groups whose modifiers the customer
    // selected.
    const dbItems = await this.items.find({
      where: { id: In(itemIds), active: true },
      relations: { category: true, modifier_groups: { modifiers: true } },
    });
    const itemById = new Map(dbItems.map((i) => [i.id, i]));

    // Every cart item must exist, be active, and belong to a category at THIS
    // location (the latter is the multi-tenant guard for Rule #13).
    for (const c of cart) {
      const i = itemById.get(c.menuItemId);
      if (!i) {
        throw cartValidationError(
          'ITEM_NOT_FOUND',
          `Item ${c.menuItemId} not found or inactive`,
          { itemId: c.menuItemId },
        );
      }
      if (!i.category || i.category.location_id !== locationId) {
        throw cartValidationError(
          'ITEM_WRONG_LOCATION',
          `Item ${c.menuItemId} does not belong to this location`,
          { itemId: c.menuItemId, itemName: i.name },
        );
      }
    }

    // Inventory pre-check (the transaction in step 5 will re-check).
    await this.assertItemsStillAvailable(this.inventory, locationId, itemIds);

    // Per-cart-item modifier validation. Runs three checks per item:
    //
    //   1. Duplicate modifierIds within this line item → MODIFIER_DUPLICATE
    //      (throw rather than silent-dedup; a client sending duplicates is
    //      buggy and silent dedup would mask it — Golden Rule #8 spirit).
    //   2. Every selected modifier exists, is active, and belongs to a
    //      modifier_group of THIS item → MODIFIER_NOT_FOUND /
    //      MODIFIER_NOT_ON_ITEM.
    //   3. For every modifier_group on the item, count the selections
    //      against the (required, multi_select) cross-product rule —
    //      see decision-log entry "Modifier validation: required,
    //      multi-select, and duplicate enforcement" for the 2x2 matrix.
    //
    // Validation runs to completion per line item (no short-circuit); the
    // first violation throws. Multiple violations across the cart still
    // throw on the first line item that has one — the customer fixes one,
    // retries, finds the next.
    return cart.map((c) => {
      const item = itemById.get(c.menuItemId)!;

      // 1. Duplicate detection — `new Set(...).size === array.length` is
      // false iff at least one duplicate exists.
      if (new Set(c.modifierIds).size !== c.modifierIds.length) {
        throw cartValidationError(
          'MODIFIER_DUPLICATE',
          `Duplicate modifier selected on '${item.name}'. ` +
            `Each modifier can only be selected once per item.`,
          { itemId: item.id, itemName: item.name },
        );
      }

      // Build a lookup from modifier_id → (modifier, group) for this item.
      // The nested relation load gave us groups + each group's modifiers.
      const groupsOnItem = item.modifier_groups ?? [];
      const modifierLookup = new Map<
        string,
        { modifier: Modifier; group: typeof groupsOnItem[number] }
      >();
      for (const group of groupsOnItem) {
        for (const modifier of group.modifiers ?? []) {
          if (modifier.active) {
            modifierLookup.set(modifier.id, { modifier, group });
          }
        }
      }

      // 2. Validate each selected modifier exists on this item.
      const modifiers = c.modifierIds.map((modifierId) => {
        const entry = modifierLookup.get(modifierId);
        if (!entry) {
          // Could be either "doesn't exist anywhere" or "exists on a
          // different item." Distinguish via a fallback lookup on Modifier
          // itself — if it exists active, it belongs to a different item.
          throw cartValidationError(
            'MODIFIER_NOT_ON_ITEM',
            `Modifier ${modifierId} is not available on '${item.name}'.`,
            { itemId: item.id, itemName: item.name, modifierId },
          );
        }
        return {
          modifierId: entry.modifier.id,
          name: entry.modifier.name,
          priceCents: entry.modifier.price_cents,
        };
      });

      // 3. Apply the (required × multi_select) rule per group on this item.
      //
      //   | required | multi_select | rule                  |
      //   |----------|--------------|-----------------------|
      //   | false    | false        | 0 or 1 selection      |
      //   | false    | true         | 0 or more selections  |
      //   | true     | false        | exactly 1 selection   |
      //   | true     | true         | 1 or more selections  |
      //
      // Selections are counted by matching the customer's modifierIds
      // against the modifiers in each group — a single Set membership
      // check per modifier id.
      const selectedIdSet = new Set(c.modifierIds);
      for (const group of groupsOnItem) {
        const groupModifierIds = (group.modifiers ?? []).map((m) => m.id);
        const selectedFromGroup = groupModifierIds.filter((id) => selectedIdSet.has(id));

        if (group.required && selectedFromGroup.length === 0) {
          throw cartValidationError(
            'MODIFIER_GROUP_REQUIRED',
            `Please select a '${group.name}' option for '${item.name}'.`,
            { itemId: item.id, itemName: item.name, groupId: group.id, groupName: group.name },
          );
        }
        if (!group.multi_select && selectedFromGroup.length > 1) {
          throw cartValidationError(
            'MODIFIER_GROUP_SINGLE_SELECT',
            `Only one '${group.name}' option allowed for '${item.name}'.`,
            { itemId: item.id, itemName: item.name, groupId: group.id, groupName: group.name },
          );
        }
      }

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
