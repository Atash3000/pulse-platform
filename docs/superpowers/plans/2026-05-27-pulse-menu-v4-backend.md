# Pulse Menu v4 — Backend Presentation Fields (Concern A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the four presentation fields needed by the v4 iOS menu (`menu_items.temperature`, `menu_items.featured`, `menu_items.art_token`, `menu_categories.display_style`), expose them through the public menu API, and reseed the dev catalog with the realistic v4 drinks + modifier groups (Size / Milk / Extras / Sweetness).

**Architecture:** Concern A from `docs/superpowers/specs/2026-05-27-pulse-menu-v4-design.md`. All new columns ship with fail-safe defaults (Golden Rule #17): a row with no presentation data renders as a plain list item with `temperature='both'`. Enums are stored as `text` with a TS enum (project convention — see `LoyaltyTier` in `entities.ts:42`). Public types in `menu.service.ts` mirror the columns 1:1. Modifier groups use the existing `modifier_groups` / `modifiers` tables — no schema change, only seed data.

**Tech Stack:** NestJS 10, TypeORM 0.3, PostgreSQL, Jest. All money in **integer cents** (Golden Rule #7).

---

## File Structure

**Modify:**
- `apps/api/src/database/entities.ts` — add 2 TS enums + 3 columns on `MenuItem` + 1 column on `MenuCategory`.
- `apps/api/src/modules/menu/menu.service.ts` — extend `PublicMenuItem` / `PublicCategory` + map the new columns in `buildFullMenu()` and `getItemById()`.
- `apps/api/scripts/seed-menu.ts` — rewrite the catalog (matcha line / classic coffee / food) with presentation fields, add modifier-group seeding (idempotent).
- `docs/decision-log.md` — append entry for `art_token` (opaque string keyed to iOS-side registry).
- `apps/api/src/modules/menu/README.md` if present, else skip.

**Create:**
- `apps/api/src/database/migrations/1780099200000-AddMenuPresentationFields.ts` — schema change + backfill of seeded matcha row.
- `apps/api/src/modules/menu/menu.service.spec.ts` — first spec for the menu service; asserts the new fields propagate end-to-end through `getFullMenu()` and `getItemById()`, and that defaults are applied.
- `apps/api/src/database/migrations/1780099200000-AddMenuPresentationFields.spec.ts` — pins the SQL statements emitted by `up()` and `down()` (mocked `QueryRunner`).

**Will NOT touch:**
- `apps/api/src/modules/menu/menu.cache.ts` (cache wraps `PublicMenu` opaquely; new fields ride through for free).
- `apps/api/src/modules/menu/menu.controller.ts` (no new endpoints).
- Anything in `apps/api/src/modules/{checkout,payments,orders,pricing}` (out of scope per spec §3).

---

## Task 0 — Branch + baseline

**Files:** none (git-only)

- [ ] **Step 1: Verify clean working tree and base branch**

Run:
```bash
cd /Users/atamurad/Desktop/pulse-platform
git status --short
git rev-parse --abbrev-ref HEAD
git merge-base --is-ancestor main HEAD && echo "OK: reachable from main"
```

Expected: working tree may have unrelated untracked files (`design/v4/`, etc.) — that's fine. `HEAD` must be reachable from `main`. If not, stop and resolve before continuing.

- [ ] **Step 2: Create the feature branch from `main`**

Run:
```bash
git checkout main
git checkout -b feat/api/menu-presentation-fields
```

Expected: `Switched to a new branch 'feat/api/menu-presentation-fields'`.

- [ ] **Step 3: Confirm Postgres is running on 5433 (per project convention)**

Run:
```bash
docker ps --format '{{.Names}}\t{{.Ports}}' | grep pulse-postgres || echo "NOT RUNNING"
```

Expected: a row showing `pulse-postgres` mapping `0.0.0.0:5433->5432/tcp`. If "NOT RUNNING", start with `docker compose up -d postgres` from the repo root before proceeding.

- [ ] **Step 4: Run the baseline test suite**

Run:
```bash
cd apps/api
npm test -- --silent 2>&1 | tail -20
```

Expected: all suites pass. Note the count so regressions are visible later.

---

## Task 1 — TS enums + entity columns

**Files:**
- Modify: `apps/api/src/database/entities.ts`

- [ ] **Step 1: Add the two TS enums**

In `apps/api/src/database/entities.ts`, just after the existing `LoyaltyTier` enum (around line 47), insert:

```typescript
/**
 * Drink temperature, drives the v4 Menu screen's temperature toggle and
 * per-item pill. Stored as text per project convention; safe default
 * 'both' means an unknown / un-seeded row never disappears from any
 * filter (Golden Rule #17 — non-critical surfaces fail safe).
 */
export enum Temperature {
  HOT = 'hot',
  ICED = 'iced',
  BOTH = 'both',
}

/**
 * How a category renders on the v4 Menu screen. 'spotlight' = hero card
 * + horizontal scroll (the Matcha line); 'list' = vertical rows (Classic
 * coffee, Food). Default 'list' keeps any un-seeded category safe.
 */
export enum CategoryDisplayStyle {
  SPOTLIGHT = 'spotlight',
  LIST = 'list',
}
```

- [ ] **Step 2: Add `display_style` to `MenuCategory`**

In the same file, inside `MenuCategory` (around line 313–332), add a column after `sort_order` and before `active`:

```typescript
  @Column({ type: 'text', default: CategoryDisplayStyle.LIST })
  display_style!: CategoryDisplayStyle;
```

- [ ] **Step 3: Add `temperature`, `featured`, `art_token` to `MenuItem`**

In the same file, inside `MenuItem` (around line 335–373), add three columns after `image_url` and before `active`:

```typescript
  @Column({ type: 'text', default: Temperature.BOTH })
  temperature!: Temperature;

  @Column({ type: 'boolean', default: false })
  featured!: boolean;

  /**
   * Opaque key the iOS app maps to a drawn abstract drink symbol
   * (e.g. 'strawberry-matcha', 'cappuccino', 'croissant'). Nullable;
   * iOS draws a neutral fallback for unknown / null tokens.
   * Backend is intentionally ignorant of the registry (see
   * decision-log entry "[api] menu_items.art_token is opaque…").
   */
  @Column({ type: 'text', nullable: true })
  art_token!: string | null;
```

- [ ] **Step 4: Type-check**

Run:
```bash
cd apps/api
npx tsc --noEmit
```

Expected: PASS with no errors. (TypeORM defaults referencing the enum values must resolve.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/database/entities.ts
git commit -m "feat(api): add Temperature + CategoryDisplayStyle entity fields

Adds menu_categories.display_style and menu_items.temperature,
.featured, .art_token. All ship with fail-safe defaults: display_style
defaults to 'list', temperature to 'both', featured to false, art_token
nullable. Backs the v4 Menu screen presentation fields (concern A of
docs/superpowers/specs/2026-05-27-pulse-menu-v4-design.md).

Migration in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2 — Migration with backfill

**Files:**
- Create: `apps/api/src/database/migrations/1780099200000-AddMenuPresentationFields.ts`
- Create: `apps/api/src/database/migrations/1780099200000-AddMenuPresentationFields.spec.ts`

- [ ] **Step 1: Write the failing migration spec**

Create `apps/api/src/database/migrations/1780099200000-AddMenuPresentationFields.spec.ts`:

```typescript
import { QueryRunner } from 'typeorm';
import { AddMenuPresentationFields1780099200000 } from './1780099200000-AddMenuPresentationFields';

function buildRunner() {
  return { query: jest.fn().mockResolvedValue(undefined) } as unknown as QueryRunner;
}

describe('AddMenuPresentationFields1780099200000', () => {
  it('up() adds display_style + temperature + featured + art_token with safe defaults', async () => {
    const runner = buildRunner();
    await new AddMenuPresentationFields1780099200000().up(runner);

    const sql = (runner.query as jest.Mock).mock.calls.map((c) => c[0] as string);

    // Schema additions
    expect(sql.some((s) => /ALTER TABLE "menu_categories" ADD "display_style" text NOT NULL DEFAULT 'list'/.test(s))).toBe(true);
    expect(sql.some((s) => /ALTER TABLE "menu_items" ADD "temperature" text NOT NULL DEFAULT 'both'/.test(s))).toBe(true);
    expect(sql.some((s) => /ALTER TABLE "menu_items" ADD "featured" boolean NOT NULL DEFAULT false/.test(s))).toBe(true);
    expect(sql.some((s) => /ALTER TABLE "menu_items" ADD "art_token" text/.test(s))).toBe(true);

    // Backfill: existing Matcha-category becomes spotlight; featured Strawberry Matcha; iced temperatures.
    // We assert the *intent* (a backfill UPDATE touching the seed names) rather than exact whitespace.
    const backfills = sql.filter((s) => /^\s*UPDATE/i.test(s));
    expect(backfills.length).toBeGreaterThanOrEqual(2);
    expect(backfills.some((s) => /display_style\s*=\s*'spotlight'/.test(s) && /Matcha/.test(s))).toBe(true);
    expect(backfills.some((s) => /featured\s*=\s*true/.test(s) && /Strawberry Matcha/.test(s))).toBe(true);
  });

  it('down() drops all four columns', async () => {
    const runner = buildRunner();
    await new AddMenuPresentationFields1780099200000().down(runner);

    const sql = (runner.query as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(sql).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/ALTER TABLE "menu_items" DROP COLUMN "art_token"/),
        expect.stringMatching(/ALTER TABLE "menu_items" DROP COLUMN "featured"/),
        expect.stringMatching(/ALTER TABLE "menu_items" DROP COLUMN "temperature"/),
        expect.stringMatching(/ALTER TABLE "menu_categories" DROP COLUMN "display_style"/),
      ]),
    );
  });
});
```

- [ ] **Step 2: Run the spec — verify it fails (file missing)**

Run:
```bash
cd apps/api
npm test -- src/database/migrations/1780099200000-AddMenuPresentationFields.spec.ts 2>&1 | tail -20
```

Expected: FAIL with `Cannot find module './1780099200000-AddMenuPresentationFields'`.

- [ ] **Step 3: Write the migration**

Create `apps/api/src/database/migrations/1780099200000-AddMenuPresentationFields.ts`:

```typescript
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds the v4 Menu screen presentation fields to the menu tables:
 *
 *   menu_categories.display_style  ('spotlight' | 'list', default 'list')
 *   menu_items.temperature         ('hot' | 'iced' | 'both', default 'both')
 *   menu_items.featured            (boolean, default false)
 *   menu_items.art_token           (text, nullable)
 *
 * Defaults are fail-safe (Golden Rule #17) — a row without any
 * presentation data renders as a plain list item that shows under
 * every temperature filter, and iOS draws a neutral symbol for a
 * null art_token. The Public types in menu.service.ts surface the
 * new fields verbatim.
 *
 * Backfill: the seed:menu dev catalog already contains a 'Matcha'
 * category seeded by an earlier version of this work — we promote it
 * to display_style='spotlight', mark 'Strawberry Matcha' featured,
 * and set the existing matcha items' temperature to 'iced'. Any DB
 * that doesn't have those rows (fresh seed:dev only, or a prod-like
 * environment) is unaffected by the UPDATEs.
 *
 * down() drops the four columns in reverse order.
 */
export class AddMenuPresentationFields1780099200000 implements MigrationInterface {
    name = 'AddMenuPresentationFields1780099200000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // 1. Schema additions — all NOT NULL with fail-safe defaults except art_token.
        await queryRunner.query(`ALTER TABLE "menu_categories" ADD "display_style" text NOT NULL DEFAULT 'list'`);
        await queryRunner.query(`ALTER TABLE "menu_items" ADD "temperature" text NOT NULL DEFAULT 'both'`);
        await queryRunner.query(`ALTER TABLE "menu_items" ADD "featured" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "menu_items" ADD "art_token" text`);

        // 2. Backfill existing dev seed (no-op on environments that don't have a Matcha category).
        await queryRunner.query(`
            UPDATE "menu_categories"
            SET "display_style" = 'spotlight'
            WHERE "name" = 'Matcha'
        `);
        await queryRunner.query(`
            UPDATE "menu_items" mi
            SET "temperature" = 'iced'
            FROM "menu_categories" mc
            WHERE mi."category_id" = mc."id" AND mc."name" = 'Matcha'
        `);
        await queryRunner.query(`
            UPDATE "menu_items" mi
            SET "featured" = true
            FROM "menu_categories" mc
            WHERE mi."category_id" = mc."id"
              AND mc."name" = 'Matcha'
              AND mi."name" = 'Strawberry Matcha'
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "menu_items" DROP COLUMN "art_token"`);
        await queryRunner.query(`ALTER TABLE "menu_items" DROP COLUMN "featured"`);
        await queryRunner.query(`ALTER TABLE "menu_items" DROP COLUMN "temperature"`);
        await queryRunner.query(`ALTER TABLE "menu_categories" DROP COLUMN "display_style"`);
    }
}
```

- [ ] **Step 4: Run the spec — verify it passes**

Run:
```bash
cd apps/api
npm test -- src/database/migrations/1780099200000-AddMenuPresentationFields.spec.ts 2>&1 | tail -10
```

Expected: PASS (2 tests).

- [ ] **Step 5: Apply the migration to the dev DB**

Run:
```bash
cd apps/api
npm run migration:run 2>&1 | tail -10
```

Expected: line containing `AddMenuPresentationFields1780099200000 has been executed successfully`.

- [ ] **Step 6: Sanity-check the dev DB shape**

Run:
```bash
docker exec -i pulse-postgres psql -U pulse -d pulse -c '\d menu_items' | grep -E "temperature|featured|art_token"
docker exec -i pulse-postgres psql -U pulse -d pulse -c '\d menu_categories' | grep "display_style"
```

Expected: each column listed with the right type. If `psql` connection fails, the project uses a different connection convention — fall back to `npm run migration:show` to confirm the migration is applied, then move on.

- [ ] **Step 7: Verify `down()` works, then re-apply**

Run:
```bash
cd apps/api
npm run migration:revert 2>&1 | tail -5
npm run migration:run   2>&1 | tail -5
```

Expected: revert message naming the migration, then re-apply succeeds. This confirms `down()` is real.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/database/migrations/1780099200000-AddMenuPresentationFields.ts \
        apps/api/src/database/migrations/1780099200000-AddMenuPresentationFields.spec.ts
git commit -m "feat(api): migration for menu presentation fields

Adds display_style on menu_categories and temperature / featured /
art_token on menu_items, with fail-safe defaults and a Matcha-category
backfill for the dev seed. Spec pins the SQL emitted by up() and down()
so future edits to the raw SQL stay loud at review time.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 — Expose the new fields through `PublicMenu`

**Files:**
- Create: `apps/api/src/modules/menu/menu.service.spec.ts`
- Modify: `apps/api/src/modules/menu/menu.service.ts`

- [ ] **Step 1: Write the failing service spec**

Create `apps/api/src/modules/menu/menu.service.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  CategoryDisplayStyle,
  Inventory,
  MenuCategory,
  MenuItem,
  Modifier,
  ModifierGroup,
  Temperature,
} from '../../database/entities';
import { MenuCache } from './menu.cache';
import { MenuService } from './menu.service';

const LOC = '00000000-0000-0000-0000-000000000111';

const category = (overrides: Partial<MenuCategory> = {}): MenuCategory =>
  ({
    id: overrides.id ?? 'cat-matcha',
    location_id: LOC,
    name: overrides.name ?? 'Matcha',
    sort_order: overrides.sort_order ?? 0,
    active: true,
    display_style: overrides.display_style ?? CategoryDisplayStyle.SPOTLIGHT,
  }) as unknown as MenuCategory;

const item = (overrides: Partial<MenuItem> = {}): MenuItem =>
  ({
    id: overrides.id ?? 'item-strawberry',
    category_id: overrides.category_id ?? 'cat-matcha',
    name: overrides.name ?? 'Strawberry Matcha',
    description: overrides.description ?? null,
    base_price_cents: overrides.base_price_cents ?? 645,
    image_url: null,
    active: true,
    temperature: overrides.temperature ?? Temperature.ICED,
    featured: overrides.featured ?? true,
    art_token: overrides.art_token ?? 'strawberry-matcha',
  }) as unknown as MenuItem;

// Convenience: a query-builder mock that returns a fixed list for getMany().
function qb(result: unknown[]) {
  const builder: Record<string, unknown> = {};
  ['where', 'andWhere', 'orderBy'].forEach((m) => {
    builder[m] = jest.fn().mockReturnValue(builder);
  });
  builder.getMany = jest.fn().mockResolvedValue(result);
  return builder;
}

describe('MenuService — v4 presentation fields', () => {
  let service: MenuService;
  let cache: { getFullMenu: jest.Mock; setFullMenu: jest.Mock; getItem: jest.Mock; setItem: jest.Mock };

  beforeEach(async () => {
    cache = {
      getFullMenu: jest.fn().mockResolvedValue(null),
      setFullMenu: jest.fn().mockResolvedValue(undefined),
      getItem: jest.fn().mockResolvedValue(null),
      setItem: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MenuService,
        { provide: MenuCache, useValue: cache },
        {
          provide: getRepositoryToken(MenuCategory),
          useValue: { find: jest.fn().mockResolvedValue([category()]) },
        },
        {
          provide: getRepositoryToken(MenuItem),
          useValue: {
            createQueryBuilder: jest.fn().mockReturnValue(qb([item()])),
            findOne: jest.fn().mockResolvedValue({ ...item(), category: category() }),
          },
        },
        {
          provide: getRepositoryToken(ModifierGroup),
          useValue: { createQueryBuilder: jest.fn().mockReturnValue(qb([])), find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getRepositoryToken(Modifier),
          useValue: { createQueryBuilder: jest.fn().mockReturnValue(qb([])) },
        },
        {
          provide: getRepositoryToken(Inventory),
          useValue: {
            createQueryBuilder: jest.fn().mockReturnValue(qb([])),
            findOne: jest.fn().mockResolvedValue(null),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(MenuService);
  });

  it('getFullMenu() exposes display_style on each category', async () => {
    const menu = await service.getFullMenu(LOC);
    expect(menu.categories).toHaveLength(1);
    expect(menu.categories[0].display_style).toBe('spotlight');
  });

  it('getFullMenu() exposes temperature / featured / art_token on each item', async () => {
    const menu = await service.getFullMenu(LOC);
    const it = menu.categories[0].items[0];
    expect(it.temperature).toBe('iced');
    expect(it.featured).toBe(true);
    expect(it.art_token).toBe('strawberry-matcha');
  });

  it('getItemById() returns temperature / featured / art_token', async () => {
    const payload = await service.getItemById('item-strawberry');
    expect(payload.temperature).toBe('iced');
    expect(payload.featured).toBe(true);
    expect(payload.art_token).toBe('strawberry-matcha');
  });
});
```

- [ ] **Step 2: Run — verify it fails on missing fields**

Run:
```bash
cd apps/api
npm test -- src/modules/menu/menu.service.spec.ts 2>&1 | tail -25
```

Expected: FAIL on the field assertions (e.g. `expect(menu.categories[0].display_style).toBe('spotlight')` returns `undefined`), OR a TypeScript error that `display_style` / `temperature` / `featured` / `art_token` are not on the Public types. Either way, RED.

- [ ] **Step 3: Extend `PublicMenuItem` / `PublicCategory`**

In `apps/api/src/modules/menu/menu.service.ts`, replace the existing `PublicMenuItem` interface (lines 36–45) with:

```typescript
export interface PublicMenuItem {
  id: string;
  name: string;
  description: string | null;
  base_price_cents: number;
  image_url: string | null;
  available: boolean;       // composed from inventory.available + inventory.quantity_left
  quantity_left: number | null;
  modifier_groups: PublicModifierGroup[];
  /** Drives the v4 temperature toggle + per-item pill. */
  temperature: 'hot' | 'iced' | 'both';
  /** Spotlight categories pick their hero from the featured item. */
  featured: boolean;
  /** Opaque key the iOS app maps to a drawn abstract drink symbol. */
  art_token: string | null;
}
```

And replace `PublicCategory` (lines 47–52) with:

```typescript
export interface PublicCategory {
  id: string;
  name: string;
  sort_order: number;
  items: PublicMenuItem[];
  /** 'spotlight' = hero card + horizontal scroll; 'list' = vertical rows. */
  display_style: 'spotlight' | 'list';
}
```

- [ ] **Step 4: Map the new columns in `getItemById()`**

In the same file, inside `getItemById()` (around line 122–133), extend the `payload` object literal so it includes the three new item fields. After `modifier_groups: groups,` add:

```typescript
      temperature: item.temperature,
      featured: item.featured,
      art_token: item.art_token,
```

- [ ] **Step 5: Map the new columns in `buildFullMenu()`**

In the same file, inside `buildFullMenu()` (the `categories: categories.map(...)` block around line 223–248), extend the per-category projection to include `display_style: c.display_style,` and the per-item projection to include the three item fields. The resulting block:

```typescript
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        sort_order: c.sort_order,
        display_style: c.display_style,
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
          temperature: it.temperature,
          featured: it.featured,
          art_token: it.art_token,
        })),
      })),
```

- [ ] **Step 6: Run the spec — verify it passes**

Run:
```bash
cd apps/api
npm test -- src/modules/menu/menu.service.spec.ts 2>&1 | tail -10
```

Expected: PASS (3 tests).

- [ ] **Step 7: Run the full suite — confirm no regressions**

Run:
```bash
cd apps/api
npm test -- --silent 2>&1 | tail -10
```

Expected: all suites pass, count ≥ the Task 0 baseline (Task 2 + Task 3 added new tests).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/menu/menu.service.ts apps/api/src/modules/menu/menu.service.spec.ts
git commit -m "feat(api): surface menu presentation fields on PublicMenu

Adds temperature / featured / art_token to PublicMenuItem and
display_style to PublicCategory. buildFullMenu() and getItemById()
now project the columns 1:1. First spec on menu.service.ts asserts
the new fields propagate through both code paths.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 — Reseed the dev catalog (v4 items + presentation fields)

**Files:**
- Modify: `apps/api/scripts/seed-menu.ts`

This task rewrites the `ITEMS` constant and the category structure to match the v4 spec (matcha line / classic coffee / food, each with its own category and `display_style`). Modifier seeding lands in Task 5; this task only handles items + categories.

- [ ] **Step 1: Replace the `CATEGORY` / `ITEMS` constants and types**

In `apps/api/scripts/seed-menu.ts`, replace the `CATEGORY` const (lines 50–53) and the `SeedItem` / `ITEMS` block (lines 60–118 inclusive) with:

```typescript
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
```

- [ ] **Step 2: Update the `Counts` interface for the new metric**

Replace the `Counts` interface (around lines 120–127) with:

```typescript
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
```

And add the four new counters to the `totals` initializer inside `run()` (search for the `categories_inserted: 0,` block and append):

```typescript
    modifier_groups_inserted: 0,
    modifier_groups_updated: 0,
    modifiers_inserted: 0,
    modifiers_updated: 0,
```

These will stay at 0 until Task 5.

- [ ] **Step 3: Rewrite the category + items upsert loop**

Inside `run()`, replace the section from `// ---- 2. Upsert the Coffee category ----` through the end of the `for (const seed of ITEMS) { ... }` loop (roughly lines 165–235) with the new multi-category loop:

```typescript
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

        // Modifier groups land in Task 5 — placeholder pass-through here.
      }
    }
```

- [ ] **Step 4: Update the import list**

Near the top of `apps/api/scripts/seed-menu.ts`, expand the entities import:

Find:
```typescript
import {
  Inventory,
  Location,
  MenuCategory,
  MenuItem,
} from '../src/database/entities';
```

Replace with:
```typescript
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
```

(`Modifier` / `ModifierGroup` are imported now for Task 5 — they're tree-shaken by ts-node either way; importing them now keeps the diff for Task 5 small.)

- [ ] **Step 5: Update the header comment + closing log**

In `apps/api/scripts/seed-menu.ts`, find the `Why no modifier_groups` block in the top file-doc (around lines 30–40) and replace it with:

```
 * Catalog shape
 * --------------
 * Three categories: Matcha (spotlight), Classic Coffee (list), Food
 * (list). Each item carries its temperature, featured flag, and an
 * opaque art_token the iOS app maps to a drawn abstract symbol.
 * Modifier groups (Size / Milk / Extras / Sweetness) are seeded per
 * item — see Task 5 in
 * docs/superpowers/plans/2026-05-27-pulse-menu-v4-backend.md.
```

In the closing `console.log` inside `run()` (the multi-line one near the bottom of the file), extend it so the new counters print. Replace the existing template literal with:

```typescript
  console.log(
    `seed:menu complete:\n` +
      `  categories      — inserted=${totals.categories_inserted} updated=${totals.categories_updated}\n` +
      `  items           — inserted=${totals.items_inserted} updated=${totals.items_updated}\n` +
      `  modifier groups — inserted=${totals.modifier_groups_inserted} updated=${totals.modifier_groups_updated}\n` +
      `  modifiers       — inserted=${totals.modifiers_inserted} updated=${totals.modifiers_updated}\n` +
      `  inventory       — inserted=${totals.inventory_inserted} left_alone=${totals.inventory_left_alone}`,
  );
```

- [ ] **Step 6: Type-check + run the seed twice (idempotency check)**

Run:
```bash
cd apps/api
npx tsc --noEmit
npm run seed:menu 2>&1 | tail -10
npm run seed:menu 2>&1 | tail -10
```

Expected: type-check clean. First seed run shows mostly `inserted` counts (or `updated` if Task 2's backfill already touched the Matcha row). Second seed run shows `updated` counts for items and `left_alone` for inventory. Modifier counts remain at 0 until Task 5.

- [ ] **Step 7: Spot-check the API response shape**

Restart the API so the in-memory + Redis menu cache picks up the new seed (per memory note `local-api-runtime-staleness`: dev runs `start:prod` with no reload).

Run (from `apps/api`):
```bash
# In one terminal, restart:
npm run build && npm run start:prod
```

In another terminal:
```bash
LOC=$(curl -s http://localhost:3000/api/v1/locations | jq -r '.[0].id')
curl -s "http://localhost:3000/api/v1/menu?locationId=$LOC" | jq '.categories | map({name, display_style, hero: (.items[] | select(.featured) | .name)})'
```

Expected: three categories printed (Matcha, Classic Coffee, Food); Matcha has `display_style: "spotlight"` and `hero: "Strawberry Matcha"`. If `jq` is missing, just `| python3 -m json.tool | head -60` and read the shape.

- [ ] **Step 8: Commit**

```bash
git add apps/api/scripts/seed-menu.ts
git commit -m "feat(api): reseed dev catalog with v4 three-category structure

Replaces the single Coffee category with Matcha (spotlight) / Classic
Coffee (list) / Food (list), each item carrying temperature, featured,
and an opaque art_token. Idempotent upsert by (location_id, name) and
(category_id, name) as before; inventory rows are never overwritten on
re-run. Modifier-group seeding lands in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 — Seed modifier groups (Size / Milk / Extras / Sweetness)

**Files:**
- Modify: `apps/api/scripts/seed-menu.ts`

The existing schema already supports modifier groups + modifiers with `required`, `multi_select`, `sort_order`, and per-modifier `price_cents`. This task only seeds data — no schema change.

- [ ] **Step 1: Add the modifier-group catalog + per-item resolution**

In `apps/api/scripts/seed-menu.ts`, just above the `CATEGORIES` constant, insert:

```typescript
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
```

- [ ] **Step 2: Add the modifier-group upsert helper**

Just below the helper above (still inside `seed-menu.ts`, outside `run()`), add:

```typescript
/**
 * Idempotent upsert of one item's modifier groups + modifiers.
 *
 * Group natural key: (item_id, name). Modifier natural key: (group_id,
 * name). Updates the row in place on hit; inserts on miss. Does NOT
 * delete groups/modifiers that exist in the DB but not in the seed
 * (out of scope — manual cleanup if the catalog shrinks).
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
        existing.active = true;
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
```

- [ ] **Step 3: Wire the helper into the item loop**

Inside `run()`, find the `// Modifier groups land in Task 5 — placeholder pass-through here.` line from Task 4 and replace it with:

```typescript
        await upsertModifierGroups(em, item.id, groupsForItem(seedCategory.name, seed), totals);
```

- [ ] **Step 4: Type-check + run the seed twice**

Run:
```bash
cd apps/api
npx tsc --noEmit
npm run seed:menu 2>&1 | tail -10
npm run seed:menu 2>&1 | tail -10
```

Expected: type-check clean. First run shows `modifier_groups inserted=N updated=0` (N = sum of groups across drinks, e.g. 4 matchas × 4 groups + 7 classics with item-specific groups + 0 food). Second run shows `modifier_groups inserted=0 updated=N` and `modifiers inserted=0 updated=M`. No duplicates.

- [ ] **Step 5: Spot-check via the API**

If the API is still running from Task 4, restart it again so the cache reflects the new modifier seed:

```bash
cd apps/api
npm run build && npm run start:prod
```

Then:
```bash
LOC=$(curl -s http://localhost:3000/api/v1/locations | jq -r '.[0].id')
curl -s "http://localhost:3000/api/v1/menu?locationId=$LOC" \
  | jq '.categories[] | {name, items: [.items[] | {name, mods: [.modifier_groups[].name]}]}'
```

Expected:
- Matcha items: `["Size","Milk","Extras","Sweetness"]`.
- Cappuccino / Latte: `["Size","Milk","Extras","Sweetness"]`.
- Americano / Cold Brew: `["Size","Extras","Sweetness"]` (no Milk).
- Flat White / Cortado: `["Milk","Extras","Sweetness"]` (no Size).
- Espresso: `["Extras","Sweetness"]` (no Size, no Milk).
- Food items: `[]`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/scripts/seed-menu.ts
git commit -m "feat(api): seed Size / Milk / Extras / Sweetness modifier groups

Each drink gets per-item modifier groups resolved by groupsForItem():
standard drinks get Size (12/16 oz), milk drinks get Milk (8 options,
oat/almond/coconut/soy +75), matcha drinks get an Add-matcha-shot
toggle, other drinks get Add-espresso-shot, and every drink gets a
Sweetness picker. Food has no modifier groups (smart-add via '+' works
inline). Idempotent upsert by (item_id, name) and (group_id, name).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6 — Decision-log entry + final verification

**Files:**
- Modify: `docs/decision-log.md`

- [ ] **Step 1: Append the decision-log entry**

Open `docs/decision-log.md` and append at the end (preserving the existing entry separator pattern):

```markdown
## 2026-05-27 — [api] menu_items.art_token is an opaque string keyed to an iOS-side registry

**Decision:** `menu_items.art_token` is a nullable text column. The backend stores the string verbatim; the iOS `DrinkArt` view owns the mapping from token → drawn abstract symbol. Unknown / null tokens render as a neutral cup symbol.

**Context:** v4 design uses abstract symbolic drink visuals (`design/v4/README.md` — "small navigational surfaces use abstract symbolic representations"). The visuals are SwiftUI gradient layers, not assets. Backend needs to tell iOS which symbol to draw without dragging the drawing logic across the network.

**Alternatives considered:**
1. Per-item asset URL (image_url) — wrong: forces a photo pipeline, contradicts the design's "abstract symbols" rule.
2. Enum on the backend (`MATCHA_LAYERED | CLASSIC_CUP | FOOD`) — loses palette granularity; every matcha drink would render identically.
3. Structured drawing spec on the backend (layer colors, shape) — over-couples the backend to a UI library; iOS would still need a fallback registry.

**Reasoning:** A short opaque string keeps the API lean (one field), keeps drawing logic where drawing tools live (SwiftUI), and degrades gracefully (null → neutral). New tokens are an iOS change only.

**Trade-offs:** Adding a new drink with a new visual requires an iOS code change to register the token. Acceptable: new drinks are rare and already require copy / merchandising decisions; cutting an iOS release for a new symbol is in scope.
```

- [ ] **Step 2: Run the full test suite one more time**

Run:
```bash
cd apps/api
npm test -- --silent 2>&1 | tail -10
```

Expected: all suites pass (baseline + the new menu.service.spec + the migration spec).

- [ ] **Step 3: Final visual spot-check of the JSON contract**

Restart the API if not already running:
```bash
cd apps/api
npm run build && npm run start:prod
```

Then verify all four new fields are present on a single item:
```bash
LOC=$(curl -s http://localhost:3000/api/v1/locations | jq -r '.[0].id')
curl -s "http://localhost:3000/api/v1/menu?locationId=$LOC" \
  | jq '.categories[0] | {display_style, hero: (.items[] | select(.featured) | {name, temperature, featured, art_token})}'
```

Expected output (formatting may vary):
```json
{
  "display_style": "spotlight",
  "hero": {
    "name": "Strawberry Matcha",
    "temperature": "iced",
    "featured": true,
    "art_token": "strawberry-matcha"
  }
}
```

- [ ] **Step 4: Commit the decision-log entry**

```bash
git add docs/decision-log.md
git commit -m "docs(decision-log): art_token is opaque, keyed to iOS DrinkArt registry

Records the choice to store the drink visual as a short opaque string
the backend never interprets — iOS owns the token → drawn symbol
mapping with a neutral fallback. See spec
docs/superpowers/specs/2026-05-27-pulse-menu-v4-design.md §8.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7 — Open the PR

**Files:** none (GitHub-only)

- [ ] **Step 1: Push the branch (after explicit user approval per CLAUDE.md §8)**

Do NOT push automatically. Wait for the user to say "push it." When they do, run:
```bash
git push -u origin feat/api/menu-presentation-fields
```

- [ ] **Step 2: Open the PR (after explicit user approval)**

When the user says "open a PR," run:
```bash
gh pr create \
  --base main \
  --head feat/api/menu-presentation-fields \
  --title "feat(api): menu presentation fields + realistic v4 seed" \
  --body "Concern A of docs/superpowers/specs/2026-05-27-pulse-menu-v4-design.md.

## What this PR does
- Adds 'menu_categories.display_style' ('spotlight' | 'list', default 'list').
- Adds 'menu_items.temperature' ('hot' | 'iced' | 'both', default 'both'), 'featured' (boolean, default false), 'art_token' (nullable text).
- Migration includes a Matcha-category backfill for the dev seed.
- Surfaces all four fields on 'PublicCategory' / 'PublicMenuItem'.
- First spec on menu.service.ts pins the propagation.
- Reseeds the dev catalog with the v4 three-category structure (Matcha spotlight, Classic Coffee list, Food list) and realistic modifier groups: Size (12/16 oz), Milk (8 options), Extras (espresso / matcha shot), Sweetness — applied per item by 'groupsForItem'.

## Out of scope (separate PRs)
- iOS Menu screen redesign (concern B).
- iOS bottom nav 5-tab + Rewards placeholder (concern C).
- iOS item modifier picker (concern D).

## Golden Rules
- #7 Integer cents — all new prices + modifier deltas in cents.
- #17 Fail safe — every new column has a safe default; unknown art_token renders as a neutral symbol on iOS.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Self-Review

Coverage of spec §4 (Concern A) cross-checked:

- **§4.1 New columns** — Tasks 1, 2 (entity + migration).
- **§4.2 Migration with backfill + down()** — Task 2.
- **§4.3 API contract (PublicMenuItem / PublicCategory + iOS mirror)** — Task 3. (iOS Codable changes belong to concern B's plan, not this one.)
- **§4.4 Reseed (Matcha / Classic / Food, prices, art_tokens, featured)** — Task 4.
- **§4.5 Modifier seed (Size / Milk / Extras / Sweetness, per-item resolution)** — Task 5.
- **§9 Golden Rules** — #7 (integer cents) enforced by `base_price_cents` + `price_cents`; #17 (fail safe) enforced by defaults on every new column; #8 (iOS never calculates authoritative price) preserved — modifier deltas live on the server.
- **§10 Testing plan (backend portion)** — migration up/down test (Task 2 step 1), menu.service propagation test (Task 3 step 1), default/backfill correctness asserted by spec + manual seed-twice check (Tasks 4 step 6, 5 step 4).
- **Decision-log entry for art_token** — Task 6.

No placeholder steps. Method names (`upsertModifierGroups`, `groupsForItem`) and type names (`Counts`, `GroupSpec`, `ModifierSpec`, `SeedItem`, `SeedCategory`) are consistent between tasks.
