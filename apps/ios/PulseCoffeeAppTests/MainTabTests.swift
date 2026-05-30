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
        XCTAssertEqual(MainTab.allCases,
                       [.home, .menu, .orders, .rewards, .account])
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
        XCTAssertEqual(MainTab.home.tabBarSymbolName,    "house")
        XCTAssertEqual(MainTab.menu.tabBarSymbolName,    "list.bullet")
        XCTAssertEqual(MainTab.orders.tabBarSymbolName,  "bag")
        XCTAssertEqual(MainTab.rewards.tabBarSymbolName, "medal")
        XCTAssertEqual(MainTab.account.tabBarSymbolName, "person.crop.circle")
    }

    func test_layeredAssetNames_brandTabsOverrideSFSymbol() {
        XCTAssertEqual(MainTab.home.layeredAssetNames,
                       LayeredTabAsset(baseName: "PulseHomeMark",
                                       accentName: "PulseHomeLeafAccent"))
        XCTAssertNil(MainTab.menu.layeredAssetNames)
        XCTAssertEqual(MainTab.orders.layeredAssetNames,
                       LayeredTabAsset(baseName: "PulseOrdersMark",
                                       accentName: "PulseOrdersAccent"))
        XCTAssertNil(MainTab.rewards.layeredAssetNames)
        XCTAssertNil(MainTab.account.layeredAssetNames)
    }

    func test_customAssetName_singleLayerBrandTabsOverrideSFSymbol() {
        XCTAssertNil(MainTab.home.customAssetName)
        XCTAssertNil(MainTab.menu.customAssetName)
        XCTAssertNil(MainTab.orders.customAssetName)
        XCTAssertNil(MainTab.rewards.customAssetName)
        XCTAssertEqual(MainTab.account.customAssetName, "PulseAccountMark")
    }

    func test_customAssets_existInBundle() {
        XCTAssertNotNil(UIImage(named: "PulseHomeMark"))
        XCTAssertNotNil(UIImage(named: "PulseHomeLeafAccent"))
        XCTAssertNotNil(UIImage(named: "PulseOrdersMark"))
        XCTAssertNotNil(UIImage(named: "PulseOrdersAccent"))
        XCTAssertNotNil(UIImage(named: "PulseAccountMark"))
    }

    func test_navBarColors_areStable() {
        assertColor(AppTheme.Colors.tabIconActive,
                    equals: Color(red: 184 / 255, green: 131 / 255, blue: 30 / 255))
        assertColor(AppTheme.Colors.tabIconInactive,
                    equals: Color(red: 122 / 255, green: 102 / 255, blue: 75 / 255))
        assertColor(AppTheme.Colors.tabIconMatchaAccent,
                    equals: Color(red: 111 / 255, green: 139 / 255, blue: 112 / 255))
        assertColor(AppTheme.Colors.tabLabelActive,
                    equals: Color(red: 26 / 255, green: 18 / 255, blue: 8 / 255))
        assertColor(AppTheme.Colors.tabLabelInactive,
                    equals: AppTheme.Colors.tabIconInactive)
        assertColor(AppTheme.Colors.tabBarBackground,
                    equals: Color(red: 251 / 255, green: 247 / 255, blue: 240 / 255))
    }

    func test_navBarIconColors_passMinimumContrastAgainstCreamBar() {
        assertMinimumContrast(AppTheme.Colors.tabIconActive,
                              against: AppTheme.Colors.tabBarBackground,
                              threshold: 3.0,
                              purpose: "active tab icon")
        assertMinimumContrast(AppTheme.Colors.tabIconInactive,
                              against: AppTheme.Colors.tabBarBackground,
                              threshold: 3.0,
                              purpose: "inactive tab icon")
        assertMinimumContrast(AppTheme.Colors.tabIconMatchaAccent,
                              against: AppTheme.Colors.tabBarBackground,
                              threshold: 3.0,
                              purpose: "active matcha accent")
    }

    func test_navBarLabelColors_passTextContrastAgainstCreamBar() {
        assertMinimumContrast(AppTheme.Colors.tabLabelActive,
                              against: AppTheme.Colors.tabBarBackground,
                              threshold: 4.5,
                              purpose: "active tab label")
        assertMinimumContrast(AppTheme.Colors.tabLabelInactive,
                              against: AppTheme.Colors.tabBarBackground,
                              threshold: 4.5,
                              purpose: "inactive tab label")
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
        XCTAssertEqual(MainTab.rewards.rawValue, "rewards")
        XCTAssertEqual(MainTab.account.rawValue, "account")
    }

    func test_tabBarVisibility_defaultsVisible_andTogglesHidden() {
        let vis = TabBarVisibility()
        XCTAssertFalse(vis.isHidden)
        vis.isHidden = true
        XCTAssertTrue(vis.isHidden)
    }

    func test_tabBadge_visibilityThreshold() {
        XCTAssertFalse(MainTab.shouldShowBadge(count: 0),
                       "Badge must be hidden when the count is zero (fail-safe)")
        XCTAssertFalse(MainTab.shouldShowBadge(count: -1),
                       "Badge must be hidden for negative counts (defensive)")
        XCTAssertTrue(MainTab.shouldShowBadge(count: 1),
                      "Badge must show for any positive count")
        XCTAssertTrue(MainTab.shouldShowBadge(count: 99),
                      "Badge must show for large counts")
    }

    func test_tabBadge_displayText_capsAt99Plus() {
        XCTAssertEqual(MainTab.badgeText(count: 1),   "1")
        XCTAssertEqual(MainTab.badgeText(count: 9),   "9")
        XCTAssertEqual(MainTab.badgeText(count: 99),  "99")
        XCTAssertEqual(MainTab.badgeText(count: 100), "99+")
        XCTAssertEqual(MainTab.badgeText(count: 999), "99+")
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

    private func assertMinimumContrast(
        _ foreground: Color,
        against background: Color,
        threshold: CGFloat,
        purpose: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let traits = UITraitCollection(userInterfaceStyle: .light)
        let foregroundColor = UIColor(foreground).resolvedColor(with: traits)
        let backgroundColor = UIColor(background).resolvedColor(with: traits)
        let ratio = contrastRatio(foregroundColor, backgroundColor)

        XCTAssertGreaterThanOrEqual(ratio,
                                    threshold,
                                    "\(purpose) contrast must be at least \(threshold):1 against the fixed cream tab bar",
                                    file: file,
                                    line: line)
    }

    private func contrastRatio(_ lhs: UIColor, _ rhs: UIColor) -> CGFloat {
        let lhsLuminance = relativeLuminance(lhs)
        let rhsLuminance = relativeLuminance(rhs)
        let lighter = max(lhsLuminance, rhsLuminance)
        let darker = min(lhsLuminance, rhsLuminance)
        return (lighter + 0.05) / (darker + 0.05)
    }

    private func relativeLuminance(_ color: UIColor) -> CGFloat {
        let components = rgbaComponents(color)
        let red = linearizedColorComponent(components.red)
        let green = linearizedColorComponent(components.green)
        let blue = linearizedColorComponent(components.blue)
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue
    }

    private func linearizedColorComponent(_ component: CGFloat) -> CGFloat {
        component <= 0.03928
            ? component / 12.92
            : pow((component + 0.055) / 1.055, 2.4)
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
