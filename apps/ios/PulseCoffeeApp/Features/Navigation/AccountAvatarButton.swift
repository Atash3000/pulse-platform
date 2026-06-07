import SwiftUI

/// Top-right account entry. Reusable across screens (Home only for now).
/// Signed in → a rounded brand circle with the first-name initial; guest →
/// a person glyph. Tapping opens `AccountView` as a sheet (which itself
/// splits on auth state: guest → WelcomeView, signed-in → profile + sign-out).
struct AccountAvatarButton: View {
    @EnvironmentObject private var appState: AppState
    @State private var showAccount = false

    /// First-name initial when signed in with a non-empty name; `nil` otherwise
    /// (guest, or a blank/whitespace name) → the view shows the person glyph.
    /// Pure + static so it's unit-testable without a view (GR#17 fail-safe:
    /// a blank name never yields an empty circle).
    static func initial(for authState: AppState.AuthState) -> String? {
        guard case .loggedIn(let profile) = authState else { return nil }
        let trimmed = profile.firstName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return nil }
        return String(first).uppercased()
    }

    var body: some View {
        let initial = Self.initial(for: appState.authState)
        return Button { showAccount = true } label: {
            Group {
                if let initial {
                    // Fixed size on purpose: a single initial in a fixed 34/44pt
                    // circle can't host Dynamic-Type growth (it would overflow);
                    // the VoiceOver label carries the readable text. Same trade-off
                    // CategoryTabBar documents.
                    Text(initial)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(AppTheme.Colors.tabBarBackground)
                } else {
                    Image(systemName: "person.crop.circle")
                        .font(.system(size: 18, weight: .regular))
                        .foregroundStyle(AppTheme.Colors.tabLabelInactive)
                }
            }
            .frame(width: 34, height: 34)
            .background(
                Circle().fill(initial != nil
                              ? AppTheme.Colors.tabLabelActive
                              : AppTheme.Colors.tabBarBackground)
            )
            .overlay(Circle().stroke(AppTheme.Colors.divider.opacity(0.14), lineWidth: 1))
            .frame(width: 44, height: 44)          // ≥44pt tap target (WCAG 2.5.5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint("Opens your account")
        .sheet(isPresented: $showAccount) {
            AccountView()
        }
    }

    private var accessibilityLabel: String {
        if case .loggedIn(let profile) = appState.authState,
           !profile.firstName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Account, signed in as \(profile.firstName)"
        }
        return "Account, sign in"
    }
}
