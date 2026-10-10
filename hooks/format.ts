// Compact figures for ClaudeRouter: 124k, 1.0M, 1:02

export function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

export function fmtTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function fmtFit(text: string, n: number): string {
  return text.length <= n ? text : `${text.slice(0, n - 1)}…`
}

export function fmtPct(p: number | null | undefined): string {
  return p === null || p === undefined ? '—' : `${Math.round(p)}%`
}
