import { BadRequestException } from '@nestjs/common';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';

import {
  Inventory,
  MenuItem,
  Order,
  OrderEvent,
  OrderItem,
  PickupType,
} from '../../database/entities';
import { HoursService } from '../locations/hours.service';
import { StripeService } from '../payments/stripe.service';
import { PricingService } from '../pricing/pricing.service';
import { CheckoutService } from './checkout.service';

// =============================================================================
// CheckoutService — modifier validation (bug-fix #2) + end-to-end smoke.
//
// SCOPE (intentionally narrow — combined turn for audit items #2 + #10):
//
//   - Modifier validation: all 11 cases of the (required × multi_select)
//     matrix, plus per-item duplicate detection, plus the four
//     preserved-behavior tests (item-not-found, item-wrong-location,
//     modifier-not-found-on-item, inactive-item).
//   - One end-to-end happy-path smoke through the full `checkout()`
//     method to anchor the test scaffold for future additions.
//
// UNCOVERED — known gaps left for follow-up turns:
//
//   - Idempotency cache paths (Step 1 in `checkout()`): cache HIT
//     returning the prior response, cache MISS proceeding, and the
//     same-key-different-customer ConflictException branch.
//   - HoursService rejection passthrough (Step 2): asserting that an
//     `AvailabilityRejected` from HoursService surfaces as a
//     BadRequestException with the original reason/message — currently
//     only the happy path is exercised.
//   - Inventory race (Step 5): the in-transaction inventory re-check
//     has no row lock (bug #8 in the audit). Tests would need real
//     concurrency or a contrived two-call mock to pin the gap. Deferred
//     to bug #8's own turn.
//   - Transaction rollback / Stripe error path: simulate Stripe throwing
//     and assert no Order is persisted, no orphan PaymentIntent stays
//     at Stripe. Bug #5 territory.
//   - Tip-percent validation (Step 3.5): delegates to PricingService;
//     tested at the pricing-service level, not exercised here.
//   - Pricing service integration (Step 4): same — covered by
//     PricingService specs.
//
// See decision-log entry "Modifier validation: required, multi-select,
// and duplicate enforcement" for the scope rationale.
// =============================================================================

interface FixtureModifier {
  id: string;
  name: string;
  price_cents: number;
  active?: boolean;
}

interface FixtureGroup {
  id: string;
  name: string;
  required: boolean;
  multi_select: boolean;
  modifiers: FixtureModifier[];
}

interface FixtureItem {
  id: string;
  name: string;
  base_price_cents: number;
  active?: boolean;
  category?: { id: string; location_id: string };
  groups?: FixtureGroup[];
}

const LOC_ID = 'loc-1';
const CUST_ID = 'cust-1';

/**
 * Spins up a CheckoutService with mocked repos + delegate services.
 * `fixtureItems` controls what `items.find` returns. Other dependencies
 * are stubbed to pass-through so the validation phase is the only thing
 * exercised in cart-validation tests.
 */
