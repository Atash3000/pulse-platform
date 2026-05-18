import Foundation

/// Fetches the full menu tree for a given location.
///
/// Backend caches the menu in Redis for 10 minutes per location and
/// throttles `GET /menu` at 60-req/min/IP. For personal-MVP iOS there's
/// no in-app caching layer yet — the menu is fetched once per app launch
/// and held in `MenuViewModel`. Disk cache (per Golden Rule #1) lands in
/// a future commit if we decide to ship a real launch app.
actor MenuService {
    static let shared = MenuService()

    private let client: APIClient

    init(client: APIClient = .shared) {
        self.client = client
    }

    /// Returns the full menu for the given location. Throws `APIError`
    /// on transport / decoding failures (including the 404 the backend
    /// returns when `locationId` is unknown).
    func fetchMenu(locationId: String) async throws -> Menu {
        try await client.get(
            "/menu",
            query: [URLQueryItem(name: "locationId", value: locationId)]
        )
    }
}
