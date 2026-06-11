import Foundation

/// Fetches the Home reorder summary (most-frequent "usual" + recent configs)
/// for the signed-in customer. Customer JWT is injected by `APIClient`.
actor HomeService {
    static let shared = HomeService()

    private let client: APIClient

    init(client: APIClient = .shared) {
        self.client = client
    }

    /// Throws `APIError` on transport/decoding failure. Callers degrade
    /// fail-safe (Home is a non-critical surface, Golden Rule #17).
    func fetchSummary() async throws -> HomeSummary {
        try await client.get("/home/summary", query: [])
    }
}
