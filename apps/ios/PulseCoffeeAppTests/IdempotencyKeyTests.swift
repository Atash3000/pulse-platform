import XCTest
@testable import PulseCoffeeApp

/// Locks in the stability guarantees of `IdempotencyKey.generate` —
/// Golden Rule #4's protection against double-charge under network
/// retry depends on these invariants.
final class IdempotencyKeyTests: XCTestCase {

    // MARK: - Stability (same input → same output)

    func test_sameInput_producesSameKey() {
        let k1 = IdempotencyKey.generate(
            userId: "user-1",
            cartItemIds: ["a", "b"],
            timestamp: 1_700_000_000
        )
        let k2 = IdempotencyKey.generate(
            userId: "user-1",
            cartItemIds: ["a", "b"],
            timestamp: 1_700_000_000
        )
        XCTAssertEqual(k1, k2, "Same input MUST produce same key — backend dedup depends on this")
    }

    func test_keyIsSHA256HexLength() {
        let key = IdempotencyKey.generate(
            userId: "u",
            cartItemIds: ["x"],
            timestamp: 1
        )
        // SHA256 hex = 64 hex chars (256 bits / 4 bits per nibble)
        XCTAssertEqual(key.count, 64)
        // All chars must be hex (backend's regex enforces [A-Za-z0-9_=:.+-])
        XCTAssertTrue(key.allSatisfy { $0.isHexDigit })
    }

    // MARK: - Sort-order independence

    func test_cartItemIdReordering_doesNotChangeKey() {
        let k1 = IdempotencyKey.generate(
            userId: "u",
            cartItemIds: ["a", "b", "c"],
            timestamp: 1
        )
        let k2 = IdempotencyKey.generate(
            userId: "u",
            cartItemIds: ["c", "a", "b"],
            timestamp: 1
        )
        XCTAssertEqual(k1, k2, "Cart line reordering must not produce a new idempotency key — the cart logically hasn't changed")
    }

    func test_cartItemIdRepetition_producesSameKey() {
        // A cart with quantity=2 of item "a" emits ["a", "a"] from
        // CartManager.itemIds. The sort step preserves both — same
        // multiset means same key.
        let k1 = IdempotencyKey.generate(
            userId: "u",
            cartItemIds: ["a", "a"],
            timestamp: 1
        )
        let k2 = IdempotencyKey.generate(
            userId: "u",
            cartItemIds: ["a", "a"],
            timestamp: 1
        )
        XCTAssertEqual(k1, k2)
    }

    // MARK: - Differentiation (different input → different key)

    func test_differentUserId_producesDifferentKey() {
        let k1 = IdempotencyKey.generate(userId: "u1", cartItemIds: ["a"], timestamp: 1)
        let k2 = IdempotencyKey.generate(userId: "u2", cartItemIds: ["a"], timestamp: 1)
        XCTAssertNotEqual(k1, k2)
    }

    func test_differentTimestamp_producesDifferentKey() {
        let k1 = IdempotencyKey.generate(userId: "u", cartItemIds: ["a"], timestamp: 1)
        let k2 = IdempotencyKey.generate(userId: "u", cartItemIds: ["a"], timestamp: 2)
        XCTAssertNotEqual(k1, k2)
    }

    func test_differentCartContents_producesDifferentKey() {
        let k1 = IdempotencyKey.generate(userId: "u", cartItemIds: ["a"], timestamp: 1)
        let k2 = IdempotencyKey.generate(userId: "u", cartItemIds: ["b"], timestamp: 1)
        XCTAssertNotEqual(k1, k2)
    }

    func test_additionalCartItem_producesDifferentKey() {
        let k1 = IdempotencyKey.generate(userId: "u", cartItemIds: ["a"], timestamp: 1)
        let k2 = IdempotencyKey.generate(userId: "u", cartItemIds: ["a", "b"], timestamp: 1)
        XCTAssertNotEqual(k1, k2)
    }

    // MARK: - Empty cart edge case

    func test_emptyCart_stillProducesValidKey() {
        // CartManager wouldn't actually call checkout with an empty
        // cart (CheckoutViewModel guards against it), but the hash
        // function should still produce a valid 64-char hex string.
        let key = IdempotencyKey.generate(userId: "u", cartItemIds: [], timestamp: 1)
        XCTAssertEqual(key.count, 64)
    }
}
