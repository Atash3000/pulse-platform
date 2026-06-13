# iOS Home (Main Screen) — Design

**Date:** 2026-06-11
**Status:** Approved design — ready for implementation planning
**Surface:** `apps/ios` (SwiftUI) + `apps/api` (NestJS) — one new backend endpoint
**Reference design:** `design/v4/pulse-coffee-v4.html` — "SCREEN 1: HOME" (lines ~1580–1793)
**Brand brief:** `design/v4/README.md`
**Audience:** the `/superpowers:writing-plans` planner and the implementing engineer.

---

## 1. Goal & the real gap

The Home tab is the app's emotional front door — a calm "daily ritual" surface that lets a returning customer **reorder their usual in under 10 seconds**. Today `apps/ios/PulseCoffeeApp/Features/Navigation/Placeholders.swift` ships `HomeView` as a "coming soon" stub. This work replaces it with the v4 Home screen, built only from **data that exists today plus one new aggregate endpoint**.

The v4 mockup has six sections. This build ships **four** of them with real data and **defers one** on a hard project constraint:

| Section | This build |
|---|---|
| Top bar (wordmark + avatar) | ✅ Reuse existing `AccountAvatarButton` |
| Greeting + location + line status | ✅ Real (profile + location wait minutes) |
| Hero "Your usual" + Reorder | ✅ Real (new endpoint + reorder flow) |
| "Order again" quick cards | ✅ Real (same endpoint) |
| **Loyalty mini (progress bar)** | 🔴 **Deferred — see §7** |
| "Pair with" food cards | ✅ Real (food items from cached menu) |

## 2. Scope

### In scope
- Replace placeholder `HomeView` with a real, auth-state-aware Home screen matching the v4 mockup (minus the loyalty mini).
- New `HomeViewModel` (`@MainActor ObservableObject`) and `HomeService`.
- One new backend endpoint: **`GET /home/summary`** returning reorder *signatures* + wait minutes.
- A **reorder flow**: map a past order's item signature onto the live menu, add to `CartManager`, and route to checkout (guarded — see §5).
- Guest and no-history fallback states (featured drink + pairings + sign-in nudge).
- Unit tests for all new pure/logic units (backend aggregation, reorder mapping, ViewModel state).

