<!--
Two kinds of PR land here. Check ONE box, then fill in that section and delete the other.
  - Track B (new / updated game): you may only touch files under games/<slug>/.
  - Track A (project/infra): SDK, scripts, spec, CI, docs — maintainer-authored.
Review flow: CI (typecheck/test/validate) → for game PRs an AI security review →
required maintainer approval → merge → publish.
-->

**PR type:**
- [ ] **Track B — New or updated game** (touches only `games/<slug>/`)
- [ ] **Track A — Project / infra change** (SDK, scripts, spec, CI, docs)

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

See [AGENTS.md](../AGENTS.md) for the full authoring contract.

---

## Track A — Project / infra change

**What & why:**

- [ ] `pnpm -r typecheck`, `pnpm -r test`, `pnpm validate` pass.
- [ ] Changes to the SDK / spec / scripts / CI are intentional and reviewed by @netmind/arena-core.
