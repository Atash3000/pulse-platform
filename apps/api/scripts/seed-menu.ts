/**
 * seed-menu.ts
 *
 * Idempotent menu seed for the dev-seeded location. Creates three
 * categories (Matcha, Classic Coffee, Food) and their items; safe to
 * run multiple times.
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
 * Re-seed does NOT sweep obsolete catalog rows. Categories and items
 * that existed before but aren't in the v4 catalog stay in the DB with
 * active=true (e.g. the old single "Coffee" category that the pre-v4
 * seed created, plus its Macchiato / Hot Chocolate / Drip Coffee /
 * Mocha / Vanilla Latte rows). A dev DB seeded by the old script will
 * therefore show four categories after re-seed (old Coffee + Matcha +
 * Classic Coffee + Food). To get a clean v4 menu, drop and re-seed:
 * `npm run db:reset && npm run seed:dev && npm run seed:menu`. Mirrors
 * the modifier-group "manual cleanup if the catalog shrinks" policy
 * below.
 *
 * Catalog shape
 * --------------
 * Three categories: Matcha (spotlight), Classic Coffee (list), Food
 * (list). Each item carries its temperature, featured flag, and an
 * opaque art_token the iOS app maps to a drawn abstract symbol.
 * Modifier groups (Size / Milk / Extras / Sweetness) are seeded per
 * item — see Task 5 in
 * docs/superpowers/plans/2026-05-27-pulse-menu-v4-backend.md.
 */

import 'reflect-metadata';
import { AppDataSource } from '../src/database/data-source';
import {
  CategoryDisplayStyle,
  Inventory,
  Location,
  MenuCategory,
  MenuItem,
  Modifier,
  ModifierGroup,
  Temperature,
} from '../src/database/entities';

// The seed-dev location name. If the user renames the location row in
// the DB by hand, this lookup will miss and the seed will tell them
// (rather than silently creating menu data orphaned from any location).
const LOCATION_NAME = 'Pulse Coffee — Main St';

type ArtToken =
  | 'strawberry-matcha' | 'raspberry-matcha' | 'brown-sugar-matcha' | 'ginger-matcha'
  | 'cappuccino' | 'latte' | 'americano' | 'flat-white' | 'cortado' | 'cold-brew' | 'espresso'
  | 'croissant' | 'khachapuri' | 'muffin' | 'cookie';

interface SeedItem {
  name: string;
  description: string;
  base_price_cents: number;
  temperature: 'hot' | 'iced' | 'both';
  featured: boolean;
  art_token: ArtToken;
}

interface SeedCategory {
  name: string;
  sort_order: number;
  display_style: 'spotlight' | 'list';
  items: ReadonlyArray<SeedItem>;
}

// ---------------------------------------------------------------------
// Modifier-group catalog
// ---------------------------------------------------------------------
//
// Items reference groups by symbolic name. The actual ModifierGroup +
// Modifier rows live PER ITEM (one row per item × group), so each
// drink's required Milk choice is independent — matches the existing
// schema in entities.ts (modifier_groups.item_id is a FK to a single
// MenuItem).
//
// Sort order = the order the GROUPS render on the detail screen.
// Within a group, modifiers render by their per-modifier sort_order.
// For a required single-select group, iOS pre-selects the lowest
// sort_order option as the default — keep the "Whole" / "12 oz" /
// "Regular" options at sort_order 0 so the default is sensible.

type GroupName = 'Size' | 'Milk' | 'Extras' | 'Sweetness';

interface ModifierSpec {
  name: string;
  price_cents: number;
  sort_order: number;
}

interface GroupSpec {
  required: boolean;
  multi_select: boolean;
  sort_order: number;
  modifiers: ReadonlyArray<ModifierSpec>;
}

const SIZE_STANDARD: GroupSpec = {
  required: true,
  multi_select: false,
  sort_order: 0,
  modifiers: [
    { name: '12 oz', price_cents: 0,  sort_order: 0 },
    { name: '16 oz', price_cents: 60, sort_order: 1 },
  ],
};

