# iOS Cart Screen ("Your Order") — Design

**Date:** 2026-05-30
**Status:** Approved design — ready for implementation planning
**Surface:** `apps/ios` (SwiftUI)
**Reference design:** `design/v4/pulse-coffee-cart-v4.html` (the approved cart mockup, on `main`)
**Audience:** the `/superpowers:writing-plans` planner and the implementing engineer.

---

## 1. Goal & the real gap

When a customer taps the cart, they should see a calm, premium **"Your order"** screen — what they ordered (with size/milk/temperature), an estimated price, and a one-tap path to checkout — matching the v4 mockup.

Today `apps/ios/PulseCoffeeApp/Features/Cart/CartView.swift` is a **plain `List` placeholder**: item name + per-unit price + a quantity stepper + "Proceed to Checkout". It shows **no drink visual, no chosen modifiers, no temperature, no estimate**, and there is **no way to edit a drink** once it's in the cart. Closing that gap — a v4-styled cart with an edit-drink flow — is this work.

This is a **functional + visual** slice scoped to data that exists today. Features in the mockup that need backend data the app doesn't have yet are explicitly deferred (§7).

---

## 2. Scope

### In scope
- Rebuild `CartView` to the v4 mockup using **data available today**: drink art, item name, temperature badge, chosen-modifier summary, optional extras line, per-line **display-only estimate**, quantity control, remove, hardcoded "ready in ~N min", a hardcoded **smart upsell**, a calm empty state, and a sticky **Checkout** CTA.
- A working **edit-drink** flow: tapping a cart line reopens the existing product-detail configurator **prefilled** with that line's selections; saving **updates** the line (preserving quantity).
- Unit tests for all new pure/logic units.

### Out of scope (deferred — backend-gated; §7)
- **"✓ Your usual"** badge on a line, empty-state **reorder-your-usual**, and loyalty **"after this order: 8 of 10"** — all require order-history / loyalty data iOS does not have. Left as TODO seams.
- **Apple Pay directly from the cart** (skipping the total-review step). Apple Pay already exists inside the checkout flow's Stripe `PaymentSheet`; re-architecting the sacred checkout (Golden Rule #2) is a separate effort. The cart's CTA navigates to the existing `CheckoutView`.
- Any backend change. This is iOS-only.

---

## 3. What already exists (reuse, don't rebuild)

