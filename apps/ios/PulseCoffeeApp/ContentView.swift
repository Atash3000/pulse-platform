import SwiftUI

/// Root router. Drives the four-tab `MainTabView` for everyone — the
/// difference between an authenticated user and a guest is which tab
/// they land on, not whether they get a tab bar.
///
/// - **Logged out:** opens to the Account tab. `AccountView` renders
///   `WelcomeView` (the cold-open join surface). Sign-in and register
///   are presented as sheets from the welcome CTAs. The Menu tab is a
///   public endpoint and remains browsable for guests; Cart / Orders /
///   Home are reachable but not yet guest-aware — see Navigation README
///   "Follow-ups" for the guest-gating commits that finish that work.
/// - **Logged in:** opens to the Menu tab — the user's launch job-to-be-
///   done is "order a coffee."
///
/// When `Notification.Name.authRequired` fires (refresh-token expired,
/// token revoked, etc.), `AppState.logout()` flips `authState` back to
/// `.loggedOut`, this view re-evaluates, the tab tree swaps to its
/// guest configuration, and any in-flight SwiftUI state inside the tab
/// tree is naturally torn down (cart in memory, view-model state) — no
/// explicit reset needed beyond Keychain clearing in `AppState.logout`.
struct ContentView: View {

    @EnvironmentObject private var appState: AppState

    var body: some View {
        switch appState.authState {
        case .loggedOut:
            MainTabView(initialTab: .account)

        case .loggedIn:
            MainTabView(initialTab: .menu)
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(AppState())
}
