import Foundation
import CryptoKit

/// Generates the SHA256 idempotency key sent with every `POST /checkout`
/// request. Per Golden Rule #4 (idempotency on every payment), the key
/// represents **the user's intent to pay for a specific cart**, not the
/// network attempt:
///
/// - The same `(userId, cart lines, timestamp)` tuple **always** produces
///   the same key — so a retry of the same checkout (including a retry
///   from a brand-new `CheckoutViewModel` after the user backed out and
///   re-entered) replays the cached SUCCEEDED response from the backend
///   rather than charging the customer twice.
/// - The timestamp is captured **once, the first time a key is derived
///   for the current cart contents**, and cached by `CartManager` until
///   the cart mutates. See `CartManager.idempotencyKey(for:)` for the
///   ownership story.
///
/// The canonical payload uses explicit separators (`#` between sections,
/// `|` between lines, `*` within a line, `,` between modifier IDs) so no
/// two distinct inputs can collapse into the same hashed string — e.g.
/// `userId "u" + item "a1" + ts 2` can no longer collide with
/// `userId "u" + item "a" + ts 12`. All IDs are backend UUIDs (hex +
/// dashes), which cannot contain any of the separator characters.
///
/// The backend's regex (`^[A-Za-z0-9_=:.+-]{32,128}$`) accepts hex —
/// SHA256 hex is 64 chars, well within range. See `IdempotencyKeyTests`
/// for the stability guarantees that lock this behavior in.
enum IdempotencyKey {

    /// Generates a deterministic key for the given user + cart lines +
    /// timestamp.
    ///
    /// - Parameters:
    ///   - userId: backend customer ID (UUID string). Stable for the
    ///     lifetime of the user's session.
    ///   - lines: the cart in wire format (`CartManager.toCheckoutItems()`).
    ///     Each line contributes its item ID, quantity, AND sorted
    ///     modifier IDs — two carts with the same drinks but different
    ///     modifiers are different payment intents and get different
    ///     keys. Line order is canonicalized internally so cart-line
    ///     reordering doesn't change the key.
    ///   - timestamp: seconds since epoch when the key was first derived
    ///     for this cart. `Int(Date().timeIntervalSince1970)` per
    ///     `docs/ai-onboarding/ios.md` rule #8.
    static func generate(
        userId: String,
        lines: [CheckoutCartItem],
        timestamp: Int
    ) -> String {
        let encodedLines = lines
            .map { line in
                "\(line.menuItemId)*\(line.quantity)*\(line.modifierIds.sorted().joined(separator: ","))"
            }
            .sorted()
        let payload = userId + "#" + encodedLines.joined(separator: "|") + "#" + String(timestamp)
        let digest = SHA256.hash(data: Data(payload.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
