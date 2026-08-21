// Deed & Dice — the authoritative rules.
//
// Runs on Arena's servers, never in the player's browser. The document simulates
// the same rules to draw the board, but that copy is advisory: whatever it shows,
// this is what counts. A player who edits their client can change what they SEE
// and what they SUBMIT — they cannot change this.
//
// Determinism is mandatory and enforced: Math.random and every clock read throw.
// The dice come from a seed derived from who is playing and which season it is,
// so a player can neither reroll for a kinder board nor copy someone whose board
// was the same.

var BOARD = [
  { t: 'go' },
  { t: 'prop', name: 'Tannery Row',   group: 'brown',  price: 60,  rent: 6 },
  { t: 'prop', name: 'Coal Wharf',    group: 'brown',  price: 60,  rent: 6 },
  { t: 'tax',  name: 'Excise',        amount: 75 },
  { t: 'prop', name: 'Glass Quarter', group: 'cyan',   price: 100, rent: 12 },
  { t: 'prop', name: 'Paper Mill',    group: 'cyan',   price: 100, rent: 12 },
  { t: 'chance' },
  { t: 'prop', name: 'Spice Dock',    group: 'pink',   price: 140, rent: 18 },
  { t: 'prop', name: 'Salt House',    group: 'pink',   price: 140, rent: 18 },
  { t: 'tax',  name: 'Harbour Due',   amount: 100 },
  { t: 'prop', name: 'Iron Yard',     group: 'orange', price: 180, rent: 24 },
  { t: 'prop', name: 'Rope Walk',     group: 'orange', price: 180, rent: 24 },
  { t: 'chance' },
  { t: 'prop', name: 'Clock Tower',   group: 'red',    price: 220, rent: 32 },
  { t: 'prop', name: 'Mint Street',   group: 'red',    price: 220, rent: 32 },
  { t: 'tax',  name: 'Levy',          amount: 125 },
  { t: 'prop', name: 'Observatory',   group: 'blue',   price: 300, rent: 45 },
  { t: 'prop', name: 'Cathedral Hill',group: 'blue',   price: 300, rent: 45 },
  { t: 'chance' },
  { t: 'prop', name: 'The Exchange',  group: 'gold',   price: 400, rent: 70 }
]

var GROUP_SIZE = { brown: 2, cyan: 2, pink: 2, orange: 2, red: 2, blue: 2, gold: 1 }
var RESALE = 0.5
var START_CASH = 1500
var PASS_GO = 200
var TURNS = 30
var GROUP_BONUS = 400
var CHANCE = [80, -60, 150, -110, 40, -30]

// A 32-bit string hash, so the seed is a pure function of who and when. Chosen
// over anything cryptographic because it has to be reproduced exactly by the
// browser copy of these rules, in plain JS, with no library.
function seedFrom(text) {
  var h = 2166136261
  for (var i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}

function rng(seed) {
  var a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    var t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Replay a run and return the final net worth.
 *
 * `decisions` is consumed in order, one per landing on an unowned property. A
 * decision list that runs out is treated as "pass" from there on rather than as
 * an error: a run is a plan, and a plan that stops early is a player who stopped
 * buying, not a malformed submission.
 */
function score(submission, ctx) {
  var decisions = (submission && submission.decisions) || []
  if (!Array.isArray(decisions)) ctx.reject('decisions must be an array')
  if (decisions.length > TURNS) ctx.reject('more decisions than there are turns')
  for (var d = 0; d < decisions.length; d++) {
    if (decisions[d] !== 'buy' && decisions[d] !== 'pass') {
      ctx.reject('decision ' + d + ' must be "buy" or "pass"')
    }
  }

  var roll = rng(seedFrom(ctx.seasonKey + ':' + ctx.authorId))
  var cash = START_CASH
  var owned = {}
  var pos = 0
  var next = 0

  for (var turn = 0; turn < TURNS; turn++) {
    var step = 1 + Math.floor(roll() * 6) + 1 + Math.floor(roll() * 6)
    var moved = pos + step
    if (moved >= BOARD.length) cash += PASS_GO
    pos = moved % BOARD.length
    var tile = BOARD[pos]

    if (tile.t === 'tax') {
      cash -= tile.amount
    } else if (tile.t === 'chance') {
      cash += CHANCE[Math.floor(roll() * CHANCE.length)]
    } else if (tile.t === 'prop') {
      if (owned[pos]) {
        // Your own door. Nothing happens — there is no opponent to charge.
      } else {
        var want = decisions[next] || 'pass'
        next++
        if (want === 'buy') {
          if (cash < tile.price) ctx.reject('turn ' + turn + ': cannot afford ' + tile.name)
          cash -= tile.price
          owned[pos] = true
        } else {
          // The bank keeps it and charges you for standing there.
          cash -= tile.rent
        }
      }
    }

    // Bankruptcy ends the run where it stands. The score is what is left, which
    // is a real (bad) outcome rather than a rejection — the player did play.
    if (cash < 0) return 0
  }

  // Net worth: cash, plus what the deeds are worth, plus a bonus for holding
  // every property of a colour. The bonus is what makes "pass" a real decision:
  // buying everything you land on spends you out of the sets that pay.
  var worth = cash
  var byGroup = {}
  for (var i = 0; i < BOARD.length; i++) {
    if (!owned[i]) continue
    var t = BOARD[i]
    // Half of what you paid. A deed counted at full price would make buying free
    // in net-worth terms and rent-avoiding on top, so buying would be strictly
    // better than passing every time and the game would contain no decision at
    // all. At half, a lone deed is a loss and only a completed group pays it back.
    worth += t.price * RESALE
    byGroup[t.group] = (byGroup[t.group] || 0) + 1
  }
  for (var g in byGroup) {
    if (byGroup[g] === GROUP_SIZE[g]) worth += GROUP_BONUS
  }
  return Math.round(worth)
}
