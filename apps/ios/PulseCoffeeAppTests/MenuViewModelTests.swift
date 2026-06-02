import XCTest
@testable import PulseCoffeeApp

final class MenuViewModelTests: XCTestCase {

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
