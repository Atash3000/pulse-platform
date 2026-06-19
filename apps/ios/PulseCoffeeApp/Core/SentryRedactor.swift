import Foundation
import Sentry

/// Sanitises Sentry events before they leave the device.
///
/// Called from the `beforeSend` hook in `PulseCoffeeApp.swift`. Pure
/// function (idempotent): re-redacting an already-redacted event is a
/// no-op. Implemented as a separate type so its behaviour can be
/// unit-tested without spinning up the full Sentry SDK.
///
/// What gets redacted:
///
/// | Location | Replacement |
/// |---|---|
/// | `event.request.headers["Authorization"]` | `<redacted>` |
/// | `breadcrumb.data["headers"]["Authorization"]` (each breadcrumb) | `<redacted>` |
/// | `breadcrumb.data["body"][<sensitive key>]` | `<redacted>` |
/// | `client_secret=<value>` query params in `breadcrumb.data["url"]` | `client_secret=<redacted>` |
/// | Stripe object IDs (`pi_*`, `seti_*`, `ch_*`, `re_*`, `pm_*`) in `breadcrumb.data["url"]` | `<prefix>_<redacted>` |
///
/// Sensitive body keys (cf. decision-log entry "[iOS] APIClient + Keychain
/// + Codables + ATS for localhost"):
///
/// - `password` — login / register bodies.
/// - `client_secret` — Stripe PaymentIntent client secret. Grants payment
///   authorization to whoever holds it; the most sensitive value the iOS
///   client touches.
/// - `refresh_token` / `access_token` — auth credentials. `TokenRefresher`
///   sends `refresh_token` in the `/auth/refresh` body, and auth
///   responses carry both; either appearing in a breadcrumb body would
///   leak a live session.
/// - `idempotency_key` — payment-dedup key. Leaking it doesn't enable
///   theft but exposes our dedup strategy; cheap to redact.
/// - `cvv` / `cvc` / `card_number` — PCI-tier card data. The Stripe SDK
///   tokenises cards on-device and never routes raw data through our
///   APIClient, so these *should* never appear here. The redactor is
///   defense-in-depth against a future code path accidentally landing
///   raw card data in a request body.
enum SentryRedactor {

    static let redactedPlaceholder = "<redacted>"

    /// Body field names whose values get replaced with `<redacted>` when
    /// they appear in `breadcrumb.data["body"]`.
    static let sensitiveBodyFields: Set<String> = [
        "password",
        "client_secret",
        "refresh_token",
        "access_token",
        "idempotency_key",
        "cvv",
        "cvc",
        "card_number",
    ]

    /// Header names whose values get replaced with `<redacted>`. Stored
    /// lowercase; matching is case-insensitive (HTTP allows arbitrary
    /// casing).
    static let sensitiveHeaders: Set<String> = [
        "authorization",
    ]

    /// Matches Stripe object IDs in arbitrary strings: payment intents
    /// (`pi_*`), setup intents (`seti_*`), charges (`ch_*`), refunds
    /// (`re_*`), payment methods (`pm_*`). The character class includes
    /// `_` because real Stripe tokens contain underscores — notably
    /// `pi_xxx_secret_yyy` client secrets, which the old
    /// `[A-Za-z0-9]+`-only pattern truncated at the first underscore,
    /// leaving the `_secret_…` tail intact in network breadcrumbs. The
    /// leading `\b` keeps `re_`/`pi_` from matching inside ordinary
    /// words (`feature_flag`). Replacement template preserves the
    /// prefix so the breadcrumb still indicates *what kind* of object
    /// was referenced.
    private static let stripeIDPattern: NSRegularExpression = {
        // swiftlint:disable:next force_try
        try! NSRegularExpression(pattern: #"\b(pi|seti|ch|re|pm)_[A-Za-z0-9_]+"#, options: [])
    }()

    /// Matches `client_secret=<value>` query params in URL strings. The
    /// Sentry SDK's network breadcrumbs swizzle the Stripe SDK's own
    /// URLSession calls, which carry `?client_secret=pi_…_secret_…` —
    /// the value must be stripped wholesale, not just the Stripe-ID part.
    private static let clientSecretParamPattern: NSRegularExpression = {
        // swiftlint:disable:next force_try
        try! NSRegularExpression(pattern: #"client_secret=[^&\s]+"#, options: [])
    }()

    /// Returns the event with sensitive fields redacted. Always returns
    /// the same event (never `nil`) — we never drop events, only sanitise
    /// them.
    static func redact(_ event: Event) -> Event {
        redactRequestHeaders(on: event)
        redactBreadcrumbs(on: event)
        return event
    }

    // MARK: - Helpers exposed for unit tests

    /// Returns the input string with any Stripe object IDs replaced.
    /// Visible to tests; used internally by `redactURLString`.
    static func redactStripeIDs(in text: String) -> String {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return stripeIDPattern.stringByReplacingMatches(
            in: text,
            options: [],
            range: range,
            withTemplate: "$1_\(redactedPlaceholder)"
        )
    }

    /// Returns the input string with any `client_secret=<value>` query
    /// param values replaced. Visible to tests; used internally by
    /// `redactURLString`.
    static func redactClientSecretParams(in text: String) -> String {
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return clientSecretParamPattern.stringByReplacingMatches(
            in: text,
            options: [],
            range: range,
            withTemplate: "client_secret=\(redactedPlaceholder)"
        )
    }

    /// Full URL-string scrub: strips `client_secret` query params, then
    /// any remaining Stripe object IDs. Visible to tests; applied to
    /// every breadcrumb's `data["url"]`.
    static func redactURLString(_ url: String) -> String {
        redactStripeIDs(in: redactClientSecretParams(in: url))
    }

    /// Returns a copy of `body` with sensitive field values replaced by
    /// the placeholder. Visible to tests.
    static func redactBody(_ body: [String: Any]) -> [String: Any] {
        var copy = body
        for key in sensitiveBodyFields where copy[key] != nil {
            copy[key] = redactedPlaceholder
        }
        return copy
    }

    /// Returns a copy of `headers` with sensitive header values replaced.
    /// Visible to tests. Header lookup is case-insensitive.
    static func redactHeaders(_ headers: [String: String]) -> [String: String] {
        var copy = headers
        for (key, _) in headers {
            if sensitiveHeaders.contains(key.lowercased()) {
                copy[key] = redactedPlaceholder
            }
        }
        return copy
    }

    // MARK: - Private mutation helpers

    private static func redactRequestHeaders(on event: Event) {
        guard let request = event.request, let headers = request.headers else {
            return
        }
        request.headers = redactHeaders(headers)
    }

    private static func redactBreadcrumbs(on event: Event) {
        guard let breadcrumbs = event.breadcrumbs else { return }
        for breadcrumb in breadcrumbs {
            redactBreadcrumb(breadcrumb)
        }
    }

    private static func redactBreadcrumb(_ breadcrumb: Breadcrumb) {
        guard var data = breadcrumb.data else { return }

        if let headers = data["headers"] as? [String: String] {
            data["headers"] = redactHeaders(headers)
        }

        if let body = data["body"] as? [String: Any] {
            data["body"] = redactBody(body)
        }

        if let url = data["url"] as? String {
            data["url"] = redactURLString(url)
        }

        breadcrumb.data = data
    }
}
