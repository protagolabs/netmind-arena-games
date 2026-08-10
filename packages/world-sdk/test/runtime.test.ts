/**
 * Runtime tests for the author side of the world protocol.
 *
 * `runtime.ts` exists as a module separate from `index.ts` precisely so this is
 * possible without a browser — everything it touches (`window`, `document`,
 * `window.parent`) is stubbed below, and the host is played by hand so a test
 * can send exactly the message sequence a real host sends, including the
 * sequences that caused the bugs these cases pin down.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WORLD_CHANNEL } from '../src/protocol'
import { boot } from '../src/runtime'
import type { HostMessage, RecordPage, StoredRecord, ThemeTokens, VisitorInfo } from '../src/protocol'
import type { WorldCtx, WorldDefinition } from '../src/types'

/* ─────────────────────────── the host, played by hand ─────────────────────────── */

type Listener = (e: unknown) => void

class FakeHost {
  /** Everything the world posted to the parent, in order. */
  readonly received: Array<Record<string, unknown>> = []
  private readonly listeners = new Map<string, Set<Listener>>()
  readonly parent = {
    postMessage: (msg: Record<string, unknown>) => {
      this.received.push(msg)
    },
  }

  addEventListener = (type: string, fn: Listener): void => {
    let set = this.listeners.get(type)
    if (!set) this.listeners.set(type, (set = new Set()))
    set.add(fn)
  }

  removeEventListener = (type: string, fn: Listener): void => {
    this.listeners.get(type)?.delete(fn)
  }

  /** Deliver a host → world message as the parent frame would. */
  send(msg: HostMessage | Record<string, unknown>, source: unknown = this.parent): void {
    for (const fn of [...(this.listeners.get('message') ?? [])]) fn({ source, data: msg })
  }

  fire(type: string, event: Record<string, unknown> = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event)
  }

  /** Requests only, in order — `ready` / `failed` filtered out. */
  requests(): Array<Record<string, unknown>> {
    return this.received.filter((m) => m.type === 'request')
  }

  lastRequest(): Record<string, unknown> | undefined {
    return this.requests().at(-1)
  }

  failures(): string[] {
    return this.received.filter((m) => m.type === 'failed').map((m) => String(m.message))
  }

  /** Answer a pending request the way the host answers a successful one. */
  reply(id: number, result: unknown): void {
    this.send({ [WORLD_CHANNEL]: true, type: 'result', id, ok: true, result } as never)
  }

  replyError(id: number, error: { code: string; message: string; retryAfterSec?: number }): void {
    this.send({ [WORLD_CHANNEL]: true, type: 'result', id, ok: false, error } as never)
  }
}

let host: FakeHost

beforeEach(() => {
  host = new FakeHost()
  ;(globalThis as Record<string, unknown>).window = host
  ;(globalThis as Record<string, unknown>).document = { body: { tagName: 'BODY' } }
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
  delete (globalThis as Record<string, unknown>).document
})

/* ─────────────────────────── fixtures ─────────────────────────── */

const DARK: ThemeTokens = {
  mode: 'dark',
  bg: '#000',
  surface: '#111',
  fg: '#fff',
  fgSubtle: '#aaa',
  border: '#222',
  accent: '#0f0',
  accentFg: '#000',
  font: 'sans-serif',
}
const LIGHT: ThemeTokens = { ...DARK, mode: 'light', bg: '#fff', fg: '#000' }

const ALICE: VisitorInfo = { id: 'u1', kind: 'human', name: 'Alice', avatar: null }
const BOT: VisitorInfo = { id: 'a1', kind: 'agent', name: 'Bot', avatar: null }

function record(id: string, payload: unknown = { n: 1 }): StoredRecord {
  return {
    id,
    collection: 'notes',
    author: ALICE,
    payload,
    version: 1,
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mine: true,
  }
}

function page(items: StoredRecord[], cursor: string | null = null): RecordPage {
  return { items, cursor, hasMore: cursor !== null }
}

/**
 * `structuredClone` is not decoration — it is the only faithful model of a host.
 *
 * `postMessage` clones, so a world never receives the same object twice. Handing
 * the runtime a shared fixture object instead let an identity comparison
 * (`env.theme !== msg.theme`) look correct here while announcing a phantom theme
 * change on every re-init in a browser. A fixture easier than production
 * certifies bugs.
 */
