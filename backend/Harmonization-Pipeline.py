"""
Harmonization Pipeline - MODIS (1km) + VIIRS (375m) Active Fire Harmonization
Brazil / Any AOI - 2018 baseline, extensible to 2000-2026

Steps:
  1. Schema & Quality Alignment (timestamp, confidence, static masking)
  2. Spatial Grid Aggregation (0.01 deg ~1.11km grid, H3 Res 8 equivalent)
     - Binary Active Fire Cells: 1 per (grid_cell, local_solar_date)
  3. Temporal Deduplication & Sensor Weighting (coincident overpass collapse + scaling ratio)
  4. FRP Normalization (sum / max per cell, NOT brightness temp)

Usage:
  # Interactive file picker (Tkinter)
  python harmonization_pipeline.py

  # Explicit files
  python harmonization_pipeline.py --modis modis_2018_Brazil.csv --viirs viirs-jpss1_2018_Brazil.csv --out-dir ./output

  # Custom grid + output
  python harmonization_pipeline.py --modis MODIS.csv --viirs VIIRS.csv --grid-deg 0.01 --out-dir ./output --make-plot

Requirements:
  pip install pandas numpy matplotlib
  # Optional: pip install h3  (if installed, will use H3 Res 8 instead of 0.01 deg grid)
"""

import argparse
import math
import os
import sys
from pathlib import Path

import pandas as pd
import numpy as np


# ---------------------------------------------------------------------------
# 1. FILE SELECTION
# ---------------------------------------------------------------------------

def select_files_interactive():
    """Let user pick MODIS and VIIRS files via file dialog. Fallback to CLI input."""
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)

        print("Select MODIS file (e.g. modis_2018_Brazil.csv) ...")
        modis_path = filedialog.askopenfilename(
            title="Select MODIS CSV file",
            filetypes=[("CSV files", "*.csv"), ("All files", "*.*")]
        )
        if not modis_path:
            print("No MODIS file selected. Exiting.")
            sys.exit(0)

        print("Select VIIRS file (e.g. viirs-jpss1_2018_Brazil.csv) ...")
        viirs_path = filedialog.askopenfilename(
            title="Select VIIRS CSV file",
            filetypes=[("CSV files", "*.csv"), ("All files", "*.*")]
        )
        if not viirs_path:
            print("No VIIRS file selected. Exiting.")
            sys.exit(0)

        root.destroy()
        return modis_path, viirs_path

    except Exception as e:
        print(f"Tkinter file dialog not available ({e}). Falling back to manual input.")
        modis_path = input("Enter path to MODIS CSV: ").strip().strip('"').strip("'")
        viirs_path = input("Enter path to VIIRS CSV: ").strip().strip('"').strip("'")
        return modis_path, viirs_path


def parse_args():
    p = argparse.ArgumentParser(description="MODIS + VIIRS Fire Harmonization Pipeline")
    p.add_argument("--modis", type=str, default=None, help="Path to MODIS CSV (e.g. modis_2018_Brazil.csv)")
    p.add_argument("--viirs", type=str, default=None, help="Path to VIIRS CSV (e.g. viirs-jpss1_2018_Brazil.csv)")
    # Alias for typo MODS
    p.add_argument("--mods", type=str, default=None, help="Alias for --modis")
    p.add_argument("--out-dir", type=str, default="./harmonized_output", help="Output directory")
    p.add_argument("--grid-deg", type=float, default=0.01, help="Grid size in degrees (0.01 ~= 1.11 km at equator). Ignored if --use-h3 is set.")
    p.add_argument("--use-h3", action="store_true", help="Use Uber H3 Res 8 instead of 0.01 deg grid (requires pip install h3)")
    p.add_argument("--h3-res", type=int, default=8, help="H3 resolution (7 ~= 5 km2, 8 ~= 0.7 km2). Default 8.")
    p.add_argument("--modis-min-confidence", type=int, default=30, help="MODIS confidence threshold (default 30)")
    p.add_argument("--make-plot", action="store_true", help="Save daily comparison plot PNG")
    p.add_argument("--save-canonical", action="store_true", help="Also save filtered canonical detections CSV (large)")
    args = p.parse_args()
    # Resolve MODS alias
    if args.mods and not args.modis:
        args.modis = args.mods
    return args


# ---------------------------------------------------------------------------
# 2. STEP 1 - SCHEMA & QUALITY ALIGNMENT
# ---------------------------------------------------------------------------

