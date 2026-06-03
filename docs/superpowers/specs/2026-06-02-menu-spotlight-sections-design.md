# Menu Spotlight-for-All Sections — Design

**Date:** 2026-06-02
**Status:** Approved design — ready for implementation planning
**Surface:** `apps/ios` (SwiftUI) + `apps/api` (one small migration + seed)
**Audience:** the `/superpowers:writing-plans` planner and the implementing engineer.

---

## 1. Goal & gap

Today only the **Matcha** category uses the hero layout (`display_style == spotlight` → `SpotlightSection`: one hero card + a horizontal scroll of the rest). **Coffee** and **Food** use a plain vertical list. Heroes drive fast decisions and upsell, so we want all three sections to use a hero layout.

Two gaps make this more than "flip a flag":
1. `SpotlightSection` puts **all** non-hero items in one horizontal scroll. The desired layout is **hero + up to 3 sub-hero cards + the remaining items as a vertical list**.
2. Menu items are returned **alphabetically by name** (`menu.service.ts` orders `i.name ASC`; items have no sort order). Curated sub-heros (the fancy coffees first, regulars below) are impossible without item-level ordering.

This is solved with a small backend migration (`menu_items.sort_order`) + seed curation + an iOS layout change. **iOS stays layout-only** — the backend returns items pre-ordered; the app renders array order.

The hero-*decision* mechanism (admin-selected / sales-automated) is explicitly **future** — the `featured` flag is the lever; we set it by hand in the seed for now.

---

## 2. Scope

### In scope
- iOS: generalize `SpotlightSection` to hero + 3 horizontal sub-heros + vertical list (reusing `MenuListRow`); fix the hardcoded "N drinks" label → "N items".
- Backend: add `menu_items.sort_order` (migration + entity + service ordering). No public-DTO/iOS-model field (items arrive pre-ordered).
- Data: Coffee + Food → `display_style: spotlight`; seed `featured` heroes; add 4 signature iced lattes to Coffee with curated `sort_order`; Food hero = Mini Khachapuri.
- `DrinkArt` registry entries for the 4 new coffee tokens.
- Tests + docs.

### Out of scope (deferred / unchanged)
- **How an item becomes hero** (admin UI / sales automation) — future; `featured` is the manual lever for now.
- The per-item `temperature` field, checkout, payments, the category nav (just merged).
- Removing the `list` display style — kept (a future category may use it; `MenuListRow` is now also reused inside spotlight).
- Exposing `sort_order` in the public menu DTO / iOS model — not needed; the server returns items ordered.

---

## 3. What exists (reuse, don't rebuild)

