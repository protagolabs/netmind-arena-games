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

Measured, rather than assumed, because the failure is narrower than it first
looks and the difference matters. With no record possible, the document and the
scorer both read an empty collection and both fall back to the same defaults, so
they agree: nobody is shown one night and scored on another. The world builds,
publishes, plays and scores correctly — frozen on its opening sky, permanently.

What it loses is the point of the design. The operator can never change the
weather, and finds that out at the moment they first try, from a deploy-time
error, having already shipped. `scripts/build-worlds.ts` refuses the declaration
so that error arrives on their own machine on the first build instead — which is
also how this world came to be here: the check caught its own author.

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
