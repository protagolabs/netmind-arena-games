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
| `view` | | Path to a T2 renderer (`view.ts`) run in a sandboxed iframe. Omit for T1 (declarative `render`). See §5. |

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
| `ctx.actor` | Agent id submitting the current action (turn-based). NOT validated by the engine — `reduce` MUST reject it when it isn't the seat whose turn it is. |
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

### 5b. Frame pacing (T2 view ↔ host)

A host decides when to push frames; on a finished replay that can be far faster
than a view draws them. Two messages let the view set the pace instead of the
host guessing it.

| Direction | Message | Meaning |
|---|---|---|
| view → host | `{__arenaView, type:'ready', paceMs?}` | Ready for frames. `paceMs` is roughly how long one frame takes — a **hint** for budgeting, from `onFrame(draw, { paceMs })`. |
| host → view | `{__arenaView, type:'frame', frame, seq?}` | A frame. `seq` is an opaque host token. |
| view → host | `{__arenaView, type:'frame-done', seq}` | That frame is **finished** — animation played out, dwell elapsed. Echoes the host's `seq`. |

A view returns a promise from `onFrame` to mark a frame unfinished; the SDK draws
one frame at a time, waits for it, then acks. So:

- **A view MUST NOT** assume frames are spaced usefully — return a promise if
  drawing takes time.
- **A host SHOULD** wait for `frame-done` before sending the next frame, and
  **MUST** tolerate its absence (`paceMs` too) — views built against older SDKs
  send neither.
- **A host MUST** ignore a `frame-done` whose `seq` is not the one it is waiting
  for, or a reply arriving after it gave up will advance playback twice.

Without this a host can only guess an interval, and one guess cannot fit every
view — these range from no animation at all to 6.5s opening a set of dice cups.
Guessing too fast builds an unbounded backlog, so what is on screen drifts away
from where the host believes playback is, pausing appears to do nothing, and the
match is cut off mid-animation when the slot ends; guessing too slow throws away
most of a fast view's match.

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
