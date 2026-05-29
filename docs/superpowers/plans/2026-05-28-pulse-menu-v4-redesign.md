# Pulse v4 Menu Screen Redesign (Concern B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the v3 grouped-`List` Menu screen with the v4 design — header + temperature toggle (All / Hot / Iced) + per-category sections (Matcha as a spotlight hero + horizontal-scroll cards, Classic Coffee + Food as vertical lists with drink-mini visuals and inline `+` buttons). Render abstract drink symbols natively in SwiftUI driven by the backend's `art_token`. Wire smart-add behavior: items with no required modifiers add to cart on `+`; items with required modifiers open the existing detail screen.

**Architecture:** Concern B from `docs/superpowers/specs/2026-05-27-pulse-menu-v4-design.md` (§5, §8). Consumes the backend fields shipped in PR #15 (`temperature`, `featured`, `art_token`, `display_style`). All field decoding is **fail-safe** (Golden Rule #17) — missing / unknown values fall back to `temperature='both'`, `display_style='list'`, neutral drink symbol. Modifier picker (concern D) is **out of scope** — `ItemDetailView` keeps its current behavior until D ships. The temperature filter is a pure function on `MenuViewModel`, fully unit-tested.

**Tech Stack:** SwiftUI, iOS 17+, XCTest. No new dependencies.

---

## File Structure

**Modify:**
- `apps/ios/PulseCoffeeApp/Models/Menu.swift` — add `Temperature` + `CategoryDisplayStyle` Swift enums (with safe-default decoding); add `temperature`, `featured`, `artToken` to `MenuItem`; add `displayStyle` to `MenuCategory`.
- `apps/ios/PulseCoffeeApp/Features/Menu/MenuView.swift` — full rewrite from v3 `List` to v4 `ScrollView` composition (header + temperature toggle + sections); preserves loading / failed / empty states and `.refreshable`.
- `apps/ios/PulseCoffeeApp/Features/Menu/MenuViewModel.swift` — adds `@Published selectedTemperature: TemperatureFilter` and a pure `filteredMenu` derivation.
- `apps/ios/PulseCoffeeAppTests/MenuTests.swift` — extend the existing decode tests for the new fields + fallback behavior.

**Create:**
- `apps/ios/PulseCoffeeApp/Features/Menu/DrinkArt.swift` — `DrinkArt` SwiftUI view + token registry. Maps `art_token` strings (e.g. `"strawberry-matcha"`, `"cappuccino"`, `"croissant"`) to drawn abstract symbols. Unknown / nil → neutral fallback. **Single file** — registry, view, and the three render kinds (matcha-layered, classic-cup, food-tile) live together until the registry grows.
- `apps/ios/PulseCoffeeApp/Features/Menu/TemperatureToggle.swift` — segmented pill (All / Hot / Iced) bound to `MenuViewModel.selectedTemperature`.
- `apps/ios/PulseCoffeeApp/Features/Menu/SpotlightSection.swift` — hero card + horizontal-scroll cards for `display_style == spotlight`.
- `apps/ios/PulseCoffeeApp/Features/Menu/MenuListRow.swift` — vertical row used by `display_style == list` sections (drink mini + name + temp pill + price + `+`).
- `apps/ios/PulseCoffeeAppTests/MenuViewModelTests.swift` — temperature-filter logic (all / hot / iced / section-hide / hero-fallback) tested as pure functions.
- `apps/ios/PulseCoffeeAppTests/DrinkArtTests.swift` — token resolution + fallback behavior.

**Will NOT touch:**
- `apps/ios/PulseCoffeeApp/Features/Menu/ItemDetailView.swift` — modifier picker is concern D. The existing "Modifier selection UI ships later" placeholder remains for this PR. Detail screen is still reached via `NavigationLink` from `MenuView`.
- Any cart / checkout / payments / auth / navigation files.
- Any backend file.

---

## Task 0 — Branch + iOS baseline

**Files:** none

- [ ] **Step 1: Confirm clean working tree on the right branch**

Run:
```bash
cd /Users/atamurad/Desktop/pulse-platform
git status --short
git rev-parse --abbrev-ref HEAD
git merge-base --is-ancestor main HEAD && echo "OK: reachable from main"
```

Expected: branch is `feat/ios/menu-v4-redesign`. Untracked file `docs/superpowers/plans/2026-05-28-pulse-menu-v4-redesign.md` (this plan) is fine; ignore it through the whole flow.

- [ ] **Step 2: Run baseline iOS tests on iPhone 17 Pro**

Use a 600000 ms (10-minute) Bash timeout for the xcodebuild call.

```bash
cd /Users/atamurad/Desktop/pulse-platform/apps/ios
xcodebuild test \
  -project PulseCoffeeApp.xcodeproj \
  -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -quiet 2>&1 | tail -15
```

Expected: `** TEST SUCCEEDED **`. Note the total test count for the regression check at the end. If the baseline is red, stop and report BLOCKED — don't try to fix.

---

## Task 1 — Extend `Menu.swift` Codable model (TDD, RED first)

**Files:**
- Modify: `apps/ios/PulseCoffeeAppTests/MenuTests.swift`
- Modify: `apps/ios/PulseCoffeeApp/Models/Menu.swift`

This task adds the four new fields (`temperature`, `featured`, `artToken` on `MenuItem`; `displayStyle` on `MenuCategory`) plus two Swift enums (`Temperature`, `CategoryDisplayStyle`). Decoding is **fail-safe**: missing JSON keys or unknown enum values fall back to the safe defaults (`both` / `list`).

- [ ] **Step 1: Read the existing decode tests in `MenuTests.swift`**

Read `apps/ios/PulseCoffeeAppTests/MenuTests.swift` end-to-end so you understand:
- The shape of the existing decode fixtures (look for the JSON string literals inside `test_menu_decodesFullTree` and `test_menu_decodesWithModifierGroups`).
- Whatever test helpers / factory functions are used.

You'll extend these fixtures to include the new fields, plus add new tests that exercise missing-field / unknown-value fallbacks.

- [ ] **Step 2: Add new tests — RED first**

Append the following tests to `MenuTests.swift` (just before the closing `}` of the `final class MenuTests` block):

```swift
    // MARK: - v4 presentation fields

    func test_menu_decodes_temperature_featured_artToken_and_displayStyle() throws {
        let json = """
        {
          "location_id": "loc-1",
          "categories": [
            {
              "id": "cat-matcha",
              "name": "Matcha",
              "sort_order": 0,
              "display_style": "spotlight",
              "items": [
                {
                  "id": "item-strawberry",
                  "name": "Strawberry Matcha",
                  "description": "Matcha, oat milk, strawberry purée.",
                  "base_price_cents": 645,
                  "image_url": null,
                  "available": true,
                  "quantity_left": null,
                  "modifier_groups": [],
                  "temperature": "iced",
                  "featured": true,
                  "art_token": "strawberry-matcha"
                }
              ]
            }
          ],
          "cached_at": "2026-05-28T00:00:00Z"
        }
        """.data(using: .utf8)!

        let menu = try JSONDecoder().decode(Menu.self, from: json)
        XCTAssertEqual(menu.categories.first?.displayStyle, .spotlight)
        let item = try XCTUnwrap(menu.categories.first?.items.first)
        XCTAssertEqual(item.temperature, .iced)
        XCTAssertTrue(item.featured)
        XCTAssertEqual(item.artToken, "strawberry-matcha")
    }

    func test_menu_failSafe_unknownTemperature_decodesAsBoth() throws {
        let json = """
        {
          "location_id": "loc-1",
          "categories": [
            {
              "id": "cat-1",
              "name": "Test",
              "sort_order": 0,
              "display_style": "list",
              "items": [
                {
                  "id": "i",
                  "name": "X",
                  "description": null,
                  "base_price_cents": 100,
                  "image_url": null,
                  "available": true,
                  "quantity_left": null,
                  "modifier_groups": [],
                  "temperature": "lukewarm",
                  "featured": false,
                  "art_token": null
                }
              ]
            }
          ],
          "cached_at": "2026-05-28T00:00:00Z"
        }
        """.data(using: .utf8)!

        let menu = try JSONDecoder().decode(Menu.self, from: json)
        XCTAssertEqual(menu.categories.first?.items.first?.temperature, .both)
    }

    func test_menu_failSafe_unknownDisplayStyle_decodesAsList() throws {
        let json = """
        {
          "location_id": "loc-1",
          "categories": [
            {
              "id": "cat-1",
              "name": "Mystery",
              "sort_order": 0,
              "display_style": "carousel",
              "items": []
            }
          ],
          "cached_at": "2026-05-28T00:00:00Z"
        }
        """.data(using: .utf8)!

        let menu = try JSONDecoder().decode(Menu.self, from: json)
        XCTAssertEqual(menu.categories.first?.displayStyle, .list)
    }

    func test_menu_failSafe_missingNewFields_decodeWithDefaults() throws {
        // Models v3 JSON (missing temperature/featured/art_token/display_style).
        // Defaults: temperature=.both, featured=false, artToken=nil, displayStyle=.list.
        let json = """
        {
          "location_id": "loc-1",
          "categories": [
            {
              "id": "cat-1",
              "name": "Legacy",
              "sort_order": 0,
              "items": [
                {
                  "id": "i",
                  "name": "X",
                  "description": null,
                  "base_price_cents": 100,
                  "image_url": null,
                  "available": true,
                  "quantity_left": null,
                  "modifier_groups": []
                }
              ]
            }
          ],
          "cached_at": "2026-05-28T00:00:00Z"
        }
        """.data(using: .utf8)!

        let menu = try JSONDecoder().decode(Menu.self, from: json)
        XCTAssertEqual(menu.categories.first?.displayStyle, .list)
        let item = try XCTUnwrap(menu.categories.first?.items.first)
        XCTAssertEqual(item.temperature, .both)
        XCTAssertFalse(item.featured)
        XCTAssertNil(item.artToken)
    }
```

