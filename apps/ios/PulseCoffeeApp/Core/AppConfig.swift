import Foundation

/// Compile-time configuration for the PulseCoffeeApp.
///
/// Every value here is derived from the active build configuration
/// (Debug or Release) via `#if DEBUG` — there are no runtime-mutable
/// fields. To change a value, edit this file or the build configuration,
/// then rebuild.
///
/// Why an enum, not a struct or a `.xcconfig` file:
/// - Enum with `static` members produces a namespace that cannot be
///   instantiated — closes off accidental misuse.
/// - For a single-app project with one Debug + one Release config, the
///   `#if DEBUG` switch is sufficient and self-documenting. `.xcconfig`
///   files shine for complex multi-target setups we do not have.
///
/// See decision-log entry "[iOS] Sentry + PostHog + AppConfig wiring"
/// for the full rationale.
enum AppConfig {

    // MARK: - Public client-side credentials
    //
    // Sentry DSNs and PostHog Project API keys are PUBLIC credentials by
    // design. They identify the project to the SDK but do not grant
    // write access to the data they hold:
    //
    //   - Sentry distinguishes between the DSN (public, embeddable in
    //     clients) and auth tokens (server-side, must never commit).
    //     See https://docs.sentry.io/concepts/key-terms/dsn-explainer/
    //
    //   - PostHog distinguishes between the Project API Key (public,
    //     embeddable in clients) and the Personal API Key (server-side,
    //     must never commit). See https://posthog.com/docs/api#api-keys
    //
    // Committing these is standard practice. We never put secret-tier
    // credentials (Stripe sk_live, JWT secrets, etc.) in this file —
    // those live in the backend `.env` and AWS Parameter Store.

    static let sentryDSN = "https://e24ba9b58bb37f857c163e680914a1a8@o4511388799074304.ingest.us.sentry.io/4511388832104448"

    static let postHogAPIKey = "phc_ru627crGzUTPMbwBeE85V5pLYqRN2eavsy2KMyikmq9W"

    // MARK: - API base URL
    //
    // Debug builds talk to the local backend running on the developer's
    // Mac (`docker compose up` in the monorepo root + `npm run start:dev`
    // in `apps/api/`). Release builds will talk to the production host
    // — the actual hostname is a DevOps phase decision; the value below
    // is a placeholder until then.
    //
    // `DEBUG_API_BASE_URL` environment override (Debug only): when set
    // in the Xcode scheme's Run → Environment Variables, replaces the
    // default localhost URL. Use case: sideloading to a real iPhone via
    // Xcode with an ngrok / Cloudflare tunnel pointed at the Mac backend
    // (real device can't reach `http://localhost:3000`). No code change
    // needed; just set the env var to the tunnel URL.
    //
    // ATS exception in `Info.plist` covers `localhost` only — tunnel URLs
    // must be HTTPS (which ngrok / Cloudflare provide by default).

    static let apiBaseURL: URL = {
        #if DEBUG
        if let override = ProcessInfo.processInfo.environment["DEBUG_API_BASE_URL"],
           !override.isEmpty,
           let url = URL(string: override) {
            return url
        }
        return URL(string: "http://localhost:3000/api/v1")!
        #else
        return URL(string: "https://api.pulsecoffee.com/api/v1")!
        #endif
    }()

    // MARK: - Build environment
    //
    // Used as Sentry's `options.environment` tag (events filterable by
    // environment in the Sentry UI) and as a PostHog shared property
    // (`environment: "debug" | "production"`). Single source of truth
    // for "which build is this?" across the observability stack.

    static var environment: String {
        #if DEBUG
        return "debug"
        #else
        return "production"
        #endif
    }

    static var isDebug: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }

    // MARK: - Apple Pay
    //
    // Whether to configure `PaymentSheet.Configuration.applePay` with our
    // merchant ID at checkout. Defaults to **false** because enabling
    // Apple Pay in iOS while it ISN'T actually set up on the Stripe side
    // produces PaymentSheet failures with no graceful fallback — Stripe
    // SDK 23.x's behavior is "unexpected error" instead of "show card
    // entry instead." See decision-log entry "[iOS] Apple Pay feature
    // flag — gate on full setup completion".
    //
    // To enable Apple Pay, ALL THREE of these must be done first:
    //   1. `merchant.com.pulsecoffee.app` registered in Apple Developer
    //      (Identifiers → Merchant IDs).
    //   2. Merchant ID added to Stripe (Stripe dashboard → Settings →
    //      Payment methods → Apple Pay → Add merchant ID).
    //   3. Apple Pay Payment Processing Certificate generated via Stripe
    //      and uploaded to Apple (Stripe dashboard walks through it).
    //
    // After all three: flip this constant to `true`. No other code
    // changes needed — the entitlement is already in place and
    // CheckoutViewModel reads this flag at PaymentSheet construction.
    static let applePayEnabled = false
}
