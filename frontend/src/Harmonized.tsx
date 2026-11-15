import { useEffect, useState } from 'react'
import './Harmonized.css'

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

const METRICS = ['Active Fire Cells', 'Total FRP', 'Max FRP', 'VIIRS-only Cells'] as const
type Metric = (typeof METRICS)[number]
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const CAL_COLORS = ['#FFFBF5', '#FEF3C7', '#FDE68A', '#FDBA74', '#FB923C', '#EA580C', '#9A3412']
const DISPLAY_NAMES: Record<string, string> = { BR: 'Brazil', US: 'USA' }

interface YearRow {
  year: number
  cells: number
  frp_total: number
  frp_max: number
  viirs_cells: number
}
interface TopRow {
  date: string
  cells: number
  frp: number
  max: number
}
interface Payload {
  complete: boolean
  country: string
  country_name: string
  year: number
  years: number[]
  archive_range: string
  yearly: YearRow[]
  average_cells: number
  monthly_avg: number[]
  daily: { date: string; cells: number; raw_modis: number; raw_viirs: number }[]
  monthly: number[]
  weekly: number[][]
  top10: TopRow[]
  peak: { date: string; cells: number } | null
  kpis: { cells: number; frp_total: number; viirs_cells: number }
  sensor_split: { both: number; viirs_only: number; modis_only: number }
  overlap_ratio: number
  overlap_months: number
  verdict: { pct: number; above: boolean; prior_cells: number | null; peak_month: number }
  coverage_note: string
}