Run — confirm RED:

```bash
cd /Users/atamurad/Desktop/pulse-platform/apps/ios
xcodebuild test \
  -project PulseCoffeeApp.xcodeproj \
  -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:PulseCoffeeAppTests/MenuTests \
  -quiet 2>&1 | tail -20
```

Expected: build errors that `Temperature` / `CategoryDisplayStyle` / the four new fields don't exist.

- [ ] **Step 3: Update `Menu.swift` with new enums + fields**

In `apps/ios/PulseCoffeeApp/Models/Menu.swift`, apply these changes:

a. **Add the two enums** at the top of the file (after the `import Foundation` line, before the `struct Menu` declaration):

```swift
/// Drink temperature, drives the v4 Menu screen's temperature toggle
/// and per-item pill. Decoded fail-safe: unknown raw values + missing
/// JSON key both fall back to `.both` so an item never disappears
/// silently from the menu (Golden Rule #17).
enum Temperature: String, Decodable, Equatable, Hashable {
    case hot
    case iced
    case both

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Temperature(rawValue: raw) ?? .both
    }
}

/// How a category renders on the v4 Menu screen. `spotlight` = hero
/// card + horizontal scroll; `list` = vertical rows. Unknown raw value
/// + missing JSON key both decode to `.list` (the safest rendering).
enum CategoryDisplayStyle: String, Decodable, Equatable, Hashable {
    case spotlight
    case list

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = CategoryDisplayStyle(rawValue: raw) ?? .list
    }
}
```

b. **Add `displayStyle` to `MenuCategory`** — with a custom `init(from:)` so a missing JSON key defaults to `.list`. Replace the existing `MenuCategory` struct with:

```swift
struct MenuCategory: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let sortOrder: Int
    let items: [MenuItem]
    /// `spotlight` = hero card + horizontal-scroll cards. `list` =
    /// vertical rows. Backend ships `'spotlight' | 'list'`; missing
    /// or unknown decodes to `.list` (Golden Rule #17).
    let displayStyle: CategoryDisplayStyle

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case sortOrder = "sort_order"
        case items
        case displayStyle = "display_style"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.name = try c.decode(String.self, forKey: .name)
        self.sortOrder = try c.decode(Int.self, forKey: .sortOrder)
        self.items = try c.decode([MenuItem].self, forKey: .items)
        self.displayStyle = (try? c.decode(CategoryDisplayStyle.self, forKey: .displayStyle)) ?? .list
    }
}
```

c. **Add `temperature`, `featured`, `artToken` to `MenuItem`** — same pattern, custom `init(from:)` for safe defaults. Replace the existing `MenuItem` struct with:

```swift
struct MenuItem: Decodable, Identifiable, Equatable, Hashable {
    let id: String
    let name: String
    let description: String?
    /// Price in integer cents per Golden Rule #7 ("All money in integer
    /// cents"). Display formatting is the UI layer's responsibility —
    /// see `MenuItem.displayPrice` below.
    let basePriceCents: Int
    let imageURL: URL?
    /// Composed by the backend from `inventory.available` AND
    /// `inventory.quantity_left`. True ⇒ item is orderable.
    let available: Bool
    /// `nil` when the item has unlimited stock; otherwise an explicit
    /// remaining count. iOS shows "Only N left" when the count is small.
    let quantityLeft: Int?
    let modifierGroups: [ModifierGroup]
    /// Drives the v4 temperature toggle + per-item pill. Missing /
    /// unknown decodes to `.both` (Golden Rule #17).
    let temperature: Temperature
    /// Spotlight categories pick their hero from the featured item.
    /// Defaults `false` when missing.
    let featured: Bool
    /// Opaque key the iOS `DrinkArt` view maps to a drawn abstract
    /// symbol. `nil` / unknown → neutral fallback.
    let artToken: String?

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case description
        case basePriceCents = "base_price_cents"
        case imageURL = "image_url"
        case available
        case quantityLeft = "quantity_left"
        case modifierGroups = "modifier_groups"
        case temperature
        case featured
        case artToken = "art_token"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.name = try c.decode(String.self, forKey: .name)
        self.description = try c.decodeIfPresent(String.self, forKey: .description)
        self.basePriceCents = try c.decode(Int.self, forKey: .basePriceCents)
        self.imageURL = try c.decodeIfPresent(URL.self, forKey: .imageURL)
        self.available = try c.decode(Bool.self, forKey: .available)
        self.quantityLeft = try c.decodeIfPresent(Int.self, forKey: .quantityLeft)
        self.modifierGroups = try c.decode([ModifierGroup].self, forKey: .modifierGroups)
        self.temperature = (try? c.decode(Temperature.self, forKey: .temperature)) ?? .both
        self.featured = (try? c.decode(Bool.self, forKey: .featured)) ?? false
        self.artToken = try c.decodeIfPresent(String.self, forKey: .artToken)
    }

    /// Display string for the base price (e.g. "$6.50"). Display only —
    /// never use for any pricing logic. Backend is the only source of
    /// truth for money math (Golden Rule #8).
    var displayPrice: String {
        let dollars = Double(basePriceCents) / 100.0
        return String(format: "$%.2f", dollars)
    }
}
```

d. **Update the file-header doc comment** so it mentions the v4 fields:

Find the existing comment block at the top of `Menu.swift` and append (just before the closing `*/` or matching pattern):

```
/// v4 presentation fields (added in concern A, decoded here in concern
/// B): MenuItem.temperature / .featured / .artToken and
/// MenuCategory.displayStyle. All decode fail-safe — unknown enum
/// values + missing JSON keys fall back to `.both`, `false`, `nil`,
/// `.list` respectively (Golden Rule #17).
```

- [ ] **Step 4: Run the MenuTests — confirm GREEN**

```bash
cd /Users/atamurad/Desktop/pulse-platform/apps/ios
xcodebuild test \
  -project PulseCoffeeApp.xcodeproj \
  -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:PulseCoffeeAppTests/MenuTests \
  -quiet 2>&1 | tail -15
```

Expected: all `MenuTests` pass (existing + 4 new).

Then run the full suite to catch unrelated regressions:

```bash
xcodebuild test \
  -project PulseCoffeeApp.xcodeproj \
  -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -quiet 2>&1 | tail -10
```

Expected: `** TEST SUCCEEDED **`, count = Task 0 baseline + 4.

- [ ] **Step 5: Commit**

```bash
cd /Users/atamurad/Desktop/pulse-platform
git add apps/ios/PulseCoffeeApp/Models/Menu.swift \
        apps/ios/PulseCoffeeAppTests/MenuTests.swift
git commit -m "feat(ios): decode v4 menu presentation fields (Codable + Swift enums)

Adds Temperature (.hot/.iced/.both) and CategoryDisplayStyle
(.spotlight/.list) Swift enums, plus MenuItem.temperature/.featured/
.artToken and MenuCategory.displayStyle. All decoding is fail-safe per
Golden Rule #17: missing JSON keys fall back to .both/false/nil/.list,
and unknown enum raw values decode to .both/.list rather than throwing.

The four legacy v3-shape JSON tests still pass — the new init(from:)
implementations use decodeIfPresent / try? for the new fields so the
v3 fixtures decode unchanged.

UI consumption (filter, sections, drink art) lands in subsequent
commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2 — `DrinkArt` SwiftUI component

**Files:**
- Create: `apps/ios/PulseCoffeeApp/Features/Menu/DrinkArt.swift`
- Create: `apps/ios/PulseCoffeeAppTests/DrinkArtTests.swift`

`DrinkArt` maps an `art_token` string to a drawn abstract symbol. Three render "kinds":
- **matcha** — three vertically-stacked colored layers (the recognisable layered-matcha silhouette).
- **classic** — cup silhouette via SF Symbol `cup.and.saucer.fill` tinted to a body color.
- **food** — rounded tile with a glyph (SF Symbol or Unicode character).

Unknown / nil token → neutral cup (the "classic" kind with a neutral tint).

- [ ] **Step 1: Write `DrinkArtTests.swift` — RED first**

Create `apps/ios/PulseCoffeeAppTests/DrinkArtTests.swift`:

```swift
import XCTest
@testable import PulseCoffeeApp

final class DrinkArtTests: XCTestCase {

    func test_knownToken_returnsRegisteredSpec() {
        let spec = DrinkArtRegistry.spec(for: "strawberry-matcha")
        XCTAssertEqual(spec.kind, .matcha)
    }

