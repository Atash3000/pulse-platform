import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack(spacing: 16) {
            Text("Pulse Coffee")
                .font(.largeTitle.weight(.bold))

            Text("Phase 1 scaffold")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            #if DEBUG
            DebugAPIBanner()
                .padding(.top, 32)
            #endif
        }
        .padding()
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
