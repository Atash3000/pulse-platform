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

/// `POST /api/v1/auth/register` body. `phone` is optional on the backend.
struct RegisterRequest: Encodable, Equatable {
    let email: String
    let password: String
    let fullName: String
    let phone: String?

    enum CodingKeys: String, CodingKey {
        case email
        case password
        case fullName = "full_name"
        case phone
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
