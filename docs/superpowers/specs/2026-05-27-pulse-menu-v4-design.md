# Pulse Coffee — v4 Menu, Modifier Picker & Bottom Nav

- **Date:** 2026-05-27
- **Status:** Approved design — ready for implementation planning
- **Design source:** `design/v4/pulse-coffee-v4.html` + `design/v4/README.md`
- **Surfaces:** `apps/api` (menu module + seed), `apps/ios` (Menu, Navigation, item detail)

---

## 1. Goal

Bring the iOS app in line with the v4 design, starting with the **Menu tab** and
the **bottom navigation bar**. Along the way, make item customisation actually
work end-to-end (size, milk, add-shots, sweetness), because the v4 menu routes
every "Add" through the item detail screen.

The v4 design philosophy (`design/v4/README.md`) is the north star: calm, fast,
80% familiar / 20% new, abstract symbolic drink visuals for small surfaces, serif
used sparingly for emotional moments. Speed of ordering beats spectacle.

## 2. Decisions made during brainstorming

| Decision | Choice | Rationale |
|---|---|---|
| How to bridge the design↔API data gap | **Full-stack** — add backend fields, iOS renders them | Keeps Golden Rule #8 intact: the server owns temperature / hero / style, iOS only displays |
| What "+" / "Add" does | **Smart add** — instant add when the item has **no required** modifiers; opens detail when it does | Food (croissant, muffin, cookie) and any modifier-free item add in one tap (speed); drinks needing Size/Milk open the picker so required choices are always made |
| Drink visuals | **Native SwiftUI abstract symbols** | Matches the design's "abstract symbols for small surfaces"; no photo pipeline needed |
| Rewards (5th) tab | **Placeholder now** | Nav matches v4 today; real loyalty deferred until the loyalty backend exists |
| Modifier picker UI | **Build now (4th concern)** | "Add opens detail" only works if detail can take size/milk/shot/sweetness choices |
| Price shown while picking modifiers | **Live total, client-side sum (display estimate)** | Base + selected modifier deltas (both already in the menu payload); Stripe checkout stays the single source of truth — see §7 decision-log note |

## 3. Scope — four concerns, four PRs

One commit / one concern (CLAUDE.md §1.6). One spec for contract coherence.

| # | Concern | Branch | Depends on |
|---|---|---|---|
| A | Backend: menu presentation fields + migration + realistic reseed | `feat/api/menu-presentation-fields` | — |
| B | iOS: v4 Menu screen redesign | `feat/ios/menu-v4-redesign` | A (API contract + seed) |
| C | iOS: 5-tab bar + Rewards placeholder | `feat/ios/bottom-nav-v4` | — (independent) |
| D | iOS: item modifier picker + live total + cart wiring | `feat/ios/item-modifier-picker` | A (modifier seed) |

Build order: **A first** (B and D consume its contract/seed); **C** can run in parallel anytime.

### Out of scope (explicit)

