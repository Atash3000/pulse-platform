import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { Location } from '../../database/entities';
import { StaffContext } from './staff-context';

const REVENUE_STATUSES = ['PAID', 'ACCEPTED', 'IN_PROGRESS', 'READY', 'PICKED_UP'];

export interface OwnerDashboardSummary {
  location_id: string;
  location_name: string;
  timezone: string;
  /** Local-day boundary (midnight in the location's timezone), as UTC ISO. */
  today_start_utc: string;
  order_count_today: number;
  revenue_cents_today: number;
  avg_order_value_cents: number;
  top_items: Array<{
    menu_item_id: string;
    item_name: string;
    /**
     * Total quantity of this item sold today (sum of order_items.quantity, not
     * number of orders containing the item). A single order with quantity=8
     * contributes 8 units, not 1. See decision-log entry "Dashboard
     * arithmetic: net revenue and unit sales semantics" for why catering and
     * office orders make the line-count answer wrong.
     */
    units_sold: number;
  }>;
  new_customers_today: number;
}

/**
 * Owner-facing dashboard aggregator.
 *
 * Read-only — owns no state, mutates no rows. Every call recomputes from the
 * canonical tables (`orders`, `order_items`, `refunds`, `customers`).
 *
 * `getSummary()` is timezone-aware: "today" is midnight-to-now in the
 * location's IANA timezone (`Location.timezone`, default `America/New_York`).
 * The local-midnight boundary is computed in Postgres via
 * `date_trunc('day', NOW() AT TIME ZONE $tz) AT TIME ZONE $tz`; the inline
 * comment in `getSummary()` explains the round-trip.
 *
 * Revenue (post-A11) is **net of partial refunds** — for each order in the
 * window we subtract the SUM of its `refunds.amount_cents` rows. Fully
 * refunded orders are excluded entirely by the `order_status` filter
 * (REFUNDED is not in `REVENUE_STATUSES`), so the subtraction only ever
 * applies to partials. Average order value (`avg_order_value_cents`) is
 * computed from this net figure, not from gross.
 *
 * `top_items.units_sold` (post-A10) counts **units, not orders**: a single
 * order with `quantity=8` contributes 8 to its item's ranking, not 1. The
 * previous COUNT(*) shape reported "number of order_items rows containing
 * this menu item", which mis-ranked catering orders.
 *
 * **Cross-day refund limitation (deliberate Phase 1 simplification):**
 * partial refunds issued today against an order created yesterday do NOT
 * reduce yesterday's revenue retroactively, and do NOT show up in today's
 * revenue (the order isn't in today's window at all). Same-day refunds —
 * the common case for a coffee shop — are handled correctly. Cross-day
 * refunds are a Phase 2 concern that would warrant a separate
 * "transactions today" report card. See decision-log entry "Dashboard
 * arithmetic: net revenue and unit sales semantics".
 */
@Injectable()
export class AdminDashboardService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(Location) private readonly locations: Repository<Location>,
  ) {}

  async getSummary(staff: StaffContext): Promise<OwnerDashboardSummary> {
    const location = await this.locations.findOne({ where: { id: staff.location_id } });
    if (!location) {
      throw new NotFoundException(`Location ${staff.location_id} not found`);
    }
    const tz = location.timezone || 'America/New_York';

    // Postgres handles the timezone math: midnight-in-tz, expressed as UTC.
    // date_trunc('day', NOW() AT TIME ZONE $tz) AT TIME ZONE $tz = the UTC instant
    // corresponding to local midnight. Pass tz twice — once to shift NOW() into
    // local, once to shift the truncated-local timestamp back to UTC.
    const [{ today_start: todayStart }] = (await this.ds.query(
      `SELECT (date_trunc('day', NOW() AT TIME ZONE $1) AT TIME ZONE $1) AS today_start`,
      [tz],
    )) as Array<{ today_start: Date }>;

    // ---- Aggregates: order count + net revenue + AOV ----
    //
    // Revenue is net of partial refunds. Fully refunded orders are excluded
    // by the order_status filter (REFUNDED is not in REVENUE_STATUSES);
    // partial refunds are subtracted via the refunds LEFT JOIN. The subquery
    // pre-aggregates refunds per order so the join can't multiply rows —
    // COUNT(*) over `o` therefore stays a clean order count.
    const [{ count, revenue }] = (await this.ds.query(
      `
      SELECT
        COUNT(*)::int                                                          AS count,
        COALESCE(SUM(o.total_cents - COALESCE(r.refunded, 0)), 0)::bigint      AS revenue
      FROM orders o
      LEFT JOIN (
        SELECT order_id, COALESCE(SUM(amount_cents), 0) AS refunded
        FROM refunds
        GROUP BY order_id
      ) r ON r.order_id = o.id
      WHERE o.location_id = $1
        AND o.created_at >= $2
        AND o.order_status = ANY($3)
      `,
      [staff.location_id, todayStart, REVENUE_STATUSES],
    )) as Array<{ count: number; revenue: string }>;

    const orderCount = Number(count);
    const revenueCents = Number(revenue);
    const aov = orderCount > 0 ? Math.round(revenueCents / orderCount) : 0;

    // ---- Top 3 menu items by units sold ----
    //
    // SUM(oi.quantity), not COUNT(*). A catering order with quantity=12 of
    // one drink should rank above twelve separate orders of one different
    // drink each — the previous line-count answer ranked them equal.
    const topItems = (await this.ds.query(
      `
      SELECT oi.menu_item_id, oi.item_name, SUM(oi.quantity)::int AS units_sold
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.location_id = $1
        AND o.created_at >= $2
        AND o.order_status = ANY($3)
      GROUP BY oi.menu_item_id, oi.item_name
      ORDER BY units_sold DESC, oi.item_name ASC
      LIMIT 3
      `,
      [staff.location_id, todayStart, REVENUE_STATUSES],
    )) as Array<{ menu_item_id: string; item_name: string; units_sold: number }>;

    // ---- New customers (created_at >= today_start). Customers aren't location-
    // scoped in the schema; report platform-wide new customers for this owner's
    // dashboard. Phase 2 can introduce location attribution if needed. ----
    const [{ new_customers }] = (await this.ds.query(
      `SELECT COUNT(*)::int AS new_customers FROM customers WHERE created_at >= $1`,
      [todayStart],
    )) as Array<{ new_customers: number }>;

    return {
      location_id: location.id,
      location_name: location.name,
      timezone: tz,
      today_start_utc: new Date(todayStart).toISOString(),
      order_count_today: orderCount,
      revenue_cents_today: revenueCents,
      avg_order_value_cents: aov,
      top_items: topItems.map((t) => ({
        menu_item_id: t.menu_item_id,
        item_name: t.item_name,
        units_sold: Number(t.units_sold),
      })),
      new_customers_today: Number(new_customers),
    };
  }
}
