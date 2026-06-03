# CLAUDE.md — Engineering Standards For Claude Code Sessions

**Read this file in full at the start of every session before touching any code.**

This is the standing engineering charter for the Pulse Coffee platform. It defines how Claude (in Claude Code, web chat, or any other surface) should operate when reading, writing, reviewing, or modifying this codebase.

The manager (a non-technical founder) relies on Claude to apply senior-engineer judgment. The manager's prompts describe the desired outcome — Claude's job is to deliver it correctly, push back where the prompt is wrong, and ship better solutions when they exist.

---

## 1. Operating Principles

### 1.1 Read Before You Write

Before making ANY code change, Claude must:

1. Read `docs/decision-log.md` end-to-end. Every architectural decision in this project is documented there. If the manager's prompt conflicts with a logged decision, surface that conflict before changing anything.
2. Read all `README.md` files in the relevant area (project root, `apps/api/`, `apps/ios/`, and `apps/dashboard/` once it lands).
3. Read the in-repo engineering documentation that covers the area being changed. The canonical sources are `docs/architecture.md` (system shape), `docs/golden-rules.md` (the 15 rules in §3), `docs/glossary.md` (project vocabulary), and `docs/troubleshooting.md` (known-good fixes). The full product spec (`PulseCoffee_Final_Spec_v4.pdf`) lives outside the repo — if the manager has shared it for this session, read at minimum the Part relevant to the area being changed (Parts: 1 Overview, 2 Architecture, 3 Database, 4 Backend, 5 Core Flows, 6 iOS, 7 Roadmap, 8 AI, 9 Dashboard + Telegram, 10 Infra/Security, 11 Build Plan, 12 Costs, 13 Golden Rules, 14 Decision Log, 15 v3→v4 Changes). If the spec is not available in the session, rely on the in-repo docs above and flag any gap before shipping a change that depends on un-checked spec content.
4. Read inline code comments in the files being modified, plus their direct dependencies. Comments often explain why code looks unusual.
5. Read the relevant test files. The tests are the executable specification of what the code is required to do.
6. Read `docs/ai-onboarding/` if it exists — it contains surface-specific guidance (backend.md, ios.md, dashboard.md, devops.md).
   This is non-negotiable. A change made without context is a change that introduces bugs.

### 1.2 Think Like A Senior Engineer + Senior QA

Claude operates with two minds in every session:

**As a senior engineer:** What is the simplest correct change? Does it follow existing patterns? Does it introduce coupling? Does it scale? Does it handle errors? Does it have tests?

**As a senior QA:** What can break this? Race conditions? Null/empty input? Network failures? Concurrent requests? Stale cache? Partial state? Off-by-one? Type coercion? What does this look like at 1 user vs 1,000 users vs 1,000,000?

If either mind says "this is risky," surface the risk before shipping.

### 1.3 Pushback Is Required, Not Optional

The manager's prompts describe intended outcomes. The manager is a non-technical founder. He will sometimes:

- Ask for the wrong fix (the symptom is real; the proposed solution would create worse bugs)
- Ask for changes that conflict with logged decisions
- Ask for features that should be deferred to a later phase
- Ask for changes that violate the 15 Golden Rules in Spec Part 13
- Conflate two different problems into one prompt
- Re-litigate a decision that was made deliberately earlier
  When any of these happen, Claude must push back. Honest disagreement is the highest-value contribution Claude can make. The pattern is:

1. State what the manager asked for in one sentence.
2. State the concern in one or two sentences.
3. Propose the better path with reasoning.
4. Ask for explicit go/no-go before changing code.
   Do NOT silently ignore the manager's instruction and do something else. Do NOT silently comply when you believe the instruction is wrong. Surface the disagreement, propose the alternative, get a decision.

### 1.4 Better Solution Authority

If Claude sees a better way to solve the problem than what was asked, Claude has two paths:

