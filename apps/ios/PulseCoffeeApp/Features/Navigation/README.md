# Navigation

Bottom tab bar that's shown after a customer signs in. Patterned after Luckin Coffee's four-tab layout (Home / Menu / Orders / Account).

```
ContentView                       ← root auth gate
└── MainTabView                   ← this folder — shown when logged in
    ├── HomeView          (Home)      placeholder
    ├── MenuView          (Menu)      real screen — see Features/Menu/
    ├── OrdersView        (Orders)    placeholder
    └── AccountView       (Account)   placeholder
```

## Files

| File | Purpose |
|---|---|
| `MainTab.swift` | Typed enum (`home`, `menu`, `orders`, `account`) with title + SF Symbols. One source of truth for the tab bar, deep-links, and analytics. |
| `MainTabView.swift` | The signed-in tab host plus custom bottom bar. Menu is the launch tab. |
| `Placeholders.swift` | `HomeView`, `OrdersView`, `AccountView` — minimal stubs (title + icon + caption). Promote to their own files when real content lands. |

## Design choices

- **Each tab owns its own `NavigationStack`.** `MenuView` already has its own stack, and the placeholders wrap themselves so they're ready for content.
- **`MainTab` rawValues are stable.** They're consumed as analytics property values and (eventually) by the deep-link router. `MainTabTests.test_rawValues_areStableForAnalytics` exists to make accidental renames loud at review time.
- **`@State` selection, not `@AppStorage`.** Sign-out tears down the entire tab tree, so persisting selection across sign-outs would surprise users who expect a fresh slate. Re-evaluate if we add a "stay logged in across launches" UX requirement.
- **Menu is the launch tab.** It's the only tab with real content in MVP-3, and the customer's job-to-be-done at launch is "order a coffee."
- **Selected tabs use the Pulse nav palette.** The custom bottom bar uses gold active icons (`#C8973A`), dark espresso active labels (`#1A1208`), warm taupe inactive icons/labels (`#A88C72`), and a warm cream bar background (`#FBF7F0` at 92%). It intentionally avoids the old iOS-blue selected treatment and draws no per-tab selected background.
- **Icons are template-rendered Pulse nav marks.** Home, Menu, and Orders use two SVG layers each: a base layer (`PulseHomeMark`, `PulseMenuMark`, `PulseOrdersMark`) and a matcha accent layer (`PulseHomeLeafAccent`, `PulseMenuAccent`, `PulseOrdersAccent`). Account uses the single-layer `PulseAccountMark`. Base layers follow active gold / inactive taupe, while accent layers use `AppTheme.Colors.tabIconMatchaAccent` only when selected and taupe when inactive.
- **Template icon style rules.** New template-rendered tab SVGs should keep the same optical weight, rounded corner logic, 1.7pt stroke family for the flat nav set, rounded line caps/joins, visual density, and active/inactive color behavior.

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
| Account | placeholder | Profile + sign-out (currently sign-out lives in `MenuView` toolbar — moves here when real content lands) |

## Follow-ups

- **Move "Sign Out" off the Menu toolbar onto Account.** The toolbar button in `Features/Menu/MenuView.swift` is left untouched for now to keep this commit scope-clean; it should be deleted once the Account tab gains real content. Tracking as a separate commit.
- **Cart icon placement.** The cart button currently lives in `MenuView`'s toolbar. Once Orders/Account gain content the bag may want to be tab-bar-adjacent (Luckin floats a checkout bar above the tab bar). Defer until the cart UX is revisited.
- **Lazy tab mounting before real Home / Orders / Account data work.** `MainTabView` keeps all four tab roots alive and hides inactive tabs with opacity so the custom bar can own selection. That is fine while only Menu does real work, but before other tabs add API fetches or polling we should lazy-mount inactive tabs or gate their `.task` bodies on the selected tab.
- **Order-status icon treatment.** The old Orders cup-status overlay was removed when product supplied the final flat Orders nav icon. Once MVP-4 order polling lands, add a badge or a separate status affordance rather than changing the base nav icon without a design pass.
- **Repeat-tap native tab behavior.** Native `TabView` can pop the selected tab to root or scroll a list to top when the already-selected tab is tapped. The custom bar intentionally defers this until Home / Orders / Account have deeper navigation stacks.
- **Native tab-bar accessibility semantics.** The custom bar marks the selected item with `.isSelected`, but it still behaves like a row of buttons rather than a system `TabView` tab-bar container. Revisit if accessibility QA requires exact native tab semantics.
- **Snapshot coverage for the custom bar.** The current XCTest coverage pins `MainTab` data and asset wiring. A later visual-regression harness should snapshot the bottom bar at regular and accessibility Dynamic Type sizes.
- **Selected background treatment.** The custom bar intentionally has no selected circle/pill because product asked to remove selected background shapes. If product wants a Luckin-style selected icon circle later, implement it inside `PulseTabBar` now that the custom bar exists.
- **Third-party illustrated icon set (Phosphor / Lucide / Iconoir).** SF Symbols are the right default; if product wants the Luckin-style illustrated look, add one SPM package (Phosphor is the strongest candidate — MIT, ~1500 icons, official Swift package). Adds a dependency, so it goes through the same review bar as any other SPM addition.
