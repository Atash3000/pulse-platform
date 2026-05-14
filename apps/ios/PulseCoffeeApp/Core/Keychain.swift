import Foundation
import Security

/// Typed wrapper around Apple's Keychain Services for storing JWTs.
///
/// Per `docs/ai-onboarding/ios.md` rule #5: tokens MUST use
/// `kSecAttrAccessibleWhenUnlocked` — never `UserDefaults`, never plist,
/// never an in-memory-only string that survives across launches.
///
/// Why typed methods (not a generic `Keychain.set(key:value:)`):
/// - Auth tokens in a payment-adjacent app must be unambiguous in code.
///   A stringly-typed API invites typos like `loadToken("acces_token")`
///   that compile and fail at runtime; typed methods make the call sites
///   self-documenting and prevent that class of bug.
/// - Logout (clear-tokens) is one symmetric call. Generic APIs leak the
///   "is `refresh_token` still in there?" decision to every caller.
///
/// All methods throw `KeychainError` on failure. `load*` methods return
/// `nil` only when the item is not present — distinguish absence from
/// failure at the call site.
enum Keychain {

    // MARK: - Public typed API

    /// Persists the access token. Replaces any previous value.
    static func saveAccessToken(_ token: String) throws {
        try saveString(token, for: .accessToken)
    }

    /// Returns the persisted access token, or `nil` if none is stored.
    /// Throws on keychain error (NOT on missing item).
    static func loadAccessToken() throws -> String? {
        try loadString(for: .accessToken)
    }

    /// Persists the refresh token. Replaces any previous value.
    static func saveRefreshToken(_ token: String) throws {
        try saveString(token, for: .refreshToken)
    }

    /// Returns the persisted refresh token, or `nil` if none is stored.
    /// Throws on keychain error (NOT on missing item).
    static func loadRefreshToken() throws -> String? {
        try loadString(for: .refreshToken)
    }

    /// Removes both access and refresh tokens. Idempotent — calling on
    /// an already-empty keychain returns success.
    ///
    /// Use this on logout. After this call, both `loadAccessToken()` and
    /// `loadRefreshToken()` return `nil`.
    static func clearTokens() throws {
        try deleteItem(for: .accessToken)
        try deleteItem(for: .refreshToken)
    }

    // MARK: - Internal implementation

    /// Bundle-aligned service identifier so the keychain entries survive
    /// uninstall + reinstall and never collide with another app's entries.
    private static let service = "com.pulsecoffee.app"

    private enum Item: String {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"

        /// `kSecAttrAccount` value. Distinguishes the two items within
        /// the same `kSecAttrService` namespace.
        var account: String { rawValue }
    }

    private static func saveString(_ value: String, for item: Item) throws {
        guard let data = value.data(using: .utf8) else {
            throw KeychainError.invalidStringEncoding
        }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: item.account,
        ]

        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlocked,
        ]

        // Try update first; if not found, add. This is the standard
        // upsert pattern for Keychain Services — using `SecItemAdd` with
        // an existing entry returns `errSecDuplicateItem` instead of
        // replacing it.
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)

        if updateStatus == errSecItemNotFound {
            var insertQuery = query
            insertQuery.merge(attributes) { (_, new) in new }
            let addStatus = SecItemAdd(insertQuery as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw KeychainError.unhandledError(addStatus)
            }
        } else if updateStatus != errSecSuccess {
            throw KeychainError.unhandledError(updateStatus)
        }
    }

    private static func loadString(for item: Item) throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: item.account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        switch status {
        case errSecSuccess:
            guard
                let data = result as? Data,
                let value = String(data: data, encoding: .utf8)
            else {
                throw KeychainError.invalidStringEncoding
            }
            return value
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError.unhandledError(status)
        }
    }

    private static func deleteItem(for item: Item) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: item.account,
        ]

        let status = SecItemDelete(query as CFDictionary)

        // `errSecItemNotFound` is an acceptable outcome — it means the
        // item was already gone, which is the post-condition we want.
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unhandledError(status)
        }
    }
}

/// Errors thrown by `Keychain.*` methods.
enum KeychainError: Error, Equatable {
    /// The string could not be UTF-8 encoded into `Data`, or the stored
    /// `Data` could not be decoded back into a UTF-8 string. Practically
    /// shouldn't happen for JWTs (which are ASCII).
    case invalidStringEncoding

    /// A Keychain Services API returned a non-success `OSStatus`. The
    /// raw status is preserved so the caller can map it to a user-facing
    /// error (or surface to Sentry).
    case unhandledError(OSStatus)
}
