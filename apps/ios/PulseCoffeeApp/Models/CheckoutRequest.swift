import Foundation

// =============================================================================
// `POST /api/v1/checkout` request body.
//
// Maps to backend DTO: `apps/api/src/modules/checkout/dto/checkout-request.dto.ts`
// (`CheckoutRequestDto`).
//
// Snake_case wire format with explicit CodingKeys per the iOS Codable
// convention (see decision-log "[iOS] Contracts source of truth").
// =============================================================================

/// One line in the cart as it ships to the backend. Modifier IDs are
/// the IDs of the chosen modifiers within their respective groups —
/// the backend joins these against `modifier_groups` for the item to
/// resolve names and prices.
///
/// Personal-MVP scope: `modifierIds` is always empty because MVP items
/// don't expose modifier selection UI. Field is here so the wire format
/// stays correct against the backend's `CartItemDto`.
struct CheckoutCartItem: Encodable, Equatable {
    let menuItemId: String
    let quantity: Int
    let modifierIds: [String]

    enum CodingKeys: String, CodingKey {
        case menuItemId = "menuItemId"
        case quantity
        case modifierIds = "modifierIds"
    }
}

/// `PickupType` matches the backend enum at
/// `apps/api/src/database/entities/*` (PickupType enum). Wire format
/// is uppercase strings; the backend's DTO uppercases incoming values
/// on entry, but iOS sends already-uppercased to keep contracts honest.
enum PickupType: String, Encodable {
    case asap = "ASAP"
    case scheduled = "SCHEDULED"
}

/// Full `POST /checkout` body. Required fields per the backend DTO:
/// - `locationId` (UUID)
/// - `idempotencyKey` (regex `^[A-Za-z0-9_=:.+-]{32,128}$` — SHA256 hex is 64 chars)
/// - `items` (1-50)
/// - `tipPercent` (0-100, but seed allows [0,15,18,20,25])
/// - `pickupType`
/// Optional: `scheduledPickupAt` (ISO 8601, required when SCHEDULED),
/// `notes` (max 500 chars).
struct CheckoutRequest: Encodable {
    let locationId: String
    let idempotencyKey: String
    let items: [CheckoutCartItem]
    let tipPercent: Int
    let pickupType: PickupType
    let scheduledPickupAt: String?
    let notes: String?

    init(
        locationId: String,
        idempotencyKey: String,
        items: [CheckoutCartItem],
        tipPercent: Int = 0,
        pickupType: PickupType = .asap,
        scheduledPickupAt: String? = nil,
        notes: String? = nil
    ) {
        self.locationId = locationId
        self.idempotencyKey = idempotencyKey
        self.items = items
        self.tipPercent = tipPercent
        self.pickupType = pickupType
        self.scheduledPickupAt = scheduledPickupAt
        self.notes = notes
    }
}
