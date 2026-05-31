# Drink Options — Milk Reorder + Temperature/Ice + Modifier Manageability — Design

**Date:** 2026-05-30
**Status:** Approved design — ready for implementation planning
**Surfaces:** `apps/api` (seed) now; `apps/api` + `apps/ios` next; `apps/dashboard` (future)
**Audience:** the `/superpowers:writing-plans` planner and implementing engineers.

---

## 1. Goal & scope

Three related pieces, **sequenced**:

- **Part A — Milk reorder (BUILD THIS CYCLE):** change the milk options + display order to `Whole, Oat, Almond, 2%, Skim, Half & Half`. Small seed-data change.
- **Part B — Temperature & ice as options (SPEC ONLY — build next cycle):** a drink can be hot-only, iced-only, or both; when both, the customer chooses Hot/Iced; iced drinks get an Ice level (Light / **Standard default** / Extra). Ice is **hidden** unless the drink is iced.
- **Part C — Modifier manageability (FUTURE — todos):** let a manager add/disable/reorder options without migrations. Captured as a documented path, not built.

**Only Part A is implemented this cycle.** Parts B and C are designed here so the plan and todos exist; each gets its own build cycle.

---

## 2. Background: how modifiers work today (and the real constraints)

- Options live in two tables: `modifier_groups` (per group) and `modifiers` (per option). A `Modifier` row has `name`, `price_cents`, `sort_order`, and **`active` (boolean)**. A `ModifierGroup` has `name`, `required`, `multi_select`, `sort_order`, and **`item_id`** — i.e. **groups are duplicated per item** (each milk drink has its own "Milk" group).
- The seed (`apps/api/scripts/seed-menu.ts`) builds these groups per item via `groupsForItem()`; it upserts by natural key and **does not delete** options dropped from the catalog (clean dev re-seed needed when shrinking — documented in the seed header).
- iOS renders modifier groups **generically, sorted by `sort_order`** (no runtime sort algorithm). `MenuItem.temperature` (`hot|iced|both`) already exists and drives the menu Hot/Iced filter + a fixed "· Hot" metadata line on single-temperature drinks (product-detail screen).
- **Key fact for Part C:** adding/disabling/reordering an option is a **data change, not a schema migration** (`active`, `sort_order`, INSERT). The friction is (1) per-item duplication and (2) no admin API / no `apps/dashboard`.

---

## 3. Part A — Milk reorder (build this cycle)

### Change
In `apps/api/scripts/seed-menu.ts`, replace the `MILK` group spec. New set + curated order (the `sort_order` *is* the display order; iOS renders in that order):

| name | price_cents | sort_order |
|---|---|---|
| Whole | 0 | 0 |
| Oat | 75 | 1 |
| Almond | 75 | 2 |
| 2% | 0 | 3 |
| Skim | 0 | 4 |
| Half & Half | 0 | 5 |

