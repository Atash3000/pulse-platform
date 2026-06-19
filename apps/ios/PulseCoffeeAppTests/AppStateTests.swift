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
        let customer = CustomerProfile(id: "c-1", email: "x@y.com", firstName: "Test", lastName: "User", nickname: nil)
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
                "first_name": "Sarah",
                "last_name": "M."
              }
            }
            """#
        )
        let appState = AppState(api: makeAPIClient())

        try await appState.login(email: "sarah@example.com", password: "password123")

        // State transitioned
        XCTAssertEqual(
            appState.authState,
            .loggedIn(CustomerProfile(id: "cust-1", email: "sarah@example.com", firstName: "Sarah", lastName: "M.", nickname: nil))
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
                "first_name": "New",
                "last_name": "Customer",
                "nickname": "Newbie"
              }
            }
            """#
        )
        let appState = AppState(api: makeAPIClient())

        try await appState.register(
            email: "new@example.com",
            password: "longpassword",
            firstName: "New",
            lastName: "Customer",
            nickname: "Newbie",
            phone: "+1 718 555 0100",
            dateOfBirth: "1994-03-15"
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
        try Keychain.saveCustomer(.init(id: "1", email: "x", firstName: "y", lastName: "z", nickname: nil))
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
        try Keychain.saveCustomer(.init(id: "1", email: "x", firstName: "y", lastName: "z", nickname: nil))
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

    // MARK: - Logout clears the cart (via the .didLogout signal bus)

    /// Regression: `CartManager` is App-scoped and used to survive
    /// logout untouched — user B could see (and pay for) user A's cart.
    /// Explicit Sign Out path: `AppState.logout()` posts `.didLogout`,
    /// CartManager clears.
    func test_logout_explicit_clearsCart() async throws {
        try Keychain.saveAccessToken("a")
        try Keychain.saveRefreshToken("r")
        try Keychain.saveCustomer(.init(id: "1", email: "x", firstName: "y", lastName: "z", nickname: nil))
        let appState = AppState(api: makeAPIClient())
        let cart = CartManager()
        cart.add(item: makeMenuItem())
        XCTAssertFalse(cart.isEmpty)

        await appState.logout()

        try await waitUntil { cart.isEmpty }
        XCTAssertTrue(cart.isEmpty, "Explicit logout must clear the cart")
    }

    /// Same regression, forced path: a 401 storm posts `.authRequired`
    /// → `AppState.logout()` → `.didLogout` → cart cleared.
    func test_logout_forcedViaAuthRequired_clearsCart() async throws {
        try Keychain.saveAccessToken("a")
        try Keychain.saveRefreshToken("r")
        try Keychain.saveCustomer(.init(id: "1", email: "x", firstName: "y", lastName: "z", nickname: nil))
        let appState = AppState(api: makeAPIClient())
        let cart = CartManager()
        cart.add(item: makeMenuItem())

        NotificationCenter.default.post(name: .authRequired, object: nil)

        try await waitUntil { appState.authState == .loggedOut && cart.isEmpty }
        XCTAssertEqual(appState.authState, .loggedOut)
        XCTAssertTrue(cart.isEmpty, "Forced (401) logout must clear the cart too")
    }

    /// Polls a MainActor condition for up to 1s — both notification
    /// observers hop onto `Task { @MainActor … }`, so delivery is async.
    private func waitUntil(_ condition: @MainActor () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(1.0)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(nanoseconds: 10_000_000) // 10ms
        }
    }

    private func makeMenuItem() -> MenuItem {
        MenuItem(
            id: "item-1",
            name: "Latte",
            description: nil,
            basePriceCents: 650,
            imageURL: nil,
            available: true,
            quantityLeft: nil,
            modifierGroups: []
        )
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
