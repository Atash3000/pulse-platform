import Foundation
import StripePaymentSheet
import Sentry

/// State machine for the checkout flow.
///
/// **Flow:**
/// 1. `.idle` → user opens CheckoutView.
/// 2. User taps "Place Order". ViewModel locks (`isProcessing = true`),
///    asks `CartManager` for the cart's stable idempotency key, and
///    calls `POST /api/v1/checkout`.
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
/// - The idempotency key is owned by `CartManager`, NOT this view
///   model. This VM is a fresh `@StateObject` per navigation, so a
///   key held here would not survive "Back to Cart" → re-enter — and a
///   payment that confirmed with Stripe just before a network blip
///   would be charged a second time under a fresh key. CartManager
///   caches one key per cart contents and invalidates it on any cart
///   mutation; see `CartManager.idempotencyKey(for:)`.
/// - Checkout button locks on first tap (`isProcessing`) — protects
///   against double-tap creating two orders.
@MainActor
final class CheckoutViewModel: ObservableObject {

    enum State: Equatable {
        case idle
        case creatingOrder
        case ready(CheckoutResponse)
        case success(orderId: String, display: CheckoutDisplay)
        case failed(message: String)
    }

    @Published private(set) var state: State = .idle
    @Published var tipPercent: Int = 0

    /// `true` while a network request or PaymentSheet is in flight.
    /// Used to lock the "Place Order" button against double-tap.
    @Published private(set) var isProcessing: Bool = false

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
        // Defense-in-depth: an empty locationId means the menu (and its
        // location) never loaded — e.g. items added from Home's
        // "Pair with" row, then checkout entered via the Menu tab's cart
        // icon before /menu resolved. The backend would 400 with raw
        // validator text; fail friendly here without a network call.
        // (The UI also guards this path — CartView disables its checkout
        // CTA while the location is unknown.)
        guard !locationId.isEmpty else {
            state = .failed(message: "We couldn't determine your pickup location. Please reopen the menu and try again.")
            return
        }

        isProcessing = true
        defer { isProcessing = false }

        state = .creatingOrder

        // The idempotency key comes from CartManager, which caches one
        // key per cart contents — so error retries (including retries
        // from a brand-new CheckoutViewModel after the user backed out
        // and re-entered) reuse the same key and the backend
        // deduplicates. Any cart mutation invalidates the cached key.
        let key = cart.idempotencyKey(for: customer.id)

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
        } catch APIError.cancelled {
            // The hosting view was torn down mid-request (user navigated
            // away). Not a defect — no Sentry capture. If the user comes
            // back, the unchanged cart re-derives the same idempotency
            // key, so the attempt replays safely (Golden Rule #4).
            state = .failed(message: Self.message(for: .cancelled))
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
            // confirmation. `cart.clear()` also drops the cached
            // idempotency key — the next cart is a new payment intent.
            cart.clear()
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

    // MARK: - Internals

    private func handleAlreadyPaid(response: CheckoutResponse) {
        cart.clear()
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
        case .cancelled:
            return "Checkout was interrupted. Please try again."
        case .unexpected(let code):
            return "Checkout failed with status \(code)."
        }
    }
}