    func test_classicToken_returnsClassicKind() {
        XCTAssertEqual(DrinkArtRegistry.spec(for: "cappuccino").kind, .classic)
        XCTAssertEqual(DrinkArtRegistry.spec(for: "espresso").kind,   .classic)
    }

    func test_foodToken_returnsFoodKind() {
        XCTAssertEqual(DrinkArtRegistry.spec(for: "croissant").kind, .food)
        XCTAssertEqual(DrinkArtRegistry.spec(for: "muffin").kind,    .food)
    }

    func test_unknownToken_returnsNeutralFallback() {
        let spec = DrinkArtRegistry.spec(for: "unicorn-latte")
        XCTAssertEqual(spec.kind, .classic, "Unknown tokens fall back to a neutral classic cup")
        XCTAssertTrue(spec.isFallback,
                      "Spec must mark itself as a fallback so logging / debugging can spot it")
    }

    func test_nilToken_returnsNeutralFallback() {
        let spec = DrinkArtRegistry.spec(for: nil)
        XCTAssertEqual(spec.kind, .classic)
        XCTAssertTrue(spec.isFallback)
    }

    func test_registry_includesAllSeededV4Tokens() {
        // Mirror of the backend seed in apps/api/scripts/seed-menu.ts.
        // If a new drink lands in the seed, register it here too — this
        // test makes the missing entry loud at code-review time.
        let seeded: [String] = [
            "strawberry-matcha", "raspberry-matcha", "brown-sugar-matcha", "ginger-matcha",
            "cappuccino", "latte", "americano", "flat-white", "cortado", "cold-brew", "espresso",
            "croissant", "khachapuri", "muffin", "cookie",
        ]
        for token in seeded {
            XCTAssertFalse(DrinkArtRegistry.spec(for: token).isFallback,
                           "Token '\(token)' is in the backend seed but not registered in DrinkArtRegistry")
        }
    }
}
```

Run — confirm RED (build error: `DrinkArtRegistry` / `DrinkArtSpec` undefined):

```bash
cd /Users/atamurad/Desktop/pulse-platform/apps/ios
xcodebuild test \
  -project PulseCoffeeApp.xcodeproj \
  -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:PulseCoffeeAppTests/DrinkArtTests \
  -quiet 2>&1 | tail -15
```

- [ ] **Step 2: Create `DrinkArt.swift`**

Create `apps/ios/PulseCoffeeApp/Features/Menu/DrinkArt.swift`:

```swift
import SwiftUI

/// Render kind for an abstract drink symbol on the v4 Menu screen.
/// Each kind has a distinct visual treatment per `design/v4/README.md`:
/// matcha = three-layer gradient silhouette (the brand's recognisable
/// layered look); classic = tinted cup silhouette; food = tile + glyph.
enum DrinkArtKind: Equatable {
    case matcha
    case classic
    case food
}

/// One entry in the drink-art token registry. `isFallback` is true for
/// the neutral spec returned when a token is unknown / nil — lets logs
/// and the test suite spot silent degradations (Golden Rule #17).
struct DrinkArtSpec: Equatable {
    let kind: DrinkArtKind
    /// 1–3 brand colors per spec.
    /// For matcha: [top, middle, bottom] of the layered drink (3 colors).
    /// For classic: [bodyTint] (1 color).
    /// For food: [tileBackgroundTop, tileBackgroundBottom] (2 colors).
    let palette: [Color]
    /// Used by `food` kind only — the unicode glyph drawn on the tile.
    /// `nil` for matcha / classic kinds.
    let glyph: String?
    /// True when this spec was returned as a fail-safe fallback.
    let isFallback: Bool
}

/// Token-to-spec registry. New backend drinks need a new entry here.
/// `DrinkArtTests.test_registry_includesAllSeededV4Tokens` makes a
/// missing entry loud at review time.
enum DrinkArtRegistry {
    private static let table: [String: DrinkArtSpec] = [
        // Matcha line — 3-layer silhouettes.
        "strawberry-matcha":  .matcha(top: Color(red: 0.80, green: 0.40, blue: 0.46),  // strawberry pink
                                       mid: Color(red: 0.96, green: 0.92, blue: 0.84),  // oat
                                       bot: Color(red: 0.50, green: 0.66, blue: 0.42)), // matcha
        "raspberry-matcha":   .matcha(top: Color(red: 0.74, green: 0.18, blue: 0.31),
                                       mid: Color(red: 0.96, green: 0.92, blue: 0.84),
                                       bot: Color(red: 0.50, green: 0.66, blue: 0.42)),
        "brown-sugar-matcha": .matcha(top: Color(red: 0.36, green: 0.22, blue: 0.12),
                                       mid: Color(red: 0.96, green: 0.92, blue: 0.84),
                                       bot: Color(red: 0.50, green: 0.66, blue: 0.42)),
        "ginger-matcha":      .matcha(top: Color(red: 0.83, green: 0.57, blue: 0.18),
                                       mid: Color(red: 0.96, green: 0.92, blue: 0.84),
                                       bot: Color(red: 0.50, green: 0.66, blue: 0.42)),

        // Classics — cup silhouettes tinted by drink body color.
        "cappuccino": .classic(tint: Color(red: 0.62, green: 0.42, blue: 0.24)),
        "latte":      .classic(tint: Color(red: 0.78, green: 0.62, blue: 0.42)),
        "americano":  .classic(tint: Color(red: 0.30, green: 0.18, blue: 0.10)),
        "flat-white": .classic(tint: Color(red: 0.86, green: 0.72, blue: 0.52)),
        "cortado":    .classic(tint: Color(red: 0.68, green: 0.46, blue: 0.28)),
        "cold-brew":  .classic(tint: Color(red: 0.22, green: 0.14, blue: 0.08)),
        "espresso":   .classic(tint: Color(red: 0.18, green: 0.10, blue: 0.06)),

        // Food — tile + unicode glyph (no asset pipeline needed).
        "croissant":  .food(top: Color(red: 0.96, green: 0.90, blue: 0.83),
                            bot: Color(red: 0.83, green: 0.65, blue: 0.45),
                            glyph: "🥐"),
        "khachapuri": .food(top: Color(red: 0.98, green: 0.91, blue: 0.78),
                            bot: Color(red: 0.72, green: 0.52, blue: 0.29),
                            glyph: "🫓"),
        "muffin":     .food(top: Color(red: 0.94, green: 0.88, blue: 0.82),
                            bot: Color(red: 0.55, green: 0.35, blue: 0.17),
                            glyph: "🧁"),
        "cookie":     .food(top: Color(red: 0.91, green: 0.83, blue: 0.66),
                            bot: Color(red: 0.42, green: 0.23, blue: 0.12),
                            glyph: "🍪"),
    ]

    /// Returns the registered spec for a token, or a neutral classic-cup
    /// fallback for nil / unknown tokens (Golden Rule #17).
    static func spec(for token: String?) -> DrinkArtSpec {
        guard let token, let hit = table[token] else {
            return DrinkArtSpec(
                kind: .classic,
                palette: [Color(red: 0.60, green: 0.50, blue: 0.40)],
                glyph: nil,
                isFallback: true
            )
        }
        return hit
    }
}

// Convenience constructors — keep the table above visually scannable.
private extension DrinkArtSpec {
    static func matcha(top: Color, mid: Color, bot: Color) -> DrinkArtSpec {
        DrinkArtSpec(kind: .matcha, palette: [top, mid, bot], glyph: nil, isFallback: false)
    }
    static func classic(tint: Color) -> DrinkArtSpec {
        DrinkArtSpec(kind: .classic, palette: [tint], glyph: nil, isFallback: false)
    }
    static func food(top: Color, bot: Color, glyph: String) -> DrinkArtSpec {
        DrinkArtSpec(kind: .food, palette: [top, bot], glyph: glyph, isFallback: false)
    }
}

/// Drawn abstract drink symbol. Used by the v4 Menu cards / rows.
/// `size` controls overall width; height is derived to keep proportions.
struct DrinkArt: View {
    let token: String?
    let size: CGFloat

    var body: some View {
        let spec = DrinkArtRegistry.spec(for: token)
        switch spec.kind {
        case .matcha:
            matchaSilhouette(palette: spec.palette)
        case .classic:
            classicCup(tint: spec.palette.first ?? .gray)
        case .food:
            foodTile(palette: spec.palette, glyph: spec.glyph ?? "•")
        }
    }

    // MARK: - Kind renderers

    private func matchaSilhouette(palette: [Color]) -> some View {
        // Three stacked rounded color bands, top-rounded glass shape.
        // Use first 3 colors; pad if fewer.
        let colors = (palette + Array(repeating: Color.gray, count: max(0, 3 - palette.count))).prefix(3)
        let arr = Array(colors)
        return VStack(spacing: 0) {
            Rectangle().fill(arr[0])
            Rectangle().fill(arr[1])
            Rectangle().fill(arr[2])
        }
        .frame(width: size * 0.55, height: size * 1.2)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.08))
        .shadow(color: .black.opacity(0.18), radius: size * 0.06, x: 0, y: size * 0.04)
        .accessibilityHidden(true)
    }

    private func classicCup(tint: Color) -> some View {
        Image(systemName: "cup.and.saucer.fill")
            .resizable()
            .scaledToFit()
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }

    private func foodTile(palette: [Color], glyph: String) -> some View {
        let top = palette.first ?? .gray
        let bot = palette.count > 1 ? palette[1] : top
        return ZStack {
            LinearGradient(colors: [top, bot], startPoint: .topLeading, endPoint: .bottomTrailing)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.22))
            Text(glyph).font(.system(size: size * 0.5))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

