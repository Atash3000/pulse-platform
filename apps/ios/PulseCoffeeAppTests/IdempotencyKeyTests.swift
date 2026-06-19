import XCTest
@testable import PulseCoffeeApp

/// Locks in the stability guarantees of `IdempotencyKey.generate` —
/// Golden Rule #4's protection against double-charge under network
/// retry depends on these invariants.
final class IdempotencyKeyTests: XCTestCase {

    private func line(_ itemId: String, qty: Int = 1, mods: [String] = []) -> CheckoutCartItem {
        CheckoutCartItem(menuItemId: itemId, quantity: qty, modifierIds: mods)
    }

    // MARK: - Stability (same input → same output)

    func test_sameInput_producesSameKey() {
        let k1 = IdempotencyKey.generate(
            userId: "user-1",
            lines: [line("a"), line("b")],
            timestamp: 1_700_000_000
        )
        let k2 = IdempotencyKey.generate(
            userId: "user-1",
            lines: [line("a"), line("b")],
            timestamp: 1_700_000_000
        )
        XCTAssertEqual(k1, k2, "Same input MUST produce same key — backend dedup depends on this")
    }

    func test_keyIsSHA256HexLength() {
        let key = IdempotencyKey.generate(userId: "u", lines: [line("x")], timestamp: 1)
        // SHA256 hex = 64 hex chars (256 bits / 4 bits per nibble)
        XCTAssertEqual(key.count, 64)
        // All chars must be hex (backend's regex enforces [A-Za-z0-9_=:.+-])
        XCTAssertTrue(key.allSatisfy { $0.isHexDigit })
    }

    // MARK: - Sort-order independence

    func test_cartLineReordering_doesNotChangeKey() {
        let k1 = IdempotencyKey.generate(
            userId: "u",
            lines: [line("a"), line("b"), line("c")],
            timestamp: 1
        )
        let k2 = IdempotencyKey.generate(
            userId: "u",
            lines: [line("c"), line("a"), line("b")],
            timestamp: 1
        )
        XCTAssertEqual(k1, k2, "Cart line reordering must not produce a new idempotency key — the cart logically hasn't changed")
    }

    func test_modifierIdReordering_doesNotChangeKey() {
        let k1 = IdempotencyKey.generate(userId: "u", lines: [line("a", mods: ["oat", "s16"])], timestamp: 1)
        let k2 = IdempotencyKey.generate(userId: "u", lines: [line("a", mods: ["s16", "oat"])], timestamp: 1)
        XCTAssertEqual(k1, k2, "Modifier-ID ordering must not change the key — the configured drink is the same")
    }

    // MARK: - Differentiation (different input → different key)

    func test_differentUserId_producesDifferentKey() {
        let k1 = IdempotencyKey.generate(userId: "u1", lines: [line("a")], timestamp: 1)
        let k2 = IdempotencyKey.generate(userId: "u2", lines: [line("a")], timestamp: 1)
        XCTAssertNotEqual(k1, k2)
    }

    func test_differentTimestamp_producesDifferentKey() {
        let k1 = IdempotencyKey.generate(userId: "u", lines: [line("a")], timestamp: 1)
        let k2 = IdempotencyKey.generate(userId: "u", lines: [line("a")], timestamp: 2)
        XCTAssertNotEqual(k1, k2)
    }

    func test_differentCartContents_producesDifferentKey() {
        let k1 = IdempotencyKey.generate(userId: "u", lines: [line("a")], timestamp: 1)
        let k2 = IdempotencyKey.generate(userId: "u", lines: [line("b")], timestamp: 1)
        XCTAssertNotEqual(k1, k2)
    }

    func test_additionalCartLine_producesDifferentKey() {
        let k1 = IdempotencyKey.generate(userId: "u", lines: [line("a")], timestamp: 1)
        let k2 = IdempotencyKey.generate(userId: "u", lines: [line("a"), line("b")], timestamp: 1)
        XCTAssertNotEqual(k1, k2)
    }

    func test_differentQuantity_producesDifferentKey() {
        let k1 = IdempotencyKey.generate(userId: "u", lines: [line("a", qty: 1)], timestamp: 1)
        let k2 = IdempotencyKey.generate(userId: "u", lines: [line("a", qty: 2)], timestamp: 1)
        XCTAssertNotEqual(k1, k2, "Quantity is part of the payment intent — qty 2 is not a replay of qty 1")
    }

    func test_sameItemDifferentModifiers_producesDifferentKey() {
        // Regression: the old generator hashed only flattened item IDs,
        // so a Latte-with-oat and a plain Latte produced the same key —
        // the backend would replay the wrong order.
        let k1 = IdempotencyKey.generate(userId: "u", lines: [line("latte", mods: ["oat-milk"])], timestamp: 1)
        let k2 = IdempotencyKey.generate(userId: "u", lines: [line("latte", mods: [])], timestamp: 1)
        XCTAssertNotEqual(k1, k2, "Same drink with different modifiers is a different payment intent")
    }

    // MARK: - Canonicalization ambiguity (explicit separators)

    func test_sectionBoundaries_areUnambiguous() {
        // Regression: the old payload concatenated userId + itemIds +
        // timestamp with no separator between sections, so
        // (user "u", item "a1", ts 2) collided with
        // (user "u", item "a", ts 12).
        let k1 = IdempotencyKey.generate(userId: "u", lines: [line("a1")], timestamp: 2)
        let k2 = IdempotencyKey.generate(userId: "u", lines: [line("a")], timestamp: 12)
        XCTAssertNotEqual(k1, k2, "Section boundaries must be unambiguous — distinct inputs must never hash the same payload")
    }

    func test_userIdItemBoundary_isUnambiguous() {
        let k1 = IdempotencyKey.generate(userId: "ua", lines: [line("b")], timestamp: 1)
        let k2 = IdempotencyKey.generate(userId: "u", lines: [line("ab")], timestamp: 1)
        XCTAssertNotEqual(k1, k2)
    }

    func test_lineBoundaries_areUnambiguous() {
        // Two lines (a, c) vs two lines with shuffled ID characters must
        // not collapse — the per-line separator keeps them distinct.
        let k1 = IdempotencyKey.generate(userId: "u", lines: [line("ab"), line("c")], timestamp: 1)
        let k2 = IdempotencyKey.generate(userId: "u", lines: [line("a"), line("bc")], timestamp: 1)
        XCTAssertNotEqual(k1, k2)
    }

    // MARK: - Empty cart edge case

    func test_emptyCart_stillProducesValidKey() {
        // CartManager wouldn't actually call checkout with an empty
        // cart (CheckoutViewModel guards against it), but the hash
        // function should still produce a valid 64-char hex string.
        let key = IdempotencyKey.generate(userId: "u", lines: [], timestamp: 1)
        XCTAssertEqual(key.count, 64)
    }
}
