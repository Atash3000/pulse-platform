import XCTest
@testable import PulseCoffeeApp

@MainActor
final class CartManagerTests: XCTestCase {

    private func makeItem(
        id: String = "item-1",
        name: String = "Latte",
        price: Int = 650,
        modifierGroups: [ModifierGroup] = []
    ) -> MenuItem {
        MenuItem(
            id: id,
            name: name,
            description: nil,
            basePriceCents: price,
            imageURL: nil,
            available: true,
            quantityLeft: nil,
            modifierGroups: modifierGroups
        )
    }

    // MARK: - add

    func test_add_singleItem_addsLineWithQuantityOne() {
        let cart = CartManager()
        cart.add(item: makeItem())

        XCTAssertEqual(cart.lineCount, 1)
        XCTAssertEqual(cart.totalItemCount, 1)
        XCTAssertEqual(cart.lines.first?.quantity, 1)
    }

    func test_add_sameItemTwice_incrementsExistingLineQuantity() {
        let cart = CartManager()
        let item = makeItem()
        cart.add(item: item)
        cart.add(item: item)

        XCTAssertEqual(cart.lineCount, 1)
        XCTAssertEqual(cart.totalItemCount, 2)
    }

    func test_add_differentItems_createsSeparateLines() {
        let cart = CartManager()
        cart.add(item: makeItem(id: "a", name: "Latte"))
        cart.add(item: makeItem(id: "b", name: "Espresso"))

        XCTAssertEqual(cart.lineCount, 2)
        XCTAssertEqual(cart.totalItemCount, 2)
    }

    func test_add_sameItemDifferentModifiers_createsSeparateLines() {
        let cart = CartManager()
        let item = makeItem()
        cart.add(item: item, modifierIds: ["oat-milk"])
        cart.add(item: item, modifierIds: [])

        XCTAssertEqual(cart.lineCount, 2, "Same item with different modifier sets should be distinct lines")
    }

    func test_add_zeroQuantity_isNoOp() {
        let cart = CartManager()
        cart.add(item: makeItem(), quantity: 0)
        XCTAssertTrue(cart.isEmpty)
    }

    func test_add_negativeQuantity_isNoOp() {
        let cart = CartManager()
        cart.add(item: makeItem(), quantity: -5)
        XCTAssertTrue(cart.isEmpty)
    }

    // MARK: - setQuantity

    func test_setQuantity_toPositive_updatesLine() {
        let cart = CartManager()
        cart.add(item: makeItem())
        let lineId = cart.lines[0].id

        cart.setQuantity(for: lineId, to: 5)

        XCTAssertEqual(cart.lines[0].quantity, 5)
        XCTAssertEqual(cart.totalItemCount, 5)
    }

    func test_setQuantity_toZero_removesLine() {
        let cart = CartManager()
        cart.add(item: makeItem())
        let lineId = cart.lines[0].id

        cart.setQuantity(for: lineId, to: 0)

        XCTAssertTrue(cart.isEmpty)
    }

    func test_setQuantity_toNegative_removesLine() {
        let cart = CartManager()
        cart.add(item: makeItem())
        let lineId = cart.lines[0].id

        cart.setQuantity(for: lineId, to: -1)

        XCTAssertTrue(cart.isEmpty)
    }

    // MARK: - remove

    func test_remove_specificLine_leavesOthers() {
        let cart = CartManager()
        cart.add(item: makeItem(id: "a"))
        cart.add(item: makeItem(id: "b"))
        let firstLineId = cart.lines[0].id

        cart.remove(lineId: firstLineId)

        XCTAssertEqual(cart.lineCount, 1)
        XCTAssertEqual(cart.lines.first?.item.id, "b")
    }

    // MARK: - clear

    func test_clear_emptiesCart() {
        let cart = CartManager()
        cart.add(item: makeItem(id: "a"), quantity: 3)
        cart.add(item: makeItem(id: "b"), quantity: 2)

        cart.clear()

        XCTAssertTrue(cart.isEmpty)
        XCTAssertEqual(cart.totalItemCount, 0)
    }

    // MARK: - wire format

