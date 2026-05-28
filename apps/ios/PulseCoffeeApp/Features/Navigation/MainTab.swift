import Foundation

/// The five top-level destinations of the signed-in app, modelled as a
/// typed enum so the tab bar, deep-links, and analytics events all share
/// one identifier set instead of raw strings.
///
/// Order of `allCases` is the order tabs appear in the bar — left to right.
enum MainTab: String, CaseIterable, Identifiable, Hashable {
    case home
    case menu
    case orders
    case rewards
    case account

    var id: String { rawValue }

    /// Label shown under the tab icon.
    var title: String {
        switch self {
        case .home:    return "Home"
        case .menu:    return "Menu"
        case .orders:  return "Orders"
        case .rewards: return "Rewards"
        case .account: return "Account"
        }
    }

    /// SF Symbol name for the unselected state.
    var symbolName: String {
        switch self {
        case .home:    return "house"
        case .menu:    return "list.bullet"
        case .orders:  return "bag"
        case .rewards: return "medal"
        case .account: return "person.crop.circle"
        }
    }

    /// Base SF Symbol used by the custom tab bar.
    ///
    /// Keep the fallback static so the selected and brand-specific variants
    /// can be layered on without changing analytics/deep-link identifiers.
    var tabBarSymbolName: String { symbolName }

    /// Layered Asset Catalog icons for brand-specific tabs that need a
    /// separate matcha accent in the selected state.
    var layeredAssetNames: LayeredTabAsset? {
        switch self {
        case .home:
            return LayeredTabAsset(baseName: "PulseHomeMark",
                                   accentName: "PulseHomeLeafAccent")
        case .orders:
            return LayeredTabAsset(baseName: "PulseOrdersMark",
                                   accentName: "PulseOrdersAccent")
        default:
            return nil
        }
    }

    /// Single-layer Asset Catalog icon for brand-specific tabs.
    var customAssetName: String? {
        switch self {
        case .account: return "PulseAccountMark"
        default:    return nil
        }
    }

    /// SF Symbol name for the selected state (filled variant).
    /// Used by placeholder content and the custom tab bar.
    var selectedSymbolName: String {
        switch self {
        case .home:    return "house.fill"
        case .menu:    return "list.bullet.rectangle.fill"
        case .orders:  return "bag.fill"
        case .rewards: return "medal.fill"
        case .account: return "person.crop.circle.fill"
        }
    }
}

struct LayeredTabAsset: Equatable {
    let baseName: String
    let accentName: String?
}