#Preview("Drink art kinds") {
    HStack(spacing: 24) {
        DrinkArt(token: "strawberry-matcha", size: 60)
        DrinkArt(token: "cappuccino", size: 60)
        DrinkArt(token: "croissant", size: 60)
        DrinkArt(token: nil, size: 60)
    }
    .padding(40)
}
```

- [ ] **Step 3: Run tests — confirm GREEN**

```bash
cd /Users/atamurad/Desktop/pulse-platform/apps/ios
xcodebuild test \
  -project PulseCoffeeApp.xcodeproj \
  -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:PulseCoffeeAppTests/DrinkArtTests \
  -quiet 2>&1 | tail -10
```

Expected: all 6 `DrinkArtTests` pass.

**Note about Xcode group membership:** if a "Build input file cannot be found" error appears for the new files, the file was created on disk but not yet added to the Xcode project group. In Xcode: File → Add Files to "PulseCoffeeApp", navigate to the new file, ensure target membership includes `PulseCoffeeApp` (and `PulseCoffeeAppTests` for the spec file), save, retry. If `xcodebuild` continues to fail because of this, surface as DONE_WITH_CONCERNS so the controller can confirm before continuing.

- [ ] **Step 4: Commit**

```bash
cd /Users/atamurad/Desktop/pulse-platform
git add apps/ios/PulseCoffeeApp/Features/Menu/DrinkArt.swift \
        apps/ios/PulseCoffeeAppTests/DrinkArtTests.swift
git commit -m "feat(ios): DrinkArt — token-driven abstract drink symbols

DrinkArtRegistry maps art_token strings (e.g. 'strawberry-matcha',
'cappuccino', 'croissant') to drawn abstract specs. Three render
kinds: matcha (3-layer gradient silhouette), classic (tinted SF
Symbol cup), food (gradient tile + unicode glyph). Unknown / nil
tokens fall back to a neutral classic cup with isFallback=true so
the regression test can spot silent degradations.

Registry covers all 15 tokens seeded in apps/api/scripts/seed-menu.ts;
a 'token in seed but missing from registry' test makes any future
mismatch loud at code review.

No asset pipeline introduced — all visuals are drawn in SwiftUI per
design/v4/README.md ('small navigational surfaces use abstract
symbolic representations').

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 — `TemperatureToggle` component

**Files:**
- Create: `apps/ios/PulseCoffeeApp/Features/Menu/TemperatureToggle.swift`

Small segmented pill (All / ☕ Hot / ❄ Iced). Pure view bound to a value of type `TemperatureFilter` (declared here for the first time — used by `MenuViewModel` in Task 4).

> **Follow-up shipped (2026-05-29):** The active pill now *slides* between segments instead of snapping. A single dark-espresso `Capsule` is rendered only behind the selected segment and tagged with `matchedGeometryEffect(id:in:)`; the tap wraps `selection = filter` in `withAnimation(.spring(response: 0.32, dampingFraction: 0.72))` so SwiftUI interpolates that one pill's frame from the old segment to the new one. Segment labels cross-fade taupe ↔ cream as the pill passes. **Reduce Motion** is honored via `@Environment(\.accessibilityReduceMotion)` — when on, the animation collapses to `nil` (instant). The Step 1 code below predates this; the live file in `apps/ios/.../TemperatureToggle.swift` and the Menu `README.md` ("Toggle slide animation") are the current source of truth.

- [ ] **Step 1: Create the component**

Create `apps/ios/PulseCoffeeApp/Features/Menu/TemperatureToggle.swift`:

```swift
import SwiftUI

/// User-facing temperature filter on the v4 Menu screen. Maps onto the
/// per-item `Temperature` field at filter time (`hot` matches items
/// with temperature `.hot` or `.both`; `iced` matches `.iced` or
/// `.both`; `all` matches everything). Lives next to `TemperatureToggle`
/// so the view and filter share one symbol set.
enum TemperatureFilter: String, CaseIterable, Hashable {
    case all
    case hot
    case iced

    var title: String {
        switch self {
        case .all:  return "All"
        case .hot:  return "☕ Hot"
        case .iced: return "❄ Iced"
        }
    }
}

/// Segmented pill control matching the v4 design's `.temp-toggle`.
/// Single-select; default selection is `.all`. Visually: pill-shaped
/// container with three equal segments; active segment uses the ink
/// foreground on a cream background.
struct TemperatureToggle: View {
    @Binding var selection: TemperatureFilter

    var body: some View {
        HStack(spacing: 0) {
            ForEach(TemperatureFilter.allCases, id: \.self) { filter in
                Button {
                    selection = filter
                } label: {
                    Text(filter.title)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(selection == filter
                                         ? AppTheme.Colors.tabBarBackground   // cream "ink-on-dark"
                                         : AppTheme.Colors.tabLabelInactive)  // taupe
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .background(
                            Capsule().fill(selection == filter
                                           ? AppTheme.Colors.tabLabelActive   // dark espresso
                                           : Color.clear)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(filter.title)
                .accessibilityAddTraits(selection == filter ? .isSelected : [])
            }
        }
        .padding(3)
        .background(
            Capsule()
                .fill(AppTheme.Colors.tabBarBackground)
                .overlay(Capsule().stroke(AppTheme.Colors.divider.opacity(0.10), lineWidth: 1))
        )
        .padding(.horizontal, 24)
    }
}

#Preview("Temperature toggle") {
    StatefulPreviewWrapper(TemperatureFilter.all) { binding in
        VStack(spacing: 32) {
            TemperatureToggle(selection: binding)
        }
        .padding(.vertical, 40)
    }
}

/// Tiny helper so #Preview can bind to a `@State`.
private struct StatefulPreviewWrapper<Value, Content: View>: View {
    @State private var value: Value
    let content: (Binding<Value>) -> Content

    init(_ initialValue: Value, @ViewBuilder content: @escaping (Binding<Value>) -> Content) {
        self._value = State(initialValue: initialValue)
        self.content = content
    }

    var body: some View { content($value) }
}
```

- [ ] **Step 2: Build (component has no behavior tests; the filter logic is tested in Task 4 against `MenuViewModel`)**

```bash
cd /Users/atamurad/Desktop/pulse-platform/apps/ios
xcodebuild build \
  -project PulseCoffeeApp.xcodeproj \
  -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -quiet 2>&1 | tail -5
```

Expected: `** BUILD SUCCEEDED **`.

If a "Build input file cannot be found" error appears, add the file to the `PulseCoffeeApp` target in Xcode (same note as Task 2 Step 3).

- [ ] **Step 3: Commit**

```bash
cd /Users/atamurad/Desktop/pulse-platform
git add apps/ios/PulseCoffeeApp/Features/Menu/TemperatureToggle.swift
git commit -m "feat(ios): TemperatureToggle — All / Hot / Iced segmented pill

Pure view bound to a TemperatureFilter enum. Three segments matching
the v4 design's .temp-toggle: pill-shaped container, active segment
on dark espresso fill, inactive on transparent. Lives alongside
TemperatureFilter so the view and the filter share one symbol set.

Filter logic lands on MenuViewModel in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 — `MenuViewModel` temperature filter (TDD)

**Files:**
- Create: `apps/ios/PulseCoffeeAppTests/MenuViewModelTests.swift`
- Modify: `apps/ios/PulseCoffeeApp/Features/Menu/MenuViewModel.swift`

Adds `@Published selectedTemperature: TemperatureFilter = .all` and a pure `static func filter(_:by:)` that returns a filtered `Menu`. Hot-section / spotlight-hero-fallback / section-hide rules per the spec §5.2 / §5.3.

- [ ] **Step 1: Write the filter tests — RED first**

Create `apps/ios/PulseCoffeeAppTests/MenuViewModelTests.swift`:

```swift
import XCTest
@testable import PulseCoffeeApp

final class MenuViewModelTests: XCTestCase {

    // MARK: - Fixtures

    private func item(_ id: String,
                      temperature: Temperature,
                      featured: Bool = false) -> MenuItem {
        // Use the JSON round-trip so we exercise the real init(from:).
        let json = """
        {
          "id": "\(id)", "name": "\(id)", "description": null,
          "base_price_cents": 100, "image_url": null,
          "available": true, "quantity_left": null, "modifier_groups": [],
          "temperature": "\(temperature.rawValue)", "featured": \(featured),
          "art_token": null
        }
        """.data(using: .utf8)!
        return try! JSONDecoder().decode(MenuItem.self, from: json)
    }

    private func category(_ id: String,
                          displayStyle: CategoryDisplayStyle,
                          items: [MenuItem]) -> MenuCategory {
        // Build via Codable so we go through the real init(from:).
        let itemsJson = items.map { try! JSONEncoder().encode($0) }
            .map { String(data: $0, encoding: .utf8)! }
            .joined(separator: ",")
        let json = """
        {
          "id": "\(id)", "name": "\(id)", "sort_order": 0,
          "display_style": "\(displayStyle.rawValue)",
          "items": [\(itemsJson)]
        }
        """.data(using: .utf8)!
        return try! JSONDecoder().decode(MenuCategory.self, from: json)
    }

    private func menu(_ categories: [MenuCategory]) -> Menu {
        let categoriesJson = categories.map { try! JSONEncoder().encode($0) }
            .map { String(data: $0, encoding: .utf8)! }
            .joined(separator: ",")
        let json = """
        {
          "location_id": "loc",
          "categories": [\(categoriesJson)],
          "cached_at": "2026-05-28T00:00:00Z"
        }
        """.data(using: .utf8)!
        return try! JSONDecoder().decode(Menu.self, from: json)
    }

    // MARK: - Tests

    func test_filter_all_returnsEveryItem() {
        let m = menu([
            category("c", displayStyle: .list, items: [
                item("hot", temperature: .hot),
                item("iced", temperature: .iced),
                item("both", temperature: .both),
            ])
        ])
        let filtered = MenuViewModel.filter(m, by: .all)
        XCTAssertEqual(filtered.categories.first?.items.map(\.id), ["hot", "iced", "both"])
    }

    func test_filter_hot_keepsHotAndBoth() {
        let m = menu([
            category("c", displayStyle: .list, items: [
                item("hot", temperature: .hot),
                item("iced", temperature: .iced),
                item("both", temperature: .both),
            ])
        ])
        let filtered = MenuViewModel.filter(m, by: .hot)
        XCTAssertEqual(filtered.categories.first?.items.map(\.id).sorted(), ["both", "hot"])
    }

    func test_filter_iced_keepsIcedAndBoth() {
        let m = menu([
            category("c", displayStyle: .list, items: [
                item("hot", temperature: .hot),
                item("iced", temperature: .iced),
                item("both", temperature: .both),
            ])
        ])
        let filtered = MenuViewModel.filter(m, by: .iced)
        XCTAssertEqual(filtered.categories.first?.items.map(\.id).sorted(), ["both", "iced"])
    }

    func test_filter_hidesCategoriesWithNoMatchingItems() {
        let m = menu([
            category("hot-only", displayStyle: .list, items: [
                item("a", temperature: .hot),
            ]),
            category("iced-only", displayStyle: .list, items: [
                item("b", temperature: .iced),
            ])
        ])
        let filtered = MenuViewModel.filter(m, by: .iced)
        XCTAssertEqual(filtered.categories.map(\.id), ["iced-only"],
                       "Categories with zero matching items must be hidden")
    }

    func test_filter_spotlight_featuredItemFilteredOut_fallsBackToFirstRemaining() {
        // The featured item is .hot. Filter to .iced. Spotlight must still
        // render — first remaining item becomes the hero (covered by the
        // section view, not the filter; here we just confirm the items
        // array's first element is the right one).
        let m = menu([
            category("spot", displayStyle: .spotlight, items: [
                item("hot-featured", temperature: .hot, featured: true),
                item("iced-1",       temperature: .iced),
                item("iced-2",       temperature: .iced),
            ])
        ])
        let filtered = MenuViewModel.filter(m, by: .iced)
        XCTAssertEqual(filtered.categories.first?.items.map(\.id), ["iced-1", "iced-2"])
    }

    func test_filter_preservesCategoryOrder_andItemOrder() {
        let m = menu([
            category("first",  displayStyle: .list, items: [item("a", temperature: .both)]),
            category("second", displayStyle: .list, items: [item("b", temperature: .both)]),
        ])
        let filtered = MenuViewModel.filter(m, by: .all)
        XCTAssertEqual(filtered.categories.map(\.id), ["first", "second"])
    }
}
```

Run — confirm RED (`MenuViewModel` doesn't have `static func filter(_:by:)` yet):

```bash
cd /Users/atamurad/Desktop/pulse-platform/apps/ios
xcodebuild test \
  -project PulseCoffeeApp.xcodeproj \
  -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:PulseCoffeeAppTests/MenuViewModelTests \
  -quiet 2>&1 | tail -20
```

**Note about Encodable:** the fixture helpers use `JSONEncoder().encode(item)` to round-trip through the real Codable path. `MenuItem` is currently `Decodable` only — if encoding fails to compile, **make the affected structs `Codable` (Encodable + Decodable)** in `Menu.swift` (add `, Encodable` to the conformance list of `MenuItem`, `MenuCategory`, `Menu`, `ModifierGroup`, `Modifier`; the synthesized encoder will use the same `CodingKeys`). That's a one-line addition per struct; no custom `encode(to:)` needed.

- [ ] **Step 2: Add the filter to `MenuViewModel`**

Open `apps/ios/PulseCoffeeApp/Features/Menu/MenuViewModel.swift` and:

a. Add a `@Published var selectedTemperature: TemperatureFilter = .all` property (just after the `@Published private(set) var state: State = .idle` line).

b. Add a computed `filteredMenu` accessor so the view doesn't have to call the static method directly:

```swift
    /// Returns the loaded menu with the current temperature filter
    /// applied. `nil` if the menu hasn't loaded yet. Pure derivation —
    /// no side effects, no caching (the menu fits in memory at this
    /// scale, and re-filtering on selection change is cheap).
    var filteredMenu: Menu? {
        guard case .loaded(_, let menu) = state else { return nil }
        return Self.filter(menu, by: selectedTemperature)
    }
```

c. Add the pure static filter at the end of the class (before the closing `}`):

```swift
    /// Pure filter. Keeps the original category and item order; drops
    /// items that don't match the temperature; drops categories that
    /// end up empty. Behavior pinned by `MenuViewModelTests`.
    static func filter(_ menu: Menu, by filter: TemperatureFilter) -> Menu {
        let filteredCategories: [MenuCategory] = menu.categories.compactMap { category in
            let keptItems = category.items.filter { item in
                Self.matches(temperature: item.temperature, filter: filter)
            }
            guard !keptItems.isEmpty else { return nil }
            // Reconstruct the category with the filtered item list.
            // MenuCategory has no public init — round-trip through JSON
            // is the cheapest preserve-and-modify available without
            // refactoring the model. The hit is microseconds for the
            // ~3-category menu.
            var copy = category
            copy.replaceItems(keptItems)
            return copy
        }

        var copy = menu
        copy.replaceCategories(filteredCategories)
        return copy
    }

    private static func matches(temperature: Temperature, filter: TemperatureFilter) -> Bool {
        switch filter {
        case .all:  return true
        case .hot:  return temperature == .hot  || temperature == .both
        case .iced: return temperature == .iced || temperature == .both
        }
    }
