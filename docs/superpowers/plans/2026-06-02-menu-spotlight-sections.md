# Menu Spotlight-for-All Sections — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every spotlight category render **hero + up to 3 sub-hero cards + a vertical list of the rest**; turn Coffee & Food into spotlight sections (Coffee gains 4 signature iced lattes); add `menu_items.sort_order` so sub-heros are curated, not alphabetical.

**Architecture:** iOS layout change in `SpotlightSection` (reuses the hero card, compact cards, and `MenuListRow`) + a small backend migration (`menu_items.sort_order`, ordered `sort_order, name`) + seed curation + 4 new `DrinkArt` tokens. iOS stays layout-only — the backend returns items pre-ordered.

**Tech Stack:** SwiftUI (**iOS 16**, XcodeGen), XCTest; NestJS + TypeORM (Postgres), Jest. iOS build/test from `apps/ios/`: `make build|test SIMULATOR_DESTINATION='platform=iOS Simulator,name=iPhone 17 Pro'`. Backend from `apps/api/`: `npm run build`, `npm test`.

**Branch:** `feat/ios/menu-spotlight-sections` (off `main` @ `b662562`; spec committed `48b7780`).

> **Commit policy (CLAUDE.md §8):** each task ends with a commit; the human approves. Don't push. No new iOS files are added (no `make project` needed).

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `apps/api/src/database/migrations/1780400000000-AddMenuItemSortOrder.ts` | Create | `menu_items.sort_order` column |
| `…/1780400000000-AddMenuItemSortOrder.spec.ts` | Create | migration up/down test |
| `apps/api/src/database/entities.ts` | Modify | `MenuItem.sort_order` |
| `apps/api/src/modules/menu/menu.service.ts` | Modify | order items `sort_order, name` |
| `apps/api/scripts/seed-menu.ts` | Modify | `SeedItem.sort_order` + `ArtToken` tokens + upsert + Coffee/Food blocks |
| `apps/ios/PulseCoffeeApp/Features/Menu/SpotlightSection.swift` | Modify | hero + 3 sub-heros + vertical list; "items" label |
| `apps/ios/PulseCoffeeAppTests/SpotlightSectionTests.swift` | Modify | sub-hero/vertical split tests |
| `apps/ios/PulseCoffeeApp/Features/Menu/DrinkArt.swift` | Modify | 4 new `classic` tokens |
| `apps/ios/PulseCoffeeAppTests/DrinkArtTests.swift` | Modify | 4 tokens in the seeded list |
| `docs/decision-log.md`, Menu `README.md`, `docs/todo-endpoints.md` | Modify | record + deferred hero mechanism |

---

## Task 1: Backend — `menu_items.sort_order`

**Files:** Create the migration + spec; Modify `entities.ts`, `menu.service.ts`.

- [ ] **Step 1: Migration** — create `apps/api/src/database/migrations/1780400000000-AddMenuItemSortOrder.ts`:

```typescript
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds menu_items.sort_order — an integer display-order key within a
 * category. Items are returned ORDER BY sort_order ASC, name ASC, so the
 * v4 Menu's spotlight sub-heros are curated (the seed puts signature
 * drinks first) instead of alphabetical.
 *
 * NOT NULL DEFAULT 0: every existing/un-curated item sorts by the
 * secondary `name` key, so the column is safe to add without a backfill.
 * The value is NOT exposed in the public menu DTO — the service returns
 * items already ordered, so the cache payload shape is unchanged (no
 * cache-namespace bump needed).
 *
 * down() drops the column.
 */
export class AddMenuItemSortOrder1780400000000 implements MigrationInterface {
    name = 'AddMenuItemSortOrder1780400000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "menu_items" ADD "sort_order" integer NOT NULL DEFAULT 0`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "menu_items" DROP COLUMN "sort_order"`);
    }
}
```

- [ ] **Step 2: Migration spec** — create `apps/api/src/database/migrations/1780400000000-AddMenuItemSortOrder.spec.ts`:

