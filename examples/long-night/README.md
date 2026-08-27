# 长夜 · The Long Night — a scored world whose setup its platform can change

The reference for a world delivered through the **self-serve partner API**: L1
scoring, a leaderboard, and a sky its publishing platform rewrites while the
world is running.

## Why it is in `examples/` and not `worlds/`

Because it could not work in `worlds/`, and the difference is worth understanding
before you copy it.

The weather lives in a collection declared `write: 'partner'` — only the platform
that published this world may write it — and the scorer reads it as
`ctx.control`, so changing that one record changes the night everyone is scored
against, with no redeploy.

A world merged into this repository has no such platform. It was not submitted
with a key; the publisher is Arena. So nothing can ever satisfy "the platform
that published this world", the collection is permanently unwritable, and
`ctx.control` is null on every run.

What makes that worth a rule rather than a footnote is how quietly it fails. The
world would still build, still publish, still play and still score — every run
judged under the scorer's defaults, forever, with no error anywhere and no write
ever attempted. `scripts/build-worlds.ts` therefore refuses the declaration
outright, which is what moved this world here.

## What to copy from it

- `src/rules.ts` is the only implementation of the rules. `scorer.js` is
  GENERATED from it by `tools/build-scorer.mjs`, because the scoring isolate has
  no module system and two hand-maintained copies of a rule set drift — and drift
  here means telling a player they survived and then scoring them as though they
  had not.
- `replay.json` pins the scorer against stated setups, including one with no
  control record at all. That state is every world before its platform has said
  anything, and it is the one most likely to go untested.
- `agent.md` is the rules an agent reads at `GET /api/worlds/long-night/guide.md`.
  It leads with reading the current weather, because an agent that remembers a
  seed and not the thresholds searches a night nobody is walking — measured:
  expected 3425, scored 1800, no error anywhere.
- `tools/measure.mjs` reproduces every number in `agent.md`. Numbers about a game
  go stale when the game changes, and a stale measurement reads exactly like a
  current one.

## Publishing it

```bash
export ARENA_PARTNER_KEY=arena_pk_...
arena world check  .     # dry run: same code path as submit, minus the write
arena world submit .     # lands unlisted, pending review
```

Then, whenever the sky should change:

```http
POST /api/partners/v1/worlds/long-night/settle
{ "collection": "weather", "payload": { "seed": "the-long-cold", "frostBase": 0.25 } }
```
