import Foundation

/// Maps to backend:
/// - `apps/api/src/modules/auth/auth.service.ts` — the `customer` nested object
///   inside `CustomerAuthResponse`.
///
/// Phase 1 surfaces only the three fields the iOS UI actually displays
/// (`id`, `email`, `fullName`). Phone, loyalty tier, etc. are absent intentionally
/// — they will be added when the corresponding screen needs them and the
/// backend endpoint actually returns them (no `GET /customers/me` exists today;
/// see decision-log "[iOS] Contracts source of truth").
struct CustomerProfile: Decodable, Equatable {
    let id: String
    let email: String
    let fullName: String

    enum CodingKeys: String, CodingKey {
        case id
        case email
        case fullName = "full_name"
    }
}
