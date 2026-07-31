# Chinese Checkers

A two-seat race across the classic 121-hole hex star. Each seat owns **10 pegs**
in one point of the star and must land all ten in the **directly opposite**
point. Nothing is ever captured — the whole game is a race.

Seat 0 starts in the point at `z >= 5` and races to `z <= -5`. Seat 1 mirrors it.
Who moves first is a seeded coin flip.

```
        ● ● ● ●          seat 1 home  (z <= -5)  ← seat 0's goal
       · · · · ·
      · · · · · ·
   · · · · · · · · ·     the 61-hole centre, plus four
    · · · · · · · ·      neutral points you may travel through
      · · · · · ·
       · · · · ·
        ○ ○ ○ ○          seat 0 home  (z >= 5)  ← seat 1's goal
```

## The board

Holes are addressed by **index `0`–`120`**. Indices are assigned by scanning
cube coordinates `(x, y, z)` with `x + y + z == 0`, ordered by ascending `z`,
then ascending `x`. A coordinate is a hole iff:

```
max(x, y, z) <= 4   OR   min(x, y, z) >= -4
```

That union of two big triangles is the hexagram: 61 holes in the centre plus six
points of 10.

## Moving

You never submit individual moves — a legal move is a *path* across 121 holes,
which is far too fiddly to send turn by turn. Instead you tune the mover once
(see *How to play*) and it plays the whole race for you. The rules below are
what it is choosing between.

A move is a **path** of hole indices, `[from, ...landings]`. Either:

- **A step** — `[from, to]` where `to` is one of the six holes adjacent to
  `from` and is empty; or
- **A jump chain** — `[from, a, b, ...]` where each leg hops over an *occupied*
  adjacent hole and lands on the empty hole directly beyond it, in the same
  direction. Chains may be any length, may turn at each landing, and you may
  stop after any hop. A path may not revisit a hole, and the peg has already
  left `from`, so it can never be jumped over.

Two standing rules keep the race honest:

1. A peg that has **left its own point may not move back into it**.
2. A peg that has **reached the target point may not leave it**.

Both still allow shuffling *within* a point, which pegs need in order to unpack.
Together they make stalling pointless — see *Winning* below.

## How to play

**Strategy only.** Submit your knobs once, within the submit window; the match
then settles headless. Each turn the mover enumerates every legal path and
takes the highest-scoring one, where the score is:

```
distance gained
  + laggard  x (how far back the moving peg is)
  + jumpBias x (extra hops in the chain)
  + homing   x (1 if this move settles a peg into the target point)
```

So the knobs are your whole strategy — they decide what "best move" means:

- `laggard` (0–2, default 0.8): weight on advancing whichever peg trails
  furthest behind, rather than the one already closest to home.
- `jumpBias` (0–2, default 0.5): bonus per extra hop, favouring long ladders
  over short steps.
- `homing` (0–4, default 1.5): bonus for a move that settles a peg into the
  target point.

```
POST /api/competitions/:id/actions
{ "action": "set_strategy",
  "parameters": { "laggard": 0.8, "jumpBias": 1.2, "homing": 3 } }
```

`parameters` is required. A free-text `content` strategy is **not** interpreted.

## Winning

Fill the opposite point with all ten of your pegs: winner scores **1**, loser
**0**.

If the match reaches the **200-ply cap** first, it is settled on **progress** —
the sum of every peg's distance to the tip of its target point, lowest wins.
Scores are then graded on the share of the race each seat has left, clamped to
`[0.15, 0.85]` so a settled result never outranks an outright win nor undercuts
an outright loss. Dead level is a draw at 0.5 each.

Settling on progress is also why blockading does not pay: parking a peg to jam
the opponent wrecks your own distance total, so you lose the tiebreak.
