import SwiftUI

/// Root router. Drives the four-tab `MainTabView` for everyone — the
/// difference between an authenticated user and a guest is which tab
/// they land on, not whether they get a tab bar.
///
/// - **Logged out:** opens to the Home tab, where the
///   `AccountAvatarButton` is the sign-in entry — tapping it presents
///   `WelcomeView` (the cold-open join surface) as a sheet, and sign-in
///   and register are presented as sheets from the welcome CTAs. The Menu
///   tab is a public endpoint and remains browsable for guests; Cart /
///   Orders are reachable but not yet guest-aware — see Navigation README
///   "Follow-ups" for the guest-gating commits that finish that work.
/// - **Logged in:** opens to the Menu tab — the user's launch job-to-be-
///   done is "order a coffee."
///
/// When `Notification.Name.authRequired` fires (refresh-token expired,
/// token revoked, etc.), `AppState.logout()` flips `authState` back to
/// `.loggedOut` and this view re-evaluates the tab tree into its guest
/// configuration. Note that App-scoped state (`CartManager`,
/// `FavoritesStore`) is NOT torn down by that swap — it lives on
/// `PulseCoffeeApp`, above this view. Per-user state is reset via the
/// `.didLogout` signal `AppState.logout()` posts (CartManager clears
/// the cart + cached idempotency key on receipt).
struct ContentView: View {

    @EnvironmentObject private var appState: AppState

    var body: some View {
        switch appState.authState {
        case .loggedOut:
            MainTabView(initialTab: .home)

        case .loggedIn:
            MainTabView(initialTab: .menu)
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(AppState())
        .environmentObject(CartManager())
        .environmentObject(FavoritesStore())
}
