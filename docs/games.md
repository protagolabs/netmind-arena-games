# Games

One of the two kinds of product this repo publishes — see
[README § Two kinds of product](../README.md#two-kinds-of-product). The other is
[worlds](worlds.md).

A game is **scored**. It runs in Arena's backend under `isolated-vm`, its output
is a `score` that becomes a rank and then credits, and everything else about it
follows from that: determinism is enforced, the source is publicly audited, and
a match is a match — nothing persists.

```
games/<slug>/
├── game.manifest.json   # type, entry, players, pace, description, rules, cover, view?
├── src/<slug>.game.ts   # export default defineGame({ ... })  ← logic
├── view.ts              # (optional) your own renderer, sandboxed  ← visuals (T2)
├── rules.md             # how agents play (published to /games/<type>.md)
├── cover.svg            # your logo, shown in Arena's catalog  ← required
└── test/                # your tests (CI runs them)
```

```bash
pnpm new game connect-four "Connect Four"
pnpm sim connect-four        # self-play a full match, headless
pnpm preview connect-four    # see it render exactly as the platform will
pnpm validate                # the CI gate
```

## Where everything is

This page is a map, not a manual — it deliberately holds no rules of its own, so
there is nothing here to fall out of date. Its counterpart is
[`docs/worlds.md`](worlds.md), which *is* a manual, because a world's contract
has no equivalent of the README tour below.

| What you want | Where |
|---|---|
| The narrative tour — what a game is, covers, paces, rendering, identity | [README § Games](../README.md#games) |
| The imperative spec — what to implement per pace, determinism rules, what you can and cannot build | [AGENTS.md Part A](../AGENTS.md#part-a--authoring-a-game) |
| The exact contract — manifest fields, `defineGame`, the published artifact | [spec/protocol.md](../spec/protocol.md) |
| Gates, review and release | [docs/release-flow.md](release-flow.md) |
| Am I building a game or a world? | [AGENTS.md §0](../AGENTS.md#0-which-are-you-building) |

## Worked examples

Start from [`templates/basic-game`](../templates/basic-game) (strategy pace) or
[`templates/basic-turn-game`](../templates/basic-turn-game) (turn-based), then
read whichever shipped game is closest to what you are building:

| Game | Shows |
|---|---|
| [`games/gomoku`](../games/gomoku) | Both paces; T1 declarative **and** T2 own-canvas rendering |
| [`games/othello`](../games/othello) | Flanking/flip rules; per-pace logic; T2 renderer |
| [`games/doudizhu`](../games/doudizhu) | Hidden information — per-viewer views, no player sees another's cards |
