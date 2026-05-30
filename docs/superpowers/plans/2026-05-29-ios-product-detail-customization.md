# iOS Product Detail & Customization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the v4 product-detail/customization page so a customer can choose options (size, milk, etc.), see a live price, and add the configured drink to the cart — closing the gap where `ItemDetailView` sends an empty modifier list and required-modifier drinks fail backend checkout validation.

**Architecture:** Three units. (1) `ItemCustomization` — a pure value type owning selection rules, integer-cents display pricing, and required-group validation; fully unit-tested with no UI. (2) `ItemDetailView` — rewritten SwiftUI screen (hero → customize pills → sticky live-price CTA) holding one `ItemCustomization`. (3) `MenuView` — detail presentation changes from a sheet to a full-screen `NavigationStack` push; smart-add preserved. The data layer (`MenuItem`/`ModifierGroup`/`Modifier`) and `CartManager` are already complete and unchanged.

**Tech Stack:** Swift, SwiftUI, XCTest, XcodeGen (`make project`). Design spec: `docs/superpowers/specs/2026-05-29-ios-product-detail-customization-design.md`.

---

## Before you start

- Read `CLAUDE.md`, the design spec above, and `docs/ai-onboarding/ios.md`.
- **iOS uses XcodeGen.** After creating any new `.swift` file, run `make project` from `apps/ios/` so Xcode picks it up (the `.pbxproj` is gitignored). Build/test commands assume the project has been regenerated.
- **Golden Rules in force:** #7 (integer cents — no floats in pricing logic), #8 (iOS never calculates the *charged* price; the local sum here is display-only), #2/#15 (no new network calls; ship boring first), #17 (fail safe).
- **Commit discipline (CLAUDE.md §1.6, §8):** one commit per task as marked. Do **not** `git push` or open a PR without explicit user approval. The branch is `feat/ios/product-detail-customization`.
- **Test command** (whole iOS suite):
  ```bash
  cd apps/ios && xcodebuild test \
    -project PulseCoffeeApp.xcodeproj -scheme PulseCoffeeApp \
    -destination 'platform=iOS Simulator,name=iPhone 16' 2>&1 | xcbeautify
  ```
  To run one class, append `-only-testing:PulseCoffeeAppTests/ItemCustomizationTests`.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `apps/ios/PulseCoffeeApp/Features/Menu/ItemCustomization.swift` | Create | Pure selection/price/validation model. |
| `apps/ios/PulseCoffeeAppTests/ItemCustomizationTests.swift` | Create | Unit tests for the model. |
| `apps/ios/PulseCoffeeApp/Features/Menu/ItemDetailView.swift` | Rewrite | The detail page (hero + customize pills + sticky CTA). |
| `apps/ios/PulseCoffeeApp/Features/Menu/MenuView.swift` | Modify | Sheet → `navigationDestination` push; smart-add unchanged. |
| `apps/ios/PulseCoffeeAppTests/CartManagerTests.swift` | Modify | Add detail→cart wiring + regression tests. |
| `docs/decision-log.md` | Modify | Record display-only-pricing / GR#8 interpretation. |
| `apps/ios/PulseCoffeeApp/Features/Checkout/CheckoutViewModel.swift` | Modify | Price-drift reconciliation guard at checkout. |
| `apps/ios/PulseCoffeeAppTests/CheckoutViewModelTests.swift` | Modify | Test the drift guard. |

---

## Task 1: `ItemCustomization` model (logic + tests)

**Files:**
- Create: `apps/ios/PulseCoffeeApp/Features/Menu/ItemCustomization.swift`
- Test: `apps/ios/PulseCoffeeAppTests/ItemCustomizationTests.swift`

- [ ] **Step 1: Write the failing tests**

Create `apps/ios/PulseCoffeeAppTests/ItemCustomizationTests.swift`:

