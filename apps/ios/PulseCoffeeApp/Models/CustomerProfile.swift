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
/// `Codable` (Decodable + Encodable). The Encodable half is used by
/// `Keychain.saveCustomer` so the profile can be persisted alongside
/// the access + refresh tokens — `AppState.bootstrap()` reads it back
/// synchronously on launch to populate `.loggedIn(profile)` without a
/// network round-trip.
struct CustomerProfile: Codable, Equatable {
    let id: String
    let email: String
    let fullName: String

    enum CodingKeys: String, CodingKey {
        case id
        case email
        case fullName = "full_name"
    }
}
