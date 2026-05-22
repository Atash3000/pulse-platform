import SwiftUI
import UIKit

/// Bottom tab bar shown after sign-in. Hosts the four top-level
/// destinations declared in `MainTab`. Each tab owns its own
/// `NavigationStack` so back-stacks don't leak across tabs (standard
/// iOS pattern — switching tabs preserves each tab's navigation state).
///
/// Menu is the launch tab: it's the only one with real content in
/// MVP-3. Home / Orders / Account are placeholders pending later
/// commits (see this folder's README for the build sequence).
struct MainTabView: View {

    @State private var selection: MainTab = .menu

    init() {
        // Suppress the iOS 18+ default "capsule pill behind the
        // selected tab" treatment. We want a flat tab bar: selection
        // is conveyed by `.tint(.blue)` on the icon + label alone,
        // no background shape. The static `let` below is computed
        // exactly once; this call re-references it cheaply on every
        // re-instantiation of `MainTabView`.
        _ = Self.appearanceConfigured
    }

    var body: some View {
        TabView(selection: $selection) {
            HomeView()
                .tabItem { label(for: .home) }
                .tag(MainTab.home)

            MenuView()
                .tabItem { label(for: .menu) }
                .tag(MainTab.menu)

            OrdersView()
                .tabItem { label(for: .orders) }
                .tag(MainTab.orders)

            AccountView()
                .tabItem { label(for: .account) }
                .tag(MainTab.account)
        }
        // Selected tab icon + label render in this color. Matches Luckin's
        // selected-tab accent so Menu (the launch tab and primary action)
        // pops blue when active. Other tabs share the same accent — system
        // `TabView` does not support a per-tab tint without a custom bar.
        // See `Features/Navigation/README.md` "Design choices" for why a
        // fully custom Luckin-style "blue circle behind icon" is deferred.
        .tint(.blue)
    }

    @ViewBuilder
    private func label(for tab: MainTab) -> some View {
        if let assetName = tab.customAssetName {
            // Brand-specific Asset Catalog icon (e.g. Menu's Pulse
            // logo). Renders `original` — keeps its colors and does
            // NOT tint blue when selected. The "Menu" text label
            // beneath the icon still tints blue on selection, so the
            // active-tab cue stays legible.
            Label(tab.title, image: assetName)
        } else {
            let symbol = selection == tab ? tab.selectedSymbolName : tab.symbolName
            Label(tab.title, systemImage: symbol)
        }
    }

    /// Global `UITabBar` appearance override, computed exactly once
    /// (Swift's static-let-with-side-effects pattern). Triggered from
    /// `init()` so the override is in place before the first body
    /// evaluation creates the underlying `UITabBar`.
    ///
    /// Why this exists: iOS 18+ ships a new selected-state treatment
    /// for `TabView` items — a filled capsule sits behind the selected
    /// icon + label. We want a flatter look (icon + label go blue when
    /// selected, no background shape). Clearing
    /// `selectionIndicatorTintColor` AND assigning an empty
    /// `selectionIndicatorImage` removes the capsule on every iOS
    /// version that ships with it; older iOS versions silently ignore
    /// these properties (already had no selection capsule).
    private static let appearanceConfigured: Bool = {
        let appearance = UITabBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor.systemBackground
        appearance.selectionIndicatorTintColor = .clear
        appearance.selectionIndicatorImage = UIImage()

        UITabBar.appearance().standardAppearance = appearance
        UITabBar.appearance().scrollEdgeAppearance = appearance
        return true
    }()
}

#Preview {
    MainTabView()
        .environmentObject(AppState())
        .environmentObject(CartManager())
}
