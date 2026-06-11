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

    enum CodingKeys: String, CodingKey {
        case id, name, address, phone, timezone
        case currentWaitMinutes = "current_wait_minutes"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.name = try c.decode(String.self, forKey: .name)
        self.address = try c.decode(String.self, forKey: .address)
        self.phone = try c.decodeIfPresent(String.self, forKey: .phone)
        self.timezone = try c.decode(String.self, forKey: .timezone)
        self.currentWaitMinutes = (try? c.decode(Int.self, forKey: .currentWaitMinutes)) ?? 5
    }

    /// Memberwise init for tests / previews.
    init(id: String, name: String, address: String, phone: String?, timezone: String, currentWaitMinutes: Int = 5) {
        self.id = id; self.name = name; self.address = address
        self.phone = phone; self.timezone = timezone; self.currentWaitMinutes = currentWaitMinutes
    }
}