async function buildService(opts: {
  fixtureItems: FixtureItem[];
  // For the smoke test: controls whether the transaction body should
  // succeed (default) or simulate an error. Cart-validation tests don't
  // reach the transaction so this is unused for those.
  transactionBehavior?: 'succeed' | 'throw';
} = { fixtureItems: [] }): Promise<{
  service: CheckoutService;
  hoursCanAccept: jest.Mock;
  pricingCalculate: jest.Mock;
  pricingValidateTip: jest.Mock;
  stripeCreatePI: jest.Mock;
  ordersFindOne: jest.Mock;
  txExecute: jest.Mock;
}> {
  const items = opts.fixtureItems.map((f) => ({
    id: f.id,
    name: f.name,
    base_price_cents: f.base_price_cents,
    active: f.active ?? true,
    category: f.category ?? { id: 'cat-1', location_id: LOC_ID },
    modifier_groups: (f.groups ?? []).map((g) => ({
      id: g.id,
      name: g.name,
      required: g.required,
      multi_select: g.multi_select,
      modifiers: g.modifiers.map((m) => ({
        id: m.id,
        name: m.name,
        price_cents: m.price_cents,
        active: m.active ?? true,
      })),
    })),
  })) as unknown as MenuItem[];

  // Repos
  const itemsFind = jest.fn().mockResolvedValue(items);
  const inventoryFind = jest.fn().mockResolvedValue([]); // empty → all available
  const ordersFindOne = jest.fn().mockResolvedValue(null); // no idempotency cache hit

  // Delegate services
  const hoursCanAccept = jest.fn().mockResolvedValue({
    allowed: true,
    estimatedReadyAt: new Date('2026-05-11T18:05:00Z'),
    waitMinutes: 5,
  });
  const pricingCalculate = jest.fn().mockResolvedValue({
    subtotalCents: 500,
    modifierCents: 0,
    discountCents: 0,
    taxCents: 45,
    tipCents: 0,
    totalCents: 545,
    display: {
      subtotal: '$5.00',
      modifier: '$0.00',
      discount: '$0.00',
      tax: '$0.45',
      tip: '$0.00',
      total: '$5.45',
    },
  });
  const pricingValidateTip = jest.fn().mockResolvedValue(undefined);
  const stripeCreatePI = jest.fn().mockResolvedValue({
    id: 'pi_smoke',
    client_secret: 'pi_smoke_secret',
  });

  // Transaction: stub to run the callback with a mocked `em` that records
  // saves/inserts. The smoke test relies on this; cart-validation tests
  // throw before reaching the transaction so they never touch it.
  //
  // `em.save` simulates TypeORM's id-population behavior on insert — the
  // real implementation assigns an id from the DB (`PrimaryGeneratedColumn`).
  // Tests need a stable id so smoke assertions work.
  const emSave = jest.fn().mockImplementation(async (entity) => {
    if (typeof entity === 'object' && entity !== null && !('id' in entity && (entity as { id: unknown }).id)) {
      (entity as { id: string }).id = 'order-fake-uuid';
    }
    return entity;
  });
  const emInsert = jest.fn().mockResolvedValue(undefined);
  const emCreate = jest.fn().mockImplementation((_entity, dto) => ({ ...dto }));
  const txExecute = jest.fn().mockImplementation(async (cb) => {
    if (opts.transactionBehavior === 'throw') {
      throw new Error('simulated transaction failure');
    }
    return cb({
      save: emSave,
      insert: emInsert,
      create: emCreate,
      getRepository: jest.fn().mockReturnValue({ find: inventoryFind }),
    });
  });

  const moduleRef = await Test.createTestingModule({
    providers: [
      CheckoutService,
      { provide: getDataSourceToken(), useValue: { transaction: txExecute } },
      { provide: getRepositoryToken(Order), useValue: { findOne: ordersFindOne } },
      { provide: getRepositoryToken(OrderItem), useValue: {} },
      { provide: getRepositoryToken(OrderEvent), useValue: {} },
      { provide: getRepositoryToken(MenuItem), useValue: { find: itemsFind } },
      { provide: getRepositoryToken(Inventory), useValue: { find: inventoryFind } },
      {
        provide: HoursService,
        useValue: { canAcceptOrders: hoursCanAccept },
      },
      {
        provide: PricingService,
        useValue: {
          calculateOrder: pricingCalculate,
          validateTipPercent: pricingValidateTip,
        },
      },
      {
        provide: StripeService,
        useValue: { createPaymentIntent: stripeCreatePI },
      },
    ],
  }).compile();

  return {
    service: moduleRef.get(CheckoutService),
    hoursCanAccept,
    pricingCalculate,
    pricingValidateTip,
    stripeCreatePI,
    ordersFindOne,
    txExecute,
  };
}

// Fixture builders for the (required × multi_select) matrix tests.
function itemWithGroup(
  itemId: string,
  itemName: string,
  groupConfig: { required: boolean; multi_select: boolean },
  modifierCount = 3,
): FixtureItem {
  const groupId = `${itemId}-group-1`;
  const modifiers: FixtureModifier[] = [];
  for (let i = 0; i < modifierCount; i++) {
    modifiers.push({
      id: `${groupId}-mod-${i + 1}`,
      name: `Mod${i + 1}`,
      price_cents: 50,
    });
  }
  return {
    id: itemId,
    name: itemName,
    base_price_cents: 500,
    groups: [
      {
        id: groupId,
        name: 'Size',
        required: groupConfig.required,
        multi_select: groupConfig.multi_select,
        modifiers,
      },
    ],
  };
}

