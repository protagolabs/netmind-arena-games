import { describe, it, expect } from 'vitest'
import { makeCtx } from '@arena/game-sdk'
import game from '../src/sealed.game'

// Mid-game: A has picked 7, B has not — A's pick is secret until B plays.
function midState() {
  let s = game.init({ players: ['A', 'B'] }, makeCtx({ seed: 1 }))
  s = { ...s, side: 0 }
  return game.reduce!(s, { pick: 7 }, makeCtx({ seed: 1, actor: 'A' }))
}

describe('sealed · viewer-scoped render (hidden info)', () => {
  it('A sees own pick; B and the public must NOT see it', () => {
    const s = midState()
    const forA = JSON.stringify(game.render!(s, { viewer: 'A' }))
    const forB = JSON.stringify(game.render!(s, { viewer: 'B' }))
    const pub = JSON.stringify(game.render!(s))
    expect(forA).toContain('"value":"7"') // A sees their own card
    expect(forB).not.toContain('7') // B cannot see A's secret
    expect(pub).not.toContain('7') // spectator cannot either
  })

  it('reveals both cards after both pick', () => {
    let s = midState()
    s = game.reduce!(s, { pick: 3 }, makeCtx({ seed: 1, actor: 'B' }))
    expect(game.terminal!(s).done).toBe(true)
    expect(game.terminal!(s).winner).toBe('A')
    const pub = JSON.stringify(game.render!(s))
    expect(pub).toContain('"value":"7"')
    expect(pub).toContain('"value":"3"')
  })

  it('rejects out-of-turn and out-of-range picks', () => {
    let s = game.init({ players: ['A', 'B'] }, makeCtx({ seed: 1 }))
    s = { ...s, side: 0 }
    expect(() => game.reduce!(s, { pick: 5 }, makeCtx({ seed: 1, actor: 'B' }))).toThrow(/not-your-turn/)
    expect(() => game.reduce!(s, { pick: 99 }, makeCtx({ seed: 1, actor: 'A' }))).toThrow(/pick-1-9/)
  })
})
