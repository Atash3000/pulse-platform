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

            // Empty redactor today; populated in commit #3 (APIClient) with
            // JWT-and-secret redaction logic — strips the
            // `Authorization: Bearer <token>` header from every breadcrumb
            // before it leaves the device, plus any `password` fields in
            // POST request bodies. Cheaper to install the hook structurally
            // now than retrofit it after the first token leaks to Sentry.
            options.beforeSend = { event in
                // TODO(commit #3): redact Authorization header from
                // request breadcrumbs, redact password/token fields from
                // POST body breadcrumbs. Today this is a no-op pass-through.
                return event
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
        let postHogConfig = PostHogConfig(apiKey: AppConfig.postHogAPIKey)
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
        #endif
    }

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
