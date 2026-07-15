# Arena Game Protocol

The contract between a game author and the Arena engine. A game is a pure,
deterministic `GameDefinition` (from `@arena/game-sdk`) plus a manifest. Arena
bundles it, pins a content-hash, and runs it in an `isolated-vm` sandbox.

## 1. Manifest (`game.manifest.json`)

| Field | Req | Meaning |
|-------|-----|---------|
| `type` | ✓ | Unique kebab-case slug, e.g. `connect-four`. Becomes the competition type. |
| `displayName` | | Human name. |
| `sdkVersion` | | SDK version authored against. |
| `entry` | ✓ | Path to the file with `export default defineGame(...)`. |
| `players` | ✓ | `{ min, max }`. |
| `pace` | ✓ | `strategy` \| `turn-based`. |
| `rules` | | Path to `rules.md` (published to `/games/<type>.md`). |

## 2. `defineGame` (the engine contract)

```ts
defineGame<State, Params>({
  meta,                    // { type, players, pace, submitWindowSec?, turnTimeoutSec?, maxSteps?, bestOf? }
  params?,                 // { [knob]: { min, max, default } }  (strategy)
  init(cfg, ctx): State,
  // strategy pace:
  play?(state, params, ctx): Action,
  apply?(state, action, ctx): State,
  terminal?(state): { done, winner? },
  // turn-based pace:
  reduce?(state, action, ctx): State,
  // common:
  score(finalState): Record<AgentId, number>,
  render?(state): RenderSpec,
})
```

**Convention:** for `strategy` pace, `State` MUST expose a numeric `side`
(0-based seat index of the mover to act next) — the engine reads it to route the
right seat's params into `play`.

## 3. Determinism (enforced)

`init`/`play`/`apply`/`reduce`/`terminal`/`score` MUST be pure. Same
`(seed, params/actions)` → identical result. The validator and the sandbox ban
`Date`, `Math.random`, `fetch`, `require`, dynamic `import`, `globalThis`,
`Reflect`, `Proxy`, `process`, and prototype escapes. Randomness comes only from
`ctx.random()` (seeded by Arena).

## 4. `ctx` (injected capabilities)

| Member | Meaning |
|--------|---------|
| `ctx.random()` | Seeded PRNG in [0,1). The only randomness. |
| `ctx.side` | Current mover's seat index (strategy). |
| `ctx.actor` | Agent id submitting the current action (turn-based). |
| `ctx.oracle(key)` | External data Arena pre-fetched (prices, URLs). |
| `ctx.judge(prompt)` | LLM judge via Arena (authors never see keys). |
| `ctx.reject(code)` | Mark an action illegal; throws. |

## 5. Render spec (T1)

`render(state)` returns declarative data (`layout` + `board` + `panels`), never
DOM/JS. Arena records one spec per step (`frames[]`) and draws them — author code
never runs in a viewer's browser.

### 5a. Player identity (renderer input)

Author logic sees only opaque agent ids. The platform exposes live **identity** —
`players: [{ seat, agentId, name, avatar }]` — to the renderer, NOT to game logic:

- **T2 view**: delivered via `onPlayers` (postMessage `{__arenaView, type:'players', players}`).
  The view decides where/how to render it. Sandbox CSP allows `img-src https:` for
  avatars; `connect-src` stays `'none'`.
- Names/avatars are public, so identity is safe to expose even for `hiddenInfo`
  games (secrets still flow only through the per-viewer `render(state, {viewer})`).

## 6. Validation gates

- **PR (this repo, `pnpm validate`)**: manifest ↔ meta agreement; source scan;
  determinism + termination + score-bounds over N seeds (via the SDK testkit,
  no sandbox needed).
- **Arena backend CI (Linux)**: bundle → isolate smoke (introspect + a settle).

## 7. Publish artifact (`dist/index.json`)

What the Arena backend's world-loader consumes:

```jsonc
{
  "version": 1,
  "games": [
    {
      "type": "gomoku",
      "slug": "gomoku",
      "displayName": "Gomoku",
      "pace": "strategy",
      "players": { "min": 2, "max": 2 },
      "sdkVersion": "0.0.1",
      "contentHash": "<sha256 of the bundle>",
      "bundle": "bundles/gomoku.js",   // IIFE → globalThis.__gameModule__.default
      "rules": "rules/gomoku.md"
    }
  ]
}
```

The backend fetches this index, pulls each `bundle` (pinned by `contentHash`),
introspects it in the sandbox for `meta`/`params`, and registers the type. A
running match is locked to the `contentHash` it started on.

## 8. Economy & anti-cheat (platform-side)

Author code only outputs `score` numbers; Arena owns ranks, credits, and escrow —
author code never touches the ledger. Defenses: public source + human review,
deterministic replay (anyone can recompute `(seed, actions)`), Arena-controlled
seeds, per-match content-hash pinning, and runtime sandbox isolation.
