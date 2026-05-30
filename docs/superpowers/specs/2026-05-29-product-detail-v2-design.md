# Product Detail Screen v2 — Design

**Date:** 2026-05-29
**Status:** Approved design — ready for implementation planning
**Surfaces:** `apps/api` (seed + one additive column) then `apps/ios` (SwiftUI)
**Supersedes the open items in:** `docs/superpowers/specs/2026-05-29-ios-product-detail-customization-design.md` (the v1 functional-core spec). v1 shipped the working customization core (`ItemCustomization` + `ItemDetailView` + the display-only pricing decision). v2 turns that functional screen into a **premium product page**.
**Audience:** the `/superpowers:writing-plans` planner and the implementing engineers.

---

## 1. Goal & the real gap

v1 closed the functional gap: a customer can now configure a drink (size, milk, …), see a live display price, and add it to the cart with required-group validation. The screen *works*, but it reads as a **customization form**, not a product page.

v2's goal, in the manager's words:

> *"This is your drink. Make it yours quickly."* — not *"Fill out this customization form."*

The customer should think less, see the price instantly, feel the drink is desirable, and add it in 1–2 taps. The change is **visual weight and focus**: the drink dominates, the modifiers serve, distractions (tab bar, "Customize" header, marketing copy) go away.

Scope is **the product detail screen only**. The rest of the app is not redesigned.

---

## 2. The one architectural idea that makes this safe

**iOS stays a generic renderer; all "matcha vs coffee" branching lives in the backend seed.**

The brief asks for behaviour that *looks* like per-drink logic:
- matcha drinks show `Half sweet / Full sweet`; coffee drinks show syrup extras and **no** sweetness group;
- fixed-size drinks (Espresso / Cortado / Flat White) show **no** Size group.

None of that is an iOS conditional. The backend's `groupsForItem()` already decides which modifier groups each item gets, and iOS renders whatever groups arrive, sorted by `sort_order`. So:

- iOS has **near-zero per-drink `if`s**. It draws groups generically (v1 already does this).
- Changing which drinks get which groups is a **seed change**, not an app release.
- The only genuinely iOS-side per-item bits are editorial/presentational: the fixed-size metadata line (shown when no Size group is present), the hardcoded "Pair with" list, and the "Pulse recommends" copy.

This keeps the risky/variable logic in one tested place (the seed) and the app dumb and robust.

---

## 3. Sequencing (decided)

**Backend slice lands first**, then the iOS slice builds against real data. They have different risk profiles (data/migration vs. UI) and iOS cannot render the new milks / sweetness / badges until the seed produces them. One concern per branch (CLAUDE.md §1.6):

1. `feat/api/menu-modifiers-v2` — seed rewrite + one additive column + TODO-seams doc. Merge to `main`.
2. `feat/ios/product-detail-customization` (existing branch, rebased on the merged backend) — the screen redesign + local favorites.

Each slice gets its own implementation plan.

---

## 4. Backend slice — `feat/api/menu-modifiers-v2`

### 4.1 Modifier seed rewrite (`apps/api/scripts/seed-menu.ts`)

Idempotent upsert semantics are unchanged (find-by-natural-key, never overwrite operator state). Only the **catalog data** changes.

> ⚠️ **Catalog-shrink caveat (already documented in the seed header):** `seed:menu` does **not** delete groups/modifiers that exist in the DB but not in the seed. Dropping milk options (2% / Skim / Half & Half / Soy) and Sweetness options (Regular / Unsweetened) from the spec will **not** remove them from a previously-seeded dev DB. The plan must call out a clean re-seed (`docker compose down -v` → migrate → `seed:dev` → `seed:menu`) **or** add a targeted cleanup step. This is a real data-hygiene task, not a no-op.

**Milk** (required, single-select, group `sort_order` 1) — exactly 5 options, in this display order:

| name | price_cents | sort_order |
|---|---|---|
| Oat | 75 | 0 |
| Whole | 0 | 1 |
| Almond | 75 | 2 |
| Coconut | 75 | 3 |
| Pistachio | 150 | 4 |

The **default** is resolved by iOS as "cheapest option" (§5.1), so it lands on **Whole (0¢)** even though Oat renders first. No `is_default` column needed.

**Sweetness** (matcha items only, required, single-select, group `sort_order` **2**) — 2 options, `Unsweetened`/`Regular` removed:

| name | price_cents | sort_order |
|---|---|---|
| Full sweet | 0 | 0 |
| Half sweet | 0 | 1 |