```swift
import XCTest
@testable import PulseCoffeeApp

final class ItemCustomizationTests: XCTestCase {

    // MARK: - Fixtures

    private func mod(_ id: String, _ name: String, _ priceCents: Int = 0, _ sort: Int = 0) -> Modifier {
        Modifier(id: id, name: name, priceCents: priceCents, sortOrder: sort)
    }

    private func group(
        _ id: String, _ name: String,
        required: Bool, multiSelect: Bool, sort: Int = 0,
        modifiers: [Modifier]
    ) -> ModifierGroup {
        ModifierGroup(id: id, name: name, required: required,
                      multiSelect: multiSelect, sortOrder: sort, modifiers: modifiers)
    }

    private func item(basePriceCents: Int = 645, groups: [ModifierGroup] = []) -> MenuItem {
        MenuItem(id: "matcha", name: "Strawberry Matcha", description: "Three flavors in one cup.",
                 basePriceCents: basePriceCents, imageURL: nil, available: true,
                 quantityLeft: nil, modifierGroups: groups)
    }

    // A required single-select Size group (12oz default-ish first, 16oz +50, 20oz +100).
    private var sizeGroup: ModifierGroup {
        group("size", "Size", required: true, multiSelect: false, sort: 0, modifiers: [
            mod("s12", "12oz", 0, 0), mod("s16", "16oz", 50, 1), mod("s20", "20oz", 100, 2),
        ])
    }
    // An optional multi-select Extras group.
    private var extrasGroup: ModifierGroup {
        group("extras", "Extras", required: false, multiSelect: true, sort: 1, modifiers: [
            mod("shot", "Extra shot", 75, 0), mod("foam", "Cold foam", 65, 1),
        ])
    }

    // MARK: - Pricing

    func test_displayPrice_isBasePlusSelectedDeltas() {
        var c = ItemCustomization(item: item(basePriceCents: 645, groups: [sizeGroup, extrasGroup]))
        c.toggle(modifierId: "s20", in: sizeGroup)   // +100
        c.toggle(modifierId: "shot", in: extrasGroup) // +75
        c.toggle(modifierId: "foam", in: extrasGroup) // +65
        XCTAssertEqual(c.displayPriceCents, 645 + 100 + 75 + 65)
    }

    func test_zeroDeltaModifier_doesNotChangePrice() {
        var c = ItemCustomization(item: item(basePriceCents: 645, groups: [sizeGroup]))
        c.toggle(modifierId: "s12", in: sizeGroup) // +0
        XCTAssertEqual(c.displayPriceCents, 645)
    }

    // MARK: - Selection rules

    func test_singleSelect_replacesPriorSelectionInGroup() {
        var c = ItemCustomization(item: item(groups: [sizeGroup]))
        c.toggle(modifierId: "s16", in: sizeGroup)
        c.toggle(modifierId: "s20", in: sizeGroup)
        XCTAssertTrue(c.isSelected("s20", in: sizeGroup))
        XCTAssertFalse(c.isSelected("s16", in: sizeGroup))
    }

    func test_multiSelect_togglesIndependently() {
        var c = ItemCustomization(item: item(groups: [extrasGroup]))
        c.toggle(modifierId: "shot", in: extrasGroup)
        c.toggle(modifierId: "foam", in: extrasGroup)
        XCTAssertTrue(c.isSelected("shot", in: extrasGroup))
        XCTAssertTrue(c.isSelected("foam", in: extrasGroup))
        c.toggle(modifierId: "shot", in: extrasGroup) // toggle off
        XCTAssertFalse(c.isSelected("shot", in: extrasGroup))
        XCTAssertTrue(c.isSelected("foam", in: extrasGroup))
    }

    // MARK: - Required-group validation

    func test_defaultSelection_preselectsFirstRequiredSingleSelectBySortOrder() {
        let c = ItemCustomization(item: item(groups: [sizeGroup]))
        XCTAssertTrue(c.isSelected("s12", in: sizeGroup)) // first by sortOrder
        XCTAssertTrue(c.isSatisfied)
    }

    func test_requiredMultiSelect_startsEmpty_andBlocksUntilChosen() {
        let req = group("syrup", "Syrup", required: true, multiSelect: true, modifiers: [
            mod("van", "Vanilla", 50, 0), mod("haz", "Hazelnut", 50, 1),
        ])
        var c = ItemCustomization(item: item(groups: [req]))
        XCTAssertFalse(c.isSatisfied)
        XCTAssertEqual(c.firstUnsatisfiedGroupName, "Syrup")
        c.toggle(modifierId: "van", in: req)
        XCTAssertTrue(c.isSatisfied)
    }

    func test_optionalGroup_doesNotBlockCTA() {
        let c = ItemCustomization(item: item(groups: [extrasGroup])) // optional only
        XCTAssertTrue(c.isSatisfied)
        XCTAssertNil(c.firstUnsatisfiedGroupName)
    }

    func test_emptyModifierGroups_isSatisfied_andPriceIsBase() {
        let c = ItemCustomization(item: item(basePriceCents: 500, groups: []))
        XCTAssertTrue(c.isSatisfied)
        XCTAssertEqual(c.displayPriceCents, 500)
        XCTAssertTrue(c.selectedModifierIds.isEmpty)
    }

    func test_selectedModifierIds_matchesActivePills() {
        var c = ItemCustomization(item: item(groups: [sizeGroup, extrasGroup]))
        c.toggle(modifierId: "s16", in: sizeGroup)
        c.toggle(modifierId: "shot", in: extrasGroup)
        XCTAssertEqual(Set(c.selectedModifierIds), ["s16", "shot"])
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
cd apps/ios && xcodebuild test -project PulseCoffeeApp.xcodeproj -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -only-testing:PulseCoffeeAppTests/ItemCustomizationTests 2>&1 | xcbeautify
```
Expected: **compile failure** — `cannot find 'ItemCustomization' in scope`.

