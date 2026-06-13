import Foundation

/// Maps to backend:
/// - `apps/api/src/modules/locations/locations.service.ts`
///   (`PublicLocationSummary`)
/// - Returned by `GET /api/v1/locations` (array — no auth required)
///
/// Phase-1 personal-MVP uses a single hardcoded location chosen as the
/// first row from `GET /locations`. Multi-location selection UI lands in
/// Phase 2 if a second shop ships.
struct LocationSummary: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let address: String
    let phone: String?
    let timezone: String
    /// Current estimated prep wait in minutes for this location. Drives the
    /// Home greeting ("no line" / "~N min") and hero "Ready in N min".
    /// Decoded fail-safe: missing key → 5 (the backend's own default).
    let currentWaitMinutes: Int
    /// Server-computed badge state in the shop's timezone. nil → hide the badge.
    let storeStatus: StoreStatus?
    /// Instant the status next changes; drives the iOS live flip. nil → no timer.
    let nextTransitionAt: Date?
    /// Today's scheduled hours ("HH:mm"), nil on a closed day / no hours.
    let todayOpen: String?
    let todayClose: String?

    enum CodingKeys: String, CodingKey {
        case id, name, address, phone, timezone
        case currentWaitMinutes = "current_wait_minutes"
        case status
        case nextTransitionAt = "next_transition_at"
        case todayOpen = "today_open"
        case todayClose = "today_close"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.name = try c.decode(String.self, forKey: .name)
        self.address = try c.decode(String.self, forKey: .address)
        self.phone = try c.decodeIfPresent(String.self, forKey: .phone)
        self.timezone = try c.decode(String.self, forKey: .timezone)
        self.currentWaitMinutes = (try? c.decode(Int.self, forKey: .currentWaitMinutes)) ?? 5
        self.storeStatus = StoreStatus(wire: (try? c.decodeIfPresent(String.self, forKey: .status)) ?? nil)
        self.nextTransitionAt = (try? c.decodeIfPresent(Date.self, forKey: .nextTransitionAt)) ?? nil
        self.todayOpen = (try? c.decodeIfPresent(String.self, forKey: .todayOpen)) ?? nil
        self.todayClose = (try? c.decodeIfPresent(String.self, forKey: .todayClose)) ?? nil
    }

    /// Memberwise init for tests / previews.
    init(id: String, name: String, address: String, phone: String?, timezone: String,
         currentWaitMinutes: Int = 5, storeStatus: StoreStatus? = nil,
         nextTransitionAt: Date? = nil, todayOpen: String? = nil, todayClose: String? = nil) {
        self.id = id; self.name = name; self.address = address
        self.phone = phone; self.timezone = timezone; self.currentWaitMinutes = currentWaitMinutes
        self.storeStatus = storeStatus; self.nextTransitionAt = nextTransitionAt
        self.todayOpen = todayOpen; self.todayClose = todayClose
    }
}
