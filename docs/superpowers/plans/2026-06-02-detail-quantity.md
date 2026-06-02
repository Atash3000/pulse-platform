# Product Detail Quantity Stepper — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 1–12 quantity stepper to the product-detail sticky CTA (add + edit modes); the CTA shows the per-unit-estimate × quantity total.

**Architecture:** UI-only on iOS. `ItemDetailView` gains a `quantity` state + a stepper pill on the CTA; `addToOrder` passes the quantity to the already-quantity-aware `CartManager.add`, and to `CartManager.updateLine` which gains an optional `quantity` (`nil` = preserve, so existing callers/tests are untouched). Total price is display-only (GR#8).

**Tech Stack:** SwiftUI, **iOS 16 target**. XCTest. **XcodeGen** (no new files here, so `make project` is optional). Build/test from `apps/ios/` with `make test SIMULATOR_DESTINATION='platform=iOS Simulator,name=iPhone 17 Pro'`.

**Branch:** `feat/ios/detail-quantity` (off `main`; spec committed on it).

> **Commit policy (CLAUDE.md §8):** each task ends with a commit; the human approves. Don't push.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `apps/ios/PulseCoffeeApp/Core/CartManager.swift` | Modify | `updateLine` gains optional `quantity` |
| `apps/ios/PulseCoffeeAppTests/CartManagerTests.swift` | Modify | Tests for the quantity param |
| `apps/ios/PulseCoffeeApp/Features/Menu/ItemDetailView.swift` | Modify | quantity state + stepper + total + EditContext.quantity + addToOrder |
| `apps/ios/PulseCoffeeApp/Features/Cart/CartView.swift` | Modify | Pass `line.quantity` into edit `EditContext` |
| `docs/decision-log.md` | Modify (append) | Record the decision |
| `apps/ios/README.md` | Modify | One-line note |
| `docs/todo-endpoints.md` | Modify | Backend max-quantity seam |

---

## Task 1: `CartManager.updateLine` gains optional `quantity` (TDD)

**Files:** Modify `apps/ios/PulseCoffeeApp/Core/CartManager.swift`, `apps/ios/PulseCoffeeAppTests/CartManagerTests.swift`

- [ ] **Step 1: Add failing tests** to `CartManagerTests.swift` (match the existing `updateLine` tests' inline `MenuItem` construction):

```swift
@MainActor
func test_updateLine_explicitQuantity_replacesQuantity() {
    let cart = CartManager()
    let item = MenuItem(id: "i", name: "Latte", description: nil, basePriceCents: 550, imageURL: nil,
        available: true, quantityLeft: nil, modifierGroups: [])
    cart.add(item: item, quantity: 2, modifierIds: ["oat"])
    let id = cart.lines[0].id
    cart.updateLine(lineId: id, modifierIds: ["whole"], quantity: 5)
    XCTAssertEqual(cart.lines.count, 1)
    XCTAssertEqual(cart.lines[0].modifierIds, ["whole"])
    XCTAssertEqual(cart.lines[0].quantity, 5)
}

@MainActor
func test_updateLine_explicitQuantity_mergeAddsNewQuantity() {
    let cart = CartManager()
    let item = MenuItem(id: "i", name: "Latte", description: nil, basePriceCents: 550, imageURL: nil,
        available: true, quantityLeft: nil, modifierGroups: [])
    cart.add(item: item, quantity: 1, modifierIds: ["whole"])  // A
    cart.add(item: item, quantity: 2, modifierIds: ["oat"])    // B
    let bId = cart.lines[1].id
    cart.updateLine(lineId: bId, modifierIds: ["whole"], quantity: 3)  // B → matches A, merge with NEW qty
    XCTAssertEqual(cart.lines.count, 1)
    XCTAssertEqual(cart.lines[0].quantity, 1 + 3)
}
```

- [ ] **Step 2: Run, verify it fails** — `make test …` → compile failure (updateLine has no `quantity` param).

- [ ] **Step 3: Implement** — replace the existing `updateLine` body in `CartManager.swift`:

```swift
    /// Replaces a line's modifier set (edit-drink flow). `quantity == nil`
    /// preserves the line's current quantity (existing callers); a value
    /// replaces it. Merge-on-collision adds the new/preserved quantity into
    /// the matching line. Remove-first to avoid index aliasing.
    func updateLine(lineId: Line.ID, modifierIds: [String], quantity: Int? = nil) {
        guard let index = lines.firstIndex(where: { $0.id == lineId }) else { return }
        let old = lines[index]
        let newQty = quantity ?? old.quantity
        lines.remove(at: index)
        if let mergeIndex = lines.firstIndex(where: {
            $0.item.id == old.item.id && $0.modifierIds == modifierIds
        }) {
            lines[mergeIndex].quantity += newQty
        } else {
            lines.insert(Line(item: old.item, quantity: newQty, modifierIds: modifierIds), at: index)
        }
    }
```

- [ ] **Step 4: Run, verify it passes** — `make test …`. New tests pass; the existing `updateLine` tests (which call the 2-arg form, now defaulting `quantity: nil`) stay green unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Core/CartManager.swift apps/ios/PulseCoffeeAppTests/CartManagerTests.swift
git commit -m "feat(ios): CartManager.updateLine accepts optional quantity

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `ItemDetailView` quantity stepper + total + wiring

**Files:** Modify `apps/ios/PulseCoffeeApp/Features/Menu/ItemDetailView.swift`, `apps/ios/PulseCoffeeApp/Features/Cart/CartView.swift`

- [ ] **Step 1: `EditContext` carries quantity** — change the struct (near line 24):

```swift
    struct EditContext: Equatable { let lineId: UUID; let modifierIds: [String]; let quantity: Int }
```

- [ ] **Step 2: Add quantity state + seed it in `init`** — after `@State private var didAdd = false`, add:

```swift
    @State private var quantity: Int
```

and in `init(item:pairings:editing:)`, after setting `self.editing = editing`, add:

```swift
        _quantity = State(initialValue: editing?.quantity ?? 1)
```

- [ ] **Step 3: Add the total-price + stepper helpers** — near `addToOrder` / `ctaLabel`, add:

```swift
    /// Display-only total = per-unit estimate × quantity (Golden Rule #8).
    private var totalPriceCents: Int { customization.displayPriceCents * quantity }
    private var totalPrice: String { String(format: "$%.2f", Double(totalPriceCents) / 100.0) }

    private func setQuantity(_ n: Int) {
        let clamped = min(12, max(1, n))
        guard clamped != quantity else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        quantity = clamped
    }

    private var quantityStepper: some View {
        HStack(spacing: 14) {
            Button { setQuantity(quantity - 1) } label: {
                Image(systemName: "minus").font(.system(size: 15, weight: .semibold))
            }
            .disabled(quantity <= 1)
            .foregroundStyle(quantity <= 1 ? DetailPalette.inkFaint : DetailPalette.ink)
            Text("\(quantity)")
                .font(.system(size: 16, weight: .semibold).monospacedDigit())
                .frame(minWidth: 16)
                .foregroundStyle(DetailPalette.ink)
            Button { setQuantity(quantity + 1) } label: {
                Image(systemName: "plus").font(.system(size: 15, weight: .semibold))
            }
            .disabled(quantity >= 12)
            .foregroundStyle(quantity >= 12 ? DetailPalette.inkFaint : DetailPalette.ink)
        }
        .buttonStyle(.plain)
        .padding(.vertical, 15)
        .padding(.horizontal, 16)
        .background(Capsule().fill(DetailPalette.warmCream))
        .overlay(Capsule().stroke(DetailPalette.ink.opacity(0.14)))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Quantity, \(quantity)")
    }
```

- [ ] **Step 4: Restructure the CTA row** — in `stickyCTA`, replace the existing `Button(action: addToOrder) { … }` (and its `.disabled`/`.opacity` modifiers) with a stepper-plus-button row:

```swift
                HStack(spacing: 12) {
                    quantityStepper
                    Button(action: addToOrder) {
                        HStack {
                            Text(ctaLabel)
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                            Spacer()
                            Text(totalPrice).opacity(0.85)
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
```

> The button previously showed `customization.displayPrice`; it now shows `totalPrice`. Keep the surrounding `VStack(spacing: 4)` + the "Choose a …" hint + the gradient + `.padding`/`.background(DetailPalette.warmCream)` exactly as they are.

- [ ] **Step 5: Pass quantity in `addToOrder`** — replace the add/update calls:

```swift
    private func addToOrder() {
        if let editing {
            cart.updateLine(lineId: editing.lineId, modifierIds: customization.selectedModifierIds, quantity: quantity)
        } else {
            cart.add(item: item, quantity: quantity, modifierIds: customization.selectedModifierIds)
        }
        didAdd = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 600_000_000)
            dismiss()
        }
    }
```

- [ ] **Step 6: `CartView` passes the line's quantity into edit** — in `CartView.swift`, the edit `navigationDestination` builds `ItemDetailView(item:, editing:)`. Update the `EditContext` init to include quantity:

```swift
                    ItemDetailView(item: line.item,
                                   editing: .init(lineId: line.id, modifierIds: line.modifierIds, quantity: line.quantity))
```

- [ ] **Step 7: Build + test** — `cd apps/ios && make build SIMULATOR_DESTINATION='platform=iOS Simulator,name=iPhone 17 Pro'` then `make test …`. Clean build + green (≈196 tests). The `#Preview` blocks need no change (default add mode, quantity 1).

- [ ] **Step 8: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Menu/ItemDetailView.swift apps/ios/PulseCoffeeApp/Features/Cart/CartView.swift
git commit -m "feat(ios): quantity stepper on product detail CTA (add + edit)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Docs — decision-log + README + todo seam

**Files:** Modify `docs/decision-log.md`, `apps/ios/README.md`, `docs/todo-endpoints.md`

- [ ] **Step 1: Append the decision-log entry** to the end of `docs/decision-log.md`:

```markdown
## 2026-06-02 — [ios] Product-detail quantity stepper (1–12); updateLine gains optional quantity

**Decision:** The product-detail sticky CTA carries a 1–12 quantity stepper (default 1; pre-filled to the line's quantity in edit mode). The CTA shows the display-only total (`displayPriceCents × quantity`). `CartManager.updateLine` gains `quantity: Int? = nil` — `nil` preserves the line's quantity (existing callers), a value replaces it.

**Context:** Customers needed to add several of a drink at once; the add CTA was hardcoded to quantity 1.

**Reasoning:** `CartManager.add` already took a quantity; the only gaps were the UI, the total display, and a quantity on the edit path. The optional `quantity` keeps the existing `updateLine` callers/tests unchanged (back-compat). Total stays display-only (GR#8); `CheckoutView` is authoritative.

**Trade-offs:** The max (12) is a hardcoded iOS constant — a per-item backend limit is a deferred seam (`docs/todo-endpoints.md`), no endpoint today.
```

- [ ] **Step 2: README note** — in `apps/ios/README.md`, add a short bullet (match the file's style) where the product-detail screen is described:

```markdown
- The product-detail CTA carries a 1–12 quantity stepper (default 1); the total it shows is a display-only estimate (the backend prices at checkout).
```

> Read the README first to place it under the right section; keep it to one line.

- [ ] **Step 3: todo-endpoints seam** — add a row to the table in `docs/todo-endpoints.md`:

```markdown
| `menu_items.max_quantity` (or reuse `inventory.quantity_left`) | iOS product-detail quantity cap | MVP hardcodes max 12 in `ItemDetailView`. If a drink ever needs a different/limited per-order max (stock, catering), expose it on the item and clamp to it. No endpoint needed today. |
```

> Read `docs/todo-endpoints.md` first and match its existing table columns.

- [ ] **Step 4: Commit**

```bash
git add docs/decision-log.md apps/ios/README.md docs/todo-endpoints.md
git commit -m "docs(ios): record quantity stepper + backend max-qty seam

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Full verification

- [ ] **Step 1: Full suite** — `cd apps/ios && make test SIMULATOR_DESTINATION='platform=iOS Simulator,name=iPhone 17 Pro'`. All green (baseline 194 + 2 new updateLine tests ≈ 196).
- [ ] **Step 2: Build** — `make build …`. Clean.
- [ ] **Step 3: Simulator walk** — open a drink: stepper shows on the CTA, `−` disabled at 1, `+` disabled at 12, CTA total = price × qty, adding N puts a line of qty N in the cart; from the cart, "Edit drink" reopens with the stepper pre-filled to that line's quantity, and "Update order" changes both modifiers and quantity. Tune spacing only if needed.
- [ ] **Step 4: Report** — tests green, build clean, branch ready for review/PR; do not push without approval.

---

## Self-review (completed by plan author)

**Spec coverage (2026-06-02-detail-quantity-design.md):** §4.1 stepper → Task 2 Steps 3–4 ✅ · §4.2 total → Task 2 Step 3 ✅ · §4.3 EditContext.quantity → Task 2 Steps 1, 6 ✅ · §4.4 updateLine quantity → Task 1 ✅ · §4.5 addToOrder → Task 2 Step 5 ✅ · §6 tests → Task 1 + Task 4 ✅ · §8 docs (decision-log/README/todo) → Task 3 ✅ · §9 backend seam → Task 3 Step 3 ✅.

**Placeholder scan:** the two "read the file first" notes (README placement, todo-endpoints columns) are match-the-pattern instructions with exact content given — not gaps.

**Type/consistency:** `quantity: Int? = nil` on `updateLine` matches across Task 1 + Task 2 Step 5. `EditContext(lineId:modifierIds:quantity:)` matches Task 2 Step 1 + Step 6. `totalPrice`/`totalPriceCents`/`setQuantity`/`quantityStepper` defined in Task 2 Step 3 and used in Step 4. `DetailPalette` tokens (ink/inkFaint/warmCream) exist. Clamp `min(12, max(1, n))` matches the spec's 1–12 range.
