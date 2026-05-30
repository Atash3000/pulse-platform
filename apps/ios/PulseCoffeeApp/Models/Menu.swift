import Foundation

/// Maps to backend:
/// - `apps/api/src/modules/menu/menu.service.ts` (`PublicMenu` interface)
/// - Returned by `GET /api/v1/menu?locationId=<uuid>` (no auth required;
///   60-req/min/IP throttle)
///
/// The backend pre-resolves availability (`available`) by joining
/// `menu_items` with `inventory` so iOS never has to do the math.
/// Modifier groups ship in the same payload but the personal-MVP screens
/// ignore them — they'll be wired when the cart / item-detail screens
/// add modifier selection.
///
/// v4 presentation fields (added in concern A, decoded here in concern
/// B): MenuItem.temperature / .featured / .artToken and
/// MenuCategory.displayStyle. All decode fail-safe — unknown enum
/// values + missing JSON keys fall back to `.both`, `false`, `nil`,
/// `.list` respectively (Golden Rule #17).

/// Drink temperature, drives the v4 Menu screen's temperature toggle
/// and per-item pill. Decoded fail-safe: unknown raw values + missing
/// JSON key both fall back to `.both` so an item never disappears
/// silently from the menu (Golden Rule #17).
enum Temperature: String, Codable, Equatable, Hashable {
    case hot
    case iced
    case both

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Temperature(rawValue: raw) ?? .both
    }
}

/// How a category renders on the v4 Menu screen. `spotlight` = hero
/// card + horizontal scroll; `list` = vertical rows. Unknown raw value
/// + missing JSON key both decode to `.list` (the safest rendering).
enum CategoryDisplayStyle: String, Codable, Equatable, Hashable {
    case spotlight
    case list

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = CategoryDisplayStyle(rawValue: raw) ?? .list
    }
}

struct Menu: Codable, Equatable {
    let locationId: String
    let categories: [MenuCategory]
    /// ISO-8601 timestamp Sentry / debugging can use to spot stale
    /// Redis-cache hits.
    let cachedAt: String

    enum CodingKeys: String, CodingKey {
        case locationId = "location_id"
        case categories
        case cachedAt = "cached_at"
    }

    /// Memberwise init — needed by `replaceCategories` since the
    /// struct otherwise gets only the auto-synthesized decoder init.
    init(locationId: String, categories: [MenuCategory], cachedAt: String) {
        self.locationId = locationId
        self.categories = categories
        self.cachedAt = cachedAt
    }
}

extension Menu {
    mutating func replaceCategories(_ newCategories: [MenuCategory]) {
        self = Menu(locationId: self.locationId,
                    categories: newCategories,
                    cachedAt: self.cachedAt)
    }
}

struct MenuCategory: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let sortOrder: Int
    let items: [MenuItem]
    /// `spotlight` = hero card + horizontal-scroll cards. `list` =
    /// vertical rows. Backend ships `'spotlight' | 'list'`; missing
    /// or unknown decodes to `.list` (Golden Rule #17).
    let displayStyle: CategoryDisplayStyle

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case sortOrder = "sort_order"
        case items
        case displayStyle = "display_style"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.name = try c.decode(String.self, forKey: .name)
        self.sortOrder = try c.decode(Int.self, forKey: .sortOrder)
        self.items = try c.decode([MenuItem].self, forKey: .items)
        self.displayStyle = (try? c.decode(CategoryDisplayStyle.self, forKey: .displayStyle)) ?? .list
    }

    /// Memberwise init — needed by `replaceItems`.
    init(id: String, name: String, sortOrder: Int, items: [MenuItem], displayStyle: CategoryDisplayStyle) {
        self.id = id
        self.name = name
        self.sortOrder = sortOrder
        self.items = items
        self.displayStyle = displayStyle
    }
}

extension MenuCategory {
    mutating func replaceItems(_ newItems: [MenuItem]) {
        self = MenuCategory(id: self.id,
                            name: self.name,
                            sortOrder: self.sortOrder,
                            items: newItems,
                            displayStyle: self.displayStyle)
    }
}

