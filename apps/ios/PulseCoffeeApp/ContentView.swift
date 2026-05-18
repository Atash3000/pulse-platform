import SwiftUI

/// Root router. Switches between `LoginView` (unauthenticated) and
/// `MenuView` (authenticated) based on `AppState.authState`.
///
/// When `Notification.Name.authRequired` fires (refresh-token expired,
/// token revoked, etc.), `AppState.logout()` flips `authState` back to
/// `.loggedOut`, the view tree re-evaluates here, and any in-flight
/// SwiftUI state inside `MenuView` is naturally torn down (cart in
/// memory, view-model state) — no explicit reset needed beyond
/// Keychain clearing in `AppState.logout`.
struct ContentView: View {

    @EnvironmentObject private var appState: AppState

    var body: some View {
        switch appState.authState {
        case .loggedOut:
            LoginView(appState: appState)

        case .loggedIn:
            MenuView()
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(AppState())
}