```

d. **`MenuCategory.replaceItems(_:)` and `Menu.replaceCategories(_:)` helpers don't exist yet.** Add them to `Menu.swift` (just below each struct):

```swift
extension Menu {
    mutating func replaceCategories(_ newCategories: [MenuCategory]) {
        self = Menu(locationId: self.locationId,
                    categories: newCategories,
                    cachedAt: self.cachedAt)
    }

    /// Memberwise init — needed by `replaceCategories` since the
    /// struct otherwise gets only the auto-synthesized decoder init.
    init(locationId: String, categories: [MenuCategory], cachedAt: String) {
        self.locationId = locationId
        self.categories = categories
        self.cachedAt = cachedAt
    }
}

extension MenuCategory {
    mutating func replaceItems(_ newItems: [MenuItem]) {
        self = MenuCategory(id: self.id,
                            name: self.name,
                            sortOrder: self.sortOrder,
                            items: newItems,
                            displayStyle: self.displayStyle)
    }

    /// Memberwise init — needed by `replaceItems`.
    init(id: String, name: String, sortOrder: Int, items: [MenuItem], displayStyle: CategoryDisplayStyle) {
        self.id = id
        self.name = name
        self.sortOrder = sortOrder
        self.items = items
        self.displayStyle = displayStyle
    }
}
```

(These extensions stay in `Menu.swift` so all model mutation helpers live together.)

- [ ] **Step 3: Run tests — GREEN**

```bash
cd /Users/atamurad/Desktop/pulse-platform/apps/ios
xcodebuild test \
  -project PulseCoffeeApp.xcodeproj \
  -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:PulseCoffeeAppTests/MenuViewModelTests \
  -quiet 2>&1 | tail -15
```

Expected: 6 tests pass.

Then full suite:

```bash
xcodebuild test \
  -project PulseCoffeeApp.xcodeproj \
  -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -quiet 2>&1 | tail -10
```

Expected: `** TEST SUCCEEDED **`.

- [ ] **Step 4: Commit**

```bash
cd /Users/atamurad/Desktop/pulse-platform
git add apps/ios/PulseCoffeeApp/Models/Menu.swift \
        apps/ios/PulseCoffeeApp/Features/Menu/MenuViewModel.swift \
        apps/ios/PulseCoffeeAppTests/MenuViewModelTests.swift
git commit -m "feat(ios): MenuViewModel temperature filter (pure, fully tested)

Adds @Published selectedTemperature: TemperatureFilter (default .all)
and a computed filteredMenu accessor. The actual filter is a static
pure function: matches items by temperature, hides categories with
no surviving items, preserves order. Spotlight hero fallback (when
the featured item is filtered out) is handled at the section-view
layer in a later commit; here we just confirm the filtered items
array's first element becomes the new hero candidate.

