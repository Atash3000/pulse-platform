import XCTest
@testable import PulseCoffeeApp

/// Locks down the public contract of the `MainTab` enum that drives the
/// signed-in tab bar. View rendering itself isn't asserted here (would
/// require a snapshot harness); the model layer is what analytics and
/// any future deep-link router will key off of, so that's what we pin.
final class MainTabTests: XCTestCase {

    func test_allCases_areInExpectedOrderAndCount() {
        XCTAssertEqual(MainTab.allCases, [.home, .menu, .orders, .account])
    }

    func test_eachTab_hasNonEmptyTitleAndSymbols() {
        for tab in MainTab.allCases {
            XCTAssertFalse(tab.title.isEmpty,
                           "tab \(tab.rawValue) must have a title")
            XCTAssertFalse(tab.symbolName.isEmpty,
                           "tab \(tab.rawValue) must have an unselected SF Symbol")
            XCTAssertFalse(tab.selectedSymbolName.isEmpty,
                           "tab \(tab.rawValue) must have a selected SF Symbol")
        }
    }

    func test_selectedSymbol_differsFromUnselected() {
        // The filled / outlined variants are the visual cue that a tab
        // is active; if a future edit collapses them to the same string
        // we lose the affordance silently. Pin it.
        for tab in MainTab.allCases {
            XCTAssertNotEqual(tab.symbolName, tab.selectedSymbolName,
                              "tab \(tab.rawValue) selected/unselected symbols must differ")
        }
    }

    func test_idMatchesRawValue() {
        for tab in MainTab.allCases {
            XCTAssertEqual(tab.id, tab.rawValue)
        }
    }

    func test_rawValues_areStableForAnalytics() {
        // Analytics events ship the raw value as a string property.
        // Changing any of these is a breaking change for the data team —
        // this test exists to make that breakage loud at code-review time.
        XCTAssertEqual(MainTab.home.rawValue,    "home")
        XCTAssertEqual(MainTab.menu.rawValue,    "menu")
        XCTAssertEqual(MainTab.orders.rawValue,  "orders")
        XCTAssertEqual(MainTab.account.rawValue, "account")
    }
}
