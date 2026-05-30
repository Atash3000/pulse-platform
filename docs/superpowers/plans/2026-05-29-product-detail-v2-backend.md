# Product Detail v2 — Backend Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce the backend data the iOS Product Detail v2 screen consumes — a 5-option milk set, matcha-only sweetness (Full/Half), coffee syrup extras, the brief's group order (Size → Milk → Sweetness → Extras), boutique one-line descriptions, and an additive `badge_type` column — all fail-safe and cache-correct.

**Architecture:** This is slice 1 of 2 (backend-first; see `docs/superpowers/specs/2026-05-29-product-detail-v2-design.md`). All "matcha vs coffee" behaviour lives in the seed's `groupsForItem()`, so iOS stays a generic renderer. The only schema change is one nullable column (`menu_items.badge_type`); everything else is seed-data + payload-exposure + a cache-namespace bump. No payment/checkout code is touched.

**Tech Stack:** NestJS + TypeORM (Postgres), Jest, Redis (ioredis). Branch: `feat/api/menu-modifiers-v2` (already created off `main`; the design spec is staged on it).

**Working directory for all commands:** `apps/api/` unless stated otherwise. Run tests with `npm test` (Jest, `*.spec.ts`).

> **Commit policy (CLAUDE.md §8):** each task ends with a commit step. In an interactive session, the human approves each commit ("commit it"); a subagent executor should stage + present the message and pause per the project's local-first rule. Do **not** push.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `apps/api/src/database/entities.ts` | Modify (`MenuItem`) | Add `badge_type` column |
| `apps/api/src/database/migrations/1780300000000-AddMenuItemBadgeType.ts` | Create | DDL for `badge_type` |
| `apps/api/src/database/migrations/1780300000000-AddMenuItemBadgeType.spec.ts` | Create | Asserts up/down SQL |
| `apps/api/src/modules/menu/menu.service.ts` | Modify | Add `badge_type` to `PublicMenuItem` + both mapping sites |
| `apps/api/src/modules/menu/menu.service.spec.ts` | Modify | Assert `badge_type` in payloads |
| `apps/api/src/modules/menu/menu.cache.ts` | Modify | Bump `menu:v2:*` → `menu:v3:*` |
| `docs/architecture.md`, `docs/glossary.md`, `docs/troubleshooting.md` | Modify | Sync cache version refs |
| `apps/api/scripts/seed-menu.ts` | Modify | Milk/Sweetness/Extras specs, group order, boutique descriptions |
| `docs/todo-endpoints.md` | Create | Record deferred endpoints/fields |
| `docs/decision-log.md` | Modify (append) | Record the non-obvious decisions + stale-option handling |

---

## Task 1: Add the `badge_type` migration (TDD on the SQL)

**Files:**
- Create: `apps/api/src/database/migrations/1780300000000-AddMenuItemBadgeType.spec.ts`
- Create: `apps/api/src/database/migrations/1780300000000-AddMenuItemBadgeType.ts`

- [ ] **Step 1: Write the failing migration spec** (mirrors `1780099200000-AddMenuPresentationFields.spec.ts`)

Create `apps/api/src/database/migrations/1780300000000-AddMenuItemBadgeType.spec.ts`:

```typescript
import { QueryRunner } from 'typeorm';
import { AddMenuItemBadgeType1780300000000 } from './1780300000000-AddMenuItemBadgeType';

function buildRunner() {
  return { query: jest.fn().mockResolvedValue(undefined) } as unknown as QueryRunner;
}

describe('AddMenuItemBadgeType1780300000000', () => {
  it('up() adds a nullable badge_type text column (no NOT NULL, no default row backfill)', async () => {
    const runner = buildRunner();
    await new AddMenuItemBadgeType1780300000000().up(runner);

    const sql = (runner.query as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(sql.some((s) => /ALTER TABLE "menu_items" ADD "badge_type" text/.test(s))).toBe(true);
    // Fail-safe: nullable, no NOT NULL constraint (GR#17 — a row with no badge is the norm).
    expect(sql.some((s) => /badge_type" text NOT NULL/.test(s))).toBe(false);
  });

  it('down() drops the badge_type column', async () => {
    const runner = buildRunner();
    await new AddMenuItemBadgeType1780300000000().down(runner);

    const sql = (runner.query as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(sql).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/ALTER TABLE "menu_items" DROP COLUMN "badge_type"/),
      ]),
    );
  });
});
```

