import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { OrderItem, PaymentStatus } from '../../database/entities';
import { HomeSummaryResponse, ReorderSignature } from './home.types';

/** Most recent paid order-items scanned per customer. A customer's lifetime
 *  item count is tiny at MVP scale; 200 is generous headroom and bounds the
 *  in-memory aggregation. */
const MAX_ITEMS = 200;
/** Configs surfaced in the "Order again" row, after `usual`. */
const RECENT_LIMIT = 4;

interface Bucket {
  menuItemId: string;
  modifierIds: string[]; // normalized (sorted)
  quantity: number; // from the most-recent occurrence
  lastUnitPriceCents: number;
  lastAt: number; // epoch ms of most-recent occurrence
  frequency: number;
}

@Injectable()
export class HomeService {
  constructor(
    @InjectRepository(OrderItem)
    private readonly orderItems: Repository<OrderItem>,
  ) {}

  async getHomeSummary(customerId: string): Promise<HomeSummaryResponse> {
    const items = await this.orderItems
      .createQueryBuilder('oi')
      .innerJoinAndSelect('oi.order', 'o')
      .where('o.customer_id = :cid', { cid: customerId })
      .andWhere('o.payment_status = :paid', { paid: PaymentStatus.SUCCEEDED })
      .orderBy('o.created_at', 'DESC')
      .take(MAX_ITEMS)
      .getMany();

    const buckets = new Map<string, Bucket>();
    for (const it of items) {
      const modifierIds = (it.modifiers ?? []).map((m) => m.modifierId).sort();
      const key = `${it.menu_item_id}|${modifierIds.join(',')}`;
      const at = it.order.created_at.getTime();
      const existing = buckets.get(key);
      if (existing) {
        existing.frequency += 1;
        // Price/quantity come from the most-recent occurrence. Compare by
        // timestamp rather than array position so the aggregation is correct
        // regardless of the order rows arrive in.
        if (at > existing.lastAt) {
          existing.lastAt = at;
          existing.quantity = it.quantity;
          existing.lastUnitPriceCents = it.unit_price_cents;
        }
      } else {
        buckets.set(key, {
          menuItemId: it.menu_item_id,
          modifierIds,
          quantity: it.quantity,
          lastUnitPriceCents: it.unit_price_cents,
          lastAt: at,
          frequency: 1,
        });
      }
    }

    const ranked = [...buckets.values()].sort(
      (a, b) => b.frequency - a.frequency || b.lastAt - a.lastAt,
    );

    const toSignature = (b: Bucket): ReorderSignature => ({
      menuItemId: b.menuItemId,
      modifierIds: b.modifierIds,
      quantity: b.quantity,
      lastUnitPriceCents: b.lastUnitPriceCents,
    });

    return {
      usual: ranked.length ? toSignature(ranked[0]) : null,
      recent: ranked.slice(1, 1 + RECENT_LIMIT).map(toSignature),
    };
  }
}
