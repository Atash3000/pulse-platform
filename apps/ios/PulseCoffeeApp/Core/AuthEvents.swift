import Foundation

extension Notification.Name {
    /// Broadcast when the API client encounters an authentication failure
    /// that can't be recovered by a token refresh — either the refresh
    /// token itself was rejected, or a request still 401'd after a
    /// successful refresh (token revoked / customer disabled between
    /// refresh and retry).
    ///
    /// `AppState` subscribes to this notification in its `init` and
    /// triggers `logout()` on receipt, transitioning the UI back to the
    /// login screen.
    ///
    /// Posted from:
    /// - `TokenRefresher.performRefresh` when `/auth/refresh` returns 401.
    /// - `APIClient.perform` when a 401-retry-with-fresh-token still 401s.
    ///
    /// `object` and `userInfo` are both nil — receivers only care that
    /// the event happened. See decision-log entry "[iOS] Auth foundation
    /// — AppState, TokenRefresher, login/register UI".
    static let authRequired = Notification.Name("com.pulsecoffee.app.auth.required")

    /// Broadcast by `AppState.logout()` after the session has been torn
    /// down (Keychain cleared, `authState` flipped to `.loggedOut`).
    /// Fires for BOTH logout paths — the explicit Sign Out button and the
    /// forced path where `.authRequired` triggers `AppState.logout()`.
    ///
    /// Subscribers reset per-user in-memory state that outlives the auth
    /// flip. Today that's `CartManager` (App-scoped; clears cart lines +
    /// the cached checkout idempotency key so user B never sees — or pays
    /// for — user A's cart).
    ///
    /// `object` and `userInfo` are both nil — receivers only care that
    /// the event happened.
    static let didLogout = Notification.Name("com.pulsecoffee.app.auth.logged-out")
}