| Asset | Location | Role |
|---|---|---|
| `CartManager` (+ `Line`) | `Core/CartManager.swift` | `@MainActor` in-memory cart. `Line` = `item: MenuItem` + `quantity` + `modifierIds: [String]`. Exposes `lines`, `setQuantity`, `remove`, `add`, `toCheckoutItems()`. **Deliberately exposes no subtotal** (GR#8). |
| `CartView` (placeholder) | `Features/Cart/CartView.swift` | **Rewritten** into the v4 screen. |
| `MenuView` | `Features/Menu/MenuView.swift` | Presents the cart via `.sheet(isPresented: $showCart)`. Holds the loaded menu (source of upsell food items). |
| `ItemDetailView` / `ItemCustomization` | `Features/Menu/` | Reused for **edit-drink**. `ItemCustomization` gets a preselect init; `ItemDetailView` gets an edit mode. |
| `ItemPairings` | `Features/Menu/ItemPairings.swift` | Pure resolver reused for the **smart upsell**. |
| `DrinkArt` | `Features/Menu/DrinkArt.swift` | The abstract drink visual (driven by `artToken`). |
| `CheckoutView` | `Features/Checkout/CheckoutView.swift` | Authoritative totals + Stripe `PaymentSheet` (Apple Pay opt-in). The cart's CTA navigates here unchanged. |
| `DetailPalette` / `AppTheme` | `Features/Menu/ProductDetailComponents.swift`, `Core/AppTheme.swift` | Color tokens (ink, warm-cream, accent, etc.). |

**Consequence:** the cart layer and checkout layer are ready. This is **a view rewrite + two small pure helpers + a small `ItemCustomization`/`ItemDetailView` edit affordance + one `CartManager` method.**

---

## 4. Architecture — small, independently-testable units

### 4.1 `CartEstimate` — display-only price (pure, NEW)
A plain value type / enum of pure functions. **Not** on `CartManager` (which by design exposes no subtotal — GR#8).
- `lineEstimateCents(_ line: CartManager.Line) -> Int` = `item.basePriceCents + Σ (priceCents of modifiers whose id ∈ line.modifierIds)`, then `× line.quantity`. Integer cents (GR#7).
- `subtotalEstimateCents(_ lines: [CartManager.Line]) -> Int` = Σ line estimates.
- A display formatter (`"$%.2f"`) used only for the final string, mirroring `MenuItem.displayPrice`.
- **Display only** — never sent to the server; the backend computes the charge at checkout (GR#8). Exhaustively unit-testable.

### 4.2 `CartLineSummary` — modifier/temperature presentation (pure, NEW)
- `temperature(for line:) -> Temperature` = `line.item.temperature`.
- `modifierSummary(for line:) -> String` = required/single-select selections joined with `" · "` (e.g. `"16 oz · Oat · Half sweet"`), resolved by mapping `line.modifierIds` through `line.item.modifierGroups` sorted by `sortOrder`.
- `extras(for line:) -> [String]` = multi-select selections (e.g. `["Matcha shot"]`) for the accent "+ …" line.
- Pure; unit-tested against representative lines.

### 4.3 `ItemCustomization` preselect init (MODIFY)
Add `init(item: MenuItem, preselectedModifierIds: [String])` that seeds `selections` from the given IDs (grouped back into their groups) instead of the cheapest-option defaults. Used by edit mode. Unit-tested (round-trips a line's IDs back to the same `selectedModifierIds`).

### 4.4 `CartManager.updateLine` (MODIFY)
`func updateLine(lineId: Line.ID, modifierIds: [String])` — replaces the line's modifier set **while preserving its quantity**. Re-keys the line by `(item, modifierIds)`: if the new config collides with another existing line, merge quantities (consistent with `add`'s dedupe); otherwise update in place. (`Line.modifierIds` becomes `var`, or the line is replaced.) Unit-tested: preserves quantity; merges on collision; no-op on unknown id.

### 4.5 `ItemDetailView` edit mode (MODIFY)
An optional edit context: `init(item:, pairings:, editing: EditContext?)` where `EditContext = (lineId, quantity)`. When editing:
- `ItemCustomization` is seeded via the preselect init (4.3).
- The CTA reads **"Update order"** (not "Add to Order").
- On tap it calls `cart.updateLine(lineId:, modifierIds:)` (not `add`) and pops.
Non-editing behaviour is unchanged.

### 4.6 `CartView` (REWRITE)
A `ScrollView` + sticky bottom CTA holding the v4 layout. Reuses `DrinkArt` and `DetailPalette`. Sections:
1. **Header:** "Your order" (serif) + sub "N drinks · ready in ~N min". (ETA hardcoded; TODO queue estimate.)
2. **Lines:** `ForEach(cart.lines)` → a row with `DrinkArt`, name, **temperature badge** (flame/snowflake SVG-equivalent SF Symbols, warm/cool tint), modifier summary, optional extras, per-line **estimate** (`CartEstimate`), **quantity** (single `+` when `quantity == 1`, full −/＋ stepper when `> 1`), and **Edit drink / Remove** actions. Tapping the line (or "Edit drink") enters edit mode (4.5).
3. **Smart upsell:** `ItemPairings.resolve(for: <a cart drink>, in: foodItems)` → first unresolved-safe suggestion; compact card with `+` quick-add. Hidden if nothing resolves.
4. **Summary:** subtotal **estimate** + "Tax & final total calculated at checkout."
5. **Sticky CTA:** "Checkout" → existing `CheckoutView` (unchanged flow).
6. **Empty state:** calm "Nothing here yet" + "Browse menu" (the richer reorder-your-usual variant is deferred, §7).

`MenuView` passes its loaded food items into `CartView` (for the upsell). Presentation stays a **sheet** (existing `showCart` wiring); the sheet covers the tab bar = the mockup's focused feel.

---

## 5. Data flow

```
MenuView (has loaded menu)
  │  cart icon → showCart = true → .sheet { CartView(locationId:, foodItems:) }
  ▼
CartView(cart: CartManager)
  per line → DrinkArt + CartLineSummary(temp, mods, extras) + CartEstimate.lineEstimateCents
  qty → cart.setQuantity(...)      remove → cart.remove(...)
  tap line / "Edit drink" → push ItemDetailView(item:, editing:(lineId, qty))
        prefilled via ItemCustomization(item:, preselectedModifierIds: line.modifierIds)
        "Update order" → cart.updateLine(lineId:, modifierIds:) → pop
  upsell "+" → cart.add(item: foodItem)
  subtotal → CartEstimate.subtotalEstimateCents(cart.lines)   (display only)
  "Checkout" → CheckoutView(cart:, appState:, locationId:)    (unchanged; backend = price truth)
```

---

## 6. Pricing & safety (GR#8)

The cart shows a **display-only estimate** (per-line and subtotal), exactly the interpretation already recorded in `docs/decision-log.md` for the product-detail screen: iOS sums locally for display, never sends a price, and `CheckoutView` shows/charges the backend's authoritative total. `CartManager` continues to expose **no** subtotal — the estimate lives in the separate `CartEstimate` display helper, so the "cart holds no money math" rule is preserved. All math is integer cents (GR#7); `Double` only in the final format string. The cart copy ("Tax & final total calculated at checkout") makes the estimate explicit.

---

## 7. Deferred (TODO seams)

Recorded as inline `// TODO:` at the call sites and consistent with `docs/todo-endpoints.md`:
1. **"✓ Your usual" badge** + **empty-state reorder** — need a "most-ordered / last-order" source (order history).
2. **Loyalty "after this order: 8 of 10"** — needs loyalty progress data.
3. **Queue-based ready-time** — replaces the hardcoded "~N min".
4. **Apple Pay directly from cart** — a checkout-flow optimization (GR#2); Apple Pay already exists in `CheckoutView`'s PaymentSheet.

---

## 8. Testing

Deterministic, no network/time, following existing `CartManagerTests` / `ItemCustomizationTests` patterns.

**Pure/logic units:**
- `CartEstimate`: line estimate = base + selected deltas × qty; subtotal = Σ; 0-delta modifiers; empty cart = 0.
- `CartLineSummary`: modifier summary string order (by `sortOrder`); extras extraction; temperature pass-through.
- `ItemCustomization(preselectedModifierIds:)`: seeds exactly the given IDs; `selectedModifierIds` round-trips.
- `CartManager.updateLine`: preserves quantity; merges into a colliding line; no-op on unknown id; leaves other lines intact.

**Edit-to-cart wiring:** editing a line through `ItemDetailView` edit mode updates that line's `modifierIds` and keeps its quantity (regression: editing does not create a duplicate line or reset qty to 1).

**View:** verified in the simulator (visual + the qty single-`+`/stepper switch + edit round-trip).

---

## 9. Golden Rules checklist
- **#7 (integer cents):** all estimate math is `Int` cents. ✅
- **#8 (iOS never calculates the charged price):** estimate is display-only in `CartEstimate`; `CartManager` exposes no subtotal; `CheckoutView` is authoritative. ✅
- **#2 (checkout sacred):** the pay flow is untouched — the CTA only navigates to the existing `CheckoutView`. ✅
- **#17 (non-critical surfaces fail safe):** upsell hides when unresolved; estimate/summary degrade to base; missing modifiers simply omit from the summary. ✅
- **#15 (ship boring first):** no speculative backend; deferred features are seams, not built. ✅
