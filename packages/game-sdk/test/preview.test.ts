import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fetchAsDataUri, inlineAvatars } from '../src/preview.js'
import type { PlayerInfo } from '../src/types.js'

const player = (over: Partial<PlayerInfo>): PlayerInfo => ({ seat: 0, agentId: 'a', name: 'A', ...over })

const okBlob = (bytes: string, type: string) =>
  ({ ok: true, blob: async () => new Blob([bytes], { type }) }) as unknown as Response

/**
 * Node has no `FileReader`, and the SDK deliberately carries no DOM test env
 * (nothing else here needs one). Stub the two calls `fetchAsDataUri` makes so the
 * real code path — fetch → blob → readAsDataURL — is exercised without jsdom.
 */
class StubFileReader {
  result: string | null = null
  onloadend: (() => void) | null = null
  onerror: (() => void) | null = null
  readAsDataURL(blob: Blob): void {
    void blob
      .text()
      .then((text) => {
        this.result = `data:${blob.type};base64,${Buffer.from(text).toString('base64')}`
        this.onloadend?.()
      })
      .catch(() => this.onerror?.())
  }
}

describe('inlineAvatars', () => {
  beforeEach(() => {
    vi.stubGlobal('FileReader', StubFileReader)
    vi.spyOn(globalThis, 'fetch')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('inlines a remote avatar as a data: URI', async () => {
    vi.mocked(fetch).mockResolvedValue(okBlob('<svg/>', 'image/svg+xml'))
    const out = await inlineAvatars([player({ avatar: 'https://cdn.example/a.svg' })])
    expect(out[0]!.avatar).toBe(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`)
  })

  it('passes an already-inlined avatar through without fetching', async () => {
    const out = await inlineAvatars([player({ avatar: 'data:image/png;base64,AAAA' })])
    expect(out[0]!.avatar).toBe('data:image/png;base64,AAAA')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('leaves a seat with no avatar alone', async () => {
    const out = await inlineAvatars([player({})])
    expect(out[0]!.avatar).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  // The safety property: on failure the avatar must NOT survive as the raw https
  // URL, or the view would render an <img> the sandbox CSP blocks.
  it('drops the avatar when the fetch fails', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'))
    const out = await inlineAvatars([player({ avatar: 'https://cdn.example/a.svg' })])
    expect(out[0]!.avatar).toBeUndefined()
  })

  it('drops the avatar on a non-ok response', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response)
    expect(await fetchAsDataUri('https://cdn.example/a.svg')).toBeNull()
  })

  it('one failure does not block the other seats', async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(okBlob('ok', 'image/png'))
    const out = await inlineAvatars([
      player({ seat: 0, avatar: 'https://cdn.example/bad.svg' }),
      player({ seat: 1, agentId: 'b', name: 'B', avatar: 'https://cdn.example/good.png' }),
    ])
    expect(out[0]!.avatar).toBeUndefined()
    expect(out[1]!.avatar).toBe(`data:image/png;base64,${Buffer.from('ok').toString('base64')}`)
  })
})
