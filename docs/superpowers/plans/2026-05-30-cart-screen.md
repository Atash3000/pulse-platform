# Cart Screen ("Your Order") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the placeholder `CartView` into the approved v4 "Your order" screen (drink art, temperature badge, modifier summary, display-only estimate, quantity control, edit-drink, smart upsell, checkout CTA), using data that exists today.

**Architecture:** Two pure display helpers (`CartEstimate`, `CartLineSummary`) keep money/format logic out of `CartManager` (Golden Rule #8). Edit-drink reuses the existing `ItemDetailView` in an "edit mode" (a preselect init on `ItemCustomization` + `CartManager.updateLine`). Checkout is untouched — the CTA navigates to the existing `CheckoutView`.

**Tech Stack:** SwiftUI, **iOS 16 deployment target** (use `navigationDestination(isPresented:)`, not the iOS-17 `item:` overload; no `@Observable`). XCTest. **XcodeGen** — run `make project` from `apps/ios/` after adding any `.swift` file.

**Branch:** `feat/ios/cart-screen` (already created off `main`; the spec is committed on it).
**Build/test (from `apps/ios/`):** `make test SIMULATOR_DESTINATION='platform=iOS Simulator,name=iPhone 17 Pro'` (build via `make build …`). Tests need no DB.

> **Commit policy (CLAUDE.md §8):** each task ends with a commit; the human approves commits. Do not push.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `apps/ios/PulseCoffeeApp/Features/Cart/CartEstimate.swift` | Create | Pure display-only cart pricing (Int cents) |
| `apps/ios/PulseCoffeeApp/Features/Cart/CartLineSummary.swift` | Create | Pure: line → temperature / modifier-summary / extras |
| `apps/ios/PulseCoffeeApp/Features/Menu/ItemCustomization.swift` | Modify | Add `init(item:preselectedModifierIds:)` |
| `apps/ios/PulseCoffeeApp/Core/CartManager.swift` | Modify | Add `updateLine(lineId:modifierIds:)` |
| `apps/ios/PulseCoffeeApp/Features/Menu/ItemDetailView.swift` | Modify | Add edit mode (`editing:` context) |
| `apps/ios/PulseCoffeeApp/Features/Cart/CartView.swift` | Rewrite | The v4 cart screen |
| `apps/ios/PulseCoffeeApp/Features/Menu/MenuView.swift` | Modify | Pass food items into `CartView` |
| `apps/ios/PulseCoffeeAppTests/CartEstimateTests.swift` | Create | Tests |
| `apps/ios/PulseCoffeeAppTests/CartLineSummaryTests.swift` | Create | Tests |
| `apps/ios/PulseCoffeeAppTests/ItemCustomizationTests.swift` | Modify | Preselect-init test |
| `apps/ios/PulseCoffeeAppTests/CartManagerTests.swift` | Modify | `updateLine` tests |
| `docs/decision-log.md` | Modify | Record edit-merge + CartEstimate-outside-CartManager |

---

## Task 1: `CartEstimate` — display-only pricing (TDD)

**Files:** Create `apps/ios/PulseCoffeeApp/Features/Cart/CartEstimate.swift`, `apps/ios/PulseCoffeeAppTests/CartEstimateTests.swift`

- [ ] **Step 1: Write failing tests**

```swift
import XCTest
@testable import PulseCoffeeApp

@MainActor
final class CartEstimateTests: XCTestCase {
    private func mod(_ id: String, _ cents: Int) -> Modifier { Modifier(id: id, name: id, priceCents: cents, sortOrder: 0) }
    private func item() -> MenuItem {
        let size = ModifierGroup(id: "size", name: "Size", required: true, multiSelect: false, sortOrder: 0,
            modifiers: [mod("s12", 0), mod("s16", 60)])
        let milk = ModifierGroup(id: "milk", name: "Milk", required: true, multiSelect: false, sortOrder: 1,
            modifiers: [mod("oat", 75), mod("whole", 0)])
        return MenuItem(id: "matcha", name: "Ginger Matcha", description: nil, basePriceCents: 675,
            imageURL: nil, available: true, quantityLeft: nil, modifierGroups: [size, milk], artToken: "ginger-matcha")
    }

    func test_lineEstimate_isBasePlusSelectedDeltas_timesQuantity() {
        let line = CartManager.Line(item: item(), quantity: 2, modifierIds: ["s16", "oat"]) // 675+60+75 = 810
        XCTAssertEqual(CartEstimate.lineEstimateCents(line), 810 * 2)
    }
    func test_lineEstimate_ignoresUnselectedModifiers() {
        let line = CartManager.Line(item: item(), quantity: 1, modifierIds: ["s12", "whole"]) // both 0
        XCTAssertEqual(CartEstimate.lineEstimateCents(line), 675)
    }
    func test_subtotal_sumsLines() {
        let a = CartManager.Line(item: item(), quantity: 1, modifierIds: ["s16", "oat"]) // 810
        let b = CartManager.Line(item: item(), quantity: 1, modifierIds: ["s12", "whole"]) // 675
        XCTAssertEqual(CartEstimate.subtotalEstimateCents([a, b]), 810 + 675)
    }
    func test_subtotal_emptyIsZero() {
        XCTAssertEqual(CartEstimate.subtotalEstimateCents([]), 0)
    }
    func test_displayPrice_formats() {
        XCTAssertEqual(CartEstimate.displayPrice(810), "$8.10")
    }
}
```

- [ ] **Step 2: Run, verify it fails** — `make test …` → compile failure (`CartEstimate` not found).

- [ ] **Step 3: Implement**

```swift
import Foundation

/// Display-only cart pricing (Golden Rule #8). Lives OUTSIDE `CartManager`
/// — which deliberately exposes no subtotal — so the "cart holds no money
/// math" rule is preserved. iOS never sends these numbers; the backend
/// computes the charge at `POST /checkout` (`CheckoutView` is authoritative).
/// All integer cents (Golden Rule #7); `Double` only in the format string.
enum CartEstimate {
    /// base price + selected modifier deltas, × quantity.
    static func lineEstimateCents(_ line: CartManager.Line) -> Int {
        let selected = Set(line.modifierIds)
        let perUnit = line.item.basePriceCents + line.item.modifierGroups
            .flatMap(\.modifiers)
            .filter { selected.contains($0.id) }
            .reduce(0) { $0 + $1.priceCents }
        return perUnit * line.quantity
    }

    static func subtotalEstimateCents(_ lines: [CartManager.Line]) -> Int {
        lines.reduce(0) { $0 + lineEstimateCents($1) }
    }

    /// e.g. "$8.10". Display only.
    static func displayPrice(_ cents: Int) -> String {
        String(format: "$%.2f", Double(cents) / 100.0)
    }
}
```

- [ ] **Step 4: Regenerate + test** — `cd apps/ios && make project`, then `make test …`. All `CartEstimateTests` pass.

- [ ] **Step 5: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Cart/CartEstimate.swift apps/ios/PulseCoffeeAppTests/CartEstimateTests.swift apps/ios/PulseCoffeeApp.xcodeproj
git commit -m "feat(ios): add display-only CartEstimate pricing helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `CartLineSummary` — modifier/temperature presentation (TDD)

**Files:** Create `apps/ios/PulseCoffeeApp/Features/Cart/CartLineSummary.swift`, `apps/ios/PulseCoffeeAppTests/CartLineSummaryTests.swift`

- [ ] **Step 1: Write failing tests**

```swift
import XCTest
@testable import PulseCoffeeApp

@MainActor
final class CartLineSummaryTests: XCTestCase {
    private func mod(_ id: String, _ name: String, _ sort: Int = 0) -> Modifier { Modifier(id: id, name: name, priceCents: 0, sortOrder: sort) }
    private func line(_ ids: [String]) -> CartManager.Line {
        let size = ModifierGroup(id: "size", name: "Size", required: true, multiSelect: false, sortOrder: 0,
            modifiers: [mod("s12", "12 oz", 0), mod("s16", "16 oz", 1)])
        let milk = ModifierGroup(id: "milk", name: "Milk", required: true, multiSelect: false, sortOrder: 1,
            modifiers: [mod("oat", "Oat", 0), mod("whole", "Whole", 1)])
        let extras = ModifierGroup(id: "extras", name: "Extras", required: false, multiSelect: true, sortOrder: 3,
            modifiers: [mod("shot", "Matcha shot", 0), mod("van", "Vanilla syrup", 1)])
        let item = MenuItem(id: "m", name: "Ginger Matcha", description: nil, basePriceCents: 675, imageURL: nil,
            available: true, quantityLeft: nil, modifierGroups: [size, milk, extras], temperature: .iced, artToken: "ginger-matcha")
        return CartManager.Line(item: item, quantity: 1, modifierIds: ids)
    }

    func test_modifierSummary_joinsSingleSelectByGroupSortOrder() {
        XCTAssertEqual(CartLineSummary.modifierSummary(for: line(["s16", "oat"])), "16 oz · Oat")
    }
    func test_extras_listsMultiSelectSelections() {
        XCTAssertEqual(CartLineSummary.extras(for: line(["s16", "oat", "shot"])), ["Matcha shot"])
    }
    func test_extras_emptyWhenNoneSelected() {
        XCTAssertTrue(CartLineSummary.extras(for: line(["s16", "oat"])).isEmpty)
    }
    func test_temperature_passesThrough() {
        XCTAssertEqual(CartLineSummary.temperature(for: line(["s12", "oat"])), .iced)
    }
}
```

- [ ] **Step 2: Run, verify it fails.**

- [ ] **Step 3: Implement**

```swift
import Foundation

/// Pure presentation of a cart line's chosen options. Resolves the stored
/// `modifierIds` back to human strings via the line's `MenuItem`. Single-
/// select groups (Size/Milk/Sweetness) form the dotted summary line;
/// multi-select groups (Extras) form the "+ …" list. No SwiftUI; testable.
enum CartLineSummary {
    static func temperature(for line: CartManager.Line) -> Temperature { line.item.temperature }

    /// e.g. "16 oz · Oat · Half sweet" — single-select selections, group order.
    static func modifierSummary(for line: CartManager.Line) -> String {
        let selected = Set(line.modifierIds)
        return line.item.modifierGroups
            .filter { !$0.multiSelect }
            .sorted { $0.sortOrder < $1.sortOrder }
            .compactMap { group in group.modifiers.first { selected.contains($0.id) }?.name }
            .joined(separator: " · ")
    }

    /// e.g. ["Matcha shot"] — multi-select selections, group then sortOrder.
    static func extras(for line: CartManager.Line) -> [String] {
        let selected = Set(line.modifierIds)
        return line.item.modifierGroups
            .filter { $0.multiSelect }
            .sorted { $0.sortOrder < $1.sortOrder }
            .flatMap { group in
                group.modifiers.sorted { $0.sortOrder < $1.sortOrder }
                    .filter { selected.contains($0.id) }.map(\.name)
            }
    }
}
```

- [ ] **Step 4: Regenerate + test** — `make project`, `make test …`. Green.

- [ ] **Step 5: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Cart/CartLineSummary.swift apps/ios/PulseCoffeeAppTests/CartLineSummaryTests.swift apps/ios/PulseCoffeeApp.xcodeproj
git commit -m "feat(ios): add CartLineSummary (temp/modifier presentation)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `ItemCustomization` preselect init (TDD)

**Files:** Modify `apps/ios/PulseCoffeeApp/Features/Menu/ItemCustomization.swift`, `apps/ios/PulseCoffeeAppTests/ItemCustomizationTests.swift`

- [ ] **Step 1: Add a failing test** to `ItemCustomizationTests.swift` (use the file's existing `mod`/`group`/`item` helpers; adapt names if they differ):

```swift
func test_preselectInit_seedsExactlyTheGivenIds() {
    let size = group("size", "Size", required: true, multiSelect: false, sort: 0, modifiers: [
        mod("s12", "12 oz", 0, 0), mod("s16", "16 oz", 60, 1),
    ])
    let extras = group("extras", "Extras", required: false, multiSelect: true, sort: 1, modifiers: [
        mod("shot", "Shot", 100, 0), mod("foam", "Foam", 65, 1),
    ])
    let item = self.item(basePriceCents: 645, groups: [size, extras])
    let c = ItemCustomization(item: item, preselectedModifierIds: ["s16", "shot"])
    XCTAssertTrue(c.isSelected("s16", in: size))
    XCTAssertFalse(c.isSelected("s12", in: size))
    XCTAssertTrue(c.isSelected("shot", in: extras))
    XCTAssertEqual(Set(c.selectedModifierIds), ["s16", "shot"])
}
```

> If the helper signatures differ, read the top of `ItemCustomizationTests.swift` and adapt — keep the assertions identical.

- [ ] **Step 2: Run, verify it fails** (no such init).

- [ ] **Step 3: Add the init** after the existing `init(item:)` (around line 39) in `ItemCustomization.swift`:

```swift
    /// Seeds selections from an existing cart line's modifier IDs (for the
    /// edit-drink flow) instead of the cheapest-option defaults. Each group
    /// keeps only the preselected IDs that belong to it.
    init(item: MenuItem, preselectedModifierIds: [String]) {
        self.item = item
        let preselected = Set(preselectedModifierIds)
        var seeded: [String: Set<String>] = [:]
        for grp in item.modifierGroups {
            seeded[grp.id] = Set(grp.modifiers.map(\.id)).intersection(preselected)
        }
        self.selections = seeded
    }
```

- [ ] **Step 4: Run, verify it passes** — `make test …`. New + existing `ItemCustomizationTests` green.

- [ ] **Step 5: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Menu/ItemCustomization.swift apps/ios/PulseCoffeeAppTests/ItemCustomizationTests.swift
git commit -m "feat(ios): ItemCustomization preselect init for edit-drink

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `CartManager.updateLine` (TDD)

**Files:** Modify `apps/ios/PulseCoffeeApp/Core/CartManager.swift`, `apps/ios/PulseCoffeeAppTests/CartManagerTests.swift`

- [ ] **Step 1: Add failing tests** to `CartManagerTests.swift` (use the file's existing `MenuItem` test fixture; if it has a helper, reuse it — otherwise construct a `MenuItem` inline as below):

```swift
@MainActor
func test_updateLine_changesModifiers_preservingQuantity() {
    let cart = CartManager()
    let item = MenuItem(id: "i", name: "Latte", description: nil, basePriceCents: 550, imageURL: nil,
        available: true, quantityLeft: nil, modifierGroups: [])
    cart.add(item: item, quantity: 3, modifierIds: ["oat"])
    let id = cart.lines[0].id
    cart.updateLine(lineId: id, modifierIds: ["whole"])
    XCTAssertEqual(cart.lines.count, 1)
    XCTAssertEqual(cart.lines[0].modifierIds, ["whole"])
    XCTAssertEqual(cart.lines[0].quantity, 3)
}

@MainActor
func test_updateLine_mergesIntoCollidingLine() {
    let cart = CartManager()
    let item = MenuItem(id: "i", name: "Latte", description: nil, basePriceCents: 550, imageURL: nil,
        available: true, quantityLeft: nil, modifierGroups: [])
    cart.add(item: item, quantity: 1, modifierIds: ["whole"])   // line A
    cart.add(item: item, quantity: 2, modifierIds: ["oat"])     // line B
    let bId = cart.lines[1].id
    cart.updateLine(lineId: bId, modifierIds: ["whole"])        // B now matches A → merge
    XCTAssertEqual(cart.lines.count, 1)
    XCTAssertEqual(cart.lines[0].quantity, 3)
    XCTAssertEqual(cart.lines[0].modifierIds, ["whole"])
}

@MainActor
func test_updateLine_unknownId_isNoOp() {
    let cart = CartManager()
    let item = MenuItem(id: "i", name: "Latte", description: nil, basePriceCents: 550, imageURL: nil,
        available: true, quantityLeft: nil, modifierGroups: [])
    cart.add(item: item, quantity: 1, modifierIds: [])
    cart.updateLine(lineId: UUID(), modifierIds: ["x"])
    XCTAssertEqual(cart.lines.count, 1)
    XCTAssertEqual(cart.lines[0].modifierIds, [])
}
```

- [ ] **Step 2: Run, verify it fails.**

- [ ] **Step 3: Implement** — add to `CartManager` after `remove(lineId:)`:

```swift
    /// Replaces a line's modifier set (for the edit-drink flow), preserving
    /// its quantity. If the new config collides with another existing line
    /// (same item + modifiers), merges quantities into that line and drops
    /// this one — consistent with `add`'s dedupe.
    func updateLine(lineId: Line.ID, modifierIds: [String]) {
        guard let index = lines.firstIndex(where: { $0.id == lineId }) else { return }
        let old = lines[index]
        if let mergeIndex = lines.firstIndex(where: {
            $0.id != lineId && $0.item.id == old.item.id && $0.modifierIds == modifierIds
        }) {
            lines[mergeIndex].quantity += old.quantity
            lines.remove(at: index)
        } else {
            lines[index] = Line(item: old.item, quantity: old.quantity, modifierIds: modifierIds)
        }
    }
```

- [ ] **Step 4: Run, verify it passes** — `make test …`. New + existing `CartManagerTests` green.

- [ ] **Step 5: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Core/CartManager.swift apps/ios/PulseCoffeeAppTests/CartManagerTests.swift
git commit -m "feat(ios): CartManager.updateLine (edit a cart line, keep qty)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `ItemDetailView` edit mode

**Files:** Modify `apps/ios/PulseCoffeeApp/Features/Menu/ItemDetailView.swift`

- [ ] **Step 1: Add the edit context + state**

In `struct ItemDetailView`, after `let pairings: [MenuItem]` (line ~21) add:

```swift
    /// When set, the screen edits an existing cart line instead of adding a
    /// new one: customization is prefilled and the CTA updates the line.
    struct EditContext: Equatable { let lineId: UUID; let modifierIds: [String] }
    let editing: EditContext?
```

- [ ] **Step 2: Update the init** (replace the existing `init(item:pairings:)` around lines 36–40):

```swift
    init(item: MenuItem, pairings: [MenuItem] = [], editing: EditContext? = nil) {
        self.item = item
        self.pairings = pairings
        self.editing = editing
        if let editing {
            _customization = State(initialValue: ItemCustomization(item: item, preselectedModifierIds: editing.modifierIds))
        } else {
            _customization = State(initialValue: ItemCustomization(item: item))
        }
    }
```

- [ ] **Step 3: Update the CTA label** (in `stickyCTA`, the `Text(didAdd ? "Added" : "Add to Order")` around line 247):

```swift
                        Text(ctaLabel)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
```

and add a computed property near `addToOrder`:

```swift
    private var ctaLabel: String {
        if editing != nil { return didAdd ? "Updated" : "Update order" }
        return didAdd ? "Added" : "Add to Order"
    }
```

- [ ] **Step 4: Update `addToOrder`** (replace the `cart.add(...)` line in the existing `addToOrder()`):

```swift
    private func addToOrder() {
        if let editing {
            cart.updateLine(lineId: editing.lineId, modifierIds: customization.selectedModifierIds)
        } else {
            cart.add(item: item, quantity: 1, modifierIds: customization.selectedModifierIds)
        }
        didAdd = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 600_000_000)
            dismiss()
        }
    }
```

- [ ] **Step 5: Regenerate + build** — `cd apps/ios && make project && make build SIMULATOR_DESTINATION='platform=iOS Simulator,name=iPhone 17 Pro'`. Builds clean. Run `make test …` (existing detail/customization tests still green).

- [ ] **Step 6: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Menu/ItemDetailView.swift
git commit -m "feat(ios): ItemDetailView edit mode (prefilled, updates line)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Rewrite `CartView` to the v4 layout

**Files:** Rewrite `apps/ios/PulseCoffeeApp/Features/Cart/CartView.swift`

- [ ] **Step 1: Replace the whole file** with:

```swift
import SwiftUI

/// v4 "Your order" cart screen (design: design/v4/pulse-coffee-cart-v4.html,
/// spec 2026-05-30-cart-screen-design.md). Shows each line's drink art,
/// temperature, chosen modifiers, a display-only estimate, a quantity
/// control, and Edit/Remove. A sticky CTA navigates to the existing
/// CheckoutView (the authoritative price/pay surface — Golden Rule #2/#8).
///
/// Deferred (need order-history / loyalty backend; see docs/todo-endpoints.md):
/// the "Your usual" badge, reorder-your-usual empty state, and the
/// "after this order" loyalty line.
struct CartView: View {
    @EnvironmentObject private var appState: AppState
    @EnvironmentObject private var cart: CartManager
    @Environment(\.dismiss) private var dismiss

    let locationId: String
    /// Loaded menu items (passed by MenuView) — pool for the smart upsell.
    let foodItems: [MenuItem]

    @State private var showCheckout = false
    @State private var editLine: CartManager.Line?

    var body: some View {
        NavigationStack {
            Group {
                if cart.isEmpty { emptyState } else { loaded }
            }
            .background(DetailPalette.warmCream.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { dismiss() } label: { Image(systemName: "chevron.down") }
                        .accessibilityLabel("Close cart")
                }
            }
            .navigationDestination(isPresented: $showCheckout) {
                CheckoutView(cart: cart, appState: appState, locationId: locationId)
            }
            // iOS-16 navigationDestination(isPresented:) pattern (matches MenuView).
            .navigationDestination(isPresented: Binding(
                get: { editLine != nil },
                set: { if !$0 { editLine = nil } }
            )) {
                if let line = editLine {
                    ItemDetailView(item: line.item,
                                   editing: .init(lineId: line.id, modifierIds: line.modifierIds))
                }
            }
        }
    }

    // MARK: - Loaded

    private var loaded: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                VStack(spacing: 0) {
                    ForEach(cart.lines) { line in
                        CartLineView(line: line, onEdit: { editLine = line })
                        if line.id != cart.lines.last?.id { Divider().background(DetailPalette.ink.opacity(0.07)) }
                    }
                }
                if let pairing = upsell { UpsellRow(item: pairing) { cart.add(item: pairing) } }
                summary
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
        }
        .safeAreaInset(edge: .bottom) { checkoutCTA }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Your order")
                .font(.system(size: 32, weight: .regular, design: .serif))
                .foregroundStyle(DetailPalette.ink)
            HStack(spacing: 6) {
                Circle().fill(DetailPalette.matchaGreen).frame(width: 7, height: 7)
                Text("\(cart.totalItemCount) \(cart.totalItemCount == 1 ? "drink" : "drinks") · ready in ~6 min")
                    .font(.system(size: 13)).foregroundStyle(DetailPalette.inkSoft)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// First pairing the menu resolves for the cart's drinks (hardcoded
    /// pairings via ItemPairings; fail-safe nil → upsell hidden).
    private var upsell: MenuItem? {
        guard let anchor = cart.lines.first?.item else { return nil }
        return ItemPairings.resolve(for: anchor, in: foodItems)
            .first { !cart.lines.contains { $0.item.id == $0.item.id && $0.item.id == $0.item.id } || true }
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Subtotal (est.)").font(.system(size: 14)).foregroundStyle(DetailPalette.inkSoft)
                Spacer()
                Text(CartEstimate.displayPrice(CartEstimate.subtotalEstimateCents(cart.lines)))
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(DetailPalette.ink)
            }
            Text("Tax & final total calculated at checkout.")
                .font(.system(size: 11)).foregroundStyle(DetailPalette.inkFaint)
        }
        .padding(.top, 4)
    }

    private var checkoutCTA: some View {
        VStack(spacing: 0) {
            LinearGradient(colors: [DetailPalette.warmCream.opacity(0), DetailPalette.warmCream],
                           startPoint: .top, endPoint: .bottom).frame(height: 16).allowsHitTesting(false)
            Button { showCheckout = true } label: {
                HStack {
                    Text("Checkout").lineLimit(1).minimumScaleFactor(0.7)
                    Spacer()
                    Text(CartEstimate.displayPrice(CartEstimate.subtotalEstimateCents(cart.lines))).opacity(0.85)
                }
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(DetailPalette.warmCream)
                .padding(.vertical, 16).padding(.horizontal, 20).frame(maxWidth: .infinity)
                .background(DetailPalette.ink, in: RoundedRectangle(cornerRadius: 14))
            }
            .padding(.horizontal, 20).padding(.top, 4).padding(.bottom, 10)
            .background(DetailPalette.warmCream)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "cup.and.saucer")
                .font(.system(size: 52)).foregroundStyle(DetailPalette.inkFaint)
            Text("Nothing here yet")
                .font(.system(size: 26, weight: .regular, design: .serif)).foregroundStyle(DetailPalette.ink)
            Text("Add a drink and it’ll be ready for pickup in minutes.")
                .font(.system(size: 14)).foregroundStyle(DetailPalette.inkSoft)
                .multilineTextAlignment(.center).frame(maxWidth: 260)
            Button { dismiss() } label: {
                Text("Browse the menu").font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(DetailPalette.warmCream)
                    .padding(.vertical, 13).padding(.horizontal, 26)
                    .background(DetailPalette.ink, in: Capsule())
            }
            .padding(.top, 6)
            // TODO: replace with reorder-your-usual once order history exists
            // (docs/todo-endpoints.md).
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

/// One cart line, v4 style.
private struct CartLineView: View {
    @EnvironmentObject private var cart: CartManager
    let line: CartManager.Line
    let onEdit: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            DrinkArt(token: line.item.artToken, size: 56)
            VStack(alignment: .leading, spacing: 5) {
                Text(line.item.name).font(.system(size: 16, weight: .semibold)).foregroundStyle(DetailPalette.ink)
                TemperatureBadge(temperature: CartLineSummary.temperature(for: line))
                let mods = CartLineSummary.modifierSummary(for: line)
                if !mods.isEmpty {
                    Text(mods).font(.system(size: 12.5)).foregroundStyle(DetailPalette.inkSoft)
                }
                ForEach(CartLineSummary.extras(for: line), id: \.self) { extra in
                    Text("+ \(extra)").font(.system(size: 12)).foregroundStyle(DetailPalette.matchaGreen)
                }
                HStack(spacing: 14) {
                    Button("Edit drink", action: onEdit)
                        .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(DetailPalette.ink)
                    Button("Remove") { cart.remove(lineId: line.id) }
                        .font(.system(size: 12.5)).foregroundStyle(DetailPalette.inkFaint)
                }
                .buttonStyle(.plain).padding(.top, 3)
            }
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 12) {
                Text(CartEstimate.displayPrice(CartEstimate.lineEstimateCents(line)))
                    .font(.system(size: 16, weight: .semibold)).foregroundStyle(DetailPalette.ink)
                quantityControl
            }
        }
        .padding(.vertical, 14)
    }

    @ViewBuilder private var quantityControl: some View {
        if line.quantity == 1 {
            Button { cart.setQuantity(for: line.id, to: 2) } label: {
                Image(systemName: "plus").font(.system(size: 15, weight: .bold))
                    .foregroundStyle(DetailPalette.warmCream).frame(width: 30, height: 30)
                    .background(Circle().fill(DetailPalette.ink))
            }
            .buttonStyle(.plain).accessibilityLabel("Add another \(line.item.name)")
        } else {
            HStack(spacing: 10) {
                Button { cart.setQuantity(for: line.id, to: line.quantity - 1) } label: {
                    Image(systemName: "minus").font(.system(size: 14, weight: .semibold)).foregroundStyle(DetailPalette.inkSoft)
                }.accessibilityLabel("Decrease quantity")
                Text("\(line.quantity)").font(.system(size: 14, weight: .semibold).monospacedDigit()).frame(minWidth: 14)
                Button { cart.setQuantity(for: line.id, to: line.quantity + 1) } label: {
                    Image(systemName: "plus").font(.system(size: 14, weight: .semibold)).foregroundStyle(DetailPalette.ink)
                }.accessibilityLabel("Increase quantity")
            }
            .buttonStyle(.plain)
            .padding(.vertical, 6).padding(.horizontal, 10)
            .background(Capsule().fill(Color(.secondarySystemBackground)))
        }
    }
}

/// Hot/Iced badge (flame/snowflake), warm/cool tint. Color is not the only
/// cue — icon + label carry the meaning.
private struct TemperatureBadge: View {
    let temperature: Temperature
    var body: some View {
        let (label, symbol, color): (String, String, Color) = {
            switch temperature {
            case .hot:  return ("Hot", "flame", DetailPalette.accentWarm)
            case .iced: return ("Iced", "snowflake", Color(red: 53/255, green: 107/255, blue: 136/255))
            case .both: return ("Hot or Iced", "thermometer.medium", DetailPalette.inkSoft)
            }
        }()
        HStack(spacing: 4) {
            Image(systemName: symbol).font(.system(size: 10, weight: .semibold))
            Text(label).font(.system(size: 11, weight: .bold))
        }
        .foregroundStyle(color)
        .padding(.vertical, 3).padding(.horizontal, 8)
        .background(Capsule().fill(color.opacity(0.13)))
    }
}

/// Compact "Pair with" upsell row.
private struct UpsellRow: View {
    let item: MenuItem
    let onAdd: () -> Void
    var body: some View {
        HStack(spacing: 12) {
            DrinkArt(token: item.artToken, size: 34)
            VStack(alignment: .leading, spacing: 1) {
                Text("Perfect with \(item.name.lowercased())")
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(DetailPalette.ink).lineLimit(1)
                Text(item.displayPrice).font(.system(size: 11.5)).foregroundStyle(DetailPalette.inkSoft)
            }
            Spacer()
            Button(action: onAdd) {
                Image(systemName: "plus").font(.system(size: 14, weight: .bold))
                    .foregroundStyle(DetailPalette.warmCream).frame(width: 30, height: 30)
                    .background(Circle().fill(DetailPalette.ink))
            }.buttonStyle(.plain).accessibilityLabel("Add \(item.name)")
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 16).fill(DetailPalette.warmCream).overlay(RoundedRectangle(cornerRadius: 16).stroke(DetailPalette.ink.opacity(0.07))))
    }
}

#Preview {
    let cart = CartManager()
    return CartView(locationId: "loc", foodItems: [])
        .environmentObject(cart)
        .environmentObject(AppState())
}
```

> **Fix the `upsell` helper** while typing it — the placeholder filter above is deliberately wrong-looking; use this clean version: suggest the first resolved pairing that isn't already in the cart:
> ```swift
> private var upsell: MenuItem? {
>     guard let anchor = cart.lines.first?.item else { return nil }
>     let inCart = Set(cart.lines.map(\.item.id))
>     return ItemPairings.resolve(for: anchor, in: foodItems).first { !inCart.contains($0.id) }
> }
> ```

- [ ] **Step 2: Regenerate + build** — `cd apps/ios && make project && make build SIMULATOR_DESTINATION='platform=iOS Simulator,name=iPhone 17 Pro'`. Resolve any compile errors (esp. the `upsell` helper — use the clean version above; and confirm `DetailPalette` tokens `matchaGreen`/`accentWarm`/`inkSoft`/`inkFaint`/`ink`/`warmCream` exist in `ProductDetailComponents.swift`).

- [ ] **Step 3: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Cart/CartView.swift
git commit -m "feat(ios): rebuild CartView to the v4 'Your order' layout

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Wire `MenuView` to pass food items + decision-log note

**Files:** Modify `apps/ios/PulseCoffeeApp/Features/Menu/MenuView.swift`, `docs/decision-log.md`

- [ ] **Step 1: Pass food items into the cart sheet**

In `MenuView.swift`, find the `.sheet(isPresented: $showCart) { CartView(locationId: …) }`. Update the `CartView(...)` call to pass the loaded items. MenuView already has an `allLoadedItems` computed property (added for product-detail pairings); reuse it:

```swift
            .sheet(isPresented: $showCart) {
                if case .loaded(let location, _) = viewModel.state {
                    CartView(locationId: location.id, foodItems: allLoadedItems)
                } else {
                    CartView(locationId: "", foodItems: [])
                }
            }
```

> Read `MenuView.swift` first to confirm the exact current `.sheet` body and the `allLoadedItems` accessor name. If `allLoadedItems` does not exist, add it:
> ```swift
>     private var allLoadedItems: [MenuItem] {
>         guard case .loaded = viewModel.state, let menu = viewModel.filteredMenu else { return [] }
>         return menu.categories.flatMap(\.items)
>     }
> ```

- [ ] **Step 2: Regenerate + build** — `make project && make build …`. Clean.

- [ ] **Step 3: Append a decision-log entry** to `docs/decision-log.md`:

```markdown
## 2026-05-30 — [ios] Cart screen — display estimate outside CartManager; edit merges by config

**Decision:** The cart's price estimate lives in a pure `CartEstimate` helper, NOT on `CartManager`. Editing a cart line (`CartManager.updateLine`) preserves the line's quantity and, if the new modifier set collides with another existing line, merges quantities into it (consistent with `add`'s dedupe).

**Context:** Building the v4 cart screen. `CartManager` deliberately exposes no subtotal (Golden Rule #8). The cart needs a display estimate and an edit-drink flow.

**Reasoning:** Keeping the estimate out of `CartManager` preserves the "cart holds no money math" rule — the estimate is display-only (same interpretation as the product-detail screen, already logged), and `CheckoutView` remains authoritative. Merge-on-edit avoids two identical lines after an edit.

**Trade-offs:** Editing into a colliding config silently merges (the edited line's id disappears). Acceptable — the result is the cart the user intends. "Your usual" / reorder / loyalty-after-order remain deferred (no order-history backend).
```

- [ ] **Step 4: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Menu/MenuView.swift docs/decision-log.md
git commit -m "feat(ios): pass food items to cart; record cart decisions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Full verification

- [ ] **Step 1: Full test suite** — `cd apps/ios && make test SIMULATOR_DESTINATION='platform=iOS Simulator,name=iPhone 17 Pro'`. All green (baseline 178 + the new Cart/edit tests).

- [ ] **Step 2: Build** — `make build …`. Clean.

- [ ] **Step 3: Simulator walk** (run the app, backend API up): Menu → add a couple of drinks → open cart. Verify: drink art, Hot/Iced badges, modifier summary, per-line estimate, single `+` at qty 1 → switches to −/＋ stepper at qty 2, **Edit drink** reopens the configurator prefilled and "Update order" updates the line keeping quantity, Remove works, upsell `+` adds, **Checkout** opens `CheckoutView`, empty state after removing all. Tune spacing only if needed (no logic changes).

- [ ] **Step 4: Report** — tests green, build clean, branch ready for review/PR. Do not push without approval.

---

## Self-review (completed by plan author)

**Spec coverage:**
- §4.1 CartEstimate → Task 1 ✅ · §4.2 CartLineSummary → Task 2 ✅ · §4.3 preselect init → Task 3 ✅ · §4.4 updateLine → Task 4 ✅ · §4.5 ItemDetailView edit mode → Task 5 ✅ · §4.6 CartView rewrite → Task 6 ✅ · upsell wiring (§4.6) → Task 6 + Task 7 ✅ · §6 GR#8 estimate → Tasks 1, 6 ✅ · §7 deferred seams → TODO comments in Task 6 + decision-log Task 7 ✅ · §8 tests → Tasks 1–4 + Task 8 ✅.

**Placeholder scan:** the `// TODO:` in CartView is an intentional deferred-seam marker. The `upsell` helper has a deliberately-flagged "fix while typing" clean version (Task 6 callout) — the engineer uses the clean block. "Read the file first" notes (ItemCustomizationTests helpers, MenuView `.sheet`/`allLoadedItems`) are match-the-pattern instructions with the exact change specified.

**Type consistency:** `CartManager.Line` (`item`/`quantity`/`modifierIds`/`id: UUID`) used consistently in CartEstimate, CartLineSummary, updateLine, CartView, EditContext. `ItemCustomization(item:preselectedModifierIds:)` matches across Task 3 and Task 5. `ItemDetailView(item:pairings:editing:)` + `EditContext(lineId:modifierIds:)` match across Tasks 5 and 6. `CartView(locationId:foodItems:)` matches across Tasks 6 and 7. `DetailPalette` tokens + `DrinkArt(token:size:)` + `ItemPairings.resolve(for:in:)` match existing signatures. `Temperature` cases `.hot/.iced/.both` match the model.

**XcodeGen:** Tasks 1, 2 add files → `make project` before testing. Tasks 3–7 modify existing files (no regen needed, but harmless).
