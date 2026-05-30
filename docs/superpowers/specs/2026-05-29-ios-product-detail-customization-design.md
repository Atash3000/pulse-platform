# iOS Product Detail & Customization Page (v4) — Design

**Date:** 2026-05-29
**Status:** Approved design — ready for implementation planning
**Surface:** `apps/ios` (SwiftUI)
**Reference design:** `design/v4/pulse-coffee-v4.html` Screen 3 ("Detail (matcha)") + `design/v4/README.md`
**Audience for this doc:** the `/superpowers:writing-plans` planner and the implementing engineer.

---

## 1. Goal & the real gap

When a customer taps a menu item, the app should show a **product detail page** where they can read about the drink, **choose their options** (size, milk, etc.), see the price update, and add the configured drink to their cart.

That page already exists as a stub — `apps/ios/PulseCoffeeApp/Features/Menu/ItemDetailView.swift` — but it is explicitly incomplete. Its own header comment says:

> **Modifier selection UI is deferred to Phase 2.** MVP orders use default options only — items with `modifierGroups[].required == true` will fail at the backend's checkout validation because we send an empty `modifierIds` array.

So today, **any drink that requires a choice cannot be ordered correctly** — iOS sends an empty modifier list and the backend rejects it at checkout (`MODIFIER_GROUP_REQUIRED`, per the 2026-05-11 decision-log entry). **Closing this gap is the core of this work.** Everything else (visual polish to match v4) rides on top of it.

This is **"Functional core first"** scope (chosen during brainstorming): build the parts of the v4 detail page that we have data for and that make ordering correct. Defer the parts that need new backend fields.

---

## 2. Scope

### In scope
1. A full-screen, scrolling **product detail page** matching the v4 layout for the parts we can data-back today:
   - **Hero:** abstract `DrinkArt` visual, serif drink name, one-line tagline (from `description`).
   - **Customize:** one pill row per `ModifierGroup`, pills per `Modifier`, with correct single/multi-select and required-group behavior.
   - **Sticky "Add to order" CTA** with a live, display-only price.
