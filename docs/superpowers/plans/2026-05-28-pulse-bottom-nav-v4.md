# Pulse v4 Bottom Nav (Concern C) Implementation Plan

> **Partially superseded (2026-06-06):** The **Account** tab is being removed from the bottom bar and moved to a top-right avatar on the Home screen (the bar becomes 4 tabs: Home · Menu · Orders · Rewards). The Rewards/Menu-icon/Orders-badge work below still stands. See `docs/superpowers/specs/2026-06-06-account-avatar-home-design.md` + the 2026-06-06 decision-log entry. This plan is kept as the historical record of the original 5-tab build.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the iOS bottom tab bar to match v4: add a 5th **Rewards** tab as a "coming soon" placeholder, change the Menu icon from the cup-style mark to a list-lines style, and add a fail-safe-hidden order-count badge on the Orders tab. No backend dependency — fully independent of Concern A.

**Architecture:** Concern C from `docs/superpowers/specs/2026-05-27-pulse-menu-v4-design.md` (§6). Extends the existing `MainTab` enum + custom `PulseTabBar` in place; reuses the layered-icon machinery; uses SF Symbols where the v4 design diverges from the current custom Pulse marks (no new SVG assets — the design uses outline strokes that map cleanly to SF Symbols). The Orders badge takes a count Int and hides when zero — count source is a TODO until `OrdersService` lands (fail-safe per Golden Rule #17).

**Tech Stack:** SwiftUI, iOS 17+, XCTest. No new dependencies.

---

## File Structure

**Modify:**
- `apps/ios/PulseCoffeeApp/Features/Navigation/MainTab.swift` — add `.rewards` case; switch Menu's symbol from cup → list-lines; drop Menu's layered asset override so SF Symbol takes over.
- `apps/ios/PulseCoffeeApp/Features/Navigation/MainTabView.swift` — wire `.rewards` into the tab host (5 tabs); extend `PulseTabBar` to render a per-tab badge count via a small overlay; add a `tabBadges` parameter (closure or dict) that defaults to 0 everywhere.
- `apps/ios/PulseCoffeeApp/Features/Navigation/Placeholders.swift` — add `RewardsView` placeholder (icon + "Rewards coming soon" copy), wired like the other placeholders.
- `apps/ios/PulseCoffeeApp/Features/Navigation/README.md` — short note about the 5-tab layout, the badge contract, and the deferred icon assets.
- `apps/ios/PulseCoffeeAppTests/MainTabTests.swift` — extend for 5 tabs + new Rewards raw value + new Menu symbol + badge visibility threshold.

**Create:** none (the placeholder fits inside `Placeholders.swift`).

**Will NOT touch:**
- Any iOS Menu / Cart / Checkout / Auth feature files.
- Any backend file.
- Any Asset Catalog imageset (we're using SF Symbols for the Menu change and the new Rewards tab — no new SVG art).

---

## Task 0 — Branch + baseline

**Files:** none (git + Xcode build only)

- [ ] **Step 1: Confirm branch + clean state**

Run:
```bash
cd /Users/atamurad/Desktop/pulse-platform
git status --short
git rev-parse --abbrev-ref HEAD
```

Expected: branch is `feat/ios/bottom-nav-v4`; the only untracked file is `docs/superpowers/plans/2026-05-28-pulse-bottom-nav-v4.md` (this plan). If you see other dirty tracked files, stop and surface.

- [ ] **Step 2: Discover an iOS Simulator destination that exists on this machine**

Run:
```bash
xcrun simctl list devices available 2>&1 | grep -E "iPhone (15|16|17) " | head -5
```

Pick the first available "iPhone 15" / "iPhone 16" / "iPhone 17" name from the output and **use that exact name in every subsequent `-destination` flag**. The plan's commands below use `iPhone 15 Pro` as a placeholder — if your machine only has `iPhone 16 Pro`, substitute throughout.

- [ ] **Step 3: Run baseline iOS tests**

Run (substitute the device name from Step 2):
```bash
cd /Users/atamurad/Desktop/pulse-platform/apps/ios
xcodebuild test \
  -project PulseCoffeeApp.xcodeproj \
  -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 15 Pro' \
  -quiet 2>&1 | tail -15
```

Expected: ends with `** TEST SUCCEEDED **`. Note the total test count for the regression check at the end. If build/tests fail on `main` (unrelated to your work), stop and surface — do not paper over a pre-existing red baseline.

---

## Task 1 — Extend `MainTab` for the 5-tab world (TDD)

**Files:**
- Modify: `apps/ios/PulseCoffeeAppTests/MainTabTests.swift`
- Modify: `apps/ios/PulseCoffeeApp/Features/Navigation/MainTab.swift`

This task adds the `.rewards` case, updates the Menu icon, and pins the new contract in tests. TDD: test changes first, then enum changes.

- [ ] **Step 1: Update `MainTabTests` to assert the 5-tab contract — RED first**

In `apps/ios/PulseCoffeeAppTests/MainTabTests.swift`:

a. **Replace** `test_allCases_areInExpectedOrderAndCount()`:

```swift
    func test_allCases_areInExpectedOrderAndCount() {
        XCTAssertEqual(MainTab.allCases,
                       [.home, .menu, .orders, .rewards, .account])
    }
```

b. **Replace** `test_tabBarSymbols_areStableBaseSymbols()`:

```swift
    func test_tabBarSymbols_areStableBaseSymbols() {
        XCTAssertEqual(MainTab.home.tabBarSymbolName,    "house")
        XCTAssertEqual(MainTab.menu.tabBarSymbolName,    "list.bullet")
        XCTAssertEqual(MainTab.orders.tabBarSymbolName,  "bag")
        XCTAssertEqual(MainTab.rewards.tabBarSymbolName, "medal")
        XCTAssertEqual(MainTab.account.tabBarSymbolName, "person.crop.circle")
    }
```

c. **Replace** `test_layeredAssetNames_brandTabsOverrideSFSymbol()` (Menu loses its layered override now that it uses an SF Symbol; Rewards has none):

```swift
    func test_layeredAssetNames_brandTabsOverrideSFSymbol() {
        XCTAssertEqual(MainTab.home.layeredAssetNames,
                       LayeredTabAsset(baseName: "PulseHomeMark",
                                       accentName: "PulseHomeLeafAccent"))
        XCTAssertNil(MainTab.menu.layeredAssetNames)
        XCTAssertEqual(MainTab.orders.layeredAssetNames,
                       LayeredTabAsset(baseName: "PulseOrdersMark",
                                       accentName: "PulseOrdersAccent"))
        XCTAssertNil(MainTab.rewards.layeredAssetNames)
        XCTAssertNil(MainTab.account.layeredAssetNames)
    }
```

d. **Replace** `test_customAssetName_singleLayerBrandTabsOverrideSFSymbol()`:

```swift
    func test_customAssetName_singleLayerBrandTabsOverrideSFSymbol() {
        XCTAssertNil(MainTab.home.customAssetName)
        XCTAssertNil(MainTab.menu.customAssetName)
        XCTAssertNil(MainTab.orders.customAssetName)
        XCTAssertNil(MainTab.rewards.customAssetName)
        XCTAssertEqual(MainTab.account.customAssetName, "PulseAccountMark")
    }
```

e. **Replace** `test_customAssets_existInBundle()` (drop the Menu asset checks — they're no longer referenced from `MainTab`; the asset files are left in the Asset Catalog untouched so they can be reused if design wants them back later):

```swift
    func test_customAssets_existInBundle() {
        XCTAssertNotNil(UIImage(named: "PulseHomeMark"))
        XCTAssertNotNil(UIImage(named: "PulseHomeLeafAccent"))
        XCTAssertNotNil(UIImage(named: "PulseOrdersMark"))
        XCTAssertNotNil(UIImage(named: "PulseOrdersAccent"))
        XCTAssertNotNil(UIImage(named: "PulseAccountMark"))
    }
```

f. **Replace** `test_rawValues_areStableForAnalytics()`:

```swift
    func test_rawValues_areStableForAnalytics() {
        // Analytics events ship the raw value as a string property.
        // Changing any of these is a breaking change for the data team —
        // this test exists to make that breakage loud at code-review time.
        XCTAssertEqual(MainTab.home.rawValue,    "home")
        XCTAssertEqual(MainTab.menu.rawValue,    "menu")
        XCTAssertEqual(MainTab.orders.rawValue,  "orders")
        XCTAssertEqual(MainTab.rewards.rawValue, "rewards")
        XCTAssertEqual(MainTab.account.rawValue, "account")
    }
```

g. **Add** a new test for the per-tab selected-symbol divergence (uses the existing `test_selectedSymbol_differsFromUnselected` — no change needed, it already loops over `allCases`).

- [ ] **Step 2: Run tests — confirm RED**

Run (substituting your device):
```bash
cd /Users/atamurad/Desktop/pulse-platform/apps/ios
xcodebuild test \
  -project PulseCoffeeApp.xcodeproj \
  -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 15 Pro' \
  -only-testing:PulseCoffeeAppTests/MainTabTests \
  -quiet 2>&1 | tail -25
```

Expected: build failure or test failure naming `.rewards` (it does not exist yet) and the Menu symbol assertion. Either is RED.

- [ ] **Step 3: Add the `.rewards` case + update Menu icon in `MainTab.swift`**

Open `apps/ios/PulseCoffeeApp/Features/Navigation/MainTab.swift` and apply the following:

a. Add `case rewards` to the enum, **between `orders` and `account`** to preserve the left-to-right tab order:

```swift
enum MainTab: String, CaseIterable, Identifiable, Hashable {
    case home
    case menu
    case orders
    case rewards
    case account
    // ...
}
```

b. Update the `title` switch:

```swift
    var title: String {
        switch self {
        case .home:    return "Home"
        case .menu:    return "Menu"
        case .orders:  return "Orders"
        case .rewards: return "Rewards"
        case .account: return "Account"
        }
    }
```

c. Update the `symbolName` switch — Menu changes from `cup.and.saucer` → `list.bullet`; add Rewards as `medal`:

```swift
    var symbolName: String {
        switch self {
        case .home:    return "house"
        case .menu:    return "list.bullet"
        case .orders:  return "bag"
        case .rewards: return "medal"
        case .account: return "person.crop.circle"
        }
    }
```

d. Update `layeredAssetNames` so Menu falls back to its SF Symbol (return `nil` for menu; rewards also returns nil):

```swift
    var layeredAssetNames: LayeredTabAsset? {
        switch self {
        case .home:
            return LayeredTabAsset(baseName: "PulseHomeMark",
                                   accentName: "PulseHomeLeafAccent")
        case .orders:
            return LayeredTabAsset(baseName: "PulseOrdersMark",
                                   accentName: "PulseOrdersAccent")
        default:
            return nil
        }
    }
```

e. Update `selectedSymbolName`:

```swift
    var selectedSymbolName: String {
        switch self {
        case .home:    return "house.fill"
        case .menu:    return "list.bullet.rectangle.fill"
        case .orders:  return "bag.fill"
        case .rewards: return "medal.fill"
        case .account: return "person.crop.circle.fill"
        }
    }
```

f. **Leave the doc comment at the top of the file alone** unless it mentions "four" — it currently says "the four top-level destinations." Update it to "the five top-level destinations" to keep the documentation honest.

- [ ] **Step 4: Run tests — confirm GREEN**

Run:
```bash
cd /Users/atamurad/Desktop/pulse-platform/apps/ios
xcodebuild test \
  -project PulseCoffeeApp.xcodeproj \
  -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 15 Pro' \
  -only-testing:PulseCoffeeAppTests/MainTabTests \
  -quiet 2>&1 | tail -15
```

Expected: `Test Suite 'MainTabTests' passed` plus `** TEST SUCCEEDED **`.

- [ ] **Step 5: Commit**

```bash
cd /Users/atamurad/Desktop/pulse-platform
git add apps/ios/PulseCoffeeApp/Features/Navigation/MainTab.swift \
        apps/ios/PulseCoffeeAppTests/MainTabTests.swift
git commit -m "feat(ios): add Rewards tab + switch Menu icon to v4 list style

Extends MainTab to a 5-tab world (home/menu/orders/rewards/account)
matching design/v4. Menu icon switches from the cup-style PulseMenuMark
layered asset to the SF Symbol 'list.bullet' (filled
'list.bullet.rectangle.fill' on selection) per the v4 design's three-
line menu glyph. Rewards uses 'medal' / 'medal.fill' — no new SVG
asset, will be revisited if product wants a Pulse-branded mark.

The PulseMenuMark / PulseMenuAccent imageset is intentionally left in
the Asset Catalog so it can be reinstated without re-importing the SVG.

Tests updated for the 5th tab, the new Menu symbol, the new layered-
asset contract, and the 'rewards' raw value (analytics-stable).
RewardsView placeholder + tab-host wiring land in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2 — `RewardsView` placeholder + wire into `MainTabView`

**Files:**
- Modify: `apps/ios/PulseCoffeeApp/Features/Navigation/Placeholders.swift`
- Modify: `apps/ios/PulseCoffeeApp/Features/Navigation/MainTabView.swift`

- [ ] **Step 1: Add `RewardsView`**

Open `apps/ios/PulseCoffeeApp/Features/Navigation/Placeholders.swift` and read the existing placeholder views (`HomeView`, `OrdersView`, `AccountView`) to copy the established pattern (`NavigationStack` + icon + title + caption — match what's already there exactly; don't invent a new layout).

Add a new `RewardsView` mirroring `OrdersView`'s shape (since Orders is the closest analog — a service screen with future data):

```swift
struct RewardsView: View {
    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                Image(systemName: "medal")
                    .font(.largeTitle)
                    .foregroundStyle(AppTheme.Colors.tabIconActive)
                Text("Rewards coming soon")
                    .font(.headline)
                Text("10 drinks = 1 free. Track your progress here once the loyalty backend ships.")
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 32)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle("Rewards")
        }
    }
}
```

**If the existing placeholders use a different visual style** (e.g. they wrap in a `ScrollView`, or use a different icon size), match that style instead — the goal is consistency with the other placeholders, not the literal code above.

- [ ] **Step 2: Wire `RewardsView` into `MainTabView`**

Open `apps/ios/PulseCoffeeApp/Features/Navigation/MainTabView.swift` and find the `ZStack { tabContent(.home) { ... } ... }` block. Add a `tabContent(.rewards) { RewardsView() }` line between the existing `.orders` and `.account` lines so the rendering order matches the enum order:

```swift
        ZStack {
            tabContent(.home) { HomeView() }
            tabContent(.menu) { MenuView() }
            tabContent(.orders) { OrdersView() }
            tabContent(.rewards) { RewardsView() }
            tabContent(.account) { AccountView() }
        }
