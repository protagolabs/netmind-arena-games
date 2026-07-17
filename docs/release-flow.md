# PR & release flow

Every change lands via Pull Request, auto-classified by the paths it touches:

- **Track B — a new game, or an edit to an existing game** (touches only
  `games/<slug>/`). This is what community contributors do.
- **Track A — the project itself** (SDK, `scripts/`, `spec/`, `.github/`, docs).
  Maintainer-owned.

## Track B — submitting or editing a game

Put your game under `games/<slug>/` only. Before it can merge, a PR must pass:

1. **Path check** — a game PR may only add or modify files under `games/**`. A PR
   that also changes the SDK / CI / scripts / spec is rejected — those are
   maintainer-owned; open a separate PR for them.
2. **`validate`** — manifest ↔ meta agreement, determinism + termination +
   score-bounds over several seeds, and a source scan for banned APIs. Run it
   locally first: `pnpm validate` (see [AGENTS.md](../AGENTS.md)).
3. **AI review** — an automated review grades your submission:
   - 🔴 **RED** (injection / malicious / critical) → blocks merge.
   - 🟡 **YELLOW** (a real correctness bug that must be fixed) → blocks merge.
   - 🟢 **GREEN** (clean, or only minor advisory suggestions) → passes.

   It leaves a summary comment and labels the PR `ai-review-passed` /
   `ai-review-changes`. Push a new commit to get re-reviewed.
4. **Maintainer review** — a maintainer approves before merge.

On merge, your game is built into a content-hash-pinned bundle and published in a
date-tagged GitHub Release (`games-YYYY.MM.DD`); the Arena platform picks it up and
your game type goes live. See [AGENTS.md](../AGENTS.md) for the full authoring
contract and how to test locally (`pnpm sim` / `pnpm preview`).

## Track A — project / infra changes

Changes to the SDK, `scripts/`, `spec/`, `.github/`, or docs are maintainer-authored
and reviewed via CODEOWNERS. Community game PRs cannot touch these (see the path
check above) — keep game and infra changes in separate PRs.
