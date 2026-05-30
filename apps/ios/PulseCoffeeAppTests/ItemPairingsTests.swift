import XCTest
@testable import PulseCoffeeApp

final class ItemPairingsTests: XCTestCase {
    private func food(_ id: String, _ name: String) -> MenuItem {
        MenuItem(id: id, name: name, description: nil, basePriceCents: 400,
                 imageURL: nil, available: true, quantityLeft: nil,
                 modifierGroups: [], artToken: nil)
    }
    private func drink(_ id: String, _ name: String, art: String) -> MenuItem {
        MenuItem(id: id, name: name, description: nil, basePriceCents: 600,
                 imageURL: nil, available: true, quantityLeft: nil,
                 modifierGroups: [], artToken: art)
    }

    private lazy var foods: [MenuItem] = [
        food("f1", "Butter Croissant"),
        food("f2", "Mini Khachapuri"),
        food("f3", "Blueberry Muffin"),
        food("f4", "Chocolate Cookie"),
    ]

    func test_matchaDrink_pairsKhachapuriCroissantCookie() {
        let matcha = drink("d1", "Ginger Matcha", art: "ginger-matcha")
        let names = ItemPairings.resolve(for: matcha, in: foods).map(\.name)
        XCTAssertEqual(names, ["Mini Khachapuri", "Butter Croissant", "Chocolate Cookie"])
    }

    func test_coffeeDrink_pairsCroissantMuffinCookie() {
        let coffee = drink("d2", "Latte", art: "latte")
        let names = ItemPairings.resolve(for: coffee, in: foods).map(\.name)
        XCTAssertEqual(names, ["Butter Croissant", "Blueberry Muffin", "Chocolate Cookie"])
    }

    func test_excludesTheItemItself_andSkipsUnresolved() {
        // A food item opened as detail should not pair with itself; missing
        // keywords are simply skipped (fail-safe).
        let partial = [food("f1", "Butter Croissant")] // only one match available
        let coffee = drink("d2", "Cold Brew", art: "cold-brew")
        let names = ItemPairings.resolve(for: coffee, in: partial).map(\.name)
        XCTAssertEqual(names, ["Butter Croissant"]) // Muffin + Cookie unresolved → skipped
    }
}