```

- [ ] **Step 3: Build + test**

```bash
cd /Users/atamurad/Desktop/pulse-platform/apps/ios
xcodebuild test \
  -project PulseCoffeeApp.xcodeproj \
  -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 15 Pro' \
  -only-testing:PulseCoffeeAppTests/MainTabTests \
  -quiet 2>&1 | tail -10
```

Expected: still green (no test for the Rewards view content; the existing tests cover the enum + bundled assets, which we haven't broken).

Then run the full suite once to catch regressions in unrelated tests:

```bash
xcodebuild test \
  -project PulseCoffeeApp.xcodeproj \
  -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 15 Pro' \
  -quiet 2>&1 | tail -10
```

Expected: `** TEST SUCCEEDED **`, count ≥ baseline.

- [ ] **Step 4: Commit**

```bash
cd /Users/atamurad/Desktop/pulse-platform
git add apps/ios/PulseCoffeeApp/Features/Navigation/Placeholders.swift \
        apps/ios/PulseCoffeeApp/Features/Navigation/MainTabView.swift
git commit -m "feat(ios): RewardsView placeholder + wire Rewards into MainTabView

Adds a 'Rewards coming soon' placeholder mirroring the OrdersView shape
(NavigationStack + icon + headline + caption). The placeholder copy
references the '10 drinks = 1 free' system documented in
design/v4/README.md so the customer sees what to expect once the
loyalty backend lands. Wired between Orders and Account in the tab
host so the rendering order matches the MainTab enum.

