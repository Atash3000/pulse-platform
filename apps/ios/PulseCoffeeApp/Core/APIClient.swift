import Foundation
import Sentry

/// The single network entry point for the Pulse Coffee iOS app.
///
/// All HTTP traffic to the backend goes through `APIClient`. Per
/// `docs/ai-onboarding/ios.md` definition-of-done, no view or view-model
/// performs an ad-hoc `URLSession` call.
///
/// Responsibilities (commit #3 — APIClient foundation):
/// - Build URLs from `AppConfig.apiBaseURL` + path + query.
/// - Encode Encodable request bodies as JSON.
/// - Inject `Authorization: Bearer <jwt>` from `Keychain` when a token is
///   present. No-op if Keychain is empty (commit #4 populates Keychain
///   via the login flow).
/// - Decode 2xx responses into the caller's `Decodable` type using
///   per-model `CodingKeys` (no global snake_case strategy — see
///   decision-log "[iOS] Contracts source of truth").
/// - Map 401 responses to `APIError.authRequired`. Refresh-or-login
///   handling lives in commit #4 (auth coordinator); commit #3 only
///   surfaces the signal.
/// - Map 4xx/5xx responses to `APIError.serverError(ServerError, statusCode:)`
///   when the body decodes as a structured error, otherwise
///   `APIError.unexpected(statusCode:)`.
/// - Emit a Sentry breadcrumb on 401 so the auth coordinator has context
///   when it retries. The `Authorization` header value is auto-redacted
///   by `SentryRedactor` before any breadcrumb leaves the device.
///
/// Out of scope for commit #3:
/// - Refresh-token retry loop (commit #4).
/// - In-flight request deduplication during a refresh (commit #4).
/// - Per-endpoint rate-limit handling (the backend rate limits per IP;
///   iOS observes 429 and surfaces a generic "try again" error).
///
/// Implemented as an `actor` so all access is serialised — eliminates
/// data races on the underlying `URLSession` and `JSONDecoder` and
/// satisfies `SWIFT_STRICT_CONCURRENCY=complete`.
actor APIClient {

    /// App-wide default instance. Tests inject a custom `URLSession`
    /// with `URLProtocol`-based stubbing — see `APIClientTests`.
    static let shared = APIClient()

    private let session: URLSession
    private let baseURL: URL
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    /// `tokenProvider` is injectable so tests can substitute Keychain
    /// access. Default reads from the real Keychain.
    private let tokenProvider: @Sendable () throws -> String?

    /// `refresher` is the token-refresh dedup primitive. Injected for
    /// tests; defaults to the shared singleton in production. See
    /// `TokenRefresher.swift` for the dedup pattern and breadcrumb
    /// trail rationale.
    private let refresher: TokenRefresher

    init(
        session: URLSession = .shared,
        baseURL: URL = AppConfig.apiBaseURL,
        tokenProvider: @Sendable @escaping () throws -> String? = { try Keychain.loadAccessToken() },
        refresher: TokenRefresher = .shared
    ) {
        self.session = session
        self.baseURL = baseURL
        self.tokenProvider = tokenProvider
        self.refresher = refresher

        let d = JSONDecoder()
        // No global key strategy. Each Codable carries explicit
        // `CodingKeys` for its snake_case fields — see decision-log.
        d.dateDecodingStrategy = .iso8601
        self.decoder = d

        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        self.encoder = e
    }

    // MARK: - Public API

    /// GET request, no body.
    func get<T: Decodable>(
        _ path: String,
        query: [URLQueryItem] = []
    ) async throws -> T {
        try await perform(.get, path: path, query: query, body: nil)
    }

    /// POST request with a JSON body.
    func post<T: Decodable, B: Encodable>(
        _ path: String,
        body: B,
        query: [URLQueryItem] = []
    ) async throws -> T {
        let data = try encoder.encode(body)
        return try await perform(.post, path: path, query: query, body: data)
    }

    /// PUT request with a JSON body.
    func put<T: Decodable, B: Encodable>(
        _ path: String,
        body: B,
        query: [URLQueryItem] = []
    ) async throws -> T {
        let data = try encoder.encode(body)
        return try await perform(.put, path: path, query: query, body: data)
    }

    /// DELETE request, no body.
    func delete<T: Decodable>(
        _ path: String,
        query: [URLQueryItem] = []
    ) async throws -> T {
        try await perform(.delete, path: path, query: query, body: nil)
    }

    // MARK: - Internal

    enum HTTPMethod: String {
        case get = "GET"
        case post = "POST"
        case put = "PUT"
        case delete = "DELETE"
    }

    private func perform<T: Decodable>(
        _ method: HTTPMethod,
        path: String,
        query: [URLQueryItem],
        body: Data?,
        isRetry: Bool = false
    ) async throws -> T {
        let request = try buildRequest(method: method, path: path, query: query, body: body)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.network(error)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.unexpected(statusCode: -1)
        }

        switch http.statusCode {
        case 200..<300:
            do {
                return try decoder.decode(T.self, from: data)
            } catch {
                throw APIError.decoding(error)
            }

        case 401:
            // A 401 from the backend can mean two structurally different
            // things, and conflating them caused a real bug (see
            // decision-log "[iOS] APIClient 401 heuristic — distinguishing
            // JWT failures from downstream 401s"):
            //
            // 1. **The customer's JWT is bad** (NestJS AuthGuard rejected
            //    it). Body: `{statusCode:401, message:"Unauthorized"}`.
            //    Correct response: refresh the token, retry once, and
            //    log the user out only if the refresh-and-retry path
            //    also 401s.
            //
            // 2. **The backend has a downstream-service 401** (Stripe API
            //    key misconfigured, Clover credentials wrong, etc.).
            //    Body example: `{statusCode:401, message:"Invalid API
            //    Key provided: sk_test_..."}`. The customer's auth is
            //    fine — kicking them to login is wrong; they'd reach
            //    the same failure on next login.
            //
            // Heuristic: decode the response body and check whether the
            // message matches NestJS's auth-guard patterns. If not, treat
            // as a generic `serverError(401)` so the caller can surface
            // an actionable error without triggering logout.
            let serverError = try? decoder.decode(ServerError.self, from: data)
            let looksLikeJWTFailure = Self.isJWTAuthFailure(serverError)

            let crumb = Breadcrumb(level: .info, category: "api.auth")
            crumb.message = looksLikeJWTFailure
                ? (isRetry
                    ? "401 from \(method.rawValue) \(path) — second 401 after refresh, surfacing authRequired"
                    : "401 from \(method.rawValue) \(path) — JWT failure, attempting refresh")
                : "401 from \(method.rawValue) \(path) — downstream-service 401 (not a JWT issue), surfacing as serverError"
            crumb.type = "http"
            crumb.data = [
                "method": method.rawValue,
                "path": path,
                "status_code": 401,
                "is_retry": isRetry,
                "is_jwt_failure": looksLikeJWTFailure,
            ]
            SentrySDK.addBreadcrumb(crumb)

            if !looksLikeJWTFailure {
                // Downstream 401 — pass through to the caller as a
                // server error. Caller's APIError mapping shows a
                // generic copy; user is NOT logged out.
                if let serverError {
                    throw APIError.serverError(serverError, statusCode: 401)
                }
                throw APIError.unexpected(statusCode: 401)
            }

            if isRetry {
                NotificationCenter.default.post(name: .authRequired, object: nil)
                throw APIError.authRequired
            }

            do {
                _ = try await refresher.refresh()
            } catch {
                // TokenRefresher already posted authRequired on its own
                // path; just propagate the error.
                throw APIError.authRequired
            }

            return try await perform(method, path: path, query: query, body: body, isRetry: true)

        case 429:
            // Throttler 429 — NestJS Throttler returns
            // `{statusCode:429, message:"ThrottlerException: Too Many Requests"}`
            // which is decodable by ServerError but the view layer wants
            // a clean discriminator. Surface a dedicated case so view
            // models can map "too many attempts" copy without parsing
            // status codes out of `unexpected(429)`.
            throw APIError.rateLimited

        default:
            // 4xx/5xx — try to decode the structured error body. Fall
            // through to `unexpected(statusCode:)` if the body doesn't
            // match either of `ServerError`'s known shapes.
            if let serverError = try? decoder.decode(ServerError.self, from: data) {
                throw APIError.serverError(serverError, statusCode: http.statusCode)
            }
            throw APIError.unexpected(statusCode: http.statusCode)
        }
    }

    /// Returns true if a 401 response body looks like a NestJS AuthGuard
    /// rejection (JWT missing / invalid / expired). Returns false for
    /// downstream-service 401s (Stripe API-key error, Clover auth failure,
    /// etc.) that the backend may have passed through without translation.
    ///
    /// Heuristic — matches NestJS's standard auth-failure messages:
    /// - `"Unauthorized"` — the default AuthGuard reject message.
    /// - Anything containing `"jwt"` — `"jwt expired"`, `"jwt malformed"`,
    ///   `"jwt signature is invalid"`, etc. from passport-jwt.
    /// - `"No auth token"` — common passport variant.
    ///
    /// Conservative fallback: if the body is unparseable, treat as a JWT
    /// failure so the refresh path still runs. Worst case the user gets
    /// an extra refresh round-trip on an unrelated error; that's strictly
    /// better than the old behavior of always logging them out.
    private static func isJWTAuthFailure(_ serverError: ServerError?) -> Bool {
        guard let message = serverError?.message, !message.isEmpty else {
            return true
        }
        let lower = message.lowercased()
        if lower == "unauthorized" { return true }
        if lower.contains("jwt") { return true }
        if lower.contains("no auth token") { return true }
        if lower.contains("authentication") && !lower.contains("api key") {
            return true
        }
        return false
    }

    private func buildRequest(
        method: HTTPMethod,
        path: String,
        query: [URLQueryItem],
        body: Data?
    ) throws -> URLRequest {
        let fullURL = baseURL.appendingPathComponent(path)
        guard var components = URLComponents(url: fullURL, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidURL
        }
        if !query.isEmpty {
            components.queryItems = query
        }
        guard let url = components.url else {
            throw APIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method.rawValue
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        // Inject Authorization header if a token is present. Empty
        // token (not yet logged in) → no header sent; backend treats it
        // as an unauthenticated request and the controller's guard
        // rejects it with 401 → `APIError.authRequired` as expected.
        //
        // We deliberately swallow Keychain errors here and proceed
        // without the header — the alternative (failing the request on
        // a transient SecItemCopyMatching failure) is worse UX than
        // letting the request through and getting a 401 from the server.
        // Keychain errors are also logged to Sentry via the
        // tokenProvider closure's own error handling in commit #4.
        if let token = try? tokenProvider(), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        if let body = body {
            request.httpBody = body
        }

        return request
    }
}

