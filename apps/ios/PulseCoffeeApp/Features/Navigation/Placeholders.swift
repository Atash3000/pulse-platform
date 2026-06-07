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
                .toolbar {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        AccountAvatarButton()
                    }
                }
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

struct RewardsView: View {
    var body: some View {
        NavigationStack {
            PlaceholderContent(tab: .rewards,
                               caption: "10 drinks = 1 free. Track your progress here once the loyalty backend ships.")
                .navigationTitle(MainTab.rewards.title)
        }
    }
}

/// Account tab — splits on auth state.
///
/// - Logged out: the `WelcomeView` cold-open / join surface. This is the
///   landing tab for guests (set in `ContentView`), so this is the first
///   thing an un-registered user sees.
/// - Logged in: the existing placeholder, until the real profile UI
///   lands (see Navigation README build sequence).
///
/// `WelcomeView` renders its own full-bleed hero and doesn't want a
/// nav-bar; the placeholder branch keeps `NavigationStack` for parity
/// with the other placeholder tabs (and so the eventual profile screen
/// has somewhere to push from).
struct AccountView: View {

    @EnvironmentObject private var appState: AppState

    var body: some View {
        switch appState.authState {
        case .loggedOut:
            WelcomeView()

        case .loggedIn:
            NavigationStack {
                VStack(spacing: 24) {
                    PlaceholderContent(tab: .account,
                                       caption: "Profile, payment methods, and order history land here.")
                    // Temporary sign-out CTA. Moved off the Menu toolbar when
                    // the v4 topbar landed; will live inside a proper profile
                    // screen once the Account tab gets real content.
                    Button(role: .destructive) {
                        Task { await appState.logout() }
                    } label: {
                        Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                            .font(.body.weight(.semibold))
                    }
                    .buttonStyle(.bordered)
                    .padding(.bottom, 32)
                }
                .navigationTitle(MainTab.account.title)
            }
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
#Preview("Rewards") { RewardsView() }
#Preview("Account — guest") {
    AccountView().environmentObject(AppState())
}