Badge UI on the Orders tab lands in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3 — Orders badge UI (fail-safe hidden at zero)

**Files:**
- Modify: `apps/ios/PulseCoffeeApp/Features/Navigation/MainTabView.swift`
- Modify: `apps/ios/PulseCoffeeAppTests/MainTabTests.swift`

Adds a small accent-warm count badge that overlays the Orders tab icon. v4 design shows a hardcoded "2" in the mockup — we won't fake state. The badge takes a count Int, **renders only when > 0** (fail-safe per Golden Rule #17). For this commit the count source is hardcoded to 0 (no `OrdersService` yet); a follow-up commit will wire it once active-order polling exists.

- [ ] **Step 1: Add a small visibility helper + RED test**

In `apps/ios/PulseCoffeeAppTests/MainTabTests.swift`, add a new test at the end of the existing tests (just before the `private func assertColor` helpers):

```swift
    func test_tabBadge_visibilityThreshold() {
        XCTAssertFalse(MainTab.shouldShowBadge(count: 0),
                       "Badge must be hidden when the count is zero (fail-safe)")
        XCTAssertFalse(MainTab.shouldShowBadge(count: -1),
                       "Badge must be hidden for negative counts (defensive)")
        XCTAssertTrue(MainTab.shouldShowBadge(count: 1),
                      "Badge must show for any positive count")
        XCTAssertTrue(MainTab.shouldShowBadge(count: 99),
                      "Badge must show for large counts")
    }

    func test_tabBadge_displayText_capsAt99Plus() {
        XCTAssertEqual(MainTab.badgeText(count: 1),   "1")
        XCTAssertEqual(MainTab.badgeText(count: 9),   "9")
        XCTAssertEqual(MainTab.badgeText(count: 99),  "99")
        XCTAssertEqual(MainTab.badgeText(count: 100), "99+")
        XCTAssertEqual(MainTab.badgeText(count: 999), "99+")
    }
```

