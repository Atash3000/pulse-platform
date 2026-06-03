/**
 * seed-menu.ts
 *
 * Idempotent menu seed for the dev-seeded location. Creates three
 * categories (Matcha, Coffee, Food) and their items; safe to
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
 * Coffee + Food). To get a clean v4 menu, wipe the Postgres
 * volume and re-seed from scratch:
 *
 *   docker compose down -v
 *   docker compose up -d postgres redis
 *   npm run migration:run
 *   npm run seed:dev
 *   npm run seed:menu
 *
 * Mirrors the modifier-group "manual cleanup if the catalog shrinks"
 * policy below.
 *
 * Catalog shape
 * --------------
 * Three categories: Matcha (spotlight), Coffee (list), Food
 * (list). Each item carries its temperature, featured flag, and an
 * opaque art_token the iOS app maps to a drawn abstract symbol.
 * Modifier groups (Size / Milk / Sweetness / Extras) are seeded per
 * item — see Task 5 in
 * docs/superpowers/plans/2026-05-29-product-detail-v2-backend.md.
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
  | 'iced-classic-matcha' | 'vanilla-matcha' | 'blueberry-matcha'
  | 'cappuccino' | 'latte' | 'americano' | 'flat-white' | 'cortado' | 'cold-brew' | 'espresso'
  | 'iced-coconut-latte' | 'iced-salted-caramel-latte' | 'iced-brown-sugar-oat-latte' | 'iced-vanilla-latte'
  | 'croissant' | 'khachapuri' | 'muffin' | 'cookie'
  | 'pain-au-chocolat' | 'cinnamon-roll' | 'everything-bagel';

interface SeedItem {
  name: string;
  description: string;
  base_price_cents: number;
  temperature: 'hot' | 'iced' | 'both';
  featured: boolean;
  art_token: ArtToken;
  sort_order?: number;
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
// For a required single-select group, iOS resolves the default to the
// cheapest option (lowest price_cents, tie-break sort_order) — NOT
// sort_order 0. So Milk renders Oat first (sort_order 0) yet defaults
// to Whole (0¢). Size "12 oz" is both first and free, so it coincides.

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
    // Curated display order — sort_order IS the order iOS renders (no runtime
    // sort). Default resolves to the cheapest option (Whole, 0¢) via the iOS
    // cheapest-option rule. Dairy = 0¢; alt-milks (Oat/Almond) = +75¢.
    { name: 'Whole',       price_cents: 0,  sort_order: 0 },
    { name: 'Oat',         price_cents: 75, sort_order: 1 },
    { name: 'Almond',      price_cents: 75, sort_order: 2 },
    { name: '2%',          price_cents: 0,  sort_order: 3 },
    { name: 'Skim',        price_cents: 0,  sort_order: 4 },
    { name: 'Half & Half', price_cents: 0,  sort_order: 5 },
  ],
};

const SWEETNESS: GroupSpec = {
  // Matcha drinks only (see groupsForItem). Required so the screen
  // always carries a definite, fail-safe sweetness (GR#17). Both
  // options are 0¢; Full sweet is the default (sort_order 0). The old
  // 'Unsweetened' / 'Regular' options are removed — matcha has
  // intrinsic sweetness from the purée/syrup.
  required: true,
  multi_select: false,
  sort_order: 2,
  modifiers: [
    { name: 'Full sweet', price_cents: 0, sort_order: 0 },
    { name: 'Half sweet', price_cents: 0, sort_order: 1 },
  ],
};

const EXTRAS_COFFEE: GroupSpec = {
  // Coffee drinks: keep the espresso shot (removing an existing option
  // is a regression) and add syrups. Coffee has no Sweetness group.
  required: false,
  multi_select: true,
  sort_order: 3,
  modifiers: [
    { name: 'Add espresso shot', price_cents: 100, sort_order: 0 },
    { name: 'Vanilla syrup',     price_cents: 50,  sort_order: 1 },
    { name: 'Caramel syrup',     price_cents: 50,  sort_order: 2 },
    { name: 'Brown sugar',       price_cents: 25,  sort_order: 3 },
  ],
};

const EXTRAS_MATCHA: GroupSpec = {
  required: false,
  multi_select: true,
  sort_order: 3,
  modifiers: [
    { name: 'Add matcha shot', price_cents: 100, sort_order: 0 },
  ],
};

/**
 * Resolves the modifier groups that apply to a given seed item.
 * - Size:      standard drinks only (excludes fixed-size Flat White, Cortado, Espresso).
 * - Milk:      milk drinks only (excludes Americano, Cold Brew, Espresso).
 * - Sweetness: matcha drinks only (Full sweet / Half sweet). Coffee drinks
 *   have no Sweetness group — use syrups under Extras instead.
 * - Extras:    matcha drinks get the matcha-shot toggle; coffee drinks get
 *   the espresso shot + vanilla/caramel/brown-sugar syrups.
 *
 * Group order: Size(0) → Milk(1) → Sweetness(2) → Extras(3).
 *
 * Food items get NO modifier groups (no required choices → smart-add
 * via "+" works inline; see iOS spec §5.1).
 */
