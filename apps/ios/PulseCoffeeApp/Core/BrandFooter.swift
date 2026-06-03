import SwiftUI

/// Reusable Pulse brand wordmark for the quiet space at the foot of a
/// scroll (e.g. below the last menu section). Decorative — hidden from
/// VoiceOver so it adds no navigation noise.
///
/// Reusable like a React component: drop `BrandFooter()` anywhere, or pass
/// a custom `tagline` (or `nil` to hide it). The wordmark uses the app's
/// serif treatment in a muted brand tone so it reads as a signature, not a
/// heading.
struct BrandFooter: View {
    /// Small uppercase line under the wordmark. `nil` hides it.
    var tagline: String? = "MATCHA · COFFEE · KITCHEN"

    var body: some View {
        VStack(spacing: 10) {
            Text("Pulse")
                .font(.system(size: 40, weight: .regular, design: .serif))
                .italic()
                .foregroundStyle(AppTheme.Colors.tabLabelActive.opacity(0.8))

            if let tagline {
                Text(tagline)
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(2)
                    .foregroundStyle(AppTheme.Colors.tabLabelInactive)
            }
        }
        .frame(maxWidth: .infinity)
        .accessibilityHidden(true)
    }
}

#Preview {
    BrandFooter()
        .padding(.vertical, 40)
        .background(AppTheme.Colors.tabBarBackground)
}
