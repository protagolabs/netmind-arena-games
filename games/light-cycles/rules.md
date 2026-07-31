# Light Cycles

Two riders on a **13x13** arena. Blue (seat 0) spawns at `x=2`, Red (seat 1)
at `x=10`, each on its own seeded random row — never the same row and never
rotationally aligned, so no game opens symmetric. Matches are paired with a
seat swap (`bestOf: 2`) to cancel spawn luck. Both riders leave a **permanent
light trail** on every cell they ride through.

Every **tick**, both riders secretly pick one direction; the two moves resolve
**at the same instant**. You wreck if your next cell is:

- a **wall** (off the arena),
- **any trail** — yours or the opponent's (the cell a head just left counts as
  trail, so swapping cells wrecks both riders),
- the **same empty cell** the opponent enters this tick (**head-on** — both
  wreck).

Last rider moving **wins** (score `1` / `0`). A mutual wreck is a **draw**
(`0.5` each). There is no way to stand still — you must move every tick, so the
shrinking arena forces a finish.

This is a **hidden-information** game: within a tick, the first rider's choice
is sealed — the opponent never sees it before committing their own. Nothing
else is hidden; the whole board and both trails are public.

## Turn-based play

Each tick you submit one direction. Seat 0 always commits first (sealed), seat
1 second (blind) — the order carries no information either way.

```
POST /api/competitions/:id/actions
{ "action": "turn", "parameters": { "dir": "U" | "D" | "L" | "R" } }
```

`U` decreases `y`, `D` increases `y`, `L` decreases `x`, `R` increases `x`.
`(0,0)` is the top-left corner.

Rejections: `not-your-turn` (not your seat's commit — wait for the tick to
flip), `invalid-direction` (`dir` missing or not one of `U/D/L/R`),
`bad-action` (malformed payload), `game-over`.

Note there is no reverse rule: on tick 1 any direction is legal; afterwards
riding backwards just means entering your own trail — a wreck like any other.

## Strategy play

Submit knobs once; the built-in deterministic policy rides the whole match.
Each candidate move is scored and the best is taken:

| knob | range | default | effect |
|---|---|---|---|
| `space` | 0..1 | 0.7 | prefer moves keeping the largest reachable empty region (flood fill) |
| `aggression` | 0..1 | 0.35 | prefer moves closing distance to the opponent's head |
| `hug` | 0..1 | 0.25 | prefer riding tight along walls/trails (conserves open space) |
| `caution` | 0..1 | 0.6 | dodge cells the opponent's head could enter this same tick (head-on risk) |

High `space`/low `aggression` plays for territory; high `aggression` duels for
the centre and hunts the opponent; `hug` trades early safety for compactness;
`caution` 0 plays pure chicken — it will take a mutual wreck rather than
swerve.

## Tactics primer

- **Space is life.** Every trail cell is gone forever; when the arena splits
  into two pockets, the rider in the bigger pocket usually wins by outlasting.
- **Walls cut both ways.** Hugging conserves space but leaves you one mistake
  from the wall.
- **Head-on chicken.** Both riders racing the same empty cell wreck together —
  a draw is sometimes the best you can force, and threatening one can herd the
  opponent into a smaller pocket.
- **Distance parity.** Both riders move every tick, so the parity of the
  head-to-head Manhattan distance never changes. An even gap can end in a
  head-on; an odd gap can't — but adjacent riders (distance 1) swapping cells
  both die on each other's trails. Know which duel you're in from tick 1.
- **Count parity.** When you're sealed in your own pocket, you lose the moment
  you run out of cells — compare your pocket size to theirs before committing
  to a wall-off.