### Out of scope (deferred — §7)
- **Loyalty mini** ("6 of 10 drinks · 4 to next free"). No loyalty backend exists; the decision-log (2026-05-14) forbids shipping **mocked** loyalty numbers. Omitted entirely — not a placeholder row — until the loyalty module lands.
- Any change to the **checkout/payment** internals (Golden Rule #2). Reorder *feeds* the existing checkout flow; it does not modify it.
- Orders-tab / order-status polling work (separate effort).

## 3. What already exists (reuse, don't rebuild)

| Asset | Location | Role |
|---|---|---|
| `AccountAvatarButton` | `Features/Navigation/AccountAvatarButton.swift` | Top-right avatar; already wired on Home. Unchanged. |
| `CartManager` (+ `Line`) | `Core/CartManager.swift` | `@MainActor` in-memory cart. `add(item:quantity:modifierIds:)` dedupes by item+modifier set. Reorder adds lines through this — **deliberately exposes no subtotal** (GR#8). |
| `MenuService` / cached menu | `Services/MenuService.swift`, `Models/Menu.swift` | Source of truth for item names, prices, modifier names, food category, availability. Home joins reorder signatures against this. |
| `LocationService` | `Services/LocationService.swift` | Selected location for the greeting. |
| `currentStoreStatus(now:)` | `Features/Menu/StoreStatus.swift` | Open / closing-soon / closed for the greeting status. |
| `CustomerProfile` | `Models/CustomerProfile.swift` | First name for "Morning, {name}." |
| `GET /orders/my` | `apps/api/.../orders.controller.ts` | Existing history (summary only — **insufficient** for cards; see §4). |
| `order_items` (snapshots) | `apps/api/src/database/entities.ts` | Source for the most-frequent aggregation. |
| Checkout flow | `Features/Checkout/**` | Reorder's destination. **Not modified.** |

## 4. Backend — one new endpoint

**`GET /home/summary`** — customer JWT required. Returns reorder **signatures**, not prices:

```jsonc
{
  "usual":  { "menuItemId": "uuid", "modifierIds": ["..."], "quantity": 1, "lastUnitPriceCents": 645 } | null,
  "recent": [ { "menuItemId": "uuid", "modifierIds": ["..."], "quantity": 1, "lastUnitPriceCents": 525 }, ... ],
  "waitMinutes": 4
}
```

- **`usual`** = the customer's **most-frequent** PAID-order line, grouped by `(menu_item_id, normalized modifier-id set)`. `recent` = the next N **distinct** configs (N ≈ 4, the mockup's row width). Null/empty when the customer has no paid orders.
- **`lastUnitPriceCents`** = the per-unit price from the most recent occurrence of that config (snapshot from `order_items`). It is a **change-detection baseline only** — never displayed and never authoritative. iOS shows the cached menu's current price and the server recomputes the real price at checkout (GR#8); the baseline only lets the reorder guard (§5) detect "price moved since you last ordered this."
- **`waitMinutes`** = `location.current_wait_minutes` for the selected location (backs the greeting's "no line" / "~N min" and the hero's "Ready in N min"). Confirm it is exposed on the public location payload; expose it if not (small additive change).
- **Why signatures, not snapshot prices:** iOS renders names/prices/modifier labels by joining against the **cached menu** (single source of truth), and the **server recomputes price at checkout** (Golden Rule #8). This avoids stale snapshot-price drift and keeps the payload lean.
- **No N+1:** one grouped aggregate query over the customer's `order_items`. Data volume is small (≈50 orders/day at launch); a `GROUP BY` with a `COUNT` + `ORDER BY count DESC LIMIT N` is sufficient. Index check: the customer→orders→items path must be covered (it is, per the hot-path indexes added in `e19c681`); flag if a missing index would force a scan.
- **Modifier-set normalization:** the group key must treat `[a,b]` and `[b,a]` as the same config (sort IDs before hashing) so "your usual" doesn't fragment across orderings.

## 5. iOS — components & reorder flow

### Components
- **`HomeView`** — auth-state branch (mirrors `AccountView`): signed-in vs guest. Hosts `AccountAvatarButton` in the toolbar (already present).
- **`HomeViewModel`** (`@MainActor ObservableObject`) — loads `GET /home/summary`, exposes resolved view state, degrades fail-safe (§6).
- **`HomeService`** — the single `GET /home/summary` call. Pairings + featured come from the cached menu, not a second fetch.
- **`GreetingHeader`** — "Morning, {first name}." + selected location + "no line" (low `waitMinutes`) / "~N min". Time-of-day greeting is a pure function of the clock.
- **`UsualHero`** — maps `usual` → cached `MenuItem`, renders name + config summary ("Large · Oat milk · Light ice") from modifier IDs + "Ready in N min" + a Reorder CTA showing the **server-fresh** price from the cached menu.
- **`OrderAgainRow`** — horizontal cards from `recent`, same signature→menu mapping. Tap = reorder.
- **`PairWithRow`** — items from the menu's **food category** (reuses existing food/pairing data). Tap "+" adds to cart.
- **`FeaturedHero`** — the guest / no-history fallback: a featured menu item (not "your usual").

### Reorder flow (`ReorderCoordinator`)
1. Resolve each signature item against the **cached menu**. Drop any item no longer on the menu or unavailable; record what was dropped.
2. Add the resolved lines to `CartManager`.
3. **Guarded destination:**
   - If **every** item resolved/available **and** each cached-menu unit price equals the signature's `lastUnitPriceCents` → route **straight to checkout** (the sub-10s reorder goal).
   - If **anything** was dropped/unavailable **or** a cached-menu price differs from `lastUnitPriceCents` → route to **Cart** with a short "we updated your order" notice, so the customer reviews before paying.
   - In all cases the **server recomputes the authoritative price at checkout** (GR#8); the guard is a UX courtesy, not a trust boundary.

This keeps the sacred checkout flow (GR#2) untouched — reorder only fills the cart and navigates.

## 6. States & error handling

| State | Home shows |
|---|---|
| Signed-in, has paid orders | greeting · usual-hero · order-again · pair-with |
| Signed-in, **no orders** | greeting · **featured** · pair-with · "Order your first" framing |
| Guest | generic greeting · featured · pair-with · "Sign in to reorder your usual" |
| `GET /home/summary` failed | featured · pair-with · menu CTA (**fail-safe**, GR#17) |

Home is **non-critical** (Golden Rule #17): a failed or slow summary fetch never blocks the screen — it degrades to the featured + pairings layout. No spinner-locked Home, no error wall.

## 7. Deferred (backend-gated) — explicit seams

- **Loyalty mini.** No loyalty backend; mocked numbers are forbidden (decision-log 2026-05-14, "Loyalty view ships placeholder copy"). When the loyalty module + `GET /loyalty/my` land, the mini is a small additive insert below the order-again row. Leave a single `// TODO(loyalty):` seam at that position — **no placeholder row, no mocked data** in this build.
- **Server-provided store status / wait.** `currentStoreStatus` is still client-hardcoded (`docs/superpowers/todos/2026-05-28-store-status-backend.md`). Greeting reuses it as-is; swap is mechanical when the backend ships.

## 8. Testing

- **Backend:** most-frequent aggregation correctness (frequency ordering, modifier-set normalization, PAID-only filter), empty-history → null `usual`, `recent` distinctness.
- **Reorder mapping:** all-available → checkout; some-unavailable → filtered + cart fallback; price-changed → cart fallback with notice.
- **ViewModel:** has-history, no-history, guest, fetch-failure → each resolves to the correct state from §6.
- **Greeting:** time-of-day function branches; "no line" vs "~N min" threshold on `waitMinutes`.

## 9. Build order (for the planner)

1. Backend `GET /home/summary` (aggregation + DTO + tests) — unblocks everything.
2. `HomeService` + `HomeViewModel` + state model (+ tests) against the new endpoint.
3. `HomeView` sections (greeting → usual-hero → order-again → pair-with → featured fallback).
4. `ReorderCoordinator` + guarded checkout routing (+ tests).
5. Wire `HomeView` into `MainTabView`, retire the `HomeView` placeholder in `Placeholders.swift`.