Brief default = **Full sweet**. Both options are 0¢, so there is no price tension with the "cheapest default" rule. To make `Full sweet` the default cleanly, seed it at `sort_order` 0 and keep the group **single-select**. The group should be **required** so the screen always shows a definite sweetness (fail-safe default guaranteed; GR#17). *(Display label order in the brief is `[Half sweet] [Full sweet]`; sort_order controls render order. If the manager wants Half rendered first but Full as default, that needs the `is_default` decoupling — flagged for the plan. Default assumption: render Full first, it is the default.)*

**Extras** (optional, multi-select, group `sort_order` **3** — renders after Sweetness, per brief #7):
- **Matcha items:** `Add matcha shot (+100¢)` — unchanged.
- **Coffee items:** `Add espresso shot (+100¢)` (kept — removing an existing customer-facing option is a regression) **plus** `Vanilla syrup (+50¢)`, `Caramel syrup (+50¢)`, `Brown sugar (+25¢)`.

`groupsForItem()` still excludes Size for `FIXED_SIZE` (Flat White, Cortado, Espresso), excludes Milk for `BLACK` (Americano, Cold Brew, Espresso), and gives Food no groups. **New rule:** Sweetness is added for **matcha only** (today it's added to all drinks).

**Resulting group sets:**
- Matcha: Size → Milk → Sweetness → Extras(matcha shot)
- Coffee (with milk, sized): Size → Milk → Extras(espresso shot + 3 syrups)
- Coffee (black / fixed-size): whatever remains after the exclusions (e.g. Espresso → Extras only)
- Food: none

All prices integer cents (GR#7).

### 4.2 Boutique descriptions

Rewrite each item's `description` to a one-line boutique ingredient string (quality adjective + ingredients, `&` before the last item). iOS already renders `description` as the tagline, so **#5 needs no iOS change**. Examples to apply:

- Ginger Matcha → `Ceremonial matcha, oat milk & fresh ginger`
- Cappuccino → `Double espresso, steamed milk & velvet foam`
- Cold Brew → `18-hour cold brew, single origin`

(The planner writes the full set, one line each, max two lines, no marketing paragraphs.)

### 4.3 `badge_type` column (additive, fail-safe)

- Migration + `MenuItem` entity: nullable `text` column `badge_type`, values `'signature' | 'staff_pick' | 'seasonal' | null`, default `null`.
- Expose in `PublicMenuItem` (and `getItemById`) so iOS can decode it.
- **Seed every item `null`** for now (Ginger Matcha included — no badge unless data says so). Ships the plumbing; no fake badges.
- iOS decodes fail-safe (unknown value / missing key → `nil`; GR#17) and renders a **monochrome** badge only when present (§5.3).

### 4.4 Cache namespace bump

`PublicMenuItem` gains `badge_type`, so per the 2026-05-28 decision-log rule, bump the menu cache namespace `menu:v2:*` → `menu:v3:*` in `apps/api/src/modules/menu/menu.cache.ts`, and update the four sync sites (`menu.cache.ts`, `docs/troubleshooting.md`, `docs/architecture.md`, `docs/glossary.md`).

### 4.5 Backend TODO-seams doc

New `docs/todo-endpoints.md` (or a section in `docs/ai-onboarding/backend.md`) recording the endpoints this feature anticipates but does **not** build, so they aren't forgotten:

- `GET /orders/history?itemId=…` (or equivalent) — powers real "Your Usual" on iOS.
- Favorites sync — persist the locally-stored favorite item IDs server-side.
- Queue-based ready-time estimate — replaces the hardcoded `~4 min`.
- Optional future `serving_size` field on `menu_items` (replaces the iOS-side fixed-size oz hardcode, §5.3).

### 4.6 Tests

- Seed unit/integration coverage that the new milk set (5, correct prices), matcha-only sweetness, and coffee extras are produced; existing seed-idempotency tests stay green.
- Migration up/down test for `badge_type` (mirrors `1780099200000-AddMenuPresentationFields.spec.ts`).
- `menu.service` test asserts `badge_type` is present in the payload.

---

## 5. iOS slice — `feat/ios/product-detail-customization`

Builds on the existing `ItemDetailView` / `ItemCustomization`. The screen, top to bottom (matches the brief's structure):

### 5.1 Default-selection rule change (`ItemCustomization`)

Change the interim default from **"first option by sort_order"** to **"cheapest option (lowest `priceCents`, tie-break lowest `sortOrder`)"** for each **required single-select** group. Consequence: Size → 12 oz (0¢), Milk → Whole (0¢) even though Oat renders first. Required multi-select and optional groups still start empty.

This honours the manager's "open at the cheapest valid config → detail price equals the menu's listed price, no jump on open" decision, without a backend `is_default` flag (GR#15). Sweetness is 0¢ across the board, so its default is whichever the seed sorts first (Full sweet).

Update the existing `test_defaultSelection_*` to assert the cheapest-by-price behaviour.

### 5.2 Hero (the drink is the hero)

- `DrinkArt` at ~**2× current size** (v1 used `size: 110`; target ~200+, tuned so drink + name + price + Size + Milk are visible without scrolling on iPhone 15 Pro). Layout built so the visual can later be swapped for an isolated render / photo / AI art without restructuring (a single sized container).
- **Favorite heart**, top-right, 28pt tap target. Empty `heart` (ink-faint) / saved `heart.fill` (accent-warm). Backed by a new `FavoritesStore` (UserDefaults, keyed by item ID — simpler than Core Data for an ID set; **TODO: backend sync** per §4.5). Non-critical → fail-safe (GR#17): a store error degrades to "not favorited", never blocks the screen.
- Name in serif (as v1).
- **Price** under the name, 18pt semibold, ink, centered, live. Labeled as an **estimate** (subtle "Est." treatment) to satisfy GR#8's "client total labeled as estimate" acceptance line.
- **"● Ready in ~4 min"** pill under the price: small, pulsing matcha-green dot. Hardcoded `~4 min`, **TODO: queue-based estimate** (§4.5). Approximate only — never an exact countdown. *(The pulsing dot is a live-status indicator, not decoration — it does not violate the "no autoplay animation" rule, which targets celebratory/casino effects.)*

### 5.3 Below the hero

- **"Pulse recommends: 16 oz · Oat · Full sweet"** — static, one line, ink-soft, brand voice (not social proof). **TODO: replace with real "Your Usual ✓ — … + Apply" once order history exists** (§4.5). No empty-state copy variant; this line is always the static recommend for MVP.
- **Static metadata line** ("Espresso · 4 oz · Hot") shown **only when the item has no Size group**. The oz label is an iOS-side hardcoded map for the 3 known fixed-size drinks (consistent with the brief's "hardcode for MVP" stance); temperature comes from the existing `temperature` field. **TODO: backend `serving_size` field** (§4.5).
- **Badge** (#16): monochrome only — solid ink background, warm-cream text, 9pt uppercase — rendered only when `badge_type != nil`. No numeric social proof anywhere.

### 5.4 Modifier groups

- **"Customize" header removed.**
- Groups rendered generically in `sort_order` (§2). 10pt uppercase labels, 0.08em tracking, 8pt spacing between groups.
- All milk options inline — **no "More" button** (the wrapping `FlowLayout` from v1 already handles 2 rows of pills).
- **Light haptic** (`UIImpactFeedbackGenerator(style: .light)`) on each pill tap.
- VoiceOver: each group labeled with its current selection (e.g. "Size, current selection 16 ounces").

### 5.5 "Pair with"

- Horizontal scroll above the sticky CTA. Heading `Pair with` (14pt semibold, not italic). Cards 130×100pt, 16pt radius: visual + name + price + `+`.
- Pairings **hardcoded by name** (matcha → Khachapuri, Croissant, Cookie; coffee → Croissant, Muffin, Cookie) and **resolved against the loaded menu's Food items**, which `MenuView` passes into `ItemDetailView` (the detail view currently receives only the single item; it will also receive the resolved pairing `[MenuItem]`). `+` does a quick-add to the cart. Inline and ignorable — not a popup. Unresolved names are simply skipped (fail-safe).

### 5.6 Sticky CTA

- Full-width, always visible via `.safeAreaInset(.bottom)` (v1 already does this). Ink background, warm-cream text, 14pt radius, 16pt padding, `safeAreaBottom + 8pt`.
- **Gradient fade** (transparent → background) above the bar so scroll content doesn't collide with it.
- Live total (= base + selected modifiers), labeled estimate (§5.2). Enabled once required groups are satisfied — guaranteed by defaults, so it is effectively always enabled (the v1 disabled-hint stays as a safety net).

### 5.7 Hide the tab bar on detail (replaces the brief's no-op API)

The brief's `.toolbar(.hidden, for: .tabBar)` **does nothing here**: `MainTabView` is a hand-rolled `ZStack` + custom `PulseTabBar` pinned with `.safeAreaInset`, not a system `TabView`. Mechanism instead:

- A lightweight shared chrome-visibility signal — a SwiftUI `PreferenceKey` set by `ItemDetailView` (or a small `@Observable` UI-state object injected via the environment) — that `MainTabView` reads to hide `PulseTabBar` while the detail is on the Menu nav stack, restored on back/pop.
- The detail page keeps the back button and the sticky CTA. Choose the `PreferenceKey` route if it stays local to the Menu→MainTabView path; use the observable if other screens will later need the same "focused mode."

### 5.8 Reliability

- **Loading skeleton** for the drink + price area while menu data is loading (not a blank screen).
- **Error state** with a retry button if menu data fails — never a silent fail.
- Dynamic Type supported; the sticky CTA must remain visible/usable at the largest text size (test at AX5).

---

## 6. Requirement → handling map

| Brief # | Requirement | Where handled |
|---|---|---|
| 1 | Hide tab bar | iOS §5.7 (custom mechanism, not `.toolbar`) |
| 2 | Drink hero ~2× | iOS §5.2 |
| 3 | Price under name, live | iOS §5.2 (already live in v1) |
| 4 | "Ready in ~4 min" pill | iOS §5.2 (hardcoded + TODO) |
| 5 | Boutique ingredient line | **Backend** §4.2 (iOS renders `description`) |
| 6 | Remove "Customize" header | iOS §5.4 |
| 7 | Group order Size→Milk→Sweet→Extras | Backend `sort_order` §4.1 + iOS renders generically |
| 8 | All milk inline, 5 options | Backend §4.1 + iOS `FlowLayout` |
| 9 | Context-aware sweetness/extras | **Backend** `groupsForItem` §4.1 |
| 10 | Fixed-size metadata line | iOS §5.3 (hardcoded oz + TODO field) |
| 11 | "Your Usual" | iOS §5.3 — **static "Pulse recommends" now; real version deferred** |
| 12 | Heart favorite (local) | iOS §5.2 `FavoritesStore` |
| 13 | Sticky CTA + gradient | iOS §5.6 |
| 14 | "Pair with" | iOS §5.5 (hardcoded, menu-resolved) |
| 15 | Calm interface + haptics | iOS §5.4 (haptic), no decoration |
| 16 | No social proof; monochrome badge | Backend `badge_type` §4.3 + iOS §5.3 |
| 17 | No loyalty progress | iOS — simply not rendered |
| 18 | No calories/caffeine | iOS — not rendered (ⓘ sheet deferred) |
| 19 | A11y & reliability | iOS §5.4 / §5.8 |

---

## 7. Deferred (with TODO seams, per the manager's request)

Recorded in `docs/todo-endpoints.md` (backend §4.5) and as inline `// TODO:` comments at the iOS call sites:

1. Real "Your Usual ✓ + Apply" — needs order-history-for-item data.
2. Favorites backend sync — `FavoritesStore` is local-only today.
3. Queue-based ready-time — replaces hardcoded `~4 min`.
4. Backend `serving_size` field — replaces the iOS fixed-size oz hardcode.
5. Nutrition `ⓘ` bottom sheet (#18) — hidden for MVP.

---

## 8. Golden Rules checklist

- **#7 (integer cents):** all modifier math is `Int` cents (seed + `ItemCustomization`). ✅
- **#8 (iOS never calculates the charged price):** display-only sum (already logged in the decision-log on v1), now also visibly **labeled "Est."**; backend computes the charge at checkout; existing reconciliation guard unchanged. ✅
- **#2 (checkout sacred):** no checkout/payment code touched; cart stays in-memory. ✅
- **#15 (ship boring first):** no speculative endpoints; no `is_default` column (cheapest-default rule instead); badge plumbing only, no fake data. ✅
- **#17 (non-critical surfaces fail safe):** `badge_type` and favorites decode/degrade to safe defaults; required groups always have a valid default; "Pair with" skips unresolved items. ✅

---

## 9. Testing summary

**Backend:** seed produces the 5-milk set with correct prices; sweetness is matcha-only with Full/Half; coffee extras include syrups; `badge_type` migration up/down; `badge_type` present in menu payload; seed idempotency unchanged.

**iOS:** `ItemCustomization` default = cheapest option (updated tests); `FavoritesStore` persists/loads by item ID and degrades safely; pairing resolution skips unknown names; detail-to-cart wiring carries the exact selected `modifierIds` (v1 regression test stays green). View-level checks for tab-bar hide/restore and Dynamic Type at AX5 where feasible.
