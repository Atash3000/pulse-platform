import Foundation
import CryptoKit

/// Generates the SHA256 idempotency key sent with every `POST /checkout`
/// request. Per Golden Rule #4 (idempotency on every payment), the key
/// represents **the user's intent to pay**, not the network attempt:
///
/// - The same `(userId, sorted item IDs, timestamp)` tuple **always**
///   produces the same key — so a network-blip retry of the same tap
///   replays the cached SUCCEEDED response from the backend rather
///   than charging the customer twice.
/// - The timestamp is captured **once when the user taps "Place Order"**
///   and held in `CheckoutViewModel` state for the full attempt. It only
///   changes when the cart changes (different item IDs → different key
///   anyway) or the user explicitly re-taps after an error.
///
/// The backend's regex (`^[A-Za-z0-9_=:.+-]{32,128}$`) accepts hex —
/// SHA256 hex is 64 chars, well within range. See `IdempotencyKeyTests`
/// for the stability guarantees that lock this behavior in.
enum IdempotencyKey {

    /// Generates a deterministic key for the given user + cart + timestamp.
    ///
    /// - Parameters:
    ///   - userId: backend customer ID (UUID string). Stable for the
    ///     lifetime of the user's session.
    ///   - cartItemIds: array of menu_item UUIDs in the cart. The
    ///     function sorts them internally so cart-line reordering
    ///     doesn't change the key.
    ///   - timestamp: seconds since epoch when the user tapped
    ///     "Place Order". `Int(Date().timeIntervalSince1970)` per
    ///     `docs/ai-onboarding/ios.md` rule #8.
    static func generate(
        userId: String,
        cartItemIds: [String],
        timestamp: Int
    ) -> String {
        let sorted = cartItemIds.sorted()
        let payload = userId + sorted.joined(separator: "|") + String(timestamp)
        let digest = SHA256.hash(data: Data(payload.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