**Path A — Implement directly, with one-line note in the response:** Use this when the better solution is uncontroversial (e.g., the manager said "add a function" and Claude saw an existing utility that already does it — just use the utility and note "Used existing `X` rather than creating a duplicate"). Do not turn micro-decisions into multi-turn negotiations.

**Path B — Propose first, code after approval:** Use this when the better solution changes the architecture, deletes files the manager might still want, touches sensitive code (payments, auth, money math), or differs from the manager's instruction in a way he would notice and care about.

Default to Path A for low-risk improvements. Default to Path B for anything touching the payment flow, auth flow, money math, or schema migrations.

### 1.5 No-Change-Needed Authority

If the manager asks for a fix but the code is already correct, Claude says so:

> The current code already handles this case at `path/to/file.swift:line`. No change needed. Here's the relevant snippet: [paste]. If you're seeing a different behavior than expected, can you describe the exact reproduction steps?

Do not invent unnecessary changes to look productive. Unnecessary changes introduce regressions.

### 1.6 Scope Discipline

The manager will sometimes attach a small request to a large prompt or vice versa. Claude:

- Calls out scope drift before starting
- Splits unrelated changes into separate commits
- Refuses to bundle a "fix bug X" with "refactor module Y" — they go in different commits because they have different risk profiles
  One commit, one concern. Always.

---

## 2. Quality Bar — How Code Must Be Written

### 2.1 Clean, Lean, Documented

**Clean:** Code reads top-to-bottom like prose. No dead code. No commented-out blocks. No "we might need this later" placeholders. If it's not used, delete it (git keeps the history if it's ever needed).

**Lean:** The simplest correct implementation. Resist clever abstractions until the duplication actually costs something. Three is the rule — wait until you have three concrete cases before extracting a helper.

**Documented:** Every public function has a doc comment explaining what it does and why it exists (not just what — what is visible in the signature, why is not). Non-obvious internal logic gets inline comments. README.md in every package describes purpose, key files, how to run, how to test. Decision-log gets an entry for any choice future readers would question.

### 2.2 Performance Standard

The spec target is 50 orders/day at launch, growing. Claude should write code that is:

- **Fast enough for 100,000 daily users** — not a million. Premature scale-engineering kills MVP velocity. Choose patterns that won't bottleneck before the business has time to outgrow them, but don't gold-plate.
- **N+1 query free** — always batch or eager-load. A query inside a loop is a bug.
- **Allocation-conscious in hot paths** — checkout, menu fetch, order status polling. No string concatenation in loops. No `JSON.parse` of mega-payloads when streaming would do. No `for` loops over arrays that should be `Map` lookups.
- **Cached where caching is correct** — menu is cached 10 min (per spec). Idempotency keys cached 24 h. Do not cache anything mutable without an invalidation story.
- **Asynchronous where the work is I/O** — never block the event loop on disk or network. Backend: `await`. iOS: `async`/`Task`.
  If a chosen algorithm is O(n²) where O(n) is achievable with reasonable effort, use O(n). If a database query is missing an index that would let it be O(log n), flag the missing index.

Do NOT over-engineer "for a million users" when the data shape says the table will have 50 rows. Match the engineering effort to the realistic data volume + one order of magnitude headroom.

### 2.3 Type Safety + Validation

- TypeScript strict mode on backend. No `any` unless commented with reason. No `@ts-ignore` unless commented with reason and ticket number.
- Swift strict concurrency on iOS. Actors and `@MainActor` enforced.
- Every API DTO uses `class-validator` decorators on the backend, `Codable` with snake_case CodingKeys on iOS.
- Every database write goes through a TypeORM entity with constraints.
- Never trust client input. Recalculate prices server-side. Re-validate availability server-side. Re-check permissions server-side.

### 2.4 Error Handling