function groupsForItem(seedCategoryName: string, seed: SeedItem): Array<{ name: GroupName; spec: GroupSpec }> {
  if (seedCategoryName === 'Food') return [];

  const FIXED_SIZE = new Set(['Flat White', 'Cortado', 'Espresso']);
  const BLACK = new Set(['Americano', 'Cold Brew', 'Espresso']);
  const isMatcha = seedCategoryName === 'Matcha';

  // Brief group order: Size -> Milk -> Sweetness -> Extras.
  const groups: Array<{ name: GroupName; spec: GroupSpec }> = [];
  if (!FIXED_SIZE.has(seed.name)) groups.push({ name: 'Size', spec: SIZE_STANDARD });
  if (!BLACK.has(seed.name))      groups.push({ name: 'Milk', spec: MILK });
  if (isMatcha)                   groups.push({ name: 'Sweetness', spec: SWEETNESS });
  groups.push({ name: 'Extras', spec: isMatcha ? EXTRAS_MATCHA : EXTRAS_COFFEE });
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
      { name: 'Strawberry Matcha',  description: 'Ceremonial matcha, oat milk & strawberry purée', base_price_cents: 645, temperature: 'iced', featured: true,  art_token: 'strawberry-matcha',   sort_order: 0 },
      { name: 'Raspberry Matcha',   description: 'Ceremonial matcha, oat milk & raspberry',         base_price_cents: 645, temperature: 'iced', featured: false, art_token: 'raspberry-matcha',    sort_order: 1 },
      { name: 'Brown Sugar Matcha', description: 'Ceremonial matcha, oat milk & brown sugar',       base_price_cents: 675, temperature: 'iced', featured: false, art_token: 'brown-sugar-matcha',  sort_order: 2 },
      { name: 'Ginger Matcha',      description: 'Ceremonial matcha, oat milk & fresh ginger',      base_price_cents: 675, temperature: 'iced', featured: false, art_token: 'ginger-matcha',       sort_order: 3 },
      { name: 'Iced Classic Matcha',description: 'Ceremonial matcha & oat milk over ice',           base_price_cents: 575, temperature: 'iced', featured: false, art_token: 'iced-classic-matcha', sort_order: 4 },
      { name: 'Vanilla Matcha',     description: 'Ceremonial matcha, oat milk & Madagascar vanilla',base_price_cents: 625, temperature: 'iced', featured: false, art_token: 'vanilla-matcha',      sort_order: 5 },
      { name: 'Blueberry Matcha',   description: 'Ceremonial matcha, oat milk & blueberry',         base_price_cents: 645, temperature: 'iced', featured: false, art_token: 'blueberry-matcha',    sort_order: 6 },
    ],
  },
  {
    name: 'Coffee',
    sort_order: 1,
    display_style: 'spotlight',
    items: [
      { name: 'Iced Coconut Latte',         description: 'Espresso, coconut milk & a sweet cream float', base_price_cents: 650, temperature: 'iced', featured: true,  art_token: 'iced-coconut-latte',          sort_order: 0 },
      { name: 'Iced Salted Caramel Latte',  description: 'Espresso, salted caramel & cold milk',         base_price_cents: 675, temperature: 'iced', featured: false, art_token: 'iced-salted-caramel-latte',   sort_order: 1 },
      { name: 'Iced Brown Sugar Oat Latte', description: 'Espresso, brown sugar & oat milk',             base_price_cents: 650, temperature: 'iced', featured: false, art_token: 'iced-brown-sugar-oat-latte',  sort_order: 2 },
      { name: 'Iced Vanilla Latte',         description: 'Espresso, Madagascar vanilla & cold milk',     base_price_cents: 625, temperature: 'iced', featured: false, art_token: 'iced-vanilla-latte',          sort_order: 3 },
      { name: 'Latte',      description: 'Espresso, steamed milk & light foam',         base_price_cents: 550, temperature: 'both', featured: false, art_token: 'latte',      sort_order: 4 },
      { name: 'Cappuccino', description: 'Double espresso, steamed milk & velvet foam', base_price_cents: 525, temperature: 'both', featured: false, art_token: 'cappuccino', sort_order: 5 },
      { name: 'Cold Brew',  description: '18-hour cold brew, single origin',            base_price_cents: 550, temperature: 'iced', featured: false, art_token: 'cold-brew',  sort_order: 6 },
      { name: 'Flat White', description: 'Double ristretto & silky microfoam',          base_price_cents: 525, temperature: 'hot',  featured: false, art_token: 'flat-white', sort_order: 7 },
      { name: 'Cortado',    description: 'Equal parts espresso & steamed milk',         base_price_cents: 475, temperature: 'hot',  featured: false, art_token: 'cortado',    sort_order: 8 },
      { name: 'Americano',  description: 'Double espresso & hot water',                 base_price_cents: 450, temperature: 'both', featured: false, art_token: 'americano',  sort_order: 9 },
      { name: 'Espresso',   description: 'House blend, double shot',                    base_price_cents: 350, temperature: 'hot',  featured: false, art_token: 'espresso',   sort_order: 10 },
    ],
  },
  {
    name: 'Food',
    sort_order: 2,
    display_style: 'spotlight',
    items: [
      { name: 'Mini Khachapuri',  description: 'Georgian cheese bread, served warm',    base_price_cents: 800, temperature: 'both', featured: true,  art_token: 'khachapuri',       sort_order: 0 },
      { name: 'Butter Croissant', description: 'Flaky French butter, baked fresh',       base_price_cents: 450, temperature: 'both', featured: false, art_token: 'croissant',        sort_order: 1 },
      { name: 'Pain au Chocolat', description: 'Butter pastry & dark chocolate batons',  base_price_cents: 500, temperature: 'both', featured: false, art_token: 'pain-au-chocolat',  sort_order: 2 },
      { name: 'Cinnamon Roll',    description: 'Soft swirl, cinnamon & cream-cheese glaze',base_price_cents: 525, temperature: 'both', featured: false, art_token: 'cinnamon-roll',    sort_order: 3 },
      { name: 'Blueberry Muffin', description: 'Fresh blueberries, gluten-free',         base_price_cents: 375, temperature: 'both', featured: false, art_token: 'muffin',           sort_order: 4 },
      { name: 'Chocolate Cookie', description: 'Dark chocolate & sea salt',              base_price_cents: 325, temperature: 'both', featured: false, art_token: 'cookie',           sort_order: 5 },
      { name: 'Everything Bagel', description: 'Toasted, with scallion cream cheese',    base_price_cents: 425, temperature: 'both', featured: false, art_token: 'everything-bagel',  sort_order: 6 },
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
          item.sort_order = seed.sort_order ?? 0;
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
              sort_order: seed.sort_order ?? 0,
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