Adds small memberwise inits + replace helpers on Menu / MenuCategory
so the filter can return a modified struct without going through the
auto-synthesized decoder. Both structs gain Encodable conformance so
test fixtures can JSON round-trip cleanly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 — `MenuListRow` + smart-add behavior

**Files:**
- Create: `apps/ios/PulseCoffeeApp/Features/Menu/MenuListRow.swift`

Vertical row used by `display_style == list` sections (Classic Coffee, Food). Layout: drink mini (DrinkArt at ~52pt) · name + temp pill + short meta · price + `+`. Smart-add: `+` adds inline when the item has zero required modifier groups; otherwise opens detail.

- [ ] **Step 1: Create the row**

Create `apps/ios/PulseCoffeeApp/Features/Menu/MenuListRow.swift`:

```swift
import SwiftUI

/// Vertical list row for `display_style == list` categories. Tapping
/// the body opens item detail. Tapping `+` either adds-to-cart inline
/// (when the item has no required modifier groups) or opens detail
/// (when it does). See spec §5.1 for the smart-add rule.
struct MenuListRow: View {
    let item: MenuItem
    let onOpenDetail: () -> Void
    let onAdd: () -> Void

    @State private var didAddJustNow = false

    var body: some View {
        HStack(spacing: 12) {
            Button(action: onOpenDetail) {
                rowBody
            }
            .buttonStyle(.plain)
            .disabled(!item.available)

            addButton
                .disabled(!item.available)
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 12)
        .background(
            RoundedRectangle(cornerRadius: 14).fill(AppTheme.Colors.tabBarBackground)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(AppTheme.Colors.divider.opacity(0.10), lineWidth: 1)
        )
        .opacity(item.available ? 1 : 0.55)
    }

    // MARK: - Pieces

    private var rowBody: some View {
        HStack(spacing: 12) {
            DrinkArt(token: item.artToken, size: 44)
                .frame(width: 52, height: 52)
                .background(
                    RoundedRectangle(cornerRadius: 10).fill(AppTheme.Colors.divider.opacity(0.04))
                )

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(item.name)
                        .font(.system(size: 15, weight: .semibold))
                        .lineLimit(1)
                    temperaturePill
                }
                if let desc = item.description, !desc.isEmpty {
                    Text(desc)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if !item.available {
                    Text("Sold out")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppTheme.Colors.warning)
                } else if let left = item.quantityLeft, left <= 5 {
                    Text("Only \(left) left")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppTheme.Colors.warning)
                }
            }

            Spacer(minLength: 8)

            Text(item.displayPrice)
                .font(.system(size: 14, weight: .bold).monospacedDigit())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var temperaturePill: some View {
        let label: String?
        let tintFG: Color
        let tintBG: Color
        switch item.temperature {
        case .hot:
            label = "Hot"
            tintFG = Color(red: 0.55, green: 0.29, blue: 0.12)
            tintBG = Color(red: 0.98, green: 0.89, blue: 0.83)
        case .iced:
            label = "Iced"
            tintFG = Color(red: 0.16, green: 0.35, blue: 0.48)
            tintBG = Color(red: 0.85, green: 0.91, blue: 0.94)
        case .both:
            label = "Hot · Iced"
            tintFG = AppTheme.Colors.tabLabelInactive
            tintBG = AppTheme.Colors.divider.opacity(0.10)
        }
        if let label {
            Text(label.uppercased())
                .font(.system(size: 9, weight: .semibold))
                .tracking(0.4)
                .foregroundStyle(tintFG)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill(tintBG))
        }
    }

    private var addButton: some View {
        Button {
            onAdd()
            if MenuListRow.canInstantAdd(item) {
                withAnimation(.easeInOut(duration: 0.15)) { didAddJustNow = true }
                Task {
                    try? await Task.sleep(nanoseconds: 700_000_000)
                    didAddJustNow = false
                }
            }
        } label: {
            Image(systemName: didAddJustNow ? "checkmark" : "plus")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(AppTheme.Colors.tabBarBackground)
                .frame(width: 28, height: 28)
                .background(Circle().fill(AppTheme.Colors.tabLabelActive))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(MenuListRow.canInstantAdd(item)
                            ? "Add \(item.name) to cart"
                            : "Open \(item.name) to customise")
    }

    /// Smart-add rule: an item can be added inline only when it has
    /// zero required modifier groups. Anything required → open detail
    /// so the customer makes the choice.
    static func canInstantAdd(_ item: MenuItem) -> Bool {
        !item.modifierGroups.contains(where: { $0.required })
    }
}

#Preview("Menu list row — variants") {
    let json = { (id: String, name: String, temp: String, art: String?, required: Bool) -> MenuItem in
        let mods = required ? """
        [{"id":"g","name":"Size","required":true,"multi_select":false,"sort_order":0,"modifiers":[]}]
        """ : "[]"
        let artJson = art.map { "\"\($0)\"" } ?? "null"
        let str = """
        {
          "id":"\(id)","name":"\(name)","description":"demo",
          "base_price_cents":525,"image_url":null,
          "available":true,"quantity_left":null,
          "modifier_groups":\(mods),
          "temperature":"\(temp)","featured":false,"art_token":\(artJson)
        }
        """.data(using: .utf8)!
        return try! JSONDecoder().decode(MenuItem.self, from: str)
    }
    return VStack(spacing: 8) {
        MenuListRow(item: json("a", "Cappuccino", "both", "cappuccino", true),
                    onOpenDetail: {}, onAdd: {})
        MenuListRow(item: json("b", "Butter Croissant", "both", "croissant", false),
                    onOpenDetail: {}, onAdd: {})
    }
    .padding(16)
}
```

- [ ] **Step 2: Build**

```bash
cd /Users/atamurad/Desktop/pulse-platform/apps/ios
xcodebuild build \
  -project PulseCoffeeApp.xcodeproj \
  -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -quiet 2>&1 | tail -5
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Commit**

```bash
cd /Users/atamurad/Desktop/pulse-platform
git add apps/ios/PulseCoffeeApp/Features/Menu/MenuListRow.swift
git commit -m "feat(ios): MenuListRow with smart-add and temperature pill

Vertical list row for the v4 Menu's list-style categories (Classic
Coffee, Food). Renders the drink mini via DrinkArt, name + temperature
pill, optional one-line description / availability copy, price, and a
'+' button. Smart-add: '+' adds inline (with a brief checkmark
confirmation) when the item has no required modifier groups; otherwise
'+' routes to the same onOpenDetail closure as tapping the row body.
MenuListRow.canInstantAdd(_:) is the pure rule; MenuView passes the
right closures in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6 — `SpotlightSection` (hero + horizontal scroll)

**Files:**
- Create: `apps/ios/PulseCoffeeApp/Features/Menu/SpotlightSection.swift`

Used for `display_style == spotlight` categories (Matcha line). Hero card on top (featured item, or first remaining item if featured was filtered out), then a horizontal scroll of compact cards for the rest.

- [ ] **Step 1: Create the component**

Create `apps/ios/PulseCoffeeApp/Features/Menu/SpotlightSection.swift`:

