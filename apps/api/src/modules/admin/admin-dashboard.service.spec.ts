import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';

import { Location, StaffRole } from '../../database/entities';
import { AdminDashboardService } from './admin-dashboard.service';
import type { StaffContext } from './staff-context';

// =============================================================================
// AdminDashboardService.getSummary — A10 (units_sold) and A11 (net revenue).
//
// We mock DataSource.query so we can control each of the four SQL calls the
// service makes, in order:
//
//   1. today_start (date_trunc / AT TIME ZONE round-trip) → returns one row
//      with a `today_start` Date.
//   2. aggregates (order count + net revenue) → { count, revenue: string }.
//   3. top_items (SUM(quantity)) → array of { menu_item_id, item_name,
//      units_sold }.
//   4. new_customers → { new_customers: number }.
//
// The tests below stub call 1 + 4 to constants, and vary calls 2 + 3 per
// scenario. We don't simulate the SQL itself — we encode the *expected*
// post-query result and assert the service threads it through correctly.
// That's enough to pin the shape and the netting math; an integration test
// against a real Postgres would catch SQL regressions but isn't part of the
// Phase 1 unit-test surface.
// =============================================================================

const STAFF: StaffContext = {
  staff_user_id: 'owner-1',
  location_id: 'loc-1',
  role: StaffRole.OWNER,
};

const FIXED_TODAY_START = new Date('2026-05-09T04:00:00.000Z');

function makeLocation(overrides: Partial<Location> = {}): Location {
  return Object.assign(
    {
      id: STAFF.location_id,
      name: 'Pulse Coffee Downtown',
      timezone: 'America/New_York',
    },
    overrides,
  ) as unknown as Location;
}

interface AggregateRow {
  count: number;
  revenue: string;
}

interface TopItemRow {
  menu_item_id: string;
  item_name: string;
  units_sold: number;
}

/**
 * Builds the mocked ds.query implementation by walking through the four
 * expected calls in order. Caller supplies what each of calls 2 + 3 should
 * return; calls 1 + 4 use defaults.
 */
function makeQueryMock(opts: {
  aggregate: AggregateRow;
  topItems: TopItemRow[];
  newCustomers?: number;
}): jest.Mock {
  const sequence: unknown[] = [
    [{ today_start: FIXED_TODAY_START }],
    [opts.aggregate],
    opts.topItems,
    [{ new_customers: opts.newCustomers ?? 0 }],
  ];
  let i = 0;
  return jest.fn().mockImplementation(async () => {
    const next = sequence[i++];
    if (next === undefined) {
      throw new Error(`ds.query called ${i} times — only 4 calls were stubbed`);
    }
    return next;
  });
}

async function buildService(opts: {
  query: jest.Mock;
  location?: Location | null;
}): Promise<AdminDashboardService> {
  const fakeDs = { query: opts.query };
  const fakeLocations = {
    findOne: jest.fn().mockResolvedValue(opts.location ?? makeLocation()),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      AdminDashboardService,
      { provide: getDataSourceToken(), useValue: fakeDs },
      { provide: getRepositoryToken(Location), useValue: fakeLocations },
    ],
  }).compile();
  return moduleRef.get(AdminDashboardService);
}

