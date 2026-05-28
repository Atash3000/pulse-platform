# TODO — Backend store-status field (replace hardcoded iOS calc)

- **Created:** 2026-05-28
- **Status:** OPEN — iOS ships a hardcoded calculation today; backend hand-off planned.
- **Driver:** The v4 Menu topbar shows a status dot (open / closing-soon / closed) next to the location name. See `docs/superpowers/specs/2026-05-27-pulse-menu-v4-design.md` §10 for the user-facing contract.

## What ships today (interim)

`apps/ios/PulseCoffeeApp/Features/Menu/StoreStatus.swift` defines:

```swift
enum StoreStatus { case open, closingSoon, closed }
func currentStoreStatus(now: Date = Date(), calendar: Calendar = .current) -> StoreStatus
```

The function reads local wall-clock time and compares against **hardcoded** hours (7:00–18:00 every day) with a 60-minute "closing soon" window before close. It carries a `TODO(2026-Q3)` pointing at this file.

**Why this is wrong:**

1. **Hours are per-location and per-day-of-week.** The backend already models this — `LocationHours` entity (`apps/api/src/database/entities.ts:141`) with rows per `(location_id, day_of_week, open_time, close_time, is_closed)`. The dev seed (`apps/api/scripts/seed-dev-data.ts:27`) sets Mon-Fri 07:00–18:00, Sat 08:00–16:00, Sun closed. iOS ignores all of this today.
2. **Timezone is per-location.** `Location.timezone` (e.g. `America/New_York`) — a single Park Slope store happens to match the customer's local time, but multi-location or traveling-customer scenarios break the assumption.
3. **Holidays / one-off closures** aren't modeled anywhere yet, but when they land the hours computation belongs server-side, not duplicated on every client.
4. **Mobile-ordering pause** (`LocationSettings.mobile_ordering_paused`) is *operationally* a closed state from the customer's perspective. iOS doesn't know about this flag today.

## Proposed backend contract

Extend `PublicLocation` (returned by `GET /api/v1/locations`) with a computed status object:

```typescript
export interface PublicLocationStatus {
  // 'open' | 'closing_soon' | 'closed' — fail-safe defaults to 'open' on
  // a missing / unknown raw value, mirroring how iOS decodes Temperature.
  state: 'open' | 'closing_soon' | 'closed';
  // ISO timestamp of the next state change ("opens at 7am", "closes at
  // 6pm"). Lets iOS render a precise tooltip if the founder asks for it
  // later (e.g. "Closes in 23 min").
  next_change_at: string;
  // The reason for `state` when not just hours-driven, so iOS can show
  // copy like "Closed for the holiday" or "Mobile ordering paused".
  // Null when the state is purely from regular hours.
  reason: string | null;
}

// On the existing PublicLocation:
export interface PublicLocation {
  // ... existing fields ...
  status: PublicLocationStatus;
}
```

Computation lives in a new `LocationStatusService` that:

1. Loads the location's `LocationHours` rows + timezone.
2. Computes "now in store-local time" via `DateTime.now({ zone: location.timezone })`.
3. Returns `closed` if `LocationSettings.mobile_ordering_paused` is true (reason: `"Mobile ordering paused"`), or if today's row is `is_closed`, or if the current local time is outside `[open_time, close_time)`.
4. Returns `closing_soon` if the current local time is within 60 minutes of `close_time`. (Window length should be a `LocationSettings.closing_soon_window_minutes` field with default 60 — keeps each store tunable.)
5. Otherwise returns `open`.

**Caching:** the status changes on a clock boundary; either compute on every read (cheap), or cache the full `PublicLocation` payload with a short TTL (1 min) so transitions show within a minute. The current menu cache TTL is 10 min and includes the location; either reduce the TTL on this specific field, or move location-status out of the menu payload entirely.

## iOS hand-off

When the backend ships:

1. Add `status: LocationStatus` to `LocationSummary` in `apps/ios/PulseCoffeeApp/Models/Location.swift` with fail-safe decoding (`.open` default for unknown / missing).
2. In `MenuView.topbar`, replace `currentStoreStatus()` with `viewModel.state.location?.status.toUI() ?? .open`.
3. **Delete** `apps/ios/PulseCoffeeApp/Features/Menu/StoreStatus.swift` entirely. Keep `StoreStatusDot.swift` (it's the view, not the calc).
4. Drop the TODO comment in `MenuView.swift`'s topbar.

Optional polish (separate ticket): poll the location status every 5 min so the dot transitions live while the customer browses the menu without re-launching.

## Acceptance criteria

- `GET /api/v1/locations` returns `status` on every location.
- A Jest spec pins the three state transitions (open → closing_soon at `close - 60min`; closing_soon → closed at `close`; closed → open at next day's `open_time`) and respects `is_closed` days + `mobile_ordering_paused`.
- iOS decodes the new field and the simulator dot color matches the live store state without restarting the app.
- `StoreStatus.swift` is deleted from the iOS source tree.

## Not in scope here

- Per-location push notifications when a closed store reopens.
- Customer "remind me when open" subscription.
- Backend admin UI to edit hours (already exists in the staff dashboard scope per the bigger spec).
