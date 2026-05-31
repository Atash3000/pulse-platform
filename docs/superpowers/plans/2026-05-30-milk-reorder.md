# Milk Reorder Implementation Plan (Part A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change the milk modifier set + display order to `Whole, Oat, Almond, 2%, Skim, Half & Half` (curated `sort_order`), dropping Coconut/Pistachio.

**Architecture:** Pure seed-data change in `apps/api/scripts/seed-menu.ts` — milks are DB rows; their `sort_order` *is* the display order (iOS renders by it, no runtime sort). No schema migration. Part B (temperature/ice) and Part C (manageability) of the design are NOT in this plan.

**Tech Stack:** NestJS + TypeORM (Postgres), the `seed:menu` script. Verified by a clean dev re-seed + SQL spot-check (this repo does not unit-test the seed script; verification is a real re-seed, per the seed file header).

**Branch:** `feat/api/milk-reorder` (created off `main`; the spec is committed on it). Working dir for commands: `apps/api/`.

> **Commit policy (CLAUDE.md §8):** each task ends with a commit; the human approves. Don't push.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `apps/api/scripts/seed-menu.ts` | Modify (`MILK` group spec, ~line 139) | New milk set + curated order |
| `docs/decision-log.md` | Modify (append) | Record the milk-set change (reverses v2) |

---

## Task 1: Replace the `MILK` group spec

**Files:** Modify `apps/api/scripts/seed-menu.ts`

- [ ] **Step 1: Replace the `MILK` constant** (currently around line 139). Replace the entire `const MILK: GroupSpec = { … };` block with:

```typescript
const MILK: GroupSpec = {
  required: true,
  multi_select: false,
  sort_order: 1,
  modifiers: [
    // Curated display order — sort_order IS the order iOS renders (no runtime
    // sort). Default resolves to the cheapest option (Whole, 0¢) via the iOS
    // cheapest-option rule. Dairy = 0¢; alt-milks (Oat/Almond) = +75¢.
    { name: 'Whole',       price_cents: 0,  sort_order: 0 },
    { name: 'Oat',         price_cents: 75, sort_order: 1 },
    { name: 'Almond',      price_cents: 75, sort_order: 2 },
    { name: '2%',          price_cents: 0,  sort_order: 3 },
    { name: 'Skim',        price_cents: 0,  sort_order: 4 },
    { name: 'Half & Half', price_cents: 0,  sort_order: 5 },
  ],
};
```

- [ ] **Step 2: Verify it compiles**

Run (from `apps/api/`): `npm run build`
Expected: clean build (no TypeScript errors).

- [ ] **Step 3: Commit**

```bash
git add apps/api/scripts/seed-menu.ts
git commit -m "feat(api): milk set/order → Whole, Oat, Almond, 2%, Skim, Half & Half

Curated sort_order = display order (iOS renders by it). Dairy 0¢, alt-milks
+75¢. Drops Coconut/Pistachio; re-adds 2%/Skim/Half & Half — reverses the
2026-05-29 v2 milk decision (intentional, manager request).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Record the decision

**Files:** Modify `docs/decision-log.md` (append at end)

- [ ] **Step 1: Append the entry**

Add to the end of `docs/decision-log.md`:

```markdown
## 2026-05-30 — [api] Milk catalog reordered to Whole/Oat/Almond/2%/Skim/H&H (reverses v2)

**Decision:** The milk modifier set is now Whole (0¢), Oat (75¢), Almond (75¢), 2% (0¢), Skim (0¢), Half & Half (0¢), in that curated `sort_order`. Coconut and Pistachio removed; 2%/Skim/Half & Half re-added.

**Context:** Manager request for the milk display order on the cart/detail screens. This reverses the 2026-05-29 v2 milk decision (which removed 2%/Skim/H&H/Soy and added Coconut/Pistachio).

**Reasoning:** Curated `sort_order` is the exact display order — iOS renders modifiers by `sort_order` with no runtime sort. Dairy options are 0¢; alt-milks (Oat/Almond) +75¢. Default stays the free Whole via the iOS cheapest-option rule.

**Trade-offs:** `seed:menu` upserts and does NOT delete dropped options, so a dev DB seeded before this change keeps Coconut/Pistachio as active rows until a clean re-seed. The broader manager-manageable-modifiers design (shared catalog + admin API) and the temperature/ice options are specced separately in `docs/superpowers/specs/2026-05-30-drink-options-design.md` (§4–§5) and not built here.
```

- [ ] **Step 2: Commit**

```bash
git add docs/decision-log.md
git commit -m "docs: record milk catalog reorder (reverses v2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Verify (clean re-seed + SQL + full suite)

> This task includes a **destructive dev-DB wipe** (`docker compose down -v`) — required so the dropped Coconut/Pistachio don't linger (the seed never deletes). Only run against the local dev DB (no real data).

- [ ] **Step 1: Full backend test suite** (no DB needed — Jest mocks)

Run (from `apps/api/`): `npm test`
Expected: all suites pass (the seed change is data-only; unit tests use fixtures, not the live seed).

- [ ] **Step 2: Clean re-seed**

Run (from `apps/api/`):
```bash
docker compose down -v
docker compose up -d --wait postgres redis
npm run migration:run
npm run seed:dev
npm run seed:menu
```
Expected: `seed:menu complete` summary with non-zero modifier inserts.

- [ ] **Step 3: SQL spot-check** — confirm the milk catalog (adjust container/db names if different — `pulse-postgres`, db/user `pulse`):

```bash
docker exec pulse-postgres psql -U pulse -d pulse -c \
"SELECT DISTINCT m.name, m.price_cents, m.sort_order \
 FROM modifiers m JOIN modifier_groups mg ON m.group_id = mg.id \
 WHERE mg.name = 'Milk' ORDER BY m.sort_order;"
```
Expected exactly (no Coconut/Pistachio):
```
 Whole | 0   | 0
 Oat   | 75  | 1
 Almond| 75  | 2
 2%    | 0   | 3
 Skim  | 0   | 4
 Half & Half | 0 | 5
```

- [ ] **Step 4: Report** — tests green, build clean, milk catalog matches. Branch ready for review/PR; do not push without approval.

---

## Self-review (completed by plan author)

**Spec coverage:** This plan implements **Part A only** of `2026-05-30-drink-options-design.md` (§3 milk reorder) + its decision-log entry. Parts B (temperature/ice, §4) and C (manageability, §5) are explicitly out of scope per the spec's sequencing and get their own cycle. ✅

**Placeholder scan:** none — exact milk table, exact seed code, exact SQL. The "specced separately" references point to the real design doc. ✅

**Type/consistency:** the `MILK` block matches the existing `GroupSpec` shape (`required`/`multi_select`/`sort_order`/`modifiers[{name,price_cents,sort_order}]`) used by the surrounding milk/size/sweetness constants in `seed-menu.ts`. Prices integer cents (GR#7). ✅