- Menu disk cache / instant-load (Golden Rule #1) — stays a follow-up, as today (`MenuViewModel.swift` already notes this).
- Loyalty backend + real Rewards screen.
- Checkout / payment / order-state / money-math changes — untouched.
- Per-modifier quantity (e.g. "3 extra shots") — a modifier is toggled on/off; multiples are out of scope this round.
- Real product photography pipeline.

---

## 4. Concern A — Backend menu presentation fields

### 4.1 New columns

**`menu_items`**

| Column | Type | Null | Default | Purpose |
|---|---|---|---|---|
| `temperature` | enum `'hot' \| 'iced' \| 'both'` | no | `'both'` | Drives the toggle filter + per-item pill |
| `featured` | boolean | no | `false` | The "★ Hero" pick inside a spotlight category |
| `art_token` | varchar | yes | `null` | Opaque key iOS maps to a drawn symbol (e.g. `strawberry-matcha`, `cappuccino`, `croissant`). Unknown / null → iOS neutral fallback |

**`menu_categories`**

| Column | Type | Null | Default | Purpose |
|---|---|---|---|---|
| `display_style` | enum `'spotlight' \| 'list'` | no | `'list'` | `spotlight` = hero card + horizontal scroll; `list` = vertical rows |

All defaults are **fail-safe** (Golden Rule #17): a row with no presentation data renders as a plain list item, never breaks the menu.

### 4.2 Migration

- TypeORM migration adds the four columns with the defaults above.
- **Backfill** existing seed: Matcha category → `display_style = 'spotlight'`; set per-item `temperature`; mark one matcha item `featured = true`; assign `art_token`s. Everything else takes the safe defaults.
- Migration has a working `down()` (drops the columns).

### 4.3 API contract

Extend in `apps/api/src/modules/menu/menu.service.ts`:

- `PublicMenuItem` gains `temperature`, `featured`, `art_token`.
- `PublicCategory` gains `display_style`.

iOS `Menu.swift` mirrors these (snake_case `CodingKeys`):

- `MenuItem`: `temperature: Temperature`, `featured: Bool`, `artToken: String?`
- `MenuCategory`: `displayStyle: CategoryDisplayStyle`
- New Swift enums `Temperature { hot, iced, both }` and `CategoryDisplayStyle { spotlight, list }`, both decoding **unknown values to a safe default** (`both` / `list`).

### 4.4 Reseed — realistic catalog

Reseed the dev catalog. **All prices integer cents (Golden Rule #7); values below are illustrative seed defaults the founder can tune.**

**Matcha line** — category `display_style: spotlight`, all `temperature: iced`:

| Item | Price | Featured | art_token |
|---|---|---|---|
| Strawberry Matcha | 645 | ✅ (hero) | `strawberry-matcha` |
| Raspberry Matcha | 645 | | `raspberry-matcha` |
| Brown Sugar Matcha | 675 | | `brown-sugar-matcha` |
| Ginger Matcha | 675 | | `ginger-matcha` |

**Classic coffee** — category `display_style: list`:

| Item | Price | Temperature | Size rule | art_token |
|---|---|---|---|---|
| Cappuccino | 525 | both | 12 / 16 oz | `cappuccino` |
| Latte | 550 | both | 12 / 16 oz | `latte` |
| Americano | 450 | both | 12 / 16 oz | `americano` |
| Flat White | 525 | hot | **8 oz fixed** (no size group) | `flat-white` |
| Cortado | 475 | hot | **8 oz fixed** (no size group) | `cortado` |
| Cold Brew | 550 | iced | 12 / 16 oz | `cold-brew` |
| Espresso | 350 | hot | **4 oz fixed** (no size group) | `espresso` |

**Food** — category `display_style: list`, no modifiers:

| Item | Price | art_token |
|---|---|---|
| Butter Croissant | 450 | `croissant` |
| Mini Khachapuri | 800 | `khachapuri` |
| Blueberry Muffin | 375 | `muffin` |
| Chocolate Cookie | 325 | `cookie` |

### 4.5 Modifier seed (uses the existing `modifier_groups` / `modifiers` model — no schema change)

The existing model already supports `required`, `multi_select`, `sort_order`, and per-modifier `price_cents` deltas. We only seed data.

| Group | Type | Applies to | Options (delta cents) |
|---|---|---|---|
| **Size** | required, single-select | standard drinks only | 12 oz (0, default) · 16 oz (+60) |
| **Milk** | required, single-select | milk drinks (matcha, cappuccino, latte, flat white, cortado) | Whole (0, default) · 2% (0) · Skim (0) · Half & Half (0) · Oat (+75) · Almond (+75) · Coconut (+75) · Soy (+75) |
| **Extras** | optional, multi-select | drinks | Add espresso shot (+100) · Add matcha shot (+100, matcha only) |
| **Sweetness** | optional, single-select | drinks | Regular (0, default) · Half (0) · Unsweetened (0) |

Conventions:
- Americano, Cold Brew, Espresso are **black** → no Milk group.
- A required single-select group's **default = the option with the lowest `sort_order`** (seed Whole / 12 oz / Regular first). iOS pre-selects this.
- Sizes encoded as a modifier group keeps "iOS never calculates price" intact — the delta lives on the server.

---

## 5. Concern B — iOS v4 Menu screen

Rebuild `MenuView` as a `ScrollView` (the grouped `List` can't express the three section treatments).

### 5.1 Structure (top → bottom)

1. **Header** — "Menu" title + subtitle ("Matcha line · Classic coffee · Food"), profile chip (matches v4 topbar). The existing sign-out toolbar button stays put until Account gets real content (per Navigation README follow-up).
2. **Temperature toggle** — `All / Hot / Iced` pill segmented control.
3. **Sections**, ordered by `sort_order`:
   - `display_style == spotlight`: the `featured` item renders as a large **hero card** (eyebrow, serif name, description, price, "Add" → detail); remaining items render in a **horizontal-scroll row** of compact cards.
   - `display_style == list`: vertical rows — drink/food mini visual, name + temp pill + meta, price, `+` button.
4. **Tap behavior (smart add):**
   - Tapping a **card / row body** → always opens `ItemDetailView`.
   - Tapping **`+` / "Add"** → if the item has **no required modifier groups**, add to cart instantly with defaults (optional groups take their defaults: Sweetness = Regular, Extras = none) via `cart.add(item:)`, with a brief confirmation + haptic; otherwise open `ItemDetailView` so required choices (Size / Milk) are made.
   - With the seed catalog, instant-add applies to **all food** plus **Espresso** (4 oz fixed, black → no required groups). Every other drink has a required Size and/or Milk group → opens detail.

### 5.2 Temperature filter (pure, testable)

`MenuViewModel` gains `@Published selectedTemperature: TemperatureFilter` (`all / hot / iced`) and a derived filtered menu:

- `all` → every item.
- `hot` → items where `temperature ∈ { hot, both }`.
- `iced` → items where `temperature ∈ { iced, both }`.
- A section with zero matching items after filtering is **hidden**.
- Spotlight hero selection: the `featured` item among the filtered set; if the featured item is filtered out, fall back to the first remaining item; if a spotlight section has no items, hide it.

Filtering is a pure function over the loaded `Menu` → unit-tested without the view.

### 5.3 Fail-safe rendering (Golden Rule #17)

- Missing / unknown `display_style` → list rendering.
- Missing / unknown `temperature` → treated as `both` (shows under every filter).
- No `featured` item in a spotlight section → first item becomes hero.

### 5.4 New files

`MenuSectionView`, `SpotlightSection` (hero + scroll), `MenuListRow`, `TemperatureToggle`. `MenuView` orchestrates; existing loading / failed / empty states and pull-to-refresh are preserved.

---

## 6. Concern C — iOS bottom nav (5 tabs)

- `MainTab` enum gains **`.rewards`**, ordered `home, menu, orders, rewards, account`.
- v4 icon set: Menu → list-lines, Orders → bag **with order-count badge**, Rewards → star/award, Account → person. Reuse the existing `PulseTabBar` + layered-icon machinery and the established template-icon style rules (Navigation README).
- New `RewardsView` placeholder (icon + "Rewards coming soon"), wired like the other `Placeholders.swift` stubs.
- `MainTab` raw values stay stable for analytics; `MainTabTests` extends for the 5th tab + raw-value stability + selected ≠ unselected symbols.
- Orders badge: count source is the same in-memory state the placeholder uses today; the badge degrades to hidden when zero (fail-safe).

---

## 7. Concern D — iOS modifier picker

Replace the "Customisation … ships in a later release" placeholder in
`ItemDetailView` with a working picker.

### 7.1 Rendering rules per group

- **Required single-select** (Size, Milk) → radio / segmented selection; **pre-select the lowest-`sort_order` option** so a valid choice always exists.
- **Optional single-select** (Sweetness) → single-select with its default pre-selected.
- **Optional multi-select** (Extras) → toggles, none selected by default.
- Groups render in `sort_order`; modifiers within a group render in `sort_order`.

### 7.2 Live total (display estimate)

- Running total = `base_price_cents + Σ(selected modifier price_cents)`, formatted for display only.
- The "Add to Cart" button shows this total.
- This is an **estimate**; the Stripe-backed checkout remains the authoritative total (Golden Rule #3 / #8).

### 7.3 Cart wiring

- On Add: collect selected modifier IDs across all groups → `cart.add(item:modifierIds:)` (already supports this — `CartManager.swift:69`).
- Add is enabled only when every **required** group has a selection (guaranteed by defaults, but validated defensively).

### 7.4 Decision-log entry (required)

Add to `docs/decision-log.md`:

> **[iOS] Item detail shows a client-summed modifier estimate.** The detail
> screen sums base + selected modifier deltas (both from the menu payload) to
> show a running total. This is a display estimate only; the Stripe checkout /
> backend `PriceCalculation` remains the authoritative charge (Golden Rules #3,
> #8). Chosen over a per-keystroke backend price-preview endpoint to avoid a
> network round-trip on every toggle for an MVP-scale catalog.

---

## 8. Drink visual system (shared, native SwiftUI)

A `DrinkArt` SwiftUI component maps `art_token` → a drawn abstract symbol. **The HTML at `design/v4/pulse-coffee-v4.html` is the canonical source for colors and shape** — iOS reproduces it pixel-for-pixel using hex codes copied character-for-character, not stylised approximations. (First iOS pass got this wrong by inventing colors and substituting an SF Symbol cup silhouette for classics; corrected in the same PR after founder review.)

- **Glass shape (matcha + classic):** `border-radius: 6px 6px 26px 26px` — flat-ish top, deeply rounded bottom (tumbler / pint-glass silhouette). Implemented via `UnevenRoundedRectangle`. Aspect ratio ~60×110 (`matcha-hero-drink` in HTML).
- **matcha tokens** → three equal-height color layers (`.layer.top / .mid / .bot` at 33.33% each, HTML lines 175–183). Top layer is always matcha green `#6B8E3D`; middle is oat `#F5E6D3` (fruit-flavored matchas) or cream `#FDF6E8` (richer-flavored); bottom is the flavor accent. Exact hex per drink at HTML lines 185–199.
- **classic tokens** → same glass shape, filled with a vertical gradient body (`linear-gradient(180deg, …)` from HTML lines 211–216, 2–4 stops, top→bottom). **Not** an SF Symbol cup icon — the body itself is the visual.
- **food tokens** → square tile with a 135° diagonal gradient (`food-mini.*` at HTML lines 1122–1125) + a unicode glyph (🥐 🫓 🧁 🍪).
- **Glass background** behind the layers / gradient: `var(--bg-deep)` (`#EDE5D3`), so any future layer animation reveals a sensible color rather than transparent.
- A local `DrinkArtRegistry` `[token: DrinkArtSpec]` covers all 15 seeded tokens. **Unknown / nil token → neutral classic-glass fill `#8E7A5C` with `isFallback: true`** (Golden Rule #17). A test pins that every backend-seeded token is registered, so a future drink lands loud at review time.
- No network images, no SVG assets — all drawn in SwiftUI; scales crisply at every Dynamic Type size.

**Accent color for editorial labels** ("★ HERO", "FEATURED", warm call-outs): `var(--accent-warm)` = `#C2410C`. Lives on `AppTheme.Colors.accentWarm`.

---

## 9. v4 Menu topbar (added 2026-05-28 after founder review)

The first iOS pass used the system navigation bar (centered title + leading sign-out icon + trailing cart). The v4 HTML doesn't have a system nav bar at all — the topbar is part of the screen content. Aligned in this iteration:

- **System nav bar hidden** (`.toolbar(.hidden, for: .navigationBar)`); custom topbar is the first row of the Menu screen content.
- **LEFT side** (HTML `.logo-row`, lines 115–140):
  - 10pt **status dot** — see §10 for the status-dot contract.
  - **Location name** in bold 17pt (`-0.02em` tracking, `--ink` foreground `#1F1A14`). Source: `PublicLocation.name` from the API (e.g. "Pulse Coffee — Park Slope"). Fallback "Pulse Coffee" before the menu loads.
- **RIGHT side** (HTML `.nav-profile`, lines 152–161):
  - Cart icon with count badge (kept from prior iOS). HTML uses an avatar chip here; iOS keeps the cart because it's a critical commerce affordance and the profile chip lives on the Account tab.
- **Sign-out** — was a placeholder leading toolbar item on Menu; moved to the Account tab (per the Navigation README's existing follow-up). AccountView's logged-in placeholder gains a `Sign Out` button until the real profile screen lands.

---

## 10. Store status dot (hardcoded now, backend later)

The 10pt dot to the left of the location name encodes operational state with three colors:

- 🟢 **green** (`#4CAF50`) — store is open.
- 🟡 **amber** (`#F5A623`) — store closes within 60 min (e.g. closes 18:00; current time 17:01 → amber).
- 🔴 **red** (`AppTheme.Colors.destructive`) — store is closed.

HTML uses `var(--accent-warm)` for the dot with a `gentle-pulse` animation. iOS preserves the pulse animation (`.opacity` / `.scaleEffect` `repeatForever`) and extends the single brand-warm color to the three operational colors above.

**Current implementation: HARDCODED.** `currentStoreStatus(now:calendar:)` in `apps/ios/PulseCoffeeApp/Features/Menu/StoreStatus.swift` computes status from local wall-clock time against hardcoded 7:00–18:00 hours every day. The function carries an explicit TODO pointing at the planned backend hand-off:

→ **see `docs/superpowers/todos/2026-05-28-store-status-backend.md`** for the planned `PublicLocation.status` API field, the hours-aware service-side computation, timezone handling, and how this client function should be deleted (or reduced to a 5-minute fallback) once the backend ships.

---

## 11. Golden Rules compliance

| Rule | How this design complies |
|---|---|
| #1 Menu loads instantly | No regression; disk cache remains a tracked follow-up (out of scope) |
| #2 Checkout sacred / #3 webhook truth | Untouched; detail total is a labelled estimate, not the charge |
| #7 Integer cents | All seed prices + deltas in cents; `displayPrice` stays display-only |
| #8 iOS never calculates authoritative price | Modifier deltas come from the server; the running total is an explicit estimate; checkout owns the real total |
| #13 Location scoping | Menu fetch already location-scoped; no change |
| #17 Non-critical fails safe | Temperature / featured / display_style / art_token all degrade to neutral defaults; nav badge hides at zero |

## 12. Testing plan

- **A (backend):** migration up/down; `menu.service` returns the new fields; backfill/default correctness; seed produces the expected catalog + modifier groups.
- **B (iOS):** `MenuViewModel` temperature-filter unit tests (all/hot/iced, section hiding, hero fallback); spotlight vs list mapping; smart-add routing (item with no required groups → `+` adds to cart; item with a required group → `+` opens detail).
- **C (iOS):** `MainTab` enum order / titles / symbols / raw-value stability for 5 tabs.
- **D (iOS):** selected-modifiers → `modifierIds` mapping; running-total computation (base, single delta, multi delta, unknown-group safety); Add-enabled gating; `DrinkArt` unknown-token fallback.

## 13. Follow-ups (not this work)

- Menu disk cache / instant load (Golden Rule #1).
- Loyalty backend + real Rewards screen.
- Move Sign Out from the Menu toolbar to Account when Account gains content.
- Per-modifier quantity (multiple shots).
- Snapshot/visual-regression coverage for the new menu + 5-tab bar.
