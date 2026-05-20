/**
 * seed-menu.ts
 *
 * Idempotent menu seed for the dev-seeded location. Creates one Coffee
 * category and eight standard drinks; safe to run multiple times.
 *
 * Run with: npm run seed:menu
 *
 * Depends on seed:dev — looks up the location by name. If the seed:dev
 * location row doesn't exist, this script exits with a clear error.
 *
 * Idempotency strategy
 * --------------------
 * The menu_categories table has no UNIQUE constraint on (location_id,
 * name); menu_items has no UNIQUE on (category_id, name). The seed uses
 * the find-by-natural-key pattern from seed-dev-data.ts:
 *
 *   - Category: find by (location_id, name); update on hit, insert on miss.
 *   - Item:     find by (category_id, name); update on hit, insert on miss.
 *   - Inventory: insert ONLY if missing — never overwrites operator-
 *     managed state (a barista marked "Oat Milk Latte" sold out in the
 *     admin dashboard; re-running the seed must NOT un-sold-out them).
 *
 * If a dev DB has pre-existing duplicate categories (the iOS-Commit-A
 * bug), run cleanup:duplicate-categories first. This seed alone will
 * not detect or resolve duplicates — it picks the first match returned
 * by findOne, which is non-deterministic on a duplicated set.
 *
 * Why no modifier_groups
 * ----------------------
 * The schema supports modifier_groups (size, milk choice, etc.) but
 * Phase 1's menu surface is intentionally flat: "Oat Milk Latte" is a
 * separate item, not a "Latte + Oat Milk modifier" composition. This
 * matches the iOS app's flat-tile UX. A future seed:menu-modifiers
 * would land if/when the UX adds a customisation sheet.
 */

import 'reflect-metadata';
import { AppDataSource } from '../src/database/data-source';
import {
  Inventory,
  Location,
  MenuCategory,
  MenuItem,
} from '../src/database/entities';

// The seed-dev location name. If the user renames the location row in
// the DB by hand, this lookup will miss and the seed will tell them
// (rather than silently creating menu data orphaned from any location).
const LOCATION_NAME = 'Pulse Coffee — Main St';

const CATEGORY = {
  name: 'Coffee',
  sort_order: 0,
} as const;

// All eight items go in the Coffee category. Prices in cents.
// Standard NYC coffee-shop menu. Oat Milk Latte is a separate item
// (not a modifier of Latte) per the Phase 1 UX decision documented at
// the top of this file.
interface SeedItem {
  name: string;
  description: string;
  base_price_cents: number;
}

const ITEMS: ReadonlyArray<SeedItem> = [
  {
    name: 'Espresso',
    description: 'Double shot of our house blend, pulled to order.',
    base_price_cents: 350,
  },
  {
    name: 'Americano',
    description: 'Two shots espresso topped with hot water.',
    base_price_cents: 450,
  },
  {
    name: 'Macchiato',
    description: 'Espresso "marked" with a small dollop of foamed milk.',
    base_price_cents: 500,
  },
  {
    name: 'Cortado',
    description: 'Equal parts espresso and steamed milk.',
    base_price_cents: 500,
  },
  {
    name: 'Cappuccino',
    description: 'Espresso with steamed milk and a thick foam crown.',
    base_price_cents: 550,
  },
  {
    name: 'Cold Brew',
    description: 'Slow-steeped overnight, served over ice.',
    base_price_cents: 550,
  },
  {
    name: 'Latte',
    description: 'Espresso with steamed milk and a light foam layer.',
    base_price_cents: 650,
  },
  {
    name: 'Mocha',
    description: 'Espresso, steamed milk, and our chocolate sauce.',
    base_price_cents: 600,
  },
  {
    name: 'Oat Milk Latte',
    description: 'Our Latte with oat milk in place of dairy.',
    base_price_cents: 725,
  },
];

