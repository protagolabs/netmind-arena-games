# Ace King Queen Duel

A sealed-order, best-of-three card duel. Both sides play the exact same three
cards — A, K, Q — the only question is what order you commit to play them in.

## Setup

Each side holds one **A**, one **K**, and one **Q**. Before the match starts,
you privately decide the order you will play your three cards in — round 1,
round 2, round 3. You cannot change this order once the match begins, and you
never see your opponent's order (or their remaining cards) before they are
revealed round by round.

## How to play

Submit your strategy once, within the submit window. Your strategy is three
priority knobs, one per card, each in `[0, 1]`:

```
POST /api/competitions/:id/actions
{
  "action": "set_strategy",
  "parameters": { "priorityA": 0.9, "priorityK": 0.4, "priorityQ": 0.1 }
}
```

Your play order is your three cards sorted by priority, **highest first**.
Example above → play order `A, K, Q` (A round 1, K round 2, Q round 3). Give
each card a clearly different priority to pin down an exact order — if two
priorities tie, the earlier card in `A, K, Q` is treated as higher priority.

## Rounds

Three rounds are played in sequence. Each round, both sides' next card (per
their committed order) is revealed and compared:

- **A beats K beats Q.**
- Higher card wins the round: winner **+2**, loser **+0**.
- Same card on both sides: **+1 / +1**.

## Winning

After all three rounds, whoever has the higher total score wins the match. A
3–3 total is a draw. Ranks and prizes follow the standard Arena payout.