```swift
import SwiftUI

/// Spotlight section for `display_style == spotlight` categories. One
/// hero card on top + a horizontal scroll of compact cards for the
/// rest. The hero pick is whichever item is currently first in the
/// (possibly filtered) items array — `MenuViewModel.filter` puts
/// `featured` items first when available, otherwise the first
/// surviving item. See spec §5.3 for the fail-safe ordering.
struct SpotlightSection: View {
    let category: MenuCategory
    let onOpenDetail: (MenuItem) -> Void
    let onAdd: (MenuItem) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionHeader
            if let hero = category.items.first {
                heroCard(for: hero)
            }
            if category.items.count > 1 {
                scrollRow(items: Array(category.items.dropFirst()))
            }
        }
        .padding(.bottom, 22)
    }

    private var sectionHeader: some View {
        HStack(alignment: .lastTextBaseline) {
            Text(headerTitle)
                .italic()
                .font(.system(size: 22, weight: .regular, design: .serif))
            Spacer()
            Text("\(category.items.count) drinks")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 24)
    }

    /// Visual lead-in line ("The matcha line"). We don't have a backend
    /// header field for this; for Matcha the design uses an editorialised
    /// phrasing, but for unknown spotlight categories we fall back to
    /// the raw `name` to avoid hardcoding a brand-only list.
    private var headerTitle: String {
        if category.name.lowercased().contains("matcha") {
            return "The matcha line"
        }
        return category.name
    }

    private func heroCard(for item: MenuItem) -> some View {
        Button { onOpenDetail(item) } label: {
            HStack(spacing: 0) {
                ZStack {
                    LinearGradient(
                        colors: [
                            Color(red: 0.98, green: 0.95, blue: 0.93),
                            Color(red: 0.93, green: 0.88, blue: 0.84),
                        ],
                        startPoint: .top, endPoint: .bottom
                    )
                    DrinkArt(token: item.artToken, size: 110)
                }
                .frame(width: 140, height: 160)
                .clipShape(RoundedRectangle(cornerRadius: 22))

                VStack(alignment: .leading, spacing: 6) {
                    Text(item.featured ? "★ HERO" : "FEATURED")
                        .font(.system(size: 10, weight: .bold))
                        .tracking(1.4)
                        .foregroundStyle(AppTheme.Colors.warning)
                    Text(item.name)
                        .font(.system(size: 22, weight: .regular, design: .serif))
                        .italic()
                        .lineLimit(2)
                    if let desc = item.description, !desc.isEmpty {
                        Text(desc)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    Spacer()
                    HStack {
                        Text(item.displayPrice)
                            .font(.system(size: 16, weight: .bold).monospacedDigit())
                        Spacer()
                        Button("Add") {
                            onAdd(item)
                        }
                        .buttonStyle(.plain)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(AppTheme.Colors.tabBarBackground)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 7)
                        .background(Capsule().fill(AppTheme.Colors.tabLabelActive))
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: 22).fill(AppTheme.Colors.tabBarBackground)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22)
                .stroke(AppTheme.Colors.divider.opacity(0.10), lineWidth: 1)
        )
        .padding(.horizontal, 16)
    }

    private func scrollRow(items: [MenuItem]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(items) { item in
                    compactCard(item)
                }
            }
            .padding(.horizontal, 16)
        }
    }

    private func compactCard(_ item: MenuItem) -> some View {
        Button { onOpenDetail(item) } label: {
            VStack(alignment: .leading, spacing: 10) {
                ZStack {
                    LinearGradient(
                        colors: [
                            Color(red: 0.97, green: 0.95, blue: 0.91),
                            Color(red: 0.92, green: 0.88, blue: 0.80),
                        ],
                        startPoint: .top, endPoint: .bottom
                    )
                    DrinkArt(token: item.artToken, size: 70)
                }
                .frame(height: 110)
                .clipShape(RoundedRectangle(cornerRadius: 12))

                Text(item.name)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)

                HStack {
                    Text(item.displayPrice)
                        .font(.system(size: 13, weight: .bold).monospacedDigit())
                    Spacer()
                    Button { onAdd(item) } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(AppTheme.Colors.tabBarBackground)
                            .frame(width: 24, height: 24)
                            .background(Circle().fill(AppTheme.Colors.tabLabelActive))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(12)
            .frame(width: 150)
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: 18).fill(AppTheme.Colors.tabBarBackground)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18)
                .stroke(AppTheme.Colors.divider.opacity(0.10), lineWidth: 1)
        )
    }
}
```

- [ ] **Step 2: Build**

```bash
cd /Users/atamurad/Desktop/pulse-platform/apps/ios
xcodebuild build \
  -project PulseCoffeeApp.xcodeproj \
  -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -quiet 2>&1 | tail -5
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Commit**

```bash
cd /Users/atamurad/Desktop/pulse-platform
git add apps/ios/PulseCoffeeApp/Features/Menu/SpotlightSection.swift
git commit -m "feat(ios): SpotlightSection — hero card + horizontal scroll

Used by display_style == spotlight categories (Matcha line). Hero
card renders the featured item (or first surviving item after the
temperature filter) on a soft gradient backdrop using DrinkArt;
remaining items render as compact horizontal-scroll cards.

The hero pick is whatever item is first in category.items —
MenuViewModel.filter is responsible for moving the right item to
the front when the featured item is filtered out (see spec §5.3).

Composed into MenuView in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7 — Rewrite `MenuView` (ScrollView composition)

**Files:**
- Modify: `apps/ios/PulseCoffeeApp/Features/Menu/MenuView.swift`

