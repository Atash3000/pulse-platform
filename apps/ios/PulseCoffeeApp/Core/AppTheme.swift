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
        static let tabBarBackground = Color(.systemBackground)
        static let divider = Color(.separator)

        static let pulseMatcha = Color(red: 94 / 255, green: 127 / 255, blue: 45 / 255)
        static let pulseMatchaLight = Color(red: 167 / 255, green: 201 / 255, blue: 87 / 255)
        static let pulseCream = Color(red: 246 / 255, green: 244 / 255, blue: 239 / 255)
        static let tabIconActive = Color(red: 154 / 255, green: 107 / 255, blue: 0 / 255)
        static let tabIconInactive = Color(red: 122 / 255, green: 102 / 255, blue: 75 / 255)
        static let tabIconBrand = pulseMatcha
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
