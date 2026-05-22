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

    /// SF Symbol used by the system tab bar.
    ///
    /// Keep SF Symbol fallbacks static. Selected-state swapping belongs in
    /// a future custom tab bar; the system tab bar should own sizing.
    var tabBarSymbolName: String { symbolName }

    /// Asset Catalog icon for brand-specific tabs.
    var customAssetName: String? {
        switch self {
        case .menu: return "PulseCupMark"
        default:    return nil
        }
    }

    /// SF Symbol name for the selected state (filled variant).
    /// Used by placeholder content and available for a future custom tab bar.
    var selectedSymbolName: String {
        switch self {
        case .home:    return "house.fill"
        case .menu:    return "cup.and.saucer.fill"
        case .orders:  return "bag.fill"
        case .account: return "person.crop.circle.fill"
        }
    }
}
