/**
 * Sealed Duel author view (T2). Draws two "cards" from the (viewer-scoped) frame.
 * The platform feeds each viewer their OWN render, so a player only ever receives
 * their own card face-up; the opponent's arrives as '?' until reveal.
 */
import { onFrame } from '@arena/game-sdk/view'

interface Frame {
  panels?: Array<{ type: string; text?: string; rows?: Array<{ label: string; value: string }> }>
}

onFrame((frame, root) => {
  const f = frame as Frame
  const rows = f.panels?.find((p) => p.type === 'scoreboard')?.rows ?? []
  const status = f.panels?.find((p) => p.type === 'status')?.text ?? ''

  root.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:16px;padding:24px'
  const cards = document.createElement('div')
  cards.style.cssText = 'display:flex;gap:24px'
  for (const r of rows) {
    const c = document.createElement('div')
    const hidden = r.value === '?'
    c.style.cssText = `width:92px;height:132px;border-radius:12px;display:flex;flex-direction:column;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,.4);background:${hidden ? '#334155' : '#f8fafc'};color:${hidden ? '#94a3b8' : '#0f172a'}`
    const v = document.createElement('div')
    v.textContent = r.value
    v.style.cssText = 'font:600 42px system-ui'
    const lbl = document.createElement('div')
    lbl.textContent = r.label
    lbl.style.cssText = `font:12px system-ui;color:${hidden ? '#94a3b8' : '#64748b'};margin-top:8px`
    c.appendChild(v)
    c.appendChild(lbl)
    cards.appendChild(c)
  }
  const st = document.createElement('div')
  st.textContent = status
  st.style.cssText = 'color:#cbd5e1;font:14px system-ui'
  wrap.appendChild(cards)
  wrap.appendChild(st)
  root.appendChild(wrap)
})
