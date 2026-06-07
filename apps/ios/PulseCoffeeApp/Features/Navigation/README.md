# Navigation

Bottom tab bar that's shown after a customer signs in. Patterned after Luckin Coffee's five-tab layout (Home / Menu / Orders / Rewards / Account).

> **⚠️ Changing (spec 2026-06-06):** `Account` is being removed from the bottom bar (→ **4 tabs**: Home · Menu · Orders · Rewards) and moved to a **top-right avatar on the Home screen** — first-name initial when signed in, person glyph when guest — that opens `AccountView` as a bottom sheet. The 5-tab description below reflects the *current* code and will be updated when that lands. See `docs/superpowers/specs/2026-06-06-account-avatar-home-design.md` and the 2026-06-06 decision-log entry.

```
ContentView                       ← root auth gate
└── MainTabView                   ← this folder — shown when logged in
    ├── HomeView          (Home)      placeholder
    ├── MenuView          (Menu)      real screen — see Features/Menu/
    ├── OrdersView        (Orders)    placeholder
    ├── RewardsView       (Rewards)   placeholder
    └── AccountView       (Account)   placeholder
```

## Files

| File | Purpose |
|---|---|
| `MainTab.swift` | Typed enum (`home`, `menu`, `orders`, `rewards`, `account`) with title + SF Symbols. One source of truth for the tab bar, deep-links, and analytics. |
| `MainTabView.swift` | The signed-in tab host plus custom bottom bar. Menu is the launch tab. |
| `Placeholders.swift` | `HomeView`, `OrdersView`, `AccountView` — minimal stubs (title + icon + caption). Promote to their own files when real content lands. |

## Design choices

- **Each tab owns its own `NavigationStack`.** `MenuView` already has its own stack, and the placeholders wrap themselves so they're ready for content.
- **`MainTab` rawValues are stable.** They're consumed as analytics property values and (eventually) by the deep-link router. `MainTabTests.test_rawValues_areStableForAnalytics` exists to make accidental renames loud at review time.
- **`@State` selection, not `@AppStorage`.** Sign-out tears down the entire tab tree, so persisting selection across sign-outs would surprise users who expect a fresh slate. Re-evaluate if we add a "stay logged in across launches" UX requirement.
- **Menu is the launch tab.** It's the only tab with real content in MVP-3, and the customer's job-to-be-done at launch is "order a coffee."
- **Selected tabs use the Pulse nav palette.** The custom bottom bar uses accessible gold active icons (`#B8831E`), dark espresso active labels (`#1A1208`), warm taupe inactive icons/labels (`#7A664B`), and a warm cream bar background (`#FBF7F0` at 92%). It intentionally avoids the old iOS-blue selected treatment and draws no per-tab selected background.
- **Icons are template-rendered Pulse nav marks.** Home, Menu, and Orders use two SVG layers each: a base layer (`PulseHomeMark`, `PulseMenuMark`, `PulseOrdersMark`) and a matcha accent layer (`PulseHomeLeafAccent`, `PulseMenuAccent`, `PulseOrdersAccent`). Account uses the single-layer `PulseAccountMark`. Base layers follow active gold / inactive taupe, while accent layers use `AppTheme.Colors.tabIconMatchaAccent` only when selected and taupe when inactive.
- **Template icon style rules.** New template-rendered tab SVGs should keep the same optical weight, rounded corner logic, 1.7pt stroke family for the flat nav set, rounded line caps/joins, visual density, and active/inactive color behavior. Icon colors must clear 3:1 contrast against the cream tab bar; text labels must clear 4.5:1.
- **v4 icon set.** Menu uses the SF Symbol `list.bullet` (selected `list.bullet.rectangle.fill`) — the cup-style `PulseMenuMark` / `PulseMenuAccent` SVGs remain in the Asset Catalog but are no longer wired from `MainTab.layeredAssetNames`. They can be re-attached without re-importing the SVG if product wants the cup back. Rewards uses `medal` / `medal.fill` — no Pulse-branded asset commissioned yet; revisit if design wants a custom mark.
- **Tab badge contract.** `PulseTabBar` takes `badge: (MainTab) -> Int`, defaulted to `{ _ in 0 }`. `MainTab.shouldShowBadge(count:)` hides the badge at zero and for negative counts; `MainTab.badgeText(count:)` caps the displayed value at `99+`. Style mirrors the cart-count badge in `MenuView` (small destructive-tint capsule, white text). Count source for Orders is a TODO in `MainTabView` until `OrdersService` lands.

## Tests

`apps/ios/PulseCoffeeAppTests/MainTabTests.swift`:

- Enum order, title/symbol presence, selected ≠ unselected symbols.
- Raw values pinned for analytics stability.

SwiftUI view rendering itself is not unit-tested (would require a snapshot harness — out of scope for this commit). The `#Preview` blocks in each Swift file are the manual-verification surface.

## Build sequence

