/**
 * The local `/api` router's contract with the vendored build.
 *
 * These are not tests of this file's logic — the router is a switch statement.
 * They pin the answers that vendored, minified code branches on. Each one is a
 * value chosen to steer the source down a path it already has, and the evidence
 * for each is a line in `src/vendor/*.js` that no compiler will ever check. A
 * wrong value here builds, validates and ships; it goes wrong only in a
 * visitor's browser, silently, on whichever feature it disabled.
 */
import { describe, it, expect } from 'vitest'
import { route } from '../src/shim.js'

const body = async (
  url: string,
  init?: RequestInit,
  chat?: Parameters<typeof route>[2],
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const res = await route(url, init, chat)
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

describe('the invite gate', () => {
  it('reports the world as ungated', async () => {
    // `(await (await fetch('/api/session')).json()).gated` — the source keeps
    // this in `zt` and consults it before every coach reply.
    const { status, json } = await body('/api/session')
    expect(status).toBe(200)
    expect(json.gated).toBe(false)
  })

  it('accepts a code and an invite request, since neither can fail usefully', async () => {
    // Both are read as `res.ok` only. Rejecting would show the visitor an error
    // about a gate this world does not have.
    expect((await route('/api/join')).ok).toBe(true)
    expect((await route('/api/request-invite')).ok).toBe(true)
  })
})

describe('the visitor heartbeat', () => {
  it('answers with the stop signal the source honours', async () => {
    // `r && r.ok === false` sets `x = true` and clears the 60s interval. Any
    // other answer leaves the world pinging a route that will never exist.
    const { json } = await body('/api/ping')
    expect(json.ok).toBe(false)
  })
})

describe('the assistant coach', () => {
  const reply = { content: [{ type: 'tool_use', id: 't1', name: 'set_tactics', input: { pressing: 0.3 } }], stop_reason: 'tool_use' }

  it('passes the page’s own request through to the model', async () => {
    // The page builds `{messages, context}` itself and replays the array across
    // its four-round tool loop. Rewriting it here would break that loop in ways
    // only a live match would show.
    let seen: unknown = null
    await body('/api/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'press high' }], context: { minute: 12 } }) }, async (req) => {
      seen = req
      return reply
    })
    expect(seen).toEqual({ messages: [{ role: 'user', content: 'press high' }], context: { minute: 12 } })
  })

  it('returns content blocks and stop_reason in the shape the source walks', async () => {
    // `i.content` is iterated for `type === 'tool_use'`, and
    // `i.stop_reason === 'tool_use'` is what continues the loop. Renaming either
    // leaves the coach replying and nothing on the pitch changing.
    const { status, json } = await body('/api/chat', { method: 'POST', body: '{}' }, async () => reply)
    expect(status).toBe(200)
    expect(json.content).toEqual(reply.content)
    expect(json.stop_reason).toBe('tool_use')
  })

  it('answers 429 when there is no model at all', async () => {
    // `u.status === 429 ? Zn(o) : _('err', a('chatErr'))`. 429 runs the source's
    // own bilingual rule parser over the order; anything else prints an error
    // and drops the instruction on the floor. This is the path a signed-out
    // visitor takes, which makes it the common case rather than the sad one.
    const { status } = await body('/api/chat', { method: 'POST', body: '{}' }, null)
    expect(status).toBe(429)
  })

  it('answers 429 when the call fails, whatever the reason', async () => {
    // Declined consent, rate limit, expired session, provider outage: the page
    // has exactly one branch for "no model right now", and it is a good one.
    const { status } = await body('/api/chat', { method: 'POST', body: '{}' }, async () => {
      throw Object.assign(new Error('nope'), { code: 'rate-limited' })
    })
    expect(status).toBe(429)
  })

  it('never sets needCode, which would divert to the invite gate', async () => {
    // `u.status === 402 || m?.needCode ? Wt() : …` is checked BEFORE the 429
    // branch, so this flag would win and open a code prompt instead.
    const { json } = await body('/api/chat', { method: 'POST', body: '{}' }, null)
    expect(json.needCode).toBeUndefined()
  })
})

describe('everything else', () => {
  it('answers Vite preload probes without failing them', async () => {
    // The modulepreload polyfill reaches for chunks esbuild already inlined.
    // There is nothing to send, but an error would surface as a console failure
    // in a world that is working perfectly.
    const res = await route('/assets/players-2026.js')
    expect(res.ok).toBe(true)
  })

  it('ignores the query string when matching', async () => {
    const { json } = await body('/api/ping?first=1')
    expect(json.ok).toBe(false)
  })
})