- [ ] **Step 3: Implement `ItemCustomization`**

Create `apps/ios/PulseCoffeeApp/Features/Menu/ItemCustomization.swift`:

```swift
import Foundation

/// In-progress customization for a single menu item. Pure value type —
/// no SwiftUI, no `CartManager` — so the selection rules and money math
/// are exhaustively unit-testable.
///
/// **Pricing here is display-only (Golden Rule #8).** `displayPriceCents`
/// is a preview the detail page shows as options change. It is never sent
/// to the server and never reaches the charged amount: iOS sends only the
/// selected modifier IDs and the backend computes the charge at
/// `POST /checkout`. All math is integer cents (Golden Rule #7); `Double`
/// appears only in the final display string.
struct ItemCustomization {
    let item: MenuItem

    /// groupID → selected modifier IDs within that group.
    private(set) var selections: [String: Set<String>]

    init(item: MenuItem) {
        self.item = item
        var seeded: [String: Set<String>] = [:]
        for grp in item.modifierGroups {
            // Default-selection rule (interim, pending a backend `is_default`
            // flag — see spec §6): pre-select the first option by sortOrder
            // for required single-select groups so the CTA and price are live
            // immediately. Required multi-select and optional groups start
            // empty.
            if grp.required && !grp.multiSelect,
               let first = grp.modifiers.sorted(by: { $0.sortOrder < $1.sortOrder }).first {
                seeded[grp.id] = [first.id]
            } else {
                seeded[grp.id] = []
            }
        }
        self.selections = seeded
    }

    /// Toggles `modifierId` within `group`, applying single- vs.
    /// multi-select rules. Single-select replaces the group's selection
    /// (radio); multi-select inserts/removes independently.
    mutating func toggle(modifierId: String, in group: ModifierGroup) {
        var current = selections[group.id] ?? []
        if group.multiSelect {
            if current.contains(modifierId) { current.remove(modifierId) }
            else { current.insert(modifierId) }
        } else {
            current = [modifierId]
        }
        selections[group.id] = current
    }

    func isSelected(_ modifierId: String, in group: ModifierGroup) -> Bool {
        selections[group.id]?.contains(modifierId) ?? false
    }

    /// base price + every selected modifier's cent delta. Display only.
    var displayPriceCents: Int {
        var total = item.basePriceCents
        for grp in item.modifierGroups {
            let chosen = selections[grp.id] ?? []
            for modifier in grp.modifiers where chosen.contains(modifier.id) {
                total += modifier.priceCents
            }
        }
        return total
    }

    /// e.g. "$6.45". Display only — never used for pricing logic.
    var displayPrice: String {
        String(format: "$%.2f", Double(displayPriceCents) / 100.0)
    }

    /// Name of the first required group (by sortOrder) with no selection,
    /// for the CTA's disabled hint. `nil` ⇒ all required groups satisfied.
    var firstUnsatisfiedGroupName: String? {
        item.modifierGroups
            .sorted(by: { $0.sortOrder < $1.sortOrder })
            .first(where: { $0.required && (selections[$0.id]?.isEmpty ?? true) })?
            .name
    }

    /// True when every required group has at least one selection.
    var isSatisfied: Bool { firstUnsatisfiedGroupName == nil }

    /// Flattened selected modifier IDs for `CartManager.add(...)`.
    var selectedModifierIds: [String] {
        item.modifierGroups.flatMap { Array(selections[$0.id] ?? []) }
    }
}
```

