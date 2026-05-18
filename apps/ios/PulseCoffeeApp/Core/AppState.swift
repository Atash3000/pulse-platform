import Foundation
import Sentry
import SwiftUI

/// Root state machine for the Pulse Coffee iOS app.
///
/// Owns the auth lifecycle:
/// - **Bootstrap** on launch reads Keychain synchronously. If both tokens
///   and a customer profile are present, transitions immediately to
///   `.loggedIn(profile)`; otherwise stays `.loggedOut`. Synchronous so
///   there's no spinner on launch — Keychain reads on Simulator/device
///   take single-digit milliseconds.
/// - **Login / register** call the backend, persist tokens + profile in
///   Keychain, transition to `.loggedIn`.
/// - **Logout** clears Keychain and transitions to `.loggedOut`. Called
///   from the toolbar Sign Out button AND automatically when
///   `Notification.Name.authRequired` is posted (refresh-token expired,
///   token revoked).
///
/// Injected via `@StateObject` in `PulseCoffeeApp.swift` and propagated
/// via `.environmentObject` so any view can read `authState`.
@MainActor
final class AppState: ObservableObject {

    enum AuthState: Equatable {
        case loggedOut
        case loggedIn(CustomerProfile)
    }

    @Published private(set) var authState: AuthState = .loggedOut

    private let api: APIClient
    private var authRequiredObserver: NSObjectProtocol?

    init(api: APIClient = .shared) {
        self.api = api
        bootstrap()
        subscribeToAuthRequired()
    }

    deinit {
        if let observer = authRequiredObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    // MARK: - Public API

    /// Authenticate against `POST /auth/login`. On success, the response
    /// tokens + customer profile are persisted in Keychain and the
    /// state transitions to `.loggedIn`. On failure, the state stays
    /// where it was and the underlying error is rethrown for the view
    /// model to map to user-facing copy.
    func login(email: String, password: String) async throws {
        let request = LoginRequest(email: email, password: password)
        let response: AuthResponse = try await api.post("/auth/login", body: request)
        try persistAuth(response)
    }

    /// Create a new account via `POST /auth/register` and authenticate
    /// in one round trip. Backend returns the same `AuthResponse` shape
    /// as `/login` (tokens + profile), so the persist path is identical.
    func register(email: String, password: String, fullName: String, phone: String?) async throws {
        let request = RegisterRequest(
            email: email,
            password: password,
            fullName: fullName,
            phone: phone
        )
        let response: AuthResponse = try await api.post("/auth/register", body: request)
        try persistAuth(response)
    }

    /// Clear all auth data and return to the login screen.
    ///
    /// `try?` on `Keychain.clearAll()` is deliberate: if Keychain throws
    /// (rare; usually on locked devices), we still want to flip
    /// `authState` to `.loggedOut` so the UI is consistent. Stale
    /// unreachable tokens on disk are less harmful than a user stuck
    /// on the menu screen with no way out.
    func logout() async {
        try? Keychain.clearAll()
        authState = .loggedOut
    }

    // MARK: - Private

    /// Reads Keychain on init. Both tokens AND profile must be present
    /// to enter `.loggedIn`. Tokens-but-no-profile is an inconsistent
    /// state (rare, possible after a Keychain corruption event) — we
    /// treat it as logged-out, forcing the user back through the login
    /// flow which will repopulate Keychain cleanly.
    private func bootstrap() {
        do {
            guard
                let token = try Keychain.loadAccessToken(),
                !token.isEmpty,
                let customer = try Keychain.loadCustomer()
            else {
                return  // Stays `.loggedOut`.
            }
            authState = .loggedIn(customer)
        } catch {
            // Keychain read failed on launch — surface to Sentry but
            // proceed as logged-out so the user can recover by signing
            // in again.
            SentrySDK.capture(error: error)
        }
    }

    /// Subscribes to `Notification.Name.authRequired`. Posted by
    /// `TokenRefresher` (refresh-token expired) and `APIClient`
    /// (second 401 after refresh-retry). Triggers logout on receipt.
    ///
    /// The observer captures `self` weakly and hops onto the main thread
    /// for the actual state mutation — actor isolation requires it.
    private func subscribeToAuthRequired() {
        authRequiredObserver = NotificationCenter.default.addObserver(
            forName: .authRequired,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.logout()
            }
        }
    }

    private func persistAuth(_ response: AuthResponse) throws {
        try Keychain.saveAccessToken(response.accessToken)
        try Keychain.saveRefreshToken(response.refreshToken)
        try Keychain.saveCustomer(response.customer)
        authState = .loggedIn(response.customer)
    }
}
