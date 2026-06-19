import XCTest
@testable import PulseCoffeeApp

/// Tests for `CheckoutViewModel` — the state machine that drives
/// `POST /checkout` + PaymentSheet construction.
@MainActor
final class CheckoutViewModelTests: XCTestCase {

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

    // MARK: - Empty cart guard

    func test_placeOrder_emptyCart_failsImmediatelyWithoutNetwork() async {
        let (vm, _, _) = makeVM()
        await vm.placeOrder()

        if case .failed(let message) = vm.state {
            XCTAssertTrue(message.contains("empty"), "got: \(message)")
        } else {
            XCTFail("Expected .failed for empty cart, got \(vm.state)")
        }
        XCTAssertEqual(StubURLProtocol.capturedRequests.count, 0, "Empty-cart check must not hit the network")
    }

    // MARK: - Logged-out guard

    func test_placeOrder_loggedOut_failsImmediately() async {
        let cart = CartManager()
        cart.add(item: makeItem())
        // Build an AppState with no Keychain tokens → .loggedOut
        let appState = makeAppState()
        let api = makeAPIClient()
        let vm = CheckoutViewModel(api: api, cart: cart, appState: appState, locationId: "loc-1")

        await vm.placeOrder()

        if case .failed(let message) = vm.state {
            XCTAssertTrue(message.contains("sign in"), "got: \(message)")
        } else {
            XCTFail("Expected .failed for logged-out user, got \(vm.state)")
        }
    }

    // MARK: - Happy path