function checkoutDto(items: { menuItemId: string; modifierIds: string[]; quantity?: number }[]) {
  return {
    locationId: LOC_ID,
    idempotencyKey: 'idem-test-key-12345',
    items: items.map((i) => ({
      menuItemId: i.menuItemId,
      modifierIds: i.modifierIds,
      quantity: i.quantity ?? 1,
    })),
    tipPercent: 15,
    pickupType: PickupType.ASAP,
  };
}

/**
 * Asserts that a thrown error is a BadRequestException with the expected
 * structured `reason` code. Mirrors the HoursService rejection-meta
 * assertion pattern.
 */
function expectRejectedWith(err: unknown, reason: string): void {
  expect(err).toBeInstanceOf(BadRequestException);
  const response = (err as BadRequestException).getResponse() as { reason: string; message: string };
  expect(response.reason).toBe(reason);
}

// =============================================================================
// (required × multi_select) matrix — 11 cases
// =============================================================================

describe('CheckoutService.validateCartItems — (required × multi_select) matrix', () => {
  // ---------- required=false, multi_select=false ----------
  describe('required=false, multi_select=false (optional + single-select)', () => {
    it('TC1: 0 selections → OK', async () => {
      const { service } = await buildService({
        fixtureItems: [itemWithGroup('item-1', 'Latte', { required: false, multi_select: false })],
      });
      await expect(
        service.checkout(CUST_ID, checkoutDto([{ menuItemId: 'item-1', modifierIds: [] }])),
      ).resolves.toBeDefined();
    });

    it('TC2: 1 selection → OK', async () => {
      const { service } = await buildService({
        fixtureItems: [itemWithGroup('item-1', 'Latte', { required: false, multi_select: false })],
      });
      await expect(
        service.checkout(
          CUST_ID,
          checkoutDto([{ menuItemId: 'item-1', modifierIds: ['item-1-group-1-mod-1'] }]),
        ),
      ).resolves.toBeDefined();
    });

    it('TC3: 2 selections → REJECT MODIFIER_GROUP_SINGLE_SELECT', async () => {
      const { service } = await buildService({
        fixtureItems: [itemWithGroup('item-1', 'Latte', { required: false, multi_select: false })],
      });
      let caught: unknown;
      try {
        await service.checkout(
          CUST_ID,
          checkoutDto([
            { menuItemId: 'item-1', modifierIds: ['item-1-group-1-mod-1', 'item-1-group-1-mod-2'] },
          ]),
        );
      } catch (e) {
        caught = e;
      }
      expectRejectedWith(caught, 'MODIFIER_GROUP_SINGLE_SELECT');
    });
  });

  // ---------- required=false, multi_select=true ----------
  describe('required=false, multi_select=true (optional + multi-select)', () => {
    it('TC4: 0 selections → OK', async () => {
      const { service } = await buildService({
        fixtureItems: [itemWithGroup('item-1', 'Latte', { required: false, multi_select: true })],
      });
      await expect(
        service.checkout(CUST_ID, checkoutDto([{ menuItemId: 'item-1', modifierIds: [] }])),
      ).resolves.toBeDefined();
    });

    it('TC5: 2 selections → OK (multi-select allows it)', async () => {
      const { service } = await buildService({
        fixtureItems: [itemWithGroup('item-1', 'Latte', { required: false, multi_select: true })],
      });
      await expect(
        service.checkout(
          CUST_ID,
          checkoutDto([
            { menuItemId: 'item-1', modifierIds: ['item-1-group-1-mod-1', 'item-1-group-1-mod-2'] },
          ]),
        ),
      ).resolves.toBeDefined();
    });
  });

  // ---------- required=true, multi_select=false ----------
  describe('required=true, multi_select=false (must pick exactly one)', () => {
    it('TC6: 0 selections → REJECT MODIFIER_GROUP_REQUIRED', async () => {
      const { service } = await buildService({
        fixtureItems: [itemWithGroup('item-1', 'Latte', { required: true, multi_select: false })],
      });
      let caught: unknown;
      try {
        await service.checkout(CUST_ID, checkoutDto([{ menuItemId: 'item-1', modifierIds: [] }]));
      } catch (e) {
        caught = e;
      }
      expectRejectedWith(caught, 'MODIFIER_GROUP_REQUIRED');
      const response = (caught as BadRequestException).getResponse() as {
        reason: string;
        message: string;
        groupName?: string;
      };
      expect(response.groupName).toBe('Size');
    });

    it('TC7: 1 selection → OK', async () => {
      const { service } = await buildService({
        fixtureItems: [itemWithGroup('item-1', 'Latte', { required: true, multi_select: false })],
      });
      await expect(
        service.checkout(
          CUST_ID,
          checkoutDto([{ menuItemId: 'item-1', modifierIds: ['item-1-group-1-mod-1'] }]),
        ),
      ).resolves.toBeDefined();
    });

    it('TC8: 2 selections → REJECT MODIFIER_GROUP_SINGLE_SELECT', async () => {
      const { service } = await buildService({
        fixtureItems: [itemWithGroup('item-1', 'Latte', { required: true, multi_select: false })],
      });
      let caught: unknown;
      try {
        await service.checkout(
          CUST_ID,
          checkoutDto([
            { menuItemId: 'item-1', modifierIds: ['item-1-group-1-mod-1', 'item-1-group-1-mod-2'] },
          ]),
        );
      } catch (e) {
        caught = e;
      }
      expectRejectedWith(caught, 'MODIFIER_GROUP_SINGLE_SELECT');
    });
  });

  // ---------- required=true, multi_select=true ----------
  describe('required=true, multi_select=true (must pick one or more)', () => {
    it('TC9: 0 selections → REJECT MODIFIER_GROUP_REQUIRED', async () => {
      const { service } = await buildService({
        fixtureItems: [itemWithGroup('item-1', 'Latte', { required: true, multi_select: true })],
      });
      let caught: unknown;
      try {
        await service.checkout(CUST_ID, checkoutDto([{ menuItemId: 'item-1', modifierIds: [] }]));
      } catch (e) {
        caught = e;
      }
      expectRejectedWith(caught, 'MODIFIER_GROUP_REQUIRED');
    });

    it('TC10: 1 selection → OK', async () => {
      const { service } = await buildService({
        fixtureItems: [itemWithGroup('item-1', 'Latte', { required: true, multi_select: true })],
      });
      await expect(
        service.checkout(
          CUST_ID,
          checkoutDto([{ menuItemId: 'item-1', modifierIds: ['item-1-group-1-mod-1'] }]),
        ),
      ).resolves.toBeDefined();
    });

    it('TC11: 3 selections → OK (multi-select allows all)', async () => {
      const { service } = await buildService({
        fixtureItems: [itemWithGroup('item-1', 'Latte', { required: true, multi_select: true })],
      });
      await expect(
        service.checkout(
          CUST_ID,
          checkoutDto([
            {
              menuItemId: 'item-1',
              modifierIds: [
                'item-1-group-1-mod-1',
                'item-1-group-1-mod-2',
                'item-1-group-1-mod-3',
              ],
            },
          ]),
        ),
      ).resolves.toBeDefined();
    });
  });
});

