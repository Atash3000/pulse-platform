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
    ///
    /// Symbol choices (iOS 16+ compatible):
    /// - `home`: `house` — a Pulse customer's "your coffee place" anchor.
    /// - `menu`: `takeoutbag.and.cup.and.straw` — takeaway cup with straw,
    ///   reads as modern coffee culture rather than a generic mug.
    /// - `orders`: `list.bullet.clipboard` — receipt / in-progress feel
    ///   instead of "shopping bag" (which reads as grocery).
    /// - `account`: `star.circle` — rewards-forward; deliberate trade of
    ///   "profile" clarity for a loyalty/dopamine read inside Account.
    var symbolName: String {
        switch self {
        case .home:    return "house"
        case .menu:    return "takeoutbag.and.cup.and.straw"
        case .orders:  return "list.bullet.clipboard"
        case .account: return "star.circle"
        }
    }

    /// SF Symbol name for the selected state (filled variant). Each
    /// selected symbol is the `.fill` counterpart of `symbolName` —
    /// the filled / outlined split is the visual cue that a tab is
    /// active. `MainTabTests.test_selectedSymbol_differsFromUnselected`
    /// pins that contract.
    var selectedSymbolName: String {
        switch self {
        case .home:    return "house.fill"
        case .menu:    return "takeoutbag.and.cup.and.straw.fill"
        case .orders:  return "list.bullet.clipboard.fill"
        case .account: return "star.circle.fill"
        }
    }

    /// When non-nil, this tab renders its icon from
    /// `Assets.xcassets/<name>.imageset` instead of an SF Symbol.
    /// Used for brand-specific tab icons that can't be expressed as
    /// SF Symbols (the Pulse "P" + cup logo on Menu).
    ///
    /// The SF Symbol fields above stay populated as a fallback path —
    /// if the Asset Catalog lookup fails for any reason, the
    /// SF Symbol is still wired in the model and call sites can read
    /// either side without crashing.
    ///
    /// Trade-off, deliberate: the Asset Catalog image is rendered
    /// `original` (preserves matcha-green + cream brand colors). It
    /// will NOT tint blue when the tab is selected. Selection state
    /// for the Menu tab is conveyed through the label text tinting
    /// blue (Label's text component is tinted independently of the
    /// image). See `Features/Navigation/README.md` for the design
    /// rationale.
    var customAssetName: String? {
        switch self {
        case .menu: return "PulseCupMark"
        default:    return nil
        }
    }
}
