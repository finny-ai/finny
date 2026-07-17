function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!)
}

function scale(values: number[], range: { min: number; max: number; outMin: number; outMax: number }): number[] {
  const { min, max, outMin, outMax } = range
  const span = max - min
  if (!Number.isFinite(span) || Math.abs(span) < 1e-12) return values.map(() => (outMin + outMax) / 2)
  return values.map((v) => outMin + ((v - min) / span) * (outMax - outMin))
}

export function svgLineChart(series: Array<{ label: string; values: number[]; color: string }>, width = 720, height = 260): string {
  const all = series.flatMap((s) => s.values).filter(Number.isFinite)
  const min = Math.min(...all, 0)
  const max = Math.max(...all, 1)
  const pad = 28
  const body = series.map((s) => {
    const xs = scale(s.values.map((_, i) => i), { min: 0, max: Math.max(1, s.values.length - 1), outMin: pad, outMax: width - pad })
    const ys = scale(s.values, { min, max, outMin: height - pad, outMax: pad })
    const points = xs.map((x, i) => `${x.toFixed(1)},${ys[i]!.toFixed(1)}`).join(" ")
    return `<polyline fill="none" stroke="${esc(s.color)}" stroke-width="2" points="${points}"><title>${esc(s.label)}</title></polyline>`
  }).join("")
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="line chart"><rect width="${width}" height="${height}" fill="#fff"/><line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="#ccd"/><line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" stroke="#ccd"/>${body}</svg>`
}

export function svgAreaChart(values: number[], width = 720, height = 220): string {
  const clean = values.filter(Number.isFinite)
  const min = Math.min(...clean, 0)
  const pad = 24
  const xs = scale(values.map((_, i) => i), { min: 0, max: Math.max(1, values.length - 1), outMin: pad, outMax: width - pad })
  const yRange = { min, max: 0, outMin: height - pad, outMax: pad }
  const ys = scale(values, yRange)
  const zero = scale([0], yRange)[0]!
  const points = xs.map((x, i) => `${x.toFixed(1)},${ys[i]!.toFixed(1)}`).join(" ")
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="drawdown chart"><rect width="${width}" height="${height}" fill="#fff"/><polygon fill="#d84a4a33" stroke="#b72d2d" points="${pad},${zero.toFixed(1)} ${points} ${width - pad},${zero.toFixed(1)}"/><line x1="${pad}" y1="${zero.toFixed(1)}" x2="${width - pad}" y2="${zero.toFixed(1)}" stroke="#667"/></svg>`
}

export function svgBarChart(values: number[], width = 720, height = 220): string {
  const maxAbs = Math.max(1, ...values.map((v) => Math.abs(v)).filter(Number.isFinite))
  const pad = 26
  const zero = height / 2
  const slot = (width - pad * 2) / Math.max(1, values.length)
  const bars = values.map((v, i) => {
    const h = Math.abs(v) / maxAbs * (height / 2 - pad)
    const x = pad + i * slot + slot * 0.15
    const y = v >= 0 ? zero - h : zero
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(slot * 0.7).toFixed(1)}" height="${h.toFixed(1)}" fill="${v >= 0 ? "#227a4b" : "#b72d2d"}"><title>Fold ${i + 1}: ${v.toFixed(2)}</title></rect>`
  }).join("")
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="bar chart"><rect width="${width}" height="${height}" fill="#fff"/><line x1="${pad}" y1="${zero}" x2="${width - pad}" y2="${zero}" stroke="#667"/>${bars}</svg>`
}

export function svgHeatmap(monthly: Record<string, Record<string, number>>, width = 720, cell = 28): string {
  const years = Object.keys(monthly).sort()
  const height = Math.max(1, years.length) * (cell + 8) + 28
  const rects = years.map((year, yi) => {
    return Array.from({ length: 12 }, (_, mi) => {
      const month = String(mi + 1).padStart(2, "0")
      const value = monthly[year]?.[month]
      const intensity = value == null ? 0 : Math.min(1, Math.abs(value) / 0.1)
      const fill = value == null ? "#eef0f3" : value >= 0 ? `rgba(34,122,75,${0.18 + intensity * 0.72})` : `rgba(183,45,45,${0.18 + intensity * 0.72})`
      return `<rect x="${80 + mi * (cell + 4)}" y="${20 + yi * (cell + 8)}" width="${cell}" height="${cell}" fill="${fill}"><title>${year}-${month}: ${value == null ? "N/A" : (value * 100).toFixed(2) + "%"}</title></rect>`
    }).join("") + `<text x="12" y="${39 + yi * (cell + 8)}" font-size="12" fill="#333">${esc(year)}</text>`
  }).join("")
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="monthly heatmap"><rect width="${width}" height="${height}" fill="#fff"/>${rects}</svg>`
}

