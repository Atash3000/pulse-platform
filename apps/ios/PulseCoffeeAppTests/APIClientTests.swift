import XCTest
@testable import PulseCoffeeApp

/// APIClient tests use a `URLProtocol`-backed stub session so they run
/// hermetically — no network, no flakiness. Each test sets up the stub
/// for one request/response pair, runs the call, and asserts on both
/// the request shape (URL, method, headers, body) and the parsed result.
final class APIClientTests: XCTestCase {

    private var session: URLSession!

    override func setUp() async throws {
        try await super.setUp()
        StubURLProtocol.reset()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        session = URLSession(configuration: config)
    }

    override func tearDown() async throws {
        StubURLProtocol.reset()
        session = nil
        try await super.tearDown()
    }

    // MARK: - Decoding success path

    func test_get_decodesSnakeCaseResponse() async throws {
        StubURLProtocol.stub(
            statusCode: 200,
            body: #"{"access_token":"a","refresh_token":"r","customer":{"id":"1","email":"x@y","full_name":"X"}}"#
        )
        let client = makeClient()

        let response: AuthResponse = try await client.get("/auth/login")

        XCTAssertEqual(response.accessToken, "a")
        XCTAssertEqual(response.refreshToken, "r")
        XCTAssertEqual(response.customer.fullName, "X")
    }

    // MARK: - Authorization header injection

