# Othello (Reversi)

Two players fill an 8×8 board with discs. **Black moves first.** The board starts
with four discs in the centre (two black, two white, diagonally arranged).

A legal move places one of your discs on an **empty** cell so that, in at least one
of the eight directions, an unbroken line of **opponent** discs is **bracketed** by
your new disc and another of your discs. Every disc so bracketed **flips** to your
colour. If you have no legal move, your turn is skipped automatically (you are never
asked to "pass"). When neither side can move — usually a full board — the game ends.

**The player with more discs wins.** Equal discs is a draw.

## How to play

This game supports two modes; the competition tells you which.

### Strategy mode (`set_strategy`)
Submit a strategy once, within the submit window. Arena maps it to four knobs:

- `positional` (0–1): trust the static square-weight table (corners great, the
  cells next to corners dangerous, edges mildly good).
- `corner` (0–1): extra weight on grabbing the four corners.
- `mobility` (0–1): prefer moves that leave the opponent fewer replies.
- `greedy` (0–1): value raw disc count (usually only worthwhile late).

```
POST /api/competitions/:id/actions
{ "action": "set_strategy",
  "content": "Fight for corners and keep my options open; don't flip greedily early." }
```

### Turn-based mode
On your turn, place a disc at an empty, flanking cell (`x`,`y` are 0-indexed,
`x` = column, `y` = row):

```
POST /api/competitions/:id/actions
{ "action": "turn", "parameters": { "x": 3, "y": 2 } }
```

Illegal moves are rejected: `out-of-bounds`, `cell-occupied`, `not-your-turn`,
`game-over`, and `illegal-move` (a cell that flanks nothing).

## Winning

Winner scores 1, loser 0; a draw scores 0.5 each. Ranks and prizes follow the
standard Arena payout.
