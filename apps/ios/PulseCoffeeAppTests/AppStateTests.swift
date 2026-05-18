import XCTest
@testable import PulseCoffeeApp

/// Tests for `AppState` — the root state machine that owns the
/// authentication lifecycle. Tests hit the real Keychain (Simulator)
/// and exercise the synchronous bootstrap path + the public login /
/// register / logout entry points + the `authRequired` notification
/// observer.
@MainActor
final class AppStateTests: XCTestCase {

    private var session: URLSession!

    override func setUp() async throws {
        try await super.setUp()
        try Keychain.clearAll()

        StubURLProtocol.reset()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        session = URLSession(configuration: config)
    }

    override func tearDown() async throws {
        try Keychain.clearAll()
        StubURLProtocol.reset()
        session = nil
        try await super.tearDown()
    }

    // MARK: - Bootstrap

    func test_init_keychainEmpty_authStateIsLoggedOut() {
        let appState = AppState(api: makeAPIClient())
        XCTAssertEqual(appState.authState, .loggedOut)
    }

    func test_init_keychainHasTokenAndCustomer_authStateIsLoggedIn() throws {
        let customer = CustomerProfile(id: "c-1", email: "x@y.com", fullName: "Test User")
        try Keychain.saveAccessToken("access-1")
        try Keychain.saveRefreshToken("refresh-1")
        try Keychain.saveCustomer(customer)

        let appState = AppState(api: makeAPIClient())

        XCTAssertEqual(appState.authState, .loggedIn(customer))
    }

    func test_init_keychainHasTokenButNoCustomer_authStateIsLoggedOut() throws {
        // Inconsistent Keychain state — we treat it as logged-out so the
        // user signs in again and Keychain repopulates cleanly.
        try Keychain.saveAccessToken("access-1")
        try Keychain.saveRefreshToken("refresh-1")
        // Intentionally no customer profile.

        let appState = AppState(api: makeAPIClient())

        XCTAssertEqual(appState.authState, .loggedOut)
    }

    // MARK: - Login

    func test_login_success_persistsAuthAndTransitionsToLoggedIn() async throws {
        StubURLProtocol.stub(
            statusCode: 200,
            body: #"""
            {
              "access_token": "new-access",
              "refresh_token": "new-refresh",
              "customer": {
                "id": "cust-1",
                "email": "sarah@example.com",
                "full_name": "Sarah M."
              }
            }
            """#
        )
        let appState = AppState(api: makeAPIClient())

        try await appState.login(email: "sarah@example.com", password: "password123")

        // State transitioned
        XCTAssertEqual(
            appState.authState,
            .loggedIn(CustomerProfile(id: "cust-1", email: "sarah@example.com", fullName: "Sarah M."))
        )
        // Keychain persisted
        XCTAssertEqual(try Keychain.loadAccessToken(), "new-access")
        XCTAssertEqual(try Keychain.loadRefreshToken(), "new-refresh")
        XCTAssertEqual(try Keychain.loadCustomer()?.id, "cust-1")
    }

    func test_login_failure_authStateRemainsLoggedOut() async {
        StubURLProtocol.stub(statusCode: 401, body: #"{"message":"Invalid email or password"}"#)
        StubURLProtocol.stub(statusCode: 401, body: "{}") // refresh attempt also fails

        let appState = AppState(api: makeAPIClient())

        do {
            try await appState.login(email: "x@y", password: "bad")
            XCTFail("Expected error")
        } catch {
            // Expected
        }

        XCTAssertEqual(appState.authState, .loggedOut)
        XCTAssertNil(try? Keychain.loadAccessToken())
    }

    // MARK: - Register

    func test_register_success_transitionsToLoggedIn() async throws {
        StubURLProtocol.stub(
            statusCode: 201,
            body: #"""
            {
              "access_token": "reg-access",
              "refresh_token": "reg-refresh",
              "customer": {
                "id": "cust-new",
                "email": "new@example.com",
                "full_name": "New Customer"
              }
            }
            """#
        )
        let appState = AppState(api: makeAPIClient())

        try await appState.register(
            email: "new@example.com",
            password: "longpassword",
            fullName: "New Customer",
            phone: "+1 718 555 0100"
        )

        if case .loggedIn(let profile) = appState.authState {
            XCTAssertEqual(profile.id, "cust-new")
        } else {
            XCTFail("Expected loggedIn, got \(appState.authState)")
        }
    }

    // MARK: - Logout

    func test_logout_clearsKeychainAndTransitionsToLoggedOut() async throws {
        // Set up logged-in state
        try Keychain.saveAccessToken("a")
        try Keychain.saveRefreshToken("r")
        try Keychain.saveCustomer(.init(id: "1", email: "x", fullName: "y"))
        let appState = AppState(api: makeAPIClient())
        XCTAssertNotEqual(appState.authState, .loggedOut)

        await appState.logout()

        XCTAssertEqual(appState.authState, .loggedOut)
        XCTAssertNil(try Keychain.loadAccessToken())
        XCTAssertNil(try Keychain.loadRefreshToken())
        XCTAssertNil(try Keychain.loadCustomer())
    }

    // MARK: - Notification-driven logout

    func test_authRequiredNotification_triggersLogout() async throws {
        try Keychain.saveAccessToken("a")
        try Keychain.saveRefreshToken("r")
        try Keychain.saveCustomer(.init(id: "1", email: "x", fullName: "y"))
        let appState = AppState(api: makeAPIClient())
        XCTAssertNotEqual(appState.authState, .loggedOut)

        NotificationCenter.default.post(name: .authRequired, object: nil)

        // The observer hops onto a Task @MainActor — give it a beat to run.
        // We poll the state up to ~1s; in practice the hop is sub-ms.
        let deadline = Date().addingTimeInterval(1.0)
        while Date() < deadline {
            if appState.authState == .loggedOut { break }
            try await Task.sleep(nanoseconds: 10_000_000) // 10ms
        }

        XCTAssertEqual(appState.authState, .loggedOut)
        XCTAssertNil(try Keychain.loadAccessToken())
    }

    // MARK: - Helpers

    private func makeAPIClient() -> APIClient {
        let baseURL = URL(string: "http://localhost:3000/api/v1")!
        let refresher = TokenRefresher(
            baseURL: baseURL,
            session: session,
            refreshTokenProvider: { try Keychain.loadRefreshToken() },
            accessTokenWriter: { try Keychain.saveAccessToken($0) }
        )
        return APIClient(
            session: session,
            baseURL: baseURL,
            tokenProvider: { try Keychain.loadAccessToken() },
            refresher: refresher
        )
    }
}
