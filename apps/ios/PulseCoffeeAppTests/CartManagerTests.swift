import XCTest
@testable import PulseCoffeeApp

@MainActor
final class CartManagerTests: XCTestCase {

    private func makeItem(id: String = "item-1", name: String = "Latte", price: Int = 650) -> MenuItem {
        MenuItem(
            id: id,
            name: name,
            description: nil,
            basePriceCents: price,
            imageURL: nil,
            available: true,
            quantityLeft: nil,
            modifierGroups: []
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
}
