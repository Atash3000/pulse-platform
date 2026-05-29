import SwiftUI

/// Shared visual tokens for Pulse Coffee.
///
/// Keep reusable colors, icon sizing, and small layout constants here so
/// broad visual changes are one edit instead of a search-and-replace pass
/// across feature screens.
enum AppTheme {
    enum Colors {
        static let iconSecondary = Color.secondary
        static let warning = Color.orange
        static let destructive = Color.red
        /// Brand warm accent — used for the matcha hero "★ HERO" eyebrow,
        /// "FEATURED" labels, and any informational call-out where the v4
        /// design uses `var(--accent-warm)` (`#c2410c`). NOT for destructive
        /// actions (that's `.destructive`).
        static let accentWarm = Color(red: 194 / 255, green: 65 / 255, blue: 12 / 255)
        static let onBadge = Color.white
        static let tabBarBackground = Color(red: 251 / 255, green: 247 / 255, blue: 240 / 255)
        static let divider = Color(red: 122 / 255, green: 92 / 255, blue: 68 / 255)

        static let tabIconActive = Color(red: 184 / 255, green: 131 / 255, blue: 30 / 255)
        static let tabIconInactive = Color(red: 122 / 255, green: 102 / 255, blue: 75 / 255)
        static let tabIconMatchaAccent = Color(red: 111 / 255, green: 139 / 255, blue: 112 / 255)
        static let tabLabelActive = Color(red: 26 / 255, green: 18 / 255, blue: 8 / 255)
        static let tabLabelInactive = tabIconInactive
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
