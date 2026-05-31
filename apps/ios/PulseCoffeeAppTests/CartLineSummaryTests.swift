import XCTest
@testable import PulseCoffeeApp

@MainActor
final class CartLineSummaryTests: XCTestCase {
    private func mod(_ id: String, _ name: String, _ sort: Int = 0) -> Modifier { Modifier(id: id, name: name, priceCents: 0, sortOrder: sort) }
    private func line(_ ids: [String]) -> CartManager.Line {
        let size = ModifierGroup(id: "size", name: "Size", required: true, multiSelect: false, sortOrder: 0,
            modifiers: [mod("s12", "12 oz", 0), mod("s16", "16 oz", 1)])
        let milk = ModifierGroup(id: "milk", name: "Milk", required: true, multiSelect: false, sortOrder: 1,
            modifiers: [mod("oat", "Oat", 0), mod("whole", "Whole", 1)])
        let extras = ModifierGroup(id: "extras", name: "Extras", required: false, multiSelect: true, sortOrder: 3,
            modifiers: [mod("shot", "Matcha shot", 0), mod("van", "Vanilla syrup", 1)])
        let item = MenuItem(id: "m", name: "Ginger Matcha", description: nil, basePriceCents: 675, imageURL: nil,
            available: true, quantityLeft: nil, modifierGroups: [size, milk, extras], temperature: .iced, artToken: "ginger-matcha")
        return CartManager.Line(item: item, quantity: 1, modifierIds: ids)
    }

    func test_modifierSummary_joinsSingleSelectByGroupSortOrder() {
        XCTAssertEqual(CartLineSummary.modifierSummary(for: line(["s16", "oat"])), "16 oz · Oat")
    }
    func test_extras_listsMultiSelectSelections() {
        XCTAssertEqual(CartLineSummary.extras(for: line(["s16", "oat", "shot"])), ["Matcha shot"])
    }
    func test_extras_emptyWhenNoneSelected() {
        XCTAssertTrue(CartLineSummary.extras(for: line(["s16", "oat"])).isEmpty)
    }
    func test_temperature_passesThrough() {
        XCTAssertEqual(CartLineSummary.temperature(for: line(["s12", "oat"])), .iced)
    }
}