export function svgReportLineChart(input: {
  series: Array<{ label: string; values: number[]; color: string }>
  labels?: string[]
  format?: "percent" | "ratio" | "number"
  width?: number
  height?: number
}): string {
  const width = input.width ?? 640
  const height = input.height ?? 170
  const pad = { left: 52, right: 16, top: 24, bottom: 34 }
  const all = input.series.flatMap((item) => item.values).filter(Number.isFinite)
  if (!all.length) return `<p class="empty">No meaningful series available.</p>`
  const rawMin = Math.min(...all)
  const rawMax = Math.max(...all)
  const margin = rawMin === rawMax ? Math.max(Math.abs(rawMin) * 0.1, 1) : (rawMax - rawMin) * 0.08
  const min = Math.min(rawMin - margin, 0)
  const max = Math.max(rawMax + margin, 0)
  const plotWidth = width - pad.left - pad.right
  const plotHeight = height - pad.top - pad.bottom
  const x = (index: number, count: number) => pad.left + (count <= 1 ? plotWidth / 2 : index / (count - 1) * plotWidth)
  const y = (value: number) => pad.top + (max - value) / Math.max(max - min, 1e-12) * plotHeight
  const formatted = (value: number) => input.format === "percent" ? `${(value * 100).toFixed(1)}%` : input.format === "ratio" ? value.toFixed(2) : value.toLocaleString(undefined, { maximumFractionDigits: 1 })
  const ticks = [min, (min + max) / 2, max]
  const axes = ticks.map((tick) => `<line x1="${pad.left}" y1="${y(tick).toFixed(1)}" x2="${width - pad.right}" y2="${y(tick).toFixed(1)}" stroke="#e4e1da"/><text x="${pad.left - 7}" y="${(y(tick) + 4).toFixed(1)}" text-anchor="end">${esc(formatted(tick))}</text>`).join("")
  const zero = min <= 0 && max >= 0 ? `<line class="baseline" x1="${pad.left}" y1="${y(0).toFixed(1)}" x2="${width - pad.right}" y2="${y(0).toFixed(1)}"/>` : ""
  const bodies = input.series.map((item) => {
    const points = item.values.map((value, index) => `${x(index, item.values.length).toFixed(1)},${y(value).toFixed(1)}`)
    const shape = points.length === 1
      ? `<circle cx="${points[0]!.split(",")[0]}" cy="${points[0]!.split(",")[1]}" r="4" fill="${esc(item.color)}"/>`
      : `<polyline fill="none" stroke="${esc(item.color)}" stroke-width="2" points="${points.join(" ")}"/>`
    return `${shape}<title>${esc(item.label)}</title>`
  }).join("")
  const count = Math.max(...input.series.map((item) => item.values.length))
  const labelAt = (index: number) => input.labels?.[index] ?? String(index + 1)
  const xLabels = count ? [0, Math.max(0, Math.floor((count - 1) / 2)), count - 1].filter((value, index, items) => items.indexOf(value) === index).map((index) => `<text x="${x(index, count).toFixed(1)}" y="${height - 10}" text-anchor="middle">${esc(labelAt(index))}</text>`).join("") : ""
  const legend = input.series.map((item, index) => `<g transform="translate(${pad.left + index * 130},12)"><line x2="18" stroke="${esc(item.color)}" stroke-width="2"/><text x="24" y="4">${esc(item.label)}</text></g>`).join("")
  return `<svg class="report-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(input.series.map((item) => item.label).join(" and "))}">${axes}${zero}${bodies}${xLabels}${legend}</svg>`
}

const BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

export function sparkline(values: number[]): string {
  const clean = values.filter(Number.isFinite)
  if (clean.length === 0) return "n/a"
  const min = Math.min(...clean)
  const max = Math.max(...clean)
  if (Math.abs(max - min) < 1e-12) return "▅".repeat(Math.min(24, values.length))
  return values.slice(-48).map((v) => BARS[Math.max(0, Math.min(BARS.length - 1, Math.round(((v - min) / (max - min)) * (BARS.length - 1))))]).join("")
}
