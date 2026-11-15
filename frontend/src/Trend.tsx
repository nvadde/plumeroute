import { useEffect, useRef, useState } from 'react'
import { loadMaps } from './loader'

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

interface DayRow {
  date: string
  fire_days: number
  modis_only: boolean
}
interface Hotspot {
  lat: number
  lon: number
  fire_days: number
}
interface TrendData {
  complete: boolean
  bbox: [number, number, number, number] | null
  scope: 'area' | 'country' | 'global'
  country: string | null
  year: string
  years: string[]
  extent: [number, number, number, number] | null
  calibration: { factor: number; overlap_months: number }
  daily: DayRow[]
  month_stats: Record<string, { mean: number; std: number; years: number }>
  verdict: { label: string; p_value: number | null; z?: number; window: string | null }
  hotspots: Hotspot[]
  coverage_note: string
  year_range: string | null
}

const PRESETS: { name: string; country: string; blurb: string }[] = [
  { name: 'Brazil', country: 'BR', blurb: 'Full Brazil archive rows for the selected year.' },
  { name: 'USA', country: 'US', blurb: 'Full United States archive rows for the selected year.' },
]

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MON_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const CAL_COLORS = ['#ece7db', '#f6cf9a', '#f2ac54', '#f09a4e', '#e05f10', '#93330a']

export function parseBbox(text: string): [number, number, number, number] | null {
  const parts = text.split(',').map((s) => Number(s.trim()))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  const [minLon, minLat, maxLon, maxLat] = parts as [number, number, number, number]
  if (minLon >= maxLon || minLat >= maxLat) return null
  return [minLon, minLat, maxLon, maxLat]
}

function calColor(v: number, max: number): string {
  if (max <= 0 || v <= 0) return CAL_COLORS[0]!
  const r = v / max
  if (r < 0.15) return CAL_COLORS[0]!
  if (r < 0.35) return CAL_COLORS[1]!
  if (r < 0.55) return CAL_COLORS[2]!
  if (r < 0.75) return CAL_COLORS[3]!
  if (r < 0.95) return CAL_COLORS[4]!
  return CAL_COLORS[5]!
}