- [ ] **Step 4: Regenerate the project and run the tests**

Run:
```bash
cd apps/ios && make project && xcodebuild test \
  -project PulseCoffeeApp.xcodeproj -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -only-testing:PulseCoffeeAppTests/ItemCustomizationTests 2>&1 | xcbeautify
```
Expected: **all `ItemCustomizationTests` pass.**

- [ ] **Step 5: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Menu/ItemCustomization.swift \
        apps/ios/PulseCoffeeAppTests/ItemCustomizationTests.swift \
        apps/ios/PulseCoffeeApp.xcodeproj
git commit -m "feat(ios): add ItemCustomization selection/price/validation model

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Rewrite `ItemDetailView`

**Files:**
- Rewrite: `apps/ios/PulseCoffeeApp/Features/Menu/ItemDetailView.swift`

- [ ] **Step 1: Replace the file with the customization page**

Overwrite `apps/ios/PulseCoffeeApp/Features/Menu/ItemDetailView.swift`:

```swift
import SwiftUI

/// Product detail & customization page (v4 Screen 3, functional-core
/// scope). Hero (drink art + serif name + tagline) → customize pill rows
/// (one per ModifierGroup) → sticky "Add to order" CTA with a live,
/// display-only price.
///
/// Selection rules, pricing, and required-group validation live in
/// `ItemCustomization` (pure + unit-tested). This view is the wiring:
/// pills mutate the customization; the CTA is gated on `isSatisfied` and
/// adds the configured item to the in-memory cart, then pops.
///
/// Nutrition stats, "three layers" storytelling, and "pair with" upsell
/// are deferred — they need backend fields that don't exist yet (spec §9).
struct ItemDetailView: View {
    @EnvironmentObject private var cart: CartManager
    @Environment(\.dismiss) private var dismiss

    let item: MenuItem
    @State private var customization: ItemCustomization
    @State private var didAdd = false

    /// `--ink` from the v4 palette — pill-active fill / CTA background.
    private let ink = Color(red: 31 / 255, green: 26 / 255, blue: 20 / 255)

    init(item: MenuItem) {
        self.item = item
        _customization = State(initialValue: ItemCustomization(item: item))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                hero
                customizeSection
                Color.clear.frame(height: 12)
            }
            .padding(.horizontal, 24)
            .padding(.top, 8)
        }
        .safeAreaInset(edge: .bottom) { cta }
        .navigationTitle("Menu")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Hero

    private var hero: some View {
        VStack(spacing: 14) {
            DrinkArt(token: item.artToken, size: 110)
            Text(item.name)
                .font(.system(size: 30, weight: .regular, design: .serif))
                .multilineTextAlignment(.center)
            if let desc = item.description, !desc.isEmpty {
                Text(desc)
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 280)
            }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Customize

    @ViewBuilder
    private var customizeSection: some View {
        if !item.modifierGroups.isEmpty {
            VStack(alignment: .leading, spacing: 16) {
                Text("Customize")
                    .font(.system(size: 14, weight: .bold))
                ForEach(item.modifierGroups.sorted(by: { $0.sortOrder < $1.sortOrder })) { group in
                    optionRow(group)
                }
            }
        }
    }

    private func optionRow(_ group: ModifierGroup) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(group.name.uppercased())
                .font(.system(size: 11, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(.secondary)
            FlowPills(group.modifiers.sorted(by: { $0.sortOrder < $1.sortOrder })) { modifier in
                OptionPill(
                    label: modifier.name,
                    isSelected: customization.isSelected(modifier.id, in: group),
                    ink: ink
                ) {
                    customization.toggle(modifierId: modifier.id, in: group)
                }
            }
        }
    }

    // MARK: - CTA

    private var cta: some View {
        VStack(spacing: 4) {
            if let hint = customization.firstUnsatisfiedGroupName {
                Text("Choose a \(hint.lowercased())")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            Button(action: addToOrder) {
                HStack {
                    Text(didAdd ? "Added" : "Add to order")
                    Spacer()
                    Text(customization.displayPrice).opacity(0.7)
                }
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white)
                .padding(.vertical, 17)
                .padding(.horizontal, 22)
                .frame(maxWidth: .infinity)
                .background(ink, in: RoundedRectangle(cornerRadius: 14))
            }
            .disabled(!customization.isSatisfied || !item.available || didAdd)
            .opacity((!customization.isSatisfied || !item.available) ? 0.5 : 1)
        }
        .padding(.horizontal, 24)
        .padding(.top, 12)
        .padding(.bottom, 20)
        .background(.background)
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

/// A pill in the v4 `.pill` / `.pill.active` style. Selected → ink fill +
/// light text; unselected → warm paper fill + hairline border.
private struct OptionPill: View {
    let label: String
    let isSelected: Bool
    let ink: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .padding(.vertical, 7)
                .padding(.horizontal, 13)
                .foregroundStyle(isSelected ? Color.white : .primary)
                .background(
                    Capsule().fill(isSelected ? ink : Color(.secondarySystemBackground))
                )
                .overlay(
                    Capsule().stroke(Color.primary.opacity(isSelected ? 0 : 0.08), lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }
}

/// Minimal wrapping pill layout — pills flow left-to-right and wrap to the
/// next line. Uses SwiftUI's `Layout` so it works inside a ScrollView.
private struct FlowPills<Item: Identifiable, Cell: View>: View {
    let items: [Item]
    let cell: (Item) -> Cell

    init(_ items: [Item], @ViewBuilder cell: @escaping (Item) -> Cell) {
        self.items = items
        self.cell = cell
    }

    var body: some View {
        FlowLayout(spacing: 6) {
            ForEach(items) { cell($0) }
        }
    }
}

/// Simple flow layout: places subviews left-to-right, wrapping on overflow.
private struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for sub in subviews {
            let size = sub.sizeThatFits(.unspecified)
            if x + size.width > maxWidth, x > 0 {
                x = 0; y += rowHeight + spacing; rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: maxWidth == .infinity ? x : maxWidth, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for sub in subviews {
            let size = sub.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX {
                x = bounds.minX; y += rowHeight + spacing; rowHeight = 0
            }
            sub.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

#Preview {
    let size = ModifierGroup(id: "size", name: "Size", required: true, multiSelect: false, sortOrder: 0, modifiers: [
        Modifier(id: "s12", name: "12oz", priceCents: 0, sortOrder: 0),
        Modifier(id: "s16", name: "16oz", priceCents: 50, sortOrder: 1),
        Modifier(id: "s20", name: "20oz", priceCents: 100, sortOrder: 2),
    ])
    let extras = ModifierGroup(id: "extras", name: "Extras", required: false, multiSelect: true, sortOrder: 1, modifiers: [
        Modifier(id: "shot", name: "Extra shot", priceCents: 75, sortOrder: 0),
        Modifier(id: "foam", name: "Cold foam", priceCents: 65, sortOrder: 1),
    ])
    return NavigationStack {
        ItemDetailView(item: MenuItem(
            id: "matcha", name: "Strawberry Matcha",
            description: "Earthy matcha, creamy oat milk, fresh strawberry purée.",
            basePriceCents: 645, imageURL: nil, available: true, quantityLeft: nil,
            modifierGroups: [size, extras], artToken: "strawberry-matcha"
        ))
        .environmentObject(CartManager())
    }
}
```

