# Product Detail — Quantity Stepper — Design

**Date:** 2026-06-02
**Status:** Approved design — ready for implementation planning
**Surface:** `apps/ios` (SwiftUI)
**Audience:** the `/superpowers:writing-plans` planner and the implementing engineer.

---

## 1. Goal & gap

On the product detail screen, a customer can currently add only **one** of a drink at a time (the CTA calls `cart.add(quantity: 1)`). They want to add several at once — "2 Ginger Matchas." Add a **quantity stepper** to the sticky CTA so they pick **1–12**, default **1**, and the same control works when **editing** a cart line.

`CartManager.add(item:quantity:modifierIds:)` already supports any quantity; the only missing pieces are the UI control, the total-price display, and a `quantity` on the edit path (`updateLine` currently can't change a line's quantity).

---

## 2. Scope

### In scope
- A `− N +` quantity stepper on the detail sticky CTA (add **and** edit modes), 1–12.
- CTA shows the **total** display-estimate (`per-unit × quantity`).
- `CartManager.updateLine` gains an optional `quantity` so edit mode can change a line's quantity.
- Tests for the logic; docs/decision-log/todo updates.

### Out of scope (todo seams — §9)
- A **backend-driven max-quantity / per-item limit** (the `12` cap is a hardcoded MVP constant).
- Any backend change or endpoint. This is iOS-only; no new API.

---

## 3. What exists (reuse, don't rebuild)

| Asset | Location | Role |
|---|---|---|
| `ItemDetailView` | `Features/Menu/ItemDetailView.swift` | Holds the CTA + `addToOrder()` + `EditContext`. Gets the stepper. |
| `ItemCustomization.displayPriceCents` | `Features/Menu/ItemCustomization.swift` | Per-unit display estimate (GR#8). Total = `× quantity`. |
| `CartManager.add(item:quantity:modifierIds:)` | `Core/CartManager.swift` | Already takes quantity — the add path just passes it. |
| `CartManager.updateLine(lineId:modifierIds:)` | `Core/CartManager.swift` | Gains an optional `quantity` (edit path). |
| `CartView` | `Features/Cart/CartView.swift` | Opens edit; passes the line's quantity into `EditContext`. |
| `DetailPalette` | `Features/Menu/ProductDetailComponents.swift` | Stepper colors (ink/warm-cream), matches the cart's qty pill. |

**Consequence:** this is **one view change + one `CartManager` signature addition + a `CartView` one-liner**, no new types/files.

---

## 4. Architecture — the four small changes

### 4.1 `ItemDetailView` — quantity state + stepper (MODIFY)
- Add `@State private var quantity: Int`. In `init`, seed from `editing?.quantity ?? 1`.
- **Sticky CTA layout** becomes one row: a compact **`− N +` pill on the left** (reusing the cart's qty-pill look — `DetailPalette` tokens), then the existing **CTA button** filling the remaining width. The button text becomes `"\(ctaLabel) · \(totalPrice)"`.
- Stepper rules: `−` decrements (disabled/no-op at **1**); `+` increments (disabled/no-op at **12**). Clamp via `quantity = min(12, max(1, …))`.
- Light haptic on each step (`UIImpactFeedbackGenerator(style: .light)`), consistent with the pills.

### 4.2 Total price (display-only, GR#8)
- `private var totalPriceCents: Int { customization.displayPriceCents * quantity }`
- `private var totalPrice: String { String(format: "$%.2f", Double(totalPriceCents) / 100.0) }`
- Shown on the CTA. Never sent to the server; `CheckoutView` remains authoritative.

### 4.3 `EditContext` carries quantity (MODIFY)
- `struct EditContext: Equatable { let lineId: UUID; let modifierIds: [String]; let quantity: Int }`
- `CartView`'s edit push passes `quantity: line.quantity`.

### 4.4 `CartManager.updateLine` gains quantity (MODIFY)
- `func updateLine(lineId: Line.ID, modifierIds: [String], quantity: Int? = nil)` — **`nil` = preserve** the line's current quantity (so existing callers/tests are untouched); a value **replaces** it. On the merge-collision path, the colliding line's quantity `+=` the new (or preserved) quantity. Remove-first pattern is kept.

### 4.5 `addToOrder()` (MODIFY)
```
if let editing { cart.updateLine(lineId: editing.lineId, modifierIds: customization.selectedModifierIds, quantity: quantity) }
else           { cart.add(item: item, quantity: quantity, modifierIds: customization.selectedModifierIds) }
```

---

## 5. Data flow

```
ItemDetailView(item:, pairings:, editing:)
  quantity = editing?.quantity ?? 1
  stepper − / +  → clamp 1...12
  CTA shows "\(ctaLabel) · \(totalPrice)"  where totalPrice = displayPriceCents × quantity (display only)
  CTA tap:
    add  → cart.add(item:, quantity: quantity, modifierIds:)
    edit → cart.updateLine(lineId:, modifierIds:, quantity: quantity)
  → dismiss
CartView edit push → ItemDetailView(item: line.item, editing: .init(lineId: line.id, modifierIds: line.modifierIds, quantity: line.quantity))
```

---

## 6. Testing

- **`CartManager.updateLine` with explicit `quantity`:** sets the new quantity (replaces, not preserves); merge-collision path adds the new quantity into the target line; `quantity: nil` still preserves (existing 5 updateLine tests stay green unchanged).
- **Total math:** `displayPriceCents × quantity` — assert via `ItemCustomization.displayPriceCents` (already tested) × a quantity in a small unit check.
- **Clamp:** `min(12, max(1, n))` — if extracted to a tiny helper, unit-test the bounds; otherwise exercised via the view.
- **View (simulator):** stepper shows in add + edit, CTA total updates with quantity, edit pre-fills the line's quantity, qty round-trips into the cart line.

---

## 7. Golden Rules
- **#7 (integer cents):** total is `Int` cents × quantity. ✅
- **#8 (iOS never calculates the charged price):** total is display-only; `CartManager` exposes no subtotal; `CheckoutView` authoritative. ✅
- **#2 (checkout sacred):** unchanged — no payment path touched. ✅
- **#17 (fail-safe):** clamp keeps quantity in 1…12; required-group validation unchanged (CTA still gated on `isSatisfied`). ✅

---

## 8. Docs to update (part of the work, per the manager)
- **Decision-log entry:** quantity on the detail screen + `updateLine` optional-quantity (display-only total; nil-preserve back-compat).
- **`apps/ios/README.md`:** one line noting the detail CTA carries a 1–12 quantity stepper.
- **`docs/todo-endpoints.md`:** the deferred backend seam (below).

## 9. Deferred / todos (no redundant endpoints — captured so we don't forget)
- **Backend per-item max quantity** — the `12` cap is a hardcoded iOS constant. If a drink ever needs a different/limited max (e.g. low stock, catering rules), expose a `max_quantity` (or reuse `inventory.quantity_left`) on the menu item and clamp to it. **No endpoint needed today** — recorded in `docs/todo-endpoints.md` so it isn't reinvented.
- No other backend work: `add`/`updateLine` are in-memory; checkout already sends per-line `quantity` via `toCheckoutItems()`.
