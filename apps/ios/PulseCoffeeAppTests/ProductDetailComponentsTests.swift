import XCTest
@testable import PulseCoffeeApp

@MainActor
final class ProductDetailComponentsTests: XCTestCase {
    func test_itemBadge_knownTypes_mapToLabels() {
        XCTAssertEqual(ItemBadge(badgeType: "signature").label, "Signature")
        XCTAssertEqual(ItemBadge(badgeType: "staff_pick").label, "Staff Pick")
        XCTAssertEqual(ItemBadge(badgeType: "seasonal").label, "Seasonal")
    }

    func test_itemBadge_unknownOrNil_rendersNoLabel() {
        // GR#17 fail-safe: an unrecognized or absent badge renders nothing.
        XCTAssertNil(ItemBadge(badgeType: "new_arrival").label)
        XCTAssertNil(ItemBadge(badgeType: nil).label)
    }
}
