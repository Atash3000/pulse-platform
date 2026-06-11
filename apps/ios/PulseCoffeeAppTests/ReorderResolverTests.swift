import XCTest
@testable import PulseCoffeeApp

final class ReorderResolverTests: XCTestCase {

    private func mod(_ id: String, _ price: Int) -> Modifier {
        Modifier(id: id, name: id, priceCents: price, sortOrder: 0)
    }

    private func item(_ id: String, base: Int, available: Bool = true, mods: [Modifier] = []) -> MenuItem {
        let group = ModifierGroup(id: id + "-g", name: "g", required: false, multiSelect: true, sortOrder: 0, modifiers: mods)
        return MenuItem(id: id, name: id.capitalized, description: nil, basePriceCents: base,
                        imageURL: nil, available: available, quantityLeft: nil,
                        modifierGroups: mods.isEmpty ? [] : [group])
    }

    private func index(_ items: [MenuItem]) -> [String: MenuItem] {
        Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
    }

    func test_resolve_availableSamePrice_isReady() {
        let items = index([item("latte", base: 525)])
        let sig = ReorderSignature(menuItemId: "latte", modifierIds: [], quantity: 1, lastUnitPriceCents: 525)
        let outcome = ReorderResolver.resolve(sig, in: items)
        guard case let .ready(r) = outcome else { return XCTFail("expected .ready") }
        XCTAssertEqual(r.item.id, "latte")
        XCTAssertEqual(r.liveUnitPriceCents, 525)
        XCTAssertEqual(r.quantity, 1)
    }

    func test_resolve_priceChanged_isReview() {
        let items = index([item("latte", base: 550)]) // was 525
        let sig = ReorderSignature(menuItemId: "latte", modifierIds: [], quantity: 1, lastUnitPriceCents: 525)
        guard case .review = ReorderResolver.resolve(sig, in: items) else { return XCTFail("expected .review") }
    }

    func test_resolve_unavailableItem_isUnavailable() {
        let items = index([item("latte", base: 525, available: false)])
        let sig = ReorderSignature(menuItemId: "latte", modifierIds: [], quantity: 1, lastUnitPriceCents: 525)
        guard case .unavailable = ReorderResolver.resolve(sig, in: items) else { return XCTFail("expected .unavailable") }
    }

    func test_resolve_missingItem_isUnavailable() {
        let sig = ReorderSignature(menuItemId: "ghost", modifierIds: [], quantity: 1, lastUnitPriceCents: 525)
        guard case .unavailable = ReorderResolver.resolve(sig, in: [:]) else { return XCTFail("expected .unavailable") }
    }

    func test_resolve_summsModifierDeltasIntoLivePrice() {
        // base 600 + oat(+50) + lightIce(0) = 650; baseline 650 → ready
        let items = index([item("matcha", base: 600, mods: [mod("oat", 50), mod("lightIce", 0)])])
        let sig = ReorderSignature(menuItemId: "matcha", modifierIds: ["lightIce", "oat"], quantity: 1, lastUnitPriceCents: 650)
        guard case let .ready(r) = ReorderResolver.resolve(sig, in: items) else { return XCTFail("expected .ready") }
        XCTAssertEqual(r.liveUnitPriceCents, 650)
        XCTAssertEqual(Set(r.modifierIds), Set(["oat", "lightIce"]))
    }

    func test_indexByID_flattensAllCategories() {
        let menu = Menu(locationId: "loc", categories: [
            MenuCategory(id: "c1", name: "Coffee", sortOrder: 0, items: [item("latte", base: 525)], displayStyle: .list),
            MenuCategory(id: "c2", name: "Matcha", sortOrder: 1, items: [item("matcha", base: 645)], displayStyle: .spotlight),
        ], cachedAt: "")
        let idx = ReorderResolver.indexByID(menu)
        XCTAssertEqual(Set(idx.keys), Set(["latte", "matcha"]))
    }
}
