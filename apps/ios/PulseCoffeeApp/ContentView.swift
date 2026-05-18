import SwiftUI

/// Root view router for personal-MVP testing.
///
/// - If a personal access token is in Keychain (set up via the
///   `DEV_ACCESS_TOKEN` env-var bootstrap in `App.init()`), routes to
///   `MenuView`.
/// - Otherwise shows a "setup needed" screen explaining how to wire the
///   env vars. This is the only branch that exists in personal-MVP —
///   when login UI lands (Phase 2), this view replaces the orange-warning
///   branch with `LoginView`.
struct ContentView: View {
    @State private var tokenStatus: TokenStatus = .checking

    var body: some View {
        Group {
            switch tokenStatus {
            case .checking:
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)

            case .loaded:
                MenuView()

            case .notLoaded:
                setupNeeded
            }
        }
        .onAppear(perform: refreshTokenStatus)
    }

    private var setupNeeded: some View {
        VStack(spacing: 20) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.largeTitle)
                .foregroundStyle(.orange)

            Text("Personal MVP setup needed")
                .font(.title2.weight(.semibold))

            VStack(alignment: .leading, spacing: 8) {
                Text("1. Create a customer account on the backend (see `apps/ios/README.md`).")
                Text("2. Add the `DEV_ACCESS_TOKEN` and `DEV_REFRESH_TOKEN` env vars to the Xcode scheme.")
                Text("3. Re-run the app once with Xcode attached.")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.horizontal)

            #if DEBUG
            DebugAPIBanner()
                .padding(.top, 24)
            #endif
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func refreshTokenStatus() {
        do {
            if let token = try Keychain.loadAccessToken(), !token.isEmpty {
                tokenStatus = .loaded
            } else {
                tokenStatus = .notLoaded
            }
        } catch {
            tokenStatus = .notLoaded
        }
    }

    private enum TokenStatus {
        case checking
        case loaded
        case notLoaded
    }
}

#if DEBUG
/// Visible only in Debug builds. Reads the active API base URL from
/// `AppConfig` so configuration drift is visible at a glance.
private struct DebugAPIBanner: View {
    var body: some View {
        VStack(spacing: 4) {
            Text("DEBUG")
                .font(.caption2.weight(.bold))
            Text(AppConfig.apiBaseURL.absoluteString)
                .font(.caption.monospaced())
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.yellow.opacity(0.25), in: RoundedRectangle(cornerRadius: 8))
    }
}
#endif

#Preview {
    ContentView()
}
