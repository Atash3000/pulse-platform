import XCTest
@testable import PulseCoffeeApp

/// Tests for `TokenRefresher`. Uses the same `StubURLProtocol` from
/// `APIClientTests.swift` for hermetic networking.
final class TokenRefresherTests: XCTestCase {

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

    // MARK: - Happy path

    func test_refresh_success_returnsNewToken() async throws {
        StubURLProtocol.stub(statusCode: 200, body: #"{"access_token":"new-jwt-value"}"#)
        var saved: String?
        let refresher = makeRefresher(
            refreshToken: "valid-refresh",
            accessTokenWriter: { saved = $0 }
        )

        let token = try await refresher.refresh()

        XCTAssertEqual(token, "new-jwt-value")
        XCTAssertEqual(saved, "new-jwt-value")
        XCTAssertEqual(StubURLProtocol.capturedRequests.count, 1)
    }

    func test_refresh_postsRefreshTokenInBody() async throws {
        StubURLProtocol.stub(statusCode: 200, body: #"{"access_token":"x"}"#)
        let refresher = makeRefresher(refreshToken: "the-refresh-token")

        _ = try await refresher.refresh()

        let body = try XCTUnwrap(StubURLProtocol.capturedBodies.first ?? nil)
        let decoded = try XCTUnwrap(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        // Wire format uses snake_case per RefreshRequest's CodingKeys
        XCTAssertEqual(decoded["refresh_token"] as? String, "the-refresh-token")
    }

    // MARK: - Failure paths

    func test_refresh_noRefreshToken_postsAuthRequiredAndThrows() async {
        let notificationExpectation = expectation(forNotification: .authRequired, object: nil)
        let refresher = makeRefresher(refreshToken: nil)

        do {
            _ = try await refresher.refresh()
            XCTFail("Expected APIError.authRequired")
        } catch APIError.authRequired {
            // expected
        } catch {
            XCTFail("Expected APIError.authRequired, got \(error)")
        }

        await fulfillment(of: [notificationExpectation], timeout: 1.0)
        // No HTTP request should have been sent — we bailed before
        // constructing the URLRequest.
        XCTAssertEqual(StubURLProtocol.capturedRequests.count, 0)
    }

    func test_refresh_401_postsAuthRequiredAndThrows() async {
        StubURLProtocol.stub(statusCode: 401, body: "{}")
        let notificationExpectation = expectation(forNotification: .authRequired, object: nil)
        let refresher = makeRefresher(refreshToken: "expired-refresh")

        do {
            _ = try await refresher.refresh()
            XCTFail("Expected APIError.authRequired")
        } catch APIError.authRequired {
            // expected
        } catch {
            XCTFail("Expected APIError.authRequired, got \(error)")
        }

        await fulfillment(of: [notificationExpectation], timeout: 1.0)
    }

    func test_refresh_429_throwsRateLimited() async {
        StubURLProtocol.stub(statusCode: 429, body: "{}")
        let refresher = makeRefresher(refreshToken: "ok")

        do {
            _ = try await refresher.refresh()
            XCTFail("Expected APIError.rateLimited")
        } catch APIError.rateLimited {
            // expected
        } catch {
            XCTFail("Expected APIError.rateLimited, got \(error)")
        }
    }

    // MARK: - State cleanup

    func test_refresh_afterSuccess_inFlightTaskIsCleared() async throws {
        StubURLProtocol.stub(statusCode: 200, body: #"{"access_token":"x"}"#)
        let refresher = makeRefresher(refreshToken: "ok")

        _ = try await refresher.refresh()

        let isCleared = await refresher._inFlightTaskIsNil()
        XCTAssertTrue(isCleared, "inFlightTask should be nil after successful refresh")
    }

    func test_refresh_afterFailure_inFlightTaskIsCleared() async {
        StubURLProtocol.stub(statusCode: 401, body: "{}")
        let refresher = makeRefresher(refreshToken: "expired")

        _ = try? await refresher.refresh()

        let isCleared = await refresher._inFlightTaskIsNil()
        XCTAssertTrue(isCleared, "inFlightTask should be nil after failed refresh — defer must run on throw")
    }

    // MARK: - Dedup under concurrency

    func test_refresh_concurrent_callsCoalesceToSingleNetworkRoundTrip() async throws {
        // One stubbed response — if dedup is broken, the second concurrent
        // call will fall through to the default-200-{} fallback and decode
        // a different token, failing this assertion.
        StubURLProtocol.stub(statusCode: 200, body: #"{"access_token":"shared-token"}"#)
        let refresher = makeRefresher(refreshToken: "ok")

        async let token1 = refresher.refresh()
        async let token2 = refresher.refresh()
        async let token3 = refresher.refresh()

        let results = try await [token1, token2, token3]

        XCTAssertEqual(Set(results), ["shared-token"],
                       "All concurrent callers should receive the same refreshed token")
        XCTAssertEqual(StubURLProtocol.capturedRequests.count, 1,
                       "Concurrent refresh() calls should produce exactly one HTTP request")
    }

    // MARK: - Helpers

    private func makeRefresher(
        refreshToken: String?,
        accessTokenWriter: @escaping @Sendable (String) -> Void = { _ in }
    ) -> TokenRefresher {
        TokenRefresher(
            baseURL: URL(string: "http://localhost:3000/api/v1")!,
            session: session,
            refreshTokenProvider: { refreshToken },
            accessTokenWriter: { token in accessTokenWriter(token) }
        )
    }
}
