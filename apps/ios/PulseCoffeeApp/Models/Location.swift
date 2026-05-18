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
}
