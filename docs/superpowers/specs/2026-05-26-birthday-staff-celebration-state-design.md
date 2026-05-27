# Birthday Feature — Staff-Facing Celebration State (Phase 1, backend-only)

**Date:** 2026-05-26
**Status:** Approved design — ready for implementation planning
**Source brief:** "Birthday Feature — Addendum: Barista / Staff-Facing Side" (companion to the not-yet-built `BIRTHDAY_FEATURE_v2.md`)
**Surface:** `apps/api` (NestJS backend)
**Audience for this doc:** the `/superpowers:writing-plans` planner and the implementing engineer.

---

## 1. Context & the dependency reality

The brief is written as an **addendum to `BIRTHDAY_FEATURE_v2.md`** and repeatedly says "no new plumbing — reuse v2's generic `rewards` table (§2.2), date-math (§5), issuance job (§6), redemption flow (§7)." **None of that exists in this repo.** There is no `rewards` table, no birthday date-math, no issuance worker, no generic redemption flow, and no `BIRTHDAY_FEATURE_v2.md` file.

What **does** exist and anchors this work:

| Asset | Location | Relevance |
|---|---|---|
| `Customer.date_of_birth` (`date`, nullable) | `apps/api/src/database/entities.ts` (~line 218) | The birthday field. Repo name is `date_of_birth`, **not** `birthday`. Decision-log (2026-05-26 "Registration profile fields") records it as *"stored but unused… write-only until a screen needs it."* **This endpoint is its first reader.** |
| `Location.timezone` (`text`, default `America/New_York`) | `entities.ts` (~line 124) | Store-timezone source for "today" math. |
| Staff auth stack | `modules/auth/roles.guard.ts`, `roles.decorator.ts`, `jwt-payload.ts`; `modules/admin/staff-context.ts` | JWT `type:'staff'` + `role` (OWNER/MANAGER/BARISTA) + `location_id`; `RolesGuard`, `@Roles(...)`, `requireStaff(req)` with multi-tenant location scoping. Exactly what the brief's §2 auth requirement needs. |
| Admin staff surface pattern | `modules/admin/admin-orders.controller.ts` | `@Controller('admin')` + `@UseGuards(AuthGuard('jwt'), RolesGuard)` + `@Throttle({30/min})` + Swagger decorators + `requireStaff(req)`. The template to follow. |
| `offers` table | `entities.ts` (~line 942): `customer_id, type, value_cents, description, sent_at, opened_at, redeemed_at, expires_at, ...` | Phase-1 source for `active_rewards`. **Note: defined but never written to by any code today — so this array is empty in practice until issuance exists.** |
| `feature_flags` table + seed | `entities.ts`; `database/seeds/feature-flags.seed.ts` | Where the new gate flag is registered. |
| `date-fns` `^4.1.0` + `date-fns-tz` `^3.2.0` | `apps/api/package.json` | Idiomatic tz math. See `modules/locations/hours-tz.ts` for the established pattern (`formatInTimeZone`, `toZonedTime`, `addDays`). **Use these — not luxon, not native `Date`.** |
| `class-transformer` `^0.5.1` | `apps/api/package.json` | Available for DTO shaping / `@Exclude`. |

**Decisions taken during brainstorming (locked):**
1. **Minimal self-contained slice** — compute state directly from `Customer.date_of_birth`; map `active_rewards` from the existing `offers` table. **No** new `rewards` table, **no** issuance worker, **no** redemption-flow rewrite.
2. **Backend endpoint only** — no badge UI (there is no POS/dashboard client; `apps/dashboard/` does not exist). Badge/redemption are specced as a future contract, not built.
3. **All three states** ship in Phase 1 (`BIRTHDAY_TODAY`, `BIRTHDAY_THIS_WEEK`, `NONE`). `SHOW_DAYS_UNTIL_BIRTHDAY` config exists, **defaults off**.
4. **Feature-flagged** behind `birthday_celebration_state`.
5. **Golden Rule #16** proposed (Section 9) — codifying the staff-PII privacy line.

---

## 2. The privacy rule (governs everything)

> **A barista NEVER sees the customer's date of birth or age. Ever.**

The server computes a **derived state** and returns only that. The raw `date_of_birth` value never appears in any staff-facing payload, not even nulled-out — the field is structurally absent from the staff DTO. This is the hard line the whole design is built to guarantee, and it is enforced by an automated test (Section 7).

---

## 3. The endpoint

```
GET /api/v1/admin/customers/:customerId/celebration-state
```