    func test_toCheckoutItems_emitsBackendShape() {
        let cart = CartManager()
        cart.add(item: makeItem(id: "a"), quantity: 2)
        cart.add(item: makeItem(id: "b"), quantity: 1, modifierIds: ["m-1"])

        let items = cart.toCheckoutItems()

        XCTAssertEqual(items.count, 2)
        XCTAssertEqual(items[0].menuItemId, "a")
        XCTAssertEqual(items[0].quantity, 2)
        XCTAssertEqual(items[0].modifierIds, [])
        XCTAssertEqual(items[1].menuItemId, "b")
        XCTAssertEqual(items[1].modifierIds, ["m-1"])
    }

    // MARK: - itemIds (for idempotency key)

    func test_itemIds_repeatsByQuantity() {
        let cart = CartManager()
        cart.add(item: makeItem(id: "latte"), quantity: 3)
        cart.add(item: makeItem(id: "espresso"), quantity: 1)

        // Idempotency key generator sees `[latte, latte, latte, espresso]`
        // and sorts internally, so order here is insertion order.
        XCTAssertEqual(cart.itemIds, ["latte", "latte", "latte", "espresso"])
    }

    // MARK: - Detail → cart wiring (via ItemCustomization)

    private func sizeGroupFixture() -> ModifierGroup {
        ModifierGroup(id: "size", name: "Size", required: true, multiSelect: false, sortOrder: 0, modifiers: [
            Modifier(id: "s12", name: "12oz", priceCents: 0, sortOrder: 0),
            Modifier(id: "s16", name: "16oz", priceCents: 50, sortOrder: 1),
        ])
    }

    func test_configuredItem_addsLineWithSelectedModifierIds() {
        let cart = CartManager()
        let group = sizeGroupFixture()
        let item = makeItem(modifierGroups: [group])
        var custom = ItemCustomization(item: item)
        custom.toggle(modifierId: "s16", in: group)

        cart.add(item: item, modifierIds: custom.selectedModifierIds)

        XCTAssertEqual(cart.lines.count, 1)
        XCTAssertEqual(cart.lines[0].modifierIds, ["s16"])
    }

    func test_requiredModifierItem_yieldsNonEmptyModifierIds_regression() {
        // Regression for the old stub that sent an empty modifier list,
        // causing MODIFIER_GROUP_REQUIRED at checkout.
        let item = makeItem(modifierGroups: [sizeGroupFixture()])
        let custom = ItemCustomization(item: item) // default pre-selects first
        XCTAssertFalse(custom.selectedModifierIds.isEmpty)
    }

    func test_twoConfigurations_createTwoLines_identicalMerge() {
        let cart = CartManager()
        let item = makeItem(modifierGroups: [sizeGroupFixture()])
        cart.add(item: item, modifierIds: ["s12"])
        cart.add(item: item, modifierIds: ["s16"]) // different → new line
        cart.add(item: item, modifierIds: ["s12"]) // same as first → merge
        XCTAssertEqual(cart.lines.count, 2)
        XCTAssertEqual(cart.totalItemCount, 3)
    }

    // MARK: - updateLine

    func test_updateLine_changesModifiers_preservingQuantity() {
        let cart = CartManager()
        let item = MenuItem(id: "i", name: "Latte", description: nil, basePriceCents: 550, imageURL: nil,
            available: true, quantityLeft: nil, modifierGroups: [])
        cart.add(item: item, quantity: 3, modifierIds: ["oat"])
        let id = cart.lines[0].id
        cart.updateLine(lineId: id, modifierIds: ["whole"])
        XCTAssertEqual(cart.lines.count, 1)
        XCTAssertEqual(cart.lines[0].modifierIds, ["whole"])
        XCTAssertEqual(cart.lines[0].quantity, 3)
    }

