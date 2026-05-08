import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  Inventory,
  Location,
  MenuCategory,
  MenuItem,
  Modifier,
  ModifierGroup,
} from '../../database/entities';
import { MenuCache } from './menu.cache';

// ---- Public response shapes --------------------------------------------------
// These are what iOS receives. They're deliberately flat and human-readable;
// PriceCalculation and "available" are precomputed so the client never does math
// or joins.

export interface PublicModifier {
  id: string;
  name: string;
  price_cents: number;
  sort_order: number;
}

export interface PublicModifierGroup {
  id: string;
  name: string;
  required: boolean;
  multi_select: boolean;
  sort_order: number;
  modifiers: PublicModifier[];
}

export interface PublicMenuItem {
  id: string;
  name: string;
  description: string | null;
  base_price_cents: number;
  image_url: string | null;
  available: boolean;       // composed from inventory.available + inventory.quantity_left
  quantity_left: number | null;
  modifier_groups: PublicModifierGroup[];
}

export interface PublicCategory {
  id: string;
  name: string;
  sort_order: number;
  items: PublicMenuItem[];
}

export interface PublicMenu {
  location_id: string;
  categories: PublicCategory[];
  cached_at: string;        // ISO timestamp; helps debug cache vs DB hits
}

@Injectable()
export class MenuService {
  private readonly logger = new Logger(MenuService.name);

  constructor(
    @InjectRepository(Location) private readonly locations: Repository<Location>,
    @InjectRepository(MenuCategory) private readonly categories: Repository<MenuCategory>,
    @InjectRepository(MenuItem) private readonly items: Repository<MenuItem>,
    @InjectRepository(ModifierGroup) private readonly groups: Repository<ModifierGroup>,
    @InjectRepository(Modifier) private readonly modifiers: Repository<Modifier>,
    @InjectRepository(Inventory) private readonly inventory: Repository<Inventory>,
    private readonly cache: MenuCache,
  ) {}

  // -------------------------------------------------------------------------
  // GET /menu — full tree, cached.
  // -------------------------------------------------------------------------

  async getMenu(locationId: string): Promise<PublicMenu> {
    const cached = await this.cache.getFullMenu<PublicMenu>(locationId);
    if (cached) {
      this.logger.debug(`menu cache HIT location=${locationId}`);
      return cached;
    }
    this.logger.debug(`menu cache MISS location=${locationId}`);

    const location = await this.locations.findOne({ where: { id: locationId } });
    if (!location || !location.active) {
      throw new NotFoundException(`Location ${locationId} not found`);
    }

    const fresh = await this.buildFullMenu(locationId);
    await this.cache.setFullMenu(locationId, fresh);
    return fresh;
  }

  // -------------------------------------------------------------------------
  // GET /menu/items/:id — single item with modifier groups, cached.
  // -------------------------------------------------------------------------

  async getItemById(itemId: string): Promise<PublicMenuItem & { location_id: string; category_id: string }> {
    const cached = await this.cache.getItem<PublicMenuItem & { location_id: string; category_id: string }>(itemId);
    if (cached) {
      this.logger.debug(`item cache HIT id=${itemId}`);
      return cached;
    }
    this.logger.debug(`item cache MISS id=${itemId}`);

    const item = await this.items.findOne({
      where: { id: itemId, active: true },
      relations: { category: true },
    });
    if (!item || !item.category) {
      throw new NotFoundException(`Item ${itemId} not found`);
    }
    const locationId = item.category.location_id;

    const [groups, inventoryRow] = await Promise.all([
      this.fetchModifierGroupsForItem(item.id),
      this.inventory.findOne({ where: { item_id: item.id, location_id: locationId } }),
    ]);

    const payload = {
      id: item.id,
      name: item.name,
      description: item.description,
      base_price_cents: item.base_price_cents,
      image_url: item.image_url,
      available: this.computeAvailable(inventoryRow),
      quantity_left: inventoryRow?.quantity_left ?? null,
      modifier_groups: groups,
      location_id: locationId,
      category_id: item.category_id,
    };

    await this.cache.setItem(locationId, item.id, payload);
    return payload;
  }

  // -------------------------------------------------------------------------
  // Cache invalidation surface — used by inventory toggles, menu edits, etc.
  // -------------------------------------------------------------------------

  invalidate(locationId: string): Promise<void> {
    return this.cache.invalidateMenu(locationId);
  }

  // -------------------------------------------------------------------------
  // Internal: full-menu loader. One round trip per table family — does NOT
  // join everything in one query because TypeORM's left-join projection blows
  // up array fields. Five small queries are simpler and faster.
  // -------------------------------------------------------------------------

