# Deferred Endpoints & Fields — TODO Seams

Things the Product Detail v2 work (2026-05-29) deliberately did **not**
build, recorded here so they aren't forgotten. Each has a corresponding
`// TODO:` comment at the iOS call site that will consume it.

| Seam | Needed by | Notes |
|---|---|---|
| `GET /orders/history?itemId=…` (or per-item "have I ordered this?") | iOS real "Your Usual ✓ — … + Apply" line | MVP ships a static "Pulse recommends …" line instead. No order-history API is consumed by iOS today. |
| Favorites sync endpoints (`GET/PUT /me/favorites`) | iOS favorite heart backend sync | MVP stores favorites locally (UserDefaults, keyed by item ID). Local-only until this lands. |
| Queue-based ready-time estimate | iOS "Ready in ~4 min" pill | MVP hardcodes `~4 min`. Replace with a real per-location queue estimate. |
| `menu_items.serving_size` (e.g. oz label) | iOS fixed-size metadata line ("Espresso · 4 oz · Hot") | MVP hardcodes the oz label for the 3 fixed-size drinks on iOS. A backend field would make it data-driven. |
| Nutrition fields (kcal / caffeine_mg / allergens) | iOS optional `ⓘ` bottom sheet (#18) | Hidden entirely for MVP. |
| `menu_items.max_quantity` (or reuse `inventory.quantity_left`) | iOS product-detail quantity stepper cap | iOS hardcodes max 12 in `ItemDetailView`. If a drink ever needs a different/limited per-order max (low stock, catering), expose it on the item and clamp the stepper to it. No endpoint needed today. |

When any of these is built, search the iOS codebase for the matching
`// TODO:` to find the exact consumption point.

## Frontend follow-ups (not endpoints)

UI work deferred until a backend seam above lands. Not blocked on an API.

- **Align the cart's per-line quantity control with the detail stepper's 12-cap.** `CartView`'s per-line quantity control has no 12-cap, unlike the product-detail stepper (`ItemDetailView`). Align them when the cap becomes backend-driven (see `menu_items.max_quantity` above).
- **Category nav horizontal overflow.** `CategoryTabBar` splits the width evenly across categories (3 fit today). If categories ever exceed the width, make the bar horizontally scrollable. Frontend-only; no endpoint.
- **Dynamic Type on the menu.** The Menu uses fixed font sizes (e.g. `CategoryTabBar` pill labels at 13pt, the header at 26pt) inherited from the design system — they don't scale with the user's Dynamic Type setting. A scalable-type pass across the menu (paired with the horizontal-overflow work, since scalable pill labels can truncate in even-split pills) is deferred. Frontend-only; no endpoint.
