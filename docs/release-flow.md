# Release & PR flow

Every change lands via Pull Request. There are two tracks, auto-distinguished by
the paths a PR touches.

```
                         ┌── touches only games/**  ──────────────→  Track B (game)
PR ── CI classifies by ──┤
     changed paths       └── touches anything outside games/ ──────→  Track A (project/infra)
```

## Track A — internal, project itself

SDK, `scripts/`, `spec/`, `.github/`, root config, docs.

1. `games-ci` runs `typecheck → test → validate`.
2. CODEOWNERS review: `@netmind/arena-core` owns `/packages/game-sdk`, `/spec`,
   `/scripts`, `/.github`; `@netmind/arena-maintainers` owns the rest.
3. Approve → merge. No AI review (trusted internal contributors).

## Track B — new game or edit a game (internal OR external)

Contributors (including external forks) submit under `games/<slug>/` only. Four
gates, all required before merge:

1. **`game-path-guard`** — the PR may only add/modify files under `games/**`. An
   external PR that also touches SDK/CI/scripts/spec **fails** (blocks sneaking an
   infra change into a game submission). Internal authors may mix, but CODEOWNERS
   still routes the infra parts to `@arena-core`.
2. **`games-ci` (`validate`)** — schema/meta agreement, determinism + termination
   + score-bounds over several seeds, and a **source scan** for banned APIs.
3. **`ai-review`** — Claude reviews the `games/**` diff and grades it into three
   tiers; it never executes the PR's code:
   - 🔴 **RED** (injection / malicious / critical) → status **failure**, blocks merge.
   - 🟡 **YELLOW** (a real correctness bug that must be fixed) → status **failure**, blocks merge.
   - 🟢 **GREEN** (clean, or only minor advisory suggestions) → status **success**.
   - The result is reflected on a **label** — `ai-review-passed` (GREEN) or
     `ai-review-changes` (RED/YELLOW) — so maintainers can see at a glance which
     PRs are ready for their review.
   - **This review runs in a separate PRIVATE repo** ([`arena-games-review`](https://github.com/protagolabs/arena-games-review)),
     NOT in this public repo, so the Claude/GitHub tokens are never stored here. It
     polls open PRs (~every 5 min) and reports the `ai-review` **commit status** +
     comment + label. Push a new commit to re-review (each head SHA is reviewed once).
4. **Human review** — a `@netmind/arena-maintainers` approval on `/games/`
   (required by branch protection, and only after the AI review is GREEN).

Merge → **`publish.yml`** builds `index.json` with every game's code/view/rules
**inlined** (one self-contained file), and cuts a **GitHub Release** whose sole
asset is that `index.json` (no AWS — just the built-in `GITHUB_TOKEN`; the release
page stays clean no matter how many games exist). The Arena backend loads the latest via
`ARENA_GAMES_INDEX=https://github.com/<owner>/<repo>/releases/latest/download/index.json`
and the type goes live on the next backend deploy/restart.

Publishing is deliberately quiet:

- **Path-filtered trigger** — only `games/**`, `packages/game-sdk/**`, or the build
  scripts changing can publish. Docs / CI / preview / test-tooling edits never do.
- **Content-hash gate** — after building, if no game's `contentHash` / view hash
  changed vs the latest release, the publish is **skipped** (so a game's test-only
  edit doesn't cut an empty release).
- **Date tags** — releases are `games-YYYY.MM.DD` (`.2`, `.3` for same-day), not
  build numbers; notes list the games + their content hashes. History + rollback
  come for free (pin `ARENA_GAMES_INDEX` to a specific tag's `download/` URL).

## Security model (why it's safe on a public repo)

- **No secrets live in this public repo.** The AI review (which needs a Claude
  token) runs in the private [`arena-games-review`](https://github.com/protagolabs/arena-games-review)
  repo and reports back only a commit status + comment. The PR's code is never
  executed; only the diff text is sent to Claude.
- `games-ci` (`validate`) runs the game logic, but on **`pull_request`** with **no
  secrets** on an ephemeral runner. `path-guard` uses only the default read-only token.
- PR content is treated as untrusted; the AI is a filter, a human maintainer is the
  final gate.

## One-time repo configuration (not in code)

- **AI review secrets live in the private [`arena-games-review`](https://github.com/protagolabs/arena-games-review) repo**, NOT here:
  `CLAUDE_CODE_OAUTH_TOKEN` + `ARENA_GAMES_TOKEN` (a token with PR/commit-status write
  on this repo). This public repo holds **no review secret**.
- **Publish**: nothing — `publish.yml` uses the built-in `GITHUB_TOKEN` to cut the
  Release (no AWS keys/bucket/CDN). Just point the **backend** at the Release:
  `ARENA_GAMES_INDEX=https://github.com/<owner>/<repo>/releases/latest/download/index.json`.
- **Teams**: `@netmind/arena-maintainers`, `@netmind/arena-core` must exist with the
  CODEOWNERS mappings.
- **Branch protection on `main`** (configured): required status checks `validate`,
  `path-guard`, `ai-review`; 1 approving review from Code Owners; dismiss stale
  approvals on new commits; require conversation resolution. Set via
  `PUT /repos/<owner>/<repo>/branches/main/protection`. With this in place the
  **Merge button stays disabled until all three checks are green AND a code owner
  approves** — the AI review (GREEN) gates before a human is asked to review.
- **Labels**: `ai-review-passed`, `ai-review-changes` (set by the external reviewer).