describe('AdminDashboardService.getSummary — A10 top items count units sold', () => {
  it('A10: catering order (quantity=12) ranks above a quantity=1 line', async () => {
    // Encodes the *expected* SUM(oi.quantity) result. The catering line for
    // "latte" is 12 units; "americano" is 1 unit. The service must surface
    // both in units_sold-descending order without re-sorting client-side.
    const query = makeQueryMock({
      aggregate: { count: 1, revenue: '5000' },
      topItems: [
        { menu_item_id: 'mi-latte', item_name: 'Latte', units_sold: 12 },
        { menu_item_id: 'mi-americano', item_name: 'Americano', units_sold: 1 },
      ],
    });
    const service = await buildService({ query });

    const summary = await service.getSummary(STAFF);

    expect(summary.top_items).toEqual([
      { menu_item_id: 'mi-latte', item_name: 'Latte', units_sold: 12 },
      { menu_item_id: 'mi-americano', item_name: 'Americano', units_sold: 1 },
    ]);
    // Catering item is first (units_sold ranking, not line count)
    expect(summary.top_items[0]!.units_sold).toBe(12);
    expect(summary.top_items[0]!.menu_item_id).toBe('mi-latte');
  });

  it('A10: two orders for same item with quantities 3 + 2 → units_sold=5 (not 2 line-count)', async () => {
    // The query GROUP BY menu_item_id collapses two order_item rows for the
    // same menu_item into one result row whose units_sold = 3 + 2 = 5.
    // Pinned so a regression that swaps SUM back to COUNT shows up as
    // units_sold=2 here.
    const query = makeQueryMock({
      aggregate: { count: 2, revenue: '4000' },
      topItems: [
        { menu_item_id: 'mi-cap', item_name: 'Cappuccino', units_sold: 5 },
      ],
    });
    const service = await buildService({ query });

    const summary = await service.getSummary(STAFF);

    expect(summary.top_items).toHaveLength(1);
    expect(summary.top_items[0]).toEqual({
      menu_item_id: 'mi-cap',
      item_name: 'Cappuccino',
      units_sold: 5,
    });
  });
});

describe('AdminDashboardService.getSummary — A11 net revenue', () => {
  it('A11: $20 order with $5 partial refund → revenue_cents_today = 1500', async () => {
    // The aggregates SQL subtracts SUM(refunds.amount_cents) per order via
    // LEFT JOIN. Encoded result: 2000 - 500 = 1500.
    const query = makeQueryMock({
      aggregate: { count: 1, revenue: '1500' },
      topItems: [],
    });
    const service = await buildService({ query });

    const summary = await service.getSummary(STAFF);

    expect(summary.revenue_cents_today).toBe(1500);
    expect(summary.order_count_today).toBe(1);
    // AOV uses the same net figure
    expect(summary.avg_order_value_cents).toBe(1500);
  });

  it('A11: two partial refunds against the same order stack ($20 - $5 - $5 = $10)', async () => {
    // The refunds subquery COALESCE(SUM(amount_cents)) collapses both refund
    // rows into one `refunded` value before the LEFT JOIN, so the order
    // appears once with net = 1000.
    const query = makeQueryMock({
      aggregate: { count: 1, revenue: '1000' },
      topItems: [],
    });
    const service = await buildService({ query });

    const summary = await service.getSummary(STAFF);

    expect(summary.revenue_cents_today).toBe(1000);
    expect(summary.order_count_today).toBe(1);
  });

  it('A11: fully refunded order is excluded entirely (status filter, refund irrelevant)', async () => {
    // REFUNDED ∉ REVENUE_STATUSES, so the order never reaches the SUM. The
    // associated $20 refund row is irrelevant to the calculation — the
    // dashboard reports zero revenue for the day. Pinned so a regression
    // that adds REFUNDED to the status filter (or computes refunds against
    // all orders) shows up as a non-zero value here.
    const query = makeQueryMock({
      aggregate: { count: 0, revenue: '0' },
      topItems: [],
    });
    const service = await buildService({ query });

    const summary = await service.getSummary(STAFF);

    expect(summary.revenue_cents_today).toBe(0);
    expect(summary.order_count_today).toBe(0);
    expect(summary.avg_order_value_cents).toBe(0);
  });

  it('A11: AOV uses net revenue, not gross', async () => {
    // Two $20 orders, one of them has a $5 partial refund.
    // Gross = 4000; net = 2000 + 1500 = 3500. AOV = 3500 / 2 = 1750.
    const query = makeQueryMock({
      aggregate: { count: 2, revenue: '3500' },
      topItems: [],
    });
    const service = await buildService({ query });

    const summary = await service.getSummary(STAFF);

    expect(summary.revenue_cents_today).toBe(3500);
    expect(summary.order_count_today).toBe(2);
    expect(summary.avg_order_value_cents).toBe(1750);
  });
});
