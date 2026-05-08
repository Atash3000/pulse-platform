import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

import { REDIS_CLIENT } from '../health/redis.token';

// 10 minutes — matches the spec's "Menu cache (10min TTL)" line in 2.2.
export const MENU_TTL_SECONDS = 600;

const FULL_KEY = (locationId: string) => `menu:full:${locationId}`;
const ITEM_KEY = (itemId: string) => `menu:item:${itemId}`;
const ITEMS_BY_LOC_KEY = (locationId: string) => `menu:items:loc:${locationId}`;

/**
 * Two-layer Redis cache for the public menu.
 *
 *   L1 — full menu blob:   menu:full:{locationId}
 *   L2 — single item blob: menu:item:{itemId}
 *
 * A SET at `menu:items:loc:{locationId}` tracks which item-keys belong to
 * which location, so invalidateMenu(locationId) can drop both layers cleanly
 * without resorting to SCAN. (SCAN is O(N over the whole keyspace) and would
 * stutter under load.)
 *
 * Cache values are JSON. We keep "tombstone" semantics simple: if a key is
 * missing, callers fall back to Postgres and re-populate. Cache misses are
 * always survivable.
 */
@Injectable()
export class MenuCache {
  private readonly logger = new Logger(MenuCache.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  // ---- Layer 1: full menu --------------------------------------------------

  async getFullMenu<T>(locationId: string): Promise<T | null> {
    return this.readJson<T>(FULL_KEY(locationId));
  }

  async setFullMenu<T>(locationId: string, payload: T): Promise<void> {
    await this.writeJson(FULL_KEY(locationId), payload, MENU_TTL_SECONDS);
  }

  // ---- Layer 2: single item -----------------------------------------------

  async getItem<T>(itemId: string): Promise<T | null> {
    return this.readJson<T>(ITEM_KEY(itemId));
  }

  /**
   * Sets the item cache AND records the item under its location's tracking
   * set so we can find it again at invalidation time. Both ops in one pipeline.
   */
  async setItem<T>(locationId: string, itemId: string, payload: T): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.set(ITEM_KEY(itemId), JSON.stringify(payload), 'EX', MENU_TTL_SECONDS);
    pipeline.sadd(ITEMS_BY_LOC_KEY(locationId), itemId);
    pipeline.expire(ITEMS_BY_LOC_KEY(locationId), MENU_TTL_SECONDS);
    await pipeline.exec();
  }

  // ---- Invalidation -------------------------------------------------------

  /**
   * Drops the full-menu blob and every per-item blob for this location.
   *
   * Called by:
   *   - InventoryService when an item is toggled sold-out / available
   *   - MenuService when staff edits an item (Phase 2)
   *   - CloverMenuImportService after a successful import sync
   */
  async invalidateMenu(locationId: string): Promise<void> {
    const trackingKey = ITEMS_BY_LOC_KEY(locationId);
    const itemIds = await this.redis.smembers(trackingKey);

    const pipeline = this.redis.pipeline();
    pipeline.del(FULL_KEY(locationId));
    for (const itemId of itemIds) {
      pipeline.del(ITEM_KEY(itemId));
    }
    pipeline.del(trackingKey);
    await pipeline.exec();

    this.logger.log(
      `Invalidated menu cache for location=${locationId} (full + ${itemIds.length} items)`,
    );
  }

  // ---- helpers -----------------------------------------------------------

  private async readJson<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Corrupted entry — drop and treat as miss. Should never happen, but
      // we don't want one bad payload to wedge the cache layer.
      this.logger.warn(`Corrupted cache entry at ${key}; dropping`);
      await this.redis.del(key);
      return null;
    }
  }

  private async writeJson(key: string, payload: unknown, ttl: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(payload), 'EX', ttl);
  }
}
