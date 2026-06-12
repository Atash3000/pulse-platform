import SwiftUI

/// Bottom tab bar shown to everyone — signed-in users and guests alike
/// (see `ContentView`). Hosts the four top-level destinations declared in
/// `MainTab`: Home, Menu, Orders, Rewards.
///
/// `initialTab` controls which tab is selected on first appearance:
/// - Signed-in users open to Menu (their job-to-be-done at launch).
/// - Guests open to Home, where the `AccountAvatarButton` is the sign-in
///   entry (it presents `WelcomeView` as a sheet).
///
/// Auth changes are handled by `ContentView`, not here: a sign-in (or a
/// logout) flips `AppState.authState`, `ContentView`'s `switch`
/// re-instantiates `MainTabView` with the new `initialTab`, and the old
/// tab tree is torn down. So a guest who signs in lands on **Menu** (the
/// fresh tree's `initialTab`), not back on Home — and that teardown is
/// what clears the in-memory cart / view-model state on logout. `selection`
/// is `@State` set once from `initialTab`; it is not re-synced on later
/// auth changes because the whole view is rebuilt instead.
struct MainTabView: View {

    @State private var selection: MainTab
    @StateObject private var tabBarVisibility = TabBarVisibility()

    init(initialTab: MainTab = .menu) {
        _selection = State(initialValue: initialTab)
    }

    var body: some View {
        ZStack {
            // Home gates its network load on `isActive` so an eager-mounted but
            // unselected Home tab doesn't fetch on launch (see HomeView). Orders
            // still needs the same treatment once it starts polling.
            tabContent(.home) { HomeView(isActive: selection == .home) }
            tabContent(.menu) { MenuView() }
            tabContent(.orders) { OrdersView() }
            tabContent(.rewards) { RewardsView() }
        }
        .animation(.easeInOut(duration: 0.15), value: selection)
        .environmentObject(tabBarVisibility)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !tabBarVisibility.isHidden {
                // TODO: when OrdersService lands, pass `badge: { $0 == .orders ? ordersService.activeCount : 0 }`.
                PulseTabBar(selection: $selection)
                    .transition(.move(edge: .bottom))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: tabBarVisibility.isHidden)
    }

    @ViewBuilder
    private func tabContent<Content: View>(
        _ tab: MainTab,
        @ViewBuilder content: () -> Content
    ) -> some View {
        content()
            .opacity(selection == tab ? 1 : 0)
            .allowsHitTesting(selection == tab)
            .accessibilityHidden(selection != tab)
    }
}

private struct PulseTabBar: View {
    @Binding var selection: MainTab
    /// Per-tab badge count. Default 0 for every tab — the closure is
    /// the seam for future services (OrdersService.activeCount, etc.).
    /// Counts ≤ 0 hide the badge (fail-safe per Golden Rule #17).
    var badge: (MainTab) -> Int = { _ in 0 }

    @ScaledMetric(relativeTo: .caption) private var iconSize = AppTheme.Metrics.tabBarIconSize
    @ScaledMetric(relativeTo: .caption) private var barHeight = AppTheme.Metrics.tabBarHeight

    private var brandedIconSize: CGFloat {
        iconSize * AppTheme.Metrics.brandedTabIconScale
    }

    var body: some View {
        HStack(spacing: 0) {
            ForEach(MainTab.allCases) { tab in
                let isSelected = selection == tab
                Button {
                    // TODO: Restore native repeat-tap behaviour once tabs have
                    // deep navigation: pop selected tab to root / scroll to top.
                    selection = tab
                } label: {
                    tabLabel(tab, isSelected: isSelected, badgeCount: badge(tab))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.title)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .frame(height: barHeight)
        .padding(.horizontal, 18)
        .background(AppTheme.Colors.tabBarBackground.opacity(0.92).ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) {
            Rectangle()
                .fill(AppTheme.Colors.divider.opacity(0.10))
                .frame(height: 1)
        }
    }

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

    @ViewBuilder
    private func icon(for tab: MainTab, isSelected: Bool) -> some View {
        if let layeredAssetNames = tab.layeredAssetNames {
            PulseLayeredTabIcon(assetNames: layeredAssetNames,
                                isSelected: isSelected)
                .frame(width: brandedIconSize, height: brandedIconSize)
        } else if let assetName = tab.customAssetName {
            Image(assetName)
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .foregroundStyle(isSelected ? AppTheme.Colors.tabIconActive : AppTheme.Colors.tabIconInactive)
                .frame(width: brandedIconSize, height: brandedIconSize)
        } else {
            Image(systemName: isSelected ? tab.selectedSymbolName : tab.tabBarSymbolName)
                .font(.system(size: iconSize,
                              weight: isSelected ? .semibold : .medium))
        }
    }
}

private struct PulseLayeredTabIcon: View {
    let assetNames: LayeredTabAsset
    let isSelected: Bool

    private var baseColor: Color {
        isSelected ? AppTheme.Colors.tabIconActive : AppTheme.Colors.tabIconInactive
    }

    private var leafColor: Color {
        isSelected ? AppTheme.Colors.tabIconMatchaAccent : AppTheme.Colors.tabIconInactive
    }

    var body: some View {
        ZStack {
            // Multi-color nav icons are split into template layers so the active
            // state can keep the matcha accent while inactive collapses to taupe.
            Image(assetNames.baseName)
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .foregroundStyle(baseColor)
                .accessibilityHidden(true)

            if let accentName = assetNames.accentName {
                Image(accentName)
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(leafColor)
                    .accessibilityHidden(true)
            }
        }
    }
}

#Preview {
    MainTabView()
        .environmentObject(AppState())
        .environmentObject(CartManager())
        .environmentObject(FavoritesStore())
}
