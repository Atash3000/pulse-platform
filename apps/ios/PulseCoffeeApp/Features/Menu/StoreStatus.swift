/// Store open / closing-soon / closed status. Drives the v4 topbar
/// status dot color (green / yellow / red).
///
/// The status is computed server-side and delivered on the `/locations`
/// payload (`status` + `next_transition_at`). The client decodes it into
/// `LocationSummary.storeStatus` and renders the dot; the live flip is
/// scheduled by `StoreStatusRefreshClock`.
enum StoreStatus: Equatable {
    case open
    case closingSoon
    case closed
}

extension StoreStatus {
    /// Maps the backend wire string to the badge enum. Unknown / nil → nil
    /// (badge hidden, Golden Rule #17 — never assert "open" on bad data).
    init?(wire: String?) {
        switch wire {
        case "open": self = .open
        case "closing_soon": self = .closingSoon
        case "closed": self = .closed
        default: return nil
        }
    }
}