    func test_placeOrder_success_transitionsToReady_andBuildsPaymentSheet() async throws {
        StubURLProtocol.stub(
            statusCode: 200,
            body: #"""
            {
              "orderId": "order-uuid-1",
              "clientSecret": "pi_test_3xyz_secret_abc",
              "totalCents": 715,
              "display": {
                "subtotal": "$6.50",
                "modifier": "$0.00",
                "discount": "$0.00",
                "tax": "$0.65",
                "tip": "$0.00",
                "total": "$7.15"
              }
            }
            """#
        )
        let (vm, cart, _) = makeVMLoggedIn()
        cart.add(item: makeItem())

        await vm.placeOrder()

        if case .ready(let response) = vm.state {
            XCTAssertEqual(response.orderId, "order-uuid-1")
            XCTAssertEqual(response.clientSecret, "pi_test_3xyz_secret_abc")
            XCTAssertEqual(response.totalCents, 715)
            XCTAssertEqual(response.display.total, "$7.15")
        } else {
            XCTFail("Expected .ready, got \(vm.state)")
        }
        XCTAssertNotNil(vm.paymentSheet, "PaymentSheet must be constructed in .ready state")
    }

    // MARK: - Idempotency

    func test_placeOrder_retryAfterFailure_reusesSameIdempotencyKey() async throws {
        // Two failures in a row, then success — assert the same
        // idempotency_key is sent on all three attempts (Golden Rule #4
        // protection: backend dedupes replays, no double-charge).
        StubURLProtocol.stub(statusCode: 500, body: "{}")
        StubURLProtocol.stub(statusCode: 500, body: "{}")
        StubURLProtocol.stub(
            statusCode: 200,
            body: #"""
            {"orderId":"o","clientSecret":"cs","totalCents":100,
             "display":{"subtotal":"$1","modifier":"$0.00","discount":"$0.00","tax":"$0","tip":"$0","total":"$1"}}
            """#
        )
        let (vm, cart, _) = makeVMLoggedIn()
        cart.add(item: makeItem())

        await vm.placeOrder()
        await vm.placeOrder()
        await vm.placeOrder()

        // All three requests should have used the same idempotency key.
        let keys = StubURLProtocol.capturedBodies.compactMap { extractIdempotencyKey(from: $0) }
        XCTAssertEqual(keys.count, 3, "Three attempts should have produced three captured request bodies")
        XCTAssertEqual(Set(keys).count, 1,
                       "Retries of the same checkout attempt must share one idempotency key — backend dedup depends on this")
    }

    /// Regression (double-charge): the key used to be minted per
    /// CheckoutViewModel, and the VM is a fresh @StateObject per
    /// navigation. Payment confirms with Stripe, network drops before
    /// the SDK sees it, user backs out to the cart and re-enters →
    /// new VM → new key → second backend order → double charge.
    /// The key now lives in CartManager, so two sequential VMs over the
    /// SAME unchanged cart must send the SAME key on the wire.
    func test_idempotencyKey_survivesViewModelRecreation_overUnchangedCart() async throws {
        StubURLProtocol.stub(statusCode: 500, body: "{}")
        StubURLProtocol.stub(statusCode: 500, body: "{}")
        let (vm1, cart, appState) = makeVMLoggedIn()
        cart.add(item: makeItem())

        await vm1.placeOrder()

        // Simulate "Back to Cart" → re-enter checkout: a brand-new VM
        // over the same cart / appState.
        let vm2 = CheckoutViewModel(api: makeAPIClient(), cart: cart, appState: appState, locationId: "loc-1")
        await vm2.placeOrder()

        let keys = StubURLProtocol.capturedBodies.compactMap { extractIdempotencyKey(from: $0) }
        XCTAssertEqual(keys.count, 2)
        XCTAssertEqual(keys[0], keys[1],
                       "A new CheckoutViewModel over an unchanged cart must reuse the same idempotency key — otherwise re-entering checkout double-charges")
    }

    /// Companion to the above: mutating the cart between attempts is a
    /// NEW payment intent and must produce a new key (otherwise the
    /// backend replays the old, smaller order).
    func test_idempotencyKey_changesWhenCartMutates() async throws {
        StubURLProtocol.stub(statusCode: 500, body: "{}")
        StubURLProtocol.stub(statusCode: 500, body: "{}")
        let (vm, cart, _) = makeVMLoggedIn()
        cart.add(item: makeItem())

        await vm.placeOrder()
        cart.add(item: makeItem(id: "item-2"))
        await vm.placeOrder()

        let keys = StubURLProtocol.capturedBodies.compactMap { extractIdempotencyKey(from: $0) }
        XCTAssertEqual(keys.count, 2)
        XCTAssertNotEqual(keys[0], keys[1],
                          "A mutated cart is a new payment intent — replaying the old key would replay the old order")
    }

    /// Regression: the old key hashed only flattened item IDs, so a
    /// Latte-with-oat and a plain Latte produced the same key. Same
    /// items + different modifiers must differ at the wire level.
    func test_idempotencyKey_sameItemsDifferentModifiers_differOnTheWire() async throws {
        // Fixed clock pins the timestamp section of both keys, so the
        // ONLY difference between the two carts is the modifier set.
        let fixedNow = { Date(timeIntervalSince1970: 1_700_000_000) }

        StubURLProtocol.stub(statusCode: 500, body: "{}")
        let cart1 = CartManager(now: fixedNow)
        cart1.add(item: makeItem(), modifierIds: ["oat-milk"])
        let (vm1, appState1) = makeVMLoggedIn(cart: cart1)
        _ = appState1
        await vm1.placeOrder()

        StubURLProtocol.stub(statusCode: 500, body: "{}")
        let cart2 = CartManager(now: fixedNow)
        cart2.add(item: makeItem(), modifierIds: [])
        let (vm2, appState2) = makeVMLoggedIn(cart: cart2)
        _ = appState2
        await vm2.placeOrder()

        let keys = StubURLProtocol.capturedBodies.compactMap { extractIdempotencyKey(from: $0) }
        XCTAssertEqual(keys.count, 2)
        XCTAssertNotEqual(keys[0], keys[1],
                          "Same drink with different modifiers is a different payment intent and needs a different key")
    }

    // MARK: - Empty locationId guard

    /// Regression: items added from Home's "Pair with" row + the Menu
    /// tab's cart icon before /menu resolved passes `locationId: ""` all
    /// the way to checkout, which auto-fires on appear → backend 400
    /// with raw validator text shown to the customer. The view model
    /// must fail friendly without a network call.
    func test_placeOrder_emptyLocationId_failsWithoutNetwork() async {
        let cart = CartManager()
        cart.add(item: makeItem())
        let (vm, appState) = makeVMLoggedIn(cart: cart, locationId: "")
        _ = appState

        await vm.placeOrder()

        if case .failed(let message) = vm.state {
            XCTAssertTrue(message.contains("location"), "got: \(message)")
            XCTAssertFalse(message.lowercased().contains("must be"), "No raw validator text in customer copy")
        } else {
            XCTFail("Expected .failed for empty locationId, got \(vm.state)")
        }
        XCTAssertEqual(StubURLProtocol.capturedRequests.count, 0,
                       "Empty-locationId check must not hit the network")
    }

    // MARK: - Server errors mapped to user copy

    func test_placeOrder_400Validation_surfacesServerMessage() async {
        StubURLProtocol.stub(
            statusCode: 400,
            body: #"{"reason":"ITEM_NOT_FOUND","message":"Item is no longer available."}"#
        )
        let (vm, cart, _) = makeVMLoggedIn()
        cart.add(item: makeItem())

        await vm.placeOrder()

        if case .failed(let message) = vm.state {
            XCTAssertEqual(message, "Item is no longer available.")
        } else {
            XCTFail("Expected .failed, got \(vm.state)")
        }
    }

    func test_placeOrder_409_surfacesPaymentInFlightCopy() async {
        StubURLProtocol.stub(statusCode: 409, body: #"{"reason":"PAYMENT_IN_FLIGHT","message":"…"}"#)
        let (vm, cart, _) = makeVMLoggedIn()
        cart.add(item: makeItem())

        await vm.placeOrder()

        if case .failed(let message) = vm.state {
            XCTAssertTrue(message.contains("payment is already in progress"), "got: \(message)")
        } else {
            XCTFail("Expected .failed, got \(vm.state)")
        }
    }

    /// Regression: a Stripe-passed-through 401 from /checkout used to
    /// kick the user back to the login screen. Now it should produce a
    /// `.failed` state with a generic "temporarily unavailable" message
    /// — no logout, no Stripe-key leakage in the user-visible copy.
    func test_placeOrder_downstream401_surfacesGenericCopy_andDoesNotLogout() async {
        StubURLProtocol.stub(
            statusCode: 401,
            body: #"{"statusCode":401,"message":"Invalid API Key provided: sk_test_..."}"#
        )
        let (vm, cart, appState) = makeVMLoggedIn()
        cart.add(item: makeItem())

        await vm.placeOrder()

        if case .failed(let message) = vm.state {
            XCTAssertTrue(message.contains("temporarily unavailable"), "got: \(message)")
            XCTAssertFalse(message.contains("API Key"), "User-visible copy must not leak Stripe key prefixes")
            XCTAssertFalse(message.contains("sk_test"), "User-visible copy must not leak Stripe key prefixes")
        } else {
            XCTFail("Expected .failed, got \(vm.state)")
        }

        // The user must still be logged in — APIClient correctly
        // identified this as a non-JWT 401.
        XCTAssertNotEqual(appState.authState, .loggedOut)
    }

    func test_placeOrder_429_surfacesRateLimitedCopy() async {
        StubURLProtocol.stub(statusCode: 429, body: "{}")
        let (vm, cart, _) = makeVMLoggedIn()
        cart.add(item: makeItem())

        await vm.placeOrder()

        if case .failed(let message) = vm.state {
            XCTAssertTrue(message.contains("Too many"), "got: \(message)")
        } else {
            XCTFail("Expected .failed, got \(vm.state)")
        }
    }

    // MARK: - Already-paid replay (empty clientSecret)

    func test_placeOrder_replayReturnsEmptyClientSecret_routesToSuccess() async throws {
        // Backend returns `clientSecret = ""` when the idempotency key
        // hits a SUCCEEDED order. We should route straight to success
        // and clear the cart.
        StubURLProtocol.stub(
            statusCode: 200,
            body: #"""
            {"orderId":"already-paid-order","clientSecret":"","totalCents":650,
             "display":{"subtotal":"$6.50","modifier":"$0.00","discount":"$0.00","tax":"$0.65","tip":"$0.00","total":"$7.15"}}
            """#
        )
        let (vm, cart, _) = makeVMLoggedIn()
        cart.add(item: makeItem())

        await vm.placeOrder()

        if case .success(let orderId, _) = vm.state {
            XCTAssertEqual(orderId, "already-paid-order")
        } else {
            XCTFail("Expected .success for empty-clientSecret replay, got \(vm.state)")
        }
        XCTAssertTrue(cart.isEmpty, "Cart should be cleared after success")
    }

    // MARK: - Lock against double-tap

    func test_placeOrder_concurrentCalls_serializeViaIsProcessingLock() async throws {
        StubURLProtocol.stub(
            statusCode: 200,
            body: #"""
            {"orderId":"o","clientSecret":"cs","totalCents":100,
             "display":{"subtotal":"$1","modifier":"$0.00","discount":"$0.00","tax":"$0","tip":"$0","total":"$1"}}
            """#
        )
        let (vm, cart, _) = makeVMLoggedIn()
        cart.add(item: makeItem())

        // Two concurrent calls — second must hit the `guard !isProcessing`
        // early-return and not send a second HTTP request.
        async let a: Void = vm.placeOrder()
        async let b: Void = vm.placeOrder()
        _ = await [a, b]

        XCTAssertEqual(StubURLProtocol.capturedRequests.count, 1,
                       "Concurrent placeOrder calls must produce exactly one HTTP request")
    }

    // MARK: - Helpers

    private func makeItem(id: String = "item-1") -> MenuItem {
        MenuItem(
            id: id,
            name: "Latte",
            description: nil,
            basePriceCents: 650,
            imageURL: nil,
            available: true,
            quantityLeft: nil,
            modifierGroups: []
        )
    }

    private func makeAPIClient() -> APIClient {
        let baseURL = URL(string: "http://localhost:3000/api/v1")!
        let refresher = TokenRefresher(
            baseURL: baseURL,
            session: session,
            refreshTokenProvider: { nil },
            accessTokenWriter: { _ in }
        )
        return APIClient(
            session: session,
            baseURL: baseURL,
            tokenProvider: { nil },
            refresher: refresher
        )
    }

    private func makeAppState() -> AppState {
        AppState(api: makeAPIClient())
    }

    private func makeVM() -> (CheckoutViewModel, CartManager, AppState) {
        let cart = CartManager()
        let appState = makeAppState()
        let api = makeAPIClient()
        let vm = CheckoutViewModel(api: api, cart: cart, appState: appState, locationId: "loc-1")
        return (vm, cart, appState)
    }

    /// Builds a logged-in AppState by pre-populating Keychain so init's
    /// bootstrap reads the customer profile and transitions to .loggedIn.
    private func makeVMLoggedIn() -> (CheckoutViewModel, CartManager, AppState) {
        let cart = CartManager()
        let (vm, appState) = makeVMLoggedIn(cart: cart)
        return (vm, cart, appState)
    }

    /// Variant that accepts a caller-built cart (e.g. with a fixed clock)
    /// and/or a non-default location id.
    private func makeVMLoggedIn(
        cart: CartManager,
        locationId: String = "loc-1"
    ) -> (CheckoutViewModel, AppState) {
        try? Keychain.saveAccessToken("test-access")
        try? Keychain.saveRefreshToken("test-refresh")
        try? Keychain.saveCustomer(.init(id: "cust-1", email: "x@y", firstName: "Test", lastName: "User", nickname: nil))
        let api = makeAPIClient()
        let appState = AppState(api: api)
        let vm = CheckoutViewModel(api: api, cart: cart, appState: appState, locationId: locationId)
        return (vm, appState)
    }

    private func extractIdempotencyKey(from data: Data?) -> String? {
        guard let data,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return obj["idempotencyKey"] as? String
    }
}
