import SwiftUI

// Stub screens for the Home / Orders tabs. They render a title, a
// tab-appropriate SF Symbol, and a "coming soon" caption so the tab bar
// is wired end-to-end before the real screens land. Each gets its own
// `NavigationStack` so its in-tab navigation history (when content
// arrives) lives independently of the other tabs.
//
// `AccountView` is no longer a tab — it is reached via the
// `AccountAvatarButton` on Home — but keeps its placeholder for the
// logged-in profile surface until the real screen lands.

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

/// Account surface — splits on auth state. No longer a tab; reached via
/// the `AccountAvatarButton` on Home, which presents this as a sheet.
///
/// - Logged out: the `WelcomeView` cold-open / join surface — the sign-in
///   entry a guest sees when they tap the Home avatar.
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
                    PlaceholderContent(title: "Account",
                                       symbolName: "person.crop.circle.fill",
                                       caption: "Profile, payment methods, and order history land here.")
                    // Temporary sign-out CTA. Will live inside a proper profile
                    // screen once Account (reached via the Home avatar sheet)
                    // gets real content.
                    Button(role: .destructive) {
                        Task { await appState.logout() }
                    } label: {
                        Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                            .font(.body.weight(.semibold))
                    }
                    .buttonStyle(.bordered)
                    .padding(.bottom, 32)
                }
                .navigationTitle("Account")
            }
        }
    }
}

private struct PlaceholderContent: View {
    let title: String
    let symbolName: String
    let caption: String

    /// Convenience init for the real tabs, which derive their title and
    /// symbol from the `MainTab` model.
    init(tab: MainTab, caption: String) {
        self.init(title: tab.title,
                  symbolName: tab.selectedSymbolName,
                  caption: caption)
    }

    /// Designated init for surfaces that are no longer modelled as a
    /// `MainTab` case (e.g. the logged-in Account profile placeholder).
    init(title: String, symbolName: String, caption: String) {
        self.title = title
        self.symbolName = symbolName
        self.caption = caption
    }

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: symbolName)
                .font(.system(size: 56))
                .foregroundStyle(.secondary)
            Text("\(title) — coming soon")
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

#Preview("Orders")  { OrdersView() }
#Preview("Rewards") { RewardsView() }
#Preview("Account — guest") {
    AccountView().environmentObject(AppState())
}
