import Foundation
import StripePaymentSheet
import Sentry

/// State machine for the checkout flow.
///
/// **Flow:**
/// 1. `.idle` → user opens CheckoutView.
/// 2. User taps "Place Order". ViewModel locks (`isProcessing = true`),
///    generates a stable idempotency key (one per tap; same key across
///    retries), and calls `POST /api/v1/checkout`.
/// 3. `.ready(checkoutResponse)` → backend returned `clientSecret` +
///    `display` totals. PaymentSheet is constructed and shown.
/// 4. User completes the PaymentSheet (Apple Pay or card). Stripe
///    confirms the PaymentIntent server-side.
/// 5. `.success(orderId)` → backend webhook will flip the order to
///    `PAID` shortly. iOS routes to the receipt / order status screen.
///    Cart is cleared.
/// 6. `.failed(message)` → display the error; user can retry. Retries
///    reuse the **same idempotency key** so the backend dedupes them —
///    Golden Rule #4 protection against double-charge.
///
/// **Critical invariants:**
/// - iOS never marks the order paid (Golden Rule #3). PaymentSheet
///   completion just means "Stripe accepted the confirmation"; the
///   actual `PAID` transition happens on the backend webhook.
/// - The idempotency key is generated **once per tap** of "Place Order"
///   and held in `idempotencyKey` for the duration of the attempt.
///   Tapping again after an error (without cart changes) reuses the
///   same key.
/// - Checkout button locks on first tap (`isProcessing`) — protects
///   against double-tap creating two orders.
@MainActor
final class CheckoutViewModel: ObservableObject {

    enum State: Equatable {
        case idle
        case creatingOrder
        case ready(CheckoutResponse)
        case paying
        case success(orderId: String, display: CheckoutDisplay)
        case failed(message: String)
    }

    @Published private(set) var state: State = .idle
    @Published var tipPercent: Int = 0

    /// `true` while a network request or PaymentSheet is in flight.
    /// Used to lock the "Place Order" button against double-tap.
    @Published private(set) var isProcessing: Bool = false

    /// Stable idempotency key for this checkout attempt. Set the first
    /// time `placeOrder` is invoked; cleared only when the cart contents
    /// change (caller's responsibility) or after a terminal success.
    /// Retries of the same tap reuse this value.
    private var idempotencyKey: String?

    /// `paymentSheet` is constructed once we have a clientSecret. The
    /// view layer reads it to present the sheet. `nil` until `.ready`.
    @Published private(set) var paymentSheet: PaymentSheet?

    private let api: APIClient
    private let cart: CartManager
    private let appState: AppState
    private let locationId: String

    init(
        api: APIClient = .shared,
        cart: CartManager,
        appState: AppState,
        locationId: String
    ) {
        self.api = api
        self.cart = cart
        self.appState = appState
        self.locationId = locationId
    }

    // MARK: - Public API

    /// Initiates the checkout flow. Idempotent on repeat calls within
    /// the same tap — the lock prevents concurrent invocations.
    func placeOrder() async {
        guard !isProcessing else { return }
        guard !cart.isEmpty else {
            state = .failed(message: "Your cart is empty.")
            return
        }
        guard case .loggedIn(let customer) = appState.authState else {
            state = .failed(message: "Please sign in to check out.")
            return
        }

        isProcessing = true
        defer { isProcessing = false }

        state = .creatingOrder

        // Generate idempotency key once per tap. Held in
        // `self.idempotencyKey` so error retries (user taps Place Order
        // again after a network failure) reuse the same key and the
        // backend deduplicates. Only regenerated when the cart contents
        // change between attempts — handled via `resetForRetry()` at
        // the call site if needed.
        let key = idempotencyKey ?? IdempotencyKey.generate(
            userId: customer.id,
            cartItemIds: cart.itemIds,
            timestamp: Int(Date().timeIntervalSince1970)
        )
        idempotencyKey = key

        let request = CheckoutRequest(
            locationId: locationId,
            idempotencyKey: key,
            items: cart.toCheckoutItems(),
            tipPercent: tipPercent,
            pickupType: .asap
        )

        do {
            let response: CheckoutResponse = try await api.post("/checkout", body: request)

            // If the backend returned an empty clientSecret, the
            // idempotency key replayed an already-SUCCEEDED order —
            // the user already paid; route straight to success.
            if response.clientSecret.isEmpty {
                handleAlreadyPaid(response: response)
                return
            }

            // Construct PaymentSheet with the clientSecret. Apple Pay
            // is **opt-in via `AppConfig.applePayEnabled`** because
            // enabling it before the merchant ID is registered + linked
            // to Stripe causes PaymentSheet to fail with a generic
            // "unexpected error" instead of cleanly falling back to
            // card entry. Default off; flip the flag when setup is done.
            var config = PaymentSheet.Configuration()
            config.merchantDisplayName = "Pulse Coffee"
            if AppConfig.applePayEnabled {
                config.applePay = .init(
                    merchantId: "merchant.com.pulsecoffee.app",
                    merchantCountryCode: "US"
                )
            }

            paymentSheet = PaymentSheet(
                paymentIntentClientSecret: response.clientSecret,
                configuration: config
            )

            state = .ready(response)
        } catch let error as APIError {
            state = .failed(message: Self.message(for: error))
            SentrySDK.capture(error: error)
        } catch {
            state = .failed(message: "Couldn't create the order. Please try again.")
            SentrySDK.capture(error: error)
        }
    }

