import XCTest
@testable import PulseCoffeeApp

/// Decoding round-trips for the menu / location Codable models.
/// Payloads mirror the backend's `PublicMenu` / `PublicLocationSummary`
/// interfaces; any backend rename surfaces here as a failing test.
final class MenuTests: XCTestCase {

    private let decoder = JSONDecoder()

    // MARK: - LocationSummary

    func test_locationSummary_decodesAllFields() throws {
        let json = """
        {
          "id": "loc-uuid-1",
          "name": "Pulse Coffee — Main St",
          "address": "123 Main St, Brooklyn NY",
          "phone": "+1 718 555 0100",
          "timezone": "America/New_York"
        }
        """.data(using: .utf8)!

        let decoded = try decoder.decode(LocationSummary.self, from: json)

        XCTAssertEqual(decoded.id, "loc-uuid-1")
        XCTAssertEqual(decoded.name, "Pulse Coffee — Main St")
        XCTAssertEqual(decoded.address, "123 Main St, Brooklyn NY")
        XCTAssertEqual(decoded.phone, "+1 718 555 0100")
        XCTAssertEqual(decoded.timezone, "America/New_York")
    }

    func test_locationSummary_phoneCanBeNull() throws {
        let json = """
        {
          "id": "loc-uuid-2",
          "name": "No Phone Shop",
          "address": "Somewhere",
          "phone": null,
          "timezone": "UTC"
        }
        """.data(using: .utf8)!

        let decoded = try decoder.decode(LocationSummary.self, from: json)
        XCTAssertNil(decoded.phone)
    }

    // MARK: - Menu (full tree)

    func test_menu_decodesFullTree() throws {
        let json = """
        {
          "location_id": "loc-uuid-1",
          "cached_at": "2026-05-14T14:00:00.000Z",
          "categories": [
            {
              "id": "cat-1",
              "name": "Espresso",
              "sort_order": 0,
              "items": [
                {
                  "id": "item-1",
                  "name": "Latte",
                  "description": "Espresso + steamed milk.",
                  "base_price_cents": 650,
                  "image_url": "https://cdn.example.com/latte.jpg",
                  "available": true,
                  "quantity_left": null,
                  "modifier_groups": []
                },
                {
                  "id": "item-2",
                  "name": "Sold-Out Cortado",
                  "description": null,
                  "base_price_cents": 550,
                  "image_url": null,
                  "available": false,
                  "quantity_left": 0,
                  "modifier_groups": []
                }
              ]
            }
          ]
        }
        """.data(using: .utf8)!

        let menu = try decoder.decode(Menu.self, from: json)

        XCTAssertEqual(menu.locationId, "loc-uuid-1")
        XCTAssertEqual(menu.cachedAt, "2026-05-14T14:00:00.000Z")
        XCTAssertEqual(menu.categories.count, 1)

        let category = menu.categories[0]
        XCTAssertEqual(category.name, "Espresso")
        XCTAssertEqual(category.items.count, 2)

        let latte = category.items[0]
        XCTAssertEqual(latte.name, "Latte")
        XCTAssertEqual(latte.basePriceCents, 650)
        XCTAssertEqual(latte.imageURL?.absoluteString, "https://cdn.example.com/latte.jpg")
        XCTAssertTrue(latte.available)
        XCTAssertNil(latte.quantityLeft)

        let cortado = category.items[1]
        XCTAssertFalse(cortado.available)
        XCTAssertEqual(cortado.quantityLeft, 0)
        XCTAssertNil(cortado.description)
        XCTAssertNil(cortado.imageURL)
    }

    func test_menu_decodesWithModifierGroups() throws {
        let json = """
        {
          "location_id": "loc-x",
          "cached_at": "2026-05-14T00:00:00Z",
          "categories": [{
            "id": "c1",
            "name": "Drinks",
            "sort_order": 0,
            "items": [{
              "id": "i1",
              "name": "Build-a-latte",
              "description": null,
              "base_price_cents": 500,
              "image_url": null,
              "available": true,
              "quantity_left": null,
              "modifier_groups": [{
                "id": "g1",
                "name": "Size",
                "required": true,
                "multi_select": false,
                "sort_order": 0,
                "modifiers": [
                  { "id": "m1", "name": "S", "price_cents": 0, "sort_order": 0 },
                  { "id": "m2", "name": "L", "price_cents": 100, "sort_order": 1 }
                ]
              }]
            }]
          }]
        }
        """.data(using: .utf8)!

        let menu = try decoder.decode(Menu.self, from: json)
        let item = menu.categories[0].items[0]

        XCTAssertEqual(item.modifierGroups.count, 1)
        let group = item.modifierGroups[0]
        XCTAssertEqual(group.name, "Size")
        XCTAssertTrue(group.required)
        XCTAssertFalse(group.multiSelect)
        XCTAssertEqual(group.modifiers.count, 2)
        XCTAssertEqual(group.modifiers[0].priceCents, 0)
        XCTAssertEqual(group.modifiers[1].priceCents, 100)
    }

    // MARK: - displayPrice (display-only helper)

    func test_menuItem_displayPrice_formatsTwoDecimals() {
        let item = MenuItem(
            id: "x",
            name: "Drip",
            description: nil,
            basePriceCents: 425,
            imageURL: nil,
            available: true,
            quantityLeft: nil,
            modifierGroups: []
        )
        XCTAssertEqual(item.displayPrice, "$4.25")
    }

    func test_menuItem_displayPrice_handlesZero() {
        let item = MenuItem(
            id: "x", name: "Free", description: nil, basePriceCents: 0,
            imageURL: nil, available: true, quantityLeft: nil, modifierGroups: []
        )
        XCTAssertEqual(item.displayPrice, "$0.00")
    }

    func test_menuItem_displayPrice_handlesDollarsOnly() {
        let item = MenuItem(
            id: "x", name: "Round", description: nil, basePriceCents: 700,
            imageURL: nil, available: true, quantityLeft: nil, modifierGroups: []
        )
        XCTAssertEqual(item.displayPrice, "$7.00")
    }
}
