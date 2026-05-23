---
description: Create a GitHub issue and return a CLAUDE.md §7-compliant branch name to use for the work
argument-hint: <type>: <short title>
---

The user wants to start a new piece of tracked work. Create a GitHub issue and hand back the branch name they should use.

The input in `$ARGUMENTS` is expected to follow Conventional-Commit shape: `<type>: <short title>`. Examples:

- `feat: orders tab icon for iOS nav`
- `fix: stripe webhook double-process`
- `chore: bump nestjs to 11`
- `docs: onboarding readme`

Workflow:

1. **Parse the input.**
   - Split on the first `:`. Left side = type, right side = title.
   - Valid types per CLAUDE.md §7: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `ci`, `revert`.
   - If the input has no `:` separator, treat the whole thing as the title and default `type` to `feat`. Tell the user this so they can correct it.
   - If the type is unrecognized, stop and ask the user to pick a valid one. Do not create the issue.

2. **Create the GitHub issue.**
   - Run `gh issue create --title "<full input>" --body "<body>"` where body is:
     ```
     Tracking issue for branch <type>/<N>-<slug>.

     Created via /new-issue.
     ```
   - Capture the returned issue URL and parse the issue number from it.

3. **Compose the suggested branch name** per CLAUDE.md §7:
   - Take the title (right side of `:`), lowercase, replace non-alphanumerics with `-`, collapse repeated `-`, trim leading/trailing `-`, truncate at 40 chars.
   - Final shape: `<type>/<issue-number>-<slug>` (note: when scope IS the issue number, drop the second slash per the convention).
   - Example: input `feat: Orders tab icon for iOS nav` with returned issue #12 → `feat/12-orders-tab-icon-for-ios-nav`.

4. **Report back to the user** in this exact shape:
   ```
   ✅ Created issue #<N>: <URL>

   Recommended branch:   <type>/<N>-<slug>
   To start work:        git switch -c <type>/<N>-<slug>

   When you open the PR, reference `Closes #<N>` in the PR body so the
   issue auto-closes on merge.
   ```

Do NOT auto-create the branch. The user may want to finish thinking before they start work. Branch creation is their explicit next step.

Do NOT switch the working tree. Issues are independent of the working tree's current state.

If `gh issue create` fails (auth, rate-limit, network), report the actual error verbatim and stop. Do not fall back to creating the branch without an issue.
