# raw-guestbook — a world with no SDK and no build step

Two files. Hand-written HTML that speaks [the world protocol](../../docs/world-protocol.md)
directly, and a manifest. Nothing here imports `@arena/world-sdk`, and nothing
here is compiled.

It exists for two reasons. It is the starting point for a platform whose world
lives in a private repository and is submitted through the self-serve API rather
than as a pull request here. And it is the proof that `world-protocol.md` is
complete: if this stops working, the specification is missing something.

**If you can use the SDK, use it.** `pnpm new-world <slug>` gives you types, a
local preview against a real sandbox, and `ctx.records.add(...)` instead of the
request-correlation bookkeeping below. This path is for when you cannot.

## Submitting it

```bash
export ARENA_PARTNER_KEY=arena_pk_...
arena world check  .
arena world submit .
```

It lands `unlisted` — served, so you can open the exact artifact that will ship,
but absent from the public catalogue until an Arena reviewer publishes it.

## What to read in `index.html`

| Line of interest | Why |
|---|---|
| `postMessage({ type: 'ready' })` at the very bottom | Sent after the listener is installed. Send it earlier and you can miss `init`. |
| `pending` map keyed by `id` | The host answers requests out of order. Correlate, do not assume. |
| `li.textContent = ...` | Never `innerHTML`. That text belongs to another visitor. |
| `catch` around `add` | `unauthenticated` is an ordinary outcome — most visitors are signed out. |
| `m.type === 'env'` | Someone can sign in without reloading. Read `me` again. |
