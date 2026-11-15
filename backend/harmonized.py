"""Country-level harmonized fire history, read from pre-computed pipeline output.

The Harmonization-Pipeline.py script has already been run for every
(country, year) pair. Its outputs live under backend/data/harmonized/
{Country}/{Year}/:
  harmonized_active_fire_cells.csv — one row per (grid cell, local solar
    day): grid_cell, local_solar_date, detections, n_modis, n_viirs,
    frp_total, frp_max, frp_mean, lat, lon, ...
  daily_comparison.csv — per-day reference (used only to cross-check in tests).
  pipeline_summary.txt — human-readable pair summary (not parsed).

This module NEVER reads the raw FIRMS archive CSVs. Each cells file is
read once per process into compact column arrays; requests are served
from memory. Every number returned is counted or summed from those files:
no hardcoded yearly totals, no country multipliers, FRP always summed
from the real frp_total column (never cells x a constant).

Row semantics (cell-day granularity): each file row is one active fire
cell on one local solar day.
  total active fire cells = row count
  total FRP = sum of frp_total (MW)
  daily max FRP = max frp_max over the day's rows
  VIIRS-only = rows with n_modis == 0 and n_viirs > 0
  sensor split both / VIIRS-only / MODIS-only by the same per-row rule
"""

import csv
import os
import pickle
from array import array

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
HARM_DIR = os.path.join(DATA_DIR, "harmonized")
STORE_NAME = "harmonized_store.pkl"
COUNTRIES = {"BR": "Brazil", "US": "United States"}
DIRNAMES = {"BR": "Brazil", "US": "United_States"}

_store = None


def _harm_files():
    """(code, year, cells path, daily path) for every pre-computed pair."""
    out = []
    if not os.path.isdir(HARM_DIR):
        return out
    for code, dirname in DIRNAMES.items():
        cdir = os.path.join(HARM_DIR, dirname)
        if not os.path.isdir(cdir):
            continue
        for year in sorted(os.listdir(cdir)):
            cells = os.path.join(cdir, year, "harmonized_active_fire_cells.csv")
            daily = os.path.join(cdir, year, "daily_comparison.csv")
            if year.isdigit() and os.path.isfile(cells):
                out.append((code, int(year), cells, daily))
    return out


def _parse_int(value, default=0):
    try:
        return int(float(value))
    except (ValueError, TypeError):
        return default


def _parse_float(value, default=0.0):
    try:
        return float(value)
    except (ValueError, TypeError):
        return default


def _iso(date_int):
    return f"{date_int // 10000:04d}-{(date_int // 100) % 100:02d}-{date_int % 100:02d}"


def _read_daily_file(path):
    """{date_iso: (raw_modis, raw_viirs)} from daily_comparison.csv.

    Missing or unreadable file degrades to {} — the chart then shows
    harmonized cells only, never invented raw points.
    """
    out = {}
    try:
        with open(path, encoding="utf-8", newline="") as f:
            for row in csv.DictReader(f):
                date = (row.get("local_solar_date") or "").strip()
                if len(date) != 10:
                    continue
                try:
                    m = round(float(row.get("raw_modis") or 0.0))
                    v = round(float(row.get("raw_viirs") or 0.0))
                except (ValueError, TypeError):
                    continue
                out[date] = (m, v)
    except OSError:
        pass
    return out