function initMessage(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return structuredClone({
    [WORLD_CHANNEL]: true,
    type: 'init',
    world: { type: 'test-world', displayName: 'Test World', schemaVersion: 1 },
    me: ALICE,
    theme: DARK,
    lang: 'en',
    assets: { 'assets/cover.png': 'data:image/png;base64,AAAA' },
    seed: { notes: page([record('seed-1')]) },
    ...over,
  })
}

/**
 * Boot a world and resolve once `mount` has been handed its `ctx`.
 *
 * Returns the ctx rather than asserting inside `mount`, so each test reads as
 * "given a booted world, when the host does X" instead of nesting.
 */
async function bootWorld(
  over: Partial<Record<string, unknown>> = {},
  def: Partial<WorldDefinition> = {},
): Promise<WorldCtx> {
  let handOver!: (ctx: WorldCtx) => void
  const mounted = new Promise<WorldCtx>((resolve) => {
    handOver = resolve
  })
  void boot({
    meta: { type: 'test-world' } as WorldDefinition['meta'],
    mount: (_root, ctx) => handOver(ctx),
    ...def,
  } as WorldDefinition)
  await Promise.resolve()
  host.send(initMessage(over) as never)
  return mounted
}

/** Let the microtask queue drain — requests resolve through promise chains. */
const settle = () => new Promise((r) => setTimeout(r, 0))

/* ─────────────────────────── handshake ─────────────────────────── */

describe('handshake', () => {
  it('announces ready before the host has said anything', async () => {
    void boot({ meta: { type: 'test-world' }, mount: () => {} } as WorldDefinition)
    await Promise.resolve()
    expect(host.received[0]).toMatchObject({ [WORLD_CHANNEL]: true, type: 'ready' })
    expect(typeof host.received[0].sdk).toBe('string')
  })

  it('does not mount until init arrives', async () => {
    let mounted = false
    void boot({
      meta: { type: 'test-world' },
      mount: () => {
        mounted = true
      },
    } as WorldDefinition)
    await settle()
    expect(mounted).toBe(false)

    host.send(initMessage() as never)
    await settle()
    expect(mounted).toBe(true)
  })

  it('ignores messages that are not from the parent frame', async () => {
    let mounted = false
    void boot({
      meta: { type: 'test-world' },
      mount: () => {
        mounted = true
      },
    } as WorldDefinition)
    await Promise.resolve()

    host.send(initMessage() as never, { notTheParent: true })
    await settle()
    expect(mounted).toBe(false)
  })

  it('ignores traffic on the window that is not ours', async () => {
    let mounted = false
    void boot({
      meta: { type: 'test-world' },
      mount: () => {
        mounted = true
      },
    } as WorldDefinition)
    await Promise.resolve()

    host.send({ type: 'init', hello: 'from some unrelated library' })
    await settle()
    expect(mounted).toBe(false)
  })

  it('refuses to render a bundle the host asked for under another slug', async () => {
    let mounted = false
    void boot({
      meta: { type: 'test-world' },
      mount: () => {
        mounted = true
      },
    } as WorldDefinition)
    await Promise.resolve()

    host.send(initMessage({ world: { type: 'other-world', displayName: 'X', schemaVersion: 1 } }) as never)
    await settle()

    expect(mounted).toBe(false)
    expect(host.failures()[0]).toMatch(/type mismatch/)
  })

  it('reports a mount that throws instead of leaving a blank frame', async () => {
    void boot({
      meta: { type: 'test-world' },
      mount: () => {
        throw new Error('author blew up')
      },
    } as WorldDefinition)
    await Promise.resolve()
    host.send(initMessage() as never)
    await settle()

    expect(host.failures()).toContain('author blew up')
  })
})

/* ─────────────────────────── environment ─────────────────────────── */

