import Foundation

/// Store open / closing-soon / closed status. Drives the v4 topbar
/// status dot color (green / yellow / red).
///
/// HARDCODED IMPLEMENTATION — see the TODO at `currentStoreStatus(now:)`
/// and `docs/superpowers/todos/2026-05-28-store-status-backend.md` for
/// the planned backend hand-off.
enum StoreStatus: Equatable {
    case open
    case closingSoon  // within `closingSoonWindow` of close time
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

/// How long before the close time the store enters "closing soon".
/// 60 minutes per the founder's spec ("closes at 6pm, opens menu at
/// 17:01 ⇒ yellow").
private let closingSoonWindow: TimeInterval = 60 * 60

/// Hardcoded weekly schedule (7 days a week, 7:00–18:00 local). When
/// the backend lands per the TODO file, this constant becomes a
/// per-location hours map fetched alongside the menu.
private struct HardcodedHours {
    let openMinutes: Int   // minutes after midnight
    let closeMinutes: Int
}
private let hardcodedHours = HardcodedHours(openMinutes: 7 * 60, closeMinutes: 18 * 60)

/// Computes the current store status from local wall-clock time.
///
/// Pure function — accepts `now` as a parameter so the test suite can
/// pin every branch without faking the system clock.
///
/// TODO(2026-Q3): replace with a backend-provided status field on the
/// public location payload. See
/// `docs/superpowers/todos/2026-05-28-store-status-backend.md` for the
/// planned `PublicLocation.status` shape, the hours-aware service-side
/// computation, and how this client function should be deleted (or
/// reduced to a 5-minute polling fallback) once the API ships.
func currentStoreStatus(now: Date = Date(), calendar: Calendar = .current) -> StoreStatus {
    let components = calendar.dateComponents([.hour, .minute], from: now)
    guard let hour = components.hour, let minute = components.minute else {
        // Defensive: a missing component is fail-safe-open so the menu
        // never wrongly tells a customer the store is closed.
        return .open
    }
    let nowMinutes = hour * 60 + minute

    if nowMinutes < hardcodedHours.openMinutes || nowMinutes >= hardcodedHours.closeMinutes {
        return .closed
    }
    let warningStart = hardcodedHours.closeMinutes - Int(closingSoonWindow / 60)
    if nowMinutes >= warningStart {
        return .closingSoon
    }
    return .open
}
