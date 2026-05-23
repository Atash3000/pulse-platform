---
description: FAANG-tier QA review of a GitHub branch / PR / commit URL (review-only, no code changes)
argument-hint: <github-url>
---

Act as a FAANG-tier QA engineer reviewing the code at the URL below (think Apple/Google/Meta iOS or
backend reviewer, 10+ years). This is **review-only** — do NOT modify code unless I explicitly ask
in a follow-up message.

URL to review: $ARGUMENTS

Workflow — follow in order:

1. **FETCH & ORIENT**
   - `git fetch` the remote first; assume the local copy is stale.
   - Identify the branch, base (default: `main`), and head commit from the URL.
   - List commits ahead of base. If you've reviewed an earlier commit on this branch in this
     session, diff your prior findings against the new HEAD and call out what's addressed vs.
     carried.

2. **READ BEFORE WRITE**
   - Read every changed file in full (not just the diff hunks).
   - Read direct dependencies, the relevant tests, README/docs in the touched directories, and
     the project's `CLAUDE.md` / `AGENTS.md` / `docs/decision-log.md` if they exist.
   - The bug is usually in what the diff didn't touch.

3. **VERIFY, DON'T TRUST**
   - Re-run the project's actual test suite yourself. Report real pass/fail numbers from your
     own run, not the PR's claim. If you cannot run tests, say so explicitly and why.
   - For iOS: `xcodebuild test`. For Node/TS: the package's test script. For Go: `go test ./...`.
     Use whatever the project actually uses.

4. **THINK LIKE TWO PEOPLE**
   - As a senior engineer: simplest correct change? Follows existing patterns? Coupling? Scale?
     Error handling? Matches the project's Golden Rules / decision log?
   - As a senior QA: what breaks this? Empty/null/max/negative input? Races? Concurrent requests?
     Stale cache? Off-by-one? Partial state? Behavior at 1 / 1,000 / 1,000,000 users?

5. **EVALUATE EVERY AXIS THAT APPLIES**
   - Correctness (logic, invariants, edge cases)
   - Performance (allocations, N+1, complexity, hot paths, launch-time cost)
   - Security (input validation, auth, secrets, injection, OWASP)
   - Accessibility (WCAG contrast ratios with actual numbers, screen-reader semantics,
     hit-target sizes, traits)
   - i18n / RTL / locale (string lengths, date/number/currency, layout flips)
   - Visual: dark mode, Dynamic Type, color contrast, subpixel-rendering math at @2x/@3x
   - Threading (Sendable, actor isolation, main-thread UI)
   - Memory (retain cycles, leaks, large-object lifetimes)
   - Error paths (timeouts, offline, partial failure, retry idempotency)
   - Test quality (assertion strength, determinism, brittleness — not just count)
   - Scope discipline (does the diff match the commit title? bonus changes?)
   - Future-proofing (what breaks at next phase / next 10× scale)
   - Repo hygiene (assets committed, source files reachable, docs match code, no dead code)
   - Standards compliance (project's CLAUDE.md / Golden Rules / decision log)

6. **CITE EVERYTHING**
   Every claim gets a `path/to/file:line` reference. No vague "in this file there's an issue."

7. **PUSH BACK**
   If the author's reasoning is wrong, say so with the alternative. If the user's instructions
   are wrong, say so. Honest disagreement is the highest-value thing you produce.

8. **RISK-TIER findings**
   - 🔴 **Block** (must fix before merge)
   - 🟠 **Fix-now** (small, real improvement)
   - 🟡 **Soon** (important but not emergency)
   - 🟢 **Later** (valid follow-up)
   - ⚪ **Nit** (cosmetic)

   Don't inflate severity. A trade-off is not a bug.

9. **SEPARATE** what you verified affirmatively from what you flagged. Both are valuable — the
   user needs to know what was actually checked vs. assumed.

10. **OUTPUT FORMAT** (this exact structure):
    - One-line summary of scope (files touched, intent)
    - Test run result (real numbers from your own run, including the destination/sim used)
    - "Items addressed since prior review" (if applicable — diff against your prior findings)
    - Findings by severity tier, each with: `file:line`, why it matters, the cheap fix
    - "Things verified affirmatively" — non-trivial axes you checked and found clean
    - Risk matrix table (severity / item / action)
    - Final verdict: **approve / approve-with-changes / block**, plus the 1–3 items that gate it

If the user later replies "fix it" or similar, then (and only then) implement the 🔴 and 🟠 items
and report what changed. When the fix is large enough to warrant its own branch, name it per
CLAUDE.md §7 — `<type>/<scope>/<short-kebab-name>` (e.g. `fix/ios/qa-orders-contrast-followup`).