| Asset | Location | Role / change |
|---|---|---|
| `SpotlightSection` | `Features/Menu/SpotlightSection.swift` | Generalize: hero + 3 sub-heros + vertical list. Already category-agnostic (hero by `featured`, else first; GR#17 fallback). |
| `MenuListRow` | `Features/Menu/MenuListRow.swift` | **Reused** for the vertical overflow list (same row as the old `list` style). |
| `DrinkArt` + registry | `Features/Menu/DrinkArt.swift` | Add 4 `classic`-kind tokens for the new coffees. `DrinkArtTests` enforces coverage. |
| `MenuItem` entity | `apps/api/src/database/entities.ts` | Add `sort_order` column. |
| `menu.service.ts` | `apps/api/src/modules/menu/` | Order items `sort_order ASC, name ASC` (was `name ASC`). |
| `seed-menu.ts` | `apps/api/scripts/` | Coffee/Food → spotlight; heroes; new coffees + `sort_order`. |
| `MenuView.section(for:)` | `Features/Menu/MenuView.swift` | No change — already routes `spotlight` → `SpotlightSection`. |

---

## 4. Architecture

### 4.1 Backend — item ordering (MODIFY)
- **Migration** `AddMenuItemSortOrder`: `ALTER TABLE "menu_items" ADD "sort_order" int NOT NULL DEFAULT 0` (`down`: drop column). Default 0 is safe — un-ordered items fall back to the secondary `name ASC`.
- **Entity** `MenuItem`: `@Column({ type: 'int', default: 0 }) sort_order!: number;`
- **`menu.service.ts`** (the items query, ~line 189): `.orderBy('i.sort_order', 'ASC').addOrderBy('i.name', 'ASC')` (was `.orderBy('i.name', 'ASC')`). The single-item endpoint is unaffected.
- **No public DTO / iOS model change** — items are returned in order; iOS uses array order.

### 4.2 Seed — display style, heroes, new coffees (MODIFY `seed-menu.ts`)
- Add `sort_order` to the seed item shape; default omit ⇒ 0.
- **Matcha** — unchanged (`spotlight`; items keep default order; hero = featured Strawberry Matcha).
- **Coffee** — `display_style: 'spotlight'`. Items, in `sort_order`:
  | sort | Drink | price¢ | temp | featured | art_token |
  |---|---|---|---|---|---|
  | 0 | Iced Coconut Latte | 650 | iced | **true** | `iced-coconut-latte` |
  | 1 | Iced Salted Caramel Latte | 675 | iced | false | `iced-salted-caramel-latte` |
  | 2 | Iced Brown Sugar Oat Latte | 650 | iced | false | `iced-brown-sugar-oat-latte` |
  | 3 | Iced Vanilla Latte | 625 | iced | false | `iced-vanilla-latte` |
  | 4 | Latte | 550 | both | false | `latte` |
  | 5 | Cappuccino | 525 | both | false | `cappuccino` |
  | 6 | Cold Brew | 550 | iced | false | `cold-brew` |
  | 7 | Flat White | 525 | hot | false | `flat-white` |
  | 8 | Cortado | 475 | hot | false | `cortado` |
  | 9 | Americano | 450 | both | false | `americano` |
  | 10 | Espresso | 350 | hot | false | `espresso` |
  - Descriptions for the new four: Coconut — "Espresso, coconut milk & a sweet cream float"; Salted Caramel — "Espresso, salted caramel & cold milk"; Brown Sugar Oat — "Espresso, brown sugar & oat milk"; Vanilla — "Espresso, Madagascar vanilla & cold milk".
  - The new coffees are non-matcha ⇒ `groupsForItem` already assigns Milk + Size + Extras (Coffee). No modifier change.
- **Food** — `display_style: 'spotlight'`; `featured: true` on **Mini Khachapuri**; others `featured: false`. 4 items ⇒ hero + 3 sub-heros, no vertical list.

### 4.3 iOS — `SpotlightSection` layout (MODIFY)
- Body becomes: `sectionHeader` → `heroCard(hero)` → (if any) `scrollRow(subHeros)` → (if any) `verticalList(rest)`.
- New pure helpers (extend the existing `hero`/`nonHeroItems`):
  ```swift
  static let subHeroLimit = 3
  static func subHeroItems(in items: [MenuItem], hero: MenuItem) -> [MenuItem] {
      Array(nonHeroItems(in: items, hero: hero).prefix(subHeroLimit))
  }
  static func verticalItems(in items: [MenuItem], hero: MenuItem) -> [MenuItem] {
      Array(nonHeroItems(in: items, hero: hero).dropFirst(subHeroLimit))
  }
  ```
- `verticalList(_:)` renders `MenuListRow` per item (same wiring `MenuView` uses), `.padding(.horizontal, 16)`.
- **Label fix:** `sectionHeader` "\(count) drinks" → "\(count) items" (correct for Food).
- Update the file's doc comment: items now arrive ordered `sort_order, name` (not `name ASC`); the hero is still the first `featured`/first item; sub-heros are the first 3 non-hero in that order; the rest list vertically.

### 4.4 `DrinkArt` registry — new coffee tokens (MODIFY `DrinkArt.swift`)
Add 4 `classic`-kind entries with milk/espresso gradient palettes:
- `iced-coconut-latte` — pale-coconut cream → espresso.
- `iced-salted-caramel-latte` — caramel/amber → espresso.
- `iced-brown-sugar-oat-latte` — warm oat-brown → espresso.
- `iced-vanilla-latte` — vanilla-cream → espresso.
Exact stops are the engineer's call within the existing `classic` palette convention; `DrinkArtTests.test_registry_includesAllSeededV4Tokens` makes a missing entry fail loudly.

---

## 5. Data flow

```
API (menu.service: items ORDER BY sort_order, name) → Menu
MenuView.section(for: category):
  spotlight → SpotlightSection(category)
    hero        = first featured item, else first        (GR#17 fallback)
    subHeros    = next up to 3 non-hero items (array order = sort_order)
    verticalRest= remaining non-hero items
    render: header("N items") + heroCard + scrollRow(subHeros) + verticalList(rest)
```

No money/auth/checkout touched. iOS reads array order; backend owns ordering.

---

## 6. Error handling / fail-safe (Golden Rule #17)

- `hero(in:)` returns the first item when nothing is featured, `nil` only for an empty category → the section renders nothing rather than crashing.
- `subHeroItems` / `verticalItems` are total functions over any list length: 0 non-hero ⇒ both empty (hero only); ≤3 ⇒ all sub-heros, empty vertical; >3 ⇒ 3 sub-heros + remainder vertical.
- A new coffee with a missing `DrinkArt` token degrades to the neutral fallback spec (already implemented), never a blank/crash.
- Migration default `0` keeps any un-ordered/legacy item valid (sorts by name).

---

## 7. Testing

- **`SpotlightSection` helpers** (pure, unit): `subHeroItems` caps at 3 and preserves order; `verticalItems` is the post-3 remainder; ≤4-item category ⇒ empty vertical; hero excluded from both; empty category ⇒ hero `nil`.
- **`DrinkArt`**: the existing registry-coverage test now also asserts the 4 new tokens resolve to non-fallback `classic` specs.
- **Migration**: a `*.spec.ts` mirroring the existing migration specs — `up()` adds `sort_order` with default 0; `down()` drops it.
- **Backend service**: items come back ordered by `sort_order` then `name` (extend the menu service test if it pins ordering; otherwise a focused new assertion).
- Full iOS suite + `npm test` green; clean re-seed + simulator walk (each section shows hero + 3 cards; Coffee shows the vertical regulars; "items" label on Food).

---

## 8. Golden Rules

- **#15 (ship boring/reliable):** reuses the proven hero card, compact card, and list row; the only new logic is two pure split functions + one ORDER BY.
- **#17 (non-critical fails safe):** hero/sub-hero/vertical split and art tokens all degrade safely; never block the menu/cart path.
- **#13 (locations from day one):** untouched — items stay location-scoped via the existing query.
- **#7 (integer cents):** new item prices are integer cents.

---

## 9. Docs to update (part of the work)

- **Decision-log:** the spotlight-for-all layout (hero + 3 + vertical), the `menu_items.sort_order` migration + ordering change, and the seed curation; note the hero-decision mechanism stays deferred.
- **`apps/ios/PulseCoffeeApp/Features/Menu/README.md`:** `SpotlightSection` now renders hero + 3 sub-heros + vertical list and is used by all three categories; `MenuListRow` is reused for the overflow.
- **`docs/todo-endpoints.md`:** record the deferred **hero-decision mechanism** (admin-select / sales-automated using the existing `featured` flag + new `sort_order`) — no endpoint today.
- Seed header comment + the `menu.service` ordering comment updated.

## 10. Deferred / todos (captured so nothing is reinvented)

- **Hero & ordering admin tooling** — `featured` (hero) and `sort_order` (sub-hero/vertical tiering) are seed-set today. A manager dashboard or a sales-driven automation to set them is future work (relates to drink-options Part C). The data levers now exist; **no endpoint added here.**
- **`list` display style** stays available for any future plain-list category.

---

## 11. As-built notes (2026-06-03)

The implementation diverged from §1–§10 in three founder-driven ways; recorded here so the spec matches reality:

- **One category at a time (replaces the design's stacked sections).** The original design kept all sections scrolling with the category nav. As built, the category bar is a **selector**: tapping a tab shows only that category's section. The scroll-spy nav from the earlier menu-category-nav work was removed as part of this.
- **Deeper Matcha & Food menus.** Beyond Coffee, Matcha and Food were each deepened to 7 items so they also have a vertical list: Matcha keeps the fruit drinks as sub-heros and adds Iced Classic / Vanilla / Blueberry to the vertical list; Food adds Pain au Chocolat / Cinnamon Roll (sub-heros) + Everything Bagel (vertical), with 3 new `DrinkArt` food tiles.
- **BrandFooter + tab-bar inset.** The menu scroll's bottom inset is sized to clear the 72pt `PulseTabBar` (the last item was hidden under it), and that space holds a reusable `Core/BrandFooter.swift` Pulse wordmark.

Decision-log: see the 2026-06-03 entries ([api] sort_order, [menu] spotlight-for-all + one-category, [ios] BrandFooter, [docs] Golden Rules #18/#19).
