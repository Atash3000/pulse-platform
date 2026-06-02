import XCTest
@testable import PulseCoffeeApp

final class MenuViewModelTests: XCTestCase {

    // MARK: - Fixtures

    private func item(_ id: String,
                      temperature: Temperature,
                      featured: Bool = false) -> MenuItem {
        // Use the JSON round-trip so we exercise the real init(from:).
        let json = """
        {
          "id": "\(id)", "name": "\(id)", "description": null,
          "base_price_cents": 100, "image_url": null,
          "available": true, "quantity_left": null, "modifier_groups": [],
          "temperature": "\(temperature.rawValue)", "featured": \(featured),
          "art_token": null
        }
        """.data(using: .utf8)!
        return try! JSONDecoder().decode(MenuItem.self, from: json)
    }

    private func category(_ id: String,
                          displayStyle: CategoryDisplayStyle,
                          items: [MenuItem]) -> MenuCategory {
        // Build via Codable so we go through the real init(from:).
        let itemsJson = items.map { try! JSONEncoder().encode($0) }
            .map { String(data: $0, encoding: .utf8)! }
            .joined(separator: ",")
        let json = """
        {
          "id": "\(id)", "name": "\(id)", "sort_order": 0,
          "display_style": "\(displayStyle.rawValue)",
          "items": [\(itemsJson)]
        }
        """.data(using: .utf8)!
        return try! JSONDecoder().decode(MenuCategory.self, from: json)
    }

    private func menu(_ categories: [MenuCategory]) -> Menu {
        let categoriesJson = categories.map { try! JSONEncoder().encode($0) }
            .map { String(data: $0, encoding: .utf8)! }
            .joined(separator: ",")
        let json = """
        {
          "location_id": "loc",
          "categories": [\(categoriesJson)],
          "cached_at": "2026-05-28T00:00:00Z"
        }
        """.data(using: .utf8)!
        return try! JSONDecoder().decode(Menu.self, from: json)
    }

    // MARK: - Tests

    func test_filter_all_returnsEveryItem() {
        let m = menu([
            category("c", displayStyle: .list, items: [
                item("hot", temperature: .hot),
                item("iced", temperature: .iced),
                item("both", temperature: .both),
            ])
        ])
        let filtered = MenuViewModel.filter(m, by: .all)
        XCTAssertEqual(filtered.categories.first?.items.map(\.id), ["hot", "iced", "both"])
    }

    func test_filter_hot_keepsHotAndBoth() {
        let m = menu([
            category("c", displayStyle: .list, items: [
                item("hot", temperature: .hot),
                item("iced", temperature: .iced),
                item("both", temperature: .both),
            ])
        ])
        let filtered = MenuViewModel.filter(m, by: .hot)
        XCTAssertEqual(filtered.categories.first?.items.map(\.id).sorted(), ["both", "hot"])
    }

    func test_filter_iced_keepsIcedAndBoth() {
        let m = menu([
            category("c", displayStyle: .list, items: [
                item("hot", temperature: .hot),
                item("iced", temperature: .iced),
                item("both", temperature: .both),
            ])
        ])
        let filtered = MenuViewModel.filter(m, by: .iced)
        XCTAssertEqual(filtered.categories.first?.items.map(\.id).sorted(), ["both", "iced"])
    }

    func test_filter_hidesCategoriesWithNoMatchingItems() {
        let m = menu([
            category("hot-only", displayStyle: .list, items: [
                item("a", temperature: .hot),
            ]),
            category("iced-only", displayStyle: .list, items: [
                item("b", temperature: .iced),
            ])
        ])
        let filtered = MenuViewModel.filter(m, by: .iced)
        XCTAssertEqual(filtered.categories.map(\.id), ["iced-only"],
                       "Categories with zero matching items must be hidden")
    }

    func test_filter_spotlight_featuredItemFilteredOut_fallsBackToFirstRemaining() {
        // The featured item is .hot. Filter to .iced. Spotlight must still
        // render — first remaining item becomes the hero (covered by the
        // section view, not the filter; here we just confirm the items
        // array's first element is the right one).
        let m = menu([
            category("spot", displayStyle: .spotlight, items: [
                item("hot-featured", temperature: .hot, featured: true),
                item("iced-1",       temperature: .iced),
                item("iced-2",       temperature: .iced),
            ])
        ])
        let filtered = MenuViewModel.filter(m, by: .iced)
        XCTAssertEqual(filtered.categories.first?.items.map(\.id), ["iced-1", "iced-2"])
    }

    func test_filter_preservesCategoryOrder_andItemOrder() {
        let m = menu([
            category("first",  displayStyle: .list, items: [item("a", temperature: .both)]),
            category("second", displayStyle: .list, items: [item("b", temperature: .both)]),
        ])
        let filtered = MenuViewModel.filter(m, by: .all)
        XCTAssertEqual(filtered.categories.map(\.id), ["first", "second"])
    }

    // MARK: - activeCategoryId (scroll-spy section picker)

    func test_activeCategoryId_empty_returnsNil() {
        XCTAssertNil(MenuViewModel.activeCategoryId(sectionTops: [], threshold: 0))
    }

    func test_activeCategoryId_noneCrossed_returnsFirst() {
        let tops: [(id: MenuCategory.ID, top: CGFloat)] = [("a", 120), ("b", 400), ("c", 700)]
        XCTAssertEqual(MenuViewModel.activeCategoryId(sectionTops: tops, threshold: 0), "a")
    }

    func test_activeCategoryId_middleCrossed_returnsThatSection() {
        let tops: [(id: MenuCategory.ID, top: CGFloat)] = [("a", -100), ("b", -20), ("c", 150)]
        XCTAssertEqual(MenuViewModel.activeCategoryId(sectionTops: tops, threshold: 0), "b")
    }

    func test_activeCategoryId_lastCrossed_returnsLast() {
        let tops: [(id: MenuCategory.ID, top: CGFloat)] = [("a", -300), ("b", -120), ("c", -10)]
        XCTAssertEqual(MenuViewModel.activeCategoryId(sectionTops: tops, threshold: 0), "c")
    }

    func test_activeCategoryId_exactThresholdTie_sectionAtThresholdWins() {
        // 'b' sits exactly at the threshold; it counts as crossed (<=) and is
        // the last such section, so it wins over 'a'. Deterministic.
        let tops: [(id: MenuCategory.ID, top: CGFloat)] = [("a", -10), ("b", 0), ("c", 50)]
        XCTAssertEqual(MenuViewModel.activeCategoryId(sectionTops: tops, threshold: 0), "b")
    }
}
