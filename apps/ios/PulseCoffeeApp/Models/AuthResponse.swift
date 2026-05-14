import Foundation

// =============================================================================
// iOS Codable convention — read first if you're adding a new model.
//
// 1. Every model carries a `///` doc comment naming the backend file(s) it
//    mirrors. `git grep "<backend file path>" apps/ios/` surfaces every
//    iOS impact site when the backend changes.
//
// 2. Snake_case wire fields map to camelCase Swift properties via explicit
//    `CodingKeys`. We do NOT use `JSONDecoder.keyDecodingStrategy =
//    .convertFromSnakeCase` — the strategy approach silently keeps working
//    after a backend rename; an explicit CodingKey makes the rename a
//    compile-time signal.
//
// 3. Cases whose Swift name already matches the wire name (e.g. `email`,
//    `customer`) do not need to appear in the `CodingKeys` enum — Swift
//    fills them in by default. List them anyway when the file is short
//    enough; clarity beats brevity for contracts.
//
// 4. Mark models `Equatable` when they're cheap to compare; tests rely on
//    it for round-trip assertions.
//
// See docs/decision-log.md → "[iOS] Contracts source of truth: backend
// DTOs + Swagger" for the full rationale.
// =============================================================================

/// Maps to backend:
/// - `apps/api/src/modules/auth/auth.service.ts` (`CustomerAuthResponse`)
/// - Returned from `POST /api/v1/auth/register` and `POST /api/v1/auth/login`
struct AuthResponse: Decodable, Equatable {
    let accessToken: String
    let refreshToken: String
    let customer: CustomerProfile

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case customer
    }
}