- [ ] **Step 2: Build and verify in the preview**

Run:
```bash
cd apps/ios && xcodebuild build -project PulseCoffeeApp.xcodeproj -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 16' 2>&1 | xcbeautify
```
Expected: **build succeeds.** Then open the Xcode preview for `ItemDetailView` and confirm:
- Size pills behave as radio (one active); Extras pills toggle independently.
- The CTA price updates instantly as pills change (16oz → $6.95, +shot → $7.70, …).
- With the required Size pre-selected, the CTA is enabled on open.

- [ ] **Step 3: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Menu/ItemDetailView.swift
git commit -m "feat(ios): build product detail customization page

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Push the detail page from `MenuView`

**Files:**
- Modify: `apps/ios/PulseCoffeeApp/Features/Menu/MenuView.swift`

- [ ] **Step 1: Swap the detail sheet for a navigation push**

In `apps/ios/PulseCoffeeApp/Features/Menu/MenuView.swift`, find this block (currently around lines 42-46):

```swift
            .sheet(item: $detailItem) { item in
                NavigationStack {
                    ItemDetailView(item: item)
                }
            }
```

Replace it with:

```swift
            .navigationDestination(item: $detailItem) { item in
                ItemDetailView(item: item)
            }
```

Leave everything else unchanged — `.sheet(isPresented: $showCart)` stays, `handleAdd(_:)` stays (smart-add dispatch), and `onOpenDetail` continues to set `detailItem`. `SpotlightSection` and `MenuListRow` route through the same `detailItem`/`handleAdd`, so they get the push for free.

