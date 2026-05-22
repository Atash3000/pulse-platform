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
        .background(AppTheme.Colors.tabBarBackground.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) {
            Rectangle()
                .fill(AppTheme.Colors.divider.opacity(0.35))
                .frame(height: 1)
        }
    }

    private func tabLabel(_ tab: MainTab, isSelected: Bool) -> some View {
        VStack(spacing: 3) {
            icon(for: tab, isSelected: isSelected)
            Text(tab.title)
                .font(.caption.weight(isSelected ? .semibold : .regular))
        }
        .foregroundStyle(isSelected ? AppTheme.Colors.accent : .primary)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private func icon(for tab: MainTab, isSelected: Bool) -> some View {
        if let assetName = tab.customAssetName {
            Image(assetName)
                .renderingMode(.original)
                .resizable()
                .scaledToFit()
                .frame(width: iconSize, height: iconSize)
        } else {
            Image(systemName: isSelected ? tab.selectedSymbolName : tab.tabBarSymbolName)
                .font(.system(size: iconSize,
                              weight: isSelected ? .semibold : .regular))
        }
    }
}

#Preview {
    MainTabView()
        .environmentObject(AppState())
        .environmentObject(CartManager())
}
