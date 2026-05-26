import XCTest
@testable import PulseCoffeeApp

/// Decoder round-trip tests for the four foundational Codable models.
///
/// Each test feeds a JSON payload mirroring the backend DTO and asserts
/// the resulting Swift struct has the expected field values. The
/// payloads are written verbatim — any backend rename surfaces here as
/// a failing test plus a compile-time CodingKey mismatch in the model.
final class CodableTests: XCTestCase {

    private let decoder = JSONDecoder()

    // MARK: - AuthResponse

    func test_authResponse_decodesSnakeCaseWireFormat() throws {
        let json = """
        {
            "access_token": "eyJhbGc.access",
            "refresh_token": "eyJhbGc.refresh",
            "customer": {
                "id": "cust-uuid-123",
                "email": "sarah@example.com",
                "first_name": "Sarah",
                "last_name": "Mitchell",
                "nickname": "Sarah M."
            }
        }
        """.data(using: .utf8)!

        let decoded = try decoder.decode(AuthResponse.self, from: json)

        XCTAssertEqual(decoded.accessToken, "eyJhbGc.access")
        XCTAssertEqual(decoded.refreshToken, "eyJhbGc.refresh")
        XCTAssertEqual(decoded.customer.id, "cust-uuid-123")
        XCTAssertEqual(decoded.customer.email, "sarah@example.com")
        XCTAssertEqual(decoded.customer.firstName, "Sarah")
        XCTAssertEqual(decoded.customer.lastName, "Mitchell")
        XCTAssertEqual(decoded.customer.nickname, "Sarah M.")
    }

    // MARK: - RefreshResponse

    func test_refreshResponse_decodesOnlyAccessToken() throws {
        let json = #"{"access_token":"eyJhbGc.new"}"#.data(using: .utf8)!
        let decoded = try decoder.decode(RefreshResponse.self, from: json)
        XCTAssertEqual(decoded.accessToken, "eyJhbGc.new")
    }

    // MARK: - CustomerProfile

    func test_customerProfile_decodesNameSplitAndNickname() throws {
        let json = """
        {"id":"u-1","email":"a@b.com","first_name":"Alice","last_name":"Brown","nickname":"Al"}
        """.data(using: .utf8)!
        let decoded = try decoder.decode(CustomerProfile.self, from: json)
        XCTAssertEqual(decoded.firstName, "Alice")
        XCTAssertEqual(decoded.lastName, "Brown")
        XCTAssertEqual(decoded.nickname, "Al")
    }

    func test_customerProfile_decodesWithMissingNicknameAsNil() throws {
        let json = """
        {"id":"u-1","email":"a@b.com","first_name":"Alice","last_name":"Brown"}
        """.data(using: .utf8)!
        let decoded = try decoder.decode(CustomerProfile.self, from: json)
        XCTAssertNil(decoded.nickname)
    }

    // MARK: - RegisterRequest (encoding)

    func test_registerRequest_encodesSnakeCaseAndOmitsNilOptionals() throws {
        let req = RegisterRequest(
            email: "a@b.com", password: "longpassword",
            firstName: "Abdurakhman", lastName: "Ivanov",
            nickname: nil, phone: nil, dateOfBirth: nil
        )
        let obj = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(req)
        ) as! [String: Any]

        XCTAssertEqual(obj["first_name"] as? String, "Abdurakhman")
        XCTAssertEqual(obj["last_name"] as? String, "Ivanov")
        // nil optionals are omitted entirely, not encoded as JSON null.
        XCTAssertFalse(obj.keys.contains("nickname"))
        XCTAssertFalse(obj.keys.contains("phone"))
        XCTAssertFalse(obj.keys.contains("date_of_birth"))
    }

    func test_registerRequest_encodesOptionalsWhenPresent() throws {
        let req = RegisterRequest(
            email: "a@b.com", password: "longpassword",
            firstName: "Abdurakhman", lastName: "Ivanov",
            nickname: "Abdu", phone: "+1 718 555 0100", dateOfBirth: "1994-03-15"
        )
        let obj = try JSONSerialization.jsonObject(
            with: JSONEncoder().encode(req)
        ) as! [String: Any]

        XCTAssertEqual(obj["nickname"] as? String, "Abdu")
        XCTAssertEqual(obj["phone"] as? String, "+1 718 555 0100")
        XCTAssertEqual(obj["date_of_birth"] as? String, "1994-03-15")
    }

    // MARK: - ServerError variants

    func test_serverError_structuredCartError_decodes() throws {
        // Mirrors apps/api/src/modules/checkout/checkout.service.ts → cartValidationError
        let json = """
        {
            "reason": "ITEM_NOT_FOUND",
            "message": "Item is no longer available.",
            "itemId": "menu-uuid-7"
        }
        """.data(using: .utf8)!
        let decoded = try decoder.decode(ServerError.self, from: json)
        XCTAssertEqual(decoded.reason, "ITEM_NOT_FOUND")
        XCTAssertEqual(decoded.message, "Item is no longer available.")
    }

    func test_serverError_nestJSSingleStringMessage_decodes() throws {
        let json = #"{"statusCode":401,"message":"Unauthorized","error":"Unauthorized"}"#
            .data(using: .utf8)!
        let decoded = try decoder.decode(ServerError.self, from: json)
        XCTAssertNil(decoded.reason)
        XCTAssertEqual(decoded.message, "Unauthorized")
    }

    func test_serverError_classValidatorArrayMessage_decodes() throws {
        // class-validator returns an array; ServerError joins them with "; ".
        let json = """
        {
            "statusCode": 400,
            "message": ["email must be an email", "password must be longer than or equal to 8 characters"],
            "error": "Bad Request"
        }
        """.data(using: .utf8)!
        let decoded = try decoder.decode(ServerError.self, from: json)
        XCTAssertNil(decoded.reason)
        XCTAssertEqual(
            decoded.message,
            "email must be an email; password must be longer than or equal to 8 characters"
        )
    }

    func test_serverError_unknownShape_returnsPlaceholderMessage() throws {
        // Some random non-error shape — should not throw, should surface a
        // placeholder. The caller still has the HTTP status code via
        // APIError.serverError(_, statusCode:).
        let json = "{}".data(using: .utf8)!
        let decoded = try decoder.decode(ServerError.self, from: json)
        XCTAssertEqual(decoded.message, "Server error")
        XCTAssertNil(decoded.reason)
    }
}
