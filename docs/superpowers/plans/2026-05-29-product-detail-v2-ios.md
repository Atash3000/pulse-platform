# Product Detail v2 — iOS Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the working-but-form-like v1 product detail screen into a premium product page — drink-as-hero, instant price, favorite heart, "ready in ~4 min", boutique ingredient line, pair-with, sticky estimate CTA, and a hidden tab bar in focused mode — while keeping iOS a generic modifier renderer.

**Architecture:** Slice 2 of 2 (see `docs/superpowers/specs/2026-05-29-product-detail-v2-design.md`). Builds on the existing `feat/ios/product-detail-customization` branch (which has v1 `ItemDetailView` + `ItemCustomization`), **rebased on the merged backend slice** so the new modifier catalog + `badge_type` exist. All "matcha vs coffee" behaviour comes from the backend's modifier groups; iOS renders groups generically by `sort_order`. New cross-cutting state (favorites, tab-bar visibility) lives in small, testable `ObservableObject`s injected via the environment.

**Tech Stack:** SwiftUI, **iOS 16 deployment target** (so: `ObservableObject` + `@EnvironmentObject`, NOT the iOS-17 `@Observable` macro; `navigationDestination(isPresented:)` overload, already used in `MenuView`). XCTest. **XcodeGen** — the `.pbxproj` is generated, so after adding/removing any Swift file you MUST run `make project` from `apps/ios/` (see memory `ios-xcodegen-workflow`). Tests run in Xcode / `xcodebuild test`.

**Branch & prerequisites:**
- Work on `feat/ios/product-detail-customization`. Before starting: the backend branch `feat/api/menu-modifiers-v2` must be merged to `main`, and this branch rebased on it (`git rebase main`). Confirm `git log main --oneline | grep badge_type` shows the backend commits.
- Working directory for builds: `apps/ios/`. Regenerate the project with `make project` after any file add/remove.

> **Commit policy (CLAUDE.md §8):** each task ends with a commit step; the human approves commits ("commit it"), and nothing is pushed without "push it".

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `apps/ios/PulseCoffeeApp/Models/Menu.swift` | Modify (`MenuItem`) | Decode `badge_type` fail-safe |
| `apps/ios/PulseCoffeeApp/Features/Menu/ItemCustomization.swift` | Modify | Default = cheapest required single-select option |
| `apps/ios/PulseCoffeeApp/Core/FavoritesStore.swift` | Create | UserDefaults-backed favorite item-ID set (fail-safe) |
| `apps/ios/PulseCoffeeApp/Core/TabBarVisibility.swift` | Create | Shared flag to hide the custom tab bar in focused mode |
| `apps/ios/PulseCoffeeApp/Features/Menu/ItemPairings.swift` | Create | Pure resolver: item → up to 3 pair-with food items |
| `apps/ios/PulseCoffeeApp/Features/Menu/ItemDetailView.swift` | Rewrite | The premium product page (hero, sections, pair-with, sticky CTA) |
| `apps/ios/PulseCoffeeApp/Features/Menu/ProductDetailComponents.swift` | Create | Small detail-only subviews (ReadyPill, FavoriteHeart, ItemBadge, PairWithCard, sticky CTA) |
| `apps/ios/PulseCoffeeApp/Features/Menu/MenuView.swift` | Modify | Pass resolved pairings into detail; inject stores |
| `apps/ios/PulseCoffeeApp/Features/Navigation/MainTabView.swift` | Modify | Hide `PulseTabBar` when `TabBarVisibility.isHidden` |
| `apps/ios/PulseCoffeeApp/PulseCoffeeApp.swift` | Modify | Inject `FavoritesStore` at app root |
| `apps/ios/PulseCoffeeAppTests/MenuTests.swift` | Modify | `badge_type` decode tests |
| `apps/ios/PulseCoffeeAppTests/ItemCustomizationTests.swift` | Modify | Cheapest-default tests |
| `apps/ios/PulseCoffeeAppTests/FavoritesStoreTests.swift` | Create | Favorites persistence + fail-safe |
| `apps/ios/PulseCoffeeAppTests/ItemPairingsTests.swift` | Create | Pairing resolution |
| `docs/decision-log.md` | Modify (append) | Record the iOS-side decisions |
| `apps/ios/README.md` | Modify | Note favorites store + tab-bar focused-mode mechanism |

---

## Task 1: Decode `badge_type` on `MenuItem` (TDD)

The backend now sends `badge_type` (`'signature' | 'staff_pick' | 'seasonal' | null`). iOS must decode it fail-safe (unknown/missing → `nil`), GR#17.

**Files:**
- Modify: `apps/ios/PulseCoffeeApp/Models/Menu.swift`
- Modify: `apps/ios/PulseCoffeeAppTests/MenuTests.swift`

- [ ] **Step 1: Write failing decode tests**

