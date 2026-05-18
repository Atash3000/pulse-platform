# Pulse Coffee — iOS App

SwiftUI customer app for Pulse Coffee. Browse menu, build cart, pay with Apple Pay, pick up.

iOS 16+. Stripe iOS SDK for payments. APNs push for "your order is ready." Sentry + PostHog for observability.

## Quick start

```bash
# One-time setup
make install        # brew install xcodegen
make project        # generate PulseCoffeeApp.xcodeproj from project.yml
make resolve        # resolve SPM packages, write Package.resolved lockfile

# Day-to-day
open PulseCoffeeApp.xcodeproj
make build          # CLI build for Simulator
make test           # XCTest suite for Simulator
```

The `.xcodeproj` is **gitignored** (except for the SPM `Package.resolved` lockfile inside it — see decision-log "[iOS] Sentry + PostHog + AppConfig wiring"). `project.yml` is the source of truth for the project structure; `Package.resolved` is the source of truth for the dependency versions. After pulling, `make project && make resolve` puts both in place.

## Layout

```
apps/ios/
├── project.yml                          XcodeGen source of truth (incl. SPM deps)
├── Makefile                             make project / resolve / build / test
├── PulseCoffeeApp/
│   ├── PulseCoffeeApp.swift            @main entry point — Sentry + PostHog init
│   ├── ContentView.swift                placeholder screen — reads AppConfig
│   ├── PulseCoffeeApp.entitlements     push capability
│   ├── Core/
│   │   └── AppConfig.swift              compile-time config (DSN, key, baseURL, env)
│   ├── Assets.xcassets/                 AppIcon + AccentColor (placeholders)
│   └── Preview Content/                 SwiftUI preview-only assets
└── PulseCoffeeAppTests/                 XCTest bundle
```

SPM dependencies declared in `project.yml`:

| Package | Product | First used in |
|---|---|---|
| `stripe-ios` | `StripePaymentSheet` | commit #7 (checkout) |
| `sentry-cocoa` | `Sentry` | commit #2 (this commit — init in `App.init()`) |
| `posthog-ios` | `PostHog` | commit #2 (this commit — init after Sentry) |

## Configuration

| Build config | API base URL |
|---|---|
| Debug | `http://localhost:3000/api/v1` |
| Release | `https://api.pulsecoffee.com/api/v1` (placeholder — DevOps lands the real host) |

The Debug build shows a yellow banner with the active API base URL so configuration drift is visible at a glance. Wired in `ContentView.swift`.

ATS exception for `http://localhost` lands with the `APIClient` in commit #3.

## Read before contributing

1. The product spec — [`PulsCoffee_Final_Spec.pdf`](../../PulsCoffee_Final_Spec.pdf) Part 6 (pages 22–23).
2. iOS chat onboarding — [`docs/ai-onboarding/ios.md`](../../docs/ai-onboarding/ios.md). The ten iOS rules there override anything that contradicts them in the brief.
3. 15 golden rules — [`docs/golden-rules.md`](../../docs/golden-rules.md). Rules 1–4, 7–9 are iOS-relevant.
4. Decision log — [`docs/decision-log.md`](../../docs/decision-log.md). Search for `[iOS]` prefix.

## Running the app

1. Bring up the backend (`docker compose up -d`, then in `apps/api/`: `npm run start:dev`).
2. Open `PulseCoffeeApp.xcodeproj` and run on Simulator or a sideloaded device.
3. The app opens to a **Sign In** screen. First-time users tap **Create an account** to register; existing users sign in with email + password.
4. After successful login/register the app persists tokens + customer profile in Keychain and routes to **Menu**.
5. Sign out via the gear icon in the Menu screen toolbar.

The bundled `seed:dev` script creates one location but no menu items. To order a real coffee you'll need to seed at least one item (and its inventory row) — see `apps/api/README.md` for the seed scripts or insert manually via `psql`.

## Build sequence

| Commit | Scope | Status |
|---|---|---|
| 1 | Xcode project + XcodeGen | ✅ Landed |
| 2 | SPM deps (Stripe, Sentry, PostHog) + AppConfig + Sentry/PostHog init | ✅ Landed |
| 3 | APIClient, Keychain, Codable models, ATS exception | ✅ Landed |
| Housekeeping | Package.resolved, PostHog rename, make clean-derived | ✅ Landed |
| MVP-2 | Menu screen (location + menu fetch, sectioned list) | ✅ Landed |
| Commit A | Auth feature — AppState, TokenRefresher, Login/Register UI, 401 retry | (this commit) |
| MVP-3 | Cart + Apple Pay checkout + idempotency | (planned) |
| MVP-4 | Order status polling + receipt screen | (planned) |
| MVP-5 | Apple Pay merchant ID entitlement + TestFlight prep | (planned) |

Scope deferred to Phase 2 (post-personal-MVP):

- Forgot password (needs backend SMTP)
- Email verification (needs backend SMTP)
- Sign in with Apple (not required while we offer only email login)
- Order history list
- Push notifications (APNs delivery to customers)
- Loyalty UI
- Scheduled pickup
- Modifier selection on items (MVP orders use default options)
- Profile tab (gear → Sign Out in MenuView toolbar covers the only Phase-1 user action)

Pre-push discipline: each commit pauses before push for CTO review.

## Testing without xcodegen installed

If a reviewer doesn't want to install XcodeGen locally, they can read `project.yml` to understand the project structure — every source file, build setting, and capability is declared there. To actually build, XcodeGen is required.
