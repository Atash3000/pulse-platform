import Foundation

/// Pure helper for the store-status live flip. The badge state is valid until
/// `nextTransitionAt`; at that instant the view refetches the location to get
/// the fresh status. This computes how long to wait. Extracted so the timing
/// logic is unit-tested without a running view.
enum StoreStatusRefreshClock {
    /// Seconds to wait before refreshing. nil when there's no transition to
    /// schedule. A past instant returns 0 (refresh now).
    static func secondsUntilNextTransition(_ nextTransitionAt: Date?, now: Date = Date()) -> TimeInterval? {
        guard let next = nextTransitionAt else { return nil }
        return max(0, next.timeIntervalSince(now))
    }
}
