# Pulse Coffee — iOS App

SwiftUI customer app for Pulse Coffee. Browse menu, build cart, pay with Apple Pay, pick up.

iOS 16+. Stripe iOS SDK for payments. APNs push for "your order is ready." Sentry + PostHog for observability.

## Quick start

```bash
# One-time setup
make install        # brew install xcodegen
make project        # generate PulseCoffeeApp.xcodeproj from project.yml

# Day-to-day
open PulseCoffeeApp.xcodeproj
make build          # CLI build for Simulator
make test           # XCTest suite for Simulator
```

The `.xcodeproj` is **gitignored** — `project.yml` is the source of truth. After pulling, run `make project` once and you're set. Rationale: see decision-log entry "[iOS] XcodeGen for project file management".

## Layout

```
apps/ios/
├── project.yml                          XcodeGen source of truth
├── Makefile                             make project / build / test
├── PulseCoffeeApp/
│   ├── PulseCoffeeApp.swift            @main entry point
│   ├── ContentView.swift                placeholder screen (Phase 1 scaffold)
│   ├── PulseCoffeeApp.entitlements     push capability
│   ├── Assets.xcassets/                 AppIcon + AccentColor (placeholders)
│   └── Preview Content/                 SwiftUI preview-only assets
└── PulseCoffeeAppTests/                 XCTest bundle
```

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

## Build sequence

This commit lands the scaffold only. Following commits:

| # | Scope |
|---|---|
| 2 | SPM dependencies (Stripe, Sentry, PostHog) + Sentry init on first line of `App.init()` |
| 3 | APIClient, Keychain (JWT), Codable models, ATS exception for localhost |
| 4 | Auth (register, login, refresh) |
| 5 | Menu (browse, item detail, disk cache) |
| 6 | Cart (in-memory, no server) |
| 7 | Checkout (Stripe PaymentSheet + Apple Pay + idempotency) |
| 8 | Orders (10s polling, history) — terminal states `[PICKED_UP, CANCELLED, FAILED, REFUNDED]` per ios.md |
| 9 | Push notifications (APNs token registration, deep-link to order detail) |
| 10 | Loyalty + Profile + logout (loyalty endpoint pending backend) |
| 11 | PostHog + TestFlight prep |

Pre-push discipline: each commit pauses before push for CTO review.

## Testing without xcodegen installed

If a reviewer doesn't want to install XcodeGen locally, they can read `project.yml` to understand the project structure — every source file, build setting, and capability is declared there. To actually build, XcodeGen is required.
