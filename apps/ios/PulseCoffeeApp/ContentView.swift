import SwiftUI

struct ContentView: View {
    @State private var tokenStatus: TokenStatus = .checking

    var body: some View {
        VStack(spacing: 20) {
            Text("Pulse Coffee")
                .font(.largeTitle.weight(.bold))

            Text("Personal MVP test build")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            tokenStatusBadge

            #if DEBUG
            DebugAPIBanner()
                .padding(.top, 24)
            #endif
        }
        .padding()
        .onAppear(perform: refreshTokenStatus)
    }

    @ViewBuilder
    private var tokenStatusBadge: some View {
        switch tokenStatus {
        case .checking:
            ProgressView()
                .padding(.top, 16)
        case .loaded:
            Label("Personal token loaded", systemImage: "checkmark.shield.fill")
                .foregroundStyle(.green)
                .padding(.top, 16)
        case .notLoaded:
            VStack(spacing: 8) {
                Label("No personal token", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                Text("Set DEV_ACCESS_TOKEN in the Xcode scheme env vars and re-run.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
            }
            .padding(.top, 16)
        }
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
/// `AppConfig` so configuration drift is visible at a glance — prevents
/// the "why isn't this working" debug session when the developer expects
/// localhost but the build is pointing somewhere else.
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