- [ ] **Step 2: Build and verify navigation in the simulator**

Run:
```bash
cd apps/ios && xcodebuild build -project PulseCoffeeApp.xcodeproj -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 16' 2>&1 | xcbeautify
```
Expected: **build succeeds.** In the simulator, confirm:
- Tapping a list/spotlight row **body** pushes the detail page with a `← Menu` back button.
- Tapping `+` on a modifier-free item quick-adds (no navigation, cart badge increments).
- Tapping `+` on a required-modifier item pushes the detail page.
- Back returns to the menu with scroll position preserved.

- [ ] **Step 3: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Menu/MenuView.swift
git commit -m "feat(ios): push product detail from menu instead of sheet

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Detail → cart wiring + regression tests

**Files:**
- Modify: `apps/ios/PulseCoffeeAppTests/CartManagerTests.swift`

- [ ] **Step 1: Write the wiring tests**

Append these tests inside the `CartManagerTests` class in
`apps/ios/PulseCoffeeAppTests/CartManagerTests.swift` (the `makeItem` helper already exists in that file):

```swift
    // MARK: - Detail → cart wiring (via ItemCustomization)

    private func sizeGroupFixture() -> ModifierGroup {
        ModifierGroup(id: "size", name: "Size", required: true, multiSelect: false, sortOrder: 0, modifiers: [
            Modifier(id: "s12", name: "12oz", priceCents: 0, sortOrder: 0),
            Modifier(id: "s16", name: "16oz", priceCents: 50, sortOrder: 1),
        ])
    }

    func test_configuredItem_addsLineWithSelectedModifierIds() {
        let cart = CartManager()
        let group = sizeGroupFixture()
        let item = makeItem(modifierGroups: [group])
        var custom = ItemCustomization(item: item)
        custom.toggle(modifierId: "s16", in: group)

        cart.add(item: item, modifierIds: custom.selectedModifierIds)

        XCTAssertEqual(cart.lines.count, 1)
        XCTAssertEqual(cart.lines[0].modifierIds, ["s16"])
    }

    func test_requiredModifierItem_yieldsNonEmptyModifierIds_regression() {
        // Regression for the old stub that sent an empty modifier list,
        // causing MODIFIER_GROUP_REQUIRED at checkout.
        let item = makeItem(modifierGroups: [sizeGroupFixture()])
        let custom = ItemCustomization(item: item) // default pre-selects first
        XCTAssertFalse(custom.selectedModifierIds.isEmpty)
    }

    func test_twoConfigurations_createTwoLines_identicalMerge() {
        let cart = CartManager()
        let item = makeItem(modifierGroups: [sizeGroupFixture()])
        cart.add(item: item, modifierIds: ["s12"])
        cart.add(item: item, modifierIds: ["s16"]) // different → new line
        cart.add(item: item, modifierIds: ["s12"]) // same as first → merge
        XCTAssertEqual(cart.lines.count, 2)
        XCTAssertEqual(cart.totalItemCount, 3)
    }
```

- [ ] **Step 2: Run the tests**

