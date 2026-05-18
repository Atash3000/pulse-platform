import Foundation
import Sentry

/// Refreshes the access token via `POST /api/v1/auth/refresh`.
///
/// **Dedup pattern.** When `APIClient` encounters a 401 it calls
/// `refresh()`. Concurrent 401s from multiple in-flight requests all
/// hit `refresh()` simultaneously. Without dedup, each 401 produces its
/// own refresh call — three requests in, three refresh tokens out, only
/// the last one persists in Keychain, the other two retries use stale
/// tokens, cascading failures. With dedup, the first call to `refresh()`
/// starts the network task; subsequent concurrent calls return the same
/// task's result. One refresh in, one new token, all original requests
/// retry with the same token. (See CTO chat decision on this pattern.)
///
/// **Why a separate URLSession (not `APIClient`).** `TokenRefresher` is
/// called from inside `APIClient.perform()`. If `TokenRefresher` reused
/// `APIClient`, a refresh request that itself got 401 would re-enter
/// the same retry path, recursing infinitely. The separate session
/// + direct call keeps the recursion impossible.
///
/// **Sentry breadcrumbs.** Each refresh attempt emits three potential
/// breadcrumbs (before / success / failure). Per the CTO addition: when
/// debugging "why did this user get logged out in production?" the
/// breadcrumb trail is gold. The `SentryRedactor` ensures no token
/// values leak.
actor TokenRefresher {
    static let shared = TokenRefresher()

    private var inFlightTask: Task<String, Error>?

    private let baseURL: URL
    private let session: URLSession
    private let refreshTokenProvider: @Sendable () throws -> String?
    private let accessTokenWriter: @Sendable (String) throws -> Void

    init(
        baseURL: URL = AppConfig.apiBaseURL,
        session: URLSession = .shared,
        refreshTokenProvider: @Sendable @escaping () throws -> String? = { try Keychain.loadRefreshToken() },
        accessTokenWriter: @Sendable @escaping (String) throws -> Void = { try Keychain.saveAccessToken($0) }
    ) {
        self.baseURL = baseURL
        self.session = session
        self.refreshTokenProvider = refreshTokenProvider
        self.accessTokenWriter = accessTokenWriter
    }

    /// Returns a fresh access token, deduplicating concurrent callers.
    ///
    /// Throws `APIError.authRequired` if the refresh token is missing,
    /// expired, or revoked. In that case `Notification.Name.authRequired`
    /// has also been posted so `AppState` can transition the UI.
    func refresh() async throws -> String {
        if let existing = inFlightTask {
            return try await existing.value
        }

        let task = Task<String, Error> {
            // `defer { inFlightTask = nil }` runs whether the task
            // returns, throws, or is cancelled — guarantees that a
            // failed refresh doesn't permanently block future attempts.
            defer { inFlightTask = nil }
            return try await performRefresh()
        }
        inFlightTask = task
        return try await task.value
    }

    #if DEBUG
    /// Test-only inspector. Lets `TokenRefresherTests` assert that the
    /// `inFlightTask` slot is correctly cleared after success / failure
    /// without relying on indirect behavioural tests.
    internal func _inFlightTaskIsNil() -> Bool {
        inFlightTask == nil
    }
    #endif

    // MARK: - Internals

    private func performRefresh() async throws -> String {
        addBreadcrumb(level: .info, message: "TokenRefresher: attempting refresh")

        let refreshToken: String?
        do {
            refreshToken = try refreshTokenProvider()
        } catch {
            addBreadcrumb(level: .error, message: "TokenRefresher: keychain read failed: \(error)")
            postAuthRequired()
            throw APIError.authRequired
        }

        guard let token = refreshToken, !token.isEmpty else {
            addBreadcrumb(level: .warning, message: "TokenRefresher: no refresh token available")
            postAuthRequired()
            throw APIError.authRequired
        }

        let requestBody: Data
        do {
            requestBody = try JSONEncoder().encode(RefreshRequest(refreshToken: token))
        } catch {
            addBreadcrumb(level: .error, message: "TokenRefresher: encode body failed: \(error)")
            throw APIError.decoding(error)
        }

        var request = URLRequest(url: baseURL.appendingPathComponent("/auth/refresh"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = requestBody

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            addBreadcrumb(level: .error, message: "TokenRefresher: network error \(error.localizedDescription)")
            throw APIError.network(error)
        }

        guard let http = response as? HTTPURLResponse else {
            addBreadcrumb(level: .error, message: "TokenRefresher: non-HTTP response")
            throw APIError.unexpected(statusCode: -1)
        }

        switch http.statusCode {
        case 200..<300:
            do {
                let refreshResponse = try JSONDecoder().decode(RefreshResponse.self, from: data)
                try accessTokenWriter(refreshResponse.accessToken)
                addBreadcrumb(level: .info, message: "TokenRefresher: refresh succeeded")
                return refreshResponse.accessToken
            } catch {
                addBreadcrumb(level: .error, message: "TokenRefresher: decode/save failed: \(error)")
                throw APIError.decoding(error)
            }

        case 401:
            addBreadcrumb(level: .warning, message: "TokenRefresher: refresh failed, status=401")
            postAuthRequired()
            throw APIError.authRequired

        case 429:
            addBreadcrumb(level: .warning, message: "TokenRefresher: refresh rate-limited (status=429)")
            throw APIError.rateLimited

        default:
            addBreadcrumb(level: .error, message: "TokenRefresher: refresh failed, status=\(http.statusCode)")
            throw APIError.unexpected(statusCode: http.statusCode)
        }
    }

    private func addBreadcrumb(level: SentryLevel, message: String) {
        let crumb = Breadcrumb(level: level, category: "auth.refresh")
        crumb.message = message
        crumb.type = "info"
        SentrySDK.addBreadcrumb(crumb)
    }

    private func postAuthRequired() {
        // NotificationCenter is thread-safe; posting from inside an actor
        // does not require a hop to the main thread.
        NotificationCenter.default.post(name: .authRequired, object: nil)
    }
}