    /// Called by the view after PaymentSheet returns a result.
    /// `PaymentSheetResult` is the SDK type with three cases:
    /// completed, canceled, failed.
    func handlePaymentResult(_ result: PaymentSheetResult, orderId: String, display: CheckoutDisplay) {
        switch result {
        case .completed:
            // PaymentSheet says the customer confirmed payment with
            // Stripe. The PAID transition still happens on the
            // server-side webhook (Golden Rule #3 — iOS never marks
            // an order paid). For MVP-3, we route to the success
            // state; MVP-4 will poll the backend for the real PAID
            // confirmation.
            cart.clear()
            idempotencyKey = nil
            state = .success(orderId: orderId, display: display)

            addBreadcrumb(
                level: .info,
                message: "checkout.payment_completed orderId=\(orderId)"
            )

        case .canceled:
            // User dismissed the PaymentSheet without paying. The
            // backend order sits at PENDING_PAYMENT; the
            // PendingPaymentCleanupTask sweeps it to FAILED after
            // 30 min. Reset to .ready so the user can retry from
            // the same checkout view.
            if case .ready(let response) = state {
                state = .ready(response) // re-present the button
            }
            addBreadcrumb(level: .info, message: "checkout.payment_canceled orderId=\(orderId)")

        case .failed(let error):
            // Stripe SDK's `error.localizedDescription` is its canonical
            // user-facing copy ("There was an unexpected error..."), which
            // is too generic to debug from. Pull more detail out of the
            // NSError bridge so the Sentry event + user-visible message
            // both carry the actual signal.
            let detail = Self.extractPaymentFailureDetail(from: error)

            state = .failed(message: detail.userMessage)

            // Attach Stripe-specific context to the Sentry event so the
            // CTO chat can pivot on `stripe.error_code` when triaging.
            SentrySDK.capture(error: error) { scope in
                scope.setTag(value: detail.errorCode ?? "unknown", key: "stripe.error_code")
                scope.setTag(value: detail.errorDomain, key: "stripe.error_domain")
                scope.setExtra(value: orderId, key: "order_id")
                if let underlying = detail.underlyingDescription {
                    scope.setExtra(value: underlying, key: "stripe.underlying")
                }
            }

            addBreadcrumb(
                level: .error,
                message: "checkout.payment_failed orderId=\(orderId) " +
                         "domain=\(detail.errorDomain) code=\(detail.errorCode ?? "?") " +
                         "msg=\(detail.userMessage)"
            )
        }
    }

