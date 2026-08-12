/**
 * Tiny sine synth for landing chimes and bells. Created lazily on the first
 * user gesture; every call is a no-op while `enabled` is false.
 */

export const PENTA = [392, 440, 523, 587, 659, 784, 880]

export class Synth {
  enabled = false
  private ac: AudioContext | null = null

  chime(freq: number, vol: number, dur = 0.8): void {
    if (!this.enabled) return
    try {
      this.ac = this.ac ?? new AudioContext()
      const ac = this.ac
      if (ac.state === 'suspended') void ac.resume()
      const osc = ac.createOscillator()
      const gain = ac.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.value = 0
      osc.connect(gain)
      gain.connect(ac.destination)
      const now = ac.currentTime
      gain.gain.linearRampToValueAtTime(vol, now + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + dur)
      osc.start(now)
      osc.stop(now + dur + 0.05)
    } catch {
      /* audio is never worth an error surface */
    }
  }
}