- **Prefix:** reuses the established `admin` staff surface (global prefix `api/v1` + `@Controller('admin')`). The brief's `/api/staff/...` path is mapped to `/api/v1/admin/...` deliberately — `RolesGuard`/`requireStaff` are already wired to this prefix; inventing `/staff` would duplicate auth logic for no functional gain.
- **Guards:** `@UseGuards(AuthGuard('jwt'), RolesGuard)`, `@Roles(StaffRole.BARISTA, StaffRole.MANAGER, StaffRole.OWNER)`.
- **Throttle:** `@Throttle({ default: { limit: 30, ttl: 60_000 } })` — matches the admin convention.
- **Param:** `:customerId` validated with `ParseUUIDPipe`.
- **Swagger:** `@ApiTags`, `@ApiBearerAuth('jwt')`, `@ApiOperation`, `@ApiParam`, `@ApiResponse`.
- **Read-only.** Issues nothing, claims nothing, mutates nothing.

### 200 response (the staff DTO)

```jsonc
{
  "state": "BIRTHDAY_TODAY",        // "BIRTHDAY_TODAY" | "BIRTHDAY_THIS_WEEK" | "NONE"
  "label": "Birthday today 🎂",      // server-built, pre-localized, safe to display as-is
  "active_rewards": [               // live rewards mapped from `offers`; empty in Phase 1 practice
    {
      "reward_id": "uuid",
      "type": "birthday_drink",
      "title": "Birthday drink — on us",
      "requires_purchase": true,
      "expires_at": "2026-05-30T23:59:59Z"
    }
  ]
}
```

### Authorization & enumeration behavior

| Caller / target | Result | Why |
|---|---|---|
| Non-staff (customer) token | **403** | `RolesGuard` rejects a non-staff token from a staff route. This is **role enforcement**, distinct from the resource-privacy 404 rule below. |
| Staff token, **unknown** `customerId` | **200** with `state:"NONE"`, `active_rewards:[]` | A non-existent customer simply has no celebration. Returning `NONE` rather than 404 prevents **customer-UUID enumeration/probing** via this endpoint. |
| Staff token, known customer, no birthday set | **200** with `state:"NONE"`, `active_rewards:[]` | Default state. |
| Malformed `customerId` (not a UUID) | **400** | `ParseUUIDPipe`. (A malformed ID is a client bug, not an enumeration vector — distinct from the unknown-but-valid-UUID case above.) |

**Reconciliation with the decision-log (lines ~302–321):** the project deliberately returns **404, not 403**, when an actor accesses *another actor's resource of the same type* (e.g. customer A peeking at customer B's order), to avoid leaking existence. That rule is **not** in tension here: (a) the 403 in this spec is `RolesGuard` refusing a wrong-*type* token from a staff route, and (b) for unknown customers we return `NONE`, which leaks nothing. No same-type cross-resource case arises — any staff member may legitimately query any customer (anyone can walk into the store), so there is no per-customer ownership check to fail.

---

## 4. Module structure (new `celebration` module)

A dedicated `CelebrationModule` under `apps/api/src/modules/celebration/`. Rationale: `admin` is already a near-"God module" (5 controllers, 5 services); isolating `date_of_birth` access into a small, single-purpose module creates a tight **audit boundary** — it is trivially verifiable that the only staff reader of birthday data lives here and emits only the derived DTO.

```
apps/api/src/modules/celebration/
  celebration.module.ts
  celebration.controller.ts          # the route, guards, throttle, swagger
  celebration.service.ts             # orchestration: load customer + location, compute state, map rewards, check flag
  celebration-date.ts                # PURE date-math helper (no DB, no Nest) — the unit-test core
  celebration-date.spec.ts
  celebration.service.spec.ts
  celebration.controller.spec.ts     # incl. the privacy key-absence assertion + 403 + enumeration
  dto/
    celebration-state.dto.ts         # CelebrationStateDto + ActiveRewardDto (staff-safe shapes)
```

`CelebrationModule` imports the TypeORM repositories for `Customer`, `Location`, `Offer`, `FeatureFlag`, and is registered in `AppModule`.

---

## 5. State computation

### 5.1 Pure date helper (`celebration-date.ts`)

Signature (illustrative):

```ts
type CelebrationState = 'BIRTHDAY_TODAY' | 'BIRTHDAY_THIS_WEEK' | 'NONE';

function computeCelebrationState(
  dateOfBirth: string | null,   // 'YYYY-MM-DD' from Postgres `date`, or null
  now: Date,                    // injected for determinism in tests
  timezone: string,             // Location.timezone, e.g. 'America/New_York'
  thisWeekDays = 7,             // N for BIRTHDAY_THIS_WEEK window
): CelebrationState
```

