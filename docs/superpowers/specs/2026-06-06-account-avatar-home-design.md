# Account Avatar on Home — Design

**Date:** 2026-06-06
**Status:** Approved design — ready for implementation planning
**Surface:** `apps/ios` (SwiftUI)
**Audience:** the `/superpowers:writing-plans` planner and the implementing engineer.

---

## 1. Goal & gap

The bottom tab bar has **5 tabs** (Home · Menu · Orders · Rewards · **Account**). Account is low-frequency (profile / sign-out) and clutters the bar. This change **removes Account from the bottom nav** (→ 4 tabs) and surfaces it as a **top-right avatar on the Home screen** — the universal convention for account/profile, which also doubles as the "you're signed in" signal.

Rewards stays a tab on purpose: loyalty is the engagement driver and belongs one tap away (see decision-log).

This is deliberately a **small first step** — the avatar lives **only on Home for now**; putting it on more screens and polishing the guest flow are explicitly deferred (§6).

---

## 2. Scope

### In scope
- Remove `account` from `MainTab` → bottom nav renders **Home · Menu · Orders · Rewards** (4).
- New reusable **`AccountAvatarButton`** placed in the **Home screen's top-right**:
  - **Signed in:** a rounded, brand-colored circle with the first-name initial (e.g. **A**).
  - **Guest:** the same circle with a person glyph.
  - **Tap → `AccountView` as a bottom sheet.**
- Guest sheet shows a **non-pushy** "Sign in / Create account" entry — never blocks browsing, never force-redirects to registration.
- Docs updated so the nav change is recorded (Navigation README, decision-log).

### Out of scope (deferred — "rest we'll figure")
- The avatar on **Menu / Orders** (Menu's top-right cart stays untouched) and **Rewards** (later).
- Full guest onboarding / sign-in-register flow polish.
- Any change to `Rewards`, the cart, or the Menu top bar.

### Accepted trade-off
With the Account tab gone and the avatar only on Home, a signed-in user reaches **Account / sign-out only from Home** for now. Accepted as the MVP step; surfacing the avatar on more screens is the follow-up (§6).

---

## 3. What exists (reuse, don't rebuild)

| Asset | Location | Role / change |
|---|---|---|
| `MainTab` | `Features/Navigation/MainTab.swift` | Remove the `.account` case (title/icon/asset). `allCases` then drives a 4-tab bar. |
| `MainTabView` | `Features/Navigation/MainTabView.swift` | Remove the `tabContent(.account) { AccountView() }` line. The `PulseTabBar` auto-renders 4 from `MainTab.allCases`. |
| `AccountView` | `Features/Navigation/Placeholders.swift` | **Reused** as the sheet body (signed-in: profile placeholder + sign-out; add a guest variant). |
| `AppState` | `Core/AppState.swift` | Source of signed-in state + customer first name (for the initial). |
| `AccountAvatarButton` | `Features/Navigation/` (new) | The avatar + sheet trigger. |
| Home view | `Features/Navigation/Placeholders.swift` (currently a "coming soon" placeholder) | Gains a top-right avatar zone. |

---

## 4. Architecture

### 4.1 `AccountAvatarButton` (NEW)
- Reads signed-in state + first name from `AppState` (`@EnvironmentObject`).
- Renders a fixed-size rounded circle (≥44pt tap target, WCAG 2.5.5):
  - signed in **and** a non-empty first name → the uppercased first character.
  - otherwise (guest, or missing/empty name) → a person SF Symbol. **Fail-safe (GR#17): a blank/whitespace name never yields an empty circle.**
- `@State private var showAccount = false`; the button toggles it; `.sheet(isPresented:)` presents `AccountView`.
- Accessibility: `.accessibilityLabel("Account")` (signed in: "Account, signed in as \(firstName)"); it's a single labelled control.
- Reusable — any screen can drop in `AccountAvatarButton()`; for now only Home does.

### 4.2 Home screen (MODIFY)
- Add a top-right header zone hosting `AccountAvatarButton()`. Home is a placeholder today, so this is a small top-trailing overlay/header — no cart, no collision.

### 4.3 `AccountView` as the sheet (MODIFY)
- Signed in: the existing content (profile placeholder + sign-out) — unchanged.
- Guest: a calm "Sign in / Create account" entry (reuses the existing auth entry points) the user can dismiss to keep browsing. Keep it minimal; full guest flow is deferred.

### 4.4 `MainTab` / `MainTabView` (MODIFY)
- Delete the `.account` case + its `title`/`icon`/asset mappings; delete the `tabContent(.account)` line. Nothing else references `.account` after that (verify with a grep at implementation). The `PulseAccountMark` asset becomes unused (leave it; removing assets is out of scope).

---

## 5. Data flow / fail-safe / testing

**Data:** `AppState` → signed-in? + first name → `AccountAvatarButton` → initial or glyph. Tap → sheet → `AccountView` (signed-in vs guest body).

**Fail-safe (GR#17):** a non-critical surface — a missing name degrades to the person glyph; the avatar never blocks Home from rendering.

**Testing:**
- `AccountAvatarButton` shows the uppercased initial when signed in with a name; the glyph when guest **or** when the name is empty/whitespace (pure helper for "initial vs glyph" so it's unit-testable without a view).
- Tapping presents the sheet (simulator/walk; no ViewInspector in the project).
- `MainTab.allCases` no longer contains `.account` (the bar renders 4) — a tiny assertion.

---

## 6. Docs to update (part of the work)

- **Decision-log entry:** Account moved from the bottom nav to a Home top-right avatar; Rewards kept as a tab (loyalty prominence); the "reachable only from Home for now" trade-off.
- **`Features/Navigation/README.md`:** 4-tab bar + the Home account avatar; note `AccountView` is now sheet-presented, not a tab.
- **Code comment** in `MenuView` ("sign-out … moved to the Account tab") → update to "the Home account avatar" at implementation.
- **`docs/superpowers/plans/2026-05-28-pulse-bottom-nav-v4.md`:** a one-line "superseded re: Account — see this spec" pointer (it's a historical plan; not rewritten).

## 7. Deferred / todos (captured so nothing is reinvented)

- **Avatar on more screens** (Rewards, Menu, Orders) so signed-in users reach Account from anywhere — the natural next step once this lands.
- **Guest onboarding flow** — how a browsing guest is gently nudged to register without being walled. The avatar is the non-pushy entry point; the full flow is its own brainstorm.
