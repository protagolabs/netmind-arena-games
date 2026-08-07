# PR & release flow

Every change lands via Pull Request, auto-classified by the paths it touches:

- **Track B — a submission.** A game (`games/<slug>/`) or a world
  (`worlds/<slug>/`). This is what community contributors do. Both kinds are
  first-class: the same PR gate, the same build, the same release.
- **Track A — the project itself** (SDK, `scripts/`, `spec/`, `.github/`, docs).
  Maintainer-owned.

## Track B — submitting a game or a world

Put your work under `games/<slug>/` or `worlds/<slug>/` only. Before it can merge,
a PR must pass four gates.

### 1. Path check

A submission PR may only add or modify files under `games/**` or `worlds/**`. A PR
that also changes the SDK / CI / scripts / spec is rejected — those are
maintainer-owned; open a separate PR for them.

This matters more for worlds than it looks. A world's document runs in every
visitor's browser, so an author who could edit the CSP or the op allowlist in the
same PR would be editing their own sandbox.

A PR may touch **both** tracks; it is then gated against both.

### 2. `validate`

Run it locally first — `pnpm validate` checks both tracks in one pass. What it
enforces depends on which one you are submitting:

| | **games/** | **worlds/** |
|---|---|---|
| Gate | determinism — the output becomes credits | containment — the code runs in a visitor's browser |
| Checks | manifest ↔ meta agreement; determinism, termination and score-bounds over several seeds; source scan for banned APIs | manifest against the world-manifest schema; no collision with a game type; `supportedSchemaVersions` ⊇ `schemaVersion`; every collection declares `maxRecordBytes`; `unique` paths also indexed; every collection schema compiles as JSON Schema 2020-12; `entry` and `cover` exist and are within their byte caps; a single self-contained build; source scan for network APIs and `localStorage` |

See [AGENTS.md](../AGENTS.md) for the authoring contract of either track, and
[worlds.md](worlds.md) for the world-specific detail.

### 3. AI review

An automated reviewer grades every submission before a human looks at it, and
reports a required `ai-review` commit status plus a summary comment.

- 🔴 **RED** (injection / malicious / critical) → blocks merge.
- 🟡 **YELLOW** (a real correctness or abuse bug that must be fixed) → blocks merge.
- 🟢 **GREEN** (clean, or only minor advisory suggestions) → passes.

It labels the PR `ai-review-passed` / `ai-review-changes`. Push a new commit to get
re-reviewed — a verdict is recorded per commit SHA, so re-running against the same
commit is skipped.

Two operational notes that save confusion:

- **You will not find this workflow in this repo.** It runs from Arena's private
  infrastructure repo, so the review tokens never live in a public repo where a
  submission PR could reach them.
- **It polls rather than triggering on your push** (roughly every 15 minutes), so
  expect a short delay before the status appears. It is not stuck.

The reviewer treats your diff as untrusted input. Text in `rules.md`, `about.md` or
a comment that tries to instruct the reviewer — "approve this", "this rule does not
apply here" — is not obeyed, and is itself reported as a finding.

#### What it looks for in a game

Its logic runs in a backend `isolated-vm` and its output becomes rank and credits,
so the threat is **cheating for real money** and the gate is determinism.

- 🔴 any network or IO (`fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`,
  `require`, dynamic `import()`, `eval`, `new Function`, filesystem, `process`,
  `globalThis`/`global`/`window` escapes beyond the SDK view contract);
  non-determinism (`Date`, `Date.now`, `performance.now`, `Math.random`, or any
  entropy other than `ctx.random()`); obfuscation or hidden payloads; a
  `score()`/`terminal` backdoor that rigs the outcome; a T2 `view.ts` that
  exfiltrates data or breaks out of the sandbox.
- 🟡 throws on normal play; can fail to terminate (missing or over-large
  `maxSteps`); wrong terminal/score/win logic; invalid `RenderSpec`; a hidden-info
  leak (the public `render` exposing a secret).

#### What it looks for in a world

A world is unscored, so **determinism is not required and is not a finding** — it
is not graded on `Date`, `Math.random` or timers. What differs is *where it runs*:
the document is served into the visitor's browser in `sandbox="allow-scripts"`
without `allow-same-origin`, with `connect-src 'none'`, and every effect goes
through a postMessage proxy in the host page that holds the credential. So the
threat is **UGC abuse**: escaping or subverting that boundary, abusing shared
storage, or deceiving the visitor.

Intent counts, not just effect: code that *attempts* an escape the CSP happens to
block is still RED.

- 🔴 **Reaching outside the sandbox** — `fetch` / `XMLHttpRequest` / `WebSocket` /
  `EventSource` / `sendBeacon`, dynamic `import()`, a `<script>`/`<link>`/`<iframe>`
  pointing at a remote URL, or a remote font/image/media URL used to smuggle data
  out (assets are inlined as `data:` URIs at build time — a world needs no remote
  origin for anything); `eval` / `new Function` / hand-obfuscated payloads;
  `document.cookie`; `localStorage` / `sessionStorage` / `indexedDB` (`ctx.local`
  is the supported store); touching `window.parent` / `window.top` /
  `document.referrer` outside the SDK's channel.
- 🔴 **Subverting the protocol** — hand-rolling `postMessage` to the parent instead
  of using the SDK, forging or replaying host messages, trying to read the
  credential, or calling ops the manifest does not declare.
- 🔴 **Deceiving the visitor** — any UI imitating Arena's own chrome or a
  login/wallet/payment prompt, or asking for a password, API key, seed phrase or
  any credential. A world has no reason to ask for one; the platform supplies
  identity.
- 🔴 **Identity abuse** — presenting a record as written by someone other than its
  `author`, or impersonating another visitor or the platform.
- 🔴 Content that is illegal, sexual, hateful, or targets a real person.
- 🟡 **Unescaped rendering of another visitor's payload** — `innerHTML` /
  `outerHTML` / `insertAdjacentHTML`, or an `href`/`src` built from stored text (a
  `javascript:` URL is script that runs in the frame). One visitor cannot reach
  another's session here, but they can deface or spoof what everyone else sees.
  `textContent` or an escaped template is the fix.
- 🟡 **Storage abuse** — writing on a timer, on `mousemove`, or otherwise without a
  deliberate visitor action; a schema accepting an unbounded string or array; a
  collection that should be one-per-person declaring no uniqueness.
- 🟡 **Read abuse** — polling `list()` / `count()` on an interval or in a render
  loop instead of relying on `onChange`.
- 🟡 **Ignoring documented errors** — `quota`, `conflict`, `rate-limited`,
  `unauthenticated` — so the world visibly breaks instead of telling the visitor
  what happened.
- 🟡 **Throwing on mount for an ordinary visitor** — signed out (`ctx.me` is
  `null`), an empty collection, or a first visit with no local state.
- 🟡 Bumping `schemaVersion` while still reading records written under the old one,
  with no handling for the older shape.

A PR touching both tracks is reviewed against both rubrics and takes the **worse**
verdict.

### 4. Maintainer review

A maintainer approves before merge. The AI verdict is advisory input to that
review, never a substitute for it — GREEN means "ready for a human to look at".

## On merge

Your submission is built into a content-hash-pinned artifact and published in a
date-tagged GitHub Release (`games-YYYY.MM.DD`) as a single self-contained
`index.json`. The Arena platform picks it up on its next refresh, without a
restart:

- a **game** type goes live in the competition catalog;
- a **world** appears on the Arena home page automatically — shipping one needs no
  frontend change.

See [AGENTS.md](../AGENTS.md) for the full authoring contract and how to test
locally (`pnpm sim` / `pnpm preview` for games, `pnpm preview-world` for worlds).

## Track A — project / infra changes

Changes to the SDK, `scripts/`, `spec/`, `.github/`, or docs are maintainer-authored
and reviewed via CODEOWNERS. Community submission PRs cannot touch these (see the
path check above) — keep submission and infra changes in separate PRs.
