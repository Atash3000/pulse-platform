import XCTest
@testable import PulseCoffeeApp

@MainActor
final class CartEstimateTests: XCTestCase {
    private func mod(_ id: String, _ cents: Int) -> Modifier { Modifier(id: id, name: id, priceCents: cents, sortOrder: 0) }
    private func item() -> MenuItem {
        let size = ModifierGroup(id: "size", name: "Size", required: true, multiSelect: false, sortOrder: 0,
            modifiers: [mod("s12", 0), mod("s16", 60)])
        let milk = ModifierGroup(id: "milk", name: "Milk", required: true, multiSelect: false, sortOrder: 1,
            modifiers: [mod("oat", 75), mod("whole", 0)])
        return MenuItem(id: "matcha", name: "Ginger Matcha", description: nil, basePriceCents: 675,
            imageURL: nil, available: true, quantityLeft: nil, modifierGroups: [size, milk], artToken: "ginger-matcha")
    }

    func test_lineEstimate_isBasePlusSelectedDeltas_timesQuantity() {
        let line = CartManager.Line(item: item(), quantity: 2, modifierIds: ["s16", "oat"]) // 675+60+75 = 810
        XCTAssertEqual(CartEstimate.lineEstimateCents(line), 810 * 2)
    }
    func test_lineEstimate_ignoresUnselectedModifiers() {
        let line = CartManager.Line(item: item(), quantity: 1, modifierIds: ["s12", "whole"]) // both 0
        XCTAssertEqual(CartEstimate.lineEstimateCents(line), 675)
    }
    func test_subtotal_sumsLines() {
        let a = CartManager.Line(item: item(), quantity: 1, modifierIds: ["s16", "oat"]) // 810
        let b = CartManager.Line(item: item(), quantity: 1, modifierIds: ["s12", "whole"]) // 675
        XCTAssertEqual(CartEstimate.subtotalEstimateCents([a, b]), 810 + 675)
    }
    func test_subtotal_emptyIsZero() {
        XCTAssertEqual(CartEstimate.subtotalEstimateCents([]), 0)
    }
    func test_displayPrice_formats() {
        XCTAssertEqual(CartEstimate.displayPrice(810), "$8.10")
    }
}
