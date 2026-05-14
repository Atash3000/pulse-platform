import Foundation

/// Maps to backend:
/// - `apps/api/src/modules/auth/auth.service.ts` (`RefreshResponse`)
/// - Returned from `POST /api/v1/auth/refresh`
///
/// Request body for the refresh endpoint is `{ refresh_token: string }` — the
/// Encodable for that request lives with the auth feature (commit #4), not here.
struct RefreshResponse: Decodable, Equatable {
    let accessToken: String

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
    }
}
