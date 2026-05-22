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
- **Selected tabs tint blue.** The custom bottom bar uses `AppTheme.Colors.accent` for selected tab labels/icons and draws no per-tab selected background, avoiding the iOS 18+ system selected-pill treatment. The bar is full-width and bottom-anchored like a native app tab strip rather than a floating capsule.
- **Icons are SF Symbols plus the Pulse menu mark.** Home / Orders / Account use SF Symbols (`house`, `bag`, `person.crop.circle`). Menu uses the Pulse `P` cup SVG from `Assets.xcassets/PulseCupMark.imageset`, stored as a 24x24 SVG with a cropped viewBox so the visible logo fills the custom tab icon slot instead of shrinking inside the original app-icon canvas. A third-party illustrated set (Phosphor, Lucide, Iconoir — all MIT-licensed) is a follow-up if/when product wants a broader custom icon set. See `docs/decision-log.md` entry "[iOS] SF Symbols over third-party icon library for tab bar" for the full reasoning.

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
- **Repeat-tap native tab behavior.** Native `TabView` can pop the selected tab to root or scroll a list to top when the already-selected tab is tapped. The custom bar intentionally defers this until Home / Orders / Account have deeper navigation stacks.
- **Native tab-bar accessibility semantics.** The custom bar marks the selected item with `.isSelected`, but it still behaves like a row of buttons rather than a system `TabView` tab-bar container. Revisit if accessibility QA requires exact native tab semantics.
- **Snapshot coverage for the custom bar.** The current XCTest coverage pins `MainTab` data and asset wiring. A later visual-regression harness should snapshot the bottom bar at regular and accessibility Dynamic Type sizes.
- **Selected background treatment.** The custom bar intentionally has no selected circle/pill because product asked to remove selected background shapes. If product wants a Luckin-style selected icon circle later, implement it inside `PulseTabBar` now that the custom bar exists.
- **Third-party illustrated icon set (Phosphor / Lucide / Iconoir).** SF Symbols are the right default; if product wants the Luckin-style illustrated look, add one SPM package (Phosphor is the strongest candidate — MIT, ~1500 icons, official Swift package). Adds a dependency, so it goes through the same review bar as any other SPM addition.
