"""Historical fire trend over pre-computed harmonized pipeline output.

Reads backend/data/harmonized/{Country}/{Year}/
harmonized_active_fire_cells.csv and filters rows to the requested bbox
using the lat/lon columns. Raw FIRMS archive CSVs are never touched.

Each file row is one active fire cell on one local solar day, so daily
fire-days are row counts per local_solar_date. The calendar and
year-over-year chart use all loaded years (2016-2025, both countries);
the map, stats, and verdict use the selected year's files. Month_stats
and the significance verdict below are computed in code from those rows.
"""

import math

import harmonized

ARCHIVE_HINT = (
    "Harmonized files not found \u2014 run Harmonization-Pipeline.py "
    "so backend/data/harmonized/{Country}/{Year}/ exists")
DETECTION_DOTS_CAP = 3000
HOTSPOT_TOP = 200

_query_cache = {}


def _loaded_years():
    store = harmonized.ensure_store()
    return sorted({y for (_, y) in store["cols"]})


def _loaded_range():
    years = _loaded_years()
    return f"{years[0]}-{years[-1]}" if years else None


def _scope_daily(bbox, country):
    """{iso: fire-days} across all loaded years for a scope."""
    if bbox is None:
        store = harmonized.ensure_store()
        daily = {}
        for key in store["cols"]:
            if country is not None and key[0] != country:
                continue
            for date, n in store["agg"][key]["daily"].items():
                daily[date] = daily.get(date, 0) + n
        return daily
    daily = {}
    for r in harmonized.iter_bbox_rows(bbox):
        daily[r["iso"]] = daily.get(r["iso"], 0) + 1
    return daily


def _scope_year_rows(bbox, year, country):
    """File rows for one year: an area filter, one country, or global."""
    return harmonized.iter_bbox_rows(bbox, year, country)


def _iso(date_int):
    return f"{date_int // 10000:04d}-{(date_int // 100) % 100:02d}-{date_int % 100:02d}"