  private async buildFullMenu(locationId: string): Promise<PublicMenu> {
    const categories = await this.categories.find({
      where: { location_id: locationId, active: true },
      order: { sort_order: 'ASC', name: 'ASC' },
    });
    if (categories.length === 0) {
      return { location_id: locationId, categories: [], cached_at: new Date().toISOString() };
    }

    const categoryIds = categories.map((c) => c.id);
    const items = await this.items
      .createQueryBuilder('i')
      .where('i.category_id IN (:...categoryIds)', { categoryIds })
      .andWhere('i.active = true')
      .orderBy('i.name', 'ASC')
      .getMany();

    const itemIds = items.map((i) => i.id);
    const [groups, inventoryRows] = await Promise.all([
      itemIds.length === 0
        ? Promise.resolve([] as ModifierGroup[])
        : this.groups
            .createQueryBuilder('g')
            .where('g.item_id IN (:...itemIds)', { itemIds })
            .orderBy('g.sort_order', 'ASC')
            .getMany(),
      itemIds.length === 0
        ? Promise.resolve([] as Inventory[])
        : this.inventory
            .createQueryBuilder('inv')
            .where('inv.item_id IN (:...itemIds)', { itemIds })
            .andWhere('inv.location_id = :locationId', { locationId })
            .getMany(),
    ]);

    const groupIds = groups.map((g) => g.id);
    const modifiers = groupIds.length === 0
      ? []
      : await this.modifiers
          .createQueryBuilder('m')
          .where('m.group_id IN (:...groupIds)', { groupIds })
          .andWhere('m.active = true')
          .orderBy('m.sort_order', 'ASC')
          .getMany();

    // ---- Index for assembly ----
    const inventoryByItem = new Map(inventoryRows.map((r) => [r.item_id, r]));
    const modifiersByGroup = new Map<string, Modifier[]>();
    for (const m of modifiers) {
      const arr = modifiersByGroup.get(m.group_id) ?? [];
      arr.push(m);
      modifiersByGroup.set(m.group_id, arr);
    }
    const groupsByItem = new Map<string, ModifierGroup[]>();
    for (const g of groups) {
      const arr = groupsByItem.get(g.item_id) ?? [];
      arr.push(g);
      groupsByItem.set(g.item_id, arr);
    }
    const itemsByCategory = new Map<string, MenuItem[]>();
    for (const it of items) {
      const arr = itemsByCategory.get(it.category_id) ?? [];
      arr.push(it);
      itemsByCategory.set(it.category_id, arr);
    }

    // ---- Compose ----
    return {
      location_id: locationId,
      cached_at: new Date().toISOString(),
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        sort_order: c.sort_order,
        items: (itemsByCategory.get(c.id) ?? []).map((it) => ({
          id: it.id,
          name: it.name,
          description: it.description,
          base_price_cents: it.base_price_cents,
          image_url: it.image_url,
          available: this.computeAvailable(inventoryByItem.get(it.id)),
          quantity_left: inventoryByItem.get(it.id)?.quantity_left ?? null,
          modifier_groups: (groupsByItem.get(it.id) ?? []).map((g) => ({
            id: g.id,
            name: g.name,
            required: g.required,
            multi_select: g.multi_select,
            sort_order: g.sort_order,
            modifiers: (modifiersByGroup.get(g.id) ?? []).map((m) => ({
              id: m.id,
              name: m.name,
              price_cents: m.price_cents,
              sort_order: m.sort_order,
            })),
          })),
        })),
      })),
    };
  }

  private async fetchModifierGroupsForItem(itemId: string): Promise<PublicModifierGroup[]> {
    const groups = await this.groups.find({
      where: { item_id: itemId },
      order: { sort_order: 'ASC' },
    });
    if (groups.length === 0) return [];

    const groupIds = groups.map((g) => g.id);
    const modifiers = await this.modifiers
      .createQueryBuilder('m')
      .where('m.group_id IN (:...groupIds)', { groupIds })
      .andWhere('m.active = true')
      .orderBy('m.sort_order', 'ASC')
      .getMany();

    const byGroup = new Map<string, Modifier[]>();
    for (const m of modifiers) {
      const arr = byGroup.get(m.group_id) ?? [];
      arr.push(m);
      byGroup.set(m.group_id, arr);
    }

    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      required: g.required,
      multi_select: g.multi_select,
      sort_order: g.sort_order,
      modifiers: (byGroup.get(g.id) ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        price_cents: m.price_cents,
        sort_order: m.sort_order,
      })),
    }));
  }

  /**
   * An item is available when its inventory row exists, available=true, and
   * (quantity_left is null OR quantity_left > 0). Missing inventory row is
   * treated as available — locations that don't track inventory still sell.
   */
  private computeAvailable(inv: Inventory | null | undefined): boolean {
    if (!inv) return true;
    if (!inv.available) return false;
    if (inv.quantity_left !== null && inv.quantity_left <= 0) return false;
    return true;
  }
}
