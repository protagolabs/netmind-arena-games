/**
 * Everything here is synthesised — the sandbox has no network, and no sample
 * says "deep water" better than three detuned sines under a lowpass anyway.
 * The AudioContext arrives from `ctx.audio()` after a real user gesture.
 */

const PENTA = [0, 3, 5, 7, 10, 12, 15, 17] // minor pentatonic steps

export class Synth {
  private ac: AudioContext
  private master: GainNode
  private padGain: GainNode
  private padFilter: BiquadFilterNode
  private padOscs: OscillatorNode[] = []
  private padBase = 55
  private enabled = true

  constructor(ac: AudioContext) {
    this.ac = ac
    this.master = ac.createGain()
    this.master.gain.value = 0
    this.master.connect(ac.destination)

    this.padFilter = ac.createBiquadFilter()
    this.padFilter.type = 'lowpass'
    this.padFilter.frequency.value = 320
    this.padFilter.Q.value = 0.6

    this.padGain = ac.createGain()
    this.padGain.gain.value = 0.05
    this.padFilter.connect(this.padGain)
    this.padGain.connect(this.master)

    // Three slow detuned layers: a root, a fifth, and a shimmering octave.
    for (const [mult, detune, level] of [
      [1, -4, 0.5],
      [1.5, 3, 0.22],
      [2, 7, 0.14],
    ] as const) {
      const osc = ac.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = this.padBase * mult
      osc.detune.value = detune
      const g = ac.createGain()
      g.gain.value = level
      osc.connect(g)
      g.connect(this.padFilter)
      osc.start()
      this.padOscs.push(osc)
    }

    const lfo = ac.createOscillator()
    lfo.frequency.value = 0.05
    const lfoGain = ac.createGain()
    lfoGain.gain.value = 90
    lfo.connect(lfoGain)
    lfoGain.connect(this.padFilter.frequency)
    lfo.start()

    this.master.gain.setTargetAtTime(0.8, ac.currentTime, 2.5)
  }

  setEnabled(on: boolean) {
    this.enabled = on
    this.master.gain.setTargetAtTime(on ? 0.8 : 0, this.ac.currentTime, 0.3)
  }

  private lastDepth = -1

  /** Depth 0..1 darkens the drone: lower root, dimmer filter, sparser air. */
  setDepth(depth: number) {
    if (Math.abs(depth - this.lastDepth) < 0.02) return // called per frame; reschedule sparingly
    this.lastDepth = depth
    const t = this.ac.currentTime
    const root = 55 * Math.pow(2, -depth * 0.8)
    this.padOscs[0]?.frequency.setTargetAtTime(root, t, 3)
    this.padOscs[1]?.frequency.setTargetAtTime(root * 1.5, t, 3)
    this.padOscs[2]?.frequency.setTargetAtTime(root * 2, t, 3)
    this.padFilter.frequency.setTargetAtTime(340 - depth * 220, t, 3)
    this.padGain.gain.setTargetAtTime(0.05 + depth * 0.025, t, 3)
  }

  private pluck(freq: number, vol: number, dur: number, type: OscillatorType = 'sine') {
    if (!this.enabled) return
    const t = this.ac.currentTime
    const osc = this.ac.createOscillator()
    osc.type = type
    osc.frequency.value = freq
    const g = this.ac.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(vol, t + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0004, t + dur)
    osc.connect(g)
    g.connect(this.master)
    osc.start(t)
    osc.stop(t + dur + 0.05)
  }

  /** Swallowing a mote: pentatonic droplet, pitch climbing with the streak. */
  eat(streak: number) {
    const step = PENTA[Math.min(PENTA.length - 1, streak % PENTA.length)]
    const freq = 440 * Math.pow(2, step / 12)
    this.pluck(freq, 0.11, 0.5)
    this.pluck(freq * 2, 0.03, 0.3)
  }

  sting() {
    this.pluck(180, 0.1, 0.3, 'triangle')
    this.pluck(120, 0.08, 0.5, 'sine')
  }

  evolve() {
    const t0 = this.ac.currentTime
    ;[0, 4, 7, 12].forEach((step, i) => {
      const osc = this.ac.createOscillator()
      osc.frequency.value = 330 * Math.pow(2, step / 12)
      const g = this.ac.createGain()
      const at = t0 + i * 0.09
      g.gain.setValueAtTime(0, at)
      g.gain.linearRampToValueAtTime(this.enabled ? 0.07 : 0, at + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0004, at + 1.4)
      osc.connect(g)
      g.connect(this.master)
      osc.start(at)
      osc.stop(at + 1.5)
    })
  }

  /** Release: a long swelling chord that hands the creature to the garden. */
  release() {
    if (!this.enabled) return
    const t0 = this.ac.currentTime
    ;[0, 7, 12, 19].forEach((step) => {
      const osc = this.ac.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = 220 * Math.pow(2, step / 12)
      const g = this.ac.createGain()
      g.gain.setValueAtTime(0, t0)
      g.gain.linearRampToValueAtTime(0.055, t0 + 1.6)
      g.gain.exponentialRampToValueAtTime(0.0004, t0 + 5)
      osc.connect(g)
      g.connect(this.master)
      osc.start(t0)
      osc.stop(t0 + 5.2)
    })
    for (let i = 0; i < 6; i++) {
      const step = PENTA[i % PENTA.length] + 24
      setTimeout(() => this.pluck(220 * Math.pow(2, step / 12), 0.04, 1.2), 400 + i * 260)
    }
  }

  resonate() {
    this.pluck(660, 0.07, 1.1)
    this.pluck(990, 0.035, 1.6)
  }

  uiTick() {
    this.pluck(520, 0.03, 0.12, 'triangle')
  }
}
