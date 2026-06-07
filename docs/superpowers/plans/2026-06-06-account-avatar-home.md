# Account Avatar on Home — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove `Account` from the bottom tab bar (→ 4 tabs) and surface it as a top-right avatar on the Home screen (first-name initial when signed in, person glyph when guest) that opens `AccountView` as a sheet. Guests land on Home.

**Architecture:** A new reusable `AccountAvatarButton` (reads `AppState.authState`) added to Home's nav-bar trailing slot; `MainTab` drops `.account`; `ContentView` routes guests to `.home`. `AccountView` is reused as the sheet body (it already splits guest→`WelcomeView` / signed-in→profile+sign-out). **Order matters:** add the avatar first (additive, nothing breaks), then remove the tab — so every commit is shippable.

**Tech Stack:** SwiftUI, **iOS 16 target**, XcodeGen. XCTest. Build/test from `apps/ios/`: `make build|test SIMULATOR_DESTINATION='platform=iOS Simulator,name=iPhone 17 Pro'`. **A file is added → `make project` is required in Task 1.**

**Branch:** `feat/ios/account-avatar-home` (off `main`; spec committed `5c094d9`/`…`).

> **Commit policy (CLAUDE.md §8):** each task ends with a commit; the human approves. Don't push.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `apps/ios/PulseCoffeeApp/Features/Navigation/AccountAvatarButton.swift` | Create | The avatar + sheet trigger + pure `initial(for:)` |
| `apps/ios/PulseCoffeeAppTests/AccountAvatarButtonTests.swift` | Create | `initial(for:)` boundary tests |
| `apps/ios/PulseCoffeeApp/Features/Navigation/Placeholders.swift` | Modify | Add the avatar to `HomeView`'s trailing toolbar |
| `apps/ios/PulseCoffeeApp/Features/Navigation/MainTab.swift` | Modify | Remove the `.account` case |
| `apps/ios/PulseCoffeeApp/Features/Navigation/MainTabView.swift` | Modify | Remove the `tabContent(.account)` line |
| `apps/ios/PulseCoffeeApp/ContentView.swift` | Modify | Guests land on `.home` |
| `apps/ios/PulseCoffeeAppTests/MainTabTests.swift` | Modify | Drop `.account` assertions |
| `apps/ios/PulseCoffeeApp/Features/Menu/MenuView.swift` | Modify | Fix the "sign-out moved to the Account tab" comment |
| `apps/ios/PulseCoffeeApp/Features/Navigation/README.md` | Modify | Rewrite to 4 tabs + Home avatar; drop the forward-note |

---

## Task 1: `AccountAvatarButton` + add to Home (TDD for the pure helper)

**Files:** Create `AccountAvatarButton.swift`, `AccountAvatarButtonTests.swift`; Modify `Placeholders.swift`.

- [ ] **Step 1: Failing tests** — create `apps/ios/PulseCoffeeAppTests/AccountAvatarButtonTests.swift`. Construct a `CustomerProfile` with a given first name the way other tests / `AppState` do — read `CustomerProfile` first and use its memberwise init **or** a JSON decode (match its `Codable`); the helper below only needs `firstName` populated:

```swift
import XCTest
@testable import PulseCoffeeApp

final class AccountAvatarButtonTests: XCTestCase {

    /// Build a `.loggedIn` AuthState with the given first name.
    private func loggedIn(firstName: String) -> AppState.AuthState {
        // Construct CustomerProfile per its initializer/Codable (read the type).
        .loggedIn(makeProfile(firstName: firstName))
    }

    func test_initial_loggedOut_isNil() {
        XCTAssertNil(AccountAvatarButton.initial(for: .loggedOut))
    }

    func test_initial_loggedIn_returnsUppercasedFirstLetter() {
        XCTAssertEqual(AccountAvatarButton.initial(for: loggedIn(firstName: "atash")), "A")
    }

    func test_initial_loggedIn_emptyName_isNil() {
        XCTAssertNil(AccountAvatarButton.initial(for: loggedIn(firstName: "")))
    }

    func test_initial_loggedIn_whitespaceName_isNil() {
        XCTAssertNil(AccountAvatarButton.initial(for: loggedIn(firstName: "   ")))
    }
}
```
Add a `makeProfile(firstName:)` helper in the test that builds a `CustomerProfile` (read the type to get its init/required fields).

- [ ] **Step 2: Run, verify it fails** — `make test …` → compile failure (`AccountAvatarButton` undefined).

- [ ] **Step 3: Create `AccountAvatarButton.swift`**:

