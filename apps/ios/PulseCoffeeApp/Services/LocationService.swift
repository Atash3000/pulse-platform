import Foundation

/// Thin service that fetches the active locations list.
///
/// For Phase 1 personal-MVP testing there's exactly one location ("Pulse
/// Coffee — Main St"), so this service exposes a `firstLocation()`
/// convenience. Multi-location picker UI lands in Phase 2 if a second
/// shop opens.
///
/// No caching today — the locations list is fetched on app launch and
/// held in `MenuViewModel`. The endpoint is public and small (one row),
/// so refreshing is cheap.
actor LocationService {
    static let shared = LocationService()

    private let client: APIClient

    init(client: APIClient = .shared) {
        self.client = client
    }

    /// Returns the first active location. Throws `LocationServiceError.noLocationsAvailable`
    /// if the backend has no active rows — useful test signal when
    /// `npm run seed:dev` hasn't run yet on a fresh database.
    func firstLocation() async throws -> LocationSummary {
        let locations: [LocationSummary] = try await client.get("/locations")
        guard let first = locations.first else {
            throw LocationServiceError.noLocationsAvailable
        }
        return first
    }
}

enum LocationServiceError: Error, Equatable {
    /// Backend returned an empty locations array. Most likely cause:
    /// `npm run seed:dev` hasn't been run on the dev's local backend.
    case noLocationsAvailable
}
