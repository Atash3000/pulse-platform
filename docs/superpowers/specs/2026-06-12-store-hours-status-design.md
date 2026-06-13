# Backend-Driven Store Hours & Status — Design

**Date:** 2026-06-12
**Status:** Approved design — ready for implementation planning
**Surface:** `apps/api` (NestJS) + `apps/ios` (SwiftUI)
**Audience:** the `/superpowers:writing-plans` planner and the implementing engineer.

> This is **sub-project A** of a two-part "locations & hours" effort. Sub-project B (nearest-location via device GPS — lat/lng on `Location`, CoreLocation permission, fallback) is a **separate** spec → plan → build cycle and is explicitly out of scope here.

---

## 1. Goal & the real gap

The store open/closed badge on the iOS Menu screen is computed from **hard-coded** hours in `apps/ios/PulseCoffeeApp/Features/Menu/StoreStatus.swift` (7:00–18:00, 7 days a week) using `Calendar.current` — the **device's** clock, not the shop's timezone. That is wrong twice over: the hours are fake, and a customer in a different timezone than the shop sees the wrong state.

Meanwhile the backend **already** stores real per-location hours (`LocationHours`: `day_of_week`, `open_time`, `close_time`, `is_closed`), already exposes them on `GET /locations/:id` (`PublicLocationDetail.hours[]`), and already has timezone-aware open/closed logic in `apps/api/src/modules/locations/hours.service.ts` (`isTimeWithinInTz`, `nextOpenAt`, `formatTimeInTz`). Two things are missing: (1) the app doesn't consume any of it, and (2) there's **no way for staff to edit hours** (admin can pause ordering and set wait-time, but not change hours).