2. **Selection + price + validation logic** as a small, pure, fully-tested unit.
3. Wiring: tap a menu row → push the detail page; the existing `+` quick-add button keeps its smart-add behavior.
4. Switch the detail presentation from a **sheet** to a **NavigationStack push** (matches v4's `← Menu` back).
5. Unit tests for the logic; view-model tests for add-to-cart wiring.

### Out of scope (deferred — needs new backend fields)
- **Nutrition stats** (kcal / caffeine / size row). No fields on `MenuItem` today.
- **"Three layers" ingredient storytelling.** No fields today.
- **"Pair with" food upsell.** No recommendation data today.
- **Two-tier adaptive detail** (rich matcha vs. fast coffee). The README endorses it; revisit once the storytelling fields exist.
- **`is_default` modifier flag.** See §6 for the interim default-selection rule and the future backend improvement.
- Any backend change. This is an **iOS-only** slice; it consumes the menu payload that already ships modifier groups.

Each deferred item is noted as a future improvement in §9.

---

## 3. What already exists (reuse, don't rebuild)

| Asset | Location | Role in this work |
|---|---|---|
| `ItemDetailView` (stub) | `Features/Menu/ItemDetailView.swift` | **Rewritten** into the real detail page. |
| `MenuView` | `Features/Menu/MenuView.swift` | Detail presentation changes from `.sheet(item:)` to a `NavigationStack` push. `handleAdd(_:)` smart-add stays. |
| `MenuListRow` | `Features/Menu/MenuListRow.swift` | `onOpenDetail` / `onAdd` callbacks already wired. `canInstantAdd(_:)` stays the smart-add gate. |
| `SpotlightSection` | `Features/Menu/SpotlightSection.swift` | Same `onOpenDetail` / `onAdd` callbacks; detail navigation must work from here too. |
| `DrinkArt` | `Features/Menu/DrinkArt.swift` | The hero's abstract drink visual (driven by `artToken`). |
| `MenuItem` / `ModifierGroup` / `Modifier` | `Models/Menu.swift` | Data is **already complete**: `basePriceCents`, `modifierGroups[].required`, `.multiSelect`, `.sortOrder`, `modifiers[].priceCents` (cent delta), `.sortOrder`. No model changes needed. |
| `CartManager` | `Core/CartManager.swift` | `add(item:quantity:modifierIds:)` already accepts modifier IDs and dedupes lines by `(item, modifierIds)`. **No change needed.** |
| `AppTheme` | `Core/AppTheme.swift` | Color/metric tokens. Detail-specific v4 colors live as local constants where `AppTheme` has no token (consistent with how `MenuView` inlines `--ink`). |

**Key consequence:** the data layer and cart layer are ready. This work is **almost entirely a view + a small view-model**, plus a navigation change.

---

## 4. Architecture

Three units, each independently understandable and testable.

### 4.1 `ItemCustomization` — pure selection/price/validation model (NEW)
A plain value type (no SwiftUI, no `CartManager`) that owns the state of one in-progress customization. This is the testable core.

**Responsibilities:**
- Hold the set of selected `Modifier` IDs, grouped by `ModifierGroup`.
- Apply selection rules on every tap:
  - **Single-select** (`multiSelect == false`): selecting an option replaces any prior selection in that group (radio behavior).
  - **Multi-select** (`multiSelect == true`): selecting toggles that option independently.
- Compute **`displayPriceCents`** = `item.basePriceCents + Σ (priceCents of every selected modifier)`. Integer cents only (Golden Rule #7). **Display only** — never sent to the server (Golden Rule #8; see §5).
- Compute **`isSatisfied`** = every `required` group has ≥ 1 selection. Gates the CTA.
- Expose **`selectedModifierIds: [String]`** for `CartManager.add(...)`.

**Why a separate type:** keeps all the money math and the required-group logic out of the view, so it can be unit-tested exhaustively (single vs. multi, required enforcement, cents summation, default pre-selection) with no UI harness. Mirrors the existing `MenuListRow.canInstantAdd` separation and the project's "tests are the executable spec" standard.

### 4.2 `ItemDetailView` — the screen (REWRITE)
A `ScrollView` with a sticky bottom CTA, holding one `@State ItemCustomization`. Sections top-to-bottom:

1. **Hero** (centered): `DrinkArt` visual (~110×200 per v4), drink name in **system serif** (`.font(.system(..., design: .serif))` — matches how `MenuView` already renders serif section titles; we do **not** bundle Instrument Serif — YAGNI), one-line tagline from `description`.
2. **Customize**: `ForEach` over `item.modifierGroups` sorted by `sortOrder`. Each row = uppercase group label + a wrapping row of **pills** (`ForEach` over `modifiers` sorted by `sortOrder`). Pill visual states match v4 `.pill` / `.pill.active` (selected = dark `--ink` fill, light text). Tapping a pill calls into `ItemCustomization`.
3. **Sticky CTA** (`.safeAreaInset(edge: .bottom)`): "Add to order" + live `displayPriceCents`. Disabled until `isSatisfied`; when disabled, shows a quiet hint naming the first unsatisfied group (e.g. "Choose a size"). On tap → add to cart → pop.

If `item.modifierGroups` is empty, the page still renders (hero + CTA) and the CTA adds immediately — but in practice such items are usually quick-added from the list without opening detail.

### 4.3 `MenuView` navigation change (EDIT)
Replace `.sheet(item: $detailItem)` with a `NavigationStack` push using `.navigationDestination(item:)` (the back button reads as `← Menu`-style, matching v4). `handleAdd(_:)` keeps the smart-add dispatch unchanged:
- `canInstantAdd(item)` → `cart.add(item:)` directly (fast reorder path, which the README explicitly values).
- otherwise → navigate to the detail page.

Row-body tap (`onOpenDetail`) always navigates to detail.

---

## 5. Pricing & safety (the decision, recorded)

**Model: live local price for display, backend authoritative at checkout, with a reconciliation check.** This matches how Starbucks and Blank Street behave (price updates instantly as you change options; the real charge is computed server-side at order time).

- **iOS sums the price locally for display only.** The menu payload already carries each modifier's `priceCents` delta specifically so options can be priced. `ItemCustomization.displayPriceCents` = base + selected deltas. The CTA updates instantly — no network call, no spinner.
- **iOS never *sends* a price.** It sends only the item ID + selected modifier IDs (`CartManager.toCheckoutItems()` already does exactly this). The backend computes what the customer is charged at `POST /checkout`. So even if the displayed number were stale or wrong, **the customer can never be charged the wrong amount** — which is the substance of Golden Rule #8.

This is a deliberate, narrow reading of GR#8: *"iOS never calculates the price that the customer is charged."* A display-only preview that is structurally incapable of reaching the charge path does not violate it. **This interpretation must be recorded in `docs/decision-log.md`** as part of implementation (it nuances iOS rule #4 / GR#8), so future readers know the local sum is intentional, not a slip.

**Added safety (cheap, all on iOS):**
1. **Integer cents only**, no floats anywhere in `ItemCustomization` (Golden Rule #7). `Double` appears solely in the final `String(format:)` for display, as it already does in `MenuItem.displayPrice`.
2. **Reconciliation at checkout:** the checkout/pay screen already displays the backend's authoritative `CheckoutDisplay` total. Add a guard that compares the backend total against the sum of locally-shown line prices; on mismatch, log a **Sentry breadcrumb / non-fatal** (price drift — e.g. a price changed under the 10-min menu cache). The customer always sees and pays the **backend** number. *(This guard lives at the checkout boundary; flagged here because it's the safety net that makes local display pricing safe. The planner should confirm the exact `CheckoutDisplay` field names when implementing.)*
3. **`ItemCustomization` is a pure function of (item, selections)** — exhaustively unit-testable, no rounding surprises.

**Not building now:** a backend price-preview endpoint. It adds a network round-trip on a hot path for zero benefit while modifier pricing is static (no promos/dynamic pricing). Clean future add *if* pricing becomes dynamic (Golden Rule #15 — ship boring first).

> **Note on `CartManager`'s existing comment:** `CartManager` deliberately exposes **no** local subtotal (its header explains why, citing GR#8). This design does **not** change that — the display sum lives in `ItemCustomization` for a single in-progress item, not in `CartManager`, and the cart total still comes only from the backend. The two are consistent.

---

## 6. Default selection (interim rule)

The v4 mockup pre-selects sensible defaults (16oz, Oat, Regular) so the CTA is live and the price shows immediately. The backend `Modifier` has **no `is_default` field** today.

**Interim rule:** on open, `ItemCustomization` pre-selects the **first option (by `sortOrder`) of each *required single-select* group**. This makes the CTA satisfied and the price live immediately, matching the v4 feel, with zero backend change.
- **Required multi-select** groups start empty (no single obvious default) and the CTA stays disabled until the user picks at least one — surfaced by the hint.
- **Optional** groups start empty.

**Future improvement (§9):** add an `is_default` boolean to the backend `Modifier` so defaults are content-controlled rather than "first by sort order." Small, additive, fail-safe.

---

## 7. Data flow

```
MenuView (list)
  │  tap row body ──────────────► navigate to ItemDetailView(item)
  │  tap "+" ──► handleAdd(item)
  │               ├─ canInstantAdd → cart.add(item:)            (no detail)
  │               └─ else          → navigate to ItemDetailView(item)
  ▼
ItemDetailView(item)
  holds  @State ItemCustomization(item)   ← pre-selects defaults (§6)
  pill tap → customization.toggle(modifier, in: group)
            → recompute displayPriceCents + isSatisfied  (instant, local)
  CTA tap (enabled only when isSatisfied):
     cart.add(item: item, quantity: 1, modifierIds: customization.selectedModifierIds)
     → pop back to menu
  ▼
CartManager (in-memory)  ── unchanged ──►  POST /checkout (backend = price truth)
```

---

## 8. Testing

Following existing `MenuTests` / `CartManagerTests` / `MenuViewModelTests` patterns. Deterministic, no network, no time.

**`ItemCustomization` (unit — the core):**
- `test_displayPrice_isBasePlusSelectedDeltas` — cents summation, including 0-delta modifiers.
- `test_singleSelect_replacesPriorSelectionInGroup`.
- `test_multiSelect_togglesIndependently`.
- `test_isSatisfied_falseUntilRequiredGroupChosen` (single and multi).
- `test_optionalGroup_doesNotBlockCTA`.
- `test_defaultSelection_preselectsFirstRequiredSingleSelectBySortOrder`.
- `test_selectedModifierIds_matchesActivePills`.
- `test_emptyModifierGroups_isSatisfied_andPriceIsBase`.

**Add-to-cart wiring (view-model/integration):**
- Adding a configured item produces a `CartManager` line with the exact selected `modifierIds`.
- Two different configurations of the same item create two lines; identical configurations merge (already `CartManager` behavior — assert it holds via this path).

**Regression:** an item with a required group, configured through the detail page, yields a non-empty `modifierIds` — i.e. the exact failure described in the `ItemDetailView` stub comment no longer occurs.

---

## 9. Future improvements (deferred, noted)

1. **Nutrition stats** — add `calories` / `caffeine_mg` (and a canonical size label) to the menu item payload; render the v4 3-stat row.
2. **"Three layers" storytelling** — add an ordered ingredient/layer array (name, description, swatch color) for hero drinks; render the v4 layers section.
3. **"Pair with" upsell** — add a recommendation source (per-item or per-category); render the horizontal food scroll with `+` quick-add.
4. **Two-tier adaptive detail** — once 1–3 exist, render rich storytelling for matcha heroes and a lean layout for classic coffee (per `design/v4/README.md`).
5. **`is_default` modifier flag** — replace the §6 "first by sort order" interim with content-controlled defaults.
6. **Bundled serif font** (Instrument Serif) — only if the system serif proves visually insufficient against the v4 reference.

---

## 10. Golden Rules checklist

- **#7 (integer cents):** all math in `ItemCustomization` is `Int` cents. ✅
- **#8 (iOS never calculates the charged price):** local sum is display-only and structurally cannot reach the charge path; backend computes the charge at checkout; reconciliation guard catches drift. Interpretation to be logged in the decision-log. ✅
- **#2 (checkout sacred) / cart in memory:** no new network calls; cart stays in-memory; `CartManager` unchanged. ✅
- **#15 (ship boring first):** no speculative price-preview endpoint; functional core only. ✅
- **#17 (non-critical surfaces fail safe):** detail page consumes already-fail-safe decoded fields (`temperature`, `artToken`, etc.); missing `description` → tagline simply omitted. ✅
```
