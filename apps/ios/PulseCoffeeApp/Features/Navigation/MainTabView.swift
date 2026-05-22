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
            tabContent(.home) { HomeView() }
            tabContent(.menu) { MenuView() }
            tabContent(.orders) { OrdersView() }
            tabContent(.account) { AccountView() }
        }
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

    var body: some View {
        HStack(spacing: 0) {
            ForEach(MainTab.allCases) { tab in
                Button {
                    selection = tab
                } label: {
                    tabLabel(tab)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tab.title)
                .accessibilityValue(selection == tab ? "Selected" : "")
            }
        }
        .frame(height: AppTheme.Metrics.tabBarHeight)
        .padding(.horizontal, 18)
        .background(AppTheme.Colors.tabBarBackground)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(AppTheme.Colors.divider.opacity(0.35))
                .frame(height: 1)
        }
    }

    private func tabLabel(_ tab: MainTab) -> some View {
        let isSelected = selection == tab
        return VStack(spacing: 3) {
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
                .resizable()
                .scaledToFit()
                .frame(width: AppTheme.Metrics.tabBarIconSize,
                       height: AppTheme.Metrics.tabBarIconSize)
        } else {
            Image(systemName: isSelected ? tab.selectedSymbolName : tab.tabBarSymbolName)
                .font(.system(size: AppTheme.Metrics.tabBarIconSize,
                              weight: isSelected ? .semibold : .regular))
        }
    }
}

#Preview {
    MainTabView()
        .environmentObject(AppState())
        .environmentObject(CartManager())
}
