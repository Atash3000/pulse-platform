import SwiftUI

/// Bottom tab bar shown after sign-in. Hosts the four top-level
/// destinations declared in `MainTab`.
///
/// Menu is the launch tab: it's the only one with real content in
/// MVP-3. Home / Orders / Account are placeholders pending later
/// commits (see this folder's README for the build sequence).
struct MainTabView: View {

    @State private var selection: MainTab = .menu

    var body: some View {
        ZStack {
            // TODO: Before Home / Orders / Account start API fetches or polling,
            // lazy-mount inactive tabs or gate their tasks on `selection`.
            tabContent(.home) { HomeView() }
            tabContent(.menu) { MenuView() }
            tabContent(.orders) { OrdersView() }
            tabContent(.account) { AccountView() }
        }
        .animation(.easeInOut(duration: 0.15), value: selection)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            PulseTabBar(selection: $selection)
        }
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

    @ScaledMetric(relativeTo: .caption) private var iconSize = AppTheme.Metrics.tabBarIconSize
    @ScaledMetric(relativeTo: .caption) private var barHeight = AppTheme.Metrics.tabBarHeight

    // TODO: Replace this with the latest order status once Orders has
    // a backend-backed view model. For now the manager wants empty shown.
    private let ordersState: OrdersTabState = .empty

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
                    tabLabel(tab, isSelected: isSelected)
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

    private func tabLabel(_ tab: MainTab, isSelected: Bool) -> some View {
        VStack(spacing: 3) {
            icon(for: tab, isSelected: isSelected)
            Text(tab.title)
                .font(.caption.weight(isSelected ? .semibold : .medium))
        }
        .foregroundStyle(isSelected ? AppTheme.Colors.tabLabelActive : AppTheme.Colors.tabLabelInactive)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private func icon(for tab: MainTab, isSelected: Bool) -> some View {
        if tab == .home {
            PulseHomeTabIcon(isSelected: isSelected)
                .frame(width: brandedIconSize, height: brandedIconSize)
        } else if tab == .orders {
            PulseOrdersTabIcon(state: ordersState, isSelected: isSelected)
                .frame(width: brandedIconSize, height: brandedIconSize)
        } else if let assetName = tab.customAssetName {
            switch tab.customAssetRendering {
            case .original:
                Image(assetName)
                    .renderingMode(.original)
                    .resizable()
                    .scaledToFit()
                    .frame(width: brandedIconSize, height: brandedIconSize)
            case .template:
                Image(assetName)
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(isSelected ? AppTheme.Colors.tabIconActive : AppTheme.Colors.tabIconInactive)
                    .frame(width: brandedIconSize, height: brandedIconSize)
            }
        } else {
            Image(systemName: isSelected ? tab.selectedSymbolName : tab.tabBarSymbolName)
                .font(.system(size: iconSize,
                              weight: isSelected ? .semibold : .medium))
        }
    }
}

private struct PulseHomeTabIcon: View {
    let isSelected: Bool

    private var baseColor: Color {
        isSelected ? AppTheme.Colors.tabIconActive : AppTheme.Colors.tabIconInactive
    }

    private var leafColor: Color {
        isSelected ? AppTheme.Colors.tabIconMatchaAccent : AppTheme.Colors.tabIconInactive
    }

    var body: some View {
        ZStack {
            // The Home mark is split into template layers so the active state can
            // keep the matcha curl while inactive collapses to the taupe stroke.
            Image("PulseHomeMark")
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .foregroundStyle(baseColor)
                .accessibilityHidden(true)

            Image("PulseHomeLeafAccent")
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .foregroundStyle(leafColor)
                .accessibilityHidden(true)
        }
    }
}

enum OrdersTabState: Equatable, Hashable {
    case empty
    case preparing
    case ready

    var cupColor: Color? {
        switch self {
        case .empty:     return nil
        case .preparing: return AppTheme.Colors.orderPreparing
        case .ready:     return AppTheme.Colors.orderReady
        }
    }
}

private struct PulseOrdersTabIcon: View {
    let state: OrdersTabState
    let isSelected: Bool

    var body: some View {
        ZStack {
            // Keep the Orders artwork split into template layers: the bag follows
            // the shared brand token, while the cup can reflect order status.
            Image("PulseOrdersMark")
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .foregroundStyle(isSelected ? AppTheme.Colors.tabIconActive : AppTheme.Colors.tabIconInactive)
                .accessibilityHidden(true)

            if let cupColor = state.cupColor {
                Image("PulseOrdersCupState")
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(cupColor)
                    .accessibilityHidden(true)
            }
        }
    }
}

#Preview {
    MainTabView()
        .environmentObject(AppState())
        .environmentObject(CartManager())
}