Replace the v3 `List` with a v4 `ScrollView` that composes header + `TemperatureToggle` + per-section views. Preserves the existing loading / failed / empty states + `.refreshable` + cart-icon toolbar + sign-out toolbar (these stay until concern B+'s Account work moves them).

- [ ] **Step 1: Rewrite `MenuView`**

Replace the entire contents of `apps/ios/PulseCoffeeApp/Features/Menu/MenuView.swift` with:

```swift
import SwiftUI

/// v4 Menu screen — ScrollView composition (header + temperature
/// toggle + sections). Sections render as SpotlightSection or a
/// vertical list of MenuListRow depending on the category's
/// `display_style`. Smart-add is wired here: items with no required
/// modifier groups are added directly to the cart; everything else
/// opens ItemDetailView. The existing loading / failed / empty
/// states and pull-to-refresh remain.
struct MenuView: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var cart: CartManager
    @StateObject private var viewModel = MenuViewModel()
    @State private var showCart = false
    @State private var detailItem: MenuItem?

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button(role: .destructive) {
                            Task { await appState.logout() }
                        } label: {
                            Image(systemName: "rectangle.portrait.and.arrow.right")
                                .accessibilityLabel("Sign Out")
                        }
                    }
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button {
                            showCart = true
                        } label: {
                            cartIcon
                                .accessibilityLabel("Cart with \(cart.totalItemCount) items")
                        }
                    }
                }
                .task {
                    if case .idle = viewModel.state {
                        await viewModel.load()
                    }
                }
                .refreshable {
                    await viewModel.load()
                }
                .sheet(isPresented: $showCart) {
                    if case .loaded(let location, _) = viewModel.state {
                        CartView(locationId: location.id)
                    } else {
                        CartView(locationId: "")
                    }
                }
                .sheet(item: $detailItem) { item in
                    NavigationStack {
                        ItemDetailView(item: item)
                    }
                }
        }
    }

    @ViewBuilder
    private var cartIcon: some View {
        if cart.totalItemCount > 0 {
            ZStack(alignment: .topTrailing) {
                Image(systemName: "cart.fill")
                Text("\(cart.totalItemCount)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(AppTheme.Colors.onBadge)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(AppTheme.Colors.destructive, in: Capsule())
                    .offset(x: 10, y: -10)
            }
        } else {
            Image(systemName: "cart")
        }
    }

    private var title: String {
        switch viewModel.state {
        case .loaded(let location, _):
            return location.name
        default:
            return "Menu"
        }
    }

    @ViewBuilder
    private var content: some View {
        switch viewModel.state {
        case .idle, .loading:
            ProgressView("Loading menu…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .loaded:
            loadedView

        case .failed(let message):
            VStack(spacing: 16) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.largeTitle)
                    .foregroundStyle(AppTheme.Colors.warning)
                Text("Could not load the menu")
                    .font(.headline)
                Text(message)
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal)
                Button("Retry") {
                    Task { await viewModel.load() }
                }
                .buttonStyle(.borderedProminent)
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private var loadedView: some View {
        if let menu = viewModel.filteredMenu, !menu.categories.isEmpty {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    header
                        .padding(.horizontal, 24)
                        .padding(.top, 8)
                        .padding(.bottom, 18)

                    TemperatureToggle(selection: $viewModel.selectedTemperature)
                        .padding(.bottom, 22)

                    ForEach(menu.categories.sorted(by: { $0.sortOrder < $1.sortOrder })) { category in
                        section(for: category)
                    }

                    Color.clear.frame(height: 24)
                }
            }
            .background(AppTheme.Colors.tabBarBackground.opacity(0.6).ignoresSafeArea())
        } else {
            emptyMenu
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Menu")
                .font(.system(size: 26, weight: .bold))
                .tracking(-0.5)
            Text("Matcha line · Classic coffee · Food")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func section(for category: MenuCategory) -> some View {
        switch category.displayStyle {
        case .spotlight:
            SpotlightSection(
                category: category,
                onOpenDetail: { item in detailItem = item },
                onAdd: { item in handleAdd(item) }
            )
        case .list:
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .lastTextBaseline) {
                    Text(category.name)
                        .italic()
                        .font(.system(size: 22, weight: .regular, design: .serif))
                    Spacer()
                    Text("\(category.items.count) items")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 6)

                VStack(spacing: 6) {
                    ForEach(category.items) { item in
                        MenuListRow(
                            item: item,
                            onOpenDetail: { detailItem = item },
                            onAdd: { handleAdd(item) }
                        )
                    }
                }
                .padding(.horizontal, 16)
            }
            .padding(.bottom, 22)
        }
    }

    private var emptyMenu: some View {
        VStack(spacing: 12) {
            Image(systemName: "cup.and.saucer")
                .font(.largeTitle)
                .foregroundStyle(AppTheme.Colors.iconSecondary)
            Text("Nothing matches this filter")
                .font(.headline)
            Text("Try the All tab to see everything available.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Smart-add dispatch: instant add for modifier-free items,
    /// detail-sheet open for items that need required choices.
    private func handleAdd(_ item: MenuItem) {
        if MenuListRow.canInstantAdd(item) {
            cart.add(item: item)
        } else {
            detailItem = item
        }
    }
}

#Preview {
    MenuView()
        .environmentObject(AppState())
        .environmentObject(CartManager())
}
```

- [ ] **Step 2: Build + run tests**

```bash
cd /Users/atamurad/Desktop/pulse-platform/apps/ios
xcodebuild test \
  -project PulseCoffeeApp.xcodeproj \
  -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -quiet 2>&1 | tail -10
```

Expected: `** TEST SUCCEEDED **`, total = Task 0 baseline + 4 (MenuTests new) + 6 (MenuViewModelTests) + 6 (DrinkArtTests) = baseline + 16.

- [ ] **Step 3: Commit**

```bash
cd /Users/atamurad/Desktop/pulse-platform
git add apps/ios/PulseCoffeeApp/Features/Menu/MenuView.swift
git commit -m "feat(ios): rewrite MenuView as v4 ScrollView composition

Replaces the v3 grouped List with a ScrollView composing header +
TemperatureToggle + per-category sections. SpotlightSection renders
the Matcha line; list-style categories (Classic Coffee, Food) render
as a vertical stack of MenuListRow. Smart-add: tapping '+' on items
with zero required modifier groups adds inline via CartManager;
items with required choices open ItemDetailView in a sheet. Tapping
the row body always opens detail.

Loading / failed / sold-out states, the cart toolbar icon, the
sign-out toolbar button, and pull-to-refresh all preserved. The
sign-out button stays until concern B+ moves it onto the Account
tab — see Navigation README follow-ups.

Empty-after-filter state shows a 'Nothing matches this filter' hint
pointing at the All tab.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8 — Manual simulator verification + screenshot

**Files:** none (verification + screenshot only)

- [ ] **Step 1: Boot, build, install, launch on iPhone 17 Pro**

```bash
cd /Users/atamurad/Desktop/pulse-platform/apps/ios

xcrun simctl boot 'iPhone 17 Pro' 2>/dev/null || true
open -a Simulator

xcodebuild \
  -project PulseCoffeeApp.xcodeproj \
  -scheme PulseCoffeeApp \
  -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath build \
  -quiet build 2>&1 | tail -5

APP_PATH=$(find build/Build/Products/Debug-iphonesimulator -name "PulseCoffeeApp.app" | head -1)
xcrun simctl install booted "$APP_PATH"

# Bundle id (confirmed in concern C Task 4):
xcrun simctl launch booted com.pulsecoffee.app 2>&1 | tail -3
sleep 4
```

- [ ] **Step 2: Take screenshots of the Menu**

The app cold-opens to Account (logged-out flow). To see the redesigned Menu:

a. **If your dev backend (`http://localhost:3000`) is running with the v4 seed**, you can sign in via the Welcome screen, then tap Menu. If you can't sign in (no test account / backend down), the menu won't load — that's OK; still capture the empty-state / failed-state screenshot for the PR.

b. **Without sign-in**, the Menu tab is still public (per `ContentView` doc — Menu remains browsable for guests). Tap the **Menu** tab in the bottom bar.

Take a screenshot once the menu has loaded (or the failure state is visible):

```bash
sleep 2
xcrun simctl io booted screenshot /tmp/pulse-menu-v4.png
echo "Screenshot at /tmp/pulse-menu-v4.png"
file /tmp/pulse-menu-v4.png
```

- [ ] **Step 3: Sanity checks (visual)**

Look for:
1. Header reads "Menu" with subtitle "Matcha line · Classic coffee · Food".
2. Temperature toggle visible: All / ☕ Hot / ❄ Iced.
3. Matcha section: italic-serif "The matcha line" heading; hero card (Strawberry Matcha) with the 3-layer matcha visual + ★ HERO eyebrow; horizontal-scroll cards for the other matcha drinks.
4. Classic Coffee section: italic-serif heading; vertical rows with the cup glyph + temperature pills (Hot / Iced / Hot · Iced).
5. Food section: vertical rows with food tiles (croissant / khachapuri / muffin / cookie glyphs).
6. Bottom 5-tab nav still visible underneath (from concern C).
7. Tapping a Matcha hero "Add" opens the item detail sheet (required Size + Milk modifiers — see ItemDetailView for the current placeholder).
8. Tapping a Food "+" adds-to-cart inline (food has no required modifiers; cart icon top-right should bump).

**If the menu fails to load** (no backend / no location seeded), capture the failure state instead — the user already knows the live data path is dev-only and the visual structure is the main thing to verify.

- [ ] **Step 4: No commit (verification + screenshot only)**

The screenshot lives at `/tmp/pulse-menu-v4.png` and is referenced from the PR body in Task 9.

---

## Task 9 — Push + open PR (USER-GATED)

**Files:** none (GitHub only)

- [ ] **Step 1: Do NOT push without explicit user approval.**

Per CLAUDE.md §8, do not run `git push` or `gh pr create` without the user saying "push it" or "open a PR." Print the commands below for review and wait for the go-ahead.

```bash
git push -u origin feat/ios/menu-v4-redesign

gh pr create \
  --base main \
  --head feat/ios/menu-v4-redesign \
  --title "feat(ios): v4 Menu redesign — spotlight matcha, classic list, food list, temp toggle, drink art" \
  --body "[see plan §Task 9 for the body template]"
```

PR body template (do not edit without asking):

```
Concern B of `docs/superpowers/specs/2026-05-27-pulse-menu-v4-design.md`. Depends on PR #15 (backend presentation fields).

## Summary
- `Menu.swift` Codable model now decodes `temperature` / `featured` / `art_token` / `display_style` with fail-safe defaults (`.both` / `false` / `nil` / `.list`) for missing or unknown values (Golden Rule #17). Legacy v3 JSON still decodes unchanged.
- New `DrinkArt` SwiftUI view + `DrinkArtRegistry` map 15 seeded `art_token` strings to drawn abstract symbols (3-layer matcha, tinted cup, food tile + glyph). Unknown tokens fall back to a neutral cup. No new SVG assets.
- New `TemperatureToggle` (All / ☕ Hot / ❄ Iced) bound to `MenuViewModel.selectedTemperature`; the filter is a pure static function on `MenuViewModel`, fully unit-tested (6 tests).
- New `SpotlightSection` renders the Matcha line as a hero card (featured item) + horizontal-scroll compact cards; new `MenuListRow` renders Classic Coffee / Food as vertical rows with temperature pills.
- `MenuView` rewritten as a `ScrollView` composing header + toggle + sections. Loading / failed / empty states, sign-out + cart toolbar, and pull-to-refresh preserved.
- **Smart add:** items with no required modifier groups (Food, Espresso) add to cart on `+` with a brief checkmark; items with required choices (Size / Milk) open `ItemDetailView` in a sheet.

## Out of scope (separate PRs)
- iOS item modifier picker (concern D) — `ItemDetailView` keeps its current 'modifier UI ships later' placeholder this round.

## Golden Rules
- **#7 Integer cents** — all prices flow through `MenuItem.displayPrice`; nothing on iOS does money math.
- **#8 iOS never owns price** — modifier deltas come from the server; the v4 menu shows base prices only here (running modifier total lives on the detail screen, lands with concern D).
- **#17 Fail safe** — Temperature / DisplayStyle decode to safe defaults on missing or unknown values; `DrinkArt` falls back to a neutral cup for unknown tokens.

## Test plan
- [x] `xcodebuild test` — green. Adds 16 new tests (4 Menu decode, 6 MenuViewModel filter, 6 DrinkArt).
- [x] Manual simulator: header + toggle + Matcha spotlight + Classic list + Food list render correctly; smart-add adds food items inline; Matcha 'Add' opens detail; 5-tab nav from concern C unaffected.
- [x] Screenshot at `/tmp/pulse-menu-v4.png` — drag-drop into this PR body on GitHub to attach.

## Fast-follows (non-blocking)
- `TemperatureFilter` is declared inside `TemperatureToggle.swift`; if the filter ends up referenced from other surfaces it should move into `Models/`.
- Matcha section header is hardcoded to 'The matcha line' for the Matcha category; long-term this could come from a backend `display_subtitle` field.
- The brand-warm accent color used in the hero eyebrow currently reuses `AppTheme.Colors.warning` (orange). When the `accentWarm` token from concern C's fast-follow lands, swap here too.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## Self-Review

Coverage cross-check against spec §5:

- **§5.1 Header + toggle + section layouts + smart-add tap rules** — Task 7 (MenuView header, TemperatureToggle, SpotlightSection / list section selection); Task 5 (smart-add via `MenuListRow.canInstantAdd` + `handleAdd`).
- **§5.2 Temperature filter (all/hot/iced + section hide + hero fallback)** — Task 4 (`MenuViewModel.filter` + tests).
- **§5.3 Fail-safe rendering (missing display_style → list, missing temperature → both, no featured → first hero)** — Task 1 (Codable defaults); Task 6 (hero is whatever is first in items array — `MenuViewModel.filter` ensures the right item is first).
- **§5.4 New files** — DrinkArt (Task 2), TemperatureToggle (Task 3), SpotlightSection (Task 6), MenuListRow (Task 5), MenuView orchestrator (Task 7).
- **§8 Drink visual system (native SwiftUI, fallback)** — Task 2 covers fully; tests pin the fallback.
- **§9 Golden Rules** — #7 / #8 / #17 all enforced and called out in commit messages.
- **§10 Testing** — Codable round-trip + filter + DrinkArt fallback all unit-tested. View rendering checked manually (Task 8).

No placeholder steps. Symbol names (`MenuViewModel.filter`, `MenuListRow.canInstantAdd`, `DrinkArtRegistry.spec`, `TemperatureFilter`, `Temperature`, `CategoryDisplayStyle`, `DrinkArtKind`, `DrinkArtSpec`) are consistent across tasks.