interface Counts {
  categories_inserted: number;
  categories_updated: number;
  items_inserted: number;
  items_updated: number;
  inventory_inserted: number;
  inventory_left_alone: number;
}

async function run(): Promise<void> {
  await AppDataSource.initialize();

  const totals: Counts = {
    categories_inserted: 0,
    categories_updated: 0,
    items_inserted: 0,
    items_updated: 0,
    inventory_inserted: 0,
    inventory_left_alone: 0,
  };

  await AppDataSource.transaction(async (em) => {
    // ---- 1. Find the seeded location -------------------------------------
    const locationRepo = em.getRepository(Location);
    const location = await locationRepo.findOne({ where: { name: LOCATION_NAME } });
    if (!location) {
      throw new Error(
        `seed:menu requires the seed-dev location "${LOCATION_NAME}" to exist. ` +
          `Run \`npm run seed:dev\` first.`,
      );
    }

    // ---- 2. Upsert the Coffee category -----------------------------------
    const categoryRepo = em.getRepository(MenuCategory);
    let category = await categoryRepo.findOne({
      where: { location_id: location.id, name: CATEGORY.name },
    });
    if (category) {
      category.sort_order = CATEGORY.sort_order;
      category.active = true;
      category = await categoryRepo.save(category);
      totals.categories_updated += 1;
    } else {
      category = await categoryRepo.save(
        categoryRepo.create({
          location_id: location.id,
          name: CATEGORY.name,
          sort_order: CATEGORY.sort_order,
          active: true,
        }),
      );
      totals.categories_inserted += 1;
    }

    // ---- 3. Upsert items -------------------------------------------------
    const itemRepo = em.getRepository(MenuItem);
    const inventoryRepo = em.getRepository(Inventory);

    for (const seed of ITEMS) {
      let item = await itemRepo.findOne({
        where: { category_id: category.id, name: seed.name },
      });
      if (item) {
        item.description = seed.description;
        item.base_price_cents = seed.base_price_cents;
        item.active = true;
        item = await itemRepo.save(item);
        totals.items_updated += 1;
      } else {
        item = await itemRepo.save(
          itemRepo.create({
            category_id: category.id,
            name: seed.name,
            description: seed.description,
            base_price_cents: seed.base_price_cents,
            active: true,
          }),
        );
        totals.items_inserted += 1;
      }

      // ---- 4. Inventory row: insert if missing, otherwise LEAVE ALONE ----
      // The (item_id, location_id) UNIQUE constraint on inventory makes
      // the existence check race-safe under the surrounding transaction.
      // We INTENTIONALLY do not update inventory.available — a barista
      // may have marked an item sold-out via the admin dashboard, and
      // re-running seed:menu must not undo their operational state.
      const existingInventory = await inventoryRepo.findOne({
        where: { item_id: item.id, location_id: location.id },
      });
      if (existingInventory) {
        totals.inventory_left_alone += 1;
      } else {
        await inventoryRepo.save(
          inventoryRepo.create({
            item_id: item.id,
            location_id: location.id,
            available: true,
            quantity_left: null,
            sold_out_at: null,
            updated_by: null,
          }),
        );
        totals.inventory_inserted += 1;
      }
    }
  });

  console.log(
    `seed:menu complete:\n` +
      `  categories — inserted=${totals.categories_inserted} updated=${totals.categories_updated}\n` +
      `  items      — inserted=${totals.items_inserted} updated=${totals.items_updated}\n` +
      `  inventory  — inserted=${totals.inventory_inserted} left_alone=${totals.inventory_left_alone}`,
  );
  console.log(
    `\nNote: the in-memory menu cache (Redis) is NOT invalidated by this script.\n` +
      `If the backend is running, restart it or wait for the cache TTL to expire\n` +
      `before GET /api/v1/menu reflects the new data.`,
  );

  await AppDataSource.destroy();
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('seed:menu FAILED:', err);
  process.exit(1);
});