Run:
```bash
cd apps/ios && xcodebuild test -project PulseCoffeeApp.xcodeproj -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -only-testing:PulseCoffeeAppTests/CartManagerTests 2>&1 | xcbeautify
```
Expected: **all `CartManagerTests` pass** (existing + 3 new).

- [ ] **Step 3: Commit**

```bash
git add apps/ios/PulseCoffeeAppTests/CartManagerTests.swift
git commit -m "test(ios): cover detail-to-cart modifier wiring + required-modifier regression

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Decision-log entry (display-only pricing / GR#8)

**Files:**
- Modify: `docs/decision-log.md`

- [ ] **Step 1: Append the entry**

Add to the **top of the entries** in `docs/decision-log.md` (newest-first, matching the file's existing order — confirm by reading the first entry):

```markdown
## 2026-05-29 — [ios] — Display-only price preview on the product detail page

**Decision:** The iOS product detail page (`ItemCustomization.displayPriceCents`)
computes a price preview locally as `base + Σ selected modifier deltas`, purely
for display on the "Add to order" CTA. This preview is never sent to the server
and never reaches the charged amount. iOS sends only the selected modifier IDs;
the backend computes the authoritative charge at `POST /checkout`.

**Context:** The v4 detail page (design/v4 Screen 3) needs the CTA price to update
live as options change. Golden Rule #8 / iOS rule #4 state "iOS never calculates
price," which on a strict reading would forbid even a display preview.

**Alternatives considered:** (a) Base-price-only / "from $X" CTA that doesn't move
with selections. (b) A backend price-preview endpoint called (debounced) on every
change.

**Reasoning:** Matches Starbucks / Blank Street UX (instant local price, server-
authoritative charge). No network round-trip on a hot path. The charged amount is
structurally untouched, so GR#8's intent — the customer can never be charged a
client-computed number — is preserved. A preview endpoint is unjustified while
modifier pricing is static (no promos/dynamic pricing) — YAGNI per Golden Rule #15.

**Trade-offs:** The displayed preview can briefly diverge from the backend total
under the 10-minute menu cache (e.g. a price changed). Mitigated by the checkout
price-drift guard (same-day change): the pay screen always shows and charges the
backend total and logs a Sentry breadcrumb on mismatch.
```

- [ ] **Step 2: Commit**

```bash
git add docs/decision-log.md
git commit -m "docs: record display-only pricing decision for iOS detail page

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Checkout price-drift reconciliation guard

> **Read first.** This task touches the checkout/payment path (CLAUDE.md §1.4 Path B — sensitive code). Before editing, read `apps/ios/PulseCoffeeApp/Features/Checkout/CheckoutViewModel.swift` and `apps/ios/PulseCoffeeApp/Models/CheckoutResponse.swift` to find (a) the authoritative total field the backend returns (likely on a `CheckoutDisplay`), and (b) where the local cart line prices are summed for display, if anywhere. The exact names below are placeholders to adapt to what you find — **do not invent fields**. The guard must be **observational only**: it never blocks checkout and the customer always sees/pays the backend total.

**Files:**
- Modify: `apps/ios/PulseCoffeeApp/Features/Checkout/CheckoutViewModel.swift`
- Test: `apps/ios/PulseCoffeeAppTests/CheckoutViewModelTests.swift`

- [ ] **Step 1: Write the failing test**

Add to `apps/ios/PulseCoffeeAppTests/CheckoutViewModelTests.swift`. Adapt the constructor/spy to the file's existing test setup (it already builds a `CheckoutViewModel` with a stubbed client — reuse that):

```swift
    func test_priceDrift_recordsBreadcrumb_whenLocalSumDiffersFromBackend() {
        // Local cart implies 1295; backend authoritative total is 1345 (a
        // modifier price changed under the menu cache).
        let vm = makeCheckoutViewModel()           // existing helper in this file
        let drift = vm.priceDriftCents(localSumCents: 1295, backendTotalCents: 1345)
        XCTAssertEqual(drift, 50)
    }

    func test_priceDrift_isZero_whenLocalMatchesBackend() {
        let vm = makeCheckoutViewModel()
        XCTAssertEqual(vm.priceDriftCents(localSumCents: 1345, backendTotalCents: 1345), 0)
    }
```