    /// Decomposes a `PaymentSheetError`'s underlying NSError so the iOS
    /// UI and Sentry events both carry better context than Stripe's
    /// generic localized description.
    private static func extractPaymentFailureDetail(
        from error: Error
    ) -> PaymentFailureDetail {
        let ns = error as NSError
        let domain = ns.domain
        let codeString = "\(ns.code)"

        // Stripe SDK error domains we care about:
        // - `STPErrorDomain`              — top-level Stripe errors
        // - `com.stripe.lib`              — older Stripe error domain
        // - `PKPassKitErrorDomain`        — Apple Pay configuration errors
        //                                   (e.g. merchant ID not registered)
        // - `NSURLErrorDomain`            — network failures during PaymentSheet
        let isApplePayConfigError = domain.contains("PassKit")
            || domain.contains("PKPaymentError")
            || (ns.userInfo["STPCardErrorCodeKey"] as? String) == "invalid_request_error"
                && (ns.userInfo["NSLocalizedFailureReason"] as? String)?
                    .lowercased().contains("apple pay") == true

        let isNetworkError = domain == NSURLErrorDomain

        let userMessage: String
        if isApplePayConfigError {
            // Most common cause in personal-MVP: merchant ID
            // `merchant.com.pulsecoffee.app` isn't registered in Apple
            // Developer + linked to Stripe yet. Card entry should still
            // work as a fallback inside the same PaymentSheet.
            userMessage = "Apple Pay isn't configured for this device yet. Try paying with a card in the same sheet."
        } else if isNetworkError {
            userMessage = "Couldn't reach the payment server. Check your connection and try again."
        } else {
            // Stripe-side error (declined card, expired PI, etc.). Show
            // the failure-reason if available; otherwise fall back to
            // the SDK's generic localized description.
            let reason = ns.userInfo[NSLocalizedFailureReasonErrorKey] as? String
            userMessage = reason ?? error.localizedDescription
        }

        return PaymentFailureDetail(
            userMessage: userMessage,
            errorDomain: domain,
            errorCode: ns.userInfo["STPErrorCodeKey"] as? String ?? codeString,
            underlyingDescription: (ns.userInfo[NSUnderlyingErrorKey] as? NSError)?.localizedDescription
        )
    }

    private struct PaymentFailureDetail {
        let userMessage: String
        let errorDomain: String
        let errorCode: String?
        let underlyingDescription: String?
    }

    /// Resets the idempotency key — call this when the cart contents
    /// change between checkout attempts (so a different cart gets a
    /// new server-side order, not a replay).
    func resetIdempotencyKey() {
        idempotencyKey = nil
    }

    // MARK: - Internals

    private func handleAlreadyPaid(response: CheckoutResponse) {
        cart.clear()
        idempotencyKey = nil
        state = .success(orderId: response.orderId, display: response.display)
        addBreadcrumb(
            level: .info,
            message: "checkout.replay_already_paid orderId=\(response.orderId)"
        )
    }

    private func addBreadcrumb(level: SentryLevel, message: String) {
        let crumb = Breadcrumb(level: level, category: "checkout")
        crumb.message = message
        SentrySDK.addBreadcrumb(crumb)
    }

    private static func message(for error: APIError) -> String {
        switch error {
        case .invalidURL:
            return "Could not build the checkout URL."
        case .network:
            return "Couldn't reach the backend. Check your connection and try again."
        case .decoding:
            return "Checkout response didn't match the expected format."
        case .serverError(let serverError, let code):
            switch code {
            case 400:
                // Validation error: backend rejected the cart shape
                // or pricing input. Surface the structured message.
                return serverError.message
            case 401:
                // Downstream-service 401 that APIClient correctly
                // identified as non-JWT (otherwise we'd be on the
                // `.authRequired` branch). The backend's response
                // message may leak implementation details (Stripe API
                // key prefixes, internal service names) — don't
                // surface the raw text to the customer.
                return "Checkout is temporarily unavailable. Please try again in a moment."
            case 409:
                // PAYMENT_IN_FLIGHT — the idempotency key matches an
                // in-progress payment from another tap. User shouldn't
                // see this normally (the button-lock prevents it).
                return "A payment is already in progress for this order. Please wait a moment."
            case 500..<600:
                // Internal server errors — backend bug or downstream
                // outage. Generic copy; the operator-facing detail
                // is in Sentry via the breadcrumb trail.
                return "Checkout failed on the server side. Please try again in a moment."
            default:
                return serverError.message
            }
        case .authRequired:
            return "Please sign in again to check out."
        case .rateLimited:
            return "Too many checkout attempts. Please wait a minute and try again."
        case .unexpected(let code):
            return "Checkout failed with status \(code)."
        }
    }
}
