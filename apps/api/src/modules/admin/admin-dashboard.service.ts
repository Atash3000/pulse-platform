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
  top_items: Array<{ menu_item_id: string; item_name: string; order_count: number }>;
  new_customers_today: number;
}

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

    // ---- Aggregates: order count + revenue + AOV ----
    const [{ count, revenue }] = (await this.ds.query(
      `
      SELECT
        COUNT(*)::int                                  AS count,
        COALESCE(SUM(total_cents), 0)::bigint          AS revenue
      FROM orders
      WHERE location_id = $1
        AND created_at >= $2
        AND order_status = ANY($3)
      `,
      [staff.location_id, todayStart, REVENUE_STATUSES],
    )) as Array<{ count: number; revenue: string }>;

    const orderCount = Number(count);
    const revenueCents = Number(revenue);
    const aov = orderCount > 0 ? Math.round(revenueCents / orderCount) : 0;

    // ---- Top 3 menu items by line count ----
    const topItems = (await this.ds.query(
      `
      SELECT oi.menu_item_id, oi.item_name, COUNT(*)::int AS order_count
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.location_id = $1
        AND o.created_at >= $2
        AND o.order_status = ANY($3)
      GROUP BY oi.menu_item_id, oi.item_name
      ORDER BY order_count DESC, oi.item_name ASC
      LIMIT 3
      `,
      [staff.location_id, todayStart, REVENUE_STATUSES],
    )) as Array<{ menu_item_id: string; item_name: string; order_count: number }>;

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
        order_count: Number(t.order_count),
      })),
      new_customers_today: Number(new_customers),
    };
  }
}