If `makeCheckoutViewModel()` doesn't exist, create a tiny helper mirroring how the other tests in this file instantiate the view model.

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd apps/ios && xcodebuild test -project PulseCoffeeApp.xcodeproj -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -only-testing:PulseCoffeeAppTests/CheckoutViewModelTests 2>&1 | xcbeautify
```
Expected: **compile failure** — `value of type 'CheckoutViewModel' has no member 'priceDriftCents'`.

- [ ] **Step 3: Add the guard**

In `CheckoutViewModel.swift`, add the pure helper and call it where the backend checkout response is handled:

```swift
    /// Difference (in integer cents) between the locally previewed price
    /// sum and the backend's authoritative total. > 0 ⇒ drift (e.g. a
    /// price changed under the 10-min menu cache). Pure + testable.
    func priceDriftCents(localSumCents: Int, backendTotalCents: Int) -> Int {
        abs(backendTotalCents - localSumCents)
    }
```

Then, at the point the checkout response arrives (where `display`/total is read), add an observational check — the customer still sees the backend total:

```swift
        let drift = priceDriftCents(localSumCents: localPreviewCents,
                                    backendTotalCents: backendTotalCents)
        if drift > 0 {
            SentrySDK.addBreadcrumb(.init(level: .warning, category: "checkout"))
            // (Match the project's existing Sentry breadcrumb idiom — see how
            // other breadcrumbs are emitted in this file; include the drift in
            // the message/data, e.g. "price-drift \(drift)c".)
        }
        // Always display/charge backendTotalCents — never localPreviewCents.
```

`localPreviewCents` is the sum the cart UI already shows (per-line `displayPrice × quantity`); if no such sum exists, compute it from `CartManager.lines` for this check only. Do **not** add a stored local total to `CartManager` (its no-local-subtotal contract stands — see CartManager header comment).

- [ ] **Step 4: Run the tests**

Run:
```bash
cd apps/ios && xcodebuild test -project PulseCoffeeApp.xcodeproj -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -only-testing:PulseCoffeeAppTests/CheckoutViewModelTests 2>&1 | xcbeautify
```
Expected: **all `CheckoutViewModelTests` pass.**

- [ ] **Step 5: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Checkout/CheckoutViewModel.swift \
        apps/ios/PulseCoffeeAppTests/CheckoutViewModelTests.swift
git commit -m "feat(ios): guard checkout against local/backend price drift

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full-suite verification

- [ ] **Step 1: Run the entire iOS test suite**

Run:
```bash
cd apps/ios && make project && xcodebuild test \
  -project PulseCoffeeApp.xcodeproj -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 16' 2>&1 | xcbeautify
```
Expected: **all tests pass** (`ItemCustomizationTests`, `CartManagerTests`, `MenuTests`, `MenuViewModelTests`, `CheckoutViewModelTests`, `AuthViewModelTests`).

- [ ] **Step 2: Manual smoke test in the simulator**

Confirm the end-to-end flow:
1. Open the menu → tap a required-modifier drink → detail page pushes.
2. Change Size/Extras → price updates live; CTA enabled (Size pre-selected).
3. "Add to order" → returns to menu, cart badge increments.
4. Open cart → checkout → order completes **without** a `MODIFIER_GROUP_REQUIRED` rejection.
5. Tap `+` on a plain coffee (no required options) → quick-adds without opening detail.

- [ ] **Step 3: Stop and hand off**

Per CLAUDE.md §8: implementation is finished at green build + green tests + committed-locally. **Do not push or open a PR** without explicit user approval. Report status and the printed list of commits.

---

## Definition of done

- A required-modifier drink can be configured on the detail page and added to the cart with correct `modifierIds`, then checked out without a `MODIFIER_GROUP_REQUIRED` rejection.
- `ItemCustomizationTests`, the new `CartManagerTests`, and `CheckoutViewModelTests` are green; full suite green.
- Detail page matches the v4 functional-core layout (hero + customize pills + sticky live-price CTA), full-screen push with `← Menu` back.
- Decision-log entry recorded.
- No new network calls; cart stays in-memory; `CartManager` and the menu models unchanged.
- `make project` run; no `print`/dead code; smart-add path still works.
```
