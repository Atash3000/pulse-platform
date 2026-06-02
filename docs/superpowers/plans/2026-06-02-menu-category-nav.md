# Menu Category Nav — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Menu screen's All/Hot/Iced temperature toggle with a sticky, scroll-spy **category nav** (one tab per category: Matcha / Coffee / Food). Keep the stacked-section layout and the per-item `temperature` field.

**Architecture:** iOS-first. New `CategoryTabBar` (data-driven, reuses the toggle's sliding-pill styling) pinned above the scroll; `ScrollViewReader` + a `PreferenceKey` give tap-to-scroll and an iOS-16-safe scroll-spy. `MenuViewModel` loses temperature filtering and gains a pure `activeCategoryId(...)` helper. One seed rename (`Classic Coffee` → `Coffee`). `TemperatureToggle` is deleted.

**Tech Stack:** SwiftUI, **iOS 16 target**. XCTest. **XcodeGen** — `make project` from `apps/ios/` is REQUIRED in Task 3 (a file is added and one deleted). Build/test: `make build|test SIMULATOR_DESTINATION='platform=iOS Simulator,name=iPhone 17 Pro'`. Backend: NestJS seed script.

**Branch:** `feat/ios/menu-category-nav` (off `main` @ `56f3d5e`; spec committed `f364965`).

> **Commit policy (CLAUDE.md §8):** each task ends with a commit; the human approves. Don't push.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `apps/api/scripts/seed-menu.ts` | Modify | Rename category `Classic Coffee` → `Coffee` (+ header comments) |
| `apps/ios/PulseCoffeeApp/Features/Menu/MenuViewModel.swift` | Modify | Add `activeCategoryId(...)`; (T3) drop temperature filtering |
| `apps/ios/PulseCoffeeAppTests/MenuViewModelTests.swift` | Modify | Add helper tests; (T3) drop filter tests + fixtures |
| `apps/ios/PulseCoffeeApp/Features/Menu/CategoryTabBar.swift` | Create | Sticky data-driven category nav |
| `apps/ios/PulseCoffeeApp/Features/Menu/MenuView.swift` | Modify | Pin the bar; ScrollViewReader + scroll-spy; copy fixes |
| `apps/ios/PulseCoffeeApp/Features/Menu/TemperatureToggle.swift` | Delete | Replaced by `CategoryTabBar` |
| `docs/decision-log.md`, `apps/ios/README.md`, `docs/todo-endpoints.md` | Modify | Record + scrub toggle references |

---

## Task 1: Seed rename `Classic Coffee` → `Coffee`

**Files:** Modify `apps/api/scripts/seed-menu.ts`

- [ ] **Step 1: Rename the category** — at line 311, change:

```typescript
    name: 'Classic Coffee',
```

to:

```typescript
    name: 'Coffee',
```

- [ ] **Step 2: Update the header comments** that name the category. Change the three header references (lines ~5, ~36, ~50) from `Classic Coffee` to `Coffee`:
  - `* categories (Matcha, Classic Coffee, Food) and their items; safe to` → `* categories (Matcha, Coffee, Food) and their items; safe to`
  - `* Classic Coffee + Food). To get a clean v4 menu, wipe the Postgres` → `* Coffee + Food). To get a clean v4 menu, wipe the Postgres`
  - `* Three categories: Matcha (spotlight), Classic Coffee (list), Food` → `* Three categories: Matcha (spotlight), Coffee (list), Food`

- [ ] **Step 3: Verify it compiles** — from `apps/api/`: `npm run build` → clean.

- [ ] **Step 4: Commit**

```bash
git add apps/api/scripts/seed-menu.ts
git commit -m "feat(api): rename menu category 'Classic Coffee' -> 'Coffee'

Data-only seed change for the new menu category nav (tab labels come
straight from category names). No migration. Needs a clean dev re-seed —
the seed upserts by name, so the old 'Classic Coffee' row lingers until a
wipe (same caveat as the 2026-05-30 milk reorder).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `MenuViewModel.activeCategoryId` helper (TDD, additive)

**Files:** Modify `apps/ios/PulseCoffeeApp/Features/Menu/MenuViewModel.swift`, `apps/ios/PulseCoffeeAppTests/MenuViewModelTests.swift`

> Additive only — the temperature filter stays for now so the build/tests stay green. Task 3 removes the filter.

- [ ] **Step 1: Add the failing tests** — append inside `MenuViewModelTests` (after the existing tests, before the closing brace):

```swift
    // MARK: - activeCategoryId (scroll-spy section picker)

    func test_activeCategoryId_empty_returnsNil() {
        XCTAssertNil(MenuViewModel.activeCategoryId(sectionTops: [], threshold: 0))
    }

    func test_activeCategoryId_noneCrossed_returnsFirst() {
        let tops: [(id: MenuCategory.ID, top: CGFloat)] = [("a", 120), ("b", 400), ("c", 700)]
        XCTAssertEqual(MenuViewModel.activeCategoryId(sectionTops: tops, threshold: 0), "a")
    }

    func test_activeCategoryId_middleCrossed_returnsThatSection() {
        let tops: [(id: MenuCategory.ID, top: CGFloat)] = [("a", -100), ("b", -20), ("c", 150)]
        XCTAssertEqual(MenuViewModel.activeCategoryId(sectionTops: tops, threshold: 0), "b")
    }

    func test_activeCategoryId_lastCrossed_returnsLast() {
        let tops: [(id: MenuCategory.ID, top: CGFloat)] = [("a", -300), ("b", -120), ("c", -10)]
        XCTAssertEqual(MenuViewModel.activeCategoryId(sectionTops: tops, threshold: 0), "c")
    }

    func test_activeCategoryId_exactThresholdTie_sectionAtThresholdWins() {
        // 'b' sits exactly at the threshold; it counts as crossed (<=) and is
        // the last such section, so it wins over 'a'. Deterministic.
        let tops: [(id: MenuCategory.ID, top: CGFloat)] = [("a", -10), ("b", 0), ("c", 50)]
        XCTAssertEqual(MenuViewModel.activeCategoryId(sectionTops: tops, threshold: 0), "b")
    }
```

- [ ] **Step 2: Run, verify it fails** — `make test …` → compile failure (`activeCategoryId` undefined).

- [ ] **Step 3: Implement** — in `MenuViewModel.swift`, add this method inside the class (e.g. just above the existing `filter(_:by:)`). If the build complains about `CGFloat`, add `import CoreGraphics` at the top:

```swift
    /// Scroll-spy section picker (pure; `nonisolated` for synchronous test
    /// calls). Given each section's top offset in the scroll's coordinate
    /// space (decreasing as the user scrolls down), in visual order, plus
    /// the y-threshold of the scroll's top edge, returns the id of the
    /// section currently under the top edge: the LAST section whose top has
    /// crossed the threshold (`top <= threshold`). Falls back to the first
    /// section before any have crossed; `nil` only for an empty list.
    /// Behavior pinned by `MenuViewModelTests`.
    nonisolated static func activeCategoryId(
        sectionTops: [(id: MenuCategory.ID, top: CGFloat)],
        threshold: CGFloat
    ) -> MenuCategory.ID? {
        guard let first = sectionTops.first else { return nil }
        let crossed = sectionTops.last { $0.top <= threshold }
        return crossed?.id ?? first.id
    }
```

- [ ] **Step 4: Run, verify it passes** — `make test …`. New tests green; existing suite unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Menu/MenuViewModel.swift apps/ios/PulseCoffeeAppTests/MenuViewModelTests.swift
git commit -m "feat(ios): MenuViewModel.activeCategoryId scroll-spy helper (TDD)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Category nav UI — new bar, scroll-spy, delete toggle

**Files:** Create `apps/ios/PulseCoffeeApp/Features/Menu/CategoryTabBar.swift`; Modify `MenuView.swift`, `MenuViewModel.swift`; Delete `TemperatureToggle.swift`; Modify `MenuViewModelTests.swift`

- [ ] **Step 1: Create `CategoryTabBar.swift`** with exactly:

```swift
import SwiftUI

/// Sticky category nav for the v4 Menu screen — one pill per menu
/// category, data-driven from the loaded categories (sort order).
/// Replaces the old All/Hot/Iced `TemperatureToggle`; reuses its
/// matched-geometry sliding-pill styling so the visual language is
/// unchanged. (3 categories split the width evenly, like the old toggle;
/// horizontal scrolling on overflow is deferred — see todo-endpoints.md.)
///
/// Two signals, split to avoid a scroll↔spy feedback loop (design §4.1):
/// - `selection` is the highlight; written by BOTH a tap and the
///   scroll-spy in `MenuView`.
/// - `onTap` fires ONLY on an explicit tap; `MenuView` uses it to scroll
///   to the section. The spy never calls `onTap`.
struct CategoryTabBar: View {
    let categories: [MenuCategory]
    @Binding var selection: MenuCategory.ID?
    let onTap: (MenuCategory.ID) -> Void

    @Namespace private var pill
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let pillID = "categoryTabActivePill"

    private var switchAnimation: Animation? {
        reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.72)
    }

    var body: some View {
        HStack(spacing: 0) {
            ForEach(categories) { category in
                segment(for: category)
            }
        }
        .padding(3)
        .background(trackBackground)
        .padding(.horizontal, 24)
    }

    private func segment(for category: MenuCategory) -> some View {
        let isActive = selection == category.id
        return Button {
            withAnimation(switchAnimation) { selection = category.id }
            onTap(category.id)
        } label: {
            HStack(spacing: 6) {
                if isActive {
                    Circle()
                        .fill(AppTheme.Colors.tabBarBackground)
                        .frame(width: 6, height: 6)
                }
                Text(category.name)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
            }
            .foregroundStyle(isActive
                             ? AppTheme.Colors.tabBarBackground
                             : AppTheme.Colors.tabLabelInactive)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background(segmentBackground(isActive: isActive))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(category.name)
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    @ViewBuilder
    private func segmentBackground(isActive: Bool) -> some View {
        if isActive {
            Capsule()
                .fill(AppTheme.Colors.tabLabelActive)
                .matchedGeometryEffect(id: Self.pillID, in: pill)
        }
    }

    private var trackBackground: some View {
        Capsule()
            .fill(AppTheme.Colors.tabBarBackground)
            .overlay(Capsule().stroke(AppTheme.Colors.divider.opacity(0.10), lineWidth: 1))
    }
}
```

- [ ] **Step 2: Delete `TemperatureToggle.swift`**

```bash
git rm apps/ios/PulseCoffeeApp/Features/Menu/TemperatureToggle.swift
```

> Note: `StatefulPreviewWrapper` lived only in that file and was only used by its own `#Preview` — deleting the file is safe. (Verify with `grep -rn StatefulPreviewWrapper apps/ios` → no other references.)

- [ ] **Step 3: Strip temperature filtering from `MenuViewModel.swift`** — remove these four members (keep `activeCategoryId`, `load`, `message`, `State`, the repos, `init`):
  - the property `@Published var selectedTemperature: TemperatureFilter = .all`
  - the computed `var filteredMenu: Menu? { … }` (the whole block + its doc comment)
  - the `nonisolated static func filter(_ menu: Menu, by filter: TemperatureFilter) -> Menu { … }` (whole block + doc comment)
  - the `private nonisolated static func matches(temperature:filter:) -> Bool { … }` (whole block)

- [ ] **Step 4: Rewrite the temperature-dependent parts of `MenuView.swift`.**

  (a) Add state — next to `@State private var detailItem: MenuItem?`:

```swift
    @State private var selectedCategoryId: MenuCategory.ID?
    /// Set briefly when a tab tap drives a programmatic scroll, so the
    /// scroll-spy doesn't fight the animation and snap the highlight back.
    @State private var spySuppressed = false
```

  (b) Add constants — anywhere in the struct (e.g. just below the `@State`s):

```swift
    private static let scrollSpace = "menuScroll"
    /// A section becomes active once its top reaches the scroll's top edge
    /// (y == 0 in the "menuScroll" space). Dial in a small positive lead
    /// here if a snappier switch is wanted.
    private static let spyThreshold: CGFloat = 0
```

  (c) Replace `allLoadedItems` and add `loadedMenu`:

```swift
    /// Every item across all loaded categories — the pool ItemPairings
    /// matches pair-with suggestions against (spec §5.5).
    private var allLoadedItems: [MenuItem] {
        guard let menu = loadedMenu else { return [] }
        return menu.categories.flatMap(\.items)
    }

    /// The loaded menu (no filtering — the category nav navigates, it
    /// doesn't filter). `nil` until the menu loads.
    private var loadedMenu: Menu? {
        if case .loaded(_, let menu) = viewModel.state { return menu }
        return nil
    }
```

  (d) Replace the whole `loadedView` with:

```swift
    @ViewBuilder
    private var loadedView: some View {
        if let menu = loadedMenu, !menu.categories.isEmpty {
            let categories = menu.categories.sorted { $0.sortOrder < $1.sortOrder }
            ScrollViewReader { proxy in
                VStack(spacing: 0) {
                    CategoryTabBar(
                        categories: categories,
                        selection: $selectedCategoryId,
                        onTap: { id in jump(to: id, using: proxy) }
                    )
                    .padding(.top, 4)
                    .padding(.bottom, 14)

                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            header
                                .padding(.horizontal, 24)
                                .padding(.top, 8)
                                .padding(.bottom, 18)

                            ForEach(categories) { category in
                                section(for: category)
                                    .id(category.id)
                                    .background(sectionTopReporter(for: category.id))
                            }

                            Color.clear.frame(height: 24)
                        }
                    }
                    .coordinateSpace(name: Self.scrollSpace)
                    .onPreferenceChange(SectionTopPreferenceKey.self) { tops in
                        guard !spySuppressed else { return }
                        let ordered: [(id: MenuCategory.ID, top: CGFloat)] =
                            categories.compactMap { c in tops[c.id].map { (id: c.id, top: $0) } }
                        if let active = MenuViewModel.activeCategoryId(
                            sectionTops: ordered, threshold: Self.spyThreshold) {
                            selectedCategoryId = active
                        }
                    }
                }
            }
            .background(AppTheme.Colors.tabBarBackground.opacity(0.6).ignoresSafeArea())
            .onAppear {
                if selectedCategoryId == nil { selectedCategoryId = categories.first?.id }
            }
        } else {
            emptyMenu
        }
    }

    /// Tab-tap → smooth-scroll to the section, suppressing the scroll-spy
    /// briefly so it doesn't snap the highlight back mid-animation.
    private func jump(to id: MenuCategory.ID, using proxy: ScrollViewProxy) {
        spySuppressed = true
        withAnimation(.easeInOut(duration: 0.35)) {
            proxy.scrollTo(id, anchor: .top)
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 450_000_000)
            spySuppressed = false
        }
    }

    /// Reports a section's top offset (in the "menuScroll" space) so the
    /// scroll-spy can pick the active section. Drawn in a `.background` so
    /// it never affects layout.
    private func sectionTopReporter(for id: MenuCategory.ID) -> some View {
        GeometryReader { geo in
            Color.clear.preference(
                key: SectionTopPreferenceKey.self,
                value: [id: geo.frame(in: .named(Self.scrollSpace)).minY]
            )
        }
    }
```

  (e) Update the `header` subtitle text — change `Text("Matcha line · Classic coffee · Food")` to:

```swift
            Text("Matcha line · Coffee · Food")
```

  (f) Replace the `emptyMenu` copy (it no longer describes a filter):

```swift
    private var emptyMenu: some View {
        VStack(spacing: 12) {
            Image(systemName: "cup.and.saucer")
                .font(.largeTitle)
                .foregroundStyle(AppTheme.Colors.iconSecondary)
            Text("The menu is empty")
                .font(.headline)
            Text("Check back soon — items are on their way.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
```

  (g) Add the preference key at file scope (bottom of `MenuView.swift`, after the `#Preview`):

```swift
/// Collects each menu section's top offset (in the menu scroll's
/// coordinate space), keyed by category id, for the scroll-spy.
private struct SectionTopPreferenceKey: PreferenceKey {
    static var defaultValue: [MenuCategory.ID: CGFloat] { [:] }
    static func reduce(value: inout [MenuCategory.ID: CGFloat],
                       nextValue: () -> [MenuCategory.ID: CGFloat]) {
        value.merge(nextValue()) { _, new in new }
    }
}
```

  > The old `loadedView` referenced `TemperatureToggle(selection: $viewModel.selectedTemperature)` — that line is gone in the replacement above. Confirm no `TemperatureToggle` / `filteredMenu` / `selectedTemperature` references remain in `MenuView.swift`.

- [ ] **Step 5: Remove the dead filter tests** in `MenuViewModelTests.swift` — delete the six `test_filter_*` cases and the now-unused `// MARK: - Fixtures` helpers (`item(...)`, `category(...)`, `menu(...)`) they relied on. Keep only the `activeCategoryId` tests added in Task 2. (Verify the fixtures aren't used by the kept tests before deleting — the `activeCategoryId` tests use plain tuples, so they aren't.)

- [ ] **Step 6: Regenerate the Xcode project** (a file was added and one deleted) — from `apps/ios/`: `make project`.

- [ ] **Step 7: Build + test** — from `apps/ios/`:

```
make build SIMULATOR_DESTINATION='platform=iOS Simulator,name=iPhone 17 Pro'
make test  SIMULATOR_DESTINATION='platform=iOS Simulator,name=iPhone 17 Pro'
```

Both must succeed. Suite green (the 6 filter tests are gone; the 5 `activeCategoryId` tests are present).

- [ ] **Step 8: Commit**

```bash
git add -A apps/ios
git commit -m "feat(ios): sticky scroll-spy category nav; remove temperature toggle

CategoryTabBar (data-driven, one pill per category) pinned above the menu
scroll; ScrollViewReader + a PreferenceKey give tap-to-scroll and an
iOS-16-safe scroll-spy (split tap/spy signals avoid a feedback loop).
MenuViewModel loses temperature filtering; TemperatureToggle deleted. The
per-item temperature field is intentionally kept (detail screen + future
options).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Docs — decision-log + README + todo scrub

**Files:** Modify `docs/decision-log.md`, `apps/ios/README.md`, `docs/todo-endpoints.md`

- [ ] **Step 1: Append the decision-log entry** at the end of `docs/decision-log.md`:

```markdown
## 2026-06-02 — [ios] Menu category nav replaces the All/Hot/Iced temperature toggle

**Decision:** The Menu screen's All/Hot/Iced temperature toggle is replaced by a sticky, data-driven category nav (one tab per category: Matcha / Coffee / Food). Tapping a tab smooth-scrolls to that section; scrolling auto-highlights the section in view (scroll-spy). The per-item `temperature` field is KEPT. The seed category `Classic Coffee` was renamed to `Coffee`.

**Context:** The temperature toggle filtered the whole menu by item temperature; the founder wanted the top bar to navigate categories instead.

**Alternatives considered:** One-category-at-a-time tabs (swap content per tab) — rejected in favor of keeping the proven stacked-scroll layout with a jump/scroll-spy nav. Hardcoding 3 tabs in iOS — rejected for a data-driven bar that follows the API's categories.

**Reasoning:** The toggle was 100% frontend (no backend filter), so this is an iOS change plus a one-line seed rename — no migration. The bar reads category names straight from the loaded menu, so it stays correct as categories change. `temperature` stays because it still drives the product-detail "Hot or Iced" line and the deferred temperature/ice options.

**Trade-offs:** The iOS-16 scroll-spy (PreferenceKey offset tracking + a brief tap-suppression window) is the one fiddly piece; it's fail-safe per GR#17 — a misfire only mis-highlights a tab, never breaks the menu/cart path. Tab labels/order come from the seed; manager-editable categories remain deferred (drink-options Part C). Horizontal scrolling for >3 categories is deferred (3 fit the width today).
```

- [ ] **Step 2: Update `apps/ios/README.md`** — grep it for temperature-toggle wording and replace with the category nav. Run `grep -niE "temperature toggle|all/hot/iced|hot.*iced|TemperatureToggle" apps/ios/README.md` and update each hit so it describes the sticky category nav (Matcha / Coffee / Food) instead. Keep any valid per-item-temperature references (e.g. the "Hot or Iced" detail line). If a file-tree listing names `TemperatureToggle.swift`, replace it with `CategoryTabBar.swift`.

- [ ] **Step 3: Scrub `docs/todo-endpoints.md`** — run `grep -niE "temperature|toggle|hot|iced" docs/todo-endpoints.md`. Remove or update any reference tied to the removed *toggle/filter*; KEEP per-item-temperature and drink-options seams. Add (or fold into the existing "Frontend follow-ups" section) one line:

```markdown
- **Category nav horizontal overflow.** `CategoryTabBar` splits the width evenly across categories (3 fit today). If categories ever exceed the width, make the bar horizontally scrollable. Frontend-only; no endpoint.
```

  Also confirm the existing menu/Navigation READMEs under `apps/ios/PulseCoffeeApp/**` don't still describe the temperature toggle: `grep -rniE "temperature toggle|all/hot/iced" apps/ios --include=*.md` and update any hit.

- [ ] **Step 4: Commit**

```bash
git add docs/decision-log.md apps/ios/README.md docs/todo-endpoints.md
git commit -m "docs(ios): record menu category nav; scrub temperature-toggle references

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Full verification

- [ ] **Step 1: iOS suite** — from `apps/ios/`: `make test SIMULATOR_DESTINATION='platform=iOS Simulator,name=iPhone 17 Pro'` → all green. `make build …` → clean.
- [ ] **Step 2: No stale symbols** — `grep -rnE "TemperatureToggle|TemperatureFilter|selectedTemperature|filteredMenu" apps/ios` returns nothing.
- [ ] **Step 3: Backend re-seed + SQL check** (destructive dev-DB wipe — local only):

```bash
cd apps/api
docker compose down -v
docker compose up -d --wait postgres redis
npm run migration:run
npm run seed:dev
npm run seed:menu
docker exec pulse-postgres psql -U pulse -d pulse -c \
"SELECT name, sort_order FROM menu_categories ORDER BY sort_order;"
```

Expected: categories are `Matcha`, `Coffee`, `Food` (no `Classic Coffee`).

- [ ] **Step 4: Simulator walk** — launch on iPhone 17 Pro: the bar pins under the topbar showing Matcha / Coffee / Food; tapping a tab smooth-scrolls to that section; free-scrolling auto-highlights the section in view; tap-then-scroll doesn't flicker the highlight; spotlight (Matcha) + section headers + add-to-cart all still work. Tune `spyThreshold` / animation only if needed.
- [ ] **Step 5: Report** — tests green, build clean, categories correct; branch ready for review/PR. Do not push without approval.

---

## Self-review (completed by plan author)

**Spec coverage (2026-06-02-menu-category-nav-design.md):** §4.1 `CategoryTabBar` + two-signal split → Task 3 Step 1 ✅ · §4.2 strip filter + `activeCategoryId` → Task 2 + Task 3 Step 3 ✅ · §4.3 pinned bar, ScrollViewReader, scroll-spy, suppress flag → Task 3 Step 4 ✅ · §4.4 seed rename → Task 1 ✅ · §6 fail-safe (empty→first/nil, non-crash) → `activeCategoryId` + `emptyMenu` ✅ · §7 tests (delete filter, add helper boundary tests) → Task 2 + Task 3 Step 5 ✅ · §9 docs → Task 4 ✅ · §10 deferred (overflow, manager-editable) → Task 4 Step 3 + decision-log ✅.

**Placeholder scan:** none — full code for `CategoryTabBar`, `activeCategoryId`, the `MenuView` rewrite, and the tests. The README/todo steps give exact `grep` commands + the precise edits to make (the only file-specific wording I can't pre-quote is inside README prose, bounded by the grep).

**Type/consistency:** `MenuCategory.ID` is `String` (confirmed: model is `Identifiable` and tests compare ids to string literals) — helper signature, tuples, tests, `PreferenceKey` dict, and `selection` binding all use `MenuCategory.ID` consistently. `activeCategoryId(sectionTops:threshold:)` signature matches between Task 2 (impl + tests) and Task 3 Step 4 (call site). `onTap`/`selection` split matches the design §4.1 contract. `AppTheme.Colors` tokens (`tabBarBackground`, `tabLabelInactive`, `tabLabelActive`, `divider`) are the same ones the deleted `TemperatureToggle` used. `make project` is included because a file is added + one deleted (XcodeGen).