```typescript
import { QueryRunner } from 'typeorm';
import { AddMenuItemSortOrder1780400000000 } from './1780400000000-AddMenuItemSortOrder';

function buildRunner() {
  return { query: jest.fn().mockResolvedValue(undefined) } as unknown as QueryRunner;
}

describe('AddMenuItemSortOrder1780400000000', () => {
  it('up() adds sort_order integer NOT NULL DEFAULT 0', async () => {
    const runner = buildRunner();
    await new AddMenuItemSortOrder1780400000000().up(runner);
    const sql = (runner.query as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(sql.some((s) => /ALTER TABLE "menu_items" ADD "sort_order" integer NOT NULL DEFAULT 0/.test(s))).toBe(true);
  });

  it('down() drops the sort_order column', async () => {
    const runner = buildRunner();
    await new AddMenuItemSortOrder1780400000000().down(runner);
    const sql = (runner.query as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(sql).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/ALTER TABLE "menu_items" DROP COLUMN "sort_order"/),
      ]),
    );
  });
});
```

- [ ] **Step 3: Entity** — in `apps/api/src/database/entities.ts`, in `class MenuItem`, add a column right after the `featured` column:

```typescript
  @Column({ type: 'int', default: 0 })
  sort_order!: number;
```

- [ ] **Step 4: Service ordering** — in `apps/api/src/modules/menu/menu.service.ts`, in `buildFullMenu`, change the items query order:

```typescript
      .andWhere('i.active = true')
      .orderBy('i.sort_order', 'ASC')
      .addOrderBy('i.name', 'ASC')
      .getMany();
```
(was `.orderBy('i.name', 'ASC')`). Leave the single-item endpoint unchanged.

- [ ] **Step 5: Build + test** — from `apps/api/`: `npm run build` (clean) then `npm test` (all green, incl. the new migration spec).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/database/migrations/1780400000000-AddMenuItemSortOrder.ts apps/api/src/database/migrations/1780400000000-AddMenuItemSortOrder.spec.ts apps/api/src/database/entities.ts apps/api/src/modules/menu/menu.service.ts
git commit -m "feat(api): menu_items.sort_order — curated item ordering

Items now return ORDER BY sort_order ASC, name ASC so the v4 Menu's
spotlight sub-heros are curated, not alphabetical. NOT NULL DEFAULT 0 (no
backfill); not exposed in the public DTO (items arrive pre-ordered).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Seed — spotlight Coffee/Food, heroes, signature lattes, sort_order

**Files:** Modify `apps/api/scripts/seed-menu.ts`.

- [ ] **Step 1: Extend `ArtToken`** — in the `ArtToken` union (the `| 'croissant' | … | 'cookie';` lines, ~76–79), add the 4 new tokens (e.g. append to the coffee line):

```typescript
  | 'cappuccino' | 'latte' | 'americano' | 'flat-white' | 'cortado' | 'cold-brew' | 'espresso'
  | 'iced-coconut-latte' | 'iced-salted-caramel-latte' | 'iced-brown-sugar-oat-latte' | 'iced-vanilla-latte'
  | 'croissant' | 'khachapuri' | 'muffin' | 'cookie';
```

- [ ] **Step 2: Add `sort_order` to `SeedItem`** — make it optional (only Coffee curates; others default 0):

```typescript
interface SeedItem {
  name: string;
  description: string;
  base_price_cents: number;
  temperature: 'hot' | 'iced' | 'both';
  featured: boolean;
  art_token: ArtToken;
  sort_order?: number;
}
```

- [ ] **Step 3: Thread `sort_order` through the item upsert** — in the item upsert block (~411–432), add it to BOTH paths:
  - In the update branch (after `item.featured = seed.featured;`): `item.sort_order = seed.sort_order ?? 0;`
  - In the `itemRepo.create({...})` insert (after `featured: seed.featured,`): `sort_order: seed.sort_order ?? 0,`

- [ ] **Step 4: Replace the Coffee category block** with (display_style spotlight; signature lattes first; hero featured):

```typescript
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
```

- [ ] **Step 5: Replace the Food category block** with (display_style spotlight; hero = Mini Khachapuri):

