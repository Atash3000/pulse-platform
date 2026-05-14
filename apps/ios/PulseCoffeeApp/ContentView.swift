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
/// Visible only in Debug builds. Surfaces the API base URL so the developer
/// knows whether the app is pointing at localhost, a tunnel, or a staging
/// host — prevents the "why isn't this working" debug session when the
/// configuration drifts unnoticed.
private struct DebugAPIBanner: View {
    private static let apiBaseURL = "http://localhost:3000/api/v1"

    var body: some View {
        VStack(spacing: 4) {
            Text("DEBUG")
                .font(.caption2.weight(.bold))
            Text(Self.apiBaseURL)
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
