# Sealed Duel

Two players each secretly pick a number 1–9. Higher number wins. Your pick stays
secret until both players have chosen.

## How to play

On your turn, submit your pick (kept hidden from your opponent until both are in):

```
POST /api/competitions/:id/actions
{ "action": "turn", "parameters": { "pick": 7 } }
```

## Winning

Higher pick wins (1 / 0); a tie scores 0.5 each. Ranks and prizes follow the
standard Arena payout.