```typescript
  {
    name: 'Food',
    sort_order: 2,
    display_style: 'spotlight',
    items: [
      { name: 'Mini Khachapuri',   description: 'Georgian cheese bread, served warm', base_price_cents: 800, temperature: 'both', featured: true,  art_token: 'khachapuri' },
      { name: 'Butter Croissant',  description: 'Flaky French butter, baked fresh',   base_price_cents: 450, temperature: 'both', featured: false, art_token: 'croissant' },
      { name: 'Blueberry Muffin',  description: 'Fresh blueberries, gluten-free',     base_price_cents: 375, temperature: 'both', featured: false, art_token: 'muffin' },
      { name: 'Chocolate Cookie',  description: 'Dark chocolate & sea salt',          base_price_cents: 325, temperature: 'both', featured: false, art_token: 'cookie' },
    ],
  },
```
(Food items omit `sort_order` → default 0 → ordered by name; the hero is the `featured` Khachapuri regardless of order, so all 4 → hero + 3 sub-heros, no vertical list.)

- [ ] **Step 6: Update the seed header comment** if it enumerates the Coffee items / display styles, so it reflects Coffee/Food now being `spotlight` and the new signature lattes (keep it accurate; the existing "Three categories: Matcha (spotlight), Coffee (list), Food (list)" line becomes all three `spotlight`).

- [ ] **Step 7: Build** — from `apps/api/`: `npm run build` → clean (the new `ArtToken`s + `sort_order` typecheck). The DB re-seed is verified in Task 6.

- [ ] **Step 8: Commit**

```bash
git add apps/api/scripts/seed-menu.ts
git commit -m "feat(api): Coffee+Food spotlight; signature iced lattes; curated sort_order

Coffee & Food become spotlight sections. Coffee gains 4 signature iced
lattes (hero = Iced Coconut Latte) ordered ahead of the regulars via
sort_order; Food hero = Mini Khachapuri. Needs a clean dev re-seed.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: iOS — `SpotlightSection` hero + 3 sub-heros + vertical list (TDD)

**Files:** Modify `apps/ios/PulseCoffeeApp/Features/Menu/SpotlightSection.swift`, `apps/ios/PulseCoffeeAppTests/SpotlightSectionTests.swift`.

- [ ] **Step 1: Add failing tests** — append inside `SpotlightSectionTests` (before the closing brace; reuses the existing `item(_:featured:)` helper):

```swift
    func test_subHeroItems_capsAtThree_inOrder() throws {
        let items = [item("h", featured: true), item("a"), item("b"), item("c"), item("d"), item("e")]
        let hero = try XCTUnwrap(SpotlightSection.hero(in: items))
        XCTAssertEqual(SpotlightSection.subHeroItems(in: items, hero: hero).map(\.id), ["a", "b", "c"])
    }

    func test_verticalItems_isRemainderAfterThree() throws {
        let items = [item("h", featured: true), item("a"), item("b"), item("c"), item("d"), item("e")]
        let hero = try XCTUnwrap(SpotlightSection.hero(in: items))
        XCTAssertEqual(SpotlightSection.verticalItems(in: items, hero: hero).map(\.id), ["d", "e"])
    }

    func test_subHeros_returnAll_andVerticalEmpty_whenThreeOrFewerNonHero() throws {
        let items = [item("h", featured: true), item("a"), item("b"), item("c")]
        let hero = try XCTUnwrap(SpotlightSection.hero(in: items))
        XCTAssertEqual(SpotlightSection.subHeroItems(in: items, hero: hero).map(\.id), ["a", "b", "c"])
        XCTAssertEqual(SpotlightSection.verticalItems(in: items, hero: hero), [])
    }

    func test_split_excludesHero() throws {
        let items = [item("a"), item("b"), item("h", featured: true), item("c"), item("d")]
        let hero = try XCTUnwrap(SpotlightSection.hero(in: items))
        let combined = SpotlightSection.subHeroItems(in: items, hero: hero)
            + SpotlightSection.verticalItems(in: items, hero: hero)
        XCTAssertFalse(combined.map(\.id).contains("h"), "Neither row may contain the hero")
        XCTAssertEqual(combined.map(\.id), ["a", "b", "c", "d"])
    }
