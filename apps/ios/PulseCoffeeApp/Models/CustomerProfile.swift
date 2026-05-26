import Foundation

/// Maps to backend:
/// - `apps/api/src/modules/auth/auth.service.ts` — the `customer` nested object
///   inside `CustomerAuthResponse`.
///
/// Phase 1 surfaces only the fields the iOS UI actually displays
/// (`id`, `email`, `firstName`, `lastName`, `nickname`). Phone, date of
/// birth, loyalty tier, etc. are absent intentionally — they are write-only
/// at registration today and will be added when a screen needs them and the
/// backend endpoint actually returns them (no `GET /customers/me` exists yet;
/// see decision-log "[iOS] Contracts source of truth").
/// `Codable` (Decodable + Encodable). The Encodable half is used by
/// `Keychain.saveCustomer` so the profile can be persisted alongside
/// the access + refresh tokens — `AppState.bootstrap()` reads it back
/// synchronously on launch to populate `.loggedIn(profile)` without a
/// network round-trip.
struct CustomerProfile: Codable, Equatable {
    let id: String
    let email: String
    let firstName: String
    let lastName: String
    /// Optional barista-facing nickname (e.g. "Abdu"). `nil` when unset.
    let nickname: String?

    enum CodingKeys: String, CodingKey {
        case id
        case email
        case firstName = "first_name"
        case lastName = "last_name"
        case nickname
    }
}
