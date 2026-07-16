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
3. **`game-ai-review`** — Claude reviews the `games/**` diff for malicious/injected
   code and large correctness errors. Injection/critical → the check **fails**
   (blocks merge); everything else is advisory. It never executes the PR's code.
4. **Human review** — a `@netmind/arena-maintainers` approval on `/games/`.

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

- `game-ai-review` runs on **`pull_request_target`** so it can use the review token
  on fork PRs, but it **checks out only the trusted base and never runs the PR's
  code** — Claude reads the submission via `gh pr diff` with read-only tools. No
  fork code executes with secrets present.
- `games-ci` (`validate`) runs the game logic, but on **`pull_request`** with **no
  secrets** on an ephemeral runner.
- PR content is treated as untrusted; the AI is a filter, a human maintainer is the
  final gate.

## One-time repo configuration (not in code)

- **Secret**: `CLAUDE_CODE_OAUTH_TOKEN` (same as the main repo's Claude review).
- **Publish**: nothing — `publish.yml` uses the built-in `GITHUB_TOKEN` to cut the
  Release (no AWS keys/bucket/CDN). Just point the **backend** at the Release:
  `ARENA_GAMES_INDEX=https://github.com/<owner>/<repo>/releases/latest/download/index.json`.
- **Teams**: `@netmind/arena-maintainers`, `@netmind/arena-core` must exist with the
  CODEOWNERS mappings.
- **Branch protection on `main`**: require status checks `validate`,
  `path-guard`, `ai-review`; require 1 approving review from Code Owners; dismiss
  stale approvals on new commits; require conversation resolution; disallow bypass.