const MILK: GroupSpec = {
  required: true,
  multi_select: false,
  sort_order: 1,
  modifiers: [
    { name: 'Whole',       price_cents: 0,  sort_order: 0 },
    { name: '2%',          price_cents: 0,  sort_order: 1 },
    { name: 'Skim',        price_cents: 0,  sort_order: 2 },
    { name: 'Half & Half', price_cents: 0,  sort_order: 3 },
    { name: 'Oat',         price_cents: 75, sort_order: 4 },
    { name: 'Almond',      price_cents: 75, sort_order: 5 },
    { name: 'Coconut',     price_cents: 75, sort_order: 6 },
    { name: 'Soy',         price_cents: 75, sort_order: 7 },
  ],
};

const SWEETNESS: GroupSpec = {
  required: false,
  multi_select: false,
  sort_order: 3,
  modifiers: [
    { name: 'Regular',     price_cents: 0, sort_order: 0 },
    { name: 'Half',        price_cents: 0, sort_order: 1 },
    { name: 'Unsweetened', price_cents: 0, sort_order: 2 },
  ],
};

const EXTRAS_ESPRESSO: GroupSpec = {
  required: false,
  multi_select: true,
  sort_order: 2,
  modifiers: [
    { name: 'Add espresso shot', price_cents: 100, sort_order: 0 },
  ],
};

const EXTRAS_MATCHA: GroupSpec = {
  required: false,
  multi_select: true,
  sort_order: 2,
  modifiers: [
    { name: 'Add matcha shot', price_cents: 100, sort_order: 0 },
  ],
};

/**
 * Resolves the modifier groups that apply to a given seed item.
 * - Size:      standard drinks only (excludes fixed-size Flat White, Cortado, Espresso).
 * - Milk:      milk drinks only (excludes Americano, Cold Brew, Espresso).
 * - Extras:    matcha drinks get the matcha-shot toggle, all other drinks get espresso-shot.
 * - Sweetness: all drinks.
 *
 * Food items get NO modifier groups (no required choices → smart-add
 * via "+" works inline; see iOS spec §5.1).
 */
function groupsForItem(seedCategoryName: string, seed: SeedItem): Array<{ name: GroupName; spec: GroupSpec }> {
  if (seedCategoryName === 'Food') return [];

  const FIXED_SIZE = new Set(['Flat White', 'Cortado', 'Espresso']);
  const BLACK = new Set(['Americano', 'Cold Brew', 'Espresso']);
  const isMatcha = seedCategoryName === 'Matcha';

  const groups: Array<{ name: GroupName; spec: GroupSpec }> = [];
  if (!FIXED_SIZE.has(seed.name)) groups.push({ name: 'Size', spec: SIZE_STANDARD });
  if (!BLACK.has(seed.name))      groups.push({ name: 'Milk', spec: MILK });
  groups.push({ name: 'Extras',    spec: isMatcha ? EXTRAS_MATCHA : EXTRAS_ESPRESSO });
  groups.push({ name: 'Sweetness', spec: SWEETNESS });
  return groups;
}

/**
 * Idempotent upsert of one item's modifier groups + modifiers.
 *
 * Group natural key: (item_id, name). Modifier natural key: (group_id,
 * name). Updates the row in place on hit; inserts on miss. Does NOT
 * delete groups/modifiers that exist in the DB but not in the seed
 * (out of scope — manual cleanup if the catalog shrinks).
 *
 * The `active` flag on existing modifiers is intentionally LEFT ALONE
 * on re-seed (mirrors the inventory-left-alone safety in the file
 * header) so an admin can deactivate a modifier (e.g. "we're out of
 * Oat Milk") without `npm run seed:menu` silently re-enabling it.
 * New modifiers still default to active=true on insert.
 */
