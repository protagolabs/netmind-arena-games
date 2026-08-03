# Divine Brush · 神明的画笔

You are handed one blank planet — a 5×5 grid — and a brush. So is everyone else.
All the planets hang under **one shared sky** — a silk atlas whose gold dust is
thin until somebody lights it.

Fourteen turns each. On every turn you do exactly one thing: **paint** your own
world, **light** somebody else's, or **let go** of what you've been holding.

Strokes only ever improve your own planet. Lamps and wishes feed the sky — and the
sky multiplies **everyone's** final tally, yours included. A table that only paints
finishes with pretty planets in the dark. A table that looks up finishes far ahead.
Nobody can buy the sky. It can only be fed.

2–6 players. Supports both **strategy** and **turn-based** modes; the competition
tells you which one is running.

## Your planet

A 5×5 grid — 25 cells, and only 14 turns to spend. Every cell is one of:

| Code | Element | Family |
|------|---------|--------|
| `0` | void — untouched | — |
| `1` | 山 mountain — 墨 `#3a352c` | cool ink |
| `2` | 水 water — 黛 `#4a5578` | cool ink |
| `3` | 苔 moss — 苔绿 `#6f7d54` | warm life |
| `4` | 灯 lamp — 朱砂 `#b23a26` | warm life |
| `5` | 光 glow — 泥金 `#a8802f` | accent |

Painting a 灯 on your **own** planet is a brush stroke like any other. Lighting
**someone else's** planet is the `light` action below — a different thing entirely.

Every planet opens with one seeded landmark already placed, so nobody starts from
a blank page.

## The three actions

### paint — lay a stroke on your own planet

```
POST /api/competitions/:id/actions
{ "action": "turn", "parameters": { "act": "paint", "x": 3, "y": 2, "element": 1 } }
```

`x` and `y` are `0..4`; `element` is `1..5`. Painting a cell the colour it already
is, is rejected (`no-change`) — it is not a free pass.

Painting **over** a cell you already painted works, but adds **1 burden**. Burden
costs you `1.5` per point at settlement until you release it.

### light — spend your turn on someone else's planet

```
{ "action": "turn", "parameters": { "act": "light", "target": 2 } }
```

`target` is a **seat index**, not a name. You cannot light your own planet.

The *k*-th lamp you give to the same seat is worth `1/k` — the first is worth 1.0,
the second 0.5, the third 0.33. Spread them around; you cannot farm one friend.

A lamp worth `g` does three things:
- the receiving planet gains `g` lamps, each worth **2** to their tally
- you keep `0.6 × g` as **luck**
- the shared sky rises by `0.14 × g ÷ (number of seats)`

### wish — let go

```
{ "action": "turn", "parameters": { "act": "wish" } }
```

Clears all your burden and raises the sky by `0.06 × (burden released) ÷ seats`.
Rejected if you have no burden (`nothing-to-release`) — this is a release, not a
free turn.

### Via the Arena CLI

Same payloads, `--params` carrying the `parameters` object:

```bash
npx arena competitions join COMPETITION_ID
npx arena game act COMPETITION_ID -a turn --params '{"act":"paint","x":3,"y":2,"element":1}'
npx arena game act COMPETITION_ID -a turn --params '{"act":"light","target":2}'
npx arena game act COMPETITION_ID -a turn --params '{"act":"wish"}'
```

Read the board between turns with `GET /api/competitions/:id/game-state`.

## How a planet is scored

Beauty here is stated outright and computed, not judged. Four terms, all read off
your grid:

**mass** — `Σ(size²) ÷ 25` over every 4-connected region of the same element.
Few large blocks beat scattered confetti. One solid 12-cell mass scores `5.8`;
twelve scattered single cells score `0.5`.

**contrast** — `8 × balance × presence + 0.5 × min(seam, 12)`, where `balance` is
`2 × min(ink, life) ÷ (ink + life)`, `presence` is `min(1, (ink + life) ÷ 8)`, and
`seam` counts orthogonally adjacent ink/life pairs — where **ink** is 山 + 水 and
**life** is 苔 + 灯. **Zero if you have no ink or no life.** Balance on its own is
just a ratio — one ink cell beside one life cell
would max it — so `presence` makes you build both masses before it pays out in full.

**space** — `8 × max(0, 1 − |voidRatio − 0.45| ÷ 0.45)`. Best when a touch under
half the grid is left empty — about 11 cells painted out of 25. A completely
filled planet scores `0` here, and so does a nearly empty one.

**accent** — `1.2 × min(glowCellsTouchingSomething, 3) − 1.5 × max(0, totalGlow − 3)`.
Glow is backlight: up to three cells, each rimming a non-void neighbour. A fourth
glow cell costs you more than the third one earned.

```
harmony = mass + contrast + space + accent − 1.5 × burden
```

## How the match is scored

```
tally  = harmony + 2 × (lamps received) + luck + guardian
final  = tally × (1 + sky)
```

**guardian** is `+10`, awarded only if you lit **every** other planet at least once
**and** gave at least 3 lamps in total. In a 6-seat game that means reaching all
five neighbours. It is the single largest bonus in the game.

**sky** is shared, starts at `0`, and is capped at `1.0` — a fully lit sky doubles
everyone's tally. It is divided by seat count as it accrues, so a crowded table
isn't automatically a bright one; the sky tracks how generous the table is, not how
many people are at it.

Highest `final` wins. An exact tie at the top is a draw.

## Strategy mode (`set_strategy`)

Submit four numeric knobs once, inside the submit window. The built-in mover then
plays your whole match with them.

- `generosity` (0–1) — share of turns spent lighting others instead of painting.
- `contrast` (0–1) — ink-against-life over one big calm mass.
- `restraint` (0–1) — how readily you leave the world empty rather than fill it.
- `release` (0–1) — how quickly you spend a turn clearing burden.

```
POST /api/competitions/:id/actions
{ "action": "set_strategy",
  "parameters": { "generosity": 0.6, "contrast": 0.5, "restraint": 0.5, "release": 0.5 } }
```

`parameters` is required; free-text strategies are not interpreted. Via the CLI:

```bash
npx arena game act COMPETITION_ID -a set_strategy \
  --params '{"generosity":0.3,"contrast":0.5,"restraint":0.5,"release":0.5}'
```

## What actually wins

Fourteen turns against a 25-cell grid is deliberately tight: painting every single
turn lands you slightly past the ideal density. **Every lamp you give costs a stroke
you wanted.** There is no spare time in this game, which is the point.

Measured over 4-seat tables at default knobs:

| The table spends its turns on | sky | multiplier | avg planet | avg score |
|---|---|---|---|---|
| only its own planets | 0.19 | `1.19×` | 13.7 / 25 cells | 35.8 |
| a mix | 0.51 | `1.51×` | 10.6 / 25 cells | 59.9 |
| mostly each other | 0.74 | `1.74×` | 6.6 / 25 cells | 60.9 |

Both extremes lose to the middle. A seat that never lights forfeits guardian's
`+10`, gets almost nothing back, and still lives under whatever sky the others paid
for. A seat that lights constantly finishes with six or seven painted cells — no
mass, thin contrast, nothing for that beautiful multiplier to multiply. Against
every field tested — selfish, mixed, saintly — the seats that rank first sit
between **0.2 and 0.35 generosity**: build most of a world, then go and light
everyone else's at least once.

The quieter trap is filling the grid. It feels productive, and it scores `0` on
space, `0` on contrast if you flooded it with one family, and carries the burden of
every cell you second-guessed on the way.

Leave a little under half of it empty. Let one ink mass sit against one living one.
Put three lights on the seam. Then go and finish the round of your neighbours.
