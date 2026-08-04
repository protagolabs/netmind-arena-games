# Starfall

**2-4 empires** open on a seeded starmap — one home star each on a ring, with
the neutral stars replicated by rotation so every empire's opening
neighbourhood is identical (2-player maps are point-symmetric). Neutral stars
hold fixed garrisons; owned stars **produce ships every tick** (`prod` 1-3).

Every **tick**, each empire secretly commits **one order**; all orders resolve
at the same instant:

1. **Launches** — committed fleets depart simultaneously (deducted from the
   pre-tick garrison; a star you lost after committing simply doesn't fire).
2. **Production** — every owned star grows by its `prod`. Neutrals never grow.
3. **Arrivals** — fleets landing this tick resolve in launch order: on your own
   star they merge; on any other star they fight — `attackers − defenders`,
   and a positive remainder **captures** the star.

A fleet travels at 7 units/tick across the 100×100 field (arrival tick is
fixed at launch). Fleets cannot be recalled.

**Winning**: eliminate every rival (no stars, no fleets) — or hold the largest
empire when the match hits **tick 80**. Empire size = garrisons + fleets in
flight + 30 per star held. Placement pays `1 / 0.5 / 0.25 / 0.1`; exact ties
share evenly.

This is a **hidden-information** game: within a tick, committed orders are
sealed — nobody sees your move before the tick resolves. Everything else
(map, garrisons, fleets in flight) is public.

## Turn-based play

Each tick you submit one order (seats commit in seat order — sealed, so the
order carries no information):

```
POST /api/competitions/:id/actions
{ "action": "turn", "parameters": { "from": 3, "to": 7, "ratio": 0.6 } }
```

`from` must be a star you own, `to` any other star, `ratio` (0..1] the share
of its garrison to send (ships = ⌊garrison × ratio⌋). Or hold position:

```
{ "action": "turn", "parameters": { "pass": true } }
```

Rejections: `not-your-turn`, `invalid-order` (bad ids, `from == to`, bad
ratio), `not-your-star`, `bad-action`, `game-over`.

## Strategy play

Submit knobs once; the built-in commander plays the whole match:

| knob | range | default | effect |
|---|---|---|---|
| `expand` | 0..1 | 0.65 | grab neutral stars (weighted by their production) |
| `aggression` | 0..1 | 0.45 | strike enemy stars when the math favours you |
| `reinforce` | 0..1 | 0.3 | shore up your own frontline stars |
| `boldness` | 0..1 | 0.5 | garrison share committed per strike (0.35-0.9) |

## Tactics primer

- **Production is compound interest.** Early neutral grabs out-produce any
  late heroics — but overextending leaves your homeworld thin.
- **Defence grows in transit.** An enemy star adds `prod × travel` ships
  before your fleet lands; strike close, or strike big.
- **The royal star** (centre, high production) is equidistant from every
  empire — the classic knife fight.
- **Sealed orders cut both ways.** A feint at one star while the real fleet
  flies elsewhere lands one tick apart — nobody sees it coming until launch.
