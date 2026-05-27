# Pulse Coffee — Home UI, v1

A self-contained SwiftUI design exploration for the signed-in **Home** screen.
Light & airy, matcha-forward, NYC specialty café. The signature device is the
**3-layer iced strawberry matcha** — ⅓ strawberry (red) · ⅓ milk (white) ·
⅓ matcha (green) — used as the logo mark *and* the hero visual.

> This is a **design artifact**, not production code. No networking, no
> checkout logic (Golden Rule #2 — checkout is sacred). All prices are integer
> cents, formatted for display only (Golden Rules #7 / #8). When a screen
> graduates, its real version is rebuilt inside `apps/ios/PulseCoffeeApp`
> against the real models, view models, and `CartManager`.

## Files

| File | Purpose |
|---|---|
| `PulseDesignSystem.swift` | Palette (`P`), `money()` formatter, `Color(hex:)`, `softShadow()`, the signature `LayeredCup` + `GlassShape` + `LayerStyle` presets (every drink is a 3-layer pour), `TricolorMark` logo, `ProductOrb`, `PulseTabBar`, `PulseCartBar`. The single source of truth for the look. |
| `PulseHomeView.swift` | The Home screen: header · greeting · **Your usual** one-tap reorder · categories · the 3-layer signature story · popular grid · fresh Georgian bakes · rewards · floating cart. |
| `PulseMenuView.swift` | The Menu screen: every drink as its own layered cup, the "3 layers" swatch on each card, a shimmering **This week's layer** featured drop, collection chips, and a satisfying add-to-cart (cup springs · + flips to ✓ · cart total bumps). |
| `PulseRootView.swift` | Tab shell. Home + Menu are designed; other tabs show a tidy placeholder. |
| `.preview/PulseDesignApp.swift` | `@main` entry so v1 can run standalone in the Simulator. |

`LayerStyle` presets so far: `strawberryMatcha`, `brownSugarMatcha`, `gingerHoney`, `raspberryMatcha`, `blueberryMatcha`, `mangoMatcha`, `ubeMatcha`, `classicMatcha`. Add a new drink color story by adding one preset — the glass, ice, gloss, and straw all come for free.

## Home screen, top → bottom

1. **Header** — tricolor mark + `PULSE` wordmark, location pill, points, avatar.
2. **Greeting** — time-aware, personal (`Good morning, Maya`).
3. **Your usual** — the fast path: one-tap **Reorder** of the customer's regular
   drink, with the layered cup, options summary, price, and an ETA. Topped with
   the strawberry/milk/matcha stripe so the brand reads instantly.
4. **Categories** — Matcha · Iced · Coffee · Bakes · Sweets.
5. **The original** — the 3-layer story card with the big `LayeredCup` and the
   33 / 33 / 33 ratio dots: how we got famous.
6. **Popular now** — brand items (strawberry matcha #1, matcha latte, khachapuri,
   dill & cheese kutab).
7. **Fresh from the oven** — Georgian pastries with the dill accent.
8. **Rewards** — progress to a free matcha.
9. **Floating cart** + bottom tab bar.

## Render it in Xcode

**Canvas preview (fastest):** open any of the three `.swift` files in
`apps/ios/PulseCoffeeApp` (or any iOS target) with these files added, and use
the `#Preview` at the bottom of `PulseHomeView.swift` / `PulseRootView.swift`.

**Run in the Simulator (standalone):**
1. New Xcode project → **iOS App**, SwiftUI, name it `PulseDesign`.
2. Delete its generated `ContentView.swift` and `*App.swift`.
3. Drag in `PulseDesignSystem.swift`, `PulseHomeView.swift`, `PulseRootView.swift`,
   and `.preview/PulseDesignApp.swift` (check *Copy items if needed*).
4. Run on any iPhone simulator.

> Note: include **only one** `@main`. If you reuse the production app target,
> drop `.preview/PulseDesignApp.swift` and point the existing entry at
> `PulseRootView()`.

## Notes & open questions for the founder

- **Data is placeholder.** Item names and prices (e.g. Strawberry Matcha
  `$7.50`, Adjarian Khachapuri `$11.00`) are believable NYC guesses — send me the
  real menu + prices and I'll swap them in.
- **Customer name** is hard-coded to `Maya`; in-app it comes from the profile.
- **"Your usual"** assumes we can derive a most-frequent order server-side. If
  that data isn't available yet, the card can fall back to "Start an order."
- Next tabs to design: **Menu**, **Orders**, **Account**.