Add to `apps/ios/PulseCoffeeAppTests/MenuTests.swift` (follow the file's existing JSON-decode pattern; if it decodes a `MenuItem` from a JSON string fixture, mirror that — otherwise use `JSONDecoder` inline as below):

```swift
func test_menuItem_decodesBadgeType() throws {
    let json = """
    {"id":"i1","name":"Ginger Matcha","description":null,"base_price_cents":675,
     "image_url":null,"available":true,"quantity_left":null,"modifier_groups":[],
     "temperature":"iced","featured":false,"art_token":"ginger-matcha",
     "badge_type":"signature"}
    """.data(using: .utf8)!
    let item = try JSONDecoder().decode(MenuItem.self, from: json)
    XCTAssertEqual(item.badgeType, "signature")
}

func test_menuItem_missingBadgeType_decodesNil() throws {
    let json = """
    {"id":"i1","name":"Latte","description":null,"base_price_cents":550,
     "image_url":null,"available":true,"quantity_left":null,"modifier_groups":[],
     "temperature":"both","featured":false,"art_token":"latte"}
    """.data(using: .utf8)!
    let item = try JSONDecoder().decode(MenuItem.self, from: json)
    XCTAssertNil(item.badgeType)
}
```

- [ ] **Step 2: Run, verify failure**

Build/test the test target; expect compile failure (`MenuItem` has no `badgeType`).

- [ ] **Step 3: Add the property, CodingKey, decode, and memberwise default**

In `apps/ios/PulseCoffeeApp/Models/Menu.swift`, `struct MenuItem`:

After the `artToken` stored property, add:
```swift
    /// Optional monochrome merchandising badge: "signature" | "staff_pick"
    /// | "seasonal". `nil` / unknown → no badge (Golden Rule #17). Never a
    /// social-proof number.
    let badgeType: String?
```

In `enum CodingKeys`, after `case artToken = "art_token"`, add:
```swift
        case badgeType = "badge_type"
```

In `init(from decoder:)`, after the `artToken` line, add:
```swift
        self.badgeType = try c.decodeIfPresent(String.self, forKey: .badgeType)
```

In the memberwise `init(...)`, add a defaulted parameter after `artToken: String? = nil`:
```swift
        artToken: String? = nil,
        badgeType: String? = nil
```
and in the body, after `self.artToken = artToken`:
```swift
        self.badgeType = badgeType
```

- [ ] **Step 4: Run, verify pass**

Both new tests pass; existing `MenuTests` stay green (memberwise default keeps old call sites compiling).

- [ ] **Step 5: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Models/Menu.swift apps/ios/PulseCoffeeAppTests/MenuTests.swift
git commit -m "feat(ios): decode menu_items.badge_type fail-safe

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `ItemCustomization` default = cheapest option (TDD)

Change the default-selection rule from "first by `sortOrder`" to "cheapest (`priceCents`, tie-break `sortOrder`)" for required single-select groups, so Milk defaults to the free `Whole` even though `Oat` renders first (spec §5.1). Keeps the detail open price equal to the menu list price.

**Files:**
- Modify: `apps/ios/PulseCoffeeApp/Features/Menu/ItemCustomization.swift`
- Modify: `apps/ios/PulseCoffeeAppTests/ItemCustomizationTests.swift`

- [ ] **Step 1: Update the existing default test + add the discriminating case**

In `apps/ios/PulseCoffeeAppTests/ItemCustomizationTests.swift`, rename `test_defaultSelection_preselectsFirstRequiredSingleSelectBySortOrder` to `test_defaultSelection_preselectsCheapestRequiredSingleSelect` and add a milk-like group where the first-by-sortOrder option is NOT the cheapest. Use the existing `mod(_:_:_:_:)` and group helpers in this file:

```swift
func test_defaultSelection_preselectsCheapestRequiredSingleSelect() {
    // Oat (+75) is sort 0 (renders first); Whole (0) is sort 1. Default
    // must be the cheapest (Whole), not the first by sortOrder.
    let milk = group("milk", "Milk", required: true, multiSelect: false, sort: 0, modifiers: [
        mod("oat", "Oat", 75, 0),
        mod("whole", "Whole", 0, 1),
        mod("almond", "Almond", 75, 2),
    ])
    let item = self.item(basePriceCents: 645, groups: [milk])
    let c = ItemCustomization(item: item)
    XCTAssertTrue(c.isSelected("whole", in: milk))
    XCTAssertFalse(c.isSelected("oat", in: milk))
    XCTAssertEqual(c.displayPriceCents, 645) // opens at base price, no premium default
    XCTAssertTrue(c.isSatisfied)
}
```

> If the helper signatures in the file differ (e.g. `item(...)` builder name/args), adapt these calls to the file's actual helpers — read the top of `ItemCustomizationTests.swift` first. The existing `sizeGroup` fixture (12oz @0, …) keeps its assertion valid because 12oz is both first and cheapest.

- [ ] **Step 2: Run, verify the new assertion fails**

The current "first by sortOrder" rule selects `oat`; the test expects `whole`. Expect FAIL on `XCTAssertTrue(c.isSelected("whole", …))`.

- [ ] **Step 3: Change the default rule**

In `apps/ios/PulseCoffeeApp/Features/Menu/ItemCustomization.swift`, in `init(item:)`, replace the default-seeding block. Current code seeds the first-by-sortOrder option for required single-select groups; replace with cheapest-by-price:

```swift
            // Default-selection rule (spec §5.1): pre-select the CHEAPEST
            // option (lowest priceCents, tie-break lowest sortOrder) for
            // required single-select groups, so the screen opens at the
            // menu's listed price and never defaults to a premium option
            // (e.g. Milk renders Oat first but defaults to free Whole).
            // Required multi-select and optional groups start empty.
            if grp.required && !grp.multiSelect,
               let cheapest = grp.modifiers.min(by: {
                   ($0.priceCents, $0.sortOrder) < ($1.priceCents, $1.sortOrder)
               }) {
                seeded[grp.id] = [cheapest.id]
            } else {
                seeded[grp.id] = []
            }
```

- [ ] **Step 4: Run, verify pass**

New + existing `ItemCustomizationTests` all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Menu/ItemCustomization.swift apps/ios/PulseCoffeeAppTests/ItemCustomizationTests.swift
git commit -m "feat(ios): default modifier selection to cheapest option

Opens the detail screen at the menu's listed price; Milk renders Oat
first (per brief) but defaults to free Whole. Spec §5.1.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `FavoritesStore` (TDD)

Local, fail-safe favorite item-ID store backed by `UserDefaults` (spec §5.2; backend sync deferred — see `docs/todo-endpoints.md`).

**Files:**
- Create: `apps/ios/PulseCoffeeApp/Core/FavoritesStore.swift`
- Create: `apps/ios/PulseCoffeeAppTests/FavoritesStoreTests.swift`

- [ ] **Step 1: Write failing tests**

Create `apps/ios/PulseCoffeeAppTests/FavoritesStoreTests.swift`:

```swift
import XCTest
@testable import PulseCoffeeApp

final class FavoritesStoreTests: XCTestCase {
    private func makeDefaults() -> UserDefaults {
        // Isolated suite per test so cases don't bleed into each other.
        let name = "favorites.test.\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    func test_isFavorite_falseByDefault() {
        let store = FavoritesStore(defaults: makeDefaults())
        XCTAssertFalse(store.isFavorite("item-1"))
    }

    func test_toggle_addsAndRemoves() {
        let store = FavoritesStore(defaults: makeDefaults())
        store.toggle("item-1")
        XCTAssertTrue(store.isFavorite("item-1"))
        store.toggle("item-1")
        XCTAssertFalse(store.isFavorite("item-1"))
    }

    func test_persistsAcrossInstances() {
        let d = makeDefaults()
        FavoritesStore(defaults: d).toggle("item-42")
        let reloaded = FavoritesStore(defaults: d)
        XCTAssertTrue(reloaded.isFavorite("item-42"))
    }

    func test_corruptData_degradesToEmpty() {
        let d = makeDefaults()
        d.set("not-an-array", forKey: FavoritesStore.storageKey) // wrong type
        let store = FavoritesStore(defaults: d)
        XCTAssertFalse(store.isFavorite("anything")) // fail-safe, no crash
    }
}
```

- [ ] **Step 2: Run, verify failure** (no `FavoritesStore` type yet → compile failure).

- [ ] **Step 3: Implement**

Create `apps/ios/PulseCoffeeApp/Core/FavoritesStore.swift`:

```swift
import Foundation
import Combine

/// Local, fail-safe store of favorited menu-item IDs, backed by
/// `UserDefaults`. Powers the heart toggle on the product detail screen
/// (spec §5.2). It is intentionally local-only for MVP — backend sync is
/// a deferred seam (`docs/todo-endpoints.md`). A read/parse failure
/// degrades to "no favorites" rather than crashing (Golden Rule #17):
/// favorites are a non-critical surface and must never block the screen.
final class FavoritesStore: ObservableObject {
    static let storageKey = "pulse.favorites.itemIDs.v1"

    private let defaults: UserDefaults
    @Published private(set) var ids: Set<String>

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // Fail-safe load: wrong type / missing key → empty set.
        let stored = defaults.array(forKey: Self.storageKey) as? [String] ?? []
        self.ids = Set(stored)
    }

    func isFavorite(_ itemID: String) -> Bool {
        ids.contains(itemID)
    }

    func toggle(_ itemID: String) {
        if ids.contains(itemID) {
            ids.remove(itemID)
        } else {
            ids.insert(itemID)
        }
        defaults.set(Array(ids), forKey: Self.storageKey)
    }
}
```

- [ ] **Step 4: Regenerate project + run tests**

```bash
cd apps/ios && make project
```
Then run the test target. All four `FavoritesStoreTests` pass.

- [ ] **Step 5: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Core/FavoritesStore.swift apps/ios/PulseCoffeeAppTests/FavoritesStoreTests.swift apps/ios/PulseCoffeeApp.xcodeproj
git commit -m "feat(ios): add local fail-safe FavoritesStore (UserDefaults)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `TabBarVisibility` + hide the custom tab bar in focused mode

The brief's `.toolbar(.hidden, for: .tabBar)` is a no-op here — `MainTabView` is a hand-rolled `ZStack` + custom `PulseTabBar`, not a system `TabView` (spec §5.7). Use a shared `ObservableObject` flag the detail screen sets on appear and clears on disappear.

**Files:**
- Create: `apps/ios/PulseCoffeeApp/Core/TabBarVisibility.swift`
- Modify: `apps/ios/PulseCoffeeApp/Features/Navigation/MainTabView.swift`
- Create/Modify test: `apps/ios/PulseCoffeeAppTests/MainTabTests.swift` (add one logic test)

- [ ] **Step 1: Implement the flag**

Create `apps/ios/PulseCoffeeApp/Core/TabBarVisibility.swift`:

```swift
import Foundation
import Combine

/// Shared signal that the custom `PulseTabBar` should be hidden for a
/// "focused mode" screen (the product detail page). The app does NOT use
/// a system `TabView`, so SwiftUI's `.toolbar(.hidden, for: .tabBar)` has
/// no effect; this flag is the project's equivalent. `MainTabView`
/// observes it; `ItemDetailView` sets `isHidden = true` on appear and
/// `false` on disappear. Fail-safe: default visible.
final class TabBarVisibility: ObservableObject {
    @Published var isHidden: Bool = false
}
```

- [ ] **Step 2: Add a tiny behavior test**

In `apps/ios/PulseCoffeeAppTests/MainTabTests.swift`, add:

```swift
func test_tabBarVisibility_defaultsVisible_andTogglesHidden() {
    let vis = TabBarVisibility()
    XCTAssertFalse(vis.isHidden)
    vis.isHidden = true
    XCTAssertTrue(vis.isHidden)
}
```

- [ ] **Step 3: Wire `MainTabView` to own + react to the flag**

In `apps/ios/PulseCoffeeApp/Features/Navigation/MainTabView.swift`:

Add the state object near the existing `@State private var selection`:
```swift
    @StateObject private var tabBarVisibility = TabBarVisibility()
```

Inject it into the environment so descendants (the pushed `ItemDetailView`) can mutate it, and conditionally render the bar. Replace the `.safeAreaInset(edge: .bottom, spacing: 0) { PulseTabBar(selection: $selection) }` modifier and add the environment object. The `body`'s `ZStack { … }` becomes:

```swift
        ZStack {
            tabContent(.home) { HomeView() }
            tabContent(.menu) { MenuView() }
            tabContent(.orders) { OrdersView() }
            tabContent(.rewards) { RewardsView() }
            tabContent(.account) { AccountView() }
        }
        .animation(.easeInOut(duration: 0.15), value: selection)
        .environmentObject(tabBarVisibility)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !tabBarVisibility.isHidden {
                PulseTabBar(selection: $selection)
                    .transition(.move(edge: .bottom))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: tabBarVisibility.isHidden)
```

> Note: `.environmentObject` on the `ZStack` content makes `tabBarVisibility` available to everything inside the tabs, including the `ItemDetailView` pushed inside `MenuView`'s `NavigationStack`. The `PulseTabBar` in the `safeAreaInset` is a sibling and reads the same `@StateObject` directly.

- [ ] **Step 4: Regenerate + build + run tests**

```bash
cd apps/ios && make project
```
Build succeeds; `MainTabTests` (incl. the new one) pass. (Detail will set the flag in Task 6 — for now the flag exists and the bar reacts to it.)

- [ ] **Step 5: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Core/TabBarVisibility.swift apps/ios/PulseCoffeeApp/Features/Navigation/MainTabView.swift apps/ios/PulseCoffeeAppTests/MainTabTests.swift apps/ios/PulseCoffeeApp.xcodeproj
git commit -m "feat(ios): add TabBarVisibility flag to hide custom tab bar

The app uses a hand-rolled PulseTabBar, so .toolbar(.hidden,for:.tabBar)
is a no-op; this shared flag is the focused-mode equivalent (spec §5.7).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `ItemPairings` resolver (TDD)

Pure function: given the tapped item and the full menu's items, return up to 3 pair-with food items (spec §5.5). Matcha vs coffee is detected from the `artToken` (matcha tokens contain "matcha"); pairings are matched by name keyword so the seed's "Mini Khachapuri" / "Butter Croissant" / "Chocolate Cookie" / "Blueberry Muffin" resolve.

**Files:**
- Create: `apps/ios/PulseCoffeeApp/Features/Menu/ItemPairings.swift`
- Create: `apps/ios/PulseCoffeeAppTests/ItemPairingsTests.swift`

- [ ] **Step 1: Write failing tests**

Create `apps/ios/PulseCoffeeAppTests/ItemPairingsTests.swift`:

```swift
import XCTest
@testable import PulseCoffeeApp

final class ItemPairingsTests: XCTestCase {
    private func food(_ id: String, _ name: String) -> MenuItem {
        MenuItem(id: id, name: name, description: nil, basePriceCents: 400,
                 imageURL: nil, available: true, quantityLeft: nil,
                 modifierGroups: [], artToken: nil)
    }
    private func drink(_ id: String, _ name: String, art: String) -> MenuItem {
        MenuItem(id: id, name: name, description: nil, basePriceCents: 600,
                 imageURL: nil, available: true, quantityLeft: nil,
                 modifierGroups: [], artToken: art)
    }

    private lazy var foods: [MenuItem] = [
        food("f1", "Butter Croissant"),
        food("f2", "Mini Khachapuri"),
        food("f3", "Blueberry Muffin"),
        food("f4", "Chocolate Cookie"),
    ]

    func test_matchaDrink_pairsKhachapuriCroissantCookie() {
        let matcha = drink("d1", "Ginger Matcha", art: "ginger-matcha")
        let names = ItemPairings.resolve(for: matcha, in: foods).map(\.name)
        XCTAssertEqual(names, ["Mini Khachapuri", "Butter Croissant", "Chocolate Cookie"])
    }

    func test_coffeeDrink_pairsCroissantMuffinCookie() {
        let coffee = drink("d2", "Latte", art: "latte")
        let names = ItemPairings.resolve(for: coffee, in: foods).map(\.name)
        XCTAssertEqual(names, ["Butter Croissant", "Blueberry Muffin", "Chocolate Cookie"])
    }

    func test_excludesTheItemItself_andSkipsUnresolved() {
        // A food item opened as detail should not pair with itself; missing
        // keywords are simply skipped (fail-safe).
        let partial = [food("f1", "Butter Croissant")] // only one match available
        let coffee = drink("d2", "Cold Brew", art: "cold-brew")
        let names = ItemPairings.resolve(for: coffee, in: partial).map(\.name)
        XCTAssertEqual(names, ["Butter Croissant"]) // Muffin + Cookie unresolved → skipped
    }
}
```

- [ ] **Step 2: Run, verify failure** (no `ItemPairings` type).

- [ ] **Step 3: Implement**

Create `apps/ios/PulseCoffeeApp/Features/Menu/ItemPairings.swift`:

```swift
import Foundation

/// Resolves the hardcoded "Pair with" suggestions for the product detail
/// screen (spec §5.5). Pure + testable. Pairings are hardcoded for MVP
/// (no recommendation backend yet — see `docs/todo-endpoints.md`).
///
/// Matcha vs coffee is inferred from `artToken` (matcha tokens contain
/// "matcha"), so no category reference is needed on `MenuItem`. Each
/// keyword resolves to the first menu item whose name contains it
/// (case-insensitive); unresolved keywords are skipped (fail-safe), and
/// the detail item never pairs with itself.
enum ItemPairings {
    private static let matchaKeywords = ["Khachapuri", "Croissant", "Cookie"]
    private static let coffeeKeywords = ["Croissant", "Muffin", "Cookie"]

    static func resolve(for item: MenuItem, in allItems: [MenuItem]) -> [MenuItem] {
        let isMatcha = item.artToken?.lowercased().contains("matcha") ?? false
        let keywords = isMatcha ? matchaKeywords : coffeeKeywords
        return keywords.compactMap { keyword in
            allItems.first {
                $0.id != item.id &&
                $0.name.range(of: keyword, options: .caseInsensitive) != nil
            }
        }
    }
}
```

- [ ] **Step 4: Regenerate + run tests** — `cd apps/ios && make project`, then test target green.

- [ ] **Step 5: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Menu/ItemPairings.swift apps/ios/PulseCoffeeAppTests/ItemPairingsTests.swift apps/ios/PulseCoffeeApp.xcodeproj
git commit -m "feat(ios): add pure ItemPairings resolver for pair-with section

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Detail subviews — `ProductDetailComponents.swift`

Small, focused detail-only subviews so `ItemDetailView` (Task 7) stays readable. Each renders exact brief values. These are visual; verify by build + the `#Preview` blocks (no unit tests — they're pure SwiftUI with no logic branches worth asserting; the logic lives in Tasks 2/3/5).

**Files:**
- Create: `apps/ios/PulseCoffeeApp/Features/Menu/ProductDetailComponents.swift`

- [ ] **Step 1: Create the components file**

```swift
import SwiftUI

/// Detail-screen palette tokens not in AppTheme (matches how MenuView
/// inlines `--ink`). Kept local to the product detail surface.
enum DetailPalette {
    static let ink = Color(red: 31 / 255, green: 26 / 255, blue: 20 / 255)          // --ink
    static let inkSoft = Color(red: 31 / 255, green: 26 / 255, blue: 20 / 255).opacity(0.6)
    static let inkFaint = Color(red: 31 / 255, green: 26 / 255, blue: 20 / 255).opacity(0.28)
    static let warmCream = Color(red: 251 / 255, green: 247 / 255, blue: 240 / 255) // page bg / on-ink text
    static let matchaGreen = Color(red: 107 / 255, green: 142 / 255, blue: 61 / 255) // #6b8e3d ready dot
    static let accentWarm = AppTheme.Colors.accentWarm                               // saved heart
}

/// Top-right favorite toggle (spec §5.2). 28pt tap target; empty heart
/// (ink-faint) ↔ filled heart (accent-warm). Non-critical surface —
/// purely toggles the local store, never blocks anything.
struct FavoriteHeart: View {
    @ObservedObject var favorites: FavoritesStore
    let itemID: String

    var body: some View {
        let saved = favorites.isFavorite(itemID)
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            favorites.toggle(itemID)
        } label: {
            Image(systemName: saved ? "heart.fill" : "heart")
                .font(.system(size: 22, weight: .regular))
                .foregroundStyle(saved ? DetailPalette.accentWarm : DetailPalette.inkFaint)
                .frame(width: 28, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(saved ? "Remove from favorites" : "Save to favorites")
    }
}

/// "● Ready in ~4 min" pill with a pulsing matcha-green dot (spec §5.2).
/// Approximate only — never an exact countdown. The dot pulse is a live-
/// status indicator, not decoration (allowed under the "no autoplay
/// animation" rule). TODO: replace `~4 min` with a queue-based estimate
/// once the backend provides one (docs/todo-endpoints.md).
struct ReadyPill: View {
    @State private var pulse = false
    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(DetailPalette.matchaGreen)
                .frame(width: 7, height: 7)
                .opacity(pulse ? 0.35 : 1.0)
                .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: pulse)
            Text("Ready in ~4 min")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(DetailPalette.inkSoft)
        }
        .padding(.vertical, 5)
        .padding(.horizontal, 11)
        .background(Capsule().fill(DetailPalette.matchaGreen.opacity(0.10)))
        .onAppear { pulse = true }
        .accessibilityLabel("Ready in about 4 minutes")
    }
}

/// Monochrome merchandising badge (spec §5.3 / brief #16). Solid ink fill,
/// warm-cream text, 9pt uppercase. Only the three known types render; any
/// other value (or nil) renders nothing (GR#17). NEVER a social-proof
/// number.
struct ItemBadge: View {
    let badgeType: String?

    private var label: String? {
        switch badgeType {
        case "signature": return "Signature"
        case "staff_pick": return "Staff Pick"
        case "seasonal": return "Seasonal"
        default: return nil
        }
    }

    var body: some View {
        if let label {
            Text(label.uppercased())
                .font(.system(size: 9, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(DetailPalette.warmCream)
                .padding(.vertical, 3)
                .padding(.horizontal, 8)
                .background(Capsule().fill(DetailPalette.ink))
        }
    }
}

/// One pair-with card (spec §5.5): 130×100, visual + name + price + `+`.
struct PairWithCard: View {
    let item: MenuItem
    let onAdd: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                DrinkArt(token: item.artToken, size: 34)
                Spacer()
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    onAdd()
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(DetailPalette.warmCream)
                        .frame(width: 24, height: 24)
                        .background(Circle().fill(DetailPalette.ink))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Add \(item.name)")
            }
            Spacer(minLength: 0)
            Text(item.name)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(DetailPalette.ink)
                .lineLimit(2)
            Text(item.displayPrice)
                .font(.system(size: 11))
                .foregroundStyle(DetailPalette.inkSoft)
        }
        .padding(10)
        .frame(width: 130, height: 100, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color(.secondarySystemBackground)))
    }
}

#Preview("Components") {
    VStack(spacing: 16) {
        ReadyPill()
        ItemBadge(badgeType: "signature")
        FavoriteHeart(favorites: FavoritesStore(), itemID: "x")
        PairWithCard(item: MenuItem(id: "f", name: "Butter Croissant", description: nil,
            basePriceCents: 450, imageURL: nil, available: true, quantityLeft: nil,
            modifierGroups: [], artToken: "croissant"), onAdd: {})
    }
    .padding()
}
```

- [ ] **Step 2: Regenerate + build** — `cd apps/ios && make project`, build the app target. No tests (visual components). Confirm the `#Preview` compiles.

- [ ] **Step 3: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Menu/ProductDetailComponents.swift apps/ios/PulseCoffeeApp.xcodeproj
git commit -m "feat(ios): detail subviews (heart, ready pill, badge, pair card)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Rewrite `ItemDetailView` into the premium product page

Assemble the screen (spec §5.2–§5.8). It receives the item + resolved pairings + reads `FavoritesStore` and `TabBarVisibility` from the environment. Hides the tab bar on appear.

**Files:**
- Rewrite: `apps/ios/PulseCoffeeApp/Features/Menu/ItemDetailView.swift`

- [ ] **Step 1: Rewrite the view**

Keep the existing `OptionPill` and `FlowLayout` (they're in this file today and work). Replace the `struct ItemDetailView` and its hero/customize/cta sections with:

```swift
struct ItemDetailView: View {
    @EnvironmentObject private var cart: CartManager
    @EnvironmentObject private var favorites: FavoritesStore
    @EnvironmentObject private var tabBarVisibility: TabBarVisibility
    @Environment(\.dismiss) private var dismiss

    let item: MenuItem
    /// Resolved pair-with food items (passed by MenuView; spec §5.5).
    let pairings: [MenuItem]

    @State private var customization: ItemCustomization
    @State private var didAdd = false

    init(item: MenuItem, pairings: [MenuItem] = []) {
        self.item = item
        self.pairings = pairings
        _customization = State(initialValue: ItemCustomization(item: item))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                hero
                if !item.modifierGroups.isEmpty { customizeSection }
                if !pairings.isEmpty { pairWithSection }
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 24)
            .padding(.top, 4)
        }
        .safeAreaInset(edge: .bottom) { stickyCTA }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // Favorite heart top-right (spec §5.2).
            ToolbarItem(placement: .topBarTrailing) {
                FavoriteHeart(favorites: favorites, itemID: item.id)
            }
        }
        .onAppear { tabBarVisibility.isHidden = true }   // focused mode (spec §5.7)
        .onDisappear { tabBarVisibility.isHidden = false }
    }

    // MARK: - Hero (spec §5.2 / §5.3)

    private var hero: some View {
        VStack(spacing: 10) {
            DrinkArt(token: item.artToken, size: 200)   // ~2× the v1 size
                .padding(.top, 4)
            if item.badgeType != nil {
                ItemBadge(badgeType: item.badgeType)
            }
            Text(item.name)
                .font(.system(size: 30, weight: .regular, design: .serif))
                .multilineTextAlignment(.center)
                .foregroundStyle(DetailPalette.ink)

            // Price (18pt semibold) + estimate label (GR#8 acceptance).
            VStack(spacing: 2) {
                Text(customization.displayPrice)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(DetailPalette.ink)
                Text("Estimated total")
                    .font(.system(size: 10, weight: .medium))
                    .tracking(0.4)
                    .foregroundStyle(DetailPalette.inkFaint)
            }

            ReadyPill()

            // Fixed-size metadata line when there is no Size group (spec §5.3).
            if fixedSizeMetadata != nil {
                Text(fixedSizeMetadata!)
                    .font(.system(size: 12))
                    .foregroundStyle(DetailPalette.inkSoft)
            }

            // Boutique ingredient line (backend-provided description; spec §5/§5.3).
            if let desc = item.description, !desc.isEmpty {
                Text(desc)
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 300)
            }

            // Static brand recommend (spec §5.3). TODO: replace with real
            // "Your Usual ✓ — … + Apply" once order history exists
            // (docs/todo-endpoints.md).
            Text("Pulse recommends: 16 oz · Oat · Full sweet")
                .font(.system(size: 12))
                .foregroundStyle(DetailPalette.inkSoft)
                .padding(.top, 2)
        }
        .frame(maxWidth: .infinity)
    }

    /// "Espresso · 4 oz · Hot"-style line for fixed-size drinks (no Size
    /// group). Oz is hardcoded for the 3 known fixed-size items (brief #10
    /// "hardcode for MVP"); TODO: backend serving_size field
    /// (docs/todo-endpoints.md). Returns nil when a Size group exists.
    private var fixedSizeMetadata: String? {
        let hasSize = item.modifierGroups.contains { $0.name.caseInsensitiveCompare("Size") == .orderedSame }
        guard !hasSize else { return nil }
        let oz: [String: Int] = ["Espresso": 4, "Cortado": 8, "Flat White": 8]
        guard let size = oz[item.name] else { return nil }
        let temp: String
        switch item.temperature {
        case .hot: temp = "Hot"
        case .iced: temp = "Iced"
        case .both: temp = "Hot or Iced"
        }
        return "\(item.name) · \(size) oz · \(temp)"
    }

    // MARK: - Customize (spec §5.4) — "Customize" header removed

    private var customizeSection: some View {
        VStack(alignment: .leading, spacing: 8) {   // 8pt between groups
            ForEach(item.modifierGroups.sorted(by: { $0.sortOrder < $1.sortOrder })) { group in
                optionRow(group)
            }
        }
    }

    private func optionRow(_ group: ModifierGroup) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(group.name.uppercased())
                .font(.system(size: 10, weight: .semibold))
                .tracking(0.8)                       // ~0.08em on 10pt
                .foregroundStyle(.secondary)
            FlowLayout(spacing: 6) {
                ForEach(group.modifiers.sorted(by: { $0.sortOrder < $1.sortOrder })) { modifier in
                    OptionPill(
                        label: modifier.name,
                        isSelected: customization.isSelected(modifier.id, in: group),
                        ink: DetailPalette.ink
                    ) {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()  // spec §5.4
                        customization.toggle(modifierId: modifier.id, in: group)
                    }
                }
            }
        }
        // VoiceOver: group label + current selection (spec §5.4).
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(group.name), current selection \(currentSelectionLabel(group))")
    }

    private func currentSelectionLabel(_ group: ModifierGroup) -> String {
        let names = group.modifiers
            .filter { customization.isSelected($0.id, in: group) }
            .map(\.name)
        return names.isEmpty ? "none" : names.joined(separator: ", ")
    }

    // MARK: - Pair with (spec §5.5)

    private var pairWithSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Pair with")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(DetailPalette.ink)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(pairings) { food in
                        PairWithCard(item: food) { cart.add(item: food) }
                    }
                }
            }
        }
    }

    // MARK: - Sticky CTA (spec §5.6)

    private var stickyCTA: some View {
        VStack(spacing: 0) {
            // Gradient fade so scroll content doesn't collide with the bar.
            LinearGradient(
                colors: [DetailPalette.warmCream.opacity(0), DetailPalette.warmCream],
                startPoint: .top, endPoint: .bottom
            )
            .frame(height: 16)
            .allowsHitTesting(false)

            VStack(spacing: 4) {
                if let hint = customization.firstUnsatisfiedGroupName {
                    Text("Choose a \(hint.lowercased())")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
                Button(action: addToOrder) {
                    HStack {
                        Text(didAdd ? "Added" : "Add to Order")
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)     // survive large Dynamic Type
                        Spacer()
                        Text(customization.displayPrice).opacity(0.85)
                    }
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(DetailPalette.warmCream)
                    .padding(.vertical, 16)
                    .padding(.horizontal, 20)
                    .frame(maxWidth: .infinity)
                    .background(DetailPalette.ink, in: RoundedRectangle(cornerRadius: 14))
                }
                .disabled(!customization.isSatisfied || !item.available || didAdd)
                .opacity((!customization.isSatisfied || !item.available) ? 0.5 : 1)
            }
            .padding(.horizontal, 24)
            .padding(.top, 4)
            .padding(.bottom, 8)   // maintains safeAreaBottom + 8pt via the inset
            .background(DetailPalette.warmCream)
        }
    }

    private func addToOrder() {
        cart.add(item: item, quantity: 1, modifierIds: customization.selectedModifierIds)
        didAdd = true
        Task {
            try? await Task.sleep(nanoseconds: 600_000_000)
            dismiss()
        }
    }
}
```

> Keep the existing `OptionPill` and `FlowLayout` structs in this file unchanged. Update the file's `#Preview` to pass `.environmentObject(FavoritesStore())` and `.environmentObject(TabBarVisibility())` (and the existing `CartManager`) so it compiles.

- [ ] **Step 2: Regenerate + build**

`cd apps/ios && make project` then build the app target. Resolve any compile errors (e.g. preview environment objects).

- [ ] **Step 3: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Menu/ItemDetailView.swift apps/ios/PulseCoffeeApp.xcodeproj
git commit -m "feat(ios): rebuild product detail as a premium product page

Hero (2x drink, badge, 18pt price + Est, ready pill, recommends line),
generic modifier rows with haptics + VoiceOver, pair-with scroll, sticky
estimate CTA with gradient fade. Hides the tab bar in focused mode.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Wire `MenuView` + inject `FavoritesStore` at app root

Pass resolved pairings into the detail destination, and make the two shared stores available.

**Files:**
- Modify: `apps/ios/PulseCoffeeApp/Features/Menu/MenuView.swift`
- Modify: `apps/ios/PulseCoffeeApp/PulseCoffeeApp.swift`

- [ ] **Step 1: Pass pairings into the detail destination**

In `apps/ios/PulseCoffeeApp/Features/Menu/MenuView.swift`, replace the `navigationDestination` builder body so it resolves pairings from the loaded menu:

```swift
            .navigationDestination(isPresented: Binding(
                get: { detailItem != nil },
                set: { presented in if !presented { detailItem = nil } }
            )) {
                if let item = detailItem {
                    ItemDetailView(item: item, pairings: ItemPairings.resolve(for: item, in: allLoadedItems))
                }
            }
```

Add a computed helper on `MenuView` (near `topbarLocationName`):

```swift
    /// Every item across all loaded categories — the pool ItemPairings
    /// matches pair-with suggestions against (spec §5.5).
    private var allLoadedItems: [MenuItem] {
        guard case .loaded = viewModel.state, let menu = viewModel.filteredMenu else { return [] }
        return menu.categories.flatMap(\.items)
    }
```

> If `viewModel.filteredMenu` excludes items under the temperature filter, prefer the unfiltered menu so food (which is `temperature: both`) always resolves. If the view model exposes an unfiltered `menu`, use that here instead of `filteredMenu`; read `MenuViewModel` to confirm which property holds the full tree, and use the fullest one. Food items are `both`, so they survive any temperature filter regardless — `filteredMenu` is acceptable if no unfiltered accessor exists.

- [ ] **Step 2: Inject `FavoritesStore` at the app root**

In `apps/ios/PulseCoffeeApp/PulseCoffeeApp.swift`, where the root view is created with its environment objects (the app already injects `AppState` / `CartManager`), add a `FavoritesStore`:

Add a `@StateObject private var favorites = FavoritesStore()` to the `App` struct (or wherever `CartManager` is created as a `@StateObject`), and add `.environmentObject(favorites)` alongside the existing `.environmentObject(...)` calls on the root view.

> Read `PulseCoffeeApp.swift` first to match the exact place `CartManager` is instantiated/injected, and mirror it. `TabBarVisibility` is owned by `MainTabView` (Task 4) and does NOT need injecting here.

- [ ] **Step 3: Regenerate + build + run full test suite**

`cd apps/ios && make project`, build, run all tests. Everything green.

- [ ] **Step 4: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Menu/MenuView.swift apps/ios/PulseCoffeeApp/PulseCoffeeApp.swift apps/ios/PulseCoffeeApp.xcodeproj
git commit -m "feat(ios): wire pairings into detail + inject FavoritesStore

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Manual verification in the simulator (visual + a11y)

This screen is visual; the unit tests cover the logic (Tasks 1–5). The remaining acceptance criteria are visual/behavioral and need the running app.

- [ ] **Step 1: Run the app** (use the project's run path; see the `run` skill or `apps/ios` README). Open Menu → tap a matcha drink.

- [ ] **Step 2: Walk the acceptance checklist** (spec §6 / brief). Confirm each:
  - Tab bar hidden on detail; restored on back.
  - Drink visual large and dominates above the fold (iPhone 15 Pro); name + price + Size + Milk visible without scrolling.
  - Price under name AND in the sticky bar, both update live as pills change; "Estimated total" label present.
  - "Ready in ~4 min" pill with pulsing dot.
  - One-line boutique description (from backend), no "Customize" header.
  - Modifier order Size → Milk → Sweetness → Extras (matcha); coffee shows syrups, no Sweetness; Espresso shows the fixed-size metadata line and no Size/Milk.
  - All 5 milks inline, no "More".
  - Heart toggles and persists across app relaunch (favorite, kill, relaunch, reopen item).
  - "Pulse recommends" line present; no "Your Usual" (no history).
  - Pair-with horizontal scroll with working `+`.
  - Light haptic on pill tap.
  - No social-proof numbers, no loyalty progress, no calories/caffeine.
  - Dynamic Type at AX5: sticky CTA still visible and tappable (the `minimumScaleFactor` keeps the label readable).
  - VoiceOver reads each group with its current selection.

- [ ] **Step 3:** Record any visual tuning needed and adjust the relevant view (sizes/spacing only — no logic changes). Re-build. This is the one task expected to need iteration against the simulator.

- [ ] **Step 4: Commit any tuning**

```bash
git add apps/ios/PulseCoffeeApp/Features/Menu/ItemDetailView.swift apps/ios/PulseCoffeeApp/Features/Menu/ProductDetailComponents.swift
git commit -m "fix(ios): visual tuning for product detail v2 from simulator pass

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

(Skip this commit if no tuning was needed.)

---

## Task 10: Docs — decision-log entry + iOS README note

**Files:**
- Modify: `docs/decision-log.md` (append)
- Modify: `apps/ios/README.md`

- [ ] **Step 1: Append the decision-log entry**

Add to the end of `docs/decision-log.md`:

```markdown
## 2026-05-29 — [ios] Product Detail v2 — generic renderer, local favorites, custom tab-bar hide

**Decision:** The product detail screen v2 keeps three non-obvious iOS choices:
1. **Generic modifier rendering.** iOS renders whatever modifier groups the backend sends, sorted by `sort_order`, with zero per-drink conditionals. The only per-item iOS logic is the fixed-size metadata line (shown when no Size group is present), the `artToken`-based matcha/coffee split for "Pair with", and the hardcoded oz labels for the 3 fixed-size drinks.
2. **Tab bar hidden via a shared `TabBarVisibility` flag**, not `.toolbar(.hidden, for: .tabBar)` — the latter is a no-op because the app uses a hand-rolled `PulseTabBar` (a `.safeAreaInset` on a `ZStack`), not a system `TabView`. `ItemDetailView` sets the flag on appear / clears on disappear; `MainTabView` conditionally renders the bar.
3. **Favorites stored locally** in `FavoritesStore` (UserDefaults set of item IDs), fail-safe to empty on parse error (GR#17). Backend sync is a deferred seam (`docs/todo-endpoints.md`).

**Context:** The v2 brief asked for a premium product page (drink-as-hero, instant price, favorite, pair-with, focused mode) on top of the working v1 customization core.

**Reasoning:** Keeping iOS a generic renderer means new drinks / modifier changes are backend-only. The custom tab-bar flag is the minimal correct mechanism given the existing navigation shape. Local favorites ship the feature now without blocking on a backend.

**Trade-offs:** "Your Usual" is replaced by a static "Pulse recommends" line until order history exists; the ready-time is hardcoded `~4 min`; fixed-size oz labels are hardcoded on iOS. All three are recorded as seams in `docs/todo-endpoints.md`.
```

- [ ] **Step 2: Add the iOS README note**

In `apps/ios/README.md`, add a short bullet under the appropriate "key files"/architecture section noting:
- `Core/FavoritesStore.swift` — local fail-safe favorites (UserDefaults), backend sync deferred.
- `Core/TabBarVisibility.swift` — focused-mode flag that hides the custom `PulseTabBar` on the product detail screen (the app has no system `TabView`, so `.toolbar(.hidden, for:.tabBar)` does nothing).

> Read the README's existing structure first and match its heading/bullet style; keep the addition to ~2–4 lines.

- [ ] **Step 3: Commit**

```bash
git add docs/decision-log.md apps/ios/README.md
git commit -m "docs: record product-detail-v2 iOS decisions + README notes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review (completed by plan author)

**Spec coverage** (design §5 iOS slice + brief acceptance criteria §6):
- §5.1 cheapest-default → Task 2 ✅
- §5.2 hero (2× drink, heart, price+Est, ready pill) → Tasks 6, 7 ✅
- §5.3 recommends line, fixed-size metadata, badge → Tasks 6, 7 ✅ (`badge_type` decode → Task 1)
- §5.4 generic groups, no Customize header, haptics, VoiceOver → Task 7 ✅
- §5.5 pair-with (resolver + UI + wiring) → Tasks 5, 6, 7, 8 ✅
- §5.6 sticky CTA + gradient + Est + Dynamic Type → Task 7 ✅
- §5.7 tab-bar hide → Task 4 (mechanism) + Task 7 (trigger) ✅
- §5.8 loading/error → handled upstream in `MenuView` (already has loading + retry); detail receives a fully-loaded `MenuItem` so has no async fetch — noted in Task 9. ✅
- Boutique description (#5) → backend-provided, rendered in hero (Task 7) ✅
- Favorites local persistence (#12) → Task 3 ✅
- Docs/decision-log/README/TODO seams → Task 10 (+ backend `docs/todo-endpoints.md` already landed) ✅

**Placeholder scan:** the `// TODO:` strings (Your Usual, queue ready-time, serving_size, favorites sync) are intentional deferred-seam markers tied to `docs/todo-endpoints.md`, not plan gaps. Two steps explicitly say "read the file first and adapt" (MenuViewModel full-menu accessor in Task 8; PulseCoffeeApp injection site in Task 8; README structure in Task 10) — these are genuine "match the existing pattern" instructions, not vague hand-waving; the exact change is specified in each case.

**Type consistency:** `badgeType: String?` used identically in the model (Task 1), `ItemBadge(badgeType:)` (Task 6), and the hero (Task 7). `FavoritesStore` API (`isFavorite(_:)`, `toggle(_:)`, `init(defaults:)`, `storageKey`) matches across Tasks 3, 6, 7, 8. `TabBarVisibility.isHidden` matches across Tasks 4 and 7. `ItemPairings.resolve(for:in:)` matches across Tasks 5 and 8. `ItemDetailView(item:pairings:)` matches across Tasks 7 and 8. `DrinkArt(token:size:)` and `CartManager.add(item:quantity:modifierIds:)` match the real existing signatures.

**XcodeGen:** every task that adds a `.swift` file regenerates with `make project` before building (Tasks 3, 4, 5, 6, 7, 8), per the project's gitignored-pbxproj workflow.
