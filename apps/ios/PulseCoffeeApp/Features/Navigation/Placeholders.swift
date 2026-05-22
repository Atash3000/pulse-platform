import SwiftUI

// Stub screens for the Home / Orders / Account tabs. They render a
// title, a tab-appropriate SF Symbol, and a "coming soon" caption so
// the tab bar is wired end-to-end before the real screens land.
// Each gets its own `NavigationStack` so its in-tab navigation history
// (when content arrives) lives independently of the other tabs.

struct HomeView: View {
    var body: some View {
        NavigationStack {
            PlaceholderContent(tab: .home,
                               caption: "Featured drinks, promos, and nearby locations land here.")
                .navigationTitle(MainTab.home.title)
        }
    }
}

struct OrdersView: View {
    var body: some View {
        NavigationStack {
            PlaceholderContent(tab: .orders,
                               caption: "Your in-progress and past orders will appear here.")
                .navigationTitle(MainTab.orders.title)
        }
    }
}

struct AccountView: View {
    var body: some View {
        NavigationStack {
            PlaceholderContent(tab: .account,
                               caption: "Profile, payment methods, and sign-out move here.")
                .navigationTitle(MainTab.account.title)
        }
    }
}

private struct PlaceholderContent: View {
    let tab: MainTab
    let caption: String

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: tab.selectedSymbolName)
                .font(.system(size: 56))
                .foregroundStyle(.secondary)
            Text("\(tab.title) — coming soon")
                .font(.headline)
            Text(caption)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

#Preview("Home")    { HomeView() }
#Preview("Orders")  { OrdersView() }
#Preview("Account") { AccountView() }