describe('environment', () => {
  it('exposes identity, theme and language from init', async () => {
    const ctx = await bootWorld()
    expect(ctx.me).toEqual(ALICE)
    expect(ctx.theme.mode).toBe('dark')
    expect(ctx.lang).toBe('en')
  })

  it('does not replay init as a change', async () => {
    const seen: string[] = []
    const ctx = await bootWorld()
    ctx.onLangChange(() => seen.push('lang'))
    ctx.onThemeChange(() => seen.push('theme'))
    ctx.onVisitor(() => seen.push('me'))
    await settle()
    expect(seen).toEqual([])
  })

  it('delivers theme, language and identity changes', async () => {
    const ctx = await bootWorld()
    const langs: string[] = []
    const modes: string[] = []
    const people: Array<string | null> = []
    ctx.onLangChange((l) => langs.push(l))
    ctx.onThemeChange((t) => modes.push(t.mode))
    ctx.onVisitor((me) => people.push(me?.name ?? null))

    host.send({ [WORLD_CHANNEL]: true, type: 'env', lang: 'zh' } as never)
    host.send({ [WORLD_CHANNEL]: true, type: 'env', theme: LIGHT } as never)
    host.send({ [WORLD_CHANNEL]: true, type: 'env', me: BOT } as never)
    host.send({ [WORLD_CHANNEL]: true, type: 'env', me: null } as never)

    expect(langs).toEqual(['zh'])
    expect(modes).toEqual(['light'])
    expect(people).toEqual(['Bot', null])
    expect(ctx.lang).toBe('zh')
    expect(ctx.theme.mode).toBe('light')
    expect(ctx.me).toBeNull()
  })

  it('commits every field of an env before notifying anyone', async () => {
    // The bug this pins: assign-then-emit per field let the first callback read
    // a half-applied env — new theme, previous language — which is why a host
    // sending fields one at a time looked correct and Arena, which sends theme
    // and language together, did not.
    const ctx = await bootWorld()
    const observed: Array<{ lang: string; mode: string }> = []
    const snapshot = () => observed.push({ lang: ctx.lang, mode: ctx.theme.mode })
    ctx.onThemeChange(snapshot)
    ctx.onLangChange(snapshot)

    host.send({ [WORLD_CHANNEL]: true, type: 'env', theme: LIGHT, lang: 'ja' } as never)

    expect(observed).toEqual([
      { lang: 'ja', mode: 'light' },
      { lang: 'ja', mode: 'light' },
    ])
  })

  it('treats a repeated init as an env change, not a silent overwrite', async () => {
    const ctx = await bootWorld()
    const langs: string[] = []
    const people: Array<string | null> = []
    ctx.onLangChange((l) => langs.push(l))
    ctx.onVisitor((me) => people.push(me?.name ?? null))

    host.send(initMessage({ lang: 'ko', me: BOT }) as never)

    expect(ctx.lang).toBe('ko')
    expect(ctx.me).toEqual(BOT)
    expect(langs).toEqual(['ko'])
    expect(people).toEqual(['Bot'])
  })

  it('a repeated init that changes nothing emits nothing', async () => {
    const ctx = await bootWorld()
    const seen: string[] = []
    ctx.onLangChange(() => seen.push('lang'))
    ctx.onThemeChange(() => seen.push('theme'))
    ctx.onVisitor(() => seen.push('me'))

    // Same content, different objects — exactly what a second `postMessage`
    // delivers, and what an identity comparison mistakes for a change.
    host.send(initMessage() as never)
    expect(seen).toEqual([])
  })

  it('a repeated init whose theme really differs does emit', async () => {
    // The other half of the case above: content comparison must not go so far as
    // to swallow a genuine change.
    const ctx = await bootWorld()
    const modes: string[] = []
    ctx.onThemeChange((t) => modes.push(t.mode))

    host.send(initMessage({ theme: LIGHT }) as never)

    expect(modes).toEqual(['light'])
    expect(ctx.theme.mode).toBe('light')
  })

  it('notices a visitor who renamed themselves without changing id', async () => {
    // Comparing `me` by `id` alone reported this as no change, so a world drawing
    // bylines kept the old name until something else forced a repaint.
    const ctx = await bootWorld()
    const names: Array<string | null> = []
    ctx.onVisitor((me) => names.push(me?.name ?? null))

    host.send(initMessage({ me: { ...ALICE, name: 'Alice Liddell' } }) as never)

    expect(names).toEqual(['Alice Liddell'])
    expect(ctx.me?.name).toBe('Alice Liddell')
  })

  it('one throwing subscriber does not starve the others', async () => {
    const ctx = await bootWorld()
    const reached: string[] = []
    ctx.onLangChange(() => {
      throw new Error('author bug')
    })
    ctx.onLangChange(() => reached.push('second'))

    host.send({ [WORLD_CHANNEL]: true, type: 'env', lang: 'fr' } as never)
    expect(reached).toEqual(['second'])
  })

  it('unsubscribes', async () => {
    const ctx = await bootWorld()
    const seen: string[] = []
    const off = ctx.onLangChange((l) => seen.push(l))
    host.send({ [WORLD_CHANNEL]: true, type: 'env', lang: 'de' } as never)
    off()
    host.send({ [WORLD_CHANNEL]: true, type: 'env', lang: 'es' } as never)
    expect(seen).toEqual(['de'])
  })
})