Run — confirm RED:

```bash
cd /Users/atamurad/Desktop/pulse-platform/apps/ios
xcodebuild test \
  -project PulseCoffeeApp.xcodeproj \
  -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 15 Pro' \
  -only-testing:PulseCoffeeAppTests/MainTabTests/test_tabBadge_visibilityThreshold \
  -quiet 2>&1 | tail -10
```

Expected: build failure because `MainTab.shouldShowBadge` / `MainTab.badgeText` don't exist yet.

- [ ] **Step 2: Add the static helpers on `MainTab`**

In `apps/ios/PulseCoffeeApp/Features/Navigation/MainTab.swift`, append (inside the `MainTab` enum, after the existing computed properties):

```swift
    /// Returns true iff a count badge should be rendered for this count.
    /// Hidden at zero (fail-safe) and for negative numbers (defensive).
    /// Pure function — kept on the enum so the badge UI and the test
    /// suite share one source of truth.
    static func shouldShowBadge(count: Int) -> Bool {
        count > 0
    }

    /// Display string for a badge count. Caps at "99+" so the badge
    /// never grows wider than the tab icon at runtime.
    static func badgeText(count: Int) -> String {
        count > 99 ? "99+" : "\(count)"
    }
```

Run the new tests — confirm GREEN:

```bash
xcodebuild test \
  -project PulseCoffeeApp.xcodeproj \
  -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 15 Pro' \
  -only-testing:PulseCoffeeAppTests/MainTabTests/test_tabBadge_visibilityThreshold \
  -only-testing:PulseCoffeeAppTests/MainTabTests/test_tabBadge_displayText_capsAt99Plus \
  -quiet 2>&1 | tail -10
```

