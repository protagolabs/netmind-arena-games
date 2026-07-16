/**
 * @arena/game-sdk/theme — the Arena platform's visual tokens.
 *
 * T1 (declarative) renders are drawn by the platform and are automatically
 * on-theme. T2 (your own `view.ts`) is yours to style — import these so your
 * renderer matches the rest of Arena (dark, red-black, crimson accents). Using
 * them is a SHOULD, not a MUST: your view can look however you like.
 *
 * ```ts
 * import { ARENA_THEME } from '@arena/game-sdk/theme'
 * ctx.fillStyle = ARENA_THEME.board.wood
 * ```
 */
export const ARENA_THEME = {
  /** Page background inside the sandboxed view iframe. */
  bg: '#0b0b0f',
  /** Card / panel surface. */
  surface: '#16161a',
  /** Primary text. */
  fg: '#f5f5f5',
  /** Secondary / muted text. */
  fgSubtle: '#a1a1aa',
  /** Hairline borders. */
  border: 'rgba(255,255,255,0.10)',
  /** Brand accent (crimson) — highlights, active state, winners. */
  accent: '#e5484d',
  /** Text on top of the accent colour. */
  accentFg: '#ffffff',
  /** Marker for the most recent move. */
  lastMove: '#ef4444',
  /** Board (go/xiangqi/gomoku) surface + lines. */
  board: {
    wood: '#c8a06a',
    line: 'rgba(40,25,10,0.7)',
    star: 'rgba(40,25,10,0.85)',
  },
  /**
   * Default per-seat colours, seat-indexed. Board games conventionally encode a
   * seat's piece as cell code `seat+1`, so `stones[seat]` is that piece's colour.
   * Seats 0/1 are the classic black/white; 2/3 extend for 3–4 player games.
   */
  stones: ['#111827', '#f8fafc', '#e5484d', '#4c9aff'] as const,
  /** UI font stack. */
  font: 'system-ui, -apple-system, "Segoe UI", sans-serif',
} as const

export type ArenaTheme = typeof ARENA_THEME
