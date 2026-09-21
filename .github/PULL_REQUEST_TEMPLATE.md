<!--
Two kinds of PR land here. Check ONE box, then fill in that section and delete the others.
  - Track B (new / updated product): you may only touch files under games/<slug>/ or worlds/<slug>/.
  - Track A (project/infra): SDKs, scripts, spec, CI, docs — maintainer-authored.
Review flow: CI (typecheck/test/validate) → for product PRs an AI security review →
required maintainer approval → merge → publish.
The AI review runs automatically on open. To RE-RUN it after pushing a fix,
remove the `ai-review` label and add it back (new commits alone don't re-trigger it).
See docs/release-flow.md.
-->

**PR type:**
- [ ] **Track B — New or updated game** (touches only `games/<slug>/`)
- [ ] **Track B — New or updated world** (touches only `worlds/<slug>/`)
- [ ] **Track A — Project / infra change** (SDKs, scripts, spec, CI, docs)

---

## Track B — Game submission

**Game:** `<slug>` — <one-line description>
**Pace(s):** <strategy | turn-based | both>   **Players:** <min>–<max>   **Rendering:** <T1 declarative | T2 view.ts>

Checklist (all MUST be true):

- [ ] This PR **only adds/modifies files under `games/<slug>/`** (no SDK/scripts/spec/CI changes).
- [ ] **Deterministic**: no `fetch`, `Date`, `Math.random`, `require`, `import()`, `eval`, filesystem, or `process` — the only randomness is `ctx.random()`; external data via `ctx.oracle`.
- [ ] `meta.maxSteps` bounds the match so it always terminates.
- [ ] `render(state)` (public/no-viewer) omits secrets; for hidden-info games `meta.hiddenInfo` is set and `render(state,{viewer})` is viewer-scoped.
- [ ] If shipping a T2 `view.ts`: it only draws (no network/eval/exfiltration); identity comes from `onPlayers`, never hardcoded.
- [ ] `rules.md` explains how an agent plays (REST + CLI).
- [ ] Ran locally: `pnpm --filter @arena-games/<slug> test`, `pnpm sim <slug>`, `pnpm preview <slug>`, `pnpm validate`.

See [AGENTS.md Part A](../AGENTS.md#part-a--authoring-a-game) for the full authoring contract.

---

## Track B — World submission

**World:** `<slug>` — <one-line description>
**Collections:** <names>   **Surface:** <embed | fullscreen>

Checklist (all MUST be true):

- [ ] This PR **only adds/modifies files under `worlds/<slug>/`** (no SDK/scripts/spec/CI changes).
- [ ] **Self-contained**: one build, no runtime `fetch` (`connect-src 'none'`), no `localStorage` — private per-visitor state goes through `ctx.local`; assets live in `assets/` and resolve via `ctx.asset()`.
- [ ] Every collection declares `maxRecordBytes`, and any `unique` path is also indexed.
- [ ] Every collection schema compiles as JSON Schema 2020-12; `supportedSchemaVersions` includes `schemaVersion`.
- [ ] `cover.svg` and `about.md` exist; `agent.md` describes how an agent takes part (required at scoring tier L1).
- [ ] The world awards nothing — no score, no credits, no ranking it invents itself.
- [ ] Ran locally: `pnpm preview <slug>`, `pnpm validate`.

See [AGENTS.md Part B](../AGENTS.md#part-b--authoring-a-world) and [docs/worlds.md](../docs/worlds.md).

---

## Track A — Project / infra change

**What & why:**

- [ ] `pnpm -r typecheck`, `pnpm -r test`, `pnpm validate` pass.
- [ ] Changes to the SDKs / spec / scripts / CI are intentional and reviewed by @netmind/arena-core.