def parse_acq_time_series(acq_time_series):
    """Parse acq_time like 58 -> 00:58, 233 -> 02:33, 1325 -> 13:25."""
    hours = []
    minutes = []
    for t in acq_time_series:
        s = f"{int(t):04d}"
        h = int(s[:2])
        m = int(s[2:])
        # Guard against malformed minutes >=60
        if m >= 60:
            h += m // 60
            m = m % 60
        hours.append(h)
        minutes.append(m)
    return np.array(hours), np.array(minutes)


def add_timestamps(df):
    """
    Timestamp standardization:
    - Combine acq_date + acq_time (UTC) -> utc_datetime (ISO-8601)
    - Convert to AOI local solar date: solar = UTC + longitude/15h
      This prevents overnight fires splitting across calendar days.
    """
    df = df.copy()
    df["acq_date_dt"] = pd.to_datetime(df["acq_date"])
    h, m = parse_acq_time_series(df["acq_time"].values)
    df["utc_hour"] = h
    df["utc_min"] = m
    df["utc_datetime"] = (
        df["acq_date_dt"]
        + pd.to_timedelta(df["utc_hour"], unit="h")
        + pd.to_timedelta(df["utc_min"], unit="m")
    )
    df["iso_utc"] = df["utc_datetime"].dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    # Local solar time
    df["solar_offset_h"] = df["longitude"] / 15.0
    df["solar_datetime"] = df["utc_datetime"] + pd.to_timedelta(df["solar_offset_h"], unit="h")
    df["local_solar_date"] = df["solar_datetime"].dt.date
    return df


def harmonize_confidence_and_mask(modis, viirs, modis_min_conf=30):
    """
    Confidence harmonization + Static source masking:
    - MODIS: numeric 0-100, retain >=30
    - VIIRS: categorical l/n/h, retain nominal (n) / high (h)
    - Both: type == 0 for presumed vegetation fire
             (VIIRS: 0=veg, 1=volcano, 2=static land, 3=offshore)
    """
    # MODIS
    modis_f = modis[(modis["confidence"] >= modis_min_conf) & (modis["type"] == 0)].copy()
    # VIIRS - confidence may be 'l','n','h' or 'low','nominal','high'
    viirs = viirs.copy()
    viirs["confidence_norm"] = viirs["confidence"].astype(str).str.lower().str.strip()
    keep_viirs = viirs["confidence_norm"].isin(["n", "h", "nominal", "high"])
    viirs_f = viirs[keep_viirs & (viirs["type"] == 0)].copy()
    return modis_f, viirs_f


def to_canonical_schema(df, sensor_label):
    """Map to canonical tabular schema before spatial processing."""
    out = pd.DataFrame({
        "latitude": df["latitude"],
        "longitude": df["longitude"],
        "acq_date": df["acq_date"],
        "acq_time": df["acq_time"],
        "iso_utc": df["iso_utc"],
        "utc_datetime": df["utc_datetime"],
        "solar_datetime": df["solar_datetime"],
        "local_solar_date": df["local_solar_date"],
        "frp": df["frp"].fillna(0),
        "confidence_raw": df["confidence"],
        "type": df["type"],
        "satellite": df["satellite"],
        "instrument": df["instrument"],
        "sensor": sensor_label,
    })
    # Brightness: MODIS 'brightness' vs VIIRS 'bright_ti4'
    if "brightness" in df.columns:
        out["brightness"] = df["brightness"]
    elif "bright_ti4" in df.columns:
        out["brightness"] = df["bright_ti4"]
    else:
        out["brightness"] = np.nan
    return out


# ---------------------------------------------------------------------------
# 3. STEP 2 - SPATIAL GRID AGGREGATION
# ---------------------------------------------------------------------------

def assign_grid_cell(df, grid_deg=0.01, use_h3=False, h3_res=8):
    """Snap detections onto a common equal-area grid."""
    df = df.copy()
    if use_h3:
        try:
            import h3
        except ImportError:
            print("WARNING: h3 not installed, falling back to 0.01 deg grid. pip install h3")
            use_h3 = False

    if use_h3:
        def _to_cell(lat, lon):
            try:
                return h3.latlng_to_cell(lat, lon, h3_res)
            except AttributeError:
                return h3.geo_to_h3(lat, lon, h3_res)
        df["grid_cell"] = [_to_cell(lat, lon) for lat, lon in zip(df["latitude"], df["longitude"])]
        df["grid_type"] = f"H3_R{h3_res}"
    else:
        # 0.01 deg grid (~1.11 km). floor() handles negative lon/lat correctly.
        df["grid_lat"] = (df["latitude"] / grid_deg).apply(math.floor).astype(int)
        df["grid_lon"] = (df["longitude"] / grid_deg).apply(math.floor).astype(int)
        df["grid_cell"] = df["grid_lat"].astype(str) + "_" + df["grid_lon"].astype(str)
        df["grid_type"] = f"GRID_{grid_deg}deg"
    return df