```swift
import SwiftUI

/// Top-right account entry. Reusable across screens (Home only for now).
/// Signed in → a rounded brand circle with the first-name initial; guest →
/// a person glyph. Tapping opens `AccountView` as a sheet (which itself
/// splits on auth state: guest → WelcomeView, signed-in → profile + sign-out).
struct AccountAvatarButton: View {
    @EnvironmentObject private var appState: AppState
    @State private var showAccount = false

    /// First-name initial when signed in with a non-empty name; `nil` otherwise
    /// (guest, or a blank/whitespace name) → the view shows the person glyph.
    /// Pure + static so it's unit-testable without a view (GR#17 fail-safe:
    /// a blank name never yields an empty circle).
    static func initial(for authState: AppState.AuthState) -> String? {
        guard case .loggedIn(let profile) = authState else { return nil }
        let trimmed = profile.firstName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return nil }
        return String(first).uppercased()
    }

    var body: some View {
        let initial = Self.initial(for: appState.authState)
        return Button { showAccount = true } label: {
            Group {
                if let initial {
                    Text(initial)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(AppTheme.Colors.tabBarBackground)
                } else {
                    Image(systemName: "person.crop.circle")
                        .font(.system(size: 18, weight: .regular))
                        .foregroundStyle(AppTheme.Colors.tabLabelInactive)
                }
            }
            .frame(width: 34, height: 34)
            .background(
                Circle().fill(initial != nil
                              ? AppTheme.Colors.tabLabelActive
                              : AppTheme.Colors.tabBarBackground)
            )
            .overlay(Circle().stroke(AppTheme.Colors.divider.opacity(0.14), lineWidth: 1))
            .frame(width: 44, height: 44)          // ≥44pt tap target (WCAG 2.5.5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
        .sheet(isPresented: $showAccount) {
            AccountView()
        }
    }

    private var accessibilityLabel: String {
        if case .loggedIn(let profile) = appState.authState,
           !profile.firstName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Account, signed in as \(profile.firstName)"
        }
        return "Account, sign in"
    }
}
```
(If `CustomerProfile`'s first-name property isn't `firstName`, use the real name — read the type. `AppTheme.Colors.tabLabelActive`/`tabBarBackground`/`tabLabelInactive`/`divider` are the same tokens the tab bar uses.)

- [ ] **Step 4: Add the avatar to Home** — in `Placeholders.swift`, give `HomeView` a trailing toolbar item (iOS-16 `.navigationBarTrailing`):

```swift
struct HomeView: View {
    var body: some View {
        NavigationStack {
            PlaceholderContent(tab: .home,
                               caption: "Featured drinks, promos, and nearby locations land here.")
                .navigationTitle(MainTab.home.title)
                .toolbar {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        AccountAvatarButton()
                    }
                }
        }
    }
}
```

- [ ] **Step 5: Regenerate the project** (a file was added) — from `apps/ios/`: `make project`.

- [ ] **Step 6: Run, verify it passes** — `make test …` (the 4 helper tests pass) and `make build …` (clean). Account tab still present at this point — that's intentional (additive commit).

- [ ] **Step 7: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Navigation/AccountAvatarButton.swift apps/ios/PulseCoffeeAppTests/AccountAvatarButtonTests.swift apps/ios/PulseCoffeeApp/Features/Navigation/Placeholders.swift
git commit -m "feat(ios): AccountAvatarButton on Home (initial when signed in, glyph for guest)

Reusable top-right avatar that opens AccountView as a sheet. Pure initial(for:)
helper is fail-safe (blank name → glyph). Added to Home's trailing toolbar.
Additive — the Account tab is still present until the next commit.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Remove Account from the bottom nav + route guests to Home

**Files:** Modify `MainTab.swift`, `MainTabView.swift`, `ContentView.swift`, `MainTabTests.swift`.

- [ ] **Step 1: `MainTab.swift`** — delete the `.account` case and every `.account` switch arm:
  - remove `case account` (line ~13)
  - remove `case .account: return "Account"` from `title`
  - remove `case .account: return "person.crop.circle"` from `symbolName`
  - remove `case .account: return "person.crop.circle.fill"` from `selectedSymbolName`
  - remove the `.account` arm from `customAssetName` (the `case .account: return "PulseAccountMark"` line; the `default: return nil` stays)
  - `layeredAssetNames` has no `.account` arm (covered by `default`) — leave it.
  - Update the doc comment "The five top-level destinations" → "four".

- [ ] **Step 2: `MainTabView.swift`** — remove the line `tabContent(.account) { AccountView() }` (line ~38). Leave the other four.

- [ ] **Step 3: `ContentView.swift`** — change the logged-out branch:

```swift
        case .loggedOut:
            MainTabView(initialTab: .home)
```
(was `.account`). Update the doc comment: guests now land on **Home** (the account avatar there is the sign-in entry; `WelcomeView` is presented as a sheet from it), not the Account tab. Logged-in stays `.menu`.

- [ ] **Step 4: `MainTabTests.swift`** — update for 4 tabs:
  - `test_allCases_areInExpectedOrderAndCount`: expected array → `[.home, .menu, .orders, .rewards]`.
  - Remove the `.account` assertions: `MainTab.account.tabBarSymbolName` (line ~43), `MainTab.account.layeredAssetNames` (line ~55), `MainTab.account.customAssetName` (line ~63), and the `UIImage(named: "PulseAccountMark")` check (line ~71) — that asset is now unused.
  - Leave the loop-based tests (`for tab in MainTab.allCases`) — they auto-cover 4 tabs now.

