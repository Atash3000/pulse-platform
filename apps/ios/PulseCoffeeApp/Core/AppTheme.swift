import SwiftUI

/// Shared visual tokens for Pulse Coffee.
///
/// Keep reusable colors, icon sizing, and small layout constants here so
/// broad visual changes are one edit instead of a search-and-replace pass
/// across feature screens.
enum AppTheme {
    enum Colors {
        static let accent = Color.blue
        static let iconSecondary = Color.secondary
        static let warning = Color.orange
        static let destructive = Color.red
        static let onBadge = Color.white
        static let tabBarBackground = Color(red: 251 / 255, green: 247 / 255, blue: 240 / 255)
        static let divider = Color(red: 122 / 255, green: 92 / 255, blue: 68 / 255)

        static let pulseMatcha = Color(red: 94 / 255, green: 127 / 255, blue: 45 / 255)
        static let pulseMatchaLight = Color(red: 167 / 255, green: 201 / 255, blue: 87 / 255)
        static let pulseCream = Color(red: 246 / 255, green: 244 / 255, blue: 239 / 255)
        static let tabIconActive = Color(red: 200 / 255, green: 151 / 255, blue: 58 / 255)
        static let tabIconInactive = Color(red: 168 / 255, green: 140 / 255, blue: 114 / 255)
        static let tabIconMatchaAccent = Color(red: 139 / 255, green: 168 / 255, blue: 136 / 255)
        static let tabLabelActive = Color(red: 26 / 255, green: 18 / 255, blue: 8 / 255)
        static let tabLabelInactive = tabIconInactive
        static let orderReady = Color("OrderReadyColor")
        static let orderPreparing = Color("OrderPreparingColor")
    }

    enum Metrics {
        static let tabBarIconSize: CGFloat = 27
        // Brand SVGs have less optical padding than SF Symbols, so they
        // render slightly larger while the system icons keep native sizing.
        static let brandedTabIconScale: CGFloat = 1.05
        static let tabBarHeight: CGFloat = 72
        static let menuItemIconSize: CGFloat = 56
        static let menuItemIconPadding: CGFloat = 8
        static let cardCornerRadius: CGFloat = 8
    }
}