    func test_updateLine_mergesIntoCollidingLine() {
        let cart = CartManager()
        let item = MenuItem(id: "i", name: "Latte", description: nil, basePriceCents: 550, imageURL: nil,
            available: true, quantityLeft: nil, modifierGroups: [])
        cart.add(item: item, quantity: 1, modifierIds: ["whole"])   // line A
        cart.add(item: item, quantity: 2, modifierIds: ["oat"])     // line B
        let bId = cart.lines[1].id
        cart.updateLine(lineId: bId, modifierIds: ["whole"])        // B now matches A → merge
        XCTAssertEqual(cart.lines.count, 1)
        XCTAssertEqual(cart.lines[0].quantity, 3)
        XCTAssertEqual(cart.lines[0].modifierIds, ["whole"])
    }

    func test_updateLine_unknownId_isNoOp() {
        let cart = CartManager()
        let item = MenuItem(id: "i", name: "Latte", description: nil, basePriceCents: 550, imageURL: nil,
            available: true, quantityLeft: nil, modifierGroups: [])
        cart.add(item: item, quantity: 1, modifierIds: [])
        cart.updateLine(lineId: UUID(), modifierIds: ["x"])
        XCTAssertEqual(cart.lines.count, 1)
        XCTAssertEqual(cart.lines[0].modifierIds, [])
    }

    func test_updateLine_sameModifiers_keepsSingleLine_preservingConfigAndQuantity() {
        let cart = CartManager()
        let item = MenuItem(id: "i", name: "Latte", description: nil, basePriceCents: 550, imageURL: nil,
            available: true, quantityLeft: nil, modifierGroups: [])
        cart.add(item: item, quantity: 2, modifierIds: ["oat"])
        let originalId = cart.lines[0].id
        cart.updateLine(lineId: originalId, modifierIds: ["oat"])  // edit to the same config
        XCTAssertEqual(cart.lines.count, 1)
        XCTAssertEqual(cart.lines[0].modifierIds, ["oat"])
        XCTAssertEqual(cart.lines[0].quantity, 2)
    }

    func test_updateLine_mergesIntoForwardLine_whenEditedLinePrecedesTarget() {
        let cart = CartManager()
        let item = MenuItem(id: "i", name: "Latte", description: nil, basePriceCents: 550, imageURL: nil,
            available: true, quantityLeft: nil, modifierGroups: [])
        cart.add(item: item, quantity: 2, modifierIds: ["oat"])    // index 0 — edited
        cart.add(item: item, quantity: 1, modifierIds: ["whole"])  // index 1 — collision target
        let editedId = cart.lines[0].id
        cart.updateLine(lineId: editedId, modifierIds: ["whole"])  // mergeIndex(1) > index(0)
        XCTAssertEqual(cart.lines.count, 1)
        XCTAssertEqual(cart.lines[0].modifierIds, ["whole"])
        XCTAssertEqual(cart.lines[0].quantity, 3)
    }

    func test_updateLine_explicitQuantity_replacesQuantity() {
        let cart = CartManager()
        let item = MenuItem(id: "i", name: "Latte", description: nil, basePriceCents: 550, imageURL: nil,
            available: true, quantityLeft: nil, modifierGroups: [])
        cart.add(item: item, quantity: 2, modifierIds: ["oat"])
        let id = cart.lines[0].id
        cart.updateLine(lineId: id, modifierIds: ["whole"], quantity: 5)
        XCTAssertEqual(cart.lines.count, 1)
        XCTAssertEqual(cart.lines[0].modifierIds, ["whole"])
        XCTAssertEqual(cart.lines[0].quantity, 5)
    }

    func test_updateLine_explicitQuantity_mergeAddsNewQuantity() {
        let cart = CartManager()
        let item = MenuItem(id: "i", name: "Latte", description: nil, basePriceCents: 550, imageURL: nil,
            available: true, quantityLeft: nil, modifierGroups: [])
        cart.add(item: item, quantity: 1, modifierIds: ["whole"])  // A
        cart.add(item: item, quantity: 2, modifierIds: ["oat"])    // B
        let bId = cart.lines[1].id
        cart.updateLine(lineId: bId, modifierIds: ["whole"], quantity: 3)  // B → matches A, merge with NEW qty
        XCTAssertEqual(cart.lines.count, 1)
        XCTAssertEqual(cart.lines[0].quantity, 1 + 3)
    }
}
