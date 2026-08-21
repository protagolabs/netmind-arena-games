import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * `onFrame` is the boundary between a host and an author's renderer, and the
 * properties tested here are the ones a host relies on to pace playback: frames
 * are drawn one at a time, and `frame-done` means "this frame is finished", not
 * "this frame arrived".
 *
 * Like `preview.test.ts`, this stubs the handful of globals the code touches
 * rather than pulling in jsdom — nothing in this package needs a real DOM, and
 * the stub makes it explicit which platform calls are part of the contract.
 */

interface Posted {
  __arenaView?: boolean
  type?: string
  seq?: number
  paceMs?: number
}

let posted: Posted[]
let handlers: Array<(e: MessageEvent) => void>
let parentWindow: object

/** Deliver a message as the host would. */
function fromHost(data: unknown): void {
  for (const h of handlers) h({ source: parentWindow, data } as unknown as MessageEvent)
}

function sendFrame(frame: unknown, seq?: number): void {
  fromHost({ __arenaView: true, type: 'frame', frame, seq })
}

const acks = (): Array<number | undefined> =>
  posted.filter((m) => m.type === 'frame-done').map((m) => m.seq)

beforeEach(() => {
  posted = []
  handlers = []
  parentWindow = { postMessage: (m: Posted) => posted.push(m) }
  vi.stubGlobal('window', {
    parent: parentWindow,
    addEventListener: (type: string, h: (e: MessageEvent) => void) => {
      if (type === 'message') handlers.push(h)
    },
  })
  vi.stubGlobal('document', { body: { id: 'root' } })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** Imported per-test: `onFrame` keeps per-registration queue state. */
async function load() {
  return (await import('../src/view.js')).onFrame
}

describe('onFrame', () => {
  it('announces readiness with the declared pace', async () => {
    const onFrame = await load()
    onFrame(() => {}, { paceMs: 1700 })
    expect(posted).toEqual([{ __arenaView: true, type: 'ready', paceMs: 1700 }])
  })

  it('draws each frame and acks it with the host token', async () => {
    const onFrame = await load()
    const seen: unknown[] = []
    onFrame((frame) => {
      seen.push(frame)
    })

    sendFrame('a', 1)
    sendFrame('b', 2)
    await Promise.resolve()

    expect(seen).toEqual(['a', 'b'])
    // Echoed, not counted: a host that timed out on frame 1 and moved on has to
    // be able to tell a late reply from the reply to what it is waiting for.
    expect(acks()).toEqual([1, 2])
  })

  it('hands the document body to the draw callback', async () => {
    const onFrame = await load()
    let root: unknown = null
    onFrame((_frame, r) => {
      root = r
    })
    sendFrame('a')
    await Promise.resolve()
    expect(root).toEqual({ id: 'root' })
  })

  it('does not draw the next frame until the current one settles', async () => {
    const onFrame = await load()
    const drawn: number[] = []
    let release: (() => void) | null = null
    onFrame((frame) => {
      drawn.push(frame as number)
      return new Promise<void>((resolve) => {
        release = resolve
      })
    })

    sendFrame(1, 1)
    sendFrame(2, 2)
    sendFrame(3, 3)
    await Promise.resolve()

    // This is the guarantee the whole protocol rests on: three frames arrived
    // together and only one was drawn. Without it an animation is overdrawn by
    // whatever lands next, which is what the host used to have to guess around.
    expect(drawn).toEqual([1])
    expect(acks()).toEqual([])

    release!()
    await Promise.resolve()
    await Promise.resolve()
    expect(drawn).toEqual([1, 2])
    expect(acks()).toEqual([1])
  })

  it('acks immediately when a draw returns nothing', async () => {
    const onFrame = await load()
    // A view with no animation is finished the moment it has drawn, and saying so
    // is what lets a host fit more of a long match into a fixed slot.
    onFrame(() => {}, { paceMs: 0 })
    sendFrame('a', 7)
    await Promise.resolve()
    expect(acks()).toEqual([7])
  })

  it('acks a frame whose draw threw, rather than stalling the queue', async () => {
    const onFrame = await load()
    const drawn: number[] = []
    onFrame((frame) => {
      drawn.push(frame as number)
      if (frame === 1) throw new Error('author bug')
    })

    sendFrame(1, 1)
    sendFrame(2, 2)
    await Promise.resolve()

    // A host waiting on an ack that never comes stops playing entirely, so one
    // bad frame must not be able to take the rest of the match with it.
    expect(drawn).toEqual([1, 2])
    expect(acks()).toEqual([1, 2])
  })

  it('gives up on a promise that never settles instead of wedging the view', async () => {
    vi.useFakeTimers()
    const onFrame = await load()
    const drawn: number[] = []
    onFrame((frame) => {
      drawn.push(frame as number)
      return new Promise<void>(() => {}) // never resolves
    })

    sendFrame(1, 1)
    sendFrame(2, 2)
    await vi.advanceTimersByTimeAsync(14_000)
    expect(acks()).toEqual([])

    await vi.advanceTimersByTimeAsync(2_000)
    expect(acks()).toEqual([1])
    expect(drawn).toEqual([1, 2])
  })

  it('scales a hold by the speed the host asks for', async () => {
    vi.useFakeTimers()
    const mod = await import('../src/view.js')
    let done = false
    mod.onFrame(async () => {
      await mod.hold(2_000)
      done = true
    })

    fromHost({ __arenaView: true, type: 'speed', speed: 4 })
    sendFrame('a', 1)
    await vi.advanceTimersByTimeAsync(400)
    expect(done).toBe(false)

    // 2000ms of authored time at 4x is 500ms of real time. Without this the only
    // way a host could go faster would be to skip frames.
    await vi.advanceTimersByTimeAsync(150)
    expect(done).toBe(true)
    expect(acks()).toEqual([1])
    expect(mod.playbackSpeed()).toBe(4)
  })

  it('clamps a speed a host should not be able to ask for', async () => {
    const mod = await import('../src/view.js')
    mod.onFrame(() => {})

    fromHost({ __arenaView: true, type: 'speed', speed: 0 })
    expect(mod.playbackSpeed()).toBeGreaterThan(0) // 0 would stall every hold forever
    fromHost({ __arenaView: true, type: 'speed', speed: 10_000 })
    expect(mod.playbackSpeed()).toBeLessThanOrEqual(20) // and this would strobe
    fromHost({ __arenaView: true, type: 'speed', speed: Number.NaN })
    expect(Number.isFinite(mod.playbackSpeed())).toBe(true)

    fromHost({ __arenaView: true, type: 'speed', speed: 1 })
    expect(mod.playbackSpeed()).toBe(1)
  })

  it('leaves timings as authored for a host that never mentions speed', async () => {
    vi.useFakeTimers()
    const mod = await import('../src/view.js')
    fromHost({ __arenaView: true, type: 'speed', speed: 1 })
    let done = false
    mod.onFrame(async () => {
      await mod.hold(1_500)
      done = true
    })
    sendFrame('a', 1)
    await vi.advanceTimersByTimeAsync(1_400)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(done).toBe(true)
  })

  it('dwells only when a frame is already waiting behind this one', async () => {
    vi.useFakeTimers()
    const mod = await import('../src/view.js')
    fromHost({ __arenaView: true, type: 'speed', speed: 1 })
    // A 1000ms animation the frame genuinely needs, then 1700ms of padding that
    // only matters when frames are stacking up.
    mod.onFrame(async () => {
      await mod.hold(1_000)
      await mod.dwell(1_700)
    })

    // Nothing behind it: acked as soon as the animation is done. Waiting the
    // extra 1700 anyway made a host that pushes on its own timer fall
    // progressively behind — measured as a play lost every 20 seconds.
    sendFrame('lone', 1)
    await vi.advanceTimersByTimeAsync(1_100)
    expect(acks()).toEqual([1])

    // A frame landing mid-draw IS a backlog, so the padding applies and the
    // burst is slowed to something watchable.
    sendFrame('x', 2)
    await vi.advanceTimersByTimeAsync(500)
    sendFrame('y', 3)
    await vi.advanceTimersByTimeAsync(600) // 'x' animation done, now dwelling
    expect(acks()).toEqual([1])

    await vi.advanceTimersByTimeAsync(1_800)
    expect(acks()).toEqual([1, 2])
  })

  it('ignores frames that did not come from the host', async () => {
    const onFrame = await load()
    const drawn: unknown[] = []
    onFrame((frame) => {
      drawn.push(frame)
    })

    for (const h of handlers) {
      h({ source: { other: true }, data: { __arenaView: true, type: 'frame', frame: 'x' } } as unknown as MessageEvent)
    }
    await Promise.resolve()

    // A view is author code running in a visitor's browser; "there happens to be
    // no other frame right now" is not a property of this file.
    expect(drawn).toEqual([])
    expect(acks()).toEqual([])
  })

  it('ignores host messages that are not frames', async () => {
    const onFrame = await load()
    const drawn: unknown[] = []
    onFrame((frame) => {
      drawn.push(frame)
    })

    fromHost({ __arenaView: true, type: 'players', players: [] })
    fromHost({ type: 'frame', frame: 'unmarked' })
    fromHost(null)
    await Promise.resolve()

    expect(drawn).toEqual([])
  })
})
