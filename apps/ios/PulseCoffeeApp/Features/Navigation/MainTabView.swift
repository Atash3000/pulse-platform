import SwiftUI

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
        let symbol = selection == tab ? tab.selectedSymbolName : tab.symbolName
        Label(tab.title, systemImage: symbol)
    }
}

#Preview {
    MainTabView()
        .environmentObject(AppState())
        .environmentObject(CartManager())
}