def _read_cells_file(path):
    """Parsed rows as (date_iso, lat, lon, n_modis, n_viirs, frp_total,
    frp_max, cell_key). Skips anything that is not an active fire cell row."""
    rows = []
    with open(path, encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            if (row.get("active_fire_cell") or "").strip() != "1":
                continue
            try:
                date = (row.get("local_solar_date") or "").strip()
                if len(date) != 10 or date[4] != "-" or date[7] != "-":
                    continue
                int(date[:4] + date[5:7] + date[8:10])
                lat = float(row["lat"])
                lon = float(row["lon"])
            except (ValueError, TypeError, KeyError):
                continue
            nm = _parse_int(row.get("n_modis"))
            nv = _parse_int(row.get("n_viirs"))
            if nm <= 0 and nv <= 0:
                continue
            rows.append((
                date,
                lat,
                lon,
                nm,
                nv,
                _parse_float(row.get("frp_total")),
                _parse_float(row.get("frp_max")),
                (row.get("grid_cell") or "").strip() or f"{lat:.2f}_{lon:.2f}",
            ))
    return rows


def _summarize(rows):
    """Small aggregates for one (country, year) row list."""
    daily = {}
    monthly = [0] * 12
    weekly = [[0] * 5 for _ in range(12)]
    month_cells = {}
    top = {}
    frp_total = 0.0
    frp_max = 0.0
    both = viirs_only = modis_only = 0
    for date, lat, lon, nm, nv, ft, fm, cell in rows:
        d = top.setdefault(date, {"cells": 0, "frp": 0.0, "max": 0.0})
        d["cells"] += 1
        d["frp"] += ft
        if fm > d["max"]:
            d["max"] = fm
        if nm > 0 and nv > 0:
            both += 1
        elif nv > 0:
            viirs_only += 1
        else:
            modis_only += 1
        m = int(date[5:7])
        if 1 <= m <= 12:
            weekly[m - 1][min(4, (int(date[8:10]) - 1) // 7)] += 1
        mk = date[:7]
        if nm > 0:
            month_cells.setdefault((mk, 0), set()).add(cell)
        if nv > 0:
            month_cells.setdefault((mk, 1), set()).add(cell)
        frp_total += ft
        if fm > frp_max:
            frp_max = fm
    month_ratio = {}
    for (mk, sens), cells in month_cells.items():
        month_ratio.setdefault(mk, [0, 0])[sens] = len(cells)
    for date in sorted(top):
        info = top[date]
        daily[date] = info["cells"]
        m = int(date[5:7])
        if 1 <= m <= 12:
            monthly[m - 1] += info["cells"]
    ranked = sorted(top.items(), key=lambda kv: (-kv[1]["cells"], kv[0]))
    peak = ranked[0] if ranked else (None, None)
    return {
        "cells": len(rows),
        "frp_total": frp_total,
        "frp_max": frp_max,
        "viirs_only": viirs_only,
        "both": both,
        "modis_only": modis_only,
        "daily": daily,
        "monthly": monthly,
        "weekly": weekly,
        "month_ratio": month_ratio,
        "top10": [
            {"date": date, "cells": info["cells"],
             "frp": info["frp"], "max": info["max"]}
            for date, info in ranked[:10]
        ],
        "peak": {"date": peak[0], "cells": peak[1]["cells"]} if peak[0] else None,
    }


def _overlap_ratio(summaries):
    """Median VIIRS/MODIS monthly distinct-cell ratio over loaded months."""
    per_month = {}
    for s in summaries:
        for mk, (modis_cells, viirs_cells) in s["month_ratio"].items():
            if mk in per_month:
                per_month[mk][0] += modis_cells
                per_month[mk][1] += viirs_cells
            else:
                per_month[mk] = [modis_cells, viirs_cells]
    ratios = sorted(
        vii / mod
        for mod, vii in per_month.values()
        if mod > 0 and vii > 0
    )
    if not ratios:
        return 1.0, 0
    return ratios[len(ratios) // 2], len(ratios)


def _store_path():
    return os.path.join(HARM_DIR, STORE_NAME)


def _store_key():
    """Mtime fingerprint of every cells file; rebuild when inputs change."""
    found = _harm_files()
    if not found:
        raise FileNotFoundError(
            "Harmonized files not found — run Harmonization-Pipeline.py "
            "so backend/data/harmonized/{Country}/{Year}/ exists")
    return {os.path.join(str(c), str(y)): os.path.getmtime(p)
            for c, y, p, _ in found}


def ensure_store():
    """Load every pre-computed cells file once; serve from memory after.

    Keeps compact column arrays per (country, year) for bbox filtering plus
    small per-year aggregates. A pickle snapshot makes restarts fast;
    raw archive CSVs are never touched.
    """
    global _store
    if _store is not None:
        return _store
    key = _store_key()
    spath = _store_path()
    if os.path.exists(spath):
        try:
            with open(spath, "rb") as f:
                saved_key, saved_store = pickle.load(f)
            if saved_key == key and "raw" in saved_store:
                _store = saved_store
                return _store
        except (OSError, ValueError, EOFError):
            pass
    found = _harm_files()
    store = {"cols": {}, "bounds": {}, "agg": {}}
    for code, year, path, daily_path in found:
        rows = _read_cells_file(path)
        raw = _read_daily_file(daily_path)
        store.setdefault("raw", {})[(code, year)] = raw
        lat = array("f")
        lon = array("f")
        date = array("i")
        mask = array("b")
        frp = array("f")
        cellids = array("i")
        cellidx = {}
        min_lat = min_lon = float("inf")
        max_lat = max_lon = float("-inf")
        for rdate, la, lo, nm, nv, ft, fm, cell in rows:
            lat.append(la)
            lon.append(lo)
            date.append(int(rdate[:4] + rdate[5:7] + rdate[8:10]))
            mask.append((1 if nm > 0 else 0) | (2 if nv > 0 else 0))
            frp.append(ft)
            cid = cellidx.get(cell)
            if cid is None:
                cid = len(cellidx)
                cellidx[cell] = cid
            cellids.append(cid)
            if la < min_lat:
                min_lat = la
            if la > max_lat:
                max_lat = la
            if lo < min_lon:
                min_lon = lo
            if lo > max_lon:
                max_lon = lo
        store["cols"][(code, year)] = {
            "lat": lat, "lon": lon, "date": date, "mask": mask, "frp": frp,
            "cellids": cellids,
        }
        store["bounds"][(code, year)] = (
            (min_lon, min_lat, max_lon, max_lat) if len(date) else None)
        store["agg"][(code, year)] = _summarize(rows)
    try:
        with open(spath, "wb") as f:
            pickle.dump((key, store), f, protocol=4)
    except OSError:
        pass
    _store = store
    return _store


def reset_cache():
    global _store
    _store = None


def iter_bbox_rows(bbox=None, year=None, country=None):
    """Pre-computed rows for a scope as small dicts (lat, lon, date int,
    mask bit 1=MODIS 2=VIIRS, frp, cell key).

    bbox None = every row (optionally narrowed to one year and/or one
    country code); otherwise only rows inside the bbox. Files outside the
    bbox are skipped by their bounds; nothing is re-read per call. Cell
    ids are offset per file so keys stay globally unique.
    """
    store = ensure_store()
    if bbox is None:
        min_lon = min_lat = float("-inf")
        max_lon = max_lat = float("inf")
    else:
        min_lon, min_lat, max_lon, max_lat = bbox
    out = []
    keys = sorted(store["cols"])
    for fi, (code, y) in enumerate(keys):
        if year is not None and y != year:
            continue
        if country is not None and code != country:
            continue
        bounds = store["bounds"][(code, y)]
        if bounds is None:
            continue
        blo, bla, bho, bha = bounds
        if bho < min_lon or blo > max_lon or bha < min_lat or bla > max_lat:
            continue
        cols = store["cols"][(code, y)]
        base = fi * 10_000_000  # per-file ids share 0..N: keep them global
        lat, lon = cols["lat"], cols["lon"]
        for i in range(len(cols["date"])):
            la, lo = lat[i], lon[i]
            if min_lat <= la <= max_lat and min_lon <= lo <= max_lon:
                dint = cols["date"][i]
                out.append({
                    "lat": la,
                    "lon": lo,
                    "date": dint,
                    "mask": cols["mask"][i],
                    "frp": cols["frp"][i],
                    "cell": base + cols["cellids"][i],
                    "iso": _iso(dint),
                })
    return out


def get_years():
    store = ensure_store()
    years = sorted({y for (_, y) in store["cols"]})
    codes = sorted({c for (c, _) in store["cols"]})
    return {
        "years": years,
        "archive_range": f"{years[0]}-{years[-1]}" if years else None,
        "countries": [
            {"code": code, "name": COUNTRIES[code]} for code in codes
        ],
    }


def get_payload(country, year=None):
    """Everything the Harmonized tab needs for one country + year."""
    store = ensure_store()
    if country not in COUNTRIES:
        raise ValueError("country must be one of BR, US")
    years = sorted(y for (c, y) in store["cols"] if c == country)
    if not years:
        raise ValueError("no years loaded for this country")
    if year is None:
        year = years[-1]
    if year not in years:
        raise ValueError(f"year must be one of {years[0]}-{years[-1]}")
    agg = store["agg"][(country, year)]
    yearly = []
    for y in years:
        a = store["agg"][(country, y)]
        yearly.append({"year": y, "cells": a["cells"],
                       "frp_total": a["frp_total"], "frp_max": a["frp_max"],
                       "viirs_cells": a["viirs_only"]})
    avg = sum(r["cells"] for r in yearly) / len(yearly)
    prior = next((r for r in yearly if r["year"] == year - 1), None)
    peak_month = max(range(12), key=lambda m: agg["monthly"][m]) + 1
    monthly_avg = [
        sum(store["agg"][(country, y)]["monthly"][m] for y in years) / len(years)
        for m in range(12)
    ]
    factor, nmonths = _overlap_ratio(
        [store["agg"][(country, y)] for y in years])
    raw = store.get("raw", {}).get((country, year), {})
    series = []
    for date in sorted(set(agg["daily"]) | set(raw)):
        m, v = raw.get(date, (0, 0))
        series.append({"date": date, "cells": agg["daily"].get(date, 0),
                       "raw_modis": m, "raw_viirs": v})
    return {
        "country": country,
        "country_name": COUNTRIES[country],
        "year": year,
        "years": years,
        "archive_range": f"{years[0]}-{years[-1]}",
        "yearly": yearly,
        "average_cells": avg,
        "monthly_avg": monthly_avg,
        "daily": series,
        "monthly": agg["monthly"],
        "weekly": agg["weekly"],
        "top10": agg["top10"],
        "peak": agg["peak"],
        "kpis": {
            "cells": agg["cells"],
            "frp_total": agg["frp_total"],
            "viirs_cells": agg["viirs_only"],
        },
        "sensor_split": {
            "both": agg["both"],
            "viirs_only": agg["viirs_only"],
            "modis_only": agg["modis_only"],
        },
        "overlap_ratio": factor,
        "overlap_months": nmonths,
        "verdict": {
            "pct": (agg["cells"] - avg) / avg * 100 if avg else 0.0,
            "above": agg["cells"] >= avg,
            "prior_cells": prior["cells"] if prior else None,
            "peak_month": peak_month,
        },
        "coverage_note": (
            f"Computed from FIRMS archive, {COUNTRIES[country]}, "
            f"{years[0]}-{years[-1]}."
        ),
    }
