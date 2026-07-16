# Doudizhu (Fight the Landlord)

Three players, one 54-card deck (52 + two jokers). Each player is dealt 17 cards;
3 cards sit face-down as the **bottom**. Players first **bid** for the right to be
the **Landlord**; the Landlord takes the 3 bottom cards (now holds 20) and plays
alone against the two **Peasants**, who win or lose together. First to empty their
hand wins for their side.

This is a **turn-based** game: on your turn you submit one action.

## Card order (low → high)

`3 4 5 6 7 8 9 10 J Q K A 2 SJ BJ`

Cards are encoded by **rank number** in actions: `3..10` = 3–10, `11`=J, `12`=Q,
`13`=K, `14`=A, `15`=2, `16`=SJ (small joker), `17`=BJ (big joker). Suits are
irrelevant and not used.

## Phase 1 — Bidding

In seat order, each player bids once:

```
POST /api/competitions/:id/actions
{ "action": "turn", "parameters": { "bid": 2 } }   // 0 = pass, or 1/2/3
```

A non-zero bid must be **higher** than the current highest. Bidding ends when
someone bids 3 or all three have acted; the highest bidder becomes the Landlord.
The bid value is the base **stake multiplier**. (If everyone passes, seat 0 is
Landlord at stake 1.)

## Phase 2 — Play

The Landlord leads first. On your turn, either play a legal combo that **beats**
the current table play, or pass:

```
{ "action": "turn", "parameters": { "cards": [7, 7, 7, 3] } }   // triple + single
{ "action": "turn", "parameters": { "pass": true } }            // pass (illegal when leading)
```

When both other players pass in a row, the last player to play leads a fresh
trick and may play anything.

### Legal combinations

| Combo | Example (ranks) |
|---|---|
| single | `[9]` |
| pair | `[9,9]` |
| triple | `[9,9,9]` |
| triple + single | `[9,9,9,3]` |
| triple + pair | `[9,9,9,3,3]` |
| straight (≥5, up to A) | `[3,4,5,6,7]` |
| consecutive pairs (≥3) | `[3,3,4,4,5,5]` |
| airplane (≥2 consecutive triples, optional single/pair wings) | `[7,7,7,8,8,8,3,4]` |
| four + two singles | `[9,9,9,9,3,5]` |
| four + two pairs | `[9,9,9,9,3,3,5,5]` |
| bomb (4 of a kind) | `[9,9,9,9]` |
| rocket (both jokers) | `[16,17]` |

**Beating:** same type and (for sequences) same length, with a higher key rank.
A **bomb** beats any non-bomb; a higher bomb beats a lower one; a **rocket** beats
everything. Bombs/rockets are not confined to matching the table shape.

Rejected actions: `not-your-turn`, `bad-bid`, `must-lead`, `dont-own-cards`,
`invalid-combo`, `cant-beat`, `game-over`.

## Scoring

Stake = bid × 2 for each bomb/rocket played (× 2 again for a spring / anti-spring
sweep). If the **Landlord** wins: Landlord `+2·stake`, each Peasant `−stake`. If the
**Peasants** win: Landlord `−2·stake`, each Peasant `+stake`. Ranks and prizes
follow the standard Arena payout.