Rules:
- `dateOfBirth == null` → `NONE`.
- Convert `now` into the store timezone (`toZonedTime` / `formatInTimeZone` from `date-fns-tz`) to derive **today's** month/day in that zone.
- Compare **month + day only** (year is irrelevant — and never surfaced).
- Month/day == today → `BIRTHDAY_TODAY`.
- Birthday's month/day falls within the **next `thisWeekDays` days, exclusive of today** (i.e. days +1…+7 in store tz) → `BIRTHDAY_THIS_WEEK`. Must wrap correctly across year/month boundaries (e.g. today Dec 30, birthday Jan 2).
- Otherwise → `NONE`.
- **Feb 29 birthday in a non-leap year → resolves on Feb 28** (consistent with the brief and the to-be-built v2 §5). Document this explicitly in code.

Pure, deterministic, DB-free — `now` is injected. This file is where the bulk of the unit tests land.

### 5.2 Label

Server-built, pre-localized, safe to render verbatim. Suggested copy (final wording is a one-line product call, keep restrained):
- `BIRTHDAY_TODAY` → `"Birthday today 🎂"`
- `BIRTHDAY_THIS_WEEK` → `"Birthday coming up"` — **vague: no date, no day count.**
- `NONE` → `""` (empty; client renders nothing).

**`SHOW_DAYS_UNTIL_BIRTHDAY`** config (env or a constant), **default `false`**. When false (always, by default), the `THIS_WEEK` label stays vague. The flag is a seam for a future "in 3 days" variant — it does **not** change the DTO shape and is **not** part of the day-one user-visible behavior.

---

## 6. `active_rewards` mapping

- Source: the `offers` table, scoped to `customer_id`.
- **Live** = `redeemed_at IS NULL AND sent_at IS NOT NULL AND (expires_at IS NULL OR expires_at > now)`.
- Map each live offer → `ActiveRewardDto`:
  - `reward_id` ← `offer.id`
  - `type` ← `offer.type`
  - `title` ← `offer.description` (fallback to a per-type default title if null)
  - `requires_purchase` ← derived per type (`birthday_drink` → `true`; default `true` — a reward is attached to a purchase, never a standalone giveaway)
  - `expires_at` ← `offer.expires_at`
- `active_rewards` is **independent of `state`**: a customer can be `BIRTHDAY_TODAY` with an empty array (reward already claimed → warm gesture still shown, nothing to apply), which is exactly the brief's edge case.
- **Reality check for the planner:** no code creates `offers` today, so this array is **empty in practice** for Phase 1. We are shipping the mapping logic, the DTO shape, and the privacy guarantee — issuance (and the badge/redemption that consume a non-empty array) are deferred. This is by design, not a gap to fix in this PR.

---

## 7. The privacy DTO & its enforcement

`CelebrationStateDto` (in `dto/celebration-state.dto.ts`):
- Contains **only** `state`, `label`, `active_rewards` (typed as `ActiveRewardDto[]`).
- Properties are `readonly`.
- The DTO is constructed explicitly from computed values — the `Customer` entity is **never** spread/serialized into the response. If `class-transformer` is in the serialization path, use `@Exclude()` at the class level + `@Expose()` on the three allowed fields as belt-and-suspenders so no entity field can leak through.
- Forbidden keys that must **never** appear under any state (snake_case + camelCase variants, defense against a future field being spread in under a different convention): `birthday`, `date_of_birth`, `dateOfBirth`, `birth_date`, `birthDate`, `age`, `year`, `birth_year`, `birthYear`, `dob`.

**Build-failing privacy test (mandatory, per brief §6):** a test serializes the endpoint's JSON response under each state (`TODAY`, `THIS_WEEK`, `NONE`) and asserts the response object — recursively — contains none of the forbidden keys. This runs in CI and fails the build on violation.

---

## 8. Feature flag

- New flag `birthday_celebration_state` added to `database/seeds/feature-flags.seed.ts` (`enabled: false` by default, with a description). Follows the existing `FlagDef` shape.
- `CelebrationService` reads the flag (via the `FeatureFlag` repository, `findOne({ where: { key } })`, checking `.enabled`) before computing.
- **Flag off → safe default:** return `state:"NONE"`, `active_rewards:[]`, `label:""`. **Not** a 404 and **not** an error — a flag flip must never break a client that's polling the endpoint. (Golden Rule #12: feature-flag anything risky; Golden Rule #15: boring and reliable.)

---

## 8a. Degraded mode / resilience (Golden Rule #17)