// =============================================================================
// Duplicate detection (TC12)
// =============================================================================

describe('CheckoutService.validateCartItems — duplicate modifier', () => {
  it('TC12: same modifierId twice within one item → REJECT MODIFIER_DUPLICATE', async () => {
    const { service } = await buildService({
      fixtureItems: [itemWithGroup('item-1', 'Latte', { required: false, multi_select: true })],
    });
    let caught: unknown;
    try {
      await service.checkout(
        CUST_ID,
        checkoutDto([
          { menuItemId: 'item-1', modifierIds: ['item-1-group-1-mod-1', 'item-1-group-1-mod-1'] },
        ]),
      );
    } catch (e) {
      caught = e;
    }
    expectRejectedWith(caught, 'MODIFIER_DUPLICATE');
    const response = (caught as BadRequestException).getResponse() as {
      reason: string;
      itemName?: string;
    };
    expect(response.itemName).toBe('Latte');
  });
});

// =============================================================================
// Preserve-existing-behavior tests (TC13–TC15)
// =============================================================================

describe('CheckoutService.validateCartItems — preserved existing behavior', () => {
  it('TC13: modifier belongs to a different item → REJECT MODIFIER_NOT_ON_ITEM', async () => {
    // Item-1 has its own modifiers; we try to attach a modifier-id that
    // doesn't exist on item-1 at all. The handler treats "modifier not on
    // this item" as MODIFIER_NOT_ON_ITEM (covers both "doesn't exist
    // anywhere" and "exists on another item" — the customer sees the
    // same operator-facing message either way).
    const { service } = await buildService({
      fixtureItems: [itemWithGroup('item-1', 'Latte', { required: false, multi_select: true })],
    });
    let caught: unknown;
    try {
      await service.checkout(
        CUST_ID,
        checkoutDto([{ menuItemId: 'item-1', modifierIds: ['orphan-modifier-id'] }]),
      );
    } catch (e) {
      caught = e;
    }
    expectRejectedWith(caught, 'MODIFIER_NOT_ON_ITEM');
  });

  it('TC14: inactive item → REJECT ITEM_NOT_FOUND', async () => {
    // Inactive items don't appear in the `find({active: true})` result,
    // so the handler treats them as "not found." Same reason code as
    // genuinely-missing items — the customer sees one message.
    const { service } = await buildService({
      fixtureItems: [], // simulate the item being filtered out by `active: true`
    });
    let caught: unknown;
    try {
      await service.checkout(
        CUST_ID,
        checkoutDto([{ menuItemId: 'item-missing', modifierIds: [] }]),
      );
    } catch (e) {
      caught = e;
    }
    expectRejectedWith(caught, 'ITEM_NOT_FOUND');
  });

  it('TC15: item belongs to a different location → REJECT ITEM_WRONG_LOCATION', async () => {
    const { service } = await buildService({
      fixtureItems: [
        {
          id: 'item-1',
          name: 'Latte',
          base_price_cents: 500,
          category: { id: 'cat-other', location_id: 'OTHER-LOC' }, // different location
          groups: [],
        },
      ],
    });
    let caught: unknown;
    try {
      await service.checkout(
        CUST_ID,
        checkoutDto([{ menuItemId: 'item-1', modifierIds: [] }]),
      );
    } catch (e) {
      caught = e;
    }
    expectRejectedWith(caught, 'ITEM_WRONG_LOCATION');
  });
});

