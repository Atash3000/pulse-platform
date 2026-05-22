import SwiftUI

/// Root router. Switches between `LoginView` (unauthenticated) and
/// `MainTabView` (authenticated) based on `AppState.authState`.
///
/// When `Notification.Name.authRequired` fires (refresh-token expired,
/// token revoked, etc.), `AppState.logout()` flips `authState` back to
/// `.loggedOut`, the view tree re-evaluates here, and any in-flight
/// SwiftUI state inside the tab tree is naturally torn down (cart in
/// memory, view-model state, selected tab) — no explicit reset needed
/// beyond Keychain clearing in `AppState.logout`.
struct ContentView: View {

    @EnvironmentObject private var appState: AppState

    var body: some View {
        switch appState.authState {
        case .loggedOut:
            LoginView(appState: appState)

        case .loggedIn:
            MainTabView()
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(AppState())
}