This endpoint is a **non-critical read surface** and is structurally **off the order/checkout/payment path** (it's a standalone staff GET, not invoked by checkout — GR#2 stays intact). It must fail safe:

- `CelebrationService.getCelebrationState` wraps its work in a try/catch. On **any** error (DB unavailable, slow dependency throwing, unexpected data), it logs (Sentry, GR#10) and returns the neutral default `{ state: 'NONE', label: '', active_rewards: [] }` — never a 500 to the staff client.
- A birthday badge failing must make the badge silently disappear, never break the barista's order ticket. The gesture is never worth an incident.
- No bespoke per-request timeout is introduced (Node is async — a slow query awaits, it doesn't block the event loop; statement-level limits, if ever wanted, are a global DB-config decision, not this endpoint's job). The error boundary above is the right-sized control.

This behavior is codified as **Golden Rule #17 (non-critical surfaces fail safe)** — see §9.

## 9. Golden Rules #16 + #17 + decision-log

Manager-approved. Both rules have been **added to `docs/golden-rules.md`** and `CLAUDE.md §3` updated to reference them; the decision-log records the rationale (so future readers know the extensions beyond Spec Part 13's 15 were deliberate, not spec drift).

**Golden Rule #16 — Staff see derived state, never customer PII:**
> A staff-facing client never receives a customer's raw PII beyond operational need. Date of birth, age, and birth year never leave the server to any staff surface — staff receive a derived state (e.g. "birthday today"), not the underlying data. Generalizes the `baristaName` privacy-by-design precedent.

**Golden Rule #17 — Non-critical surfaces fail safe:**
> Nice-to-have read surfaces (badges, recommendations, celebration state) degrade to a neutral default on error — never propagate a failure onto the order/checkout path, never turn a broken dependency into a 500. Same DNA as GR#2 (checkout sacred) and GR#6 (Clover failure ≠ order failure).

**Decision-log entry** (`docs/decision-log.md`, 2026-05-26 "Staff celebration-state endpoint") covers: the new endpoint; the minimal-slice choice (offers-as-source, no v2 plumbing); the 403-vs-404 reconciliation; the `NONE`-for-unknown-customer anti-enumeration choice; the `active_rewards`-empty-until-issuance reality; both new Golden Rules; and a **"considered and explicitly deferred"** block recording the FAANG-tier review suggestions we rejected as premature for this scale (field-level DOB encryption / shadow-column / vault, daily Redis pre-compute + 24h negative caching, hard 200ms timeout, feature-flag caching, adaptive/anomaly throttling) with the per-item rationale — so they aren't reopened without the scale to justify them.

---

## 10. Test plan (all of brief §6, plus boundaries)

**Pure date helper (`celebration-date.spec.ts`):**
- Birthday today (store tz) → `BIRTHDAY_TODAY`.
- Birthday in 3 days → `BIRTHDAY_THIS_WEEK`.
- Birthday in 8 days → `NONE` (outside window).
- No birthday (`null`) → `NONE`.
- Feb 29 birthday, non-leap year → `BIRTHDAY_TODAY` on Feb 28.
- Feb 29 birthday, leap year → `BIRTHDAY_TODAY` on Feb 29.
- Year-boundary wrap: today Dec 30, birthday Jan 2 → `BIRTHDAY_THIS_WEEK`.
- **Timezone boundary:** a `now` that is "tomorrow" in UTC but still "today" in `America/New_York` (and vice-versa) resolves against the **store** day, not UTC.

**Service (`celebration.service.spec.ts`):**
- Flag off → `NONE` / empty / `""` regardless of birthday.
- Known customer, birthday today, no live offers → `BIRTHDAY_TODAY` + `active_rewards:[]`.
- Known customer with a live `birthday_drink` offer → reward mapped correctly (`reward_id`, `type`, `title`, `requires_purchase:true`, `expires_at`).
- Redeemed / expired / unsent offers excluded from `active_rewards`.
- Unknown `customerId` → `NONE` / empty (no throw, no DB error leak).

**Controller (`celebration.controller.spec.ts`):**
- **Privacy key-absence assertion** across all three states (build-failing). *(brief §6)*
- Customer (non-staff) token → **403**. *(brief §6)*
- Valid staff token → 200 with the DTO.
- Malformed `:customerId` → 400 (`ParseUUIDPipe`).
- Throttle decorator present (smoke).

---

## 11. Out of scope (deferred — no rewrite needed when picked up later)

- The barista **badge UI** and the one-tap **redemption affordance** (no POS/dashboard client exists to render them).
- The generic **`rewards` table** from the unbuilt v2 §2.2 (we use `offers` as the Phase-1 source; a future migration can swap the mapping source without changing the endpoint contract).
- The **daily issuance worker** (v2 §6) — until it exists, `active_rewards` is empty in practice.
- The **`SHOW_DAYS_UNTIL_BIRTHDAY` "in N days"** label variant (the seam exists; default stays vague-and-warm).
- Anniversary / referral reward **types** — they will flow into `active_rewards` automatically via the generic offer→reward mapping with no endpoint change.

---

## 12. Branch & commit guidance (CLAUDE.md §7–8)

- Branch: `feat/api/staff-celebration-state` (no GitHub issue assumed; create one if desired and use its number).
- One concern. Suggested commit slices if splitting: (1) pure date helper + tests, (2) module/endpoint/DTO/service + tests + flag seed, (3) docs (golden rule #16 + decision-log entry). All on the feature branch, local until explicit push approval.
