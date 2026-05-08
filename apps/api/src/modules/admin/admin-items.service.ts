import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import {
  Inventory,
  MenuCategory,
  MenuItem,
  OutboxEvent,
  OutboxEventType,
  OutboxStatus,
} from '../../database/entities';
import { MenuService } from '../menu/menu.service';
import { StaffContext } from './staff-context';

@Injectable()
export class AdminItemsService {
  private readonly logger = new Logger(AdminItemsService.name);

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(MenuItem) private readonly items: Repository<MenuItem>,
    @InjectRepository(MenuCategory)
    private readonly categories: Repository<MenuCategory>,
    @InjectRepository(Inventory)
    private readonly inventory: Repository<Inventory>,
    private readonly menu: MenuService,
  ) {}

  async markSoldOut(staff: StaffContext, itemId: string): Promise<Inventory> {
    return this.ds.transaction(async (em) => {
      await this.assertItemBelongsToStaffLocation(em, itemId, staff.location_id);

      // Upsert inventory row — some items may not have one yet.
      let inv = await em.findOne(Inventory, {
        where: { item_id: itemId, location_id: staff.location_id },
      });
      const now = new Date();
      if (!inv) {
        inv = em.create(Inventory, {
          item_id: itemId,
          location_id: staff.location_id,
          available: false,
          quantity_left: null,
          sold_out_at: now,
          updated_by: staff.staff_user_id,
        });
      } else {
        inv.available = false;
        inv.sold_out_at = now;
        inv.updated_by = staff.staff_user_id;
      }
      const saved = await em.save(inv);

      await em.insert(OutboxEvent, {
        event_type: OutboxEventType.ITEM_OUT_OF_STOCK,
        status: OutboxStatus.PENDING,
        payload: {
          itemId,
          locationId: staff.location_id,
          staffUserId: staff.staff_user_id,
          soldOutAt: now.toISOString(),
        },
      });

      this.logger.log(
        `item ${itemId} marked SOLD-OUT at location ${staff.location_id} by ${staff.staff_user_id}`,
      );
      return saved;
    }).then(async (saved) => {
      // Cache invalidation outside the DB transaction — Redis isn't transactional
      // with Postgres anyway, and we want the customer-visible change to land
      // even if the transaction's COMMIT happens slightly after our SET.
      await this.menu.invalidate(staff.location_id);
      return saved;
    });
  }

  async markAvailable(staff: StaffContext, itemId: string): Promise<Inventory> {
    return this.ds.transaction(async (em) => {
      await this.assertItemBelongsToStaffLocation(em, itemId, staff.location_id);

      let inv = await em.findOne(Inventory, {
        where: { item_id: itemId, location_id: staff.location_id },
      });
      if (!inv) {
        inv = em.create(Inventory, {
          item_id: itemId,
          location_id: staff.location_id,
          available: true,
          quantity_left: null,
          sold_out_at: null,
          updated_by: staff.staff_user_id,
        });
      } else {
        inv.available = true;
        inv.sold_out_at = null;
        inv.updated_by = staff.staff_user_id;
      }
      const saved = await em.save(inv);

      this.logger.log(
        `item ${itemId} restored AVAILABLE at location ${staff.location_id} by ${staff.staff_user_id}`,
      );
      return saved;
    }).then(async (saved) => {
      await this.menu.invalidate(staff.location_id);
      return saved;
    });
  }

  /**
   * The multi-tenant guard. A staff member must never be able to flip the
   * sold-out flag on an item that lives at a different location.
   */
  private async assertItemBelongsToStaffLocation(
    em: import('typeorm').EntityManager,
    itemId: string,
    locationId: string,
  ): Promise<void> {
    const item = await em.findOne(MenuItem, {
      where: { id: itemId },
      relations: { category: true },
    });
    if (!item || !item.category || item.category.location_id !== locationId) {
      throw new NotFoundException(`Item ${itemId} not found at this location`);
    }
  }
}
