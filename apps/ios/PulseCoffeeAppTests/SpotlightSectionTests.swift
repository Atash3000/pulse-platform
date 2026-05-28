import XCTest
@testable import PulseCoffeeApp

/// Pins the hero-pick rule that drives the v4 Menu's spotlight section.
/// The bug this guards against: backend orders matcha items by
/// `name ASC` (apps/api/src/modules/menu/menu.service.ts:184), so
/// Strawberry Matcha — the seeded `featured: true` drink — is last
/// alphabetically. Picking `items.first` would put Brown Sugar Matcha
/// in the hero slot.
final class SpotlightSectionTests: XCTestCase {

    private func item(_ id: String, featured: Bool = false) -> MenuItem {
        let json = """
        {
          "id": "\(id)", "name": "\(id)", "description": null,
          "base_price_cents": 100, "image_url": null,
          "available": true, "quantity_left": null, "modifier_groups": [],
          "temperature": "both", "featured": \(featured), "art_token": null
        }
        """.data(using: .utf8)!
        return try! JSONDecoder().decode(MenuItem.self, from: json)
    }

    func test_hero_picksFeaturedItem_evenWhenNotFirstInArray() {
        // Matches the seed shape: featured item arrives last under name-ASC order.
        let items = [
            item("brown-sugar-matcha"),
            item("ginger-matcha"),
            item("raspberry-matcha"),
            item("strawberry-matcha", featured: true),
        ]
        XCTAssertEqual(SpotlightSection.hero(in: items)?.id,
                       "strawberry-matcha",
                       "Hero must be the featured item regardless of its position in the backend-ordered array")
    }

    func test_hero_fallsBackToFirstItem_whenNoneFeatured() {
        let items = [item("a"), item("b"), item("c")]
        XCTAssertEqual(SpotlightSection.hero(in: items)?.id, "a")
    }

    func test_hero_isNil_forEmptyInput() {
        XCTAssertNil(SpotlightSection.hero(in: []))
    }

    func test_hero_picksFirstFeatured_whenMultipleAreFlagged() {
        // Defensive: backend contract is at-most-one featured per category,
        // but the iOS pick should still be deterministic if that breaks.
        let items = [
            item("a"),
            item("b", featured: true),
            item("c", featured: true),
        ]
        XCTAssertEqual(SpotlightSection.hero(in: items)?.id, "b",
                       "When multiple items are featured, the first one wins (stable, deterministic)")
    }

    func test_nonHeroItems_dropsHeroByID_notByIndex() throws {
        let items = [
            item("brown-sugar-matcha"),
            item("ginger-matcha"),
            item("raspberry-matcha"),
            item("strawberry-matcha", featured: true),
        ]
        let hero = try XCTUnwrap(SpotlightSection.hero(in: items))
        let rest = SpotlightSection.nonHeroItems(in: items, hero: hero)
        XCTAssertEqual(rest.map(\.id),
                       ["brown-sugar-matcha", "ginger-matcha", "raspberry-matcha"],
                       "Scroll row must exclude the hero by ID — a naive dropFirst() would keep the featured item and drop the alphabetically-first one instead")
    }

    func test_nonHeroItems_returnsEmpty_whenHeroIsOnlyItem() throws {
        let items = [item("solo", featured: true)]
        let hero = try XCTUnwrap(SpotlightSection.hero(in: items))
        XCTAssertEqual(SpotlightSection.nonHeroItems(in: items, hero: hero), [])
    }
}
