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

When any of these is built, search the iOS codebase for the matching
`// TODO:` to find the exact consumption point.