```

- [ ] **Step 2: Run, verify it fails** — `make test …` → compile failure (`subHeroItems`/`verticalItems` undefined).

- [ ] **Step 3: Add the helpers** — in `SpotlightSection.swift`, extend the existing `extension SpotlightSection { … }` (which already has `hero` + `nonHeroItems`) with:

```swift
    /// Max items shown as horizontal sub-hero cards before the rest spill
    /// into the vertical list.
    static let subHeroLimit = 3

    /// The first `subHeroLimit` non-hero items (horizontal cards). Order
    /// is the backend-supplied order (`sort_order, name`).
    static func subHeroItems(in items: [MenuItem], hero: MenuItem) -> [MenuItem] {
        Array(nonHeroItems(in: items, hero: hero).prefix(subHeroLimit))
    }

    /// Non-hero items beyond the sub-hero cap — rendered as a vertical
    /// list (`MenuListRow`). Empty when there are ≤ `subHeroLimit` of them.
    static func verticalItems(in items: [MenuItem], hero: MenuItem) -> [MenuItem] {
        Array(nonHeroItems(in: items, hero: hero).dropFirst(subHeroLimit))
    }
```

- [ ] **Step 4: Rewire `body`** — replace the existing `body` with:

```swift
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader
            if let hero = Self.hero(in: category.items) {
                heroCard(for: hero)
                let subs = Self.subHeroItems(in: category.items, hero: hero)
                if !subs.isEmpty { scrollRow(items: subs) }
                let rest = Self.verticalItems(in: category.items, hero: hero)
                if !rest.isEmpty { verticalList(rest) }
            }
        }
        .padding(.bottom, 22)
    }