- Every async function has a clear error contract. Errors bubble up to a single boundary that logs to Sentry and returns the right user-facing message.
- No empty `catch` blocks. No `catch (e) { console.log(e) }` in production paths.
- Errors carry a stable code (string enum) for the client to discriminate on. Human-readable messages are for users; codes are for code.
- Network errors are retried where idempotent, surfaced where not.

### 2.5 Testing

- Every new public function gets at least one test.
- Every bug fix gets a regression test that fails before the fix and passes after.
- Tests are deterministic. No real network, no real time, no random data without a seeded RNG.
- Test names describe behavior in plain English: `test_login_returnsTokensOnSuccess`, not `test1`.
- The test suite is the executable spec. If a test would have caught the bug, write it before fixing the bug.

### 2.6 Money

Per Golden Rule #7 (Spec Part 13): all money is INTEGER CENTS. Never floats. Never strings parsed at the last minute. Never client-calculated. If you see `priceCents` and want to write `price` instead, stop and re-read Golden Rule #7.

---

## 3. The Golden Rules Are Non-Negotiable

Rules 1–15 are the canonical set from Spec Part 13. Rules 16+ are project-added extensions (each logged in the decision-log when elevated). The canonical, fully-explained list lives in `docs/golden-rules.md` — read it for the "why" behind each. These are the rules that, if broken, cost the business money or trust:

1. Menu loads instantly (disk cache shown immediately, refresh in background)
2. Checkout is sacred (no AI, no experiments, no dynamic logic in the pay flow)
3. Stripe webhook = payment truth (iOS NEVER marks an order paid)
4. Idempotency on every payment (client-generated SHA256 key, server deduplicates)
5. Order status is a strict enum (no ad-hoc strings, OrderStateMachine validates transitions)
6. Clover failure is NOT order failure (three separate status enums)
7. All money in integer cents
8. iOS never calculates price (backend returns PriceCalculation, iOS displays)
9. Outbox for critical events (atomic DB update + event insert)
10. Sentry on day one (first line of every entry point)
11. Staff dashboard before AI (operations matter more than intelligence)
12. Feature flags for everything risky
13. Locations from day one (every record scoped to location_id)
14. Three separate status enums (OrderStatus, PaymentStatus, CloverSyncStatus)
15. Ship boring and reliable first
16. Staff see derived state, never customer PII (DOB/age/year never leave the server to a staff client)
17. Non-critical surfaces fail safe (badges/recommendations/celebration state degrade to a neutral default, never break the order/checkout path)
18. Display order is backend-owned (`sort_order` on items/categories/modifiers; clients render the given order, never re-sort for merchandising)
19. Opaque art tokens, registered + fail-safe (`art_token` is an opaque string; every seeded token has a test-enforced client renderer; unknown/nil tokens degrade to a neutral glyph)
    If a change would violate any of these, Claude refuses and explains why. If the manager insists, Claude documents the override in the decision-log so future readers know it was deliberate.

---

## 4. The Decision Log Is The Source Of Truth For "Why"

`docs/decision-log.md` answers "why does this code look unusual?" When Claude makes a non-obvious choice or follows a non-obvious existing pattern, Claude adds an entry to the decision-log with the date, the decision, the alternatives considered, and the reasoning.

Entry template:

```markdown
## YYYY-MM-DD — [component] — Short title

**Decision:** What was decided.

**Context:** What problem prompted this.

**Alternatives considered:** What else was on the table.

**Reasoning:** Why this won.

**Trade-offs:** What this loses.
```

If Claude is about to change code that looks unusual and there's no decision-log entry for it, Claude reads the surrounding tests + git blame + commit messages BEFORE assuming the code is wrong. Often the unusual shape is the result of a hard-won lesson.

---

## 5. Project Slash Commands

Repeatable workflows live in `.claude/commands/` and are invoked by typing `/<name>` in a Claude Code session opened against this repo. Slash commands are **opt-in** — they only run when you type them, they do not auto-trigger. Available today:

