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
| `MainTabView.swift` | The `TabView` itself. Hosts a tab item per `MainTab` case. Menu is the launch tab. |
| `Placeholders.swift` | `HomeView`, `OrdersView`, `AccountView` — minimal stubs (title + icon + caption). Promote to their own files when real content lands. |

## Design choices

- **Each tab owns its own `NavigationStack`.** Standard iOS pattern — switching tabs preserves each tab's back-stack independently. `MenuView` already has its own stack, so the Menu tab inherits that; the placeholders wrap themselves so they're ready for content.
- **`MainTab` rawValues are stable.** They're consumed as analytics property values and (eventually) by the deep-link router. `MainTabTests.test_rawValues_areStableForAnalytics` exists to make accidental renames loud at review time.
- **`@State` selection, not `@AppStorage`.** Sign-out tears down the entire tab tree, so persisting selection across sign-outs would surprise users who expect a fresh slate. Re-evaluate if we add a "stay logged in across launches" UX requirement.
- **Menu is the launch tab.** It's the only tab with real content in MVP-3, and the customer's job-to-be-done at launch is "order a coffee."
- **Selected tabs tint blue.** `.tint(.blue)` on the `TabView` makes the active tab's icon and label render blue — matches Luckin's selected-state accent. System `TabView` applies the tint to whichever tab is active, not per-tab, so all selected tabs share the blue accent. A fully custom "blue circle behind icon" treatment (exact Luckin look) would require a hand-rolled tab bar — see Follow-ups.
- **Icons are SF Symbols (Apple's icon library).** Built into iOS 16+, ~5,000 icons, no third-party SPM dependency, automatically themed for dynamic type / accessibility / dark mode. The four chosen symbols (`house.fill`, `takeoutbag.and.cup.and.straw.fill`, `list.bullet.clipboard.fill`, `star.circle.fill`) are deliberately picked to read as *premium dopamine* rather than generic system app: takeaway-cup-with-straw signals modern coffee culture (not generic mug), clipboard signals receipt + order progress (not grocery bag), star signals rewards/loyalty (not bland profile). A third-party illustrated set (Phosphor, Lucide, Iconoir — all MIT-licensed) remains a follow-up if/when product wants a fully custom illustrated look. See `docs/decision-log.md` entry "[iOS] SF Symbols over third-party icon library for tab bar" for the full reasoning.

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
- **Fully custom tab bar for the Luckin "blue circle behind icon" look.** Today we use the system `TabView` with `.tint(.blue)`, which makes the selected tab's icon + label blue but does not draw a circle behind the icon. Replicating that visual exactly requires a hand-rolled `HStack`-based tab bar that overlays a `Circle().fill(.blue)` behind the selected item. Larger surface area (selection state, layout math, safe-area handling, accessibility traits) — defer until product signs off on the visual treatment.
- **Third-party illustrated icon set (Phosphor / Lucide / Iconoir).** SF Symbols are the right default; if product wants the Luckin-style illustrated look, add one SPM package (Phosphor is the strongest candidate — MIT, ~1500 icons, official Swift package). Adds a dependency, so it goes through the same review bar as any other SPM addition.
