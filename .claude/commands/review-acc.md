---
description: Accessibility review (iOS / SwiftUI) of a branch, PR, or git ref range — VoiceOver labels, Dynamic Type, WCAG contrast, tap targets, Reduce Motion. Read-only.
argument-hint: [pr-number | branch-name | git-ref-range | (empty = current branch vs main)]
---

Run an accessibility review of iOS UI changes. Invoke the `accessibility-reviewer` sub-agent and pass it the scope below. This is **review-only** — do NOT modify code unless I explicitly ask in a follow-up message.

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
   - List changed files. If none are in iOS-UI scope (no files under `apps/ios/PulseCoffeeApp/Features/**`, `PulseCoffeeApp.swift`, `ContentView.swift`, `Assets.xcassets/**`, or `Info.plist`), report *"No iOS UI files in scope"* and stop.

2. **DELEGATE TO THE SPECIALIST**
   - Hand the diff list + computed git range to the `accessibility-reviewer` sub-agent.
   - The sub-agent has its own protocol (read full files, scan for anti-patterns, tier findings, cite `file:line`, propose fixes). Don't second-guess its rules; it specializes in iOS/SwiftUI accessibility.

3. **RELAY THE REPORT**
   - Forward the sub-agent's structured report verbatim. Don't paraphrase tiered findings — those are calibrated.
   - Add one paragraph at the top that names the scope (PR / branch / range) and the resolved git diff command used. That makes the report reproducible.

4. **STOP HERE**
   - This command does not apply fixes. If I want fixes, I'll start a new turn with the specific findings I want addressed.
   - This command does not run the iOS test suite or build the app. Accessibility issues don't necessarily show up in compile errors or unit tests — that's why we have this specialist.

Notes:

- Hardcoded color contrast checks: compute the WCAG ratio from the actual hex. Don't eyeball.
- Tap-target checks: `.frame(width:height:)` < 44pt on any tappable element is a flag, even if the SF Symbol's intrinsic touch area looks bigger in Xcode preview.
- Dynamic Type: assume the user is on AX5 (the largest setting). If the layout would clip, that's a Critical finding, not a polish item.
- VoiceOver order: a `.accessibilityElement(children: .combine)` on a `HStack` that holds name+price is the cart-row default; flag rows that don't have it.
- Reduce Motion: any `withAnimation` block in a flow the user can't avoid (= not opt-in like a celebration) needs a Reduce Motion check.

If the diff also touches payment / checkout / Stripe paths, mention it in a footer — `payment-reviewer` may also want to look (different specialist, different rules; they're complementary, not overlapping).