# ---------------------------------------------------------------------------
# 4. STEP 3 + 4 - TEMPORAL DEDUP + FRP
# ---------------------------------------------------------------------------

def aggregate_cells(canon):
    """
    Step 2 + 3 + 4 combined:
    - Group by (grid_cell, local_solar_date) -> collapses coincident overpasses
    - Binary occupancy: active_fire_cell = 1
    - FRP: frp_total = sum VIIRS FRP in cell (approx MODIS integrated FRP)
           frp_max   = daily max FRP per cell (avoids multi-overpass inflation)
    """
    canon["is_modis"] = canon["instrument"] == "MODIS"
    canon["is_viirs"] = canon["instrument"] == "VIIRS"

    agg = canon.groupby(["grid_cell", "local_solar_date"], as_index=False).agg(
        detections=("frp", "count"),
        n_modis=("is_modis", "sum"),
        n_viirs=("is_viirs", "sum"),
        frp_total=("frp", "sum"),
        frp_max=("frp", "max"),
        frp_mean=("frp", "mean"),
        lat=("latitude", "mean"),
        lon=("longitude", "mean"),
        utc_min=("utc_datetime", "min"),
        utc_max=("utc_datetime", "max"),
    )
    agg["active_fire_cell"] = 1
    agg["frp_mean_per_cell"] = agg["frp_total"] / agg["detections"]
    return agg


def compute_scaling_ratio(agg):
    """Cross-calibration ratio for pre-2012 MODIS-only extension."""
    both = ((agg["n_modis"] > 0) & (agg["n_viirs"] > 0)).sum()
    viirs_only = ((agg["n_modis"] == 0) & (agg["n_viirs"] > 0)).sum()
    modis_only = ((agg["n_modis"] > 0) & (agg["n_viirs"] == 0)).sum()
    modis_cells = modis_only + both
    scaling = len(agg) / modis_cells if modis_cells > 0 else np.nan
    return {
        "both": int(both),
        "viirs_only": int(viirs_only),
        "modis_only": int(modis_only),
        "total_cells": int(len(agg)),
        "modis_cells": int(modis_cells),
        "scaling_ratio_total_over_modis": float(scaling),
        "viirs_only_fraction": float(viirs_only / len(agg)) if len(agg) else 0,
    }


def make_daily_comparison(agg, modis_f, viirs_f):
    daily = agg.groupby("local_solar_date", as_index=False).agg(
        cells=("active_fire_cell", "sum"),
        frp_total_daily=("frp_total", "sum"),
        frp_max_daily=("frp_max", "max"),
    )
    raw_modis = modis_f.groupby("local_solar_date").size().rename("raw_modis").reset_index()
    raw_viirs = viirs_f.groupby("local_solar_date").size().rename("raw_viirs").reset_index()
    daily = daily.merge(raw_modis, on="local_solar_date", how="left")
    daily = daily.merge(raw_viirs, on="local_solar_date", how="left")
    daily = daily.fillna(0)
    return daily


def make_plot(daily, out_path):
    try:
        import matplotlib.pyplot as plt
        daily_plot = daily.copy()
        daily_plot["local_solar_date"] = pd.to_datetime(daily_plot["local_solar_date"])
        daily_plot = daily_plot.sort_values("local_solar_date")
        plt.figure(figsize=(11, 4.5))
        plt.plot(daily_plot["local_solar_date"], daily_plot["raw_modis"], label="Raw MODIS points", alpha=0.6)
        plt.plot(daily_plot["local_solar_date"], daily_plot["raw_viirs"], label="Raw VIIRS points", alpha=0.6)
        plt.plot(daily_plot["local_solar_date"], daily_plot["cells"], label="Harmonized Active Fire Cells (1km grid)", linewidth=2)
        plt.title("Raw Counts vs Harmonized Active Fire Cells")
        plt.ylabel("Daily Count")
        plt.legend()
        plt.tight_layout()
        plt.savefig(out_path, dpi=200)
        plt.close()
        print(f"Plot saved: {out_path}")
    except Exception as e:
        print(f"Could not make plot: {e}")


