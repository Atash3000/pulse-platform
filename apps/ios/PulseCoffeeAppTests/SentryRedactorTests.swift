import XCTest
import Sentry
@testable import PulseCoffeeApp

/// Tests for `SentryRedactor.redact` and its supporting helpers.
///
/// We exercise the pure helpers (`redactHeaders`, `redactBody`,
/// `redactStripeIDs`) directly to keep tests independent of Sentry's
/// `Event` mutation API, and we also exercise the top-level `redact(_:)`
/// against a real `Event` to confirm the full pipeline writes back into
/// `event.request.headers` and `breadcrumb.data`.
final class SentryRedactorTests: XCTestCase {

    // MARK: - redactHeaders (case-insensitive)

    func test_redactHeaders_replacesAuthorizationValue() {
        let input = [
            "Authorization": "Bearer eyJhbGc.secret",
            "Content-Type": "application/json",
        ]
        let result = SentryRedactor.redactHeaders(input)
        XCTAssertEqual(result["Authorization"], "<redacted>")
        XCTAssertEqual(result["Content-Type"], "application/json")
    }

    func test_redactHeaders_lowerCasedAuthorization_alsoRedacted() {
        let input = ["authorization": "Bearer sneaky-lowercase"]
        XCTAssertEqual(SentryRedactor.redactHeaders(input)["authorization"], "<redacted>")
    }

    func test_redactHeaders_noopWhenNoSensitiveHeaders() {
        let input = ["Content-Type": "application/json", "X-Request-Id": "abc"]
        XCTAssertEqual(SentryRedactor.redactHeaders(input), input)
    }

    // MARK: - redactBody (sensitive field redaction)

    func test_redactBody_redactsEachSensitiveField() {
        let input: [String: Any] = [
            "password": "hunter2",
            "client_secret": "pi_3Abc_secret_xyz",
            "idempotency_key": "abc123",
            "cvv": "123",
            "cvc": "456",
            "card_number": "4242424242424242",
            "email": "leave@me.alone",
        ]
        let result = SentryRedactor.redactBody(input)

        for field in ["password", "client_secret", "idempotency_key", "cvv", "cvc", "card_number"] {
            XCTAssertEqual(result[field] as? String, "<redacted>", "field \(field) should be redacted")
        }
        XCTAssertEqual(result["email"] as? String, "leave@me.alone")
    }

    func test_redactBody_idempotent() {
        let once = SentryRedactor.redactBody(["password": "hunter2"])
        let twice = SentryRedactor.redactBody(once)
        XCTAssertEqual(twice["password"] as? String, "<redacted>")
    }

    func test_redactBody_emptyBody_noop() {
        XCTAssertTrue(SentryRedactor.redactBody([:]).isEmpty)
    }

    // MARK: - redactStripeIDs

    func test_redactStripeIDs_replacesPaymentIntentId() {
        let input = "https://api.pulsecoffee.com/api/v1/orders/order-1?pi=pi_3Abc123Xyz"
        let result = SentryRedactor.redactStripeIDs(in: input)
        XCTAssertEqual(
            result,
            "https://api.pulsecoffee.com/api/v1/orders/order-1?pi=pi_<redacted>"
        )
    }

    func test_redactStripeIDs_replacesChargeAndRefundIds() {
        let input = "charge=ch_3Test refund=re_3Test2"
        let result = SentryRedactor.redactStripeIDs(in: input)
        XCTAssertEqual(result, "charge=ch_<redacted> refund=re_<redacted>")
    }

    func test_redactStripeIDs_leavesUnrelatedTextAlone() {
        let input = "pickup=ASAP location=loc-uuid-7"
        XCTAssertEqual(SentryRedactor.redactStripeIDs(in: input), input)
    }

    // MARK: - Full event pipeline

    func test_redact_appliesToEventRequestHeaders() {
        let event = Event()
        // sentry-cocoa 8.58.2's Obj-C `SentryRequest` is exposed to Swift
        // under its Obj-C name — verified by inspecting
        // `SourcePackages/checkouts/sentry-cocoa/Sources/Sentry/Public/SentryRequest.h`
        // which has `@interface SentryRequest : NSObject` with no
        // `NS_SWIFT_NAME(Request)` binding. Bare `Request` does not resolve.
        let request = SentryRequest()
        request.headers = ["Authorization": "Bearer eyJ.secret", "Accept": "application/json"]
        event.request = request

        _ = SentryRedactor.redact(event)

        XCTAssertEqual(event.request?.headers?["Authorization"], "<redacted>")
        XCTAssertEqual(event.request?.headers?["Accept"], "application/json")
    }

    func test_redact_appliesToBreadcrumbBodyAndHeaders() {
        let event = Event()
        let breadcrumb = Breadcrumb(level: .info, category: "test")
        breadcrumb.data = [
            "headers": ["Authorization": "Bearer secret"],
            "body": ["password": "hunter2", "email": "x@y.com"],
            "url": "/orders/pi_3Abc123Xyz",
        ]
        event.breadcrumbs = [breadcrumb]

        _ = SentryRedactor.redact(event)

        let updated = event.breadcrumbs?.first?.data
        XCTAssertEqual((updated?["headers"] as? [String: String])?["Authorization"], "<redacted>")
        let body = updated?["body"] as? [String: Any]
        XCTAssertEqual(body?["password"] as? String, "<redacted>")
        XCTAssertEqual(body?["email"] as? String, "x@y.com")
        XCTAssertEqual(updated?["url"] as? String, "/orders/pi_<redacted>")
    }

    func test_redact_emptyEvent_doesNotCrash() {
        let event = Event()
        XCTAssertNoThrow(_ = SentryRedactor.redact(event))
    }

    func test_redact_breadcrumbWithoutData_doesNotCrash() {
        let event = Event()
        let crumb = Breadcrumb(level: .info, category: "test")
        // No data dictionary set on this breadcrumb.
        event.breadcrumbs = [crumb]
        XCTAssertNoThrow(_ = SentryRedactor.redact(event))
    }

    func test_redact_multipleBreadcrumbs_eachIsRedacted() {
        let event = Event()
        let crumb1 = Breadcrumb(level: .info, category: "a")
        crumb1.data = ["body": ["password": "one"]]
        let crumb2 = Breadcrumb(level: .info, category: "b")
        crumb2.data = ["body": ["password": "two"]]
        event.breadcrumbs = [crumb1, crumb2]

        _ = SentryRedactor.redact(event)

        for crumb in event.breadcrumbs ?? [] {
            let body = crumb.data?["body"] as? [String: Any]
            XCTAssertEqual(body?["password"] as? String, "<redacted>")
        }
    }
}