- [ ] **Step 2: Run the spec, verify it fails**

Run: `npm test -- 1780300000000-AddMenuItemBadgeType.spec.ts`
Expected: FAIL — `Cannot find module './1780300000000-AddMenuItemBadgeType'`.

- [ ] **Step 3: Write the migration**

Create `apps/api/src/database/migrations/1780300000000-AddMenuItemBadgeType.ts`:

```typescript
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds menu_items.badge_type — an optional monochrome merchandising
 * badge surfaced on the iOS product detail screen.
 *
 *   menu_items.badge_type  ('signature' | 'staff_pick' | 'seasonal' | NULL)
 *
 * Nullable with NO default and NO backfill: the overwhelming majority of
 * items carry no badge, and "no badge" is the fail-safe rendering
 * (Golden Rule #17 — iOS shows nothing when the value is null/unknown).
 * The allowed value set is enforced in application code, not a DB CHECK,
 * to match the existing text-enum columns (temperature, display_style)
 * which also rely on app-level validation + fail-safe decoding.
 *
 * PublicMenuItem in menu.service.ts surfaces the field verbatim; the
 * menu cache namespace is bumped to v3 in the same slice because the
 * cached payload shape gains a field (see decision-log 2026-05-28).
 *
 * down() drops the column.
 */
export class AddMenuItemBadgeType1780300000000 implements MigrationInterface {
    name = 'AddMenuItemBadgeType1780300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "menu_items" ADD "badge_type" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "menu_items" DROP COLUMN "badge_type"`);
    }
}
```

- [ ] **Step 4: Run the spec, verify it passes**

Run: `npm test -- 1780300000000-AddMenuItemBadgeType.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/database/migrations/1780300000000-AddMenuItemBadgeType.ts \
        apps/api/src/database/migrations/1780300000000-AddMenuItemBadgeType.spec.ts
git commit -m "feat(api): add nullable menu_items.badge_type column

