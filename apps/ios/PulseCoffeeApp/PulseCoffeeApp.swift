import SwiftUI
import Sentry
import PostHog

@main
struct PulseCoffeeApp: App {
    init() {
        // Golden Rule #9: Sentry MUST be the first call in App.init() —
        // before any other code can throw, log, or crash. We need errors
        // captured before we know we need them.
        SentrySDK.start { options in
            options.dsn = AppConfig.sentryDSN

            // One Sentry iOS project; debug-vs-production split via the
            // environment tag (filterable in the Sentry UI). The two-DSN
            // alternative would be operational overhead for a single
            // developer — see decision-log entry for the analysis.
            options.environment = AppConfig.environment

            // Composed release identifier so Sentry's release tracking
            // matches the Info.plist version pair the app actually ships.
            options.releaseName = Self.releaseName

            // tracesSampleRate is PERFORMANCE-MONITORING sampling, NOT
            // error sampling. Errors are always captured at 100% regardless
            // of this value. Setting this to 1.0 makes every transaction
            // (HTTP request, view lifecycle, etc.) a billable event.
            //
            // Phase 1 keeps it at 1.0 because catching unknown-unknowns at
            // launch is the high-value pass. CTO set an 80%-of-quota alert
            // in Sentry as the backstop — we tune down reactively if we
            // approach the free-tier ceiling. Phase 2 default tune-down
            // target is 0.2–0.5 once we know which transactions matter.
            options.tracesSampleRate = 1.0

            // Populated in commit #3: `SentryRedactor.redact` scrubs
            // sensitive values from outbound events before delivery.
            // - `Authorization` headers on the event request + on each
            //   breadcrumb's request snapshot.
            // - `password`, `client_secret`, `idempotency_key`, `cvv`,
            //   `cvc`, `card_number` field values in any breadcrumb's
            //   request body.
            // - Stripe object IDs (`pi_*`, `ch_*`, `re_*`) in breadcrumb
            //   URLs (defense-in-depth — not credentials, but they
            //   shouldn't appear in error tracking either).
            //
            // See `Core/SentryRedactor.swift` for the redaction rules
            // and `PulseCoffeeAppTests/SentryRedactorTests.swift` for
            // the test coverage.
            options.beforeSend = { event in
                SentryRedactor.redact(event)
            }

            // Auto-instrument URLSession: every iOS network call becomes a
            // breadcrumb on the next captured event without per-call code.
            // (`enableNetworkBreadcrumbs` is true by default — listing
            // explicitly for self-documenting code.)
            options.enableNetworkBreadcrumbs = true
        }

        // PostHog init AFTER Sentry (Sentry catches PostHog init failures).
        // Single PostHog project covers iOS + backend (when DevOps wires
        // backend later, tagged source: "api"). Shared properties below
        // tag every event with `source: "ios"` so the two streams stay
        // distinguishable when the funnel correlation matters.
        //
        // PostHog 3.x renamed the `apiKey:` parameter to `projectToken:`
        // for clarity (the value has always been the public Project API
        // Key, now sometimes called "Project Token" in PostHog's docs).
        // Our `AppConfig.postHogAPIKey` constant name is unchanged —
        // same value.
        let postHogConfig = PostHogConfig(projectToken: AppConfig.postHogAPIKey)
        PostHogSDK.shared.setup(postHogConfig)
        PostHogSDK.shared.register([
            "source": "ios",
            "environment": AppConfig.environment,
        ])

        // Optional smoke test for Sentry delivery. Enable by setting the
        // SMOKE_TEST=1 environment variable in the Xcode scheme:
        //   Product → Scheme → Edit Scheme → Run → Arguments →
        //     Environment Variables → SMOKE_TEST = 1
        //
        // Fires a single test event so the developer can confirm events
        // reach the Sentry dashboard. No-op in Release builds and when the
        // env var is unset, so no risk of production noise.
        #if DEBUG
        if ProcessInfo.processInfo.environment["SMOKE_TEST"] == "1" {
            SentrySDK.capture(message: "ios.smoke-test: commit #2 wiring verified")
        }
        Self.bootstrapPersonalDevToken()
        #endif
    }

    #if DEBUG
    /// One-shot bootstrap that copies the `DEV_ACCESS_TOKEN` and
    /// `DEV_REFRESH_TOKEN` environment variables into the Keychain
    /// **if and only if** the Keychain is currently empty.
    ///
    /// Workflow for personal-MVP testing (no login UI, single-developer
    /// scenario — see `apps/ios/README.md` "Personal MVP testing" section
    /// for the curl recipe that produces these tokens):
    ///
    /// 1. Manager creates a customer account via `POST /api/v1/auth/register`
    ///    on the backend; saves `access_token` + `refresh_token` from the
    ///    response.
    /// 2. In Xcode: Product → Scheme → Edit Scheme → Run → Arguments →
    ///    Environment Variables. Add `DEV_ACCESS_TOKEN` and (optionally)
    ///    `DEV_REFRESH_TOKEN`.
    /// 3. Build + run once with Xcode attached — the tokens land in
    ///    Keychain on app launch.
    /// 4. After step 3, the env vars are no longer consulted (Keychain
    ///    wins). Sideload-to-phone builds work because Keychain persists.
    ///
    /// To force a re-bootstrap (rotated token, wrong account), the
    /// dev clears Keychain first — easiest via uninstall+reinstall, or
    /// via a future logout flow.
    ///
    /// Stripped from Release builds via `#if DEBUG` — production never
    /// reads environment variables for credentials.
    private static func bootstrapPersonalDevToken() {
        // Bail out if Keychain already has a token (steady-state path).
        if let existing = try? Keychain.loadAccessToken(), !existing.isEmpty {
            return
        }

        let env = ProcessInfo.processInfo.environment
        guard let access = env["DEV_ACCESS_TOKEN"], !access.isEmpty else {
            return
        }

        try? Keychain.saveAccessToken(access)
        if let refresh = env["DEV_REFRESH_TOKEN"], !refresh.isEmpty {
            try? Keychain.saveRefreshToken(refresh)
        }
    }
    #endif

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }

    /// Composes `pulse-coffee-ios@<MARKETING_VERSION>+<CURRENT_PROJECT_VERSION>`
    /// from Info.plist values that XcodeGen generates from project.yml.
    /// Matches Sentry's recommended release-tracking convention.
    private static var releaseName: String {
        let bundle = Bundle.main
        let short = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        return "pulse-coffee-ios@\(short)+\(build)"
    }
}