# ---------------------------------------------------------------------------
# 5. MAIN
# ---------------------------------------------------------------------------

def main():
    args = parse_args()

    if args.modis and args.viirs:
        modis_path, viirs_path = args.modis, args.viirs
    else:
        modis_path, viirs_path = select_files_interactive()

    print(f"MODIS file: {modis_path}")
    print(f"VIIRS file: {viirs_path}")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # --- Load ---
    print("Loading CSVs...")
    modis = pd.read_csv(modis_path)
    viirs = pd.read_csv(viirs_path)
    print(f"Raw: MODIS {len(modis):,} | VIIRS {len(viirs):,}")

    # --- Step 1: Timestamps ---
    modis = add_timestamps(modis)
    viirs = add_timestamps(viirs)

    # --- Step 1: Confidence + Masking ---
    modis_f, viirs_f = harmonize_confidence_and_mask(modis, viirs, modis_min_conf=args.modis_min_confidence)
    print(f"After Step 1 filter: MODIS {len(modis_f):,} | VIIRS {len(viirs_f):,}")

    # --- Canonical schema ---
    canon_modis = to_canonical_schema(modis_f, "MODIS")
    canon_viirs = to_canonical_schema(viirs_f, "VIIRS")
    canon = pd.concat([canon_modis, canon_viirs], ignore_index=True)
    print(f"Combined canonical: {len(canon):,}")

    if args.save_canonical:
        canon_path = out_dir / "canonical_filtered.csv"
        canon.to_csv(canon_path, index=False)
        print(f"Saved canonical: {canon_path}")

    # --- Step 2: Grid ---
    canon = assign_grid_cell(canon, grid_deg=args.grid_deg, use_h3=args.use_h3, h3_res=args.h3_res)
    print(f"Unique grid cells: {canon['grid_cell'].nunique():,}")

    # --- Step 3 + 4: Aggregate ---
    agg = aggregate_cells(canon)
    print(f"Active Fire Cell-Days: {len(agg):,}  (raw {len(canon):,} -> ratio {len(canon)/len(agg):.2f}x collapsed)")

    # --- Scaling ratio ---
    stats = compute_scaling_ratio(agg)
    print("\n--- Cross-calibration (overlap period) ---")
    print(f"Both sensors: {stats['both']:,} | VIIRS-only: {stats['viirs_only']:,} | MODIS-only: {stats['modis_only']:,}")
    print(f"VIIRS-only fraction: {stats['viirs_only_fraction']:.1%} (small fires MODIS missed)")
    print(f"Scaling ratio total/modis = {stats['scaling_ratio_total_over_modis']:.3f}")
    print(f"Use for pre-2012: adjusted = modis_cell_count * {stats['scaling_ratio_total_over_modis']:.3f}")

    # --- Daily comparison ---
    daily = make_daily_comparison(agg, modis_f, viirs_f)

    # --- Save ---
    agg_path = out_dir / "harmonized_active_fire_cells.csv"
    daily_path = out_dir / "daily_comparison.csv"
    agg.to_csv(agg_path, index=False)
    daily.to_csv(daily_path, index=False)
    print(f"\nSaved: {agg_path}")
    print(f"Saved: {daily_path}")

    if args.make_plot:
        make_plot(daily, out_dir / "daily_harmonized_plot.png")

    # Summary txt
    summary = (
        f"Harmonization Pipeline Results\n"
        f"MODIS: {modis_path} ({len(modis):,} raw -> {len(modis_f):,} filtered)\n"
        f"VIIRS: {viirs_path} ({len(viirs):,} raw -> {len(viirs_f):,} filtered)\n"
        f"Combined canonical: {len(canon):,}\n"
        f"Unique grid cells: {canon['grid_cell'].nunique():,}\n"
        f"Active Fire Cell-Days: {len(agg):,}\n"
        f"Both: {stats['both']:,} | VIIRS-only: {stats['viirs_only']:,} | MODIS-only: {stats['modis_only']:,}\n"
        f"Scaling ratio (total/modis): {stats['scaling_ratio_total_over_modis']:.3f}\n"
        f"Grid: {canon['grid_type'].iloc[0] if len(canon) else 'N/A'}\n"
    )
    (out_dir / "pipeline_summary.txt").write_text(summary)
    print("\n" + summary)
    print("Done.")


if __name__ == "__main__":
    main()
