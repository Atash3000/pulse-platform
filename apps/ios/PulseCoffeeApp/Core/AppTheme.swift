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
    }

    enum Metrics {
        static let tabBarIconSize: CGFloat = 26.4
        static let tabBarHeight: CGFloat = 72
        static let menuItemIconSize: CGFloat = 56
        static let menuItemIconPadding: CGFloat = 8
        static let cardCornerRadius: CGFloat = 8
    }
}
