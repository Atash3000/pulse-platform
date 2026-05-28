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
| `PulseHomeView.swift` | The Home screen: header (Beans ring) · greeting · **Your usual** reorder hero (qty stepper + one-tap reorder) · type categories · the 3-layer signature story · popular grid · Georgian bakes · Beans rewards · floating cart. |
| `PulseMenuView.swift` | The Menu screen: every drink as its own layered cup (3 color swatches per card), a shimmering **This week's layer** featured drop, **type** chips, and a satisfying add-to-cart (cup springs · + flips to ✓ · total bumps · haptic). |
| `PulseRootView.swift` | Tab shell. Home + Menu are designed; other tabs show a tidy placeholder. |
| `.preview/PulseDesignApp.swift` | `@main` entry so v1 can run standalone in the Simulator. |
| `project.yml` | xcodegen spec → generates `PulseDesign.xcodeproj` (git-ignored, regenerable). |

`LayerStyle` presets: `strawberryMatcha`, `brownSugarMatcha`, `gingerHoney`, `raspberryMatcha`, `blueberryMatcha`, `mangoMatcha`, `ubeMatcha`, `classicMatcha`, `brownSugarLatte`, `vanillaLatte`, `lavenderHoney`. Add a new drink color story by adding one preset — the glass, ice, gloss, and straw all come for free.

## Home screen, top → bottom

1. **Header** — tricolor mark + `PULSE` wordmark, location pill, **Beans** ring
   (loyalty balance + progress to the next free matcha), avatar.
2. **Greeting** — time-aware, personal (`Good afternoon, Maya`).
3. **Your usual** — the hero / one iconic interaction: the layered cup, an ETA
   pill, a **quantity stepper**, and a one-tap **Reorder** (price tracks qty,
   flips to ✓ with a success haptic). Topped with the strawberry/milk/matcha
   stripe so the brand reads instantly.
4. **Categories** — one taxonomy by **type**: Matcha · Coffee · Bakery · Seasonal
   (matches the Menu tab).
5. **The original** — the 3-layer story card with the big `LayeredCup` and the
   33 / 33 / 33 ratio dots: how we got famous.
6. **Popular now** — brand items (strawberry matcha #1, matcha latte, khachapuri,
   dill & cheese kutab).
7. **Fresh from the oven** — Georgian pastries with the dill accent.
8. **Rewards** — progress to a free matcha.
9. **Floating cart** + bottom tab bar.

## Render it in Xcode

**Easiest — generate + open the project (needs `brew install xcodegen`):**
```bash
cd design/v1
xcodegen generate          # creates PulseDesign.xcodeproj from project.yml
open PulseDesign.xcodeproj  # then pick a simulator and press ⌘R
```
For a live design canvas, open `PulseHomeView.swift` and press **⌥⌘↩**; the
`#Preview` at the bottom renders and updates as you edit.

**Manual (no xcodegen):** new Xcode iOS App project, delete its generated
`ContentView.swift` + `*App.swift`, drag in the four `.swift` files plus
`.preview/PulseDesignApp.swift` (*Copy items if needed*), run.

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
