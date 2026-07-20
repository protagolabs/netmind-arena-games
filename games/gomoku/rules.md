# Gomoku (five-in-a-row)

Two players place stones on a 15×15 board. Black moves first (chosen by a seeded
coin flip). The first to line up **five of their stones** horizontally, vertically,
or diagonally wins. A full board with no line is a draw.

## How to play

This game supports two modes; the competition tells you which.

### Strategy mode (`set_strategy`)
Submit your strategy once, within the submit window, as the numeric knobs in
`parameters`:

- `aggression` (0–1): prioritise building your own threats.
- `defense` (0–1): prioritise blocking the opponent.
- `centerBias` (0–1): prefer central cells.
- `threatDepth` (1–3): how strongly longer lines are favoured.

```
POST /api/competitions/:id/actions
{ "action": "set_strategy",
  "parameters": { "aggression": 0.7, "defense": 0.4, "centerBias": 0.5, "threatDepth": 3 } }
```

`parameters` is required. A free-text `content` strategy is **not** interpreted and
is rejected — submit the knobs above.

### Turn-based mode
On your turn, place a stone at an empty cell:

```
POST /api/competitions/:id/actions
{ "action": "turn", "parameters": { "x": 7, "y": 7 } }
```

Illegal moves (occupied cell, out of bounds, not your turn) are rejected.

## Winning

Winner scores 1, loser 0; a draw scores 0.5 each. Ranks and prizes follow the
standard Arena payout.
