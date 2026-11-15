export type LatLng = [number, number]

export function pointInPoly(lat: number, lng: number, poly: LatLng[]): boolean {
  let inside = false
  for (let i = 0; i < poly.length; i++) {
    const [lat1, lng1] = poly[i]!
    const [lat2, lng2] = poly[(i + 1) % poly.length]!
    if (lng1 > lng !== lng2 > lng) {
      const y = lat1 + ((lat2 - lat1) * (lng - lng1)) / (lng2 - lng1)
      if (y > lat) inside = !inside
    }
  }
  return inside
}

function segInt(a: LatLng, b: LatLng, c: LatLng, d: LatLng): boolean {
  const cross = (p: LatLng, q: LatLng, r: LatLng) =>
    (q[1] - p[1]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[1] - p[1])
  const d1 = cross(c, d, a)
  const d2 = cross(c, d, b)
  const d3 = cross(a, b, c)
  const d4 = cross(a, b, d)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

export function segHitsPoly(a: LatLng, b: LatLng, poly: LatLng[]): boolean {
  for (let i = 0; i < poly.length; i++) {
    if (segInt(a, b, poly[i]!, poly[(i + 1) % poly.length]!)) return true
  }
  return false
}

function nearestBoundaryPoint(lat: number, lng: number, poly: LatLng[]): LatLng {
  let best: LatLng = poly[0]!
  let bestD = Infinity
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = [poly[i]![0], poly[i]![1]]
    const [bx, by] = [poly[(i + 1) % poly.length]![0], poly[(i + 1) % poly.length]![1]]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((lat - ax) * dx + (lng - ay) * dy) / len2))
    const px = ax + t * dx
    const py = ay + t * dy
    const d = (lat - px) * (lat - px) + (lng - py) * (lng - py)
    if (d < bestD) {
      bestD = d
      best = [px, py]
    }
  }
  return best
}

// Smoke-aware routing in code, no routing API: the plume polygon and the
// forecast cone are no-go areas; waypoints step around whichever segment
// they block. Origin inside the plume becomes an escape route out first.
export function planRoute(origin: LatLng, dest: LatLng, noGos: LatLng[][]): { path: LatLng[]; escaped: boolean } {
  let start = origin
  let escaped = false
  for (const poly of noGos) {
    if (poly.length > 2 && pointInPoly(origin[0], origin[1], poly)) {
      const [blat, blng] = nearestBoundaryPoint(origin[0], origin[1], poly)
      let clat = 0
      let clng = 0
      for (const [la, lo] of poly) {
        clat += la
        clng += lo
      }
      clat /= poly.length
      clng /= poly.length
      const push = 0.02
      const dlat = blat - clat
      const dlng = blng - clng
      const n = Math.hypot(dlat, dlng) || 1
      start = [blat + (dlat / n) * push, blng + (dlng / n) * push]
      escaped = true
      break
    }
  }
  const hitsAny = (a: LatLng, b: LatLng) => noGos.some((p) => p.length > 2 && segHitsPoly(a, b, p))
  const insideAny = (lat: number, lng: number) =>
    noGos.some((p) => p.length > 2 && pointInPoly(lat, lng, p))
  const waypoints: LatLng[] = [start, dest]
  for (let iter = 0; iter < 6; iter++) {
    let blocked = -1
    for (let i = 0; i < waypoints.length - 1; i++) {
      if (hitsAny(waypoints[i]!, waypoints[i + 1]!)) {
        blocked = i
        break
      }
    }
    if (blocked === -1) break
    const a = waypoints[blocked]!
    const b = waypoints[blocked + 1]!
    const mx = (a[0] + b[0]) / 2
    const my = (a[1] + b[1]) / 2
    // Pairs are [lat, lng]: the perpendicular of (dlat, dlng) is (-dlng, dlat).
    const dlat = b[0] - a[0]
    const dlng = b[1] - a[1]
    const len = Math.hypot(dlat, dlng) || 1
    const nx = -dlng / len
    const ny = dlat / len
    let placed = false
    for (const c of [0.05, 0.1, 0.2, 0.4, 0.8]) {
      for (const s of [1, -1]) {
        const cand: LatLng = [mx + nx * s * c, my + ny * s * c]
        if (insideAny(cand[0], cand[1])) continue
        if (!hitsAny(a, cand) && !hitsAny(cand, b)) {
          waypoints.splice(blocked + 1, 0, cand)
          placed = true
          break
        }
      }
      if (placed) break
    }
    if (!placed) break
  }
  return { path: escaped ? [origin, ...waypoints] : waypoints, escaped }
}
