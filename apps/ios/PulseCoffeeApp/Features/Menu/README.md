# Menu

The v4 Menu screen — header + temperature toggle + per-category sections (Matcha spotlight, Classic Coffee list, Food list) — plus the shared abstract drink-symbol system used in spotlight hero cards and list rows.

Design source: `design/v4/pulse-coffee-v4.html`. Spec: `docs/superpowers/specs/2026-05-27-pulse-menu-v4-design.md`.

## Files

| File | Purpose |
|---|---|
| `MenuView.swift` | Screen entry point. Hides the system nav bar, renders the custom topbar (status dot + location name + cart), and switches on `MenuViewModel.state` to show loading / failed / empty / loaded. The loaded body is a `ScrollView` + `LazyVStack` composing `TemperatureToggle` + `SpotlightSection` (for `display_style == .spotlight`) or a stack of `MenuListRow` (for `.list`). Smart-add wired here via `handleAdd(_:)` calling `MenuListRow.canInstantAdd(_:)`. |
| `MenuViewModel.swift` | `@MainActor` view-model. Bootstraps `LocationSummary` + `Menu`, holds `state`. Owns `selectedTemperature: TemperatureFilter` (`@Published`) and a `filteredMenu` computed property. Pure static `filter(_:by:)` is the testable seam. |
| `ItemDetailView.swift` | Item detail sheet. Modifier picker UI is still a placeholder ("ships in a later release") — concern D will land it. Detail is opened from `MenuView`'s smart-add for items with required modifier groups. |
| `SpotlightSection.swift` | Renders `display_style == .spotlight` categories: hero card on top (featured item or first surviving item after the temperature filter) + horizontal-scroll of compact cards for the rest. Hero pick logic in static `hero(in:)` + `nonHeroItems(in:hero:)` so the rule is independently testable. |
| `MenuListRow.swift` | Vertical row for `display_style == .list` categories. Drink mini + name + temperature pill + price + `+` button. The static `canInstantAdd(_:)` is the smart-add rule (true iff no required modifier groups). |
| `TemperatureToggle.swift` | All / ☕ Hot / ❄ Iced segmented pill + the `TemperatureFilter` enum bound to `MenuViewModel.selectedTemperature`. View subviews are extracted (`segment(for:)`, `segmentBackground(isActive:)`, `trackBackground`) so Swift's type-checker doesn't trip. |
| `DrinkArt.swift` | Token-driven SwiftUI drink visuals. `DrinkArtKind` (matcha / classic / food), `DrinkArtSpec` (palette + glyph + isFallback), `DrinkArtRegistry` (15 seeded tokens). All hex colors copied verbatim from `design/v4/pulse-coffee-v4.html`. Includes a `Color(hex: UInt32)` convenience init. |
| `StoreStatus.swift` | **Hardcoded** topbar status calculation. Pure `currentStoreStatus(now:calendar:)` returns `.open` / `.closingSoon` / `.closed` based on local wall-clock against 7:00–18:00 hours. Carries a TODO pointing at `docs/superpowers/todos/2026-05-28-store-status-backend.md` for the backend hand-off. |
| `StoreStatusDot.swift` | 10pt circle bound to a `StoreStatus`. Green / amber / red + gentle `repeatForever` pulse. VoiceOver-labelled. |

## Companion tests

| File | What it pins |
|---|---|
| `MenuTests.swift` | Codable round-trip for `Menu` / `MenuCategory` / `MenuItem`, fail-safe decoding of `temperature` / `featured` / `art_token` / `display_style` (Golden Rule #17), legacy v3 JSON still decodes with defaults. |
| `MenuViewModelTests.swift` | `MenuViewModel.filter(_:by:)` — all/hot/iced matrix, category hide when empty, hero ordering after filter, source-order preservation. |
| `DrinkArtTests.swift` | Registry kind resolution (matcha / classic / food), unknown / nil → fallback with `isFallback: true`, **every backend-seeded token is registered** (so a future drink lands loud at review). |
| `SpotlightSectionTests.swift` | `hero(in:)` + `nonHeroItems(in:hero:)` rules. |

## Design choices

- **System nav bar hidden.** `.toolbar(.hidden, for: .navigationBar)` — the v4 HTML doesn't have a system nav bar; the topbar is part of the screen content. `NavigationStack` is retained for sheet presentation.
- **HTML hex codes are the source of truth.** Spec §8 mandates pixel-for-pixel match with `design/v4/pulse-coffee-v4.html`. `DrinkArt` uses the verbatim hex codes (e.g. matcha green `#6B8E3D` on every matcha drink's top layer; cappuccino body gradient `#F5DDC4 → #D4A574 → #6B3A1E → #4A2611`). Don't invent colors — copy from the HTML.
- **Glass shape is `UnevenRoundedRectangle`.** HTML `border-radius: 6 6 26 26` (flat top, deeply rounded bottom). Scaled to render size so curvature reads the same at any zoom.
- **Classic drinks are gradient bodies, not cup icons.** The first iOS pass used `Image(systemName: "cup.and.saucer.fill")` tinted — wrong. The HTML fills the glass shape with a vertical gradient that represents the liquid (espresso shot → milk → foam). No cup outline.
- **Status dot is hardcoded, with explicit TODO.** Backend `LocationHours` + `LocationSettings` already model what's needed; the hand-off is documented in `docs/superpowers/todos/2026-05-28-store-status-backend.md` so the swap is mechanical when the API lands.
- **Smart add via `MenuListRow.canInstantAdd(_:)`.** Pure boolean (`item.modifierGroups.contains(where: { $0.required })` inverted). Lives on `MenuListRow` because that's where the button it gates renders; `MenuView.handleAdd(_:)` calls it from a shared dispatch.
- **`Color(hex: UInt32)` extension** lives at the bottom of `DrinkArt.swift`. If a second file needs it later, move to `Core/AppTheme.swift`. Keeping it local for now keeps the design hex codes adjacent to the helper that decodes them.

## Follow-ups

- **Store-status backend hand-off** — see TODO file. Replaces the hardcoded `StoreStatus.swift` with a server-computed `PublicLocation.status` field.
- **Modifier picker (concern D)** — replaces the "ships in a later release" placeholder in `ItemDetailView`.
- **`accentWarm` already on `AppTheme`** — added during the topbar work. Closes the v4-nav fast-follow.
- **Stale-data resilience.** `MenuViewModel` re-fetches on `.refreshable`; long-term we may want to poll the menu every few minutes to pick up sold-out flips, hours changes, and status transitions without a manual pull.
- **Sticky topbar.** Currently the topbar scrolls with content. If the founder wants it pinned, switch the layout to `safeAreaInset(edge: .top)`.
