import XCTest
@testable import PulseCoffeeApp

/// Tests for the typed Keychain wrapper.
///
/// These tests touch the real iOS Keychain on the Simulator. Each test
/// calls `Keychain.clearTokens()` in `setUp` so leftover state from a
/// previous run cannot leak. Real-device runs work too — tokens are
/// scoped to the bundle identifier and survive between tests within a
/// single XCTestCase invocation only because we explicitly clear.
final class KeychainTests: XCTestCase {

    override func setUp() async throws {
        try await super.setUp()
        // Wipe both items before each test so order-independent.
        try Keychain.clearTokens()
    }

    override func tearDown() async throws {
        try Keychain.clearTokens()
        try await super.tearDown()
    }

    // MARK: - Access token round-trip

    func test_saveAndLoadAccessToken_roundTrips() throws {
        try Keychain.saveAccessToken("test-access-token-123")
        let loaded = try Keychain.loadAccessToken()
        XCTAssertEqual(loaded, "test-access-token-123")
    }

    func test_loadAccessToken_returnsNilWhenAbsent() throws {
        let loaded = try Keychain.loadAccessToken()
        XCTAssertNil(loaded)
    }

    func test_saveAccessToken_overwritesPreviousValue() throws {
        try Keychain.saveAccessToken("first")
        try Keychain.saveAccessToken("second")
        XCTAssertEqual(try Keychain.loadAccessToken(), "second")
    }

    // MARK: - Refresh token round-trip

    func test_saveAndLoadRefreshToken_roundTrips() throws {
        try Keychain.saveRefreshToken("test-refresh-token-abc")
        let loaded = try Keychain.loadRefreshToken()
        XCTAssertEqual(loaded, "test-refresh-token-abc")
    }

    func test_loadRefreshToken_returnsNilWhenAbsent() throws {
        let loaded = try Keychain.loadRefreshToken()
        XCTAssertNil(loaded)
    }

    // MARK: - Token isolation

    func test_accessAndRefreshTokens_areStoredIndependently() throws {
        try Keychain.saveAccessToken("access-value")
        try Keychain.saveRefreshToken("refresh-value")
        XCTAssertEqual(try Keychain.loadAccessToken(), "access-value")
        XCTAssertEqual(try Keychain.loadRefreshToken(), "refresh-value")
    }

    // MARK: - Clear

    func test_clearTokens_removesBoth() throws {
        try Keychain.saveAccessToken("a")
        try Keychain.saveRefreshToken("r")
        try Keychain.clearTokens()
        XCTAssertNil(try Keychain.loadAccessToken())
        XCTAssertNil(try Keychain.loadRefreshToken())
    }

    func test_clearTokens_isIdempotent() throws {
        // Empty keychain — should not throw.
        try Keychain.clearTokens()
        XCTAssertNil(try Keychain.loadAccessToken())

        // Save, clear, clear again — second clear is still a no-op success.
        try Keychain.saveAccessToken("x")
        try Keychain.clearTokens()
        XCTAssertNoThrow(try Keychain.clearTokens())
    }
}
