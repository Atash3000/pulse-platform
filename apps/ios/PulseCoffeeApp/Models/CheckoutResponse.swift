import Foundation

/// `POST /api/v1/checkout` response.
///
/// Maps to backend: `apps/api/src/modules/checkout/checkout.service.ts`
/// (`CheckoutResponse` interface).
///
/// The `display` strings are **pre-formatted by the backend** (e.g.
/// "$6.50"). iOS shows them verbatim — Golden Rule #8 forbids any
/// client-side money math. `totalCents` is the integer-cents source of
/// truth used by Stripe (the `client_secret` is bound to this amount).
struct CheckoutResponse: Decodable, Equatable {
    let orderId: String
    /// Stripe PaymentIntent client secret. Pass to
    /// `PaymentSheet(paymentIntentClientSecret:)` to drive the
    /// payment sheet. Backend returns an empty string when the
    /// idempotency key replays a SUCCEEDED order — in that case
    /// the order is already paid and iOS should route to the
    /// status / receipt screen instead of presenting the sheet.
    let clientSecret: String
    let totalCents: Int
    let display: CheckoutDisplay

    enum CodingKeys: String, CodingKey {
        case orderId
        case clientSecret
        case totalCents
        case display
    }
}

/// Pre-formatted display strings for the order summary. The backend
/// formats these with the location's currency / locale rules so iOS
/// can render them as-is without any pricing logic.
///
/// All fields are strings ("$6.50") — not integers. The "$0.00"
/// placeholders for unused entries (e.g. no discount applied) come
/// straight from the backend.
struct CheckoutDisplay: Decodable, Equatable {
    let subtotal: String
    let modifier: String
    let discount: String
    let tax: String
    let tip: String
    let total: String
}