/* ─────────────────────────── collections ─────────────────────────── */

describe('collections', () => {
  it('serves the seeded first page without a round trip, once', async () => {
    const ctx = await bootWorld()
    const notes = ctx.collection('notes')

    const first = await notes.list()
    expect(first.items.map((r) => r.id)).toEqual(['seed-1'])
    expect(host.requests()).toHaveLength(0)

    const second = notes.list()
    await settle()
    const req = host.lastRequest()
    expect(req).toMatchObject({ op: 'list', collection: 'notes' })
    host.reply(req!.id as number, page([record('live-1')]))
    expect((await second).items.map((r) => r.id)).toEqual(['live-1'])
  })

  it('does not answer a filtered or paged list from the seed', async () => {
    const ctx = await bootWorld()
    const notes = ctx.collection('notes')

    void notes.list({ mine: true })
    await settle()
    expect(host.lastRequest()).toMatchObject({ op: 'list', args: { mine: true } })
  })

  it('does not over-serve a list that asked for fewer records than the seed holds', async () => {
    // The host seeds at ITS page size. Answering a smaller `limit` from the seed
    // handed back whatever the host had decided — and did it without the round
    // trip that would have corrected it, identically in preview and production.
    const ctx = await bootWorld({ seed: { notes: page([record('s1'), record('s2'), record('s3')]) } })

    void ctx.collection('notes').list({ limit: 2 })
    await settle()
    expect(host.lastRequest()).toMatchObject({ op: 'list', args: { limit: 2 } })
  })

  it('still answers from the seed when the limit cannot be exceeded', async () => {
    const ctx = await bootWorld({ seed: { notes: page([record('s1')]) } })

    const first = await ctx.collection('notes').list({ limit: 50 })
    expect(first.items.map((r) => r.id)).toEqual(['s1'])
    expect(host.requests()).toHaveLength(0)
  })

  it('returns the same handle for a repeated collection() call', async () => {
    const ctx = await bootWorld()
    expect(ctx.collection('notes')).toBe(ctx.collection('notes'))
  })

  it('an undeclared collection is an author bug, thrown at the call', async () => {
    const ctx = await bootWorld()
    expect(() => ctx.collection('nope')).toThrow(/not declared/)
  })

  it('maps each op onto the wire, and each reply back', async () => {
    const ctx = await bootWorld()
    const notes = ctx.collection<{ n: number }>('notes')

    const cases: Array<[() => Promise<unknown>, Record<string, unknown>, unknown, unknown]> = [
      [() => notes.get('r1'), { op: 'get', args: { id: 'r1' } }, record('r1'), 'r1'],
      [() => notes.count({ mine: true }), { op: 'count', args: { mine: true } }, 7, 7],
      [() => notes.add({ n: 2 }), { op: 'add', args: { payload: { n: 2 } } }, record('r2'), 'r2'],
      [
        () => notes.put('r3', { n: 3 }, { version: 4 }),
        { op: 'put', args: { id: 'r3', payload: { n: 3 }, version: 4 } },
        record('r3'),
        'r3',
      ],
      [
        () => notes.patch('r4', { n: 5 }, { version: 6 }),
        { op: 'patch', args: { id: 'r4', partial: { n: 5 }, version: 6 } },
        record('r4'),
        'r4',
      ],
    ]

    for (const [call, wire, reply, expected] of cases) {
      const p = call()
      await settle()
      const req = host.lastRequest()!
      expect(req).toMatchObject({ collection: 'notes', ...wire })
      host.reply(req.id as number, reply)
      const got = await p
      expect(typeof got === 'object' && got !== null ? (got as { id: string }).id : got).toEqual(
        expected,
      )
    }

    const del = notes.del('r5')
    await settle()
    expect(host.lastRequest()).toMatchObject({ op: 'del', args: { id: 'r5' } })
    host.reply(host.lastRequest()!.id as number, undefined)
    await expect(del).resolves.toBeUndefined()
  })

  it('get() resolving to nothing is null, not a rejection', async () => {
    const ctx = await bootWorld()
    const p = ctx.collection('notes').get('missing')
    await settle()
    host.reply(host.lastRequest()!.id as number, null)
    await expect(p).resolves.toBeNull()
  })

  it('correlates concurrent requests by id', async () => {
    const ctx = await bootWorld()
    const notes = ctx.collection('notes')
    const a = notes.get('a')
    const b = notes.get('b')
    await settle()

    const [reqA, reqB] = host.requests()
    // Answered out of order on purpose: correlation is the whole point of `id`.
    host.reply(reqB.id as number, record('b'))
    host.reply(reqA.id as number, record('a'))

    expect((await a)?.id).toBe('a')
    expect((await b)?.id).toBe('b')
  })

  it('routes the local store through its own ops, with no collection', async () => {
    const ctx = await bootWorld()

    void ctx.local.set('draft', { text: 'hi' })
    await settle()
    expect(host.lastRequest()).toMatchObject({
      op: 'local.set',
      collection: undefined,
      args: { key: 'draft', value: { text: 'hi' } },
    })

    void ctx.local.get('draft')
    await settle()
    expect(host.lastRequest()).toMatchObject({ op: 'local.get', args: { key: 'draft' } })

    void ctx.local.del('draft')
    await settle()
    expect(host.lastRequest()).toMatchObject({ op: 'local.del', args: { key: 'draft' } })
  })
})

