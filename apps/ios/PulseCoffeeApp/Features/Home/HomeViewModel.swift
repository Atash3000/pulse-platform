import Foundation
import Sentry

/// Drives the Home tab's reorder sections. Home is a NON-critical surface
/// (Golden Rule #17): a guest, an empty history, or a failed fetch all resolve
/// to a usable screen — never an error wall. The View layer reads `content`
/// and renders the featured fallback whenever there is no `usual`.
@MainActor
final class HomeViewModel: ObservableObject {

    enum Content: Equatable {
        case loading
        /// Signed-in customer; `summary.usual` may be nil (no paid history yet).
        case signedIn(HomeSummary)
        /// Guest, or any fetch failure → featured + pairings layout.
        case fallback
    }

    @Published private(set) var content: Content = .loading

    private let fetch: () async throws -> HomeSummary

    /// Production uses the shared `HomeService`; tests inject a closure.
    /// `fetch` defaults to `nil` (rather than a closure literal) so the
    /// default-argument expression never references the `HomeService` actor
    /// from this `@MainActor` context — the actor hop happens at call time.
    init(fetch: (() async throws -> HomeSummary)? = nil) {
        self.fetch = fetch ?? { try await HomeService.shared.fetchSummary() }
    }

    func load(isSignedIn: Bool) async {
        content = .loading
        guard isSignedIn else { content = .fallback; return }
        do {
            content = .signedIn(try await fetch())
        } catch APIError.cancelled, is CancellationError {
            // Tab switch / view teardown cancelled the fetch — that's
            // navigation, not a failure: no Sentry capture, and stay in
            // `.loading` (which the view renders as the fail-safe
            // featured fallback) so the next `load` retries cleanly.
        } catch {
            SentrySDK.capture(error: error)
            content = .fallback
        }
    }
}