Expected: both tests pass.

- [ ] **Step 3: Render the badge in `PulseTabBar`**

Open `apps/ios/PulseCoffeeApp/Features/Navigation/MainTabView.swift` and find the `PulseTabBar` struct.

a. Add a `badges` parameter to the binding contract. Replace the existing `@Binding var selection: MainTab` line with:

```swift
    @Binding var selection: MainTab
    /// Per-tab badge count. Default 0 for every tab — the closure is
    /// the seam for future services (OrdersService.activeCount, etc.).
    /// Counts ≤ 0 hide the badge (fail-safe per Golden Rule #17).
    var badge: (MainTab) -> Int = { _ in 0 }
```

b. Inside the `body` `ForEach`, the existing code reads:

```swift
                Button {
                    selection = tab
                } label: {
                    tabLabel(tab, isSelected: isSelected)
                }
```

Change the label call so it passes the current badge count:

```swift
                Button {
                    selection = tab
                } label: {
                    tabLabel(tab, isSelected: isSelected, badgeCount: badge(tab))
                }
```

c. Update `tabLabel(_:isSelected:)` to accept the badge count and overlay a badge over the icon when visible. Replace the existing `tabLabel` function with:

```swift
    private func tabLabel(_ tab: MainTab,
                          isSelected: Bool,
                          badgeCount: Int) -> some View {
        VStack(spacing: 3) {
            ZStack(alignment: .topTrailing) {
                icon(for: tab, isSelected: isSelected)
                if MainTab.shouldShowBadge(count: badgeCount) {
                    Text(MainTab.badgeText(count: badgeCount))
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(AppTheme.Colors.onBadge)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(AppTheme.Colors.destructive, in: Capsule())
                        .offset(x: 10, y: -10)
                        .accessibilityLabel("\(badgeCount) \(tab.title)")
                }
            }
            Text(tab.title)
                .font(.caption.weight(isSelected ? .semibold : .medium))
        }
        .foregroundStyle(isSelected ? AppTheme.Colors.tabLabelActive : AppTheme.Colors.tabLabelInactive)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
    }
```