export default function TrendView({ liveBbox, appbarQuery }: { liveBbox: string | null; appbarQuery: string }) {
  const divRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const overlaysRef = useRef<google.maps.MVCObject[]>([])
  const [preset, setPreset] = useState<string>('')
  const [bboxText, setBboxText] = useState('')
  const [bbox, setBbox] = useState<string | null>(null)
  const [country, setCountry] = useState<string | null>(null)
  const [data, setData] = useState<TrendData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [mapReady, setMapReady] = useState(false)
  const [season, setSeason] = useState<string | null>(null)
  const fittedKey = useRef<string | null>(null)

  // Appbar search on the Trend tab drives the same preset matching.
  const lastAppQuery = useRef('')
  useEffect(() => {
    if (appbarQuery !== lastAppQuery.current) {
      lastAppQuery.current = appbarQuery
      if (appbarQuery.trim()) onSearch(appbarQuery)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appbarQuery])

  const presetName = country !== null
    ? (PRESETS.find((p) => p.country === country)?.name ?? country)
    : bbox === null
      ? 'Brazil and United States'
      : 'Custom area'
  const presetBlurb = country !== null
    ? (PRESETS.find((p) => p.country === country)?.blurb ?? 'Country archive rows for the selected year.')
    : bbox === null
      ? 'All loaded archive rows for the selected year — every chart below uses the full Brazil + USA data.'
      : 'Custom bounding box — all charts use only hot spots inside this box.'

  function fitToBbox(text: string) {
    const parsed = parseBbox(text)
    if (!parsed) return
    const [minLon, minLat, maxLon, maxLat] = parsed
    mapRef.current?.fitBounds({ south: minLat, west: minLon, north: maxLat, east: maxLon })
  }

  function applyArea(text: string) {
    // A hand-picked area overrides the country preset. Zoom the map FIRST
    // so it never waits for /trend.
    fitToBbox(text)
    setBboxText(text)
    setBbox(text)
    setCountry(null)
    setPreset('')
  }

  function applyCountry(code: string, name: string) {
    // Country preset: full country files for the selected year. The map
    // fits once the response extent arrives (no hardcoded country bounds).
    setCountry(code)
    setBbox(null)
    setPreset(name)
  }

  function showAll() {
    setBboxText('')
    setBbox(null)
    setCountry(null)
    setPreset('')
  }

  function onSearch(q: string) {
    setBboxText(q)
    const s = q.toLowerCase()
    const hit = PRESETS.find((p) => p.name.toLowerCase().includes(s) || s.includes(p.name.toLowerCase()))
    if (hit && s.length >= 3) {
      applyCountry(hit.country, hit.name)
    }
  }

  async function readError(res: Response): Promise<string> {
    const body = await res.text()
    try {
      const parsed = JSON.parse(body) as { detail?: unknown }
      if (typeof parsed.detail === 'string' && parsed.detail) return parsed.detail
    } catch {
      // not JSON — fall through to raw text
    }
    return body || `Backend returned ${res.status}`
  }

  // Fetch trend whenever the applied area or season changes. The map has
  // already zoomed by now (applyArea fits first); this fills the calendar.
  useEffect(() => {
    let cancelled = false
    const ctrl = new AbortController()
    const timer = window.setTimeout(() => ctrl.abort(), 30000)
    setLoading(true)
    setError(null)
    setData(null)
    const params = `${bbox ? `bbox=${bbox}&` : country ? `country=${country}&` : ''}${season ? `year=${season}` : ''}`
    fetch(`${API_BASE}/trend?${params}`, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(await readError(res))
        return (await res.json()) as TrendData
      })
      .then((t) => {
        if (!cancelled) {
          setData(t)
          setSeason((s) => (s && t.years.includes(s) ? s : (t.years[t.years.length - 1] ?? null)))
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return
        if (e instanceof DOMException && e.name === 'AbortError') {
          setError('The archive request took longer than 30 seconds. Try a smaller area or reload.')
        } else {
          setError(`Couldn't load the archive: ${e instanceof Error ? e.message : String(e)}`)
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
  }, [bbox, country, season])

  // Map init: boundary outline + hotspot markers for the selected area.
  useEffect(() => {
    let cancelled = false
    async function init() {
      const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined
      if (!apiKey || !divRef.current) return
      const { Map } = await loadMaps(apiKey)
      if (cancelled || !divRef.current) return
      if (!mapRef.current) {
        mapRef.current = new Map(divRef.current, { center: { lat: 0, lng: 0 }, zoom: 2 })
      }
      setMapReady(true)
    }
    void init()
    return () => {
      cancelled = true
    }
  }, [])

  // Fit the map to the loaded scope once per scope+year (country extent,
  // global extent, or the selected area), without fighting pans afterwards.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !data?.complete || !data.extent) return
    const key = `${data.scope}:${data.country ?? ''}:${data.year}`
    if (fittedKey.current === key) return
    fittedKey.current = key
    const [minLon, minLat, maxLon, maxLat] = data.extent
    map.fitBounds({ south: minLat, west: minLon, north: maxLat, east: maxLon })
  }, [data, mapReady])

  // Bbox outline: drawn from the entered bbox the moment it is applied,
  // never waiting for /trend. Latitude goes to lat, longitude to lng.
  useEffect(() => {
    const map = mapRef.current
    if (bbox === null) {
      for (const o of overlaysRef.current) {
        if (o instanceof google.maps.Polyline && (o as { __bboxOutline?: boolean }).__bboxOutline) o.setMap(null)
      }
      overlaysRef.current = overlaysRef.current.filter(
        (o) => !((o instanceof google.maps.Polyline) && (o as { __bboxOutline?: boolean }).__bboxOutline),
      )
      return
    }
    const parsed = parseBbox(bbox)
    if (!map || !parsed) return
    for (const o of overlaysRef.current) {
      if (o instanceof google.maps.Polyline && (o as { __bboxOutline?: boolean }).__bboxOutline) o.setMap(null)
    }
    overlaysRef.current = overlaysRef.current.filter(
      (o) => !((o instanceof google.maps.Polyline) && (o as { __bboxOutline?: boolean }).__bboxOutline),
    )
    const [minLon, minLat, maxLon, maxLat] = parsed
    const corners = [
      { lat: minLat, lng: minLon },
      { lat: minLat, lng: maxLon },
      { lat: maxLat, lng: maxLon },
      { lat: maxLat, lng: minLon },
      { lat: minLat, lng: minLon },
    ]
    const outline = new google.maps.Polyline({
      path: corners,
      map,
      strokeColor: '#0066ff',
      strokeOpacity: 0,
      clickable: false,
      icons: [
        {
          icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: '#0066ff', scale: 2 },
          offset: '0',
          repeat: '10px',
        },
      ],
    })
    ;(outline as { __bboxOutline?: boolean }).__bboxOutline = true
    overlaysRef.current.push(outline)
  }, [bbox, mapReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !data?.complete) return
    for (const o of overlaysRef.current) {
      if (o instanceof google.maps.Marker) o.setMap(null)
    }
    overlaysRef.current = overlaysRef.current.filter(
      (o) => !(o instanceof google.maps.Marker),
    )
    for (const h of data.hotspots.slice(0, 500)) {
      overlaysRef.current.push(
        new google.maps.Marker({
          position: { lat: h.lat, lng: h.lon },
          map,
          title: `${h.fire_days} fire-days`,
          clickable: true,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 3.5,
            fillColor: '#ff5a1f',
            fillOpacity: 0.9,
            strokeColor: '#b63f04',
            strokeWeight: 1,
          },
        }),
      )
    }
  }, [data])

  // ---- derived season stats, all computed in code from /trend daily ----
  const years = data ? [...data.years].sort() : []
  const byDate = new Map((data?.daily ?? []).map((d) => [d.date, d.fire_days]))
  const seasonDays: { date: string; v: number }[] = []
  if (season && data) {
    for (const d of data.daily) {
      if (d.date.startsWith(season + '-')) seasonDays.push({ date: d.date, v: d.fire_days })
    }
    seasonDays.sort((a, b) => (a.date < b.date ? -1 : 1))
  }
  const seasonTotal = seasonDays.reduce((a, d) => a + d.v, 0)
  const activeDays = seasonDays.filter((d) => d.v > 0).length
  let longestStreak = 0
  {
    let run = 0
    let prev = ''
    for (const d of seasonDays) {
      if (d.v <= 0) {
        run = 0
        prev = d.date
        continue
      }
      const dayNum = Date.parse(d.date + 'T00:00:00Z') / 86400000
      const prevNum = prev ? Date.parse(prev + 'T00:00:00Z') / 86400000 : NaN
      run = prevNum === dayNum - 1 ? run + 1 : 1
      longestStreak = Math.max(longestStreak, run)
      prev = d.date
    }
  }
  const monthTotals = new Array(12).fill(0) as number[]
  for (const d of seasonDays) monthTotals[Number(d.date.slice(5, 7)) - 1]! += d.v
  const peakMonth = seasonTotal > 0 ? MON_FULL[monthTotals.indexOf(Math.max(...monthTotals))]! : '—'
  const avgYearly = years.length > 1
    ? years.filter((y) => y !== season).reduce((a, y) => a + data!.daily.filter((d) => d.date.startsWith(y + '-')).reduce((x, d) => x + d.fire_days, 0), 0) /
      (years.length - 1)
    : NaN
  const pctVsAvg = Number.isFinite(avgYearly) && avgYearly > 0 ? ((seasonTotal - avgYearly) / avgYearly) * 100 : null

  // Verdict banner: wording from the backend verdict + a percent computed above.
  const v = data?.verdict
  const noVerdict = !v || v.label === 'insufficient history'
  const bannerClass = !v ? 'plain' : noVerdict ? 'plain' : /above|below/.test(v.label) ? '' : 'ok'
  const bannerTitle = !data ? '' : noVerdict
    ? `${season ?? ''} in ${presetName} — not enough history for a verdict`
    : `${season ?? ''} in ${presetName} is ${v.label} the ${v.window ?? '10-year'} average`

  // Calendar cells: one per day of the season, ember scale.
  const seasonYear = Number(season ?? 0)
  const isLeap = seasonYear % 4 === 0 && (seasonYear % 100 !== 0 || seasonYear % 400 === 0)
  const daysInSeason = season ? (isLeap ? 366 : 365) : 364
  const calMax = Math.max(0.001, ...seasonDays.map((d) => d.v))
  const calCells: { key: string; v: number }[] = []
  if (season) {
    const start = Date.parse(`${season}-01-01T00:00:00Z`)
    for (let i = 0; i < daysInSeason; i++) {
      const dt = new Date(start + i * 86400000).toISOString().slice(0, 10)
      calCells.push({ key: dt, v: byDate.get(dt) ?? 0 })
    }
  }

  // YoY chart: selected-season monthly bars vs per-month mean across years.
  const chartMax = Math.max(1, ...monthTotals, ...MON.map((_, m) => data?.month_stats[String(m + 1)]?.mean ?? 0))
  const chartAvg = MON.map((_, m) => data?.month_stats[String(m + 1)]?.mean ?? 0)

  const factor = data?.calibration.factor ?? NaN
  const overlap = data?.calibration.overlap_months ?? 0

  function downloadCSV() {
    if (!data) return
    const scope = bbox ? `bbox=${bbox}&` : country ? `country=${country}&` : ''
    const a = document.createElement('a')
    a.href = `${API_BASE}/trend?${scope}year=${data.year}&format=csv`
    a.download = 'fires.csv'
    a.click()
  }

  return (
    <div className="trend-body">
      <div className="ctl-label">1 · Area of interest — pick a location <output>{presetName}</output></div>
      <div className="trend-loc-bar">
        {PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            className={'loc-chip' + (preset === p.name ? ' on' : '')}
            onClick={() => applyCountry(p.country, p.name)}
          >
            <span className="dotpin" />
            {p.name}
          </button>
        ))}
        <label className="loc-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input
            value={bboxText}
            onChange={(e) => onSearch(e.target.value)}
            placeholder='Search a place — try "brazil" — or paste minLon,minLat,maxLon,maxLat'
            aria-label="Trend area bbox"
          />
        </label>
        <button className="btn small" type="button" onClick={() => applyArea(bboxText)}>Apply area</button>
        <button
          className="btn small"
          type="button"
          onClick={showAll}
          disabled={bbox === null}
          title="Clear the area — show all loaded Brazil + USA data"
        >
          Show all
        </button>
        <button className="btn small" type="button" onClick={() => liveBbox && applyArea(liveBbox)} disabled={!liveBbox}>
          ◎ Follow Live location
        </button>
      </div>

      <div className="trend-mapwrap">
        <div ref={divRef} style={{ width: '100%', minHeight: 300 }} />
        <div className="map-chip">
          HISTORY MAP · {presetName.toUpperCase()} · {data?.year_range ?? '…'} · HISTORY ONLY
        </div>
        <div className="map-legend">
          <div><i style={{ background: '#ff5a1f' }} /> Historical hot spot (harmonized)</div>
          <div><i style={{ background: '#0066ff', opacity: 0.55 }} /> Selected area of interest</div>
        </div>
      </div>
      <div className="trend-map-meta">
        <span>Showing history for <b>{presetName}</b> — <span>{presetBlurb}</span></span>
        {bbox !== null && <span className="mono">BBOX {bbox}</span>}
        <span className="mono" style={{ color: 'var(--amber)' }}>HISTORY ONLY · AREA + PAST FIRES · NO LIVE ROUTE — ROUTING IS IN LIVE MODE</span>
      </div>

      {loading && <div style={{ marginBottom: 12 }}>Loading the archive — this can take a minute on first load.</div>}
      {error && <div className="errbar">{error}</div>}

      <div className="ctl-label" style={{ marginBottom: 12 }}>2 · Trends for this location — calendar, chart &amp; verdict update together</div>
      <div className="trend-grid">
        <div>
          <div className="ctl-label">Burning-activity calendar — fire days for {presetName} <output>{season ? `${season} season` : ''}</output></div>
          <div className="cal-scroll">
            <div className="cal-months" aria-hidden="true">
              {MON.map((m) => (
                <span key={m} style={{ flex: 4.2 }}>{m}</span>
              ))}
            </div>
            <div className="cal" role="img" aria-label="Calendar heatmap: one cell per day, darker ember means more fire detections that day">
              {calCells.map((c) => (
                <i key={c.key} style={{ background: calColor(c.v, calMax) }} title={`${c.key}: ${c.v.toFixed(1)} fire-days`} />
              ))}
            </div>
          </div>
          <div className="cal-legend">
            Less <i style={{ background: CAL_COLORS[0] }} /><i style={{ background: CAL_COLORS[1] }} /><i style={{ background: CAL_COLORS[2] }} /><i style={{ background: CAL_COLORS[3] }} /><i style={{ background: CAL_COLORS[5] }} /> More fire activity
          </div>
          <div className={'trend-banner' + (bannerClass ? ` ${bannerClass}` : '')}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flex: 'none', marginTop: 2 }} aria-hidden="true"><path d="M3 17l6-6 4 4 8-8" /><path d="M14 7h7v7" /></svg>
            <div>
              <b>{bannerTitle || 'Loading…'}</b>
              {data && !noVerdict && (
                <p>
                  Fire days ran{' '}
                  <strong>
                    {pctVsAvg === null ? '—' : `${Math.abs(pctVsAvg).toFixed(0)}% ${pctVsAvg >= 0 ? 'above' : 'below'}`}
                  </strong>{' '}
                  the {data.year_range ?? 'archive'} average for {presetName} (two-sample test,{' '}
                  <span className="mono">p = {v!.p_value === null ? 'n/a' : v!.p_value.toFixed(2)}</span>). The
                  verdict is computed in code from harmonized detections — the model only phrases it.
                </p>
              )}
              {data && noVerdict && (
                <p>Fewer than 24 months of fire-days in this area, so the significance test stays silent instead of guessing.</p>
              )}
            </div>
          </div>
          <div style={{ marginTop: 18 }}>
            <div className="ctl-label">Detections by month — {presetName} · selected season vs its 10-year average</div>
            <svg viewBox="0 0 720 240" style={{ width: '100%', height: 'auto' }} role="img" aria-label="Bar chart comparing monthly fire detections for the selected season against the ten year average">
              <line x1="40" y1="200" x2="700" y2="200" stroke="var(--line2)" strokeWidth="1.5" />
              <g>
                {monthTotals.map((val, i) => {
                  const x = 58 + i * 56
                  const h = (val / chartMax) * 170
                  const avg = chartAvg[i] ?? 0
                  return (
                    <rect
                      key={i}
                      x={x}
                      y={200 - h}
                      width="30"
                      height={Math.max(0, h)}
                      rx="3.5"
                      fill="var(--ember)"
                      opacity={val >= avg ? 1 : 0.55}
                    >
                      <title>{`${MON[i]}: ${val.toFixed(1)} vs avg ${avg.toFixed(1)}`}</title>
                    </rect>
                  )
                })}
              </g>
              <path
                d={'M' + chartAvg.map((a, i) => `${58 + i * 56 + 15},${200 - (a / chartMax) * 170}`).join(' L')}
                fill="none"
                stroke="var(--blue)"
                strokeWidth="2.6"
                strokeDasharray="6 5"
              />
              <g fontFamily="IBM Plex Mono,monospace" fontSize="11" fill="var(--ink3)" textAnchor="middle">
                {MON.map((m, i) => (
                  <text key={m} x={58 + i * 56 + 15} y="220">{m}</text>
                ))}
              </g>
            </svg>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--ink2)' }}>
              <span style={{ display: 'flex', gap: 7, alignItems: 'center' }}><i style={{ width: 13, height: 13, borderRadius: 3, background: 'var(--ember)', display: 'block' }} />{season ?? ''} {presetName} (harmonized)</span>
              <span style={{ display: 'flex', gap: 7, alignItems: 'center' }}><i style={{ width: 16, height: 0, borderTop: '3px dashed var(--blue)', display: 'block' }} />10-year average</span>
            </div>
          </div>
        </div>
        <div>
          <div className="ctl-label">Season</div>
          <div className="year-row">
            {years.map((y) => (
              <button key={y} type="button" className={'year-btn' + (season === y ? ' on' : '')} onClick={() => setSeason(y)}>
                {y}
              </button>
            ))}
          </div>
          <div className="statgrid" style={{ marginTop: 16 }}>
            <div className="stat"><b>{seasonTotal.toFixed(0)}</b><span>fire days · {presetName}</span></div>
            <div className="stat"><b>{activeDays}</b><span>active days with detections</span></div>
            <div className="stat"><b>{peakMonth}</b><span>peak month</span></div>
            <div className="stat"><b>{longestStreak} day{longestStreak === 1 ? '' : 's'}</b><span>longest active streak</span></div>
          </div>
          <button className="btn" type="button" onClick={downloadCSV} disabled={!data} style={{ width: '100%', marginTop: 12 }}>
            ↓ Download hot spots CSV — {presetName}
          </button>
          <p style={{ fontSize: 12, color: 'var(--ink3)', marginTop: 7 }}>CSV is scoped to the map box above — changing area changes the file.</p>
          <div className="panel harm" style={{ boxShadow: 'none' }}>
            <h3 style={{ fontSize: 16 }}>How we harmonize</h3>
            <p className="sub" style={{ marginBottom: 4 }}>Four steps turn two sensors' raw pixels into comparable fire-days.</p>
            <ol style={{ margin: '0 0 4px', paddingLeft: 20, fontSize: 13.5, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <li><strong>Local solar date</strong> — detections group by each area's local solar day, so overnight fires never split.</li>
              <li><strong>Confidence + type filtering</strong> — MODIS ≥ 30%, VIIRS nominal/high only; vegetation fires (type 0), never industrial heat or flares.</li>
              <li><strong>0.01° active-fire cells</strong> — one cell + one day = 1 fire-day, however many pixels fired; raw counts are never compared.</li>
              <li><strong>Overlap calibration</strong> — the median VIIRS/MODIS monthly ratio below scales the pre-2012 MODIS-only baseline to the same scale.</li>
            </ol>
            <div className="harm-row"><span>VIIRS ÷ MODIS</span><div className="bar"><i style={{ width: `${Math.min(100, (factor / Math.max(factor, 1)) * 100)}%`, background: '#e8a04c' }} /></div><b>{Number.isFinite(factor) ? `${factor.toFixed(2)}×` : '…'}</b></div>
            <div className="harm-row"><span>Harmonized</span><div className="bar"><i style={{ width: `${Math.min(100, (1 / Math.max(factor, 1)) * 100)}%`, background: 'var(--green)' }} /></div><b>1.00×</b></div>
            <p className="note">
              Median VIIRS/MODIS monthly ratio over {overlap} overlap months{data?.year_range ? `, ${data.year_range}` : ''}.
              Without the normalization factor, any year-over-year chart "proves" fires changed when the satellite did.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}