| Tab | Status | Next step |
|---|---|---|
| Home | placeholder | Featured drinks + nearest-location card |
| Menu | shipped (MVP-2 + MVP-3) | Left-sidebar category picker (Luckin-style) |
| Orders | placeholder | Order-status polling list (MVP-4) |
| Rewards | placeholder | Loyalty progress + reward history (depends on loyalty backend) |
| Account | **guest: `WelcomeView` cold-open / join surface; logged-in: placeholder + Sign Out button** | Real profile screen (payment methods, order history, edit profile) — sign-out moved here when the v4 Menu topbar dropped the old leading toolbar item |

## Auth-state routing

`ContentView` now opens `MainTabView` for **both** logged-in and logged-out users — the difference is the initial tab.

| Auth state | `initialTab` | Account-tab content |
|---|---|---|
| `.loggedOut` | `.account` | `WelcomeView` (Features/Auth/WelcomeView.swift). Sheets present `LoginView` / `RegisterView`. |
| `.loggedIn` | `.menu` | Existing placeholder, until the real profile screen lands. |

`AccountView` reads `AppState.authState` directly and branches between `WelcomeView` and the placeholder, so the Account tab shows the right content in either tree.

Note that auth changes do trigger a full re-render: `ContentView`'s `switch` re-instantiates `MainTabView` with the new `initialTab` when `authState` flips, tearing down the old tab tree. A guest who signs in therefore lands on **Menu** (the new tree's `initialTab`), not back on the Account tab — and that teardown is what clears the in-memory cart / view-model state on logout. The `AccountView` branch is still needed because `AccountView` is mounted in both trees and must render the correct content in each; it is not the mechanism that swaps content "in place."

## Follow-ups

- **Guest-gate the non-Account tabs.** With `ContentView` now letting logged-out users into `MainTabView`, the Menu tab works (public endpoint), but Cart / checkout / Orders / Home aren't yet aware of guest state. Next commits should: (a) replace the Cart's "Checkout" button with a "Sign in to checkout" CTA when guest, (b) show a "Sign in to see your orders" empty state in `OrdersView`, (c) hide or stub the streak / rewards strips on the Home tab when guest. Each is one focused commit per §1.6.
- **Real Welcome hero asset.** `WelcomeView` currently uses 🍵 + a gradient. Replace with `WelcomeHero.imageset` (real photo) when brand supplies one.
- **Fraunces + DM Sans fonts.** Welcome and Home-v3 both want custom typography. Bundle the font files, register in `project.yml`, swap `.system(.serif)` call-sites in a single typography commit.
- **Loyalty copy on Welcome screen is hardcoded.** The "50 beats welcome gift", "10 beats ≈ $1", and "free birthday drink" promises in `WelcomeView` are unmocked stubs awaiting the backend loyalty module — see decision-log entry "[iOS] WelcomeView ships hardcoded loyalty marketing copy" for the override of the 2026-05-14 loyalty-placeholder decision and the swap-when-backend-lands TODOs.
- ~~**Move "Sign Out" off the Menu toolbar onto Account.**~~ Done — `AccountView` (`Placeholders.swift`) now hosts the `Sign Out` button under its logged-in placeholder. The Menu toolbar dropped the leading sign-out icon when the v4 topbar landed. Will be replaced by a richer profile screen later.
- **Cart icon placement.** The cart button currently lives in the v4 Menu topbar (right side, where the HTML `nav-profile` chip sits). The HTML mockup uses an avatar there; iOS keeps the cart because it's a critical commerce affordance and the profile chip is on the Account tab. Once a richer customer-profile UI ships, revisit whether the cart belongs tab-bar-adjacent (Luckin floats a checkout bar above the tab bar).
- **Lazy tab mounting before real Home / Orders / Rewards / Account data work.** `MainTabView` keeps all five tab roots alive and hides inactive tabs with opacity so the custom bar can own selection. That is fine while only Menu does real work, but before other tabs add API fetches or polling we should lazy-mount inactive tabs or gate their `.task` bodies on the selected tab.
- **Order-status icon treatment.** The old Orders cup-status overlay was removed when product supplied the final flat Orders nav icon. Once MVP-4 order polling lands, add a badge or a separate status affordance rather than changing the base nav icon without a design pass.
- **Repeat-tap native tab behavior.** Native `TabView` can pop the selected tab to root or scroll a list to top when the already-selected tab is tapped. The custom bar intentionally defers this until Home / Orders / Account have deeper navigation stacks.
- **Native tab-bar accessibility semantics.** The custom bar marks the selected item with `.isSelected`, but it still behaves like a row of buttons rather than a system `TabView` tab-bar container. Revisit if accessibility QA requires exact native tab semantics.
- **Snapshot coverage for the custom bar.** The current XCTest coverage pins `MainTab` data and asset wiring. A later visual-regression harness should snapshot the bottom bar at regular and accessibility Dynamic Type sizes.
- **Selected background treatment.** The custom bar intentionally has no selected circle/pill because product asked to remove selected background shapes. If product wants a Luckin-style selected icon circle later, implement it inside `PulseTabBar` now that the custom bar exists.
- **Third-party illustrated icon set (Phosphor / Lucide / Iconoir).** SF Symbols are the right default; if product wants the Luckin-style illustrated look, add one SPM package (Phosphor is the strongest candidate — MIT, ~1500 icons, official Swift package). Adds a dependency, so it goes through the same review bar as any other SPM addition.