/* ─────────────────────────── errors ─────────────────────────── */

describe('errors', () => {
  it('rejects with the host code, message and retry hint', async () => {
    const ctx = await bootWorld()
    const p = ctx.collection('notes').add({ n: 1 })
    await settle()
    host.replyError(host.lastRequest()!.id as number, {
      code: 'rate-limited',
      message: 'slow down',
      retryAfterSec: 30,
    })

    await expect(p).rejects.toMatchObject({
      name: 'WorldError',
      code: 'rate-limited',
      message: 'slow down',
      retryAfterSec: 30,
    })
  })

  it('falls back to unavailable when the host names no code', async () => {
    const ctx = await bootWorld()
    const p = ctx.collection('notes').add({ n: 1 })
    await settle()
    host.send({ [WORLD_CHANNEL]: true, type: 'result', id: host.lastRequest()!.id, ok: false } as never)
    await expect(p).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('a result for an unknown id is ignored, not thrown', async () => {
    await bootWorld()
    expect(() => host.reply(9999, record('x'))).not.toThrow()
  })

  it('gives up on a host that never answers, instead of hanging forever', async () => {
    vi.useFakeTimers()
    try {
      const ctx = await bootWorld()
      const p = ctx.collection('notes').add({ n: 1 })
      // Attach the expectation before advancing: an unobserved rejection between
      // the timer firing and the assertion is an unhandled rejection.
      const settled = expect(p).rejects.toMatchObject({ code: 'unavailable' })
      await vi.advanceTimersByTimeAsync(30_000)
      await settled
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives a model call longer than an ordinary one, and longer than the host does', async () => {
    /**
     * The backstop has to sit OUTSIDE every legitimate wait, and `ai.chat` has
     * two the other ops do not: the model itself (Arena allows it a minute), and
     * a human — the first call shows the visitor what the model is for and asks
     * whether to spend their own credit on it.
     *
     * Giving up at the ordinary deadline would not merely be impatient. The host
     * is still working, so the call completes and the VISITOR IS BILLED for a
     * reply nothing is listening for any more.
     */
    vi.useFakeTimers()
    try {
      const ctx = await bootWorld({ capabilities: { ai: true } })
      let settled: string | null = null
      void ctx
        .ai!.chat({ messages: [{ role: 'user', content: 'hi' }] })
        .then(() => (settled = 'resolved'))
        .catch(() => (settled = 'rejected'))

      // Past the ordinary deadline, and past the host's own ceiling for this op.
      await vi.advanceTimersByTimeAsync(90_000)
      expect(settled).toBeNull()

      await vi.advanceTimersByTimeAsync(31_000)
      expect(settled).toBe('rejected')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not time out a request the host did answer', async () => {
    vi.useFakeTimers()
    try {
      const ctx = await bootWorld()
      const p = ctx.collection('notes').get('r1')
      await vi.advanceTimersByTimeAsync(0)
      host.reply(host.lastRequest()!.id as number, record('r1'))
      expect((await p)?.id).toBe('r1')
      // Well past the timeout: a cleared timer must not reject a settled promise.
      await vi.advanceTimersByTimeAsync(60_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards uncaught errors and unhandled rejections to the host', async () => {
    await bootWorld()
    host.fire('error', { message: 'boom', filename: 'world.js', lineno: 12 })
    host.fire('unhandledrejection', { reason: { message: 'nope' } })

    expect(host.failures()).toContain('boom (world.js:12)')
    expect(host.failures()).toContain('unhandled rejection: nope')
  })
})

/* ─────────────────────────── changes ─────────────────────────── */

describe('changes', () => {
  it('delivers all three ops to the subscribed collection', async () => {
    const ctx = await bootWorld()
    const events: string[] = []
    ctx.collection('notes').onChange((e) => {
      events.push(e.op === 'deleted' ? `deleted:${e.id}` : `${e.op}:${e.record.id}`)
    })

    for (const event of [
      { op: 'added', record: record('n1') },
      { op: 'updated', record: record('n1') },
      { op: 'deleted', id: 'n1' },
    ]) {
      host.send({ [WORLD_CHANNEL]: true, type: 'change', collection: 'notes', event } as never)
    }

    expect(events).toEqual(['added:n1', 'updated:n1', 'deleted:n1'])
  })

  it('does not cross collections', async () => {
    const ctx = await bootWorld({ seed: { notes: page([]), lamps: page([]) } })
    const seen: string[] = []
    ctx.collection('notes').onChange(() => seen.push('notes'))
    ctx.collection('lamps').onChange(() => seen.push('lamps'))

    host.send({
      [WORLD_CHANNEL]: true,
      type: 'change',
      collection: 'lamps',
      event: { op: 'added', record: record('l1') },
    } as never)

    expect(seen).toEqual(['lamps'])
  })

  it('stops after unsubscribe', async () => {
    const ctx = await bootWorld()
    let count = 0
    const off = ctx.collection('notes').onChange(() => count++)
    const change = {
      [WORLD_CHANNEL]: true,
      type: 'change',
      collection: 'notes',
      event: { op: 'added', record: record('n1') },
    }
    host.send(change as never)
    off()
    host.send(change as never)
    expect(count).toBe(1)
  })
})

/* ─────────────────────────── assets and teardown ─────────────────────────── */

describe('assets', () => {
  it('resolves a published asset by path, with or without the assets/ prefix', async () => {
    const ctx = await bootWorld()
    const uri = 'data:image/png;base64,AAAA'
    expect(ctx.asset('assets/cover.png')).toBe(uri)
    expect(ctx.asset('cover.png')).toBe(uri)
    expect(ctx.asset('./cover.png')).toBe(uri)
  })

  it('a missing asset is a wrong path, thrown as not-found', async () => {
    const ctx = await bootWorld()
    expect(() => ctx.asset('nope.png')).toThrow(/not published/)
  })
})

/* ─────────────────────────── model access ─────────────────────────── */

describe('ctx.ai', () => {
  it('is null when the host announces no capabilities', async () => {
    const ctx = await bootWorld()
    expect(ctx.ai).toBeNull()
  })

  it('is null when the host announces ai: false', async () => {
    // The deployment can have model access switched off even for a world whose
    // manifest declares it, so `capabilities` present is not the same as granted.
    const ctx = await bootWorld({ capabilities: { ai: false } })
    expect(ctx.ai).toBeNull()
  })

  it('sends an ai.chat request with no collection', async () => {
    const ctx = await bootWorld({ capabilities: { ai: true } })
    void ctx.ai!.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 })
    await settle()
    expect(host.lastRequest()).toMatchObject({
      op: 'ai.chat',
      collection: undefined,
      args: { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 },
    })
  })

  it('surfaces unauthenticated as a typed error the world can fall back from', async () => {
    // The single most common outcome in practice: nobody is signed in, so there
    // is no account to bill. A world has to be able to tell that apart from a
    // transport failure, because only one of the two is worth retrying.
    const ctx = await bootWorld({ capabilities: { ai: true } })
    const call = ctx.ai!.chat({ messages: [{ role: 'user', content: 'hi' }] })
    await settle()
    const id = Number(host.lastRequest()!.id)
    host.replyError(id, { code: 'unauthenticated', message: 'sign in to do that' })
    await expect(call).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('surfaces rate-limited with its retry hint', async () => {
    const ctx = await bootWorld({ capabilities: { ai: true } })
    const call = ctx.ai!.chat({ messages: [{ role: 'user', content: 'hi' }] })
    await settle()
    const id = Number(host.lastRequest()!.id)
    host.replyError(id, { code: 'rate-limited', message: 'slow down', retryAfterSec: 42 })
    await expect(call).rejects.toMatchObject({ code: 'rate-limited', retryAfterSec: 42 })
  })
})

describe('teardown', () => {
  it('runs unmount when the document goes away', async () => {
    let torn = 0
    await bootWorld({}, { unmount: () => torn++ })
    host.fire('pagehide')
    expect(torn).toBe(1)
  })

  it('runs it at most once', async () => {
    let torn = 0
    await bootWorld({}, { unmount: () => torn++ })
    host.fire('pagehide')
    host.fire('pagehide')
    expect(torn).toBe(1)
  })

  it('a throwing unmount is not the last thing that happens', async () => {
    await bootWorld(
      {},
      {
        unmount: () => {
          throw new Error('teardown bug')
        },
      },
    )
    expect(() => host.fire('pagehide')).not.toThrow()
  })
})

/* ─────────────────────────── channels ─────────────────────────── */

/** A `signal` frame as the host posts it. */
function signal(channel: string, event: Record<string, unknown>): Record<string, unknown> {
  return structuredClone({ [WORLD_CHANNEL]: true, type: 'signal', channel, event })
}

const CAPS = { capabilities: { realtime: true } }

describe('ctx.channel', () => {
  it('is refused for a deployment that does not serve realtime', async () => {
    const ctx = await bootWorld()
    await expect(ctx.channel('versus/ab').join()).rejects.toMatchObject({ code: 'unavailable' })
  })

  /**
   * Two calls for one room must give ONE handle. Two would mean two listener
   * sets and two independent reconnect loops racing to rejoin the same room.
   */
  it('returns the same handle for the same name, normalised', async () => {
    const ctx = await bootWorld(CAPS)
    expect(ctx.channel('versus/AB')).toBe(ctx.channel('versus/ab'))
  })

  it('refuses a name that is not <namespace>/<room>', async () => {
    const ctx = await bootWorld(CAPS)
    expect(() => ctx.channel('versus')).toThrow(/namespace.*room/)
  })

  it('joins and resolves with who is already there', async () => {
    const ctx = await bootWorld(CAPS)
    const room = ctx.channel('versus/ab')
    const joined = room.join()
    await settle()
    expect(host.lastRequest()).toMatchObject({ op: 'channel.join', args: { name: 'versus/ab' } })
    host.reply(host.lastRequest()!.id as number, { peers: [{ id: 'u2', kind: 'human', name: 'Bo', avatar: null }] })
    expect((await joined).map((p) => p.id)).toEqual(['u2'])
  })

  /**
   * The echo is the point, not an inefficiency: both sides consume one identical
   * stream, so a deterministic world cannot order a crossing pair of events two
   * different ways. `mine` is what lets a world tell them apart afterwards.
   */
  it('marks a message from the current visitor as mine', async () => {
    const ctx = await bootWorld(CAPS)
    const seen: Array<{ mine: boolean; data: unknown }> = []
    ctx.channel('versus/ab').onMessage((m) => seen.push({ mine: m.mine, data: m.data }))

    host.send(
      signal('versus/ab', { op: 'message', from: ALICE, data: { n: 1 }, seq: 1, at: 'now' }) as never,
    )
    host.send(
      signal('versus/ab', { op: 'message', from: BOT, data: { n: 2 }, seq: 1, at: 'now' }) as never,
    )

    expect(seen).toEqual([
      { mine: true, data: { n: 1 } },
      { mine: false, data: { n: 2 } },
    ])
  })

  /** `me` changes when someone signs in mid-session, so `mine` cannot be frozen. */
  it('recomputes mine after the visitor changes', async () => {
    const ctx = await bootWorld(CAPS)
    const seen: boolean[] = []
    ctx.channel('versus/ab').onMessage((m) => seen.push(m.mine))

    host.send(signal('versus/ab', { op: 'message', from: BOT, data: {}, seq: 1, at: 'now' }) as never)
    host.send({ [WORLD_CHANNEL]: true, type: 'env', me: BOT } as never)
    host.send(signal('versus/ab', { op: 'message', from: BOT, data: {}, seq: 2, at: 'now' }) as never)

    expect(seen).toEqual([false, true])
  })

  it('delivers presence and closed to their own subscribers', async () => {
    const ctx = await bootWorld(CAPS)
    const room = ctx.channel('versus/ab')
    const rosters: number[] = []
    const closes: string[] = []
    room.onPresence((peers) => rosters.push(peers.length))
    room.onClosed((reason) => closes.push(reason))

    host.send(signal('versus/ab', { op: 'presence', peers: [ALICE, BOT] }) as never)
    host.send(signal('versus/ab', { op: 'closed', reason: 'error' }) as never)

    expect(rosters).toEqual([2])
    expect(closes).toEqual(['error'])
  })

  it('routes a frame only to the channel it names', async () => {
    const ctx = await bootWorld(CAPS)
    const a: unknown[] = []
    const b: unknown[] = []
    ctx.channel('versus/aa').onMessage((m) => a.push(m.data))
    ctx.channel('versus/bb').onMessage((m) => b.push(m.data))

    host.send(signal('versus/aa', { op: 'message', from: ALICE, data: 1, seq: 1, at: 'now' }) as never)

    expect(a).toEqual([1])
    expect(b).toEqual([])
  })

  it('a frame for a channel nobody is listening to is dropped, not thrown', async () => {
    await bootWorld(CAPS)
    expect(() =>
      host.send(signal('versus/zz', { op: 'message', from: ALICE, data: 1, seq: 1, at: 'now' }) as never),
    ).not.toThrow()
  })

  /**
   * A refusal is final — an undeclared namespace or a signed-out visitor will not
   * fix itself — so a failed join must NOT start the reconnect loop. Retrying
   * `forbidden` forever is how a typo becomes a request every few seconds for as
   * long as the tab is open.
   */
  it('does not retry a refused join', async () => {
    vi.useFakeTimers()
    try {
      const ctx = await bootWorld(CAPS)
      const joined = ctx.channel('versus/ab').join()
      await Promise.resolve()
      host.replyError(host.lastRequest()!.id as number, { code: 'forbidden', message: 'no' })
      await expect(joined).rejects.toMatchObject({ code: 'forbidden' })

      const before = host.requests().length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(host.requests().length).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  /** A stream that opened and then died IS worth retrying — the host may come back. */
  it('reconnects after a stream that had opened dies', async () => {
    vi.useFakeTimers()
    try {
      const ctx = await bootWorld(CAPS)
      const room = ctx.channel('versus/ab')
      void room.join()
      await Promise.resolve()
      host.reply(host.lastRequest()!.id as number, { peers: [] })
      await Promise.resolve()

      host.send(signal('versus/ab', { op: 'closed', reason: 'error' }) as never)
      const before = host.requests().length
      await vi.advanceTimersByTimeAsync(1_000)

      const retried = host.requests().slice(before)
      expect(retried.some((r) => r.op === 'channel.join')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  /** `leave()` means leave. Being dragged back into a room is worse than staying out. */
  it('stops reconnecting once the world has left', async () => {
    vi.useFakeTimers()
    try {
      const ctx = await bootWorld(CAPS)
      const room = ctx.channel('versus/ab')
      void room.join()
      await Promise.resolve()
      host.reply(host.lastRequest()!.id as number, { peers: [] })
      await Promise.resolve()

      void room.leave()
      await Promise.resolve()
      // Answer it: an unanswered request would sit until its own 30s backstop
      // and reject into nobody's hands, which is a different bug from the one
      // under test and would fail the run as an unhandled rejection.
      host.reply(host.lastRequest()!.id as number, null)
      await Promise.resolve()
      host.send(signal('versus/ab', { op: 'closed', reason: 'error' }) as never)

      const before = host.requests().length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(host.requests().filter((r) => r.op === 'channel.join').length).toBe(
        host.requests().slice(0, before).filter((r) => r.op === 'channel.join').length,
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends through the host rather than opening anything itself', async () => {
    const ctx = await bootWorld(CAPS)
    void ctx.channel('versus/ab').send({ tick: 137 })
    await settle()
    expect(host.lastRequest()).toMatchObject({
      op: 'channel.send',
      args: { name: 'versus/ab', data: { tick: 137 } },
    })
  })
})
