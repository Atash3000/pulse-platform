#!/usr/bin/env bash
# Pulse Coffee — Claude Code SessionStart hook.
#
# Prints a short, deterministic context block at the top of every new
# Claude Code session so the assistant (and the human) start oriented:
# current branch, HEAD, dirty state, sync-with-remote, recent commits,
# and a one-line Golden-Rules reminder.
#
# Wired in `.claude/settings.json` under `hooks.SessionStart`.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

# ---- Git state -------------------------------------------------------------
branch="$(git branch --show-current 2>/dev/null || echo '?')"
head_oneline="$(git log -1 --oneline 2>/dev/null || echo '?')"
dirty="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"

# Sync vs. upstream, if one is set.
ahead="?"
behind="?"
if git rev-parse --abbrev-ref --symbolic-full-name @{u} >/dev/null 2>&1; then
  ahead="$(git rev-list --count @{u}..HEAD 2>/dev/null || echo '?')"
  behind="$(git rev-list --count HEAD..@{u} 2>/dev/null || echo '?')"
fi

# Recent activity (last 3 commits on this branch).
recent="$(git log --oneline -3 2>/dev/null || echo '?')"

# ---- Output ----------------------------------------------------------------
cat <<EOF
## Session context (Pulse Coffee)

- **Branch:** \`${branch}\`
- **HEAD:** ${head_oneline}
- **Uncommitted files:** ${dirty}
- **Sync with remote:** ahead ${ahead}, behind ${behind}

**Recent commits:**
\`\`\`
${recent}
\`\`\`

**Reminders:**
- Read \`docs/decision-log.md\` end-to-end before any non-trivial code change (CLAUDE.md §1.1).
- Money is **integer cents only** (Golden Rule #7). Checkout is **sacred** (Golden Rule #2). Stripe webhook = payment truth (Golden Rule #3).
- One commit, one concern (CLAUDE.md §1.6). Push back when the prompt is wrong (CLAUDE.md §1.3).
EOF
