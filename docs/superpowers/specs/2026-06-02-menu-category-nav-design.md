# Menu Category Nav — Design

**Date:** 2026-06-02
**Status:** Approved design — ready for implementation planning
**Surface:** `apps/ios` (SwiftUI) + a one-line `apps/api` seed rename
**Audience:** the `/superpowers:writing-plans` planner and the implementing engineer.

---

## 1. Goal & gap

The v4 Menu screen has an **All / Hot / Iced** temperature toggle pinned above a stacked, scrolling list of category sections (Matcha spotlight, Classic Coffee list, Food list). The toggle filters the already-loaded menu by each item's `temperature` — it is **100% frontend**; the API returns the full menu and there is no backend filtering behind it.

Replace that toggle with a **sticky, scroll-spy category nav** — one tab per menu category (Matcha / Coffee / Food). Tapping a tab scrolls to that section; scrolling auto-highlights the section in view. The stacked-section layout is kept; only the top bar changes.

The per-item `temperature` field is **kept** (it still powers the product-detail "Hot or Iced" line and remains the basis for the deferred temperature/ice drink-options work). This change removes the *toggle UI and its filter logic*, not the temperature concept.

---

## 2. Scope

### In scope
- Delete the `TemperatureToggle` view + `TemperatureFilter` enum.
- Add a data-driven, sticky `CategoryTabBar` (one tab per loaded category, sort order).
- Scroll-spy + tap-to-scroll wiring in `MenuView` (iOS-16-compatible).
- Strip temperature **filtering** from `MenuViewModel`; add a pure active-section helper.
- Rename the seed category `Classic Coffee` → `Coffee` (data only).
- Delete dead temperature-filter tests; add tests for the new pure helper.
- Docs/README/decision-log/todo cleanup of toggle references.

### Out of scope (unchanged)
- The `menu_items.temperature` column, the `Temperature` enum, the API, any migration.
- The product-detail "Hot or Iced" metadata line.
- The deferred temperature/ice drink-options spec (`2026-05-30-drink-options-design.md` Part B) — stays valid; the field it needs is kept.
- The spotlight (Matcha hero) treatment and the in-scroll section headers — kept as-is.

---

## 3. What exists (reuse, don't rebuild)

| Asset | Location | Role / change |
|---|---|---|
| `TemperatureToggle` + `TemperatureFilter` | `Features/Menu/TemperatureToggle.swift` | **Delete.** Its matched-geometry pill styling is lifted into `CategoryTabBar`. |
| `MenuViewModel` | `Features/Menu/MenuViewModel.swift` | Remove `selectedTemperature`, `filteredMenu`, `filter(_:by:)`, `matches(...)`. Add pure `activeCategoryId(...)` helper. Expose loaded menu directly. |
| `MenuView` | `Features/Menu/MenuView.swift` | Pin `CategoryTabBar` under the topbar; wrap sections in `ScrollViewReader`; add scroll-spy. |
| `MenuCategory` / `Menu` | `Models/Menu.swift` | Unchanged. Categories already carry `id`, `name`, `sortOrder`, `displayStyle`, `items`. |
| `SpotlightSection`, `MenuListRow` | `Features/Menu/` | Unchanged (they read `item.temperature` for display only — the field stays). |
| Seed category `Classic Coffee` | `apps/api/scripts/seed-menu.ts` | Rename to `Coffee` (data only). |

**Consequence:** one deleted file, one new file, edits to `MenuView` + `MenuViewModel`, a one-line seed rename, and docs.

---

## 4. Architecture — the components

### 4.1 `CategoryTabBar` (NEW — `Features/Menu/CategoryTabBar.swift`)
- Input: the loaded `[MenuCategory]` (already sort-ordered), a `Binding<MenuCategory.ID?>` `selection` (the highlight), and an `onTap: (MenuCategory.ID) -> Void` closure (the explicit-tap signal).
- Renders one pill per category, label = `category.name`. Reuses `TemperatureToggle`'s matched-geometry selection pill + `DetailPalette`/menu styling so the visual language is unchanged.
- **Two distinct signals, to avoid a scroll↔spy feedback loop:** `selection` is the *highlight state* and is written by **both** an explicit tap **and** the scroll-spy. `onTap` fires **only** on an explicit tap. Tapping a pill sets `selection` AND calls `onTap`; the scroll-spy sets `selection` only (never `onTap`). So only explicit taps drive a scroll (§4.3) — the spy just moves the highlight.
- If there are 0 or 1 categories, the bar may render empty/single — harmless; the menu still works.
- Horizontally scrollable if the category count ever exceeds the visible width (future-proof; today 3 fit).

### 4.2 `MenuViewModel` (MODIFY)
- **Remove:** `@Published var selectedTemperature`, the `filteredMenu` computed, `filter(_:by:)`, `matches(temperature:filter:)`.
- The view reads the loaded menu directly (the `.loaded(location, menu)` state already carries it).
- **Add** a pure, `nonisolated static` helper for the scroll-spy so it is unit-testable without a view:
  ```
  /// Given each section's top offset (in the scroll content's coordinate
  /// space) keyed by category id, and the y-threshold of the pinned bar's
  /// bottom edge, returns the id of the section currently "active" (the
  /// last section whose top has crossed above the threshold). Returns the
  /// first id if none have crossed yet. nil only when there are no sections.
  static func activeCategoryId(sectionTops: [(id: MenuCategory.ID, top: CGFloat)],
                               threshold: CGFloat) -> MenuCategory.ID?
  ```