- Group stays `required: true, multi_select: false, sort_order: 1`.
- **Default** resolves to **Whole** via the existing iOS cheapest-option rule (0¢, lowest sort_order) — no premium default.
- **Dropped:** Coconut, Pistachio. **Re-added:** 2%, Skim, Half & Half. This **reverses the 2026-05-29 v2 milk decision** — recorded as a new decision-log entry (intentional, per the manager).
- Prices integer cents (GR#7).

### Apply / caveat
Because the seed doesn't delete dropped options, a **clean dev re-seed** is required so Coconut/Pistachio don't linger (`docker compose down -v` → `migration:run` → `seed:dev` → `seed:menu`). Stated in the plan.

### Tests
Seed produces exactly the 6 milks with the prices/sort above; existing seed idempotency unchanged. (No iOS change — it already renders by `sort_order`.)

---

## 4. Part B — Temperature & ice as options (spec; build next cycle)

### Model — regular modifier groups, derived from `item.temperature`
Reuse the existing modifier system so options stay data-managed and iOS renders them generically. The seed's `groupsForItem()` derives groups from `item.temperature`:

- `temperature == both` → attach a **Temperature** group: `Hot` (sort 0), `Iced` (sort 1); `required`, single-select; both 0¢.
- `temperature ∈ {iced, both}` → attach an **Ice** group: `Light` (0), `Standard` (1, **default**), `Extra` (2); `required`, single-select; all 0¢.
- `temperature ∈ {hot, iced}` (single) → **no** Temperature group; the fixed temperature shows as metadata (existing product-detail behavior).

> Default temperature for `both` drinks = `Hot` (first by sort_order, via the cheapest-option rule since both are 0¢). Per-drink defaults (e.g. matcha → Iced) are a later merchandising tweak (a future `is_default`/sort tweak) — noted, not built.

### The conditional: ice only when iced (lightweight, no schema change)
iOS shows the **Ice** group only when the drink is actually iced:
- iced-only → Ice always shown.
- `both` → Ice shown only when the **Temperature** selection is `Iced`; **hidden** (not disabled) when `Hot`.
- hot-only → no Ice group attached at all.

**Implementation:** a thin client convention in the iOS generic renderer — a group named **`Ice`** renders only when the item has no `Temperature` group (iced-only) OR the `Temperature` group's current selection is the `Iced` option. Keyed on the well-known group/option names + `item.temperature`. **No new schema column.** When Ice is hidden, its selection is ignored for `selectedModifierIds` so a hot drink never sends an ice modifier.

> Heavier alternative considered & deferred (YAGNI): a generic `shows_when` dependency column on `modifier_groups` (group X shows when group Y's selection == Z). Build only if a second conditional appears — captured as a todo.

### iOS rendering & interaction
- The generic modifier renderer (detail screen) already sorts by `sort_order`; add the conditional-Ice rule + recompute visible groups when the Temperature selection changes.
- The **temperature badge** (already on cart + detail) derives from the selected Temperature for `both` drinks, else from `item.temperature`.
- `ItemCustomization` must treat a hidden Ice group's selection as absent (not counted in `isSatisfied`, not in `selectedModifierIds`).

### Pricing & rules
Temperature & ice are 0¢ (GR#7). Required groups keep a valid default (GR#17): Temperature default Hot, Ice default Standard.

### Tests (next cycle)
Seed attaches Temperature only to `both`, Ice to iced-capable, neither to hot-only; iOS shows/hides Ice per the Temperature selection; hidden Ice not in `selectedModifierIds`; `isSatisfied` ignores hidden groups; badge reflects chosen temperature.

---

## 5. Part C — Modifier manageability (future; todos)

Recorded in `docs/todo-endpoints.md`; not built. The path:
1. **Shared modifier catalog** — replace per-item duplicated groups with shared definitions (e.g. a `modifier_group_templates` catalog + an item↔template link), so a milk/temperature/ice change is **one row** applied everywhere, not edited per drink. One restructuring migration; after it, option changes are migration-free.
2. **Admin API** — CRUD + `active` toggle + `sort_order` reorder for modifiers/groups (today only `admin-orders` exists; no modifier admin).
3. **Dashboard UI** — a manager screen to manage options. `apps/dashboard` does not exist yet → its own project.

Until then, options change via the seed script (dev) or direct DB; `active=false` hides an option without deletion.

---

## 6. Golden Rules
- **#7 (integer cents):** milk/temperature/ice prices are `Int` cents. ✅
- **#8 (iOS never calculates charged price):** unaffected — these are selections; backend prices at checkout. ✅
- **#15 (ship boring first):** Part A is a data change; the generic `shows_when` engine is deferred (thin convention instead). ✅
- **#17 (fail-safe):** required Temperature/Ice always have valid defaults; a hidden Ice group never blocks the CTA or sends a stray modifier. ✅

---

## 7. Deferred / todos
- Generic `shows_when` conditional-modifier capability (Part B uses a thin convention instead).
- Per-drink temperature default (matcha → Iced) — merchandising tweak.
- Shared modifier catalog + admin API + dashboard (Part C).
- These join `docs/todo-endpoints.md`.