/// Errors thrown by `APIClient.*` methods.
///
/// Marked `@unchecked Sendable` because the `network` and `decoding`
/// cases hold `Error` instances whose Sendable status depends on the
/// concrete error type. In practice every error we encounter is value-
/// type-backed (URLError, DecodingError, custom enums) and safe to
/// pass across actor boundaries.
enum APIError: Error, @unchecked Sendable {
    /// URL could not be built from `baseURL + path + query`.
    case invalidURL

    /// Networking layer failure (no connection, timeout, TLS, etc.).
    /// Underlying `URLError` available in the associated value.
    case network(Error)

    /// Response body did not decode into the requested type.
    /// Underlying `DecodingError` available in the associated value.
    case decoding(Error)

    /// Backend returned a 4xx/5xx with a structured error body.
    /// `statusCode` preserved so callers can branch on it
    /// (e.g. 409 conflict needs different UX than 400 validation).
    case serverError(ServerError, statusCode: Int)

    /// Backend rejected the request after one refresh-retry cycle, OR
    /// the refresh itself returned 401. `AppState` listens for the
    /// matching `Notification.Name.authRequired` post and transitions
    /// the UI to the login screen.
    case authRequired

    /// HTTP 429 — backend's throttler rejected the request. View
    /// layers map this to "too many attempts, please wait" copy.
    /// Surfaces as a discrete case (not `unexpected(429)`) so view
    /// models don't have to parse status codes out of unrelated paths.
    case rateLimited

    /// Backend returned a non-2xx status that didn't match any of
    /// the known structured-error shapes. The status code is
    /// preserved for logging / generic error UI.
    case unexpected(statusCode: Int)
}
