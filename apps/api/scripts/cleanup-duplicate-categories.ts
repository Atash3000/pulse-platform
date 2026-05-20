/**
 * cleanup-duplicate-categories.ts
 *
 * Standalone script (NOT a TypeORM migration) — fixes local-dev databases
 * that got duplicate `menu_categories` rows for the same (location_id, name)
 * pair via earlier manual SQL inserts.
 *
 * Why this is a script, not a migration
 * -------------------------------------
 * TypeORM migrations run automatically at app boot in production (via the
 * Phase 2 deployment workflow). Production has never had the duplicates
 * — they were created locally during iOS Commit A verification. A
 * migration that runs in production would be a no-op for production
 * databases but creates the wrong mental model: "this codebase
 * routinely cleans up its own data corruption." Cleanup belongs in a
 * dev-only ad-hoc tool.
 *
 * The `menu_categories` schema has NO unique constraint on
 * (location_id, name). Adding one would be a separate architectural
 * decision (the spec allows a future "Latte" + "Latte (Holiday)"
 * category renaming pattern that a UNIQUE constraint would block). For
 * now: this script ensures the dev DB is clean; the seed:menu script
 * uses upsert-by-name so future runs don't recreate the duplicate.
 *
 * Algorithm
 * ---------
 * For every (location_id, name) group with > 1 rows:
 *
 *   1. Pick KEEPER = lowest sort_order (deterministic; sort_order is
 *      the only chronological-ish signal — menu_categories has no
 *      created_at column).
 *      Tiebreaker on equal sort_order: lowest id (UUID lexicographic).
 *
 *   2. Re-point any `menu_items.category_id` referencing an ORPHAN to
 *      the KEEPER. ORDER MATTERS: re-point BEFORE deleting orphans, or
 *      the FK CASCADE on menu_categories.id will cascade-delete the
 *      items themselves.
 *
 *   3. Delete the orphan categories.
 *
 * Wrapped in a transaction so partial failure does not leave dangling
 * references.
 *
 * Run with: npm run cleanup:duplicate-categories
 *
 * Safe to run multiple times. On a clean database, exits with a "no
 * duplicates found" message and zero changes.
 *
 * Item-level dedup (e.g., two "Espresso" rows in the same category) is
 * OUT OF SCOPE — that's a separate decision because the schema also
 * has no unique constraint on (category_id, name), and the right call
 * varies by data (sometimes you want "Latte" + "Iced Latte" via
 * modifier groups, sometimes via separate items).
 */

import 'reflect-metadata';
import { DataSource } from 'typeorm';

import { AppDataSource } from '../src/database/data-source';

interface DupeGroup {
  location_id: string;
  name: string;
  keeper_id: string;
  orphan_ids: string[];
  orphan_count: number;
  items_repointed: number;
}

async function run(ds: DataSource): Promise<void> {
  await ds.initialize();

  const summary: DupeGroup[] = [];
  let totalOrphans = 0;
  let totalItemsRepointed = 0;

  await ds.transaction(async (em) => {
    // Find every (location_id, name) group that has more than one row.
    // Raw SQL because the aggregate-then-detail pattern doesn't fit
    // TypeORM's findOne cleanly and we want explicit ORDER BY for
    // determinism.
    const groups = (await em.query(
      `SELECT location_id, name, COUNT(*)::int AS row_count
         FROM menu_categories
        GROUP BY location_id, name
       HAVING COUNT(*) > 1
        ORDER BY location_id, name`,
    )) as Array<{ location_id: string; name: string; row_count: number }>;

    if (groups.length === 0) {
      console.log('cleanup:duplicate-categories → no duplicates found, exiting clean.');
      return;
    }

    console.log(`cleanup:duplicate-categories → ${groups.length} duplicate group(s) found:`);

    for (const g of groups) {
      // Pick the KEEPER. Determinism rules:
      //   - lowest sort_order wins (the earlier-displayed one is usually
      //     the original; the duplicate was usually appended with a
      //     higher sort_order)
      //   - tiebreaker: lowest id lexicographic (UUID compare). This is
      //     arbitrary but stable — running cleanup twice always picks
      //     the same row.
      const rows = (await em.query(
        `SELECT id, sort_order
           FROM menu_categories
          WHERE location_id = $1 AND name = $2
          ORDER BY sort_order ASC, id ASC`,
        [g.location_id, g.name],
      )) as Array<{ id: string; sort_order: number }>;

      const keeper = rows[0]!;
      const orphans = rows.slice(1);
      const orphanIds = orphans.map((r) => r.id);

      // Re-point items from orphans to the keeper. Done in a single
      // UPDATE so we get an accurate `affected` count.
      const result = await em.query(
        `UPDATE menu_items
            SET category_id = $1
          WHERE category_id = ANY($2::uuid[])`,
        [keeper.id, orphanIds],
      );
      // PostgreSQL UPDATE returns [rows, affected_count] via TypeORM's
      // .query — when there are no RETURNING rows, the second array
      // element is the affected count.
      const itemsRepointed = Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;

      // Delete the orphan categories. FK from menu_items now points at
      // keeper, so CASCADE on category-delete will not take items with
      // it.
      await em.query(`DELETE FROM menu_categories WHERE id = ANY($1::uuid[])`, [orphanIds]);

      summary.push({
        location_id: g.location_id,
        name: g.name,
        keeper_id: keeper.id,
        orphan_ids: orphanIds,
        orphan_count: orphanIds.length,
        items_repointed: itemsRepointed,
      });
      totalOrphans += orphanIds.length;
      totalItemsRepointed += itemsRepointed;
    }
  });

  // ---- Report ----------------------------------------------------------
  for (const s of summary) {
    console.log(
      `  • location=${s.location_id} name="${s.name}"\n` +
        `      kept ${s.keeper_id}\n` +
        `      removed ${s.orphan_count} orphan(s)\n` +
        `      re-pointed ${s.items_repointed} menu_item row(s)`,
    );
  }

  if (summary.length > 0) {
    console.log(
      `\ncleanup:duplicate-categories complete — removed ${totalOrphans} orphan categor${
        totalOrphans === 1 ? 'y' : 'ies'
      }, re-pointed ${totalItemsRepointed} item row(s).`,
    );
  }

  await ds.destroy();
}

run(AppDataSource).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('cleanup:duplicate-categories FAILED:', err);
  process.exit(1);
});
