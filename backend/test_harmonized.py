"""Offline tests for the /harmonized reader (pre-computed pipeline files)."""

import csv
import os
import tempfile
import unittest
import unittest.mock

import harmonized

HEADER = ["grid_cell", "local_solar_date", "detections", "n_modis", "n_viirs",
          "frp_total", "frp_max", "frp_mean", "lat", "lon", "active_fire_cell"]


def cell_row(cell, date, lat, lon, nm, nv, ft, fm):
    return {"grid_cell": cell, "local_solar_date": date,
            "detections": str(nm + nv), "n_modis": str(nm), "n_viirs": str(nv),
            "frp_total": str(ft), "frp_max": str(fm),
            "frp_mean": str(ft / max(1, nm + nv)),
            "lat": str(lat), "lon": str(lon), "active_fire_cell": "1"}


def seed(pairs):
    """pairs: [(country_dir, year, rows, daily_rows?)]. Returns tmp layout."""
    tmp = tempfile.mkdtemp()
    for item in pairs:
        cdir, year, rows = item[0], item[1], item[2]
        daily_rows = item[3] if len(item) > 3 else []
        ydir = os.path.join(tmp, cdir, str(year))
        os.makedirs(ydir)
        with open(os.path.join(ydir, "harmonized_active_fire_cells.csv"),
                  "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=HEADER)
            w.writeheader()
            w.writerows(rows)
        with open(os.path.join(ydir, "daily_comparison.csv"),
                  "w", newline="") as f:
            w = csv.DictWriter(
                f, fieldnames=["local_solar_date", "cells", "frp_total_daily",
                               "frp_max_daily", "raw_modis", "raw_viirs"])
            w.writeheader()
            w.writerows(daily_rows)
        with open(os.path.join(ydir, "pipeline_summary.txt"), "w") as f:
            f.write("summary for cross-checks\n")
    return tmp


def payload(tmp, country, year):
    with unittest.mock.patch.object(harmonized, "HARM_DIR", tmp):
        harmonized.reset_cache()
        try:
            return harmonized.get_payload(country, year)
        finally:
            harmonized.reset_cache()


class TestHarmonizedReader(unittest.TestCase):
    def _br(self):
        rows2020 = [
            cell_row("A", "2020-01-05", -1.80, -53.48, 2, 3, 12.0, 7.0),
            cell_row("B", "2020-01-05", -1.81, -53.48, 0, 2, 4.0, 4.0),
            cell_row("A", "2020-01-06", -1.80, -53.48, 1, 0, 6.0, 6.0),
            # Inactive + sensorless rows are ignored, never counted.
            dict(cell_row("C", "2020-01-06", -1.82, -53.48, 1, 1, 9.0, 9.0),
                 active_fire_cell="0"),
            dict(cell_row("D", "2020-01-06", -1.83, -53.48, 0, 0, 3.0, 3.0)),
        ]
        rows2021 = [cell_row("A", "2021-02-05", -1.80, -53.48, 1, 1, 8.0, 8.0)]
        return seed([("Brazil", 2020, rows2020), ("Brazil", 2021, rows2021)])

    def test_aggregates_from_files(self):
        out = payload(self._br(), "BR", 2020)
        self.assertEqual(out["country"], "BR")
        self.assertEqual(out["years"], [2020, 2021])
        self.assertEqual(out["archive_range"], "2020-2021")
        self.assertEqual(out["kpis"]["cells"], 3)
        self.assertAlmostEqual(out["kpis"]["frp_total"], 22.0)
        self.assertEqual(
            [(d["date"], d["cells"], d["raw_modis"], d["raw_viirs"])
             for d in out["daily"]],
            [("2020-01-05", 2, 0, 0), ("2020-01-06", 1, 0, 0)])
        self.assertEqual(out["monthly"], [0] * 0 + [3] + [0] * 11)
        self.assertEqual(out["top10"][0]["date"], "2020-01-05")
        self.assertEqual(out["top10"][0]["cells"], 2)
        self.assertAlmostEqual(out["top10"][0]["frp"], 16.0)
        self.assertAlmostEqual(out["top10"][0]["max"], 7.0)
        self.assertEqual(out["sensor_split"],
                         {"both": 1, "viirs_only": 1, "modis_only": 1})
        self.assertEqual(out["peak"], {"date": "2020-01-05", "cells": 2})
        self.assertTrue(out["coverage_note"].endswith("2020-2021."))

    def test_verdict_and_overlap(self):
        out = payload(self._br(), "BR", 2021)
        # avg = (3 + 1) / 2 = 2.0; 2021 is 50% below.
        self.assertAlmostEqual(out["average_cells"], 2.0)
        self.assertAlmostEqual(out["verdict"]["pct"], -50.0)
        self.assertFalse(out["verdict"]["above"])
        self.assertEqual(out["verdict"]["peak_month"], 2)
        # Jan 2020: VIIRS cells {A, B} = 2, MODIS cells {A} = 1 -> 2.0;
        # Feb 2021: 1 / 1 -> 1.0; median of [2.0, 1.0] = 2.0.
        self.assertAlmostEqual(out["overlap_ratio"], 2.0)
        self.assertEqual(out["overlap_months"], 2)

    def test_validation(self):
        tmp = self._br()
        with unittest.mock.patch.object(harmonized, "HARM_DIR", tmp):
            harmonized.reset_cache()
            try:
                with self.assertRaises(ValueError):
                    harmonized.get_payload("XX", 2020)
                with self.assertRaises(ValueError):
                    harmonized.get_payload("BR", 2019)
                meta = harmonized.get_years()
            finally:
                harmonized.reset_cache()
        self.assertEqual(meta["years"], [2020, 2021])
        self.assertEqual([c["code"] for c in meta["countries"]], ["BR"])

    def test_daily_series_merges_raw_counts(self):
        daily_rows = [
            {"local_solar_date": "2020-01-05", "cells": "2",
             "frp_total_daily": "16.0", "frp_max_daily": "7.0",
             "raw_modis": "5", "raw_viirs": "9"},
            # Raw-only date (spillover): present with zero harmonized cells.
            {"local_solar_date": "2020-01-07", "cells": "0",
             "frp_total_daily": "0.0", "frp_max_daily": "0.0",
             "raw_modis": "1", "raw_viirs": "0"},
        ]
        rows2020 = [
            cell_row("A", "2020-01-05", -1.80, -53.48, 2, 3, 12.0, 7.0),
            cell_row("B", "2020-01-05", -1.81, -53.48, 0, 2, 4.0, 4.0),
        ]
        tmp = seed([("Brazil", 2020, rows2020, daily_rows)])
        out = payload(tmp, "BR", 2020)
        self.assertEqual(
            [(d["date"], d["cells"], d["raw_modis"], d["raw_viirs"])
             for d in out["daily"]],
            [("2020-01-05", 2, 5, 9), ("2020-01-07", 0, 1, 0)])

    def test_missing_daily_file_degrades_to_zeros(self):
        tmp = tempfile.mkdtemp()
        ydir = os.path.join(tmp, "Brazil", "2020")
        os.makedirs(ydir)
        with open(os.path.join(ydir, "harmonized_active_fire_cells.csv"),
                  "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=HEADER)
            w.writeheader()
            w.writerow(cell_row("A", "2020-01-05", -1.80, -53.48,
                               2, 3, 12.0, 7.0))
        out = payload(tmp, "BR", 2020)
        self.assertEqual(
            [(d["date"], d["cells"], d["raw_modis"], d["raw_viirs"])
             for d in out["daily"]],
            [("2020-01-05", 1, 0, 0)])

    def test_cache_reuse_without_rescan(self):
        tmp = self._br()
        with unittest.mock.patch.object(harmonized, "HARM_DIR", tmp):
            harmonized.reset_cache()
            try:
                before = harmonized.ensure_store()
                harmonized.get_payload("BR", 2020)
                self.assertIs(harmonized.ensure_store(), before)
            finally:
                harmonized.reset_cache()


if __name__ == "__main__":
    unittest.main()
