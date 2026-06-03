import XCTest
@testable import PulseCoffeeApp

final class DrinkArtTests: XCTestCase {

    func test_knownToken_returnsRegisteredSpec() {
        let spec = DrinkArtRegistry.spec(for: "strawberry-matcha")
        XCTAssertEqual(spec.kind, .matcha)
    }

    func test_classicToken_returnsClassicKind() {
        XCTAssertEqual(DrinkArtRegistry.spec(for: "cappuccino").kind, .classic)
        XCTAssertEqual(DrinkArtRegistry.spec(for: "espresso").kind,   .classic)
    }

    func test_foodToken_returnsFoodKind() {
        XCTAssertEqual(DrinkArtRegistry.spec(for: "croissant").kind, .food)
        XCTAssertEqual(DrinkArtRegistry.spec(for: "muffin").kind,    .food)
    }

    func test_unknownToken_returnsNeutralFallback() {
        let spec = DrinkArtRegistry.spec(for: "unicorn-latte")
        XCTAssertEqual(spec.kind, .classic, "Unknown tokens fall back to a neutral classic cup")
        XCTAssertTrue(spec.isFallback,
                      "Spec must mark itself as a fallback so logging / debugging can spot it")
    }

    func test_nilToken_returnsNeutralFallback() {
        let spec = DrinkArtRegistry.spec(for: nil)
        XCTAssertEqual(spec.kind, .classic)
        XCTAssertTrue(spec.isFallback)
    }

    func test_registry_includesAllSeededV4Tokens() {
        // Mirror of the backend seed in apps/api/scripts/seed-menu.ts.
        // If a new drink lands in the seed, register it here too — this
        // test makes the missing entry loud at code-review time.
        let seeded: [String] = [
            "strawberry-matcha", "raspberry-matcha", "brown-sugar-matcha", "ginger-matcha",
            "iced-classic-matcha", "vanilla-matcha", "blueberry-matcha",
            "cappuccino", "latte", "americano", "flat-white", "cortado", "cold-brew", "espresso",
            "iced-coconut-latte", "iced-salted-caramel-latte", "iced-brown-sugar-oat-latte", "iced-vanilla-latte",
            "croissant", "khachapuri", "muffin", "cookie",
            "pain-au-chocolat", "cinnamon-roll", "everything-bagel",
        ]
        for token in seeded {
            XCTAssertFalse(DrinkArtRegistry.spec(for: token).isFallback,
                           "Token '\(token)' is in the backend seed but not registered in DrinkArtRegistry")
        }
    }
}