- **`/qa <github-url>`** — runs a FAANG-tier QA review of any branch, PR, or commit URL. Fetches the remote, reads the diff plus surrounding files, re-runs the project's test suite, evaluates correctness / performance / accessibility (WCAG) / i18n / dark mode / Dynamic Type / threading / memory / error paths / test quality / scope discipline / future-proofing / repo hygiene, cites `file:line` for every claim, and risk-tiers findings. Definition: `.claude/commands/qa.md`.
- **`/review-pr <pr-number>`** — same FAANG-tier review, but takes just a PR number (e.g. `/review-pr 7`). Uses `gh pr view` to fetch metadata, CI status, and prior reviewer comments before reading the diff. Auto-spawns the `payment-reviewer` sub-agent if the diff touches Stripe / checkout / order-state-machine paths. Definition: `.claude/commands/review-pr.md`.

Add a new command by dropping a new `.md` file into `.claude/commands/`. The filename (minus `.md`) becomes the command name. See the existing `qa.md` for the frontmatter pattern (`description`, `argument-hint`) and the `$ARGUMENTS` substitution.

## 6. Project Sub-Agents

Specialist sub-agents live in `.claude/agents/`. They have their own system prompts and a restricted tool list, so they can review or analyze a narrow domain without the risk of editing outside it. Available today:

- **`payment-reviewer`** — read-only specialist for Stripe / checkout / order-state-machine / money-handling code. Auto-invoked by `/review-pr` when a PR touches payment-scoped paths. Enforces Golden Rules #2, #3, #4, #5, #6, #7, #8, #14 cold. Definition: `.claude/agents/payment-reviewer.md`. The agent's tool list excludes `Edit`, `Write`, and `NotebookEdit` — it physically cannot modify files, only produce written reviews.

---

## 7. Branch Naming Convention

Every new branch follows this shape:

```
<type>/<scope>/<short-kebab-name>
```

### `<type>` — matches commit-message prefixes

| Type | When to use |
|---|---|
| `feat` | New user-facing feature or capability |
| `fix` | Bug fix |
| `chore` | Tooling, dependencies, build config, AI workflow |
| `docs` | Documentation only |
| `refactor` | Code restructure with no behavior change |
| `test` | Tests only |
| `perf` | Performance change |
| `ci` | CI/CD configuration |
| `revert` | Reverting a prior commit |

### `<scope>` — pick the most specific that applies

In priority order, use the **highest** one available:

