import Foundation

/// Structured error body returned by the backend on 4xx / 5xx responses.
///
/// Maps to two backend shapes (NestJS conflates them depending on which guard
/// rejected the request):
///
/// 1. **Structured cart / domain errors** — `{ reason, message, ...meta }`
///    Example callers:
///    - `apps/api/src/modules/checkout/checkout.service.ts` (`cartValidationError`)
///    - `apps/api/src/modules/customers/customers.service.ts` (`PUSH_TOKEN_INVALID`)
///    The `reason` field is a stable string code (e.g. `ITEM_NOT_FOUND`,
///    `MODIFIER_GROUP_REQUIRED`). ViewModels switch on it for localized copy.
///
/// 2. **NestJS default validation errors** — `{ statusCode, message, error }`
///    where `message` can be either a single `String` (most exceptions) or an
///    array of strings (class-validator constraint failures). The custom
///    `init(from:)` below decodes both shapes into a single `message: String`.
struct ServerError: Decodable, Equatable, Error {
    /// Stable code (e.g. "ITEM_NOT_FOUND"), present on structured backend errors.
    /// Absent on raw NestJS validation errors.
    let reason: String?

    /// Human-readable text. Operator-facing English; ViewModels use `reason`
    /// for localization branching, fall back to `message` otherwise.
    let message: String

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.reason = try container.decodeIfPresent(String.self, forKey: .reason)

        // `message` is either a String (most exceptions) or [String]
        // (class-validator). Try the singular form first, then the array form.
        if let single = try? container.decode(String.self, forKey: .message) {
            self.message = single
        } else if let multiple = try? container.decode([String].self, forKey: .message) {
            self.message = multiple.joined(separator: "; ")
        } else {
            // Backend sent something we don't recognise. Surface a placeholder
            // rather than throwing — the HTTP status code is still informative
            // for the caller (it lives in `APIError.serverError(_, statusCode:)`).
            self.message = "Server error"
        }
    }

    /// Convenience initialiser for tests.
    init(reason: String?, message: String) {
        self.reason = reason
        self.message = message
    }

    enum CodingKeys: String, CodingKey {
        case reason
        case message
    }
}
