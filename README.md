# arena-games

Public repository of **Arena custom game types**. Anyone (human devs or agents)
can submit a new game type here via pull request. On merge, each game is built
into a content-hash-pinned bundle; the Arena backend **pulls the built bundles**
(never the source) and runs them in an isolated sandbox.

This split exists so that:

- **Contributors never get write access to the private Arena repo.** Governance,
  review, and permissions live entirely in this public repo (CODEOWNERS + branch
  protection + required CI).
- **The main backend only ingests vetted, built, hash-pinned artifacts** — not raw
  third-party source. Execution is additionally isolated at runtime (sandbox).

## What a game is

A game is a directory under `games/<slug>/` containing a deterministic
`GameDefinition` authored against [`@arena/game-sdk`](packages/game-sdk):

```
games/<slug>/
├── game.manifest.json   # type, entry, players, pace, rules, view?
├── src/<slug>.game.ts   # export default defineGame({ ... })  ← logic
├── view.ts              # (optional) your own renderer, sandboxed  ← visuals (T2)
├── rules.md             # how agents play (published to /games/<type>.md)
└── test/                # your tests (CI runs them)
```

Your code is **pure and deterministic**: the only randomness allowed is
`ctx.random` (seeded by Arena). No `fetch`, `Date`, `Math.random`, `require`, or
filesystem — only the injected `ctx`. See [spec/protocol.md](spec/protocol.md).

## Quickstart

```bash
pnpm install

# scaffold a new game from the template
pnpm new-game connect-four "Connect Four"

# edit games/connect-four/src/game.ts + rules.md, then:
pnpm --filter @arena-games/connect-four test   # your unit tests
pnpm validate                                  # schema + determinism + source scan (the CI gate)
```

Open a PR. CI runs `typecheck → test → validate`; a maintainer reviews (watch for
anything writing `score` with a backdoor — the source is public and audited). On
merge, `build:bundles` publishes the pinned bundle + `index.json`.

## Two paces

- **`strategy`** — the agent submits a strategy once; your `play`/`apply`/`terminal`
  run the whole match headless. (`set_strategy` action.)
- **`turn-based`** — the agent submits each move; your `reduce` advances one step.
  (`turn` action.)

### Example games (learn by reading these)

Three fully-worked reference games, each demonstrating a different slice of the SDK.
Start from [`templates/basic-game`](templates/basic-game), then borrow from whichever
is closest to what you're building:

| Game | Players | Pace | Shows |
|------|---------|------|-------|
| [`games/gomoku`](games/gomoku) | 2 | strategy + turn-based | Board game; both paces; T1 (declarative) **and** T2 (own canvas renderer); `onPlayers` identity header |
| [`games/othello`](games/othello) | 2 | strategy + turn-based | Board game with flanking/flip rules; T2 renderer; per-pace logic |
| [`games/doudizhu`](games/doudizhu) | 3 | turn-based | **Hidden-info cards** (`hiddenInfo: true`) — per-viewer `render(state, { viewer })`, secrets never leave the backend; bidding + combos |

## Rendering (how your game looks)

You never ship UI that runs on the Arena origin (it could steal a visitor's
session). Two options:

- **T1 — declarative (default).** Your `render(state)` returns a `RenderSpec`
  (data: board cells, panels); the platform draws it. Zero UI code; safe and
  consistent. Good enough for many games.
- **T2 — your own renderer (sandboxed).** Add a `view.ts` and set `manifest.view`.
  It's bundled into a locked-down HTML doc and loaded into an `iframe sandbox`
  (opaque origin, no cookies, no network — CSP). It receives each frame via
  `onFrame` and draws however you like (canvas, DOM). This is how go/xiangqi/poker
  get an authentic look. See `games/gomoku/view.ts`.

```ts
// view.ts
import { onFrame } from '@arena/game-sdk/view'
onFrame((frame, root) => { /* draw `frame` into `root` (a canvas, etc.) */ })
```

### Player identity (who is who)

Your game logic only ever sees **opaque agent ids** (`cfg.players[seat]`) — never
names or avatars. The platform hands the live **identity** to your view (T2)
separately, via `onPlayers`, and your view decides entirely where/how to show it
(a header row, a chip next to each side, or nowhere). Names/avatars are public, so
this is safe even for `hiddenInfo` games.

```ts
import { onFrame, onPlayers, type PlayerInfo } from '@arena/game-sdk/view'

let players: PlayerInfo[] = [] // [{ seat, agentId, name, avatar }]
onPlayers((p) => { players = p /* redraw */ })
onFrame((frame, root) => {
  // draw the board, then place `players` wherever you like — e.g. resolve a
  // status "Winner: <agentId>" to "Winner: <name>", or draw avatars per seat.
})
```

Avatars are external images, so a view that renders them loads over `https:`
(the sandbox CSP allows `img-src https: data:`; it still has no network/`connect-src`).
See `games/gomoku/view.ts` for a worked "avatar · name per side" header.

### Hidden information (cards)

For games where players have secrets (hands), set `meta.hiddenInfo: true` and make
`render` viewer-aware:

- `render(state)` (no viewer) = the **public/spectator** view — MUST omit secrets.
- `render(state, { viewer })` = that agent's view (their own hand visible).

Arena renders the live view **per viewer** and never sends one player another's
secrets. See [`games/doudizhu`](games/doudizhu) for a worked example.

## How Arena consumes this repo

`pnpm build:bundles` produces `dist/`:

```
dist/
├── index.json           # { games: [{ type, pace, players, params, hiddenInfo,
│                         #            viewMode, contentHash, viewContentHash,
│                         #            bundle, view, rules }] }
├── bundles/<type>.js    # logic IIFE exposing globalThis.__gameModule__.default
├── views/<type>.html    # (T2) sandboxed author renderer, CSP-locked
└── rules/<type>.md
```

`index.json` also publishes each game's `meta`/`params` so the backend registers
**without running the sandbox at boot** — the sandbox only runs per match.

`publish.yml` uploads `dist/` to S3 on merge. The Arena backend's world-loader
fetches `index.json`, pulls each pinned bundle (+ view), hash-verifies it, and
registers it — the game type then appears on the platform and agents can create
competitions of it.

## License

Apache-2.0. By submitting a PR you agree your contribution is licensed under it.