- [ ] **Step 5: Build + test** — `make build …` (clean; `AccountView` is still referenced by the avatar sheet + its `#Preview`, so it stays) and `make test …` (green). No new files → `make project` not needed.

- [ ] **Step 6: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Navigation/MainTab.swift apps/ios/PulseCoffeeApp/Features/Navigation/MainTabView.swift apps/ios/PulseCoffeeApp/ContentView.swift apps/ios/PulseCoffeeAppTests/MainTabTests.swift
git commit -m "feat(ios): drop Account from the bottom nav (4 tabs); guests land on Home

MainTab loses .account (bar renders Home/Menu/Orders/Rewards); ContentView
routes logged-out users to Home, where the AccountAvatarButton is the sign-in
entry (WelcomeView as a sheet). AccountView is now reached only via the avatar.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Docs + stale comments

**Files:** Modify `MenuView.swift`, `Features/Navigation/README.md`.

- [ ] **Step 1: Fix the `MenuView` comment** — its topbar doc comment says sign-out "moved to the Account tab when the v4 topbar landed." Update to: moved to the **Home account avatar** (the Account tab was removed 2026-06-06). Grep for the exact text: `grep -n "Account tab" apps/ios/PulseCoffeeApp/Features/Menu/MenuView.swift`.

- [ ] **Step 2: Rewrite the Navigation README** to current reality:
  - Remove the `> ⚠️ Changing (spec 2026-06-06)` forward-note (it's now done).
  - Intro + the file-tree: **4 tabs** (Home · Menu · Orders · Rewards); `AccountView` is no longer a tab — it's presented as a **sheet from the Home top-right `AccountAvatarButton`** (initial when signed in, glyph for guest). Guests land on Home.
  - `MainTab.swift` row: enum is now `home/menu/orders/rewards`.
  - `Placeholders.swift` row: note `HomeView` hosts the `AccountAvatarButton`; `AccountView` is the sheet body (guest → WelcomeView, signed-in → profile + sign-out).
  - Update any "five-tab" / Luckin reference to four.
  - Keep the design-choices/badge/icon sections; just drop the account-tab specifics.

- [ ] **Step 3: Commit**

```bash
git add apps/ios/PulseCoffeeApp/Features/Menu/MenuView.swift apps/ios/PulseCoffeeApp/Features/Navigation/README.md
git commit -m "docs(ios): update nav README + MenuView comment for Account-as-avatar

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Full verification

- [ ] **Step 1: Suite** — from `apps/ios/`: `make test …` → all green (4 new `AccountAvatarButton` tests; `MainTab` tests now expect 4). `make build …` → clean.
- [ ] **Step 2: No stale `.account` refs** — `grep -rn "\.account\b" apps/ios/PulseCoffeeApp apps/ios/PulseCoffeeAppTests` returns nothing referencing the removed enum case (string literals / unrelated `.account` are fine; there should be none for `MainTab.account`).
- [ ] **Step 3: Simulator walk** — bottom bar shows 4 tabs (no Account). Guest cold-open lands on **Home** with a person-glyph avatar top-right → tap → `WelcomeView` sheet (sign-in/join), dismissable to keep browsing. Signed in: Home avatar shows the first-name initial → tap → profile + Sign Out sheet; the bar still shows 4 tabs. Menu's cart top-right is unchanged.
- [ ] **Step 4: Report** — tests green, build clean, branch ready for review/PR. Do not push without approval.

---

## Self-review (completed by plan author)

**Spec coverage (2026-06-06-account-avatar-home-design.md):** §2/§4.1 `AccountAvatarButton` (initial/glyph, sheet, 44pt, fail-safe) → Task 1 ✅ · §4.2 avatar on Home → Task 1 Step 4 ✅ · §4.3 `AccountView` reused as sheet (already auth-split) → Task 1 (sheet body) ✅ · §4.4 `MainTab`/`MainTabView` remove `.account` → Task 2 ✅ · §4.5 `ContentView` guests → `.home` → Task 2 Step 3 ✅ · §5 tests (pure helper + MainTab=4) → Task 1 + Task 2 Step 4 ✅ · §6 docs (decision-log done in spec commit; README; MenuView comment) → Task 3 ✅.

**Placeholder scan:** none in the code blocks. The two "read the type" notes (`CustomerProfile`'s init for the test helper; the exact first-name property) are bounded — the helper only needs `firstName`; the implementer confirms the property name against the type.

**Type/consistency:** `AccountAvatarButton.initial(for:)` signature matches between impl (Task 1 Step 3) and tests (Step 1). `AppState.AuthState` is `.loggedOut`/`.loggedIn(CustomerProfile)` (verified). Commit order is additive-then-removal so each commit builds + is shippable: Task 1 leaves the Account tab AND adds the avatar (both work); Task 2 removes the tab once the avatar exists. `make project` only in Task 1 (the one new file). `AppTheme.Colors` tokens are the tab-bar set, already in use.
