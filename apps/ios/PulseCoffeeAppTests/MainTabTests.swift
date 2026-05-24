import XCTest
import UIKit
import SwiftUI
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
        // The filled / outlined variants are the visual cue the custom
        // tab bar uses for selected state while `tabBarSymbolName` stays
        // as the stable base symbol.
        for tab in MainTab.allCases {
            XCTAssertNotEqual(tab.symbolName, tab.selectedSymbolName,
                              "tab \(tab.rawValue) selected/unselected symbols must differ")
        }
    }

    func test_tabBarSymbols_areStableBaseSymbols() {
        XCTAssertEqual(MainTab.home.tabBarSymbolName, "house")
        XCTAssertEqual(MainTab.menu.tabBarSymbolName, "cup.and.saucer")
        XCTAssertEqual(MainTab.orders.tabBarSymbolName, "bag")
        XCTAssertEqual(MainTab.account.tabBarSymbolName, "person.crop.circle")
    }

    func test_layeredAssetNames_brandTabsOverrideSFSymbol() {
        XCTAssertEqual(MainTab.home.layeredAssetNames,
                       LayeredTabAsset(baseName: "PulseHomeMark",
                                       accentName: "PulseHomeLeafAccent"))
        XCTAssertEqual(MainTab.menu.layeredAssetNames,
                       LayeredTabAsset(baseName: "PulseMenuMark",
                                       accentName: "PulseMenuAccent"))
        XCTAssertEqual(MainTab.orders.layeredAssetNames,
                       LayeredTabAsset(baseName: "PulseOrdersMark",
                                       accentName: "PulseOrdersAccent"))
        XCTAssertNil(MainTab.account.layeredAssetNames)
    }

    func test_customAssetName_singleLayerBrandTabsOverrideSFSymbol() {
        XCTAssertNil(MainTab.home.customAssetName)
        XCTAssertNil(MainTab.menu.customAssetName)
        XCTAssertNil(MainTab.orders.customAssetName)
        XCTAssertEqual(MainTab.account.customAssetName, "PulseAccountMark")
    }

    func test_customAssets_existInBundle() {
        XCTAssertNotNil(UIImage(named: "PulseHomeMark"))
        XCTAssertNotNil(UIImage(named: "PulseHomeLeafAccent"))
        XCTAssertNotNil(UIImage(named: "PulseMenuMark"))
        XCTAssertNotNil(UIImage(named: "PulseMenuAccent"))
        XCTAssertNotNil(UIImage(named: "PulseOrdersMark"))
        XCTAssertNotNil(UIImage(named: "PulseOrdersAccent"))
        XCTAssertNotNil(UIImage(named: "PulseAccountMark"))
    }

    func test_navBarSpecColors_areStable() {
        assertColor(AppTheme.Colors.tabIconActive,
                    equals: Color(red: 200 / 255, green: 151 / 255, blue: 58 / 255))
        assertColor(AppTheme.Colors.tabIconInactive,
                    equals: Color(red: 168 / 255, green: 140 / 255, blue: 114 / 255))
        assertColor(AppTheme.Colors.tabIconMatchaAccent,
                    equals: Color(red: 139 / 255, green: 168 / 255, blue: 136 / 255))
        assertColor(AppTheme.Colors.tabLabelActive,
                    equals: Color(red: 26 / 255, green: 18 / 255, blue: 8 / 255))
        assertColor(AppTheme.Colors.tabLabelInactive,
                    equals: AppTheme.Colors.tabIconInactive)
        assertColor(AppTheme.Colors.tabBarBackground,
                    equals: Color(red: 251 / 255, green: 247 / 255, blue: 240 / 255))
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

    private func assertColor(
        _ actual: Color,
        equals expected: Color,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        assertUIColor(UIColor(actual),
                      equals: UIColor(expected),
                      userInterfaceStyle: .light,
                      file: file,
                      line: line)
        assertUIColor(UIColor(actual),
                      equals: UIColor(expected),
                      userInterfaceStyle: .dark,
                      file: file,
                      line: line)
    }

    private func assertUIColor(
        _ actual: UIColor,
        equals expected: UIColor,
        userInterfaceStyle: UIUserInterfaceStyle,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let traits = UITraitCollection(userInterfaceStyle: userInterfaceStyle)
        let actualComponents = rgbaComponents(actual.resolvedColor(with: traits),
                                              file: file,
                                              line: line)
        let expectedComponents = rgbaComponents(expected.resolvedColor(with: traits),
                                                file: file,
                                                line: line)

        XCTAssertEqual(actualComponents.red, expectedComponents.red, accuracy: 0.001, file: file, line: line)
        XCTAssertEqual(actualComponents.green, expectedComponents.green, accuracy: 0.001, file: file, line: line)
        XCTAssertEqual(actualComponents.blue, expectedComponents.blue, accuracy: 0.001, file: file, line: line)
        XCTAssertEqual(actualComponents.alpha, expectedComponents.alpha, accuracy: 0.001, file: file, line: line)
    }

    private func rgbaComponents(
        _ color: UIColor,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> (red: CGFloat, green: CGFloat, blue: CGFloat, alpha: CGFloat) {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        XCTAssertTrue(color.getRed(&red,
                                   green: &green,
                                   blue: &blue,
                                   alpha: &alpha),
                      "Expected RGB-compatible color",
                      file: file,
                      line: line)
        return (red, green, blue, alpha)
    }
}
