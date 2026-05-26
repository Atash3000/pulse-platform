import Foundation

// =============================================================================
// Encodable bodies for the auth endpoints.
//
// Maps to backend DTOs:
//   apps/api/src/modules/auth/dto/login.dto.ts
//   apps/api/src/modules/auth/dto/register.dto.ts
//   apps/api/src/modules/auth/dto/refresh.dto.ts
//
// All request bodies use the same snake_case convention as the response
// Codables — explicit CodingKeys, no global keyEncodingStrategy.
// =============================================================================

/// `POST /api/v1/auth/login` body.
struct LoginRequest: Encodable, Equatable {
    let email: String
    let password: String
}

/// `POST /api/v1/auth/register` body. `nickname`, `phone`, and
/// `dateOfBirth` are optional on the backend; `nil` values are omitted
/// from the JSON entirely (we encode only present keys) so the backend's
/// `@IsOptional()` validators see "absent", not "null".
///
/// `dateOfBirth` is the ISO-8601 calendar date (`YYYY-MM-DD`) the backend
/// expects — the caller (AuthViewModel) formats the picked `Date` with a
/// fixed `en_US_POSIX` formatter so the wire value is locale-independent.
struct RegisterRequest: Encodable, Equatable {
    let email: String
    let password: String
    let firstName: String
    let lastName: String
    let nickname: String?
    let phone: String?
    let dateOfBirth: String?

    enum CodingKeys: String, CodingKey {
        case email
        case password
        case firstName = "first_name"
        case lastName = "last_name"
        case nickname
        case phone
        case dateOfBirth = "date_of_birth"
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(email, forKey: .email)
        try container.encode(password, forKey: .password)
        try container.encode(firstName, forKey: .firstName)
        try container.encode(lastName, forKey: .lastName)
        // Omit optional keys when nil so the backend treats them as absent.
        try container.encodeIfPresent(nickname, forKey: .nickname)
        try container.encodeIfPresent(phone, forKey: .phone)
        try container.encodeIfPresent(dateOfBirth, forKey: .dateOfBirth)
    }
}

/// `POST /api/v1/auth/refresh` body. The backend validates `refresh_token`
/// as a JWT and rejects malformed inputs with a 400 (not a 401).
struct RefreshRequest: Encodable, Equatable {
    let refreshToken: String

    enum CodingKeys: String, CodingKey {
        case refreshToken = "refresh_token"
    }
}