struct MenuItem: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let name: String
    let description: String?
    /// Price in integer cents per Golden Rule #7 ("All money in integer
    /// cents"). Display formatting is the UI layer's responsibility —
    /// see `MenuItem.displayPrice` below.
    let basePriceCents: Int
    let imageURL: URL?
    /// Composed by the backend from `inventory.available` AND
    /// `inventory.quantity_left`. True ⇒ item is orderable.
    let available: Bool
    /// `nil` when the item has unlimited stock; otherwise an explicit
    /// remaining count. iOS shows "Only N left" when the count is small.
    let quantityLeft: Int?
    let modifierGroups: [ModifierGroup]
    /// Drives the v4 temperature toggle + per-item pill. Missing /
    /// unknown decodes to `.both` (Golden Rule #17).
    let temperature: Temperature
    /// Spotlight categories pick their hero from the featured item.
    /// Defaults `false` when missing.
    let featured: Bool
    /// Opaque key the iOS `DrinkArt` view maps to a drawn abstract
    /// symbol. `nil` / unknown → neutral fallback.
    let artToken: String?
    /// Optional monochrome merchandising badge: "signature" | "staff_pick"
    /// | "seasonal". `nil` / unknown → no badge (Golden Rule #17). Never a
    /// social-proof number.
    let badgeType: String?

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case description
        case basePriceCents = "base_price_cents"
        case imageURL = "image_url"
        case available
        case quantityLeft = "quantity_left"
        case modifierGroups = "modifier_groups"
        case temperature
        case featured
        case artToken = "art_token"
        case badgeType = "badge_type"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.name = try c.decode(String.self, forKey: .name)
        self.description = try c.decodeIfPresent(String.self, forKey: .description)
        self.basePriceCents = try c.decode(Int.self, forKey: .basePriceCents)
        self.imageURL = try c.decodeIfPresent(URL.self, forKey: .imageURL)
        self.available = try c.decode(Bool.self, forKey: .available)
        self.quantityLeft = try c.decodeIfPresent(Int.self, forKey: .quantityLeft)
        self.modifierGroups = try c.decode([ModifierGroup].self, forKey: .modifierGroups)
        self.temperature = (try? c.decode(Temperature.self, forKey: .temperature)) ?? .both
        self.featured = (try? c.decode(Bool.self, forKey: .featured)) ?? false
        self.artToken = try c.decodeIfPresent(String.self, forKey: .artToken)
        self.badgeType = try c.decodeIfPresent(String.self, forKey: .badgeType)
    }

    /// Memberwise init used by tests (e.g. `displayPrice` assertions) and
    /// any call site that constructs a `MenuItem` in memory rather than
    /// decoding from JSON. New v4 fields default to safe values so v3-era
    /// call sites don't need to be updated.
    init(
        id: String,
        name: String,
        description: String?,
        basePriceCents: Int,
        imageURL: URL?,
        available: Bool,
        quantityLeft: Int?,
        modifierGroups: [ModifierGroup],
        temperature: Temperature = .both,
        featured: Bool = false,
        artToken: String? = nil,
        badgeType: String? = nil
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.basePriceCents = basePriceCents
        self.imageURL = imageURL
        self.available = available
        self.quantityLeft = quantityLeft
        self.modifierGroups = modifierGroups
        self.temperature = temperature
        self.featured = featured
        self.artToken = artToken
        self.badgeType = badgeType
    }

    /// Display string for the base price (e.g. "$6.50"). Display only —
    /// never use for any pricing logic. Backend is the only source of
    /// truth for money math (Golden Rule #8).
    var displayPrice: String {
        let dollars = Double(basePriceCents) / 100.0
        return String(format: "$%.2f", dollars)
    }
}

struct ModifierGroup: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let name: String
    let required: Bool
    let multiSelect: Bool
    let sortOrder: Int
    let modifiers: [Modifier]

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case required
        case multiSelect = "multi_select"
        case sortOrder = "sort_order"
        case modifiers
    }
}

struct Modifier: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let name: String
    /// Price delta in integer cents (can be 0).
    let priceCents: Int
    let sortOrder: Int

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case priceCents = "price_cents"
        case sortOrder = "sort_order"
    }
}