function fmt(n: number) {
  return Math.round(n).toLocaleString('en-US')
}
function compact(n: number) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`
  return `${Math.round(n)}`
}
function metricValue(r: YearRow, metric: Metric): number {
  if (metric === 'Total FRP') return r.frp_total
  if (metric === 'Max FRP') return r.frp_max
  if (metric === 'VIIRS-only Cells') return r.viirs_cells
  return r.cells
}
function metricLabel(v: number, metric: Metric): string {
  if (metric === 'Total FRP') return `${(v / 1000000).toFixed(1)}M MW`
  if (metric === 'Max FRP') return `${Math.round(v).toLocaleString('en-US')} MW`
  return `${compact(v)} cells`
}
function prettyDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return `${MONTHS[(m ?? 1) - 1]} ${d}, ${y}`
}

function DailyChart({ series, year }: { series: Payload['daily']; year: number }) {
  const W = 720
  const H = 260
  const ML = 52
  const MB = 26
  const MT = 10
  const PW = W - ML - 8
  const PH = H - MT - MB
  const isLeap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInYear = isLeap ? 366 : 365
  const byDate = new Map(series.map((d) => [d.date, d]))
  const start = Date.parse(`${year}-01-01T00:00:00Z`)
  const pts: { x: number; m: number; v: number; c: number; label: string }[] = []
  for (let i = 0; i < daysInYear; i++) {
    const dt = new Date(start + i * 86400000).toISOString().slice(0, 10)
    const d = byDate.get(dt)
    pts.push({ x: i, m: d?.raw_modis ?? 0, v: d?.raw_viirs ?? 0, c: d?.cells ?? 0, label: dt })
  }
  const yMax = Math.max(1, ...pts.map((p) => Math.max(p.m, p.v, p.c)))
  const X = (i: number) => ML + (i / (daysInYear - 1)) * PW
  const Y = (v: number) => MT + PH - (v / yMax) * PH
  const line = (pick: (p: (typeof pts)[number]) => number) =>
    pts.map((p, i) => `${X(i).toFixed(1)},${Y(pick(p)).toFixed(1)}`).join(' ')
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="hz-daily-svg" role="img" aria-label={`Daily raw and harmonized counts for ${year}`}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={ML} x2={W - 8} y1={Y(t * yMax)} y2={Y(t * yMax)} stroke="var(--line2)" strokeWidth="1" />
          <text x={ML - 6} y={Y(t * yMax) + 4} textAnchor="end" fontSize="11" fill="var(--ink3)" fontFamily="IBM Plex Mono,monospace">
            {compact(t * yMax)}
          </text>
        </g>
      ))}
      {MONTHS.map((m, i) => {
        const first = pts.findIndex((p) => p.label.slice(0, 7) === `${year}-${String(i + 1).padStart(2, '0')}`)
        if (first < 0) return null
        return (
          <text key={m} x={X(first)} y={H - 8} fontSize="11" fill="var(--ink3)" fontFamily="IBM Plex Mono,monospace">
            {m}
          </text>
        )
      })}
      <polyline points={line((p) => p.m)} fill="none" stroke="#3B82F6" strokeWidth="2" />
      <polyline points={line((p) => p.v)} fill="none" stroke="#F59E0B" strokeWidth="2.5" />
      <polyline points={line((p) => p.c)} fill="none" stroke="var(--green)" strokeWidth="3" />
    </svg>
  )
}

export default function HarmonizedView() {
  const [countries, setCountries] = useState<{ code: string; name: string }[]>([])
  const [country, setCountry] = useState('BR')
  const [year, setYear] = useState<number | null>(null)
  const [yearFilter, setYearFilter] = useState<number[]>([])
  const [yearOpen, setYearOpen] = useState(false)
  const [metric, setMetric] = useState<Metric>('Active Fire Cells')
  const [compare, setCompare] = useState<'Off' | 'Avg'>('Off')
  const [sortKey, setSortKey] = useState<'cells' | 'frp' | 'max' | 'date'>('cells')
  const [sortDir, setSortDir] = useState<1 | -1>(-1)
  const [selectedDay, setSelectedDay] = useState(0)
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`${API_BASE}/harmonized/years`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Backend returned ${res.status}`)
        return (await res.json()) as { years: number[]; countries: { code: string; name: string }[] }
      })
      .then((m) => {
        if (cancelled) return
        setCountries(m.countries)
        if (!m.countries.some((c) => c.code === country)) setCountry(m.countries[0]?.code ?? 'BR')
      })
      .catch(() => {
        if (!cancelled) setCountries([{ code: 'BR', name: 'Brazil' }, { code: 'US', name: 'United States' }])
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let cancelled = false
    const ctrl = new AbortController()
    const timer = window.setTimeout(() => ctrl.abort(), 60000)
    setLoading(true)
    setError(null)
    const q = year === null ? '' : `&year=${year}`
    fetch(`${API_BASE}/harmonized?country=${country}${q}`, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.text()
          let msg = body.slice(0, 300) || `Backend returned ${res.status}`
          try {
            const parsed = JSON.parse(body) as { detail?: unknown }
            if (typeof parsed.detail === 'string' && parsed.detail) msg = parsed.detail
          } catch {
            // not JSON — keep short raw text
          }
          throw new Error(msg)
        }
        return (await res.json()) as Payload
      })
      .then((p) => {
        if (cancelled) return
        setData(p)
        setYear(p.year)
        setSelectedDay(0)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        if (e instanceof DOMException && e.name === 'AbortError') {
          setError('The harmonized request took longer than a minute. Try again.')
        } else {
          setError(`Couldn't load harmonized history: ${e instanceof Error ? e.message : String(e)}`)
        }
      })
      .finally(() => {
        window.clearTimeout(timer)
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      ctrl.abort()
    }
  }, [country, year])

  if (!data) {
    return (
      <div className="hz-body">
        {loading && <p>Loading the harmonized archive…</p>}
        {error && <div className="hz-err">{error}</div>}
      </div>
    )
  }

  const cname = DISPLAY_NAMES[data.country] ?? data.country_name
  const prior = data.yearly.find((r) => r.year === data.year - 1)
  const yoy = prior && prior.cells > 0 ? ((data.kpis.cells - prior.cells) / prior.cells) * 100 : null
  const priorFrp = prior && prior.frp_total > 0 ? ((data.kpis.frp_total - prior.frp_total) / prior.frp_total) * 100 : null
  const total = data.kpis.cells || 1
  const bothPct = (data.sensor_split.both / total) * 100
  const viirsPct = (data.sensor_split.viirs_only / total) * 100
  const modisPct = Math.max(0, 100 - bothPct - viirsPct)
  const viirsShare = (data.kpis.viirs_cells / total) * 100

  const visibleYears = yearFilter.length === 0 ? data.yearly : data.yearly.filter((d) => yearFilter.includes(d.year))
  const maxMetric = Math.max(1, ...data.yearly.map((d) => metricValue(d, metric))) * 1.12
  const avgMetric = data.yearly.reduce((a, d) => a + metricValue(d, metric), 0) / data.yearly.length
  const maxMonthly = Math.max(1, ...data.monthly)
  const peakMonthName = MONTH_FULL[data.verdict.peak_month - 1] ?? ''

  const rows = [...data.top10].sort((a, b) => {
    const av = a[sortKey]
    const bv = b[sortKey]
    if (typeof av === 'string') return sortDir * av.localeCompare(bv as string)
    return sortDir * ((av as number) - (bv as number))
  })
  const sel = rows[selectedDay] ?? rows[0]
  const weekMax = Math.max(1, ...data.weekly.flat())

  const toggleYear = (y: number) =>
    setYearFilter((prev) => (prev.includes(y) ? prev.filter((v) => v !== y) : [...prev, y]))
  const yearButtonLabel =
    yearFilter.length === 0 ? 'All Years' : yearFilter.length === 1 ? `${yearFilter[0]}` : yearFilter.length === data.years.length ? 'All Years' : `${yearFilter.length} years`

  return (
    <div className="hz-body">
      {loading && <p className="hz-loading">Loading the harmonized archive…</p>}
      {error && <div className="hz-err">{error}</div>}

      <section className="hz-card">
        <div className="hz-card-head">
          <div>
            <p className="hz-kicker">1 • Country &amp; year — pick a country</p>
            <h1 className="hz-title">
              Harmonized fire history <span className="hz-accent">for {cname}</span>
            </h1>
          </div>
          <span className="hz-pill">
            {data.country} • 1 km grid • {data.year}
          </span>
        </div>

        <div className="hz-controls">
          <label className="hz-field">
            <span className="hz-label">Country</span>
            <select value={country} onChange={(e) => setCountry(e.target.value)} aria-label="Country">
              {countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {DISPLAY_NAMES[c.code] ?? c.name}
                </option>
              ))}
            </select>
          </label>

          <div className="hz-field">
            <span className="hz-label">Year — multi-select</span>
            <button type="button" className="hz-dropdown-btn" onClick={() => setYearOpen((v) => !v)} aria-expanded={yearOpen}>
              <span>
                {yearButtonLabel} <span className="hz-muted">• chart filter</span>
              </span>
              <span aria-hidden="true">{yearOpen ? '▲' : '▼'}</span>
            </button>
            {yearOpen && (
              <div className="hz-dropdown">
                <button type="button" className="hz-checkrow" onClick={() => setYearFilter([])}>
                  <span>All Years</span>
                  <span className={'hz-check' + (yearFilter.length === 0 ? ' on' : '')}>{yearFilter.length === 0 && '✓'}</span>
                </button>
                {data.years.map((y) => (
                  <button key={y} type="button" className="hz-checkrow" onClick={() => toggleYear(y)}>
                    <span>
                      {y} {y === data.year && <span className="hz-selected-badge">SELECTED</span>}
                    </span>
                    <span className={'hz-check' + (yearFilter.includes(y) ? ' on' : '')}>{yearFilter.includes(y) && '✓'}</span>
                  </button>
                ))}
                <button type="button" className="hz-done" onClick={() => setYearOpen(false)}>
                  Done
                </button>
              </div>
            )}
          </div>

          <div className="hz-field">
            <span className="hz-label">Metric</span>
            <div className="hz-pills">
              {METRICS.map((m) => (
                <button key={m} type="button" className={'hz-pillbtn' + (metric === m ? ' on' : '')} onClick={() => setMetric(m)}>
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div className="hz-field">
            <span className="hz-label">Compare</span>
            <div className="hz-compare">
              {(['Off', 'Avg'] as const).map((v) => (
                <button key={v} type="button" className={compare === v ? 'on' : ''} onClick={() => setCompare(v)}>
                  {v === 'Off' ? 'Off' : `vs ${data.archive_range} Avg`}
                </button>
              ))}
            </div>
          </div>
        </div>

        <p className="hz-scope">
          Showing harmonized history for <b>{cname}</b> — MODIS + VIIRS snapped to 1km grid. All charts below use <b>{metric}</b>, not
          raw points. <span className="hz-muted">Tap a yearly bar to change the selected year.</span>
        </p>
      </section>

      <div className="hz-section-head">
        <h2>2 • Harmonized trends for this country — year, chart &amp; verdict update together</h2>
        <span>{data.year} selected</span>
      </div>

      <div className="hz-kpis">
        <div className="hz-kpi">
          <p className="hz-kpi-label">Total active fire cells</p>
          <p className="hz-kpi-big">{fmt(data.kpis.cells)}</p>
          <p className={'hz-kpi-sub' + (yoy !== null && yoy < 0 ? ' down' : '')}>
            {yoy === null ? 'no prior year' : `${yoy >= 0 ? '+' : ''}${yoy.toFixed(1)}% vs ${data.year - 1}`}
          </p>
          <p className="hz-kpi-note">
            {data.year} • {cname}
          </p>
        </div>
        <div className="hz-kpi">
          <p className="hz-kpi-label">Total FRP</p>
          <p className="hz-kpi-big">
            {(data.kpis.frp_total / 1000000).toFixed(1)}M <span className="hz-unit">MW</span>
          </p>
          <p className={'hz-kpi-sub' + (priorFrp !== null && priorFrp < 0 ? ' down' : '')}>
            {priorFrp === null ? 'no prior year' : `${priorFrp >= 0 ? '+' : ''}${priorFrp.toFixed(1)}% vs prior year`}
          </p>
          <p className="hz-kpi-note">Summed per 1 km cell</p>
        </div>
        <div className="hz-kpi">
          <p className="hz-kpi-label">Peak day</p>
          <p className="hz-kpi-med">{data.peak ? prettyDay(data.peak.date) : '—'}</p>
          <p className="hz-kpi-accent">{data.peak ? `${fmt(data.peak.cells)} cells` : ''}</p>
          <p className="hz-kpi-note">Highest single-day cell count</p>
        </div>
        <div className="hz-kpi">
          <p className="hz-kpi-label">VIIRS-only %</p>
          <p className="hz-kpi-big">{viirsShare.toFixed(1)}%</p>
          <p className="hz-kpi-sub">small fires MODIS missed</p>
          <p className="hz-kpi-note">Share of harmonized cells</p>
        </div>
      </div>

      <div className="hz-verdict">
        <div>
          <p className="hz-kicker">Verdict</p>
          <p className="hz-verdict-text">
            In {cname}, {data.year} — {data.verdict.above ? 'Above-average' : 'Below-average'} fire year •{' '}
            {Math.abs(data.verdict.pct).toFixed(0)}% {data.verdict.above ? 'above' : 'below'} {data.archive_range} average • Peak in{' '}
            {peakMonthName}
          </p>
        </div>
        <span className="hz-verdict-tag">{data.year} in focus</span>
      </div>

      <section className="hz-card" style={{ marginTop: 16 }}>
        <p className="hz-kicker">Daily — raw vs harmonized</p>
        <h3>
          Raw counts vs harmonized active fire cells — {cname} {data.year}
        </h3>
        <DailyChart series={data.daily} year={data.year} />
        <div className="hz-legend">
          <span>
            <i className="hz-sw-line" style={{ borderColor: '#3B82F6' }} /> Raw MODIS points
          </span>
          <span>
            <i className="hz-sw-line" style={{ borderColor: '#F59E0B' }} /> Raw VIIRS points
          </span>
          <span>
            <i className="hz-sw-line" style={{ borderColor: 'var(--green)', borderWidth: 3 }} /> Harmonized Active Fire Cells, 1 km grid
          </span>
        </div>
        <p className="hz-note">
          Raw VIIRS counts dwarf MODIS because VIIRS sees smaller fires — the green line is the one comparable series, after
          harmonization.
        </p>
      </section>

      <div className="hz-row-3">
        <section className="hz-card hz-span2">
          <p className="hz-kicker">Yearly trend — {metric}</p>
          <h3>Every year, one bar • tap to select</h3>
          <div className="hz-bars">
            {compare === 'Avg' && (
              <div className="hz-avgline" style={{ bottom: `${(avgMetric / maxMetric) * 100}%` }}>
                <span>AVG {metricLabel(avgMetric, metric)}</span>
              </div>
            )}
            {visibleYears.map((d) => {
              const v = metricValue(d, metric)
              const h = Math.max(4, (v / maxMetric) * 100)
              const active = d.year === data.year
              return (
                <button
                  key={d.year}
                  type="button"
                  title={`${d.year}: ${metricLabel(v, metric)}`}
                  className={'hz-bar' + (active ? ' active' : '')}
                  onClick={() => setYear(d.year)}
                >
                  <span className="hz-bar-val">{compact(v)}</span>
                  <span className="hz-bar-col" style={{ height: `${h}%` }} />
                  <span className="hz-bar-year">{String(d.year).slice(2)}</span>
                </button>
              )
            })}
          </div>
          <div className="hz-legend">
            <span>
              <i className="hz-swatch hz-sw-active" /> Selected year
            </span>
            <span>
              <i className="hz-swatch hz-sw-other" /> Other years
            </span>
            {compare === 'Avg' && (
              <span>
                <i className="hz-swatch hz-sw-avg" /> {data.archive_range} average
              </span>
            )}
            <span className="hz-right">
              Showing {visibleYears.length} of {data.years.length} years
            </span>
          </div>
          <p className="hz-note">
            <b>{data.year}:</b> {fmt(data.kpis.cells)} cells • {metricLabel(metricValue(data.yearly.find((r) => r.year === data.year)!, metric), metric)}.
          </p>
        </section>

        <section className="hz-card">
          <p className="hz-kicker">Sensor split — {data.year}</p>
          <h3>Where did cells come from?</h3>
          <div className="hz-donut-wrap">
            <div
              className="hz-donut"
              style={{
                background: `conic-gradient(#EA580C 0 ${bothPct}%, #F59E0B ${bothPct}% ${bothPct + viirsPct}%, #FDE68A ${bothPct + viirsPct}% 100%)`,
              }}
            >
              <div className="hz-donut-hole">
                <p>{compact(data.kpis.cells)}</p>
                <span>cells</span>
              </div>
            </div>
          </div>
          <div className="hz-splitrows">
            <div>
              <span>
                <i className="hz-dot" style={{ background: '#EA580C' }} /> Both sensors
              </span>
              <b>{bothPct.toFixed(1)}%</b>
            </div>
            <div>
              <span>
                <i className="hz-dot" style={{ background: '#F59E0B' }} /> VIIRS-only
              </span>
              <b>{viirsPct.toFixed(1)}%</b>
            </div>
            <div>
              <span>
                <i className="hz-dot" style={{ background: '#FDE68A' }} /> MODIS-only
              </span>
              <b>{modisPct.toFixed(1)}%</b>
            </div>
          </div>
          <p className="hz-note hz-amber">VIIRS catches the smaller, cooler fires MODIS misses. That is why harmonizing matters.</p>
        </section>
      </div>

      <div className="hz-row-5">
        <section className="hz-card hz-span3">
          <p className="hz-kicker">Seasonality — monthly, {data.year}</p>
          <h3>Aug–Oct carries the year</h3>
          <div className="hz-monthly">
            <div className="hz-mrow">
              {data.monthly.map((v, i) => (
                <div key={i} className="hz-mcol" title={`${MONTHS[i]}: ${fmt(v)}`}>
                  {compare === 'Avg' && (
                    <span
                      className="hz-mdot"
                      style={{ bottom: `${(data.monthly_avg[i]! / maxMonthly) * 100}%` }}
                      title={`Average: ${fmt(data.monthly_avg[i]!)}`}
                    />
                  )}
                  <div className="hz-mbar" style={{ height: `${Math.max(3, (v / maxMonthly) * 100)}%` }} />
                </div>
              ))}
            </div>
          </div>
          <div className="hz-mlabels">
            {MONTHS.map((m) => (
              <span key={m}>{m}</span>
            ))}
          </div>
          <div className="hz-legend">
            <span>
              <i className="hz-swatch hz-sw-other" /> {data.year} monthly cells
            </span>
            {compare === 'Avg' && (
              <span>
                <i className="hz-dot" style={{ background: '#94A3B8' }} /> {data.archive_range} average
              </span>
            )}
            <span className="hz-right">
              Peak: {peakMonthName} • {fmt(data.monthly[data.verdict.peak_month - 1]!)}
            </span>
          </div>
        </section>

        <section className="hz-card hz-span2">
          <p className="hz-kicker">Burning-activity calendar</p>
          <h3>
            Fire days for {cname}, {data.year}
          </h3>
          <div className="hz-cal">
            {data.weekly.map((weeks, mi) => (
              <div key={mi} className="hz-cal-col">
                <span>{MONTHS[mi]![0]}</span>
                {weeks.map((c, wi) => (
                  <i key={wi} title={`${MONTHS[mi]} • week ${wi + 1}`} style={{ background: calColor(c, weekMax) }} />
                ))}
              </div>
            ))}
          </div>
          <div className="hz-legend">
            <span>Less</span>
            <span className="hz-calscale">
              {CAL_COLORS.map((c) => (
                <i key={c} style={{ background: c }} />
              ))}
            </span>
            <span>More fire activity</span>
          </div>
          <p className="hz-note">Each column is a month; each square is a week. Darker orange means more harmonized fire activity that week.</p>
        </section>
      </div>

      <div className="hz-row-5">
        <section className="hz-card hz-span3">
          <div className="hz-card-head">
            <div>
              <p className="hz-kicker">
                Top 10 peak days — {cname}, {data.year}
              </p>
              <h3>The days that defined the season</h3>
            </div>
            <span className="hz-pill">Tap a column to sort</span>
          </div>
          <div className="hz-tablewrap">
            <table className="hz-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{sortHeader('Date', 'date')}</th>
                  <th className="hz-num">{sortHeader('Active cells', 'cells')}</th>
                  <th className="hz-num">{sortHeader('Total FRP', 'frp')}</th>
                  <th className="hz-num">{sortHeader('Max FRP', 'max')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.date} onClick={() => setSelectedDay(i)} className={rows[selectedDay]?.date === r.date ? 'sel' : ''}>
                    <td className="hz-rank">{String(i + 1).padStart(2, '0')}</td>
                    <td className="hz-date">{r.date}</td>
                    <td className="hz-num hz-bold">{fmt(r.cells)}</td>
                    <td className="hz-num">{fmt(r.frp)}</td>
                    <td className="hz-num">{fmt(r.max)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sel && (
            <p className="hz-note">
              Selected row: <b>{sel.date}</b> — {fmt(sel.cells)} cells. Tap another row to highlight it.
            </p>
          )}
        </section>

        <section className="hz-card hz-method hz-span2">
          <p className="hz-kicker">Methodology — how this was harmonized</p>
          <div className="hz-steps">
            <p>
              <b>Local solar date</b> — UTC timestamps shift by longitude so overnight fires stay on one day.
            </p>
            <p>
              <b>Confidence + type</b> — MODIS ≥ 30%, VIIRS nominal/high; vegetation fires (type 0) only.
            </p>
            <p>
              <b>0.01° cells</b> — one cell + one day = 1 fire-day; FRP summed per cell from the real column.
            </p>
            <p>
              <b>Overlap calibration</b> — median VIIRS/MODIS monthly ratio {data.overlap_ratio.toFixed(2)} over{' '}
              {data.overlap_months} loaded months.
            </p>
          </div>
          <div className="hz-readas">
            <p className="hz-kicker">Read it as</p>
            <p>One cell = one 1 km square with fire on one local solar day. Not raw satellite points.</p>
          </div>
        </section>
      </div>

      <footer className="hz-footer">
        <span>{data.coverage_note}</span>
        <span>PlumeRoute • Harmonized</span>
      </footer>
    </div>
  )

  function calColor(v: number, weekMax: number): string {
    const r = v / Math.max(1, weekMax)
    if (r <= 0.02) return CAL_COLORS[0]!
    if (r < 0.12) return CAL_COLORS[1]!
    if (r < 0.28) return CAL_COLORS[2]!
    if (r < 0.48) return CAL_COLORS[3]!
    if (r < 0.72) return CAL_COLORS[4]!
    if (r < 0.92) return CAL_COLORS[5]!
    return CAL_COLORS[6]!
  }

  function sortHeader(label: string, key: 'cells' | 'frp' | 'max' | 'date') {
    const active = sortKey === key
    return (
      <button
        type="button"
        onClick={() => {
          if (active) setSortDir((d) => (d === 1 ? -1 : 1))
          else {
            setSortKey(key)
            setSortDir(-1)
          }
        }}
        className="hz-sort"
      >
        {label}
        <span className="hz-sort-arrow">{active ? (sortDir === -1 ? '▼' : '▲') : '↕'}</span>
      </button>
    )
  }
}