Optional monochrome merchandising badge (signature/staff_pick/seasonal).
Nullable, no default, no backfill — 'no badge' is the fail-safe norm
(GR#17). Allowed values enforced in app code like the other text enums.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add `badge_type` to the entity

**Files:**
- Modify: `apps/api/src/database/entities.ts` (the `MenuItem` class, after `art_token`, around line 401)

- [ ] **Step 1: Add the column to the entity**

In `apps/api/src/database/entities.ts`, inside `class MenuItem`, immediately after the `art_token` column block (the one ending `art_token!: string | null;` near line 401) and before the `@Column({ type: 'boolean', default: true }) active!: boolean;` block, insert:

```typescript
  /**
   * Optional monochrome merchandising badge shown on the iOS product
   * detail screen: 'signature' | 'staff_pick' | 'seasonal' | null.
   * Nullable; the value set is validated in app code (no DB CHECK,
   * matching temperature / display_style). iOS decodes fail-safe —
   * unknown / null renders no badge (Golden Rule #17). Never carries
   * social-proof numbers.
   */
  @Column({ type: 'text', nullable: true })
  badge_type!: string | null;
```

- [ ] **Step 2: Verify the project still compiles**

Run: `npm run build`
Expected: build succeeds (no TypeScript errors).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/database/entities.ts
git commit -m "feat(api): map badge_type on the MenuItem entity

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Expose `badge_type` in the public menu payload (TDD)

**Files:**
- Modify: `apps/api/src/modules/menu/menu.service.spec.ts`
- Modify: `apps/api/src/modules/menu/menu.service.ts` (interface line ~50; mapping sites ~131 and ~270; test fixture)

- [ ] **Step 1: Extend the test fixture to carry a badge**

In `apps/api/src/modules/menu/menu.service.spec.ts`, in the `item()` fixture builder (around lines 29–41), add a `badge_type` line right after the `art_token` line:

```typescript
    art_token: overrides.art_token ?? 'strawberry-matcha',
    badge_type: overrides.badge_type ?? 'signature',
```

- [ ] **Step 2: Write the failing assertions**

In `apps/api/src/modules/menu/menu.service.spec.ts`, add two tests inside the existing `describe('MenuService — v4 presentation fields', …)` block (right after the existing `getItemById() returns temperature / featured / art_token` test, around line 123):

```typescript
  it('getFullMenu() exposes badge_type on each item', async () => {
    const menu = await service.getFullMenu(LOC);
    const it = menu.categories[0].items[0];
    expect(it.badge_type).toBe('signature');
  });

  it('getItemById() returns badge_type', async () => {
    const payload = await service.getItemById('item-strawberry');
    expect(payload.badge_type).toBe('signature');
  });
```

- [ ] **Step 3: Run the tests, verify they fail**

Run: `npm test -- menu.service.spec.ts`
Expected: FAIL — the two new tests report `expected 'signature', received undefined` (the service doesn't map the field yet). The TypeScript may also flag `it.badge_type` as not existing on `PublicMenuItem` — proceed to Step 4.

- [ ] **Step 4: Add `badge_type` to the `PublicMenuItem` interface**

In `apps/api/src/modules/menu/menu.service.ts`, in `interface PublicMenuItem` (around lines 36–51), add after the `art_token` line:

```typescript
  /** Opaque key the iOS app maps to a drawn abstract drink symbol. */
  art_token: string | null;
  /** Optional monochrome badge ('signature' | 'staff_pick' | 'seasonal'); null = none. */
  badge_type: string | null;
```

- [ ] **Step 5: Map it at both build sites**

In `getItemById()` (the `payload` object, around line 131), after `art_token: item.art_token,` add:

```typescript
      art_token: item.art_token,
      badge_type: item.badge_type,
```

In `getFullMenu()` (the item `.map(...)`, around line 270), after `art_token: it.art_token,` add:

```typescript
          art_token: it.art_token,
          badge_type: it.badge_type,
```

- [ ] **Step 6: Run the tests, verify they pass**

Run: `npm test -- menu.service.spec.ts`
Expected: PASS (all tests in the file, including the two new ones).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/menu/menu.service.ts apps/api/src/modules/menu/menu.service.spec.ts
git commit -m "feat(api): surface badge_type in the public menu payload

PublicMenuItem gains badge_type; mapped in both getMenu and getItemById.
Tests assert it round-trips on each item.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Bump the menu cache namespace v2 → v3

The cached `PublicMenuItem` shape gains `badge_type`, so per the 2026-05-28 decision-log rule the cache namespace must be bumped to avoid serving pre-shape JSON during the 10-minute TTL after deploy.

**Files:**
- Modify: `apps/api/src/modules/menu/menu.cache.ts`
- Modify: `docs/architecture.md`, `docs/glossary.md`, `docs/troubleshooting.md`

- [ ] **Step 1: Bump the key prefixes and the comment in `menu.cache.ts`**

In `apps/api/src/modules/menu/menu.cache.ts`, change the three key builders (lines 15–17):

```typescript
const FULL_KEY = (locationId: string) => `menu:v3:full:${locationId}`;
const ITEM_KEY = (itemId: string) => `menu:v3:item:${itemId}`;
const ITEMS_BY_LOC_KEY = (locationId: string) => `menu:v3:items:loc:${locationId}`;
```

Then update the version note in the comment block just above (the sentence beginning "v2 bump landed…"). Append:

```
// v3 bump landed with the product-detail-v2 work (PublicMenuItem gains
// badge_type) for the same reason.
```

Also update the two doc-comment lines (around lines 22–25) that read `menu:v2:full:{locationId}` / `menu:v2:item:{itemId}` / `menu:v2:items:loc:{locationId}` to `v3`.

- [ ] **Step 2: Verify the cache tests still pass**

Run: `npm test -- menu.cache`
Expected: PASS. (If no dedicated cache spec exists, run `npm test -- menu` and confirm green.)

- [ ] **Step 3: Sync the four doc references**

Replace every `menu:v2:` with `menu:v3:` in the three docs. Verify the set of occurrences first:

Run (from repo root `/Users/atamurad/Desktop/pulse-platform`): `grep -rn "menu:v2" docs/architecture.md docs/glossary.md docs/troubleshooting.md`
Expected matches: `architecture.md` lines ~109–135, `glossary.md` lines ~81–83, `troubleshooting.md` lines ~81–97.

Edit each occurrence `menu:v2:` → `menu:v3:` in those three files. **Do not** edit `docs/decision-log.md` line 2727 — that entry is a historical record of the v2 decision and must stay verbatim.

- [ ] **Step 4: Confirm no stray v2 refs remain (except the decision-log history)**

Run (repo root): `grep -rn "menu:v2" docs/ apps/api/src --include="*.md" --include="*.ts"`
Expected: only `docs/decision-log.md:2727` (and any other historical decision-log lines) remain.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/menu/menu.cache.ts docs/architecture.md docs/glossary.md docs/troubleshooting.md
git commit -m "chore(api): bump menu cache namespace v2->v3 for badge_type

PublicMenuItem gained a field, so old-shape cached blobs must be
unreachable on read (decision-log 2026-05-28). Docs synced; the v2
decision-log entry is left as historical record.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Rewrite the modifier seed + boutique descriptions

No unit test exists for `seed-menu.ts` (it is a DB script, matching the repo convention that seeds aren't unit-tested). Verification is: it compiles/lints, runs idempotently against a fresh dev DB, and a SQL spot-check confirms the new catalog. The data itself is plain constants.

**Files:**
- Modify: `apps/api/scripts/seed-menu.ts`

- [ ] **Step 1: Replace the `MILK` group spec** (around lines 138–152)

```typescript
const MILK: GroupSpec = {
  required: true,
  multi_select: false,
  sort_order: 1,
  modifiers: [
    // Display order per brief: Oat first. Default resolves to the
    // cheapest option (Whole, 0¢) on iOS, NOT the first by sort_order,
    // so a premium milk is never the default (brief anti-requirement).
    { name: 'Oat',       price_cents: 75,  sort_order: 0 },
    { name: 'Whole',     price_cents: 0,   sort_order: 1 },
    { name: 'Almond',    price_cents: 75,  sort_order: 2 },
    { name: 'Coconut',   price_cents: 75,  sort_order: 3 },
    { name: 'Pistachio', price_cents: 150, sort_order: 4 },
  ],
};
```

- [ ] **Step 2: Replace the `SWEETNESS` group spec** (around lines 154–163)

```typescript
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
```

- [ ] **Step 3: Replace the two `EXTRAS_*` group specs** (around lines 165–181)

Rename `EXTRAS_ESPRESSO` → `EXTRAS_COFFEE`, move both to `sort_order: 3` (after Sweetness, per brief group order), and add the coffee syrups:

```typescript
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
```

- [ ] **Step 4: Update `groupsForItem` so Sweetness is matcha-only and Extras uses the renamed coffee group** (around lines 193–206)

Replace the function body's group-assembly section with:

```typescript
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
```

Also update the function's doc comment (lines ~183–192): Sweetness is now **matcha only** (was "all drinks"), and coffee Extras are espresso shot + syrups.

- [ ] **Step 5: Rewrite item descriptions to boutique one-liners**

In the `CATEGORIES` array (around lines 282–319), replace each item's `description` value (leave all other fields untouched):

Matcha:
- Strawberry Matcha → `'Ceremonial matcha, oat milk & strawberry purée'`
- Raspberry Matcha → `'Ceremonial matcha, oat milk & raspberry'`
- Brown Sugar Matcha → `'Ceremonial matcha, oat milk & brown sugar'`
- Ginger Matcha → `'Ceremonial matcha, oat milk & fresh ginger'`

Classic Coffee:
- Cappuccino → `'Double espresso, steamed milk & velvet foam'`
- Latte → `'Espresso, steamed milk & light foam'`
- Americano → `'Double espresso & hot water'`
- Flat White → `'Double ristretto & silky microfoam'`
- Cortado → `'Equal parts espresso & steamed milk'`
- Cold Brew → `'18-hour cold brew, single origin'`
- Espresso → `'House blend, double shot'`

Food:
- Butter Croissant → `'Flaky French butter, baked fresh'`
- Mini Khachapuri → `'Georgian cheese bread, served warm'`
- Blueberry Muffin → `'Fresh blueberries, gluten-free'`
- Chocolate Cookie → `'Dark chocolate & sea salt'`

- [ ] **Step 6: Verify it compiles and lints**

Run: `npm run build`
Expected: success (confirms `EXTRAS_ESPRESSO` has no remaining references — the rename is complete).

Run: `npm run lint`
Expected: no errors in `scripts/seed-menu.ts`.

- [ ] **Step 7: Run the seed against a clean dev DB and spot-check**

Because `seed:menu` does NOT delete options dropped from the catalog (2% / Skim / Half & Half / Soy milks; Regular / Unsweetened sweetness will linger on an already-seeded DB), do a clean re-seed:

Run (from `apps/api/`):
```bash
docker compose down -v
docker compose up -d postgres redis
npm run migration:run
npm run seed:dev
npm run seed:menu
```
Expected: `seed:menu complete:` summary with non-zero modifier inserts.

Spot-check the catalog (adjust container name if different — see memory note `pulse-postgres on 5433`):
```bash
docker exec pulse-postgres psql -U postgres -d pulse -c \
  "SELECT mi.name AS item, mg.name AS grp, mg.sort_order, m.name AS modifier, m.price_cents \
   FROM menu_items mi \
   JOIN modifier_groups mg ON mg.item_id = mi.id \
   JOIN modifiers m ON m.group_id = mg.id \
   WHERE mi.name IN ('Ginger Matcha','Latte','Espresso') \
   ORDER BY mi.name, mg.sort_order, m.sort_order;"
```
Expected, confirming the brief:
- **Ginger Matcha** → Size(0), Milk(1) {Oat 75, Whole 0, Almond 75, Coconut 75, Pistachio 150}, Sweetness(2) {Full 0, Half 0}, Extras(3) {Add matcha shot 100}.
- **Latte** → Size(0), Milk(1) {5 milks}, Extras(3) {Add espresso shot 100, Vanilla 50, Caramel 50, Brown sugar 25}, **no Sweetness**.
- **Espresso** → Extras(3) only (no Size, no Milk, no Sweetness).

- [ ] **Step 8: Commit**

```bash
git add apps/api/scripts/seed-menu.ts
git commit -m "feat(api): product-detail-v2 modifier catalog + boutique copy

- Milk: 5 options (Oat, Whole, Almond, Coconut, Pistachio); Oat shown
  first but Whole stays the default via iOS cheapest-option rule.
- Sweetness: matcha-only, Full/Half sweet (Unsweetened removed).
- Extras: coffee gets syrups (vanilla/caramel/brown sugar) alongside
  the espresso shot; matcha keeps the matcha shot.
- Group order Size -> Milk -> Sweetness -> Extras per brief.
- One-line boutique ingredient descriptions for every item.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Record the deferred endpoints/fields

**Files:**
- Create: `docs/todo-endpoints.md`

- [ ] **Step 1: Create the TODO-seams doc**

Create `docs/todo-endpoints.md`:

```markdown
# Deferred Endpoints & Fields — TODO Seams

Things the Product Detail v2 work (2026-05-29) deliberately did **not**
build, recorded here so they aren't forgotten. Each has a corresponding
`// TODO:` comment at the iOS call site that will consume it.

| Seam | Needed by | Notes |
|---|---|---|
| `GET /orders/history?itemId=…` (or per-item "have I ordered this?") | iOS real "Your Usual ✓ — … + Apply" line | MVP ships a static "Pulse recommends …" line instead. No order-history API is consumed by iOS today. |
| Favorites sync endpoints (`GET/PUT /me/favorites`) | iOS favorite heart backend sync | MVP stores favorites locally (UserDefaults, keyed by item ID). Local-only until this lands. |
| Queue-based ready-time estimate | iOS "Ready in ~4 min" pill | MVP hardcodes `~4 min`. Replace with a real per-location queue estimate. |
| `menu_items.serving_size` (e.g. oz label) | iOS fixed-size metadata line ("Espresso · 4 oz · Hot") | MVP hardcodes the oz label for the 3 fixed-size drinks on iOS. A backend field would make it data-driven. |
| Nutrition fields (kcal / caffeine_mg / allergens) | iOS optional `ⓘ` bottom sheet (#18) | Hidden entirely for MVP. |

When any of these is built, search the iOS codebase for the matching
`// TODO:` to find the exact consumption point.
```

- [ ] **Step 2: Commit**

```bash
git add docs/todo-endpoints.md
git commit -m "docs: record deferred endpoints/fields for product-detail-v2

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Record the design decisions in the decision-log

Per CLAUDE.md §4, the non-obvious choices in this slice need a decision-log entry so a future reader doesn't "fix" them. This is also where the redundant-stale-data handling is documented.

**Files:**
- Modify: `docs/decision-log.md` (append a new dated entry at the end)

- [ ] **Step 1: Append the entry**

Add to the end of `docs/decision-log.md`:

```markdown
## 2026-05-29 — [api] Product Detail v2 modifier catalog + stale-option handling

**Decision:** The Product Detail v2 seed rewrite makes four non-obvious choices:
1. **No `is_default` column.** iOS resolves a required single-select group's default to the **cheapest option** (lowest `price_cents`, tie-break lowest `sort_order`), not the first by `sort_order`. So Milk renders `Oat` first (brief's display order) yet defaults to `Whole` (0¢) — a premium milk is never the default, and the detail screen opens at the same price the menu list shows.
2. **Sweetness is `required` and matcha-only.** `Unsweetened`/`Regular` removed (matcha has intrinsic sweetness); `Full sweet`/`Half sweet` only, both 0¢, `Full sweet` default (`sort_order` 0). Required guarantees a fail-safe default (GR#17). Coffee drinks get no Sweetness group — they get syrups under Extras instead.
3. **`EXTRAS_ESPRESSO` → `EXTRAS_COFFEE`.** Coffee keeps `Add espresso shot` (removing a live option is a regression) and gains `Vanilla`/`Caramel` (+50¢) and `Brown sugar` (+25¢). Group order is now Size → Milk → Sweetness → Extras (`sort_order` 0/1/2/3).
4. **`badge_type` ships as plumbing only.** Nullable column, all items seeded `null`, exposed in `PublicMenuItem`, rendered monochrome on iOS only when present. No fake badges, no social-proof numbers.

**Context:** The brief ("Product Detail Screen v2") asked for a 5-milk lineup with Oat shown first, matcha-only sweetness, coffee syrups, and an optional badge — while the v1 seed had 8 milks (free Whole default), all-drinks sweetness, and an espresso-shot-only Extras group.

**Alternatives considered:**
- *Add an `is_default` boolean to `Modifier`.* Rejected — the cheapest-option rule on iOS achieves the same result with zero schema change (GR#15). Revisit only if a paid option ever needs to be the default.
- *Make the seed auto-delete options dropped from the catalog.* Rejected — see trade-offs; it would break the seed's documented "never overwrite operator state" guarantee.
- *A DB `CHECK` constraint on `badge_type`.* Rejected — matches the existing text-enum columns (`temperature`, `display_style`) that validate in app code + decode fail-safe.

**Reasoning:** Smallest change that satisfies the brief. All variability (which drink gets which groups) stays in `groupsForItem()`, so iOS is a generic renderer with near-zero per-drink conditionals.

**Trade-offs — STALE MODIFIER DATA (the "redundant backend" hazard):** `seed:menu` is idempotent by **upsert**, not by **replace** — it never deletes groups/modifiers that exist in the DB but are absent from the new catalog (this protects operator-set sold-out flags; see the seed file header). So on a DB previously seeded with the v1 catalog, the dropped milks (`2%`, `Skim`, `Half & Half`, `Soy`) and sweetness options (`Regular`, `Unsweetened`) **linger as active rows and still render**. Handling:
- **Dev:** clean re-seed — `docker compose down -v` → `migration:run` → `seed:dev` → `seed:menu`. (Documented in the seed file header and the v2 backend plan.)
- **Prod-like / non-wipeable:** deactivate the obsolete modifiers manually (`active=false`), do not hard-delete (order history references them by snapshot, but the modifier rows should be retained for referential safety).
- **Future, if this recurs:** a `cleanup-obsolete-modifiers.ts` script (mirroring `cleanup-duplicate-categories.ts`) that deactivates modifiers/groups not in the current catalog. **Deliberately not built now** — premature for a ~50-row dev catalog (§2.2 / GR#15).
```

- [ ] **Step 2: Commit**

```bash
git add docs/decision-log.md
git commit -m "docs: record product-detail-v2 seed decisions + stale-data handling

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Full-suite verification

- [ ] **Step 1: Run the entire backend test suite**

Run (from `apps/api/`): `npm test`
Expected: all suites pass (migrations, menu service, cache, checkout, orders, etc. — nothing regressed).

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 3: Report status**

Confirm to the human: all tests green, build clean, branch `feat/api/menu-modifiers-v2` ready for review/PR. Do **not** push or open a PR without explicit approval (CLAUDE.md §8). The iOS slice (Plan 2) should be started only after this branch merges to `main`, so iOS builds against the real catalog.

---

## Self-review (completed by plan author)

**Spec coverage** (spec §4 backend slice):
- §4.1 milk / sweetness / extras / group order → Task 5 ✅
- §4.2 boutique descriptions → Task 5 Step 5 ✅
- §4.3 `badge_type` column + payload exposure → Tasks 1, 2, 3 ✅
- §4.4 cache bump v2→v3 + doc sync → Task 4 ✅
- §4.5 TODO-seams doc → Task 6 ✅
- §4.6 tests → Tasks 1, 3 (migration + service); seed verified by run (Task 5, full suite Task 8) ✅
- Decision-log entry (CLAUDE.md §4) + stale-data handling → Task 7 ✅

**Placeholder scan:** no TBD/TODO-as-work; the `// TODO:` strings created in Task 6 are intentional deferred-seam markers, not plan gaps. ✅

**Type consistency:** `badge_type: string | null` used identically in the entity (Task 2), `PublicMenuItem` (Task 3), and both mapping sites (Task 3). `EXTRAS_COFFEE` rename is applied at both the definition (Task 5 Step 3) and the only reference (Task 5 Step 4); Task 5 Step 6 build catches any missed reference. Group `sort_order`s (Size 0, Milk 1, Sweetness 2, Extras 3) are consistent across Steps 1–4 and the Step 7 spot-check. ✅