// =============================================================================
// End-to-end happy-path smoke (TC16)
// =============================================================================

describe('CheckoutService.checkout — end-to-end happy path', () => {
  it('TC16: cart with one item + valid modifiers → response with orderId, clientSecret, totals', async () => {
    const { service, hoursCanAccept, pricingCalculate, pricingValidateTip, stripeCreatePI, txExecute } =
      await buildService({
        fixtureItems: [itemWithGroup('item-1', 'Latte', { required: true, multi_select: false })],
      });

    const result = await service.checkout(
      CUST_ID,
      checkoutDto([{ menuItemId: 'item-1', modifierIds: ['item-1-group-1-mod-1'] }]),
    );

    // Response shape pinned (interface CheckoutResponse).
    expect(result).toMatchObject({
      clientSecret: 'pi_smoke_secret',
      totalCents: 545,
      display: expect.objectContaining({
        subtotal: expect.any(String),
        total: expect.any(String),
      }),
    });
    expect(result.orderId).toEqual(expect.any(String));

    // Every step in the flow was invoked.
    expect(hoursCanAccept).toHaveBeenCalledTimes(1);
    expect(pricingValidateTip).toHaveBeenCalledTimes(1);
    expect(pricingCalculate).toHaveBeenCalledTimes(1);
    expect(stripeCreatePI).toHaveBeenCalledTimes(1);
    expect(txExecute).toHaveBeenCalledTimes(1);
  });
});
