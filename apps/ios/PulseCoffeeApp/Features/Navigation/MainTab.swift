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

    /// SF Symbol name for the selected state (filled variant).
    var selectedSymbolName: String {
        switch self {
        case .home:    return "house.fill"
        case .menu:    return "cup.and.saucer.fill"
        case .orders:  return "bag.fill"
        case .account: return "person.crop.circle.fill"
        }
    }
}
