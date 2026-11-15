import { useEffect, useRef, useState } from 'react'
import { planRoute, pointInPoly, type LatLng } from './route'
import { loadMaps } from './loader'
import TrendView from './Trend'
import HarmonizedView from './Harmonized'

interface Fire {
  latitude: number
  longitude: number
  acq_date: string
  acq_time: string
  satellite: string
  confidence: string
  frp: number | null
}

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

type GibsLayer = 'truecolor' | 'aod'

interface WindHour {
  time: string
  speed_ms: number
  direction_deg: number
}

interface Verdict {
  level: 'AVOID' | 'CAUTION' | 'SAFE'
  verdict: string
  safer_direction: string
}

const LIVE_PLACES = [
  { name: 'Prainha area', lat: -1.8, lng: -53.5 },
  { name: 'Red Hill area', lat: 32.2, lng: -90.2 },
]

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
function compass(deg: number): string {
  return COMPASS[Math.round(deg / 22.5) % 16]!
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(a))
}

const VWORD = { AVOID: '◉ AVOID', CAUTION: '◎ CAUTION', SAFE: '○ SAFE' } as const
const VCLASS = { AVOID: 'avoid', CAUTION: 'caution', SAFE: 'safe' } as const

export default function App() {
  const divRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const gibsRef = useRef<Record<GibsLayer, google.maps.ImageMapType | null>>({
    truecolor: null,
    aod: null,
  })
  const markersRef = useRef<google.maps.Marker[]>([])
  const [showFires, setShowFires] = useState(true)
  const [showPlume, setShowPlume] = useState(true)
  const [showAod, setShowAod] = useState(false)
  const [showTruecolor, setShowTruecolor] = useState(true)
  const [showRoute, setShowRoute] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'trend' | 'live' | 'harmonized'>('harmonized')
  const [plumeArea, setPlumeArea] = useState<number | null>(null)
  const [tracing, setTracing] = useState(false)
  const [freshness, setFreshness] = useState('FIRMS · …')
  const [searchText, setSearchText] = useState('')
  const [askOpen, setAskOpen] = useState(false)
  const [askInput, setAskInput] = useState('')
  const [askLog, setAskLog] = useState<{ q: string; a: string }[]>([])
  const [liveBbox, setLiveBbox] = useState<string | null>(null)
  const plumeRef = useRef<google.maps.Polygon | null>(null)

  const HOURS = [0, 1, 2, 3, 4, 5, 6]
  const [plume, setPlume] = useState<[number, number][] | null>(null)
  const [windHours, setWindHours] = useState<WindHour[] | null>(null)
  const [hourIdx, setHourIdx] = useState(3)
  const forecastRef = useRef<google.maps.Polygon | null>(null)

  const [place, setPlace] = useState<{ name: string; lat: number; lng: number } | null>(null)
  const [assessment, setAssessment] = useState<Verdict | null>(null)
  const [assessing, setAssessing] = useState(false)
  const [originText, setOriginText] = useState('')
  const [destText, setDestText] = useState('')
  const [escapeMsg, setEscapeMsg] = useState(false)
  const [routeInfo, setRouteInfo] = useState<string | null>(null)
  const routeRef = useRef<google.maps.Polyline | null>(null)

  function parseLatLng(text: string): LatLng | null {
    const parts = text.split(',').map((s) => Number(s.trim()))
    if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return null
    const [lat, lng] = parts as [number, number]
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
    return [lat, lng]
  }

  // Advect the plume centroid forward t hours on the 850 hPa winds.
  function advected(t: number): [number, number][] | null {
    if (!plume || !windHours || t <= 0) return t === 0 ? plume : null
    let north = 0
    let east = 0
    for (let i = 0; i < t && i < windHours.length; i++) {
      const w = windHours[i]!
      const rad = (w.direction_deg * Math.PI) / 180
      north += -w.speed_ms * Math.cos(rad) * 3600
      east += -w.speed_ms * Math.sin(rad) * 3600
    }
    let cLat = 0
    let cLng = 0
    for (const [lat, lng] of plume) {
      cLat += lat
      cLng += lng
    }
    cLat /= plume.length
    cLng /= plume.length
    const advLat = cLat + north / 111320
    const advLng = cLng + east / (111320 * Math.cos((cLat * Math.PI) / 180))
    const spread = 1 + 0.12 * t
    return plume.map(([lat, lng]) => [advLat + (lat - cLat) * spread, advLng + (lng - cLng) * spread])
  }

  // First forecast hour the place falls inside the advected plume, if any.
  function arrivalHour(lat: number, lng: number): number | null {
    for (let t = 0; t <= 6; t++) {
      const poly = advected(t)
      if (poly && poly.length > 2 && pointInPoly(lat, lng, poly)) return t
    }
    return null
  }

  function drawRoute() {
    const map = mapRef.current
    const origin = parseLatLng(originText)
    const dest = parseLatLng(destText)
    if (!map || !origin || !dest) {
      setError('Enter origin and destination as "lat,lng".')
      return
    }
    setError(null)
    setEscapeMsg(false)
    setRouteInfo(null)
    routeRef.current?.setMap(null)
    routeRef.current = null
    const noGos: LatLng[][] = []
    for (const ref of [plumeRef, forecastRef]) {
      const path = ref.current?.getPath()
      if (path && path.getLength() > 2) {
        const poly: LatLng[] = []
        path.forEach((ll) => poly.push([ll.lat(), ll.lng()]))
        noGos.push(poly)
      }
    }
    const { path, escaped } = planRoute(origin, dest, noGos)
    const render = () => {
      routeRef.current = new google.maps.Polyline({
        path: path.map(([lat, lng]) => ({ lat, lng })),
        map: showRoute ? map : null,
        strokeColor: '#43d68a',
        strokeWeight: 5,
      })
      setRouteInfo(
        escaped
          ? 'Start is inside the smoke — the route leaves the plume first, then stays clear of it and the forecast cone.'
          : 'Smoke-aware route drawn — it stays clear of the mapped plume and the forecast cone.',
      )
    }
    if (escaped) {
      setEscapeMsg(true)
      window.setTimeout(render, 1200)
    } else {
      render()
    }
  }

  // Plain-words backend errors: {"detail": "..."} parses to the message,
  // anything else falls back to short raw text — never a JSON blob.
  async function errorText(res: Response): Promise<string> {
    const body = await res.text()
    try {
      const parsed = JSON.parse(body) as { detail?: unknown }
      if (typeof parsed.detail === 'string' && parsed.detail) return parsed.detail
    } catch {
      // not JSON — fall through to short text
    }
    return body.slice(0, 300) || `Backend returned ${res.status}`
  }

  async function assessAt(lat: number, lng: number, name: string): Promise<Verdict | null> {
    setAssessing(true)
    setError(null)
    setPlace({ name, lat, lng })
    try {
      const res = await fetch(`${API_BASE}/assess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latitude: lat, longitude: lng, place: name }),
      })
      if (!res.ok) throw new Error(await errorText(res))
      const v = (await res.json()) as Verdict
      setAssessment(v)
      return v
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setAssessing(false)
    }
  }

  function speak(text: string) {
    try {
      if (!('speechSynthesis' in window)) return false
      window.speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(text)
      u.rate = 1
      window.speechSynthesis.speak(u)
      return true
    } catch {
      return false
    }
  }

  // WAV capture at the model's native rate: the /transcribe endpoint takes
  // mono 16-bit PCM WAV (16 or 24 kHz), which MediaRecorder cannot produce.
  const WAV_RATE = 24000
  type RecState = 'idle' | 'recording' | 'transcribing'
  const [recState, setRecState] = useState<RecState>('idle')
  const audioCtxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const procRef = useRef<ScriptProcessorNode | null>(null)
  const samplesRef = useRef<Float32Array[]>([])
  const wavRef = useRef<Blob | null>(null)

  function stopCapture() {
    try {
      procRef.current?.disconnect()
    } catch {
      // already closed
    }
    procRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {})
      audioCtxRef.current = null
    }
  }

  function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
    const total = chunks.reduce((a, c) => a + c.length, 0)
    const data = new Int16Array(total)
    let off = 0
    for (const c of chunks) {
      for (let i = 0; i < c.length; i++) {
        const s = Math.max(-1, Math.min(1, c[i]!))
        data[off++] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
    }
    const buf = new ArrayBuffer(44 + data.length * 2)
    const v = new DataView(buf)
    const wstr = (o: number, s: string) => {
      for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
    }
    wstr(0, 'RIFF')
    v.setUint32(4, 36 + data.length * 2, true)
    wstr(8, 'WAVE')
    wstr(12, 'fmt ')
    v.setUint32(16, 16, true)
    v.setUint16(20, 1, true)
    v.setUint16(22, 1, true)
    v.setUint32(24, sampleRate, true)
    v.setUint32(28, sampleRate * 2, true)
    v.setUint16(32, 2, true)
    v.setUint16(34, 16, true)
    wstr(36, 'data')
    v.setUint32(40, data.length * 2, true)
    new Int16Array(buf, 44).set(data)
    return new Blob([buf], { type: 'audio/wav' })
  }

  function resample24k(chunks: Float32Array[], fromRate: number): { chunks: Float32Array[]; rate: number } {
    if (fromRate === WAV_RATE) return { chunks, rate: WAV_RATE }
    const flat = new Float32Array(chunks.reduce((a, c) => a + c.length, 0))
    let o = 0
    for (const c of chunks) {
      flat.set(c, o)
      o += c.length
    }
    const n = Math.floor((flat.length * WAV_RATE) / fromRate)
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const pos = (i * fromRate) / WAV_RATE
      const i0 = Math.floor(pos)
      const frac = pos - i0
      out[i] = (flat[i0] ?? 0) * (1 - frac) + (flat[Math.min(i0 + 1, flat.length - 1)] ?? 0) * frac
    }
    return { chunks: [out], rate: WAV_RATE }
  }

  async function toggleRecording() {
    if (recState === 'transcribing') return
    if (recState === 'recording') {
      await finishRecording()
      return
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof window.AudioContext === 'undefined') {
      setError('Voice input is not supported in this browser — type your question instead.')
      setAskOpen(true)
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const ctx = new window.AudioContext({ sampleRate: WAV_RATE })
      await ctx.resume()
      const src = ctx.createMediaStreamSource(stream)
      const proc = ctx.createScriptProcessor(4096, 1, 1)
      samplesRef.current = []
      proc.onaudioprocess = (e) => {
        samplesRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)))
      }
      const sink = ctx.createGain()
      sink.gain.value = 0
      src.connect(proc)
      proc.connect(sink)
      sink.connect(ctx.destination)
      streamRef.current = stream
      audioCtxRef.current = ctx
      procRef.current = proc
      wavRef.current = null
      setAskOpen(true)
      setRecState('recording')
    } catch {
      stopCapture()
      setError('Microphone blocked — allow microphone access and try again, or type your question.')
      setAskOpen(true)
    }
  }

  function finishRecording(): Promise<void> {
    const ctx = audioCtxRef.current
    const chunks = samplesRef.current
    samplesRef.current = []
    stopCapture()
    if (!ctx || chunks.length === 0) {
      setRecState('idle')
      setError('Nothing was recorded — tap the mic, speak, then tap stop.')
      return Promise.resolve()
    }
    const { chunks: norm, rate } = resample24k(chunks, ctx.sampleRate)
    wavRef.current = encodeWav(norm, rate)
    setRecState('transcribing')
    return Promise.resolve().then(() => transcribeAndAssess())
  }

  async function transcribeAndAssess() {
    try {
      const blob = wavRef.current
      wavRef.current = null
      if (!blob || blob.size <= 44) {
        setError('Nothing was recorded — tap the mic, speak, then tap stop.')
        setRecState('idle')
        return
      }
      const b64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => {
          const s = String(r.result ?? '')
          const i = s.indexOf(',')
          resolve(i >= 0 ? s.slice(i + 1) : s)
        }
        r.onerror = () => reject(new Error('could not read recording'))
        r.readAsDataURL(blob)
      })
      const res = await fetch(`${API_BASE}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_b64: b64, mime: 'audio/wav' }),
      })
      if (!res.ok) throw new Error(await errorText(res))
      const { text } = (await res.json()) as { text: string }
      const q = text.trim()
      if (!q) throw new Error('The transcription came back empty — try again.')
      // The transcribed place decides where /assess runs, like typed search.
      const s = q.toLowerCase()
      const hit = LIVE_PLACES.find(
        (p) => p.name.toLowerCase().includes(s) || s.includes(p.name.split(' ')[0]!.toLowerCase()),
      )
      const target = hit ?? place ?? (() => {
        const c = mapRef.current?.getCenter()
        const lat = c?.lat() ?? -1.8
        const lng = c?.lng() ?? -53.5
        return { name: `${lat.toFixed(3)}, ${lng.toFixed(3)}`, lat, lng }
      })()
      setAskLog((log) => [...log, { q, a: '…' }])
      const v = await assessAt(target.lat, target.lng, target.name)
      const answer = v
        ? `${v.level}. ${v.verdict}${v.safer_direction ? ` Safer direction: ${v.safer_direction}.` : ''}`
        : 'Honest by design: the assessment failed, so there is no verdict to read aloud.'
      setAskLog((log) => {
        const next = [...log]
        next[next.length - 1] = { q, a: answer }
        return next
      })
      if (!speak(answer)) {
        setAskLog((log) => {
          const next = [...log]
          next[next.length - 1] = { q, a: answer + ' (voice output is not supported in this browser — read above.)' }
          return next
        })
      }
    } catch (e) {
      setError(`Couldn't transcribe that: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRecState('idle')
    }
  }

  async function askQuestion() {
    const q = askInput.trim()
    if (!q || !place) return
    setAskInput('')
    setAskLog((log) => [...log, { q, a: '…' }])
    try {
      const res = await fetch(`${API_BASE}/assess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latitude: place.lat, longitude: place.lng, place: place.name }),
      })
      if (!res.ok) throw new Error(await errorText(res))
      const v = (await res.json()) as Verdict
      setAssessment(v)
      setAskLog((log) => {
        const next = [...log]
        next[next.length - 1] = { q, a: `${v.level}: ${v.verdict}${v.safer_direction ? ` Safer direction: ${v.safer_direction}.` : ''}` }
        return next
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setAskLog((log) => {
        const next = [...log]
        next[next.length - 1] = { q, a: `Honest by design: I couldn't reach the backend (${msg}) — no guess.` }
        return next
      })
    }
  }

  // Forecast cone polygon for the selected hour.
  useEffect(() => {
    const map = mapRef.current
    forecastRef.current?.setMap(null)
    forecastRef.current = null
    const t = HOURS[hourIdx] ?? 0
    const poly = advected(t)
    if (!map || !poly || t === 0) return
    forecastRef.current = new google.maps.Polygon({
      paths: poly.map(([lat, lng]) => ({ lat, lng })),
      map: showPlume ? map : null,
      strokeColor: '#f4822a',
      strokeOpacity: Math.max(0.25, 0.9 - 0.12 * t),
      fillColor: '#f4822a',
      fillOpacity: Math.max(0.05, 0.3 - 0.045 * t),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hourIdx, plume, windHours, showPlume])

  async function tracePlume() {
    const map = mapRef.current
    if (!map || tracing) return
    const b = map.getBounds()
    if (!b) return
    const sw = b.getSouthWest()
    const ne = b.getNorthEast()
    if (sw.lng() >= ne.lng() || sw.lat() >= ne.lat()) {
      setError('Zoom into a valid region before tracing the plume.')
      return
    }
    setTracing(true)
    setError(null)
    try {
      const bbox = `${sw.lng()},${sw.lat()},${ne.lng()},${ne.lat()}`
      const res = await fetch(`${API_BASE}/smoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bbox }),
      })
      if (!res.ok) {
        const body = await res.text()
        throw new Error(body || `Backend returned ${res.status}`)
      }
      const { polygon, area_km2 } = (await res.json()) as {
        polygon: [number, number][]
        area_km2: number
      }
      plumeRef.current?.setMap(null)
      plumeRef.current = null
      forecastRef.current?.setMap(null)
      forecastRef.current = null
      setPlume(null)
      setWindHours(null)
      setHourIdx(0)
      if (polygon.length === 0) {
        setPlumeArea(0)
        return
      }
      plumeRef.current = new google.maps.Polygon({
        paths: polygon.map(([lat, lng]) => ({ lat, lng })),
        map: showPlume ? map : null,
        strokeColor: '#ff7a1a',
        strokeOpacity: 1,
        fillColor: '#ff7a1a',
        fillOpacity: 0.5,
      })
      setPlume(polygon)
      setPlumeArea(area_km2)
      let cLat = 0
      let cLng = 0
      for (const [lat, lng] of polygon) {
        cLat += lat
        cLng += lng
      }
      cLat /= polygon.length
      cLng /= polygon.length
      try {
        const wres = await fetch(
          `${API_BASE}/wind?latitude=${cLat}&longitude=${cLng}`,
        )
        if (!wres.ok) {
          const body = await wres.text()
          throw new Error(body || `Backend returned ${wres.status}`)
        }
        const { hours } = (await wres.json()) as { hours: WindHour[] }
        setWindHours(hours)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setTracing(false)
    }
  }

  // Independent GIBS overlays: true color (Level9, valid to zoom 9) and
  // AOD (Level6 matrix: zooms 0-6 only — above 6 GIBS answers XML errors,
  // so the layer stays off instead of drawing failed tiles).
  const gibsVisRef = useRef({ truecolor: true, aod: true })
  function refreshOverlays() {
    const map = mapRef.current
    if (!map) return
    map.overlayMapTypes.clear()
    if (gibsVisRef.current.truecolor && gibsRef.current.truecolor) {
      map.overlayMapTypes.push(gibsRef.current.truecolor)
    }
    const z = map.getZoom() ?? 0
    if (gibsVisRef.current.aod && gibsRef.current.aod && z <= 6) {
      map.overlayMapTypes.push(gibsRef.current.aod)
    }
  }
  useEffect(() => {
    gibsVisRef.current = { truecolor: showTruecolor, aod: showAod }
    refreshOverlays()
  }, [showTruecolor, showAod, tab])

  useEffect(() => {
    plumeRef.current?.setMap(showPlume ? mapRef.current : null)
  }, [showPlume])
  useEffect(() => {
    for (const m of markersRef.current) m.setMap(showFires ? mapRef.current : null)
  }, [showFires])
  useEffect(() => {
    routeRef.current?.setMap(showRoute ? mapRef.current : null)
  }, [showRoute])

  useEffect(() => {
    let cancelled = false
    let map: google.maps.Map | null = null

    async function init() {
      const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined
      if (!apiKey) {
        setError('VITE_GOOGLE_MAPS_API_KEY is not set')
        return
      }
      const { Map } = await loadMaps(apiKey)
      if (cancelled || !divRef.current) return

      // Imagery date: pinned composite known to serve real tiles.
      // (A z2 probe tile from this exact date was verified to return a
      // real PNG. Note: some high-zoom tiles over the demo area are black
      // coverage gaps in this composite — see verification notes.)
      const gibsDate = '2026-11-13'
      if (cancelled) return
      map = new Map(divRef.current, {
        center: { lat: -1.8, lng: -53.5 },
        zoom: 8,
      })
      // Open zoomed to the Prainha demo area, not the whole world.
      map.fitBounds({ south: -2.3, west: -54.0, north: -1.3, east: -53.0 })

      const tileSize = new google.maps.Size(256, 256)
      gibsRef.current.truecolor = new google.maps.ImageMapType({
        getTileUrl: (coord: google.maps.Point, zoom: number) =>
          `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${gibsDate}/GoogleMapsCompatible_Level9/${zoom}/${coord.y}/${coord.x}.png`,
        tileSize,
        maxZoom: 9,
        minZoom: 1,
        name: 'GIBS True Color',
      })
      gibsRef.current.aod = new google.maps.ImageMapType({
        getTileUrl: (coord: google.maps.Point, zoom: number) =>
          `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_Aerosol_Optical_Depth_v6_NRT/default/${gibsDate}/GoogleMapsCompatible_Level6/${zoom}/${coord.y}/${coord.x}.png`,
        tileSize,
        maxZoom: 6,
        minZoom: 1,
        name: 'GIBS Smoke (AOD)',
      })
      mapRef.current = map
      // Layer visibility (with the zoom cap) is owned by refreshOverlays —
      // never push both layers blindly here.
      refreshOverlays()

      async function loadFires() {
        if (!map) return
        const b = map.getBounds()
        if (!b) return
        const sw = b.getSouthWest()
        const ne = b.getNorthEast()
        if (sw.lng() >= ne.lng() || sw.lat() >= ne.lat()) return
        const bbox = `${sw.lng()},${sw.lat()},${ne.lng()},${ne.lat()}`
        try {
          const res = await fetch(`${API_BASE}/fires?bbox=${bbox}&days=1`)
          if (!res.ok) {
            const body = await res.text()
            throw new Error(body || `Backend returned ${res.status}`)
          }
          const fires = (await res.json()) as Fire[]
          if (cancelled || !map) return
          for (const m of markersRef.current) m.setMap(null)
          markersRef.current = fires.map(
            (f) =>
              new google.maps.Marker({
                position: { lat: f.latitude, lng: f.longitude },
                map: mapRef.current,
                title: `${f.acq_date} ${f.acq_time} · ${f.satellite} · FRP ${f.frp ?? 'n/a'}`,
              }),
          )
          if (fires.length > 0) {
            const latest = fires.map((f) => f.acq_date).sort().pop()!
            const ageDays = Math.max(
              0,
              Math.round((Date.now() - Date.parse(latest + 'T00:00:00Z')) / 86400000),
            )
            setFreshness(ageDays === 0 ? `FIRMS · today ${latest}` : `FIRMS · ${latest} (${ageDays}d old)`)
          } else {
            setFreshness('FIRMS · no detections in view')
          }
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e))
        }
      }

      const bb = map.getBounds()
      if (bb) {
        const sw0 = bb.getSouthWest()
        const ne0 = bb.getNorthEast()
        setLiveBbox(`${sw0.lng()},${sw0.lat()},${ne0.lng()},${ne0.lat()}`)
      }
      map.addListener('idle', () => {
        const b2 = map?.getBounds()
        if (b2) {
          const s = b2.getSouthWest()
          const n = b2.getNorthEast()
          setLiveBbox(`${s.lng()},${s.lat()},${n.lng()},${n.lat()}`)
        }
        void loadFires()
      })
      map.addListener('zoom_changed', () => {
        refreshOverlays()
      })
      map.addListener('click', (e: google.maps.MapMouseEvent) => {
        const ll = e.latLng
        if (!ll) return
        void assessAt(ll.lat(), ll.lng(), `${ll.lat().toFixed(3)}, ${ll.lng().toFixed(3)}`)
      })
      await loadFires()
    }

    init().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e))
    })

    return () => {
      cancelled = true
      for (const m of markersRef.current) m.setMap(null)
      markersRef.current = []
      plumeRef.current?.setMap(null)
      forecastRef.current?.setMap(null)
      routeRef.current?.setMap(null)
    }
  }, [tab])

  function onSearch(q: string) {
    setSearchText(q)
    const s = q.toLowerCase()
    const hit = LIVE_PLACES.find(
      (p) => p.name.toLowerCase().includes(s) || s.includes(p.name.split(' ')[0]!.toLowerCase()),
    )
    if (hit && s.length >= 3 && mapRef.current) {
      mapRef.current.setCenter({ lat: hit.lat, lng: hit.lng })
      mapRef.current.setZoom(8)
      void assessAt(hit.lat, hit.lng, hit.name)
    }
  }

  const t = HOURS[hourIdx] ?? 0
  const w0 = windHours?.[0]
  const arrival = place ? arrivalHour(place.lat, place.lng) : null
  const nearestKm = place && plume && plume.length > 0
    ? Math.min(...plume.map(([la, lo]) => haversineKm(place.lat, place.lng, la, lo)))
    : null
  const etaText = !place
    ? 'Tap the map or pick a place — the cone arrival is computed from the mapped plume and 850 hPa winds.'
    : !plume || !windHours
      ? `${place.name}: no mapped plume yet — press “Trace plume” to measure one from the current view.`
      : arrival === null
        ? `${place.name} stays clear through +6 h${nearestKm !== null ? ` — nearest smoke ≈ ${nearestKm.toFixed(0)} km away` : ''}.`
        : arrival === 0
          ? `${place.name} is inside the mapped plume now.`
          : `At +${arrival} h, the cone reaches ${place.name}${nearestKm !== null && arrival > 2 ? ` — nearest smoke now ≈ ${nearestKm.toFixed(0)} km away` : ''}.`

  const toggle = (label: string, on: boolean, set: (v: boolean) => void) => (
    <button key={label} type="button" className="tgl" aria-pressed={on} onClick={() => set(!on)}>
      <span className="sw" />
      {label}
    </button>
  )

  return (
    <div className="frame">
      <div className="appbar">
        <div className="brand">
          <span className="mark">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round"><path d="M4 19c4-1 5-4 5-7V4c4 2 6 5 6 9 2-1 3-2 4-4 1 5-1 10-6 11H6" /></svg>
          </span>
          PlumeRoute
        </div>
        <div className="mode-switch" role="group" aria-label="Mode">
          <button type="button" className={tab === 'harmonized' ? 'on' : ''} onClick={() => setTab('harmonized')}>Harmonized</button>
          <button type="button" className={tab === 'trend' ? 'on' : ''} onClick={() => setTab('trend')}>Trend</button>
          <button type="button" className={tab === 'live' ? 'on' : ''} onClick={() => setTab('live')}>Live</button>
        </div>
        <label className="search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input
            type="text"
            placeholder='Search a place — try "brazil"'
            aria-label="Search a place"
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value)
              if (tab === 'live') onSearch(e.target.value)
            }}
          />
        </label>
        <button
          type="button"
          className="voice-btn"
          onClick={() => void toggleRecording()}
          aria-expanded={askOpen}
          aria-label={recState === 'recording' ? 'Stop recording' : 'Ask by voice — record a spoken question'}
          title={recState === 'recording' ? 'Stop recording' : 'Record a spoken question'}
          style={recState === 'recording' ? { background: 'var(--red)' } : undefined}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
          {recState === 'recording' ? '● Recording — tap to stop' : recState === 'transcribing' ? 'Transcribing…' : 'Ask by voice'}
        </button>
        <span className="freshness">{freshness}</span>
      </div>

      {tab === 'trend' ? (
        <TrendView liveBbox={liveBbox} appbarQuery={tab === 'trend' ? searchText : ''} />
      ) : tab === 'harmonized' ? (
        <HarmonizedView />
      ) : (
        <>
          <div className="mapwrap">
            <div ref={divRef} style={{ width: '100%', minHeight: 420 }} />
            <div className="wind-chip">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ffb38a" strokeWidth="2.2" strokeLinecap="round"><path d="M4 20 20 4M11 4h9v9" /></svg>
              {w0 ? `850 hPa wind · ${compass(w0.direction_deg)} · ${(w0.speed_ms * 3.6).toFixed(0)} km/h` : '850 hPa wind · —'}
            </div>
            <div className="map-legend">
              <div><i style={{ background: '#ff5a1f' }} /> FIRMS detection</div>
              <div><i style={{ background: '#ff7a1a', opacity: 0.55 }} /> SAM plume (now)</div>
              <div><i style={{ background: '#f4822a', opacity: 0.3 }} /> Forecast cone (+1–6 h)</div>
              <div><i style={{ background: '#c96a1e', opacity: 0.45 }} /> GIBS aerosol (AOD)</div>
            </div>
          </div>

          <div className="console">
            <div className="console-left">
              <div className="ctl-label">Trajectory forecast — time slider <output>{t === 0 ? 'Now' : `+${t} h`}</output></div>
              <input type="range" min={0} max={6} step={1} value={hourIdx} onChange={(e) => setHourIdx(Number(e.target.value))} aria-label="Forecast hour" />
              <div className="ticks"><span>Now</span><span>+1 h</span><span>+2 h</span><span>+3 h</span><span>+4 h</span><span>+5 h</span><span>+6 h</span></div>
              <div className="eta-line">{etaText}</div>
              <div className="ctl-label" style={{ marginTop: 20 }}>Layers</div>
              <div className="toggle-row" style={{ marginTop: 0 }}>
                {toggle('FIRMS fires', showFires, setShowFires)}
                {toggle('SAM plume', showPlume, setShowPlume)}
                {toggle('GIBS AOD', showAod, setShowAod)}
                {toggle('True color', showTruecolor, setShowTruecolor)}
                {toggle('Smoke-aware route', showRoute, setShowRoute)}
              </div>
              <div className="ctl-label" style={{ marginTop: 20 }}>Measure &amp; route</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn small" onClick={() => void tracePlume()} disabled={tracing}>
                  {tracing ? 'Tracing…' : 'Trace plume'}
                </button>
                <input
                  value={originText}
                  onChange={(e) => setOriginText(e.target.value)}
                  placeholder="Origin lat,lng"
                  aria-label="Route origin"
                  style={{ padding: '6px 8px', border: '1.5px solid var(--line2)', borderRadius: 10, font: 'inherit', fontSize: 14 }}
                />
                <input
                  value={destText}
                  onChange={(e) => setDestText(e.target.value)}
                  placeholder="Destination lat,lng"
                  aria-label="Route destination"
                  style={{ padding: '6px 8px', border: '1.5px solid var(--line2)', borderRadius: 10, font: 'inherit', fontSize: 14 }}
                />
                <button type="button" className="btn small primary" onClick={drawRoute}>Route</button>
              </div>
              {plumeArea !== null && (
                <p style={{ marginTop: 10, fontSize: 13.5 }} className="mono">
                  {plumeArea > 0 ? `SAM 3.1 plume · ${plumeArea.toFixed(1)} km² · measured` : 'No plume found in this view.'}
                </p>
              )}
              {escapeMsg && (
                <div className="verdict avoid" style={{ marginTop: 12 }}>
                  <div className="v-head"><span className="v-word">◉ AVOID</span></div>
                  <p>You are in the smoke — fastest way out. The route leaves the plume first.</p>
                </div>
              )}
            </div>
            <div className="console-right">
              <div className="ctl-label">Verdict for a place — tap the map or pick one</div>
              <div className="place-row">
                {LIVE_PLACES.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    className={'place-chip' + (place?.name === p.name ? ' on' : '')}
                    onClick={() => void assessAt(p.lat, p.lng, p.name)}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
              {(assessing || assessment) && (
                <div className={'verdict ' + (assessment ? VCLASS[assessment.level] : 'plain')} role="status">
                  {assessing && !assessment && <p>Assessing this spot…</p>}
                  {assessment && (
                    <>
                      <div className="v-head">
                        <span className="v-word">{VWORD[assessment.level]}</span>
                        <span className="v-place">{place?.name}</span>
                      </div>
                      <p>{assessment.verdict}</p>
                      <div className="v-meta">
                        <span>
                          {arrival === null ? 'no arrival in window' : arrival === 0 ? 'in smoke now' : `arrival ≈ +${arrival} h`}
                        </span>
                        {nearestKm !== null && <span>nearest smoke ≈ {nearestKm.toFixed(0)} km</span>}
                        {assessment.safer_direction && <span>safer: {assessment.safer_direction}</span>}
                      </div>
                    </>
                  )}
                </div>
              )}
              <div className={'ask-log' + (askOpen || askLog.length > 0 ? ' show' : '')}>
                {askLog.map((m, i) => (
                  <div key={i}>
                    <div className="ask-q">{m.q}</div>
                    <div className="ask-a">{m.a}</div>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <input
                    value={askInput}
                    onChange={(e) => setAskInput(e.target.value)}
                    placeholder={place ? `Ask about ${place.name}…` : 'Pick a place first, then ask…'}
                    aria-label="Ask about this place"
                    disabled={!place}
                    style={{ flex: 1, padding: '6px 10px', border: '1.5px solid var(--line2)', borderRadius: 10, font: 'inherit', fontSize: 14 }}
                    onKeyDown={(e) => { if (e.key === 'Enter') void askQuestion() }}
                  />
                  <button type="button" className="btn small primary" onClick={() => void askQuestion()} disabled={!place || !askInput.trim()}>Ask</button>
                </div>
              </div>
            </div>
          </div>

          {routeInfo && (
            <div className="route-note" role="note">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 19c3 0 3-2.5 3-5V7c0-1.7 1.3-3 3-3h9" /><path d="m15 1 4 3-4 3" /><circle cx="4" cy="19" r="1.6" fill="currentColor" /></svg>
              <p><strong>Why the route bends — the routing rule.</strong> {routeInfo} Every segment is tested against the plume and the forecast cone; any segment inside is rejected.</p>
            </div>
          )}

          <div className="trio" aria-label="The three verdict states">
            <div className="vcard avoid">
              <div className="w">◉ AVOID</div>
              <p>Smoke arrives soon, or the place is already in the plume. The card always says <em>when</em> it arrives and <em>which way is safer</em>.</p>
              <div className="rule">RULE · fast arrival → AVOID</div>
            </div>
            <div className="vcard caution">
              <div className="w">◎ CAUTION</div>
              <p>Smoke arrives later in the window, or only clips the area. The card gives the deadline to act by — not just a warning.</p>
              <div className="rule">RULE · later arrival → CAUTION</div>
            </div>
            <div className="vcard safe">
              <div className="w">○ SAFE</div>
              <p>Outside the cone for the full 6 hours. The card still shows the nearest smoke and the wind, so "safe" never reads as "no fire exists."</p>
              <div className="rule">RULE · no arrival in window → SAFE</div>
            </div>
          </div>
          {error && <div className="errbar" style={{ margin: '0 20px 20px' }}>{error}</div>}
        </>
      )}
    </div>
  )
}