This work makes the badge server-authoritative (computed in the shop's timezone, flipping automatically as hours change or the clock crosses a boundary) and adds a staff-authed hours-edit endpoint. It also corrects the seed location name to **"Pulse Coffee — Park Slope."**

The data model is already multi-location; nothing here hard-codes a single shop. The displayed name comes from the DB (`location.name`), so "Park Slope" is a seed value, not code.

## 2. Scope

### In scope
- A backend function that computes store **status** (`open` | `closing_soon` | `closed`) in the location's timezone, plus the **next transition instant** and today's open/close times.
- Exposing `status`, `next_transition_at`, `today_open`, `today_close` on the public location payload (`PublicLocationSummary` and `PublicLocationDetail`).
- A staff-authed **`PUT /admin/hours`** endpoint to replace a location's weekly hours.
- iOS: consume the server status, **delete** the hard-coded hours, flip the badge live at `next_transition_at`.
- Seed: rename the location to "Pulse Coffee — Park Slope" with a real address and a full 7-day hours set.

### Out of scope (deferred / separate)
- **Nearest-location / device GPS** (sub-project B): `Location` lat/lng, CoreLocation permission, GPS-denied fallback. Not touched here.
- **Dashboard UI.** No `apps/dashboard` exists; the admin surface in this effort is the API endpoint only. A future web/Telegram UI calls it.
- **"Ordering paused" in the badge.** `mobile_ordering_paused` (on `LocationSettings`) is a separate existing concern; the badge reflects **hours**, not the pause flag. Status is hours-derived only.

## 3. What already exists (reuse, don't rebuild)

| Asset | Location | Role |
|---|---|---|
| `LocationHours` entity | `apps/api/src/database/entities.ts` (`location_hours`) | Per-day rows: `day_of_week` (0–6), `open_time`, `close_time` (`time`), `is_closed`. Already seeded + returned by `GET /locations/:id`. |
| `hours.service.ts` tz helpers | `apps/api/src/modules/locations/hours.service.ts` | `isTimeWithinInTz`, `nextOpenAt`, `formatTimeInTz` — timezone- and DST-aware. The status function reuses these; do **not** write new tz math. |
| `LocationsService` | `apps/api/src/modules/locations/locations.service.ts` | `listActive()` → `PublicLocationSummary[]`, `getById()` → `PublicLocationDetail`. The new fields are added to both. |
| Admin pattern | `apps/api/src/modules/admin/admin-ordering.controller.ts` + `staff-context.ts` | Staff-scoped-to-own-location + role guard. `PUT /admin/hours` mirrors this exactly (no `:locationId` in path — the caller's location). |
| `StoreStatus` enum + `StoreStatusDot` | `apps/ios/PulseCoffeeApp/Features/Menu/StoreStatus.swift`, `StoreStatusDot.swift` | The enum (`open`/`closingSoon`/`closed`) + colored-dot view stay. The hard-coded `hardcodedHours` + `currentStoreStatus(now:)` are **deleted**. |
| `LocationSummary` | `apps/ios/PulseCoffeeApp/Models/Location.swift` | Gains `status`, `nextTransitionAt`, `todayOpen`, `todayClose` (all fail-safe decode). |

## 4. Backend — status computation

A pure function, `computeStoreStatus(hours, timezone, now)`, living alongside the existing tz helpers (extend `hours.service.ts` or a sibling `store-status.ts` in the same module):

```
status ∈ { open, closing_soon, closed }
next_transition_at: ISO instant the status next changes
today_open / today_close: today's scheduled hours (see rule below)
```

`today_open`/`today_close` are **today's scheduled open/close times** ("HH:mm" in the shop tz) whenever today is an operating day (`is_closed = false`), **independent of the current status** — so a closed-before-open store can still surface "Opens 7:00 AM." Both are `null` when today `is_closed` or the location has no hours.

Rules (all evaluated in the location's `timezone`):
- **closed** when today `is_closed`, or `now` is before today's `open_time` or at/after `close_time`.
- **closing_soon** when open and `now` is within **60 minutes** of `close_time`.
- **open** otherwise.
- **`next_transition_at`** = the nearest upcoming boundary from `now`: `close_time − 60m` (open→closing_soon), `close_time` (closing_soon→closed), or the next day's `open_time` (closed→open, via `nextOpenAt`). Crosses midnight and DST correctly because the tz helpers do.
- **No hours rows for the location → `status: null`**, `next_transition_at: null`. iOS hides the badge (fail-safe; never assert "open" on undefined data, Golden Rule #17).

This is a pure function of `(hours, timezone, now)` — `now` is a parameter so tests pin every branch without faking the clock.

## 5. Backend — expose on the location payload

Add to both `PublicLocationSummary` and `PublicLocationDetail`:

```jsonc
{
  // ...existing fields...
  "status": "open" | "closing_soon" | "closed" | null,
  "next_transition_at": "2026-06-12T22:00:00Z" | null,
  "today_open": "07:00" | null,
  "today_close": "18:00" | null
}
```

`listActive()` already batch-loads each location's data; it must also batch-load **hours for all returned locations** (one `location_hours` query keyed by `location_id IN (...)`, grouped in memory — **no N+1**) and call `computeStoreStatus` per row. `getById()` already loads `hours` — compute from those.

## 6. Backend — admin hours edit

**`PUT /admin/hours`** — staff JWT, scoped to the caller's own location via `staff-context` (same as `admin-ordering`). **OWNER / MANAGER only.**

Request body — the full weekly schedule (replace-all, idempotent):
```jsonc
{
  "hours": [
    { "day_of_week": 0, "open_time": "08:00", "close_time": "17:00", "is_closed": false },
    // ... exactly 7 entries, day_of_week 0–6 ...
  ]
}
```

Validation (`class-validator`): exactly 7 entries covering 0–6 (no dupes/gaps); `open_time`/`close_time` match `^\d{2}:\d{2}$` and are valid times; `open_time < close_time` when `is_closed` is false. On success, replace the location's `location_hours` rows in a **transaction** (delete-then-insert, or upsert per day). Returns the updated weekly schedule.

No cache to invalidate (the locations endpoint isn't cached). iOS reflects the change on its next `/locations` fetch.

## 7. iOS — consume server status

- **`LocationSummary`** decodes `status` (enum `open`/`closingSoon`/`closed`; unknown/missing → `nil` → badge hidden), `nextTransitionAt` (`Date?`, ISO-8601), `todayOpen`/`todayClose` (`String?`). All fail-safe (the model already uses this pattern for `currentWaitMinutes`).
- **`StoreStatus.swift`:** delete `hardcodedHours`, `closingSoonWindow`, and `currentStoreStatus(now:)`. Keep the `StoreStatus` enum and `StoreStatusDot`. The status now comes from `LocationSummary.status` (map the wire enum → `StoreStatus`).
- **Live flip:** a small driver (e.g. a `@MainActor` object or a `.task` keyed on `nextTransitionAt`) sleeps until `nextTransitionAt`, then triggers a refetch of `/locations` to pull the fresh `status` + the new `nextTransitionAt`, and reschedules. Combined with the existing launch/foreground fetch. No tight polling; one timer per visible badge, self-cancelling. If `nextTransitionAt` is nil, no timer.
- Optional: `StoreStatusDot` (or its label) can show "Open until {todayClose}" / "Opens {nextOpen}" using `todayOpen/Close` — display only.

## 8. Error handling

- **Status compute:** missing hours → `null` status → hidden badge (no false "open").
- **Admin edit:** invalid body → 400 with field-level errors (ValidationPipe); non-OWNER/MANAGER → 403; missing location context → the staff-context guard's existing failure.
- **iOS:** unknown/missing status enum → hidden badge; bad `nextTransitionAt` → no timer (status still shown from the last fetch).

## 9. Testing

- **Backend `computeStoreStatus`:** mid-day open; within the 60-min closing window; before open; at/after close; `is_closed` day; `next_transition_at` correctness for each boundary including across-midnight and a DST transition; missing-hours → null. Pure-function tests with injected `now` + fixed `timezone`.
- **Backend payload:** `listActive` batch-loads hours with no N+1 and sets the four fields; `getById` likewise.
- **Backend admin edit:** replace succeeds + returns the schedule; validation rejects (missing day, dup day, `open >= close`, bad time format); role guard rejects BARISTA; scoping uses the caller's location; idempotent re-PUT.
- **iOS:** `LocationSummary` decodes the four fields fail-safe (and when absent); wire-status → `StoreStatus` mapping incl. unknown → hidden; the live-flip driver fires a refresh at an injected `nextTransitionAt` and reschedules.

## 10. Build order (for the planner)

1. Backend `computeStoreStatus` pure function + tests.
2. Wire the four fields into `PublicLocationSummary`/`PublicLocationDetail` (batch hours load, no N+1) + tests.
3. `PUT /admin/hours` (DTO + service + controller, role-scoped) + tests.
4. Seed: rename to "Pulse Coffee — Park Slope" + full 7-day hours.
5. iOS `LocationSummary` decode of the four fields + tests.
6. iOS: delete hard-coded `StoreStatus` hours; feed the dot from `LocationSummary.status`; live-flip driver + tests.
