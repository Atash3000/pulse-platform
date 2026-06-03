---
description: Security review of a branch, PR, or git ref range — auth, JWT, Stripe webhook verification, secret hygiene, input validation, rate limiting, iOS token storage. Read-only.
argument-hint: [pr-number | branch-name | git-ref-range | (empty = current branch vs main)]
---

Run a security review of in-scope changes. Invoke the `security-reviewer` sub-agent and pass it the scope below. This is **review-only** — do NOT modify code unless I explicitly ask in a follow-up message.

Scope argument: $ARGUMENTS

Resolve the scope as follows (in order):

1. **No argument** → diff is `origin/main...HEAD` (current branch vs main).
2. **Pure number** (e.g. `42`) → it's a PR number. Use `gh pr view 42 --json baseRefName,headRefName` to fetch refs, then `git fetch && git diff <base>...<head>`.
3. **Looks like a branch name** (contains `/`, no `..`) → `git diff origin/main...<branch>`.
4. **Git ref range** (contains `..`, e.g. `HEAD~3..HEAD`, `main..feat/foo`) → `git diff <range>` exactly as given.
5. **Anything else** → ask me to clarify; do not guess.

Workflow:

1. **FETCH & ORIENT**
   - `git fetch origin` first.
   - Compute the diff per the scope rules above.
   - List changed files.

2. **FILTER TO JURISDICTION**
   - The `security-reviewer` sub-agent owns these paths only:
     - `apps/api/src/modules/auth/**`
     - `apps/api/src/modules/payments/**`
     - `apps/api/src/modules/checkout/**` (auth + idempotency surface)
     - Any `*.controller.ts` (perimeter audit)
     - `apps/api/src/main.ts`
     - `apps/api/src/database/entities/*` (sensitive columns only)
     - `apps/api/src/database/migrations/*`
     - `apps/ios/PulseCoffeeApp/Core/Keychain.swift`
     - `apps/ios/PulseCoffeeApp/Core/SentryRedactor.swift`
     - `apps/ios/PulseCoffeeApp/Core/APIClient.swift`
     - `apps/ios/PulseCoffeeApp/Core/TokenRefresher.swift`
     - `apps/ios/PulseCoffeeApp/Core/AppState.swift`
     - `apps/ios/PulseCoffeeApp/PulseCoffeeApp.entitlements`
     - `apps/ios/PulseCoffeeApp/Info.plist`
     - `.env`, `.env.*` (excluding `.env.example`), `.env.example`, `.gitignore`
   - If the diff has zero files in this list, report *"No security-scoped files in diff"* and stop. Don't invoke the sub-agent for a no-op.

3. **DELEGATE TO THE SPECIALIST**
   - Hand the filtered file list + computed git range to the `security-reviewer` sub-agent.
   - The sub-agent has its own protocol (read full files, run repo-wide secret-shape scans, audit the controller perimeter, tier findings, cite `file:line`, propose fixes). Don't second-guess its rules; it specializes in this surface.

4. **RELAY THE REPORT**
   - Forward the sub-agent's structured report verbatim. Don't paraphrase tiered findings — those are calibrated.
   - Add one paragraph at the top that names the scope (PR / branch / range) and the resolved git diff command used. That makes the report reproducible.

5. **STOP HERE**
   - This command does not apply fixes. If I want fixes, I'll start a new turn with the specific findings I want addressed.
   - This command does not run the test suite. Security issues don't necessarily show up in unit tests — that's why we have this specialist.

Notes:

- **Repo-wide vs diff-only scans.** Secret-shape scans (Stripe key literals, JWT-shaped tokens, AWS keys, etc.) run repo-wide, not just on the diff. A secret introduced in this PR is the most relevant signal, but a secret committed three months ago that's still in the tree is a bigger problem and worth surfacing once per session.

- **Perimeter audit cadence.** The "every controller has the expected guard placement" audit is expensive (read every controller). The sub-agent should do this once per session, not once per PR — caching the previous result and diffing against the new HEAD.

- **Overlap with `payment-reviewer`.** Both reviewers look at the checkout flow. `security-reviewer` focuses on auth gates and request validation; `payment-reviewer` focuses on money invariants (integer cents, idempotency replay semantics, three-status separation). If a PR touches checkout, mention in a footer that `payment-reviewer` may want a separate look.

- **Overlap with `accessibility-reviewer`.** Zero overlap. Distinct concerns.

- **Known Gap tier.** The sub-agent uses a `Known Gap` tier for issues that this PR didn't introduce but also didn't fix (e.g., refresh-token rotation not implemented, CORS allowlist not set up for prod). These are signal, not blockers — don't strip them from the report.

- **Stripe + Webhook special handling.** Webhook code changes get a re-read of `apps/api/src/modules/payments/README.md` first. That README explains the threat model concretely; the agent should ground its review in those exact threats.