async function upsertModifierGroups(
  em: import('typeorm').EntityManager,
  itemId: string,
  groups: ReadonlyArray<{ name: GroupName; spec: GroupSpec }>,
  totals: Counts,
): Promise<void> {
  const groupRepo = em.getRepository(ModifierGroup);
  const modifierRepo = em.getRepository(Modifier);

  for (const { name, spec } of groups) {
    let group = await groupRepo.findOne({ where: { item_id: itemId, name } });
    if (group) {
      group.required = spec.required;
      group.multi_select = spec.multi_select;
      group.sort_order = spec.sort_order;
      group = await groupRepo.save(group);
      totals.modifier_groups_updated += 1;
    } else {
      group = await groupRepo.save(
        groupRepo.create({
          item_id: itemId,
          name,
          required: spec.required,
          multi_select: spec.multi_select,
          sort_order: spec.sort_order,
        }),
      );
      totals.modifier_groups_inserted += 1;
    }

    for (const mod of spec.modifiers) {
      const existing = await modifierRepo.findOne({ where: { group_id: group.id, name: mod.name } });
      if (existing) {
        existing.price_cents = mod.price_cents;
        existing.sort_order = mod.sort_order;
        // active is intentionally NOT reset — match the inventory-left-alone
        // precedent at the top of this file: a re-seed must not overwrite
        // operator-managed state (e.g. "Oat Milk is sold out this week").
        // New modifiers still default to active=true in the insert branch.
        await modifierRepo.save(existing);
        totals.modifiers_updated += 1;
      } else {
        await modifierRepo.save(
          modifierRepo.create({
            group_id: group.id,
            name: mod.name,
            price_cents: mod.price_cents,
            sort_order: mod.sort_order,
            active: true,
            clover_mod_id: null,
          }),
        );
        totals.modifiers_inserted += 1;
      }
    }
  }
}

// Three-category v4 catalog. Prices in cents (Golden Rule #7). Featured
// flag is the spotlight hero pick — only one per spotlight category.
const CATEGORIES: ReadonlyArray<SeedCategory> = [
  {
    name: 'Matcha',
    sort_order: 0,
    display_style: 'spotlight',
    items: [
      { name: 'Strawberry Matcha', description: 'Matcha, oat milk, strawberry purée.', base_price_cents: 645, temperature: 'iced', featured: true,  art_token: 'strawberry-matcha' },
      { name: 'Raspberry Matcha',  description: 'Matcha, oat milk, raspberry.',         base_price_cents: 645, temperature: 'iced', featured: false, art_token: 'raspberry-matcha' },
      { name: 'Brown Sugar Matcha',description: 'Matcha, oat milk, brown sugar.',       base_price_cents: 675, temperature: 'iced', featured: false, art_token: 'brown-sugar-matcha' },
      { name: 'Ginger Matcha',     description: 'Matcha, oat milk, ginger.',            base_price_cents: 675, temperature: 'iced', featured: false, art_token: 'ginger-matcha' },
    ],
  },
  {
    name: 'Classic Coffee',
    sort_order: 1,
    display_style: 'list',
    items: [
      { name: 'Cappuccino', description: 'Double shot, steamed milk, foam crown.',    base_price_cents: 525, temperature: 'both', featured: false, art_token: 'cappuccino' },
      { name: 'Latte',      description: 'Espresso, steamed milk, light foam.',       base_price_cents: 550, temperature: 'both', featured: false, art_token: 'latte' },
      { name: 'Americano',  description: 'Two shots espresso, hot water.',            base_price_cents: 450, temperature: 'both', featured: false, art_token: 'americano' },
      { name: 'Flat White', description: 'Double shot, microfoam. 8 oz.',             base_price_cents: 525, temperature: 'hot',  featured: false, art_token: 'flat-white' },
      { name: 'Cortado',    description: 'Equal parts espresso and steamed milk. 8 oz.', base_price_cents: 475, temperature: 'hot',  featured: false, art_token: 'cortado' },
      { name: 'Cold Brew',  description: '18-hour slow brew, smooth.',                base_price_cents: 550, temperature: 'iced', featured: false, art_token: 'cold-brew' },
      { name: 'Espresso',   description: 'Double shot of our house blend. 4 oz.',     base_price_cents: 350, temperature: 'hot',  featured: false, art_token: 'espresso' },
    ],
  },
  {
    name: 'Food',
    sort_order: 2,
    display_style: 'list',
    items: [
      { name: 'Butter Croissant',  description: 'Flaky, French butter, warm.',           base_price_cents: 450, temperature: 'both', featured: false, art_token: 'croissant' },
      { name: 'Mini Khachapuri',   description: 'Georgian cheese bread.',                base_price_cents: 800, temperature: 'both', featured: false, art_token: 'khachapuri' },
      { name: 'Blueberry Muffin',  description: 'Fresh-baked, gluten-free option.',      base_price_cents: 375, temperature: 'both', featured: false, art_token: 'muffin' },
      { name: 'Chocolate Cookie',  description: 'Dark chocolate, sea salt.',             base_price_cents: 325, temperature: 'both', featured: false, art_token: 'cookie' },
    ],
  },
];