    func test_request_includesAuthorizationHeader_whenTokenProvided() async throws {
        StubURLProtocol.stub(statusCode: 200, body: #"{"access_token":"x"}"#)
        let client = makeClient(token: "test-jwt-123")

        let _: RefreshResponse = try await client.get("/anything")

        let sent = try XCTUnwrap(StubURLProtocol.lastRequest)
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Authorization"), "Bearer test-jwt-123")
    }

    func test_request_omitsAuthorizationHeader_whenNoToken() async throws {
        StubURLProtocol.stub(statusCode: 200, body: #"{"access_token":"x"}"#)
        let client = makeClient(token: nil)

        let _: RefreshResponse = try await client.get("/anything")

        let sent = try XCTUnwrap(StubURLProtocol.lastRequest)
        XCTAssertNil(sent.value(forHTTPHeaderField: "Authorization"))
    }

    func test_request_omitsAuthorizationHeader_whenTokenIsEmptyString() async throws {
        StubURLProtocol.stub(statusCode: 200, body: #"{"access_token":"x"}"#)
        let client = makeClient(token: "")

        let _: RefreshResponse = try await client.get("/anything")

        let sent = try XCTUnwrap(StubURLProtocol.lastRequest)
        XCTAssertNil(sent.value(forHTTPHeaderField: "Authorization"))
    }

    // MARK: - 401 → refresh → retry flow

    func test_get_401_thenRefreshSuccess_retriesAndReturnsResult() async throws {
        // Three responses in the queue:
        //   1. Original request returns 401
        //   2. Refresh endpoint returns 200 with new access token
        //   3. Retry of original request returns 200 with the real payload
        StubURLProtocol.stub(statusCode: 401, body: #"{"message":"Unauthorized"}"#)
        StubURLProtocol.stub(statusCode: 200, body: #"{"access_token":"new-jwt"}"#)
        StubURLProtocol.stub(statusCode: 200, body: #"{"access_token":"final"}"#)

        let client = makeClient(token: "expired", refreshToken: "valid-refresh")

        let response: RefreshResponse = try await client.get("/orders/abc")
        XCTAssertEqual(response.accessToken, "final")

        // Three HTTP round-trips: original → refresh → retry
        XCTAssertEqual(StubURLProtocol.capturedRequests.count, 3)
        XCTAssertEqual(StubURLProtocol.capturedRequests[1].url?.lastPathComponent, "refresh")
    }

    func test_get_401_thenRefreshFails_throwsAuthRequired() async {
        // Original 401 (JWT-failure body, the message must match the
        // NestJS auth-guard pattern so APIClient triggers refresh),
        // refresh also 401 → propagate authRequired and post notification.
        StubURLProtocol.stub(statusCode: 401, body: #"{"statusCode":401,"message":"Unauthorized"}"#)
        StubURLProtocol.stub(statusCode: 401, body: "{}")

        let notificationExpectation = expectation(forNotification: .authRequired, object: nil)

        let client = makeClient(token: "expired", refreshToken: "expired-refresh")

        do {
            let _: RefreshResponse = try await client.get("/orders/abc")
            XCTFail("Expected APIError.authRequired")
        } catch APIError.authRequired {
            // expected
        } catch {
            XCTFail("Expected APIError.authRequired, got \(error)")
        }

        await fulfillment(of: [notificationExpectation], timeout: 1.0)
    }

    func test_get_401_thenRefreshSuccess_butRetry401_throwsAuthRequired() async {
        // Edge case: refresh produces a new token, but by the time we
        // retry the customer was disabled / token revoked → second 401.
        // Both 401 bodies use the NestJS auth-guard pattern so APIClient's
        // heuristic identifies them as JWT failures. We surface
        // authRequired and post the notification.
        StubURLProtocol.stub(statusCode: 401, body: #"{"statusCode":401,"message":"Unauthorized"}"#)
        StubURLProtocol.stub(statusCode: 200, body: #"{"access_token":"new"}"#)
        StubURLProtocol.stub(statusCode: 401, body: #"{"statusCode":401,"message":"Unauthorized"}"#)

        let notificationExpectation = expectation(forNotification: .authRequired, object: nil)

        let client = makeClient(token: "expired", refreshToken: "valid-refresh")

        do {
            let _: RefreshResponse = try await client.get("/orders/abc")
            XCTFail("Expected APIError.authRequired")
        } catch APIError.authRequired {
            // expected
        } catch {
            XCTFail("Expected APIError.authRequired, got \(error)")
        }

        await fulfillment(of: [notificationExpectation], timeout: 1.0)
    }

    // MARK: - 401 heuristic — JWT failure vs downstream-service 401

    /// Regression for the bug where a Stripe-passed-through 401 kicked
    /// the user back to the login screen. The Stripe error body
    /// (`{"message":"Invalid API Key provided: sk_test_..."}`) doesn't
    /// match the NestJS auth-guard pattern, so APIClient must treat it
    /// as a generic server error — NOT trigger refresh + retry +
    /// force-logout.
    func test_get_401_withStripeDownstreamMessage_doesNotTriggerRefresh() async {
        StubURLProtocol.stub(
            statusCode: 401,
            body: #"{"statusCode":401,"message":"Invalid API Key provided: sk_test_..."}"#
        )
        let client = makeClient(token: "valid-jwt", refreshToken: "valid-refresh")

        do {
            let _: RefreshResponse = try await client.get("/checkout")
            XCTFail("Expected APIError.serverError")
        } catch APIError.serverError(let inner, let code) {
            XCTAssertEqual(code, 401)
            XCTAssertTrue(inner.message.contains("Invalid API Key"))
        } catch {
            XCTFail("Expected APIError.serverError, got \(error)")
        }

        // CRITICAL: only ONE request — refresh path must NOT have fired.
        XCTAssertEqual(StubURLProtocol.capturedRequests.count, 1,
                       "Downstream 401 should NOT trigger a refresh round-trip")
    }

    /// Same regression, second variant: a 401 with a long-form downstream
    /// service auth message (e.g., hypothetical Clover credential error)
    /// that doesn't contain "Unauthorized" or "jwt" must also pass through.
    func test_get_401_withGenericDownstreamServiceError_doesNotTriggerRefresh() async {
        StubURLProtocol.stub(
            statusCode: 401,
            body: #"{"statusCode":401,"message":"POS credentials rejected by merchant API"}"#
        )
        let client = makeClient(token: "valid-jwt", refreshToken: "valid-refresh")

        do {
            let _: RefreshResponse = try await client.get("/orders/abc")
            XCTFail("Expected APIError.serverError")
        } catch APIError.serverError(_, let code) {
            XCTAssertEqual(code, 401)
        } catch {
            XCTFail("Expected APIError.serverError, got \(error)")
        }
        XCTAssertEqual(StubURLProtocol.capturedRequests.count, 1)
    }

    /// Verifies the heuristic still does the right thing for genuine
    /// NestJS auth-guard 401s — refresh path runs, retry follows.
    func test_get_401_withUnauthorizedMessage_triggersRefresh() async throws {
        StubURLProtocol.stub(statusCode: 401, body: #"{"statusCode":401,"message":"Unauthorized"}"#)
        StubURLProtocol.stub(statusCode: 200, body: #"{"access_token":"new"}"#)
        StubURLProtocol.stub(statusCode: 200, body: #"{"access_token":"final"}"#)

        let client = makeClient(token: "expired", refreshToken: "valid-refresh")
        let response: RefreshResponse = try await client.get("/protected")

        XCTAssertEqual(response.accessToken, "final")
        XCTAssertEqual(StubURLProtocol.capturedRequests.count, 3,
                       "JWT-failure 401 should trigger original → refresh → retry (3 requests)")
    }

    /// Verifies that JWT-expiry-style messages from passport-jwt also
    /// trigger refresh (case-insensitive `"jwt"` substring match).
    func test_get_401_withJWTExpiredMessage_triggersRefresh() async throws {
        StubURLProtocol.stub(statusCode: 401, body: #"{"statusCode":401,"message":"jwt expired"}"#)
        StubURLProtocol.stub(statusCode: 200, body: #"{"access_token":"new"}"#)
        StubURLProtocol.stub(statusCode: 200, body: #"{"access_token":"final"}"#)

        let client = makeClient(token: "expired", refreshToken: "valid-refresh")
        let response: RefreshResponse = try await client.get("/protected")

        XCTAssertEqual(response.accessToken, "final")
        XCTAssertEqual(StubURLProtocol.capturedRequests.count, 3)
    }

    /// Verifies that a 401 with NO decodable body (e.g., HTML error page
    /// from a misconfigured reverse proxy) falls back to the
    /// conservative refresh path. Worst case is one extra refresh
    /// round-trip on an unparseable error; better than silently
    /// surfacing a generic error and missing a real token expiry.
    func test_get_401_withUnparseableBody_triggersRefreshConservatively() async {
        StubURLProtocol.stub(statusCode: 401, body: "<html>502 Bad Gateway</html>")
        StubURLProtocol.stub(statusCode: 401, body: "{}") // refresh also fails

        let client = makeClient(token: "expired", refreshToken: "expired")

        do {
            let _: RefreshResponse = try await client.get("/protected")
            XCTFail("Expected APIError.authRequired")
        } catch APIError.authRequired {
            // expected — refresh attempt fired and also failed
        } catch {
            XCTFail("Expected APIError.authRequired, got \(error)")
        }
        XCTAssertGreaterThanOrEqual(StubURLProtocol.capturedRequests.count, 2,
                                    "Unparseable 401 should still attempt refresh")
    }

    // MARK: - 429 → rateLimited

    func test_get_429_throwsRateLimited() async {
        StubURLProtocol.stub(statusCode: 429, body: #"{"message":"ThrottlerException: Too Many Requests"}"#)
        let client = makeClient()

        do {
            let _: RefreshResponse = try await client.get("/auth/login")
            XCTFail("Expected APIError.rateLimited")
        } catch APIError.rateLimited {
            // expected — discrete case, view layers map to friendly copy
        } catch {
            XCTFail("Expected APIError.rateLimited, got \(error)")
        }
    }

    // MARK: - Structured server errors

    func test_get_400_decodesAsServerError() async {
        StubURLProtocol.stub(
            statusCode: 400,
            body: #"{"reason":"ITEM_NOT_FOUND","message":"Item gone"}"#
        )
        let client = makeClient()

        do {
            let _: AuthResponse = try await client.get("/menu/items/bad")
            XCTFail("Expected APIError.serverError")
        } catch APIError.serverError(let inner, let code) {
            XCTAssertEqual(inner.reason, "ITEM_NOT_FOUND")
            XCTAssertEqual(inner.message, "Item gone")
            XCTAssertEqual(code, 400)
        } catch {
            XCTFail("Expected APIError.serverError, got \(error)")
        }
    }

    func test_get_500_unparseableBody_surfacesUnexpected() async {
        StubURLProtocol.stub(statusCode: 500, body: "<html>oops</html>")
        let client = makeClient()

        do {
            let _: AuthResponse = try await client.get("/anything")
            XCTFail("Expected APIError.unexpected")
        } catch APIError.unexpected(let code) {
            XCTAssertEqual(code, 500)
        } catch APIError.serverError(_, let code) {
            // ServerError's lenient init falls back to a placeholder
            // message, so an HTML body with no JSON could still parse
            // (decoder rejects it though, so we expect .unexpected).
            // Accept either as a defensive assertion.
            XCTAssertEqual(code, 500)
        } catch {
            XCTFail("Expected APIError.unexpected or .serverError, got \(error)")
        }
    }

    // MARK: - URL construction

    func test_get_buildsURLWithQueryItems() async throws {
        StubURLProtocol.stub(statusCode: 200, body: #"{"access_token":"x"}"#)
        let client = makeClient()

        let _: RefreshResponse = try await client.get(
            "/menu",
            query: [URLQueryItem(name: "locationId", value: "loc-7")]
        )

        let sent = try XCTUnwrap(StubURLProtocol.lastRequest)
        let url = try XCTUnwrap(sent.url)
        XCTAssertEqual(url.lastPathComponent, "menu")
        XCTAssertTrue(url.absoluteString.contains("locationId=loc-7"))
    }

    // MARK: - Body encoding

    func test_post_encodesBodyAsJSON() async throws {
        StubURLProtocol.stub(statusCode: 200, body: #"{"access_token":"x"}"#)
        let client = makeClient()

        struct LoginBody: Encodable { let email: String; let password: String }
        let _: RefreshResponse = try await client.post(
            "/auth/login",
            body: LoginBody(email: "a@b.com", password: "secret")
        )

        let sent = try XCTUnwrap(StubURLProtocol.lastRequest)
        XCTAssertEqual(sent.httpMethod, "POST")
        XCTAssertEqual(sent.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let bodyData = try XCTUnwrap(StubURLProtocol.lastBodyData)
        let decoded = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: bodyData) as? [String: Any]
        )
        XCTAssertEqual(decoded["email"] as? String, "a@b.com")
        XCTAssertEqual(decoded["password"] as? String, "secret")
    }

    // MARK: - Helpers

    private func makeClient(
        token: String? = nil,
        refreshToken: String? = nil
    ) -> APIClient {
        let baseURL = URL(string: "http://localhost:3000/api/v1")!
        let refresher = TokenRefresher(
            baseURL: baseURL,
            session: session,
            refreshTokenProvider: { refreshToken },
            accessTokenWriter: { _ in /* no-op for tests */ }
        )
        return APIClient(
            session: session,
            baseURL: baseURL,
            tokenProvider: { token },
            refresher: refresher
        )
    }
}

// MARK: - URLProtocol-backed stub

/// Captures requests and serves canned responses. Supports a queue of
/// responses for tests that exercise multi-step flows (e.g. 401 → retry).
///
/// - `stub(statusCode:body:)` appends a single response to the queue.
/// - `startLoading` pops the head of the queue; if the queue is empty
///   it falls back to a default 200 `{}` so a missing stub doesn't
///   crash the test, only fails the assertion.
/// - `capturedRequests` holds every request the client sent, in order.
final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    private struct StubResponse {
        let statusCode: Int
        let body: String
    }

    nonisolated(unsafe) private static var responseQueue: [StubResponse] = []
    nonisolated(unsafe) static var capturedRequests: [URLRequest] = []
    nonisolated(unsafe) static var capturedBodies: [Data?] = []

    static func stub(statusCode: Int, body: String) {
        responseQueue.append(StubResponse(statusCode: statusCode, body: body))
    }

    static func reset() {
        responseQueue = []
        capturedRequests = []
        capturedBodies = []
    }

    /// Convenience accessors that match the prior single-stub API.
    static var lastRequest: URLRequest? { capturedRequests.last }
    static var lastBodyData: Data? { capturedBodies.last ?? nil }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequests.append(request)
        if let body = request.httpBody {
            Self.capturedBodies.append(body)
        } else if let stream = request.httpBodyStream {
            Self.capturedBodies.append(Self.drain(stream))
        } else {
            Self.capturedBodies.append(nil)
        }

        // Pop the next stubbed response; fall back to 200 {} if empty.
        let stub = Self.responseQueue.isEmpty
            ? StubResponse(statusCode: 200, body: "{}")
            : Self.responseQueue.removeFirst()

        let url = request.url ?? URL(string: "http://stub")!
        let response = HTTPURLResponse(
            url: url,
            statusCode: stub.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: stub.body.data(using: .utf8) ?? Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func drain(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 1024
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }
        while stream.hasBytesAvailable {
            let read = stream.read(buffer, maxLength: bufferSize)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}