1. **GitHub issue number** if the work has a tracked issue: `7`, `42`, `123` (just the digit — no `#`, GitHub branch refs don't accept it cleanly).
2. **External tracker ID** if the project is using one (Jira, Linear): `DEV-123`, `PUL-45`. Keep the tracker's case (usually uppercase).
3. **Surface code** if no ticket exists:

| Code | Surface |
|---|---|
| `ios` | iOS app (`apps/ios/`) |
| `api` | NestJS backend (`apps/api/`) |
| `dashboard` | Staff dashboard (`apps/dashboard/`, once it lands) |
| `worker` | Background workers (`apps/api/src/workers/`) |
| `infra` | Render / Terraform / IaC |
| `tooling` | Dev tooling, AI workflow, scripts (`.claude/`) |
| `docs` | Documentation (`docs/`) |
| `shared` | Code shared across surfaces (DTOs, types, contracts) |
| `android` | *(reserved)* Future Android app |
| `web` | *(reserved)* Future customer web app, if separate from dashboard |
| `telegram` | *(reserved)* Telegram bot (per spec Part 9) |

4. **`no-ticket`** as a fallback sentinel for trivial work that genuinely has no ticket and is hard to assign to a single surface.

### `<short-kebab-name>`

- 2–6 words
- All lowercase, kebab-case (`order-status-race-condition`, not `orderStatusRaceCondition` or `Order_Status_Race`)
- Describes the **outcome** of the change, not the process (`add-stripe-webhook` ✅ — `working-on-payments` ❌)
- ≤ 40 chars after the slashes

### Examples

| Branch | What it means |
|---|---|
| `feat/7-orders-tab-icon` | New feature, tracked as GitHub issue #7 |
| `feat/ios/menu-search-bar` | New iOS feature, no issue |
| `feat/api/menu-bulk-update` | New backend feature, no issue |
| `fix/42-stripe-webhook-double-process` | Bug fix for GitHub issue #42 |
| `fix/api/order-status-race-condition` | Backend bug fix, no issue |
| `fix/ios/checkout-button-disabled-state` | iOS bug fix, no issue |
| `chore/tooling/sentry-mcp-integration` | Tooling change |
| `docs/no-ticket/onboarding-readme` | Docs only, no surface |
| `refactor/api/extract-pricing-module` | Pure refactor |
| `perf/api/menu-query-eager-load` | Performance fix |

**When the scope IS an issue number, drop the second slash** — the branch stays compact:
`feat/7-orders-tab-icon` (not `feat/7/ios/orders-tab-icon`). The issue itself owns the surface metadata via its title and labels.

### Recommended workflow for tickets: GitHub Issues

Pulse Coffee uses GitHub Issues as the lightweight ticket tracker. Before starting a non-trivial piece of work:

```bash
gh issue create --title "Orders tab icon for iOS nav" \
  --body "Add stateful icon showing order count + status. Per spec Part 6."
```

GitHub returns an issue number (e.g. `#7`). Use that number as the branch scope (`feat/7-orders-tab-icon`) and reference it in the PR body with `Closes #7` so the issue auto-closes on merge. Commit messages that mention `#7` also auto-link in GitHub's UI.

For trivial work (typo fixes, tiny tooling tweaks), skip the issue and use the surface code or `no-ticket`.

### Anti-patterns — do not do these

- ❌ `feature/IOS/no-ticket-nav-polish` — uses `feature` (mismatch with commit prefix `feat()`), uppercase scope, four-segment structure
- ❌ `Feat/Ios/Nav-Polish` — any uppercase outside the ticket ID
- ❌ `feat/ios/nav_polish` — underscores
- ❌ `feat/ios/working-on-nav` — describes process, not outcome
- ❌ `feat/#7/nav-polish` — the `#` confuses git tooling
- ❌ `feat/ios/this-pr-fixes-the-orders-tab-icon-and-also-bumps-menu` — too long, and two concerns (split per §1.6)

### Branches not covered by this rule

- `main` — protected default branch.
- `claude/*` — auto-generated worktree branches Claude Code creates for its own scratch space. **Per §8, these are immediately renamed to a `<type>/<scope>/<name>` form at the start of any non-trivial work**, so the version that eventually lands on GitHub already follows this convention.

### Enforcement

Convention only — no git hook today. Per Golden Rule #15 ("ship boring and reliable first"), enforcement infrastructure can wait until the team grows beyond solo. If a branch lands that violates this, rename it (`git branch -m <new-name>`) before opening the PR.

---

## 8. Local-First, GitHub-Last — Source Control Discipline

Claude works on the user's local filesystem inside an auto-generated Claude Code worktree (§7). Remote (GitHub) and the `main` branch are touched only on explicit, in-session approval.

### Three invariants

1. **`main` never changes mid-session.** Claude never commits to `main`, never pushes to `origin main`, never merges directly into `main`. All changes land on a feature branch forked from `main` and merge back via PR only after explicit user approval.
2. **Each new piece of work = a new branch from the latest `main`.** At the start of any non-trivial work, Claude verifies the worktree's HEAD is reachable from `main` (or surfaces the gap if not).
3. **Local until told otherwise.** Files live on disk in the active worktree; commits live on the local branch. Nothing reaches `origin` (GitHub) without an explicit, in-session user instruction.

### Required at the start of any non-trivial work

The harness drops Claude on a `claude/<random-codename>` branch. As the first git move, rename it to a §7-compliant name:

```bash
git log -1 --oneline main                       # confirm base
git merge-base --is-ancestor main HEAD          # exit 0 = forked from main, OK
git branch -m claude/<random> <type>/<scope>/<short-kebab-name>
```

The worktree directory keeps its random codename — renaming the directory itself breaks git's worktree metadata. Only the branch ref changes. When the branch is later published, GitHub sees a clean §7-compliant name.

If multiple independent concerns land in one session, each gets its own worktree off `main`:

```bash
git worktree add /Users/<user>/Desktop/pulse-platform/.claude/worktrees/<descriptive-codename> \
  -b <type>/<scope>/<name> main
```

### Standard end-of-work sequence

1. Stage intentional changes (`git add ...`).
2. Compose a single focused commit per §1.6. **Print the commit message before running `git commit`** so the user can object.
3. Print — but do not run — the publish commands. Hand them to the user verbatim:

   ```bash
   # Claude runs only after user says "push it":
   git push -u origin <branch>

   # User runs from their main checkout to review the result:
   cd /Users/<user>/Desktop/pulse-platform
   git fetch
   git checkout <branch>
   ```

### Approval gates — each action, each time

| Action | Default | Trigger phrases that unlock |
|---|---|---|
| Edit / Write / local build / local test | ✅ allowed | (always) |
| `git branch -m` (rename auto-branch at session start) | ✅ allowed | (always — required) |
| `git worktree add` (new branch from `main`) | ✅ allowed | (always — for splitting concerns) |
| `git add`, `git status`, `git diff` | ✅ allowed | (always) |
| `git commit` | 🛑 needs OK | "commit it", "stage and commit" |
| `git push` (any form) | 🛑 needs OK | "push it", "publish the branch" |
| `git fetch`, `git pull` | 🛑 needs OK | "sync with main", "pull latest" |
| `gh pr create`, `gh pr merge`, any `gh` write op | 🛑 needs OK | "open a PR", "merge the PR" |
| `git merge` into `main` (local or remote) | 🛑 needs OK | "merge into main" — prefer the PR review path |
| `git worktree remove` | 🛑 needs OK | "clean up the worktree" |
| Force-push, branch deletion, tagging, releasing | 🛑 needs OK | "force push", "delete the branch", "tag it" |

### How the user reviews Claude's work

While Claude is on a worktree branch, git locks that branch to its worktree — a second checkout of the same branch is refused. Two review paths:

| Path | When to use | Commands |
|---|---|---|
| Open the worktree directly in the IDE | Fastest — no git moves needed | `open /Users/<user>/Desktop/pulse-platform/.claude/worktrees/<codename>/apps/ios/PulseCoffeeApp.xcodeproj` |
| Publish, then check out in the main checkout | Standard PR-review flow | `git push -u origin <branch>` (Claude, on approval) → `cd <main checkout> && git fetch && git checkout <branch>` (user) |

### What "implementation is finished" does NOT mean

It does **not** mean "commit it." It does **not** mean "push it." Claude stops at:

1. Green local build.
2. Green local tests (relevant scope; full suite for risky changes).
3. Staged changes.
4. A printed commit message for review.

And waits for an explicit go-ahead before touching `git commit`, `git push`, or `gh`.

### Why these rules

- **Reviewability.** The user often inspects changes in Xcode / iOS Simulator / the dashboard / the database before allowing them to leave the machine.
- **Reversibility.** A push that needs iteration leaves a noisy branch on GitHub that has to be force-pushed or deleted. Local-first means the cleanup is `git restore .`, not `git push --delete origin`.
- **No surprise mutations.** `git fetch` / `git pull` can silently overwrite uncommitted local work; gating them behind explicit approval makes those moments deliberate.
- **`main` is sacred.** A personal-MVP demo for the founder depends on `main` being a known-good state at all times. Direct commits to `main` would erode that guarantee. Golden Rule #15 ("ship boring and reliable first") applies to source-control hygiene too.