interface Counts {
  categories_inserted: number;
  categories_updated: number;
  items_inserted: number;
  items_updated: number;
  inventory_inserted: number;
  inventory_left_alone: number;
  modifier_groups_inserted: number;
  modifier_groups_updated: number;
  modifiers_inserted: number;
  modifiers_updated: number;
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
    modifier_groups_inserted: 0,
    modifier_groups_updated: 0,
    modifiers_inserted: 0,
    modifiers_updated: 0,
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

    // ---- 2. Upsert categories + items + inventory ----
    const categoryRepo = em.getRepository(MenuCategory);
    const itemRepo = em.getRepository(MenuItem);
    const inventoryRepo = em.getRepository(Inventory);

    for (const seedCategory of CATEGORIES) {
      // Category upsert — natural key (location_id, name).
      let category = await categoryRepo.findOne({
        where: { location_id: location.id, name: seedCategory.name },
      });
      if (category) {
        category.sort_order = seedCategory.sort_order;
        category.display_style = seedCategory.display_style as CategoryDisplayStyle;
        category.active = true;
        category = await categoryRepo.save(category);
        totals.categories_updated += 1;
      } else {
        category = await categoryRepo.save(
          categoryRepo.create({
            location_id: location.id,
            name: seedCategory.name,
            sort_order: seedCategory.sort_order,
            display_style: seedCategory.display_style as CategoryDisplayStyle,
            active: true,
          }),
        );
        totals.categories_inserted += 1;
      }

      for (const seed of seedCategory.items) {
        // Item upsert — natural key (category_id, name).
        let item = await itemRepo.findOne({
          where: { category_id: category.id, name: seed.name },
        });
        if (item) {
          item.description = seed.description;
          item.base_price_cents = seed.base_price_cents;
          item.temperature = seed.temperature as Temperature;
          item.featured = seed.featured;
          item.art_token = seed.art_token;
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
              temperature: seed.temperature as Temperature,
              featured: seed.featured,
              art_token: seed.art_token,
              active: true,
            }),
          );
          totals.items_inserted += 1;
        }

        // Inventory: insert if missing, otherwise leave alone (barista
        // sold-out flags must NOT be overwritten by a re-seed).
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

        await upsertModifierGroups(em, item.id, groupsForItem(seedCategory.name, seed), totals);
      }
    }
  });

  console.log(
    `seed:menu complete:\n` +
      `  categories      — inserted=${totals.categories_inserted} updated=${totals.categories_updated}\n` +
      `  items           — inserted=${totals.items_inserted} updated=${totals.items_updated}\n` +
      `  modifier groups — inserted=${totals.modifier_groups_inserted} updated=${totals.modifier_groups_updated}\n` +
      `  modifiers       — inserted=${totals.modifiers_inserted} updated=${totals.modifiers_updated}\n` +
      `  inventory       — inserted=${totals.inventory_inserted} left_alone=${totals.inventory_left_alone}`,
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
