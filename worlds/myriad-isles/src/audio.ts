/** Tiny synth: placement plops, score arps, and the settle chord. */

export interface Sfx {
  plop(gained: number): void
  draft(): void
  settle(): void
  setMuted(m: boolean): void
  muted: boolean
  dispose(): void
}

export function makeSfx(getCtx: () => Promise<AudioContext>): Sfx {
  let ac: AudioContext | null = null
  let master: GainNode | null = null
  const ensure = async () => {
    if (ac) return
    ac = await getCtx()
    master = ac.createGain()
    master.gain.value = 0.5
    master.connect(ac.destination)
  }
  const tone = (freq: number, t0: number, dur: number, type: OscillatorType, gain: number, slide = 0) => {
    if (!ac || !master) return
    const o = ac.createOscillator()
    const g = ac.createGain()
    o.type = type
    o.frequency.setValueAtTime(freq, t0)
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur)
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
    o.connect(g).connect(master)
    o.start(t0)
    o.stop(t0 + dur + 0.05)
  }
  const api: Sfx = {
    muted: false,
    setMuted(m) {
      api.muted = m
      if (master) master.gain.value = m ? 0 : 0.5
    },
    plop(gained) {
      void ensure().then(() => {
        if (!ac) return
        const t = ac.currentTime
        tone(300, t, 0.12, 'sine', 0.35, -140)
        if (gained > 0) {
          const notes = [523, 659, 784].slice(0, Math.min(3, 1 + Math.floor(gained / 5)))
          notes.forEach((f, i) => tone(f, t + 0.07 + i * 0.06, 0.1, 'triangle', 0.16))
        } else if (gained < 0) {
          tone(130, t + 0.06, 0.2, 'square', 0.1)
        }
      })
    },
    draft() {
      void ensure().then(() => {
        if (!ac) return
        const t = ac.currentTime
        tone(392, t, 0.14, 'triangle', 0.15)
        tone(523, t + 0.08, 0.16, 'triangle', 0.15)
      })
    },
    settle() {
      void ensure().then(() => {
        if (!ac) return
        const t = ac.currentTime
        ;[262, 330, 392, 523].forEach((f, i) => tone(f, t + i * 0.05, 1.6, 'sine', 0.12))
        tone(1046, t + 0.4, 0.8, 'triangle', 0.05)
      })
    },
    dispose() {
      if (ac) void ac.close().catch(() => undefined)
      ac = null
    },
  }
  return api
}
