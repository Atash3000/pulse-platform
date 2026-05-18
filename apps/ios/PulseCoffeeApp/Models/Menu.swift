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
struct Menu: Decodable, Equatable {
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
}

struct MenuCategory: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let sortOrder: Int
    let items: [MenuItem]

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case sortOrder = "sort_order"
        case items
    }
}

struct MenuItem: Decodable, Identifiable, Equatable {
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

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case description
        case basePriceCents = "base_price_cents"
        case imageURL = "image_url"
        case available
        case quantityLeft = "quantity_left"
        case modifierGroups = "modifier_groups"
    }

    /// Display string for the base price (e.g. "$6.50"). Display only —
    /// never use for any pricing logic. Backend is the only source of
    /// truth for money math (Golden Rule #8).
    var displayPrice: String {
        let dollars = Double(basePriceCents) / 100.0
        return String(format: "$%.2f", dollars)
    }
}

struct ModifierGroup: Decodable, Identifiable, Equatable {
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

struct Modifier: Decodable, Identifiable, Equatable {
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
