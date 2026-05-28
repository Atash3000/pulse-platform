import SwiftUI

/// The 10pt status dot that sits to the left of the location name in
/// the v4 Menu topbar. Color encodes `StoreStatus`:
///
/// - `.open`         — green (`#4CAF50`)
/// - `.closingSoon`  — amber (`#F5A623`)
/// - `.closed`       — `AppTheme.Colors.destructive` (matches the
///                     cart-count badge red, kept consistent app-wide)
///
/// HTML reference: `.logo-dot { width:10px; background:var(--accent-warm);
/// animation: gentle-pulse 2.2s ease-in-out infinite; }` — the design
/// uses one warm color with a pulse. We extend it to three colors so
/// the dot carries operational state, not just brand atmosphere.
///
/// The gentle-pulse animation is reproduced via SwiftUI's `.opacity` /
/// `.scaleEffect` on a `Timer`-free `withAnimation(.easeInOut.repeatForever)`.
struct StoreStatusDot: View {
    let status: StoreStatus

    @State private var pulse = false

    private var color: Color {
        switch status {
        case .open:        return Color(red: 76 / 255, green: 175 / 255, blue: 80 / 255)
        case .closingSoon: return Color(red: 245 / 255, green: 166 / 255, blue: 35 / 255)
        case .closed:      return AppTheme.Colors.destructive
        }
    }

    private var accessibilityLabel: String {
        switch status {
        case .open:        return "Store open"
        case .closingSoon: return "Store closing soon"
        case .closed:      return "Store closed"
        }
    }

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 10, height: 10)
            .opacity(pulse ? 0.5 : 1)
            .scaleEffect(pulse ? 0.85 : 1)
            .onAppear {
                withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) {
                    pulse = true
                }
            }
            .accessibilityLabel(accessibilityLabel)
    }
}

#Preview("Status dot variants") {
    VStack(spacing: 24) {
        HStack(spacing: 12) {
            StoreStatusDot(status: .open)
            Text("Open")
        }
        HStack(spacing: 12) {
            StoreStatusDot(status: .closingSoon)
            Text("Closing soon")
        }
        HStack(spacing: 12) {
            StoreStatusDot(status: .closed)
            Text("Closed")
        }
    }
    .padding(40)
}
