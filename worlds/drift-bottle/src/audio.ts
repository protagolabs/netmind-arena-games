/**
 * The sound of the world, synthesised on the spot.
 *
 * Nothing here loads a resource: `connect-src 'none'` means a world cannot fetch
 * a wave loop, and inlining one as a `data:` URI would cost more bytes than the
 * whole document. Surf is filtered noise with a slow swell on it; every effect is
 * an envelope over an oscillator or a noise burst.
 *
 * `ctx.audio()` only resolves after a genuine gesture inside the frame — a
 * sandboxed iframe cannot inherit the host page's activation — so {@link ready}
 * stays false until then, the world says so in the corner, and everything
 * degrades to silence rather than to a broken control.
 */
export class SeaSound {
  /** Reflects the visitor's preference, which is remembered in `ctx.local`. */
  enabled = true
  /** True once a gesture has actually produced an AudioContext. */
  ready = false

  private ac: AudioContext | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null
  private pending: Promise<void> | null = null

  constructor(
    private readonly open: () => Promise<AudioContext>,
    private readonly onReady: () => void,
  ) {}

  /**
   * Ask for the context. Safe to call before any gesture: the promise simply
   * stays pending until one happens, and calling again returns the same wait.
   */
  unlock(): void {
    if (this.ac || this.pending) return
    this.pending = this.open()
      .then((ac) => {
        this.ac = ac
        this.master = ac.createGain()
        this.master.gain.value = this.enabled ? 1 : 0
        this.master.connect(ac.destination)
        this.noise = makeNoise(ac)
        this.startSurf()
        this.ready = true
        this.onReady()
      })
      .catch(() => {
        /* no audio in this browser; the world is still complete without it */
      })
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    if (!this.master || !this.ac) return
    const now = this.ac.currentTime
    this.master.gain.cancelScheduledValues(now)
    this.master.gain.setTargetAtTime(on ? 1 : 0, now, 0.25)
  }

  /* ───────────────────────── the effects ───────────────────────── */

  /** A bottle hitting water: a bright break, then a low body of displaced water. */
  splash(): void {
    const ac = this.live()
    if (!ac) return
    const t = ac.currentTime

    const burst = ac.createBufferSource()
    burst.buffer = this.noise
    const band = ac.createBiquadFilter()
    band.type = 'bandpass'
    band.Q.value = 1.1
    band.frequency.setValueAtTime(2200, t)
    band.frequency.exponentialRampToValueAtTime(320, t + 0.45)
    const g = ac.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5)
    burst.connect(band).connect(g).connect(this.master!)
    burst.start(t)
    burst.stop(t + 0.55)

    this.tone('sine', 190, 70, t, 0.34, 0.22)
  }

  /** Rope and water: three bubbles rising as the bottle comes up. */
  haul(): void {
    const ac = this.live()
    if (!ac) return
    const t = ac.currentTime
    for (let i = 0; i < 3; i++) {
      const at = t + i * 0.11
      this.tone('sine', 260 + i * 90, 700 + i * 260, at, 0.14, 0.09)
    }
    const swirl = ac.createBufferSource()
    swirl.buffer = this.noise
    const lp = ac.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(500, t)
    lp.frequency.exponentialRampToValueAtTime(1800, t + 0.35)
    const g = ac.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.08)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42)
    swirl.connect(lp).connect(g).connect(this.master!)
    swirl.start(t)
    swirl.stop(t + 0.45)
  }

  /** The cork. */
  pop(): void {
    const ac = this.live()
    if (!ac) return
    this.tone('sine', 420, 1250, ac.currentTime, 0.07, 0.3)
  }

  /** A reply arriving, or leaving: a small two-note chime over the water. */
  chime(): void {
    const ac = this.live()
    if (!ac) return
    const t = ac.currentTime
    this.tone('sine', 932, 932, t, 0.9, 0.16)
    this.tone('sine', 1244, 1244, t + 0.07, 1.1, 0.11)
    this.tone('sine', 1864, 1864, t + 0.07, 0.7, 0.05)
  }

  /** Glass giving way. */
  shatter(): void {
    const ac = this.live()
    if (!ac) return
    const t = ac.currentTime
    const burst = ac.createBufferSource()
    burst.buffer = this.noise
    const hp = ac.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 2600
    const g = ac.createGain()
    g.gain.setValueAtTime(0.28, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3)
    burst.connect(hp).connect(g).connect(this.master!)
    burst.start(t)
    burst.stop(t + 0.32)
  }

  /** Interface feedback, quiet enough to live under everything else. */
  tick(): void {
    const ac = this.live()
    if (!ac) return
    this.tone('triangle', 880, 660, ac.currentTime, 0.05, 0.06)
  }

  /* ───────────────────────── plumbing ───────────────────────── */

  private live(): AudioContext | null {
    return this.enabled && this.ac && this.master ? this.ac : null
  }

  private tone(type: OscillatorType, from: number, to: number, at: number, dur: number, peak: number): void {
    const ac = this.ac!
    const osc = ac.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(from, at)
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, at + dur)
    const g = ac.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.exponentialRampToValueAtTime(peak, at + Math.min(0.02, dur / 3))
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur)
    osc.connect(g).connect(this.master!)
    osc.start(at)
    osc.stop(at + dur + 0.02)
  }

  /**
   * Continuous surf: brown-ish noise under a lowpass, with a slow LFO on both
   * the cutoff and the gain so it breathes instead of hissing. It runs for the
   * life of the document; the master gain is what the toggle actually moves.
   */
  private startSurf(): void {
    const ac = this.ac!
    const src = ac.createBufferSource()
    src.buffer = this.noise
    src.loop = true

    const lp = ac.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 420
    lp.Q.value = 0.4

    const gain = ac.createGain()
    gain.gain.value = 0.05

    // Two swells at different speeds, so the pattern does not audibly repeat.
    for (const [rate, depth, target] of [
      [0.06, 0.028, gain.gain],
      [0.017, 0.018, gain.gain],
      [0.043, 160, lp.frequency],
    ] as [number, number, AudioParam][]) {
      const lfo = ac.createOscillator()
      lfo.frequency.value = rate
      const amp = ac.createGain()
      amp.gain.value = depth
      lfo.connect(amp).connect(target)
      lfo.start()
    }

    src.connect(lp).connect(gain).connect(this.master!)
    src.start()
  }
}

/** Six seconds of noise, low-passed by integration so it reads as water. */
function makeNoise(ac: AudioContext): AudioBuffer {
  const len = ac.sampleRate * 6
  const buf = ac.createBuffer(1, len, ac.sampleRate)
  const data = buf.getChannelData(0)
  let last = 0
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1
    last = (last + 0.02 * white) / 1.02
    data[i] = last * 3.2
  }
  return buf
}