```

- [ ] **Step 5: Add `verticalList`** — add this method (next to `scrollRow`):

```swift
    /// Overflow items beyond the 3 sub-hero cards, as the same compact
    /// rows the `list` categories use.
    private func verticalList(_ items: [MenuItem]) -> some View {
        VStack(spacing: 6) {
            ForEach(items) { item in
                MenuListRow(
                    item: item,
                    onOpenDetail: { onOpenDetail(item) },
                    onAdd: { onAdd(item) }
                )
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
    }
```

- [ ] **Step 6: Fix the header label** — in `sectionHeader`, change `Text("\(category.items.count) drinks")` to:

```swift
            Text("\(category.items.count) items")
```

- [ ] **Step 7: Update the file's doc comment** — the top-of-file comment says items are ordered `name ASC` and describes only "hero + horizontal scroll". Update it to: items arrive ordered `sort_order, name`; layout is hero (first `featured`/first) + up to 3 sub-hero cards + remaining items in a vertical list; the row excludes the hero by ID.

- [ ] **Step 8: Run, verify it passes** — `make test …` (full suite green) and `make build …` (clean).

- [ ] **Step 9: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Menu/SpotlightSection.swift apps/ios/PulseCoffeeAppTests/SpotlightSectionTests.swift
git commit -m "feat(ios): spotlight section = hero + 3 sub-heros + vertical list

SpotlightSection now caps the horizontal row at 3 and spills the rest into
a vertical MenuListRow list (curated by the backend's sort_order). Header
reads 'N items' (correct for Food). Used by all spotlight categories.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: iOS — `DrinkArt` tokens for the 4 new coffees

**Files:** Modify `apps/ios/PulseCoffeeApp/Features/Menu/DrinkArt.swift`, `apps/ios/PulseCoffeeAppTests/DrinkArtTests.swift`.

- [ ] **Step 1: Register the 4 tokens** — in `DrinkArtRegistry.table`, add to the Classics group (after `"cortado": …`):

```swift
        // Signature iced lattes — milk-cream top → espresso bottom.
        "iced-coconut-latte":          .classic(stops: [0xFBF3E6, 0xE9D9BE, 0xB98E5E, 0x7A4F2C]),
        "iced-salted-caramel-latte":   .classic(stops: [0xF3DEC0, 0xD9A867, 0xA9692F, 0x6B3A1E]),
        "iced-brown-sugar-oat-latte":  .classic(stops: [0xF5E6CE, 0xCFA877, 0x9A6B3A, 0x5C3A1F]),
        "iced-vanilla-latte":          .classic(stops: [0xFDF6E8, 0xEBD9B3, 0xC2945A, 0x8B5A2B]),
```

- [ ] **Step 2: Extend the registry-coverage test** — in `DrinkArtTests.test_registry_includesAllSeededV4Tokens`, add the 4 tokens to the `seeded` array (e.g. after the coffee line):

```swift
            "cappuccino", "latte", "americano", "flat-white", "cortado", "cold-brew", "espresso",
            "iced-coconut-latte", "iced-salted-caramel-latte", "iced-brown-sugar-oat-latte", "iced-vanilla-latte",
            "croissant", "khachapuri", "muffin", "cookie",
```

- [ ] **Step 3: Build + test** — `make test …` → green (the 4 tokens resolve to non-fallback `classic` specs; `test_registry_includesAllSeededV4Tokens` passes).

- [ ] **Step 4: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Menu/DrinkArt.swift apps/ios/PulseCoffeeAppTests/DrinkArtTests.swift
git commit -m "feat(ios): DrinkArt tokens for the 4 signature iced lattes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Docs

**Files:** Modify `docs/decision-log.md`, `apps/ios/PulseCoffeeApp/Features/Menu/README.md`, `docs/todo-endpoints.md`.

- [ ] **Step 1: Decision-log** — append to `docs/decision-log.md`:

```markdown
## 2026-06-02 — [menu] Spotlight layout for all sections + menu_items.sort_order

**Decision:** Every spotlight category renders hero + up to 3 horizontal sub-hero cards + the remaining items as a vertical list (`MenuListRow`). Coffee and Food became `spotlight`; Coffee gained 4 signature iced lattes (hero = Iced Coconut Latte), regulars drop to the vertical list; Food hero = Mini Khachapuri. Added `menu_items.sort_order` (ordered `sort_order, name`) so sub-heros are curated, not alphabetical.

**Context:** Heroes drive fast decisions + upsell; only Matcha had the hero layout. Items were returned `name ASC`, so curated sub-heros were impossible.

**Reasoning:** `SpotlightSection` was already category-agnostic; the layout change is two pure split helpers + reusing `MenuListRow`. Ordering lives in the backend (`sort_order`), so iOS stays layout-only (renders array order). `sort_order` is reusable for future manager menu ordering. The hero is still the `featured` item (fail-safe to first).

**Trade-offs:** `sort_order` is not in the public DTO (items arrive ordered) — fine today, but a future client needing the raw value would add it then. The hero-*decision* mechanism (admin-select / sales-automation) stays deferred; `featured` + `sort_order` are the manual levers. A clean dev re-seed is required for the new Coffee items + display styles to appear.
```

- [ ] **Step 2: Menu README** — in `apps/ios/PulseCoffeeApp/Features/Menu/README.md`, update the `SpotlightSection` description to: hero + up to 3 sub-hero cards + a vertical `MenuListRow` list for the overflow, used by all spotlight categories (Matcha / Coffee / Food); note `MenuListRow` is reused for the overflow. Grep it first: `grep -niE "spotlight|hero|horizontal scroll|list style|drinks" apps/ios/PulseCoffeeApp/Features/Menu/README.md` and update stale lines.

- [ ] **Step 3: todo-endpoints** — add to the "Frontend follow-ups (not endpoints)" section (or a "Deferred backend seams" area, matching the file) in `docs/todo-endpoints.md`:

```markdown
- **Hero & item-ordering admin tooling.** The spotlight hero (`menu_items.featured`) and sub-hero/vertical tiering (`menu_items.sort_order`) are seed-set today. A manager dashboard or sales-driven automation to set them is future work (relates to the deferred manager-manageable-menu effort). The data levers exist; no endpoint added here.
```

- [ ] **Step 4: Commit**

```bash
git add docs/decision-log.md apps/ios/PulseCoffeeApp/Features/Menu/README.md docs/todo-endpoints.md
git commit -m "docs: record spotlight-for-all layout + sort_order; defer hero admin tooling

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Full verification

> Includes a **destructive dev-DB wipe** (`docker compose down -v`) — the seed upserts by name, so the display-style flips + new Coffee items need a clean re-seed. Local dev DB only. Controller-run (not a subagent).

- [ ] **Step 1: Backend** — from `apps/api/`: `npm run build` (clean) + `npm test` (green).
- [ ] **Step 2: iOS** — from `apps/ios/`: `make test …` (green) + `make build …` (clean).
- [ ] **Step 3: Clean re-seed**

```bash
cd apps/api
docker compose down -v
docker compose up -d --wait postgres redis
npm run migration:run
npm run seed:dev
npm run seed:menu
```
Expected: `seed:menu complete` with non-zero inserts.

- [ ] **Step 4: SQL spot-check** — categories all spotlight + Coffee ordered:

```bash
docker exec pulse-postgres psql -U pulse -d pulse -c \
"SELECT name, display_style FROM menu_categories ORDER BY sort_order;"
docker exec pulse-postgres psql -U pulse -d pulse -c \
"SELECT i.name, i.sort_order, i.featured FROM menu_items i JOIN menu_categories c ON i.category_id=c.id WHERE c.name='Coffee' ORDER BY i.sort_order, i.name;"
```
Expected: Matcha/Coffee/Food all `spotlight`; Coffee items in sort_order with Iced Coconut Latte (`sort_order 0`, `featured t`) first.

- [ ] **Step 5: Bust the Redis menu cache** (so the running API serves the re-seeded menu): `docker exec pulse-redis redis-cli FLUSHALL`.
- [ ] **Step 6: Simulator walk** — each section shows a hero + up to 3 sub-hero cards; Coffee shows the regular lattes in a vertical list below; Food header reads "4 items"; the new latte cards render real (non-fallback) art; add-to-cart works from hero, card, and vertical row.
- [ ] **Step 7: Report** — backend + iOS green, categories/ordering correct; branch ready for review/PR. Do not push without approval.

---

## Self-review (completed by plan author)

**Spec coverage (2026-06-02-menu-spotlight-sections-design.md):** §4.1 migration/entity/service ordering → Task 1 ✅ · §4.2 seed (display styles, heroes, new coffees, sort_order) → Task 2 ✅ · §4.3 SpotlightSection hero+3+vertical + "items" label + helpers → Task 3 ✅ · §4.4 DrinkArt 4 tokens → Task 4 ✅ · §6 fail-safe (hero nil/fallback, total split functions, art fallback, default 0) → Tasks 1/3/4 ✅ · §7 tests (split helpers, registry, migration, ordering) → Tasks 1/3/4 + Task 6 ✅ · §9 docs → Task 5 ✅ · §10 deferred hero mechanism → Task 5 Step 3 + decision-log ✅.

**Placeholder scan:** none — full migration + spec, exact entity/service/seed edits, complete SpotlightSection body/helpers/verticalList, concrete DrinkArt stops, exact test bodies. The Menu-README/seed-header edits give a grep + the precise content to write (prose, bounded).

**Type/consistency:** `subHeroItems`/`verticalItems(in:hero:)` signatures match between Task 3 impl, tests, and `body`; `subHeroLimit = 3`. `MenuListRow(item:onOpenDetail:onAdd:)` matches `MenuView`'s existing call. The 4 new `ArtToken`s (Task 2 Step 1) exactly match the 4 `DrinkArt` table keys (Task 4 Step 1) and the `DrinkArtTests` seeded list (Task 4 Step 2): `iced-coconut-latte`, `iced-salted-caramel-latte`, `iced-brown-sugar-oat-latte`, `iced-vanilla-latte`. Coffee hero = `featured: true` at `sort_order 0` ⇒ `hero(in:)` picks it, `subHeroItems` = sort 1–3 (the other fancy), `verticalItems` = sort 4–10 (regulars). Migration timestamp `1780400000000` > the latest existing (`1780300000000`). Prices integer cents (GR#7).
