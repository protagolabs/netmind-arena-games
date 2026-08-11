# PredictMy.ai

An 11-a-side football match, played out by a deterministic engine, broadcast on a
channel that only exists here. Click any dot on the pitch and that player is
yours — a dashed ring marks it — then tell it what to do in plain language.
"压上逼抢", "拉开宽度", "打身后", "盯防 9 号". The order rewrites that player's
strategy parameters and the dot changes behaviour on the next tick.

Nothing is scored. There is no entry, no prize and no ranking — the match runs
whether you touch it or not. What you can do is interfere: claim one player, or
take a bench and give the order to the whole side, then watch ninety minutes
decide whether you were right. When you want the answer without the theatre,
`预测比赛` runs the full engine a hundred times over and reports what usually
happens.

There is one way to have an opponent, and you have to go looking for it: **联网
对战** in the menu puts another coach on the other bench, by room code. It is
still not scored — nobody wins anything — it just means the side you are arguing
with argues back.

The controls are a television's, not an app's. There is a seed, so a match can be
replayed exactly. There is a vision overlay for what the players can see, a
referee you can switch off, a cinematic filter, and a camera you can move between
the broadcast angle and directly overhead.

## What is different here

This is a port of [predictmy.ai](https://predictmy.ai), running inside Arena's
world sandbox. The engine, the pitch, the remote and the copy are the deployed
build, unchanged. Two things are not:

- **The assistant coach.** On the site, tactics chat reaches a server-side LLM.
  Here it reaches Arena's, and the inference is billed to your own NetMind
  account — so you are asked once, before the first call, and you can say no. The
  site kept its coach's instructions on its server, so those had to be written
  again for this port; the orders it understands are the same, the voice may not
  be. Signed out, or declined, the chat falls back to the bilingual rule parser
  the site already carries for when its model is busy: explicit orders still
  work, a hint that needs inference does not.
- **The other pages.** World Cup mode, the adventure game and the written docs
  are separate pages of the site. A world is a single screen, so every control
  that pointed at one now names the address instead. A sandboxed document cannot
  open a link — that is the security model, not an oversight — so the address is
  offered to copy; the **based on PredictMy.ai** link Arena renders around this
  frame is the one that actually clicks.

Three things here are Arena's rather than the site's, and it seems only fair to
say which:

- **Online versus.** This one is a separate page on the site too, and it is the
  only one that came over — because what it needs is not a second screen but a
  relay, and a world now has one. None of the site's versus code is here. The
  room, the codes, the two benches and the panel are all written for Arena, so
  it will not look or behave like the original.

  How it works, since it is unusual: nothing about the match crosses the wire.
  The simulator is deterministic, so both sides run the whole ninety minutes
  locally from one seed and exchange only the orders — a few dozen short
  messages. An order takes effect half a second after you send it, on the same
  tick for both coaches, which is what keeps two machines playing one match
  rather than two similar ones. Reload the page and it replays from the start to
  catch up. If the two ever disagree, they notice within a few seconds and both
  rebuild from the seed.

  You coach ONE team, the way the original does it. The panel says which, and
  the page's own controls — the preset buttons, the tactics box, the AI coach,
  the sliders — all keep working and all relay: an order you give the normal way
  reaches the other screen. The opposite bench is not yours, so clicking it does
  nothing.

  One limit worth knowing: it needs both coaches signed in. A room has no way to
  seat someone with no identity.

- **The score bar** above the pitch. On the site the score lives inside the coach
  panel, so unless you have selected someone you can watch the whole match
  without being told what it is. The numbers and the words are the simulator's
  own; showing them all the time was our call.
- **The assistant coach's instructions**, as above — the site kept those on its
  server, so they had to be written again.

Language and theme moved rather than disappeared: Arena's header drives both, and
the page's own switchers are hidden, because two controls for one setting are two
controls that disagree. All nine of the site's languages are still there.

The invite-code gate is gone too: nothing here is gated.