d. Update the call site in `MainTabView.body` so the default-zero badge is passed (this preserves existing behaviour while introducing the seam):

The existing line is:

```swift
            PulseTabBar(selection: $selection)
```

Leave it exactly as-is — the new `badge` parameter has a default value of `{ _ in 0 }`, so all tab badges render hidden until a future commit wires real counts. Add a one-line TODO comment immediately above it:

```swift
            // TODO: when OrdersService lands, pass `badge: { $0 == .orders ? ordersService.activeCount : 0 }`.
            PulseTabBar(selection: $selection)
```

- [ ] **Step 4: Run full test suite**

```bash
cd /Users/atamurad/Desktop/pulse-platform/apps/ios
xcodebuild test \
  -project PulseCoffeeApp.xcodeproj \
  -scheme PulseCoffeeApp \
  -destination 'platform=iOS Simulator,name=iPhone 15 Pro' \
  -quiet 2>&1 | tail -10
```

Expected: `** TEST SUCCEEDED **`. Total count = baseline + 2 (the two new badge tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/atamurad/Desktop/pulse-platform
git add apps/ios/PulseCoffeeApp/Features/Navigation/MainTab.swift \
        apps/ios/PulseCoffeeApp/Features/Navigation/MainTabView.swift \
        apps/ios/PulseCoffeeAppTests/MainTabTests.swift
git commit -m "feat(ios): Orders-style count badge on PulseTabBar

PulseTabBar gains a 'badge: (MainTab) -> Int' closure parameter,
defaulted to { _ in 0 } so the call site stays unchanged and every
badge starts hidden. MainTab.shouldShowBadge(count:) and
MainTab.badgeText(count:) are the single source of truth for the
hide-at-zero / cap-at-99+ rules (Golden Rule #17 fail-safe). When
OrdersService lands, the MainTabView TODO points at the one-line
wire-up: 'badge: { \$0 == .orders ? ordersService.activeCount : 0 }'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4 — README touch-up + final manual verification

**Files:**
- Modify: `apps/ios/PulseCoffeeApp/Features/Navigation/README.md`

- [ ] **Step 1: Refresh the Navigation README**

Open `apps/ios/PulseCoffeeApp/Features/Navigation/README.md` and read it end-to-end first to understand the existing structure (it already documents the 4-tab world from concern C's predecessor). Make these targeted edits:

a. Anywhere the README says "four tabs" / "four top-level destinations" / lists the four tabs, update to **five** and include `Rewards` between `Orders` and `Account`.

b. Add a new short subsection under "Design choices" (or whichever subsection lists icon decisions), titled something like **"v4 icon set"**:

```markdown
- **v4 icon set.** Menu uses the SF Symbol `list.bullet` (selected `list.bullet.rectangle.fill`) — the cup-style `PulseMenuMark` / `PulseMenuAccent` SVGs remain in the Asset Catalog but are no longer wired from `MainTab.layeredAssetNames`. They can be re-attached without re-importing the SVG if product wants the cup back. Rewards uses `medal` / `medal.fill` — no Pulse-branded asset commissioned yet; revisit if design wants a custom mark.
```

c. Add another short subsection titled **"Tab badge contract"**:

```markdown
- **Tab badge contract.** `PulseTabBar` takes `badge: (MainTab) -> Int`, defaulted to `{ _ in 0 }`. `MainTab.shouldShowBadge(count:)` hides the badge at zero and for negative counts; `MainTab.badgeText(count:)` caps the displayed value at `99+`. Style mirrors the cart-count badge in `MenuView` (small destructive-tint capsule, white text). Count source for Orders is a TODO in `MainTabView` until `OrdersService` lands.
```

d. Update the **Build sequence** table so the Rewards row reads:

```
| Rewards | placeholder | Loyalty progress + reward history (depends on loyalty backend) |
```

(Add it as a new row between Orders and Account in the existing table.)

e. **Do NOT delete the existing design-decision bullets about contrast, layered icons, etc.** They still apply.

- [ ] **Step 2: Manual simulator verification (this is the bit the founder asked for)**

Build the app and run it in the simulator. Suggested CLI (in case Xcode IDE is closed):

```bash
cd /Users/atamurad/Desktop/pulse-platform/apps/ios

# Boot a simulator (replace device name with what your machine has):
xcrun simctl boot 'iPhone 15 Pro' 2>/dev/null || true
open -a Simulator

# Build for that simulator and install:
xcodebuild \
  -project PulseCoffeeApp.xcodeproj \
  -scheme PulseCoffeeApp \
  -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 15 Pro' \
  -derivedDataPath build \
  -quiet build 2>&1 | tail -5

APP_PATH=$(find build/Build/Products/Debug-iphonesimulator -name "PulseCoffeeApp.app" | head -1)
xcrun simctl install booted "$APP_PATH"

# Launch:
xcrun simctl launch booted limited.PulseCoffeeApp 2>&1 | tail -3
```

(If the bundle identifier above is wrong, find the actual one via `defaults read "$APP_PATH/Info" CFBundleIdentifier` and re-launch.)

**What to look for in the simulator:**

1. Tab bar has **five** tabs left-to-right: Home, Menu, Orders, Rewards, Account.
2. Menu icon is the **three-line list glyph**, not the cup-and-saucer.
3. Rewards tab shows the placeholder ("Rewards coming soon" + the loyalty teaser copy).
4. Orders tab does **NOT** show a badge (count is 0 → hidden). This is correct; the badge will appear once a future commit wires real order counts.
5. Tapping each tab switches the content without crash. Account tab still goes to `WelcomeView` for guests and the placeholder for signed-in users.
6. Active-tab color is still the warm gold; inactive is taupe; the bar background is the cream.

Take a screenshot for the PR:

```bash
xcrun simctl io booted screenshot /tmp/pulse-nav-v4.png
echo "Screenshot at /tmp/pulse-nav-v4.png"
```

- [ ] **Step 3: Commit README**

```bash
cd /Users/atamurad/Desktop/pulse-platform
git add apps/ios/PulseCoffeeApp/Features/Navigation/README.md
git commit -m "docs(ios): document 5-tab nav, v4 icon set, and badge contract

Updates the Navigation README for the 5th Rewards tab, the Menu icon
switch to the SF Symbol 'list.bullet' (PulseMenuMark assets retained
in the catalog for future use), the medal SF Symbol for Rewards, and
the PulseTabBar badge contract (default-zero closure, hide-at-zero
fail-safe, cap at 99+).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5 — Push + open PR (USER-GATED)

**Files:** none (GitHub only)

- [ ] **Step 1: Do NOT push without explicit user approval.**

Per CLAUDE.md §8, do not run `git push` or `gh pr create` without the user saying "push it" or "open a PR." Print the publish commands so the user can run them manually if preferred:

```bash
git push -u origin feat/ios/bottom-nav-v4
gh pr create \
  --base main \
  --head feat/ios/bottom-nav-v4 \
  --title "feat(ios): v4 bottom nav — 5 tabs + Rewards placeholder + Orders badge UI" \
  --body "[see plan §Task 5 for the body template]"
```

PR body template (the implementer should not edit this without asking):

```
Concern C of `docs/superpowers/specs/2026-05-27-pulse-menu-v4-design.md`.

## Summary
- Adds a 5th tab `Rewards` (between Orders and Account) with a "coming soon" placeholder mirroring the OrdersView shape. Copy references the "10 drinks = 1 free" system from `design/v4/README.md`.
- Switches the Menu icon from the cup-style `PulseMenuMark` layered asset to SF Symbol `list.bullet` (selected `list.bullet.rectangle.fill`) per the v4 design's three-line glyph. The cup assets stay in the Asset Catalog so they can be reinstated without re-importing.
- Adds a fail-safe-hidden order-count badge on `PulseTabBar`: takes a `(MainTab) -> Int` closure (default `{ _ in 0 }`), hides at zero, caps display at `99+`. Count source is a TODO until `OrdersService` lands.
- Updates `MainTabTests` for the 5-tab world, the new symbol/asset contracts, and the badge visibility/threshold rules.
- Refreshes `Features/Navigation/README.md`.

## Out of scope (separate PRs)
- iOS v4 Menu redesign (concern B) — depends on the backend in PR #15.
- iOS item modifier picker (concern D) — depends on the modifier seed in PR #15.
- Backend menu presentation fields (concern A) — PR #15.

## Golden Rules
- #17 Fail safe — badge defaults to count 0 → hidden; analytics raw values pinned (loud regression if accidentally renamed).

## Test plan
- xcodebuild test — full suite green (baseline + 2 new badge tests).
- Manual simulator: 5 tabs visible; Menu icon is list-lines; Rewards opens to placeholder; Orders has no badge today (0 count → hidden); active/inactive colors unchanged.
- Screenshot in /tmp/pulse-nav-v4.png (attached to the PR by the controller).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## Self-Review

Coverage of spec §6 (Concern C):

- **5-tab MainTab enum, ordered home/menu/orders/rewards/account** — Task 1.
- **v4 icon set (Menu list-lines, Rewards medal)** — Task 1 (Account/Home/Orders icons left as-is intentionally; they already match v4 outline-stroke style).
- **Orders badge with fail-safe hide-at-zero** — Task 3 (count source = TODO until OrdersService, explicitly per spec).
- **RewardsView placeholder + wired into MainTabView** — Task 2.
- **MainTabTests extended for 5th tab + raw-value stability** — Task 1, plus Task 3 for badge logic.
- **Navigation README refresh** — Task 4.
- **CLAUDE.md §8: no push/PR without explicit user approval** — Task 5 is explicitly gated.

No placeholders. Method names (`shouldShowBadge`, `badgeText`, `RewardsView`) are consistent across tasks. Icon-asset names (`list.bullet`, `medal`) are real SF Symbols available since iOS 15+.