### 4.3 `MenuView` (MODIFY)
- `@State private var selectedCategoryId: MenuCategory.ID?` — defaults to the first category on load.
- `@State private var suppressSpyUntil` (or a bool) — set when a tab tap triggers a programmatic scroll, cleared shortly after, so the spy doesn't fight the animation.
- Layout becomes: `VStack(spacing: 0) { topbar; CategoryTabBar(...); scrollContent }` — the bar is **outside** the scroll, so it is permanently pinned.
- `scrollContent` = `ScrollViewReader { proxy in ScrollView { LazyVStack { ForEach(categories) { section(for:).id(category.id) } } } }`.
- **Tap → scroll:** tab selection change (or `onSelect`) → set the suppress flag → `withAnimation { proxy.scrollTo(id, anchor: .top) }`.
- **Scroll → spy:** each section wraps a `GeometryReader` that writes its `.frame(in: .named("menuScroll")).minY` into a `PreferenceKey` (`[id: CGFloat]`). `MenuView` reads the merged preference in `.onPreferenceChange`, calls `MenuViewModel.activeCategoryId(...)`, and updates `selectedCategoryId` (skipped while the suppress flag is active). The scroll uses `.coordinateSpace(name: "menuScroll")`.

### 4.4 Seed rename (MODIFY — `apps/api/scripts/seed-menu.ts`)
- Change the `Classic Coffee` category `name` to `Coffee`. Data only; no migration, no entity change.
- ⚠️ The seed upserts categories by `(location_id, name)`, so the rename creates a new `Coffee` row and leaves a stale `Classic Coffee` unless the dev DB is re-seeded clean — same caveat as the 2026-05-30 milk reorder. Verification includes a clean re-seed.

---

## 5. Data flow

```
API → MenuViewModel.load() → .loaded(location, menu)   (full menu, no filtering)
MenuView:
  categories = menu.categories sorted by sortOrder
  selectedCategoryId defaults to categories.first?.id
  CategoryTabBar(categories, selection: $selectedCategoryId, onTap: …)
    onTap(id) → suppress spy briefly → proxy.scrollTo(id, .top)   // explicit taps only
    (spy writes selectedCategoryId for the highlight — no scroll)
  ScrollView (coordinateSpace "menuScroll")
    each section → GeometryReader minY → SectionTopPreferenceKey [id: CGFloat]
  .onPreferenceChange → activeCategoryId(sectionTops, threshold) → selectedCategoryId
                        (unless suppressed)
```

No money, no auth, no network beyond the existing menu fetch.

---

## 6. Error handling / fail-safe (Golden Rule #17)

- Scroll-spy is a **non-critical** surface: if the offset math misbehaves, the menu still scrolls, tabs still tap-scroll, and items still add to cart. Worst case is a briefly-stale highlight — never a crash or a blocked order path.
- `activeCategoryId` returns the first id when nothing has crossed the threshold and `nil` only for an empty menu; `MenuView` falls back to the first category / hides the bar when there are no categories.
- Existing loading / failed / empty states and pull-to-refresh are unchanged.

---

## 7. Testing

- **Delete** the temperature-filter tests in `MenuViewModelTests` (the logic is gone).
- **Add** unit tests for `MenuViewModel.activeCategoryId(sectionTops:threshold:)`:
  - empty → `nil`
  - all sections below the threshold → first id
  - middle section crossed → that id
  - last section crossed → last id
  - exact-boundary tie → deterministic (the lower/last crossed wins)
- Build + full suite green. Simulator walk: tap each tab scrolls to its section; scrolling auto-highlights the right tab; tap-then-scroll doesn't flicker.
- No View-layer unit test for `CategoryTabBar`/scroll wiring (no ViewInspector in the project) — covered by the simulator walk, noted explicitly.

---

## 8. Golden Rules

- **#15 (ship boring/reliable):** keeps the proven stacked-section layout; only the top bar changes. The one fiddly piece (iOS-16 scroll-spy) is isolated and fail-safe.
- **#17 (non-critical fails safe):** scroll-spy degrades to a stale highlight, never breaks the menu/cart path.
- **#13 (locations from day one):** untouched — categories remain location-scoped via the existing menu query.

---

## 9. Docs to update (part of the work)

- **Decision-log entry:** records the toggle removal + the new sticky scroll-spy category nav; notes it supersedes the temperature-toggle decision while the per-item `temperature` field is intentionally kept.
- **`apps/ios/README.md`** + Menu/Navigation READMEs: replace "temperature toggle" / "All-Hot-Iced" wording with the category nav; keep valid per-item-temperature references.
- **`docs/todo-endpoints.md`:** scrub any temperature-filter/toggle reference; keep the per-item-temperature and drink-options seams.
- The seed file header comment is updated for the `Coffee` rename.

## 10. Deferred / todos (captured so nothing is reinvented)

- **Manager-editable category order/labels** — the tab labels and order come straight from the seeded categories. A dashboard to rename/reorder categories without a seed edit is part of the broader manager-manageable-menu work (already noted in the drink-options spec Part C); **no endpoint added here**.
- **Per-item temperature → options** — unchanged deferred work in `2026-05-30-drink-options-design.md` Part B; the field it relies on is kept.
