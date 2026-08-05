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
├── cover.svg             # home-page card
└── about.md              # shown on the card and the world's page
```

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

### Schema versions — data outlives code

A world is perpetual. Unlike a match, it accumulates records across releases, so
a renderer must expect payloads older than itself. Bump `schemaVersion` when the
shape changes; keep every version you can still render in
`supportedSchemaVersions`. CI rejects a release that drops one.

## Rendering, audio, assets

The document is loaded via `srcdoc` into `sandbox="allow-scripts"` **without**
`allow-same-origin`, so it has an opaque origin and cannot reach the visitor's
session. The CSP sets `connect-src 'none'`: a world cannot open a channel of its
own, and every read and write goes through the host's allowlisted postMessage
proxy, which holds the credential.

`img-src` and `media-src` allow `data:`, which is looser than the game-view
policy. That is deliberate: games lock `img-src` down because a hidden-info
game's frame contains a viewer's secrets, and a world renders nothing private.

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

Same pipeline as games: PR → CODEOWNERS review → merge → `build:bundles` →
GitHub Release. Worlds ride in the same `index.json` under `worlds[]`, pinned by
content hash, and the Arena backend picks them up on its next refresh without a
restart. A published world appears on the Arena home page automatically — no
frontend change is needed to ship one.

Submission PRs may only touch `games/` or `worlds/`. A world's document runs in a
visitor's browser, so an author who could also edit the CSP or the op allowlist
in the same PR would be editing their own sandbox.