def _overlap_factor(rows):
    """Median VIIRS/MODIS monthly distinct-cell ratio over loaded months."""
    monthly = {}
    for r in rows:
        mk = r["date"] // 100
        if r["mask"] & 1:
            monthly.setdefault((mk, 0), set()).add(r["cell"])
        if r["mask"] & 2:
            monthly.setdefault((mk, 1), set()).add(r["cell"])
    ratios = sorted(
        len(monthly[(mk, 1)]) / len(monthly[(mk, 0)])
        for mk in {k[0] for k in monthly}
        if (mk, 0) in monthly and (mk, 1) in monthly
        and monthly[(mk, 0)] and monthly[(mk, 1)]
    )
    if not ratios:
        return {"factor": 1.0, "overlap_months": 0}
    return {"factor": ratios[len(ratios) // 2], "overlap_months": len(ratios)}


def _scoped_factor(bbox, country):
    """Overlap factor for a scope: area rows recomputed, country/global
    combined from the stored per-file month ratios."""
    if bbox is not None:
        return _overlap_factor(year_rows_all(bbox))
    store = harmonized.ensure_store()
    per_month = {}
    for key in store["cols"]:
        if country is not None and key[0] != country:
            continue
        for mk, (mod, vii) in store["agg"][key]["month_ratio"].items():
            if mk in per_month:
                per_month[mk][0] += mod
                per_month[mk][1] += vii
            else:
                per_month[mk] = [mod, vii]
    ratios = sorted(vii / mod for mod, vii in per_month.values() if mod and vii)
    if not ratios:
        return {"factor": 1.0, "overlap_months": 0}
    return {"factor": ratios[len(ratios) // 2], "overlap_months": len(ratios)}


def _country_name(code):
    return harmonized.COUNTRIES.get(code, code)


def month_stats(daily):
    """Per calendar month: mean/std of monthly fire-days over the years present."""
    by_month = {}
    for date, count in daily.items():
        y, m = int(date[:4]), int(date[5:7])
        by_month.setdefault(m, {}).setdefault(y, 0.0)
        by_month[m][y] += count
    stats = {}
    for m, years in by_month.items():
        vals = [years[y] for y in sorted(years)]
        mean = sum(vals) / len(vals)
        var = sum((v - mean) ** 2 for v in vals) / len(vals)
        stats[m] = {"mean": mean, "std": math.sqrt(var), "years": len(vals)}
    return stats


def verdict_yearly(year_totals, year, archive_range):
    """Significance of one year's total vs the loaded-range mean, in code.

    Two-sided z-test of the selected year's fire-day total against the
    mean/std of all loaded yearly totals. Labels honestly: within unless
    p < 0.05.
    """
    totals = [year_totals[y] for y in sorted(year_totals)]
    if len(totals) < 3 or year not in year_totals:
        return {"label": "insufficient history", "p_value": None, "window": None}
    mean = sum(totals) / len(totals)
    var = sum((v - mean) ** 2 for v in totals) / len(totals)
    std = math.sqrt(var)
    current = year_totals[year]
    if std == 0:
        label = "within" if current == mean else ("above" if current > mean else "below")
        return {"label": label, "p_value": 1.0 if current == mean else 0.0,
                "window": archive_range}
    z = (current - mean) / std
    p = math.erfc(abs(z) / math.sqrt(2))
    if p < 0.05:
        label = "significantly above" if z > 0 else "significantly below"
    else:
        label = "within"
    return {"label": label, "p_value": p, "z": z, "window": archive_range}


def ensure_cache():
    """Load the pre-computed files once (delegates to harmonized)."""
    harmonized.ensure_store()
    return True


def ensure_index():
    """Legacy name kept for compatibility."""
    return ensure_cache()


def reset_cache():
    _query_cache.clear()


def _sensor_label(mask):
    if mask == 3:
        return "MODIS+VIIRS"
    return "MODIS" if mask == 1 else "VIIRS"


def query(bbox=None, year=None, country=None):
    """Full trend payload.

    Scope precedence: bbox (area) > country code > global (all loaded
    Brazil + USA rows). Calendar and YoY chart always cover all loaded
    years of the scope; map, stats, and verdict cover the selected year
    (default: latest loaded). No fake data, ever.
    """
    if country is not None and country not in harmonized.COUNTRIES:
        raise ValueError("country must be one of BR, US")
    years = _loaded_years()
    if not years:
        raise FileNotFoundError(ARCHIVE_HINT)
    if year is None:
        year = years[-1]
    if year not in years:
        raise ValueError(f"year must be one of {years[0]}-{years[-1]}")
    if bbox is not None:
        scope = "area"
        ctry = None
    elif country is not None:
        scope = "country"
        ctry = country
    else:
        scope = "global"
        ctry = None
    key = (tuple(bbox) if bbox else None, ctry, year)
    if key not in _query_cache:
        daily_counts = _scope_daily(bbox, ctry)
        daily = {d: {"fire_days": float(n), "modis_only": False}
                 for d, n in daily_counts.items()}
        year_rows = _scope_year_rows(bbox, year, ctry)
        year_totals = {}
        for d, n in daily_counts.items():
            y = int(d[:4])
            year_totals[y] = year_totals.get(y, 0.0) + n
        archive_range = f"{years[0]}-{years[-1]}"
        sensors = set()
        for r in year_rows:
            if r["mask"] & 1:
                sensors.add("MODIS")
            if r["mask"] & 2:
                sensors.add("VIIRS")
        calibration = _scoped_factor(bbox, ctry)
        if scope == "global":
            coverage = (
                f"Showing {year} fire-days across Brazil and the United "
                f"States ({archive_range}). Sensors: "
                f"{', '.join(sorted(sensors))}."
            )
        elif scope == "country":
            coverage = (
                f"Showing {year} fire-days in {_country_name(ctry)} "
                f"({archive_range}). Sensors: {', '.join(sorted(sensors))}."
            )
        else:
            coverage = (
                f"Showing {year} fire-days for this area ({archive_range}). "
                f"Sensors: {', '.join(sorted(sensors))}."
                if year_totals else
                "No fire-days in this area for the archive period."
            )
        hotspots = {}
        hotpos = {}
        for r in year_rows:
            c = r["cell"]
            hotspots[c] = hotspots.get(c, 0) + 1
            if c not in hotpos:
                hotpos[c] = (r["lat"], r["lon"])
        ranked = sorted(hotspots.items(), key=lambda kv: kv[1], reverse=True)[:200]
        step = max(1, len(year_rows) // 3000)
        detections = [{"lat": r["lat"], "lon": r["lon"]}
                      for r in year_rows[::step][:3000]]
        extent = None
        if year_rows:
            lats = [r["lat"] for r in year_rows]
            lons = [r["lon"] for r in year_rows]
            extent = [min(lons), min(lats), max(lons), max(lats)]
        _query_cache[key] = {
            "daily": [
                {"date": d, "fire_days": round(v["fire_days"], 2),
                 "modis_only": v["modis_only"]}
                for d, v in sorted(daily.items())
            ],
            "month_stats": month_stats({d: n for d, n in daily_counts.items()}),
            "verdict": verdict_yearly(year_totals, year, archive_range),
            "hotspots": [
                {"lat": round(hotpos[c][0], 4), "lon": round(hotpos[c][1], 4),
                 "fire_days": n}
                for c, n in ranked
            ],
            "detections": detections,
            "calibration": calibration,
            "coverage_note": coverage,
            "year_range": archive_range,
            "years": years,
            "year": year,
            "scope": scope,
            "country": ctry,
            "bbox": list(bbox) if bbox else None,
            "extent": extent,
        }
    return _query_cache[key]


def year_rows_all(bbox):
    """All file rows in a bbox, any year (for calibration)."""
    if bbox is None:
        return []
    return harmonized.iter_bbox_rows(bbox)


def iter_csv_rows(bbox, year, country=None):
    """Filtered harmonized rows (common columns) for CSV export, oldest first."""
    rows = sorted(_scope_year_rows(bbox, year, country),
                  key=lambda r: (r["date"], r["lat"], r["lon"]))
    for r in rows:
        ds = r["date"]
        yield {
            "latitude": r["lat"],
            "longitude": r["lon"],
            "acq_date": f"{ds // 10000:04d}-{ds // 100 % 100:02d}-{ds % 100:02d}",
            "acq_time": "",
            "satellite": "",
            "instrument": _sensor_label(r["mask"]),
            "confidence": "",
            "frp": r["frp"],
            "daynight": "",
        }
