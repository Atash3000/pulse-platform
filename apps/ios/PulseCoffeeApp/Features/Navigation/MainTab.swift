import Foundation

/// The four top-level destinations of the signed-in app, modelled as a
/// typed enum so the tab bar, deep-links, and analytics events all share
/// one identifier set instead of raw strings.
///
/// Order of `allCases` is the order tabs appear in the bar — left to right.
enum MainTab: String, CaseIterable, Identifiable, Hashable {
    case home
    case menu
    case orders
    case account

    var id: String { rawValue }

    /// Label shown under the tab icon.
    var title: String {
        switch self {
        case .home:    return "Home"
        case .menu:    return "Menu"
        case .orders:  return "Orders"
        case .account: return "Account"
        }
    }

    /// SF Symbol name for the unselected state.
    var symbolName: String {
        switch self {
        case .home:    return "house"
        case .menu:    return "cup.and.saucer"
        case .orders:  return "bag"
        case .account: return "person.crop.circle"
        }
    }

    /// Base SF Symbol used by the custom tab bar.
    ///
    /// Keep the fallback static so the selected and brand-specific variants
    /// can be layered on without changing analytics/deep-link identifiers.
    var tabBarSymbolName: String { symbolName }

    /// Asset Catalog icon for brand-specific tabs.
    var customAssetName: String? {
        switch self {
        case .home: return "PulseHomeMark"
        case .menu: return "PulseCupMark"
        case .account: return "PulseAccountMark"
        default:    return nil
        }
    }

    /// Rendering mode for brand-specific tab assets.
    ///
    /// Original-rendered assets keep multi-color logo gradients. Template
    /// assets opt into the shared active/inactive tab icon color system.
    var customAssetRendering: TabAssetRendering {
        switch self {
        case .home, .account: return .template
        default:             return .original
        }
    }

    /// SF Symbol name for the selected state (filled variant).
    /// Used by placeholder content and the custom tab bar.
    var selectedSymbolName: String {
        switch self {
        case .home:    return "house.fill"
        case .menu:    return "cup.and.saucer.fill"
        case .orders:  return "bag.fill"
        case .account: return "person.crop.circle.fill"
        }
    }
}

enum TabAssetRendering: Equatable {
    case original
    case template
}
