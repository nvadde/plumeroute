"""Offline tests for /trend over pre-computed pipeline files (bbox + year)."""

import csv
import os
import tempfile
import unittest
import unittest.mock

import harmonized
import trend

HEADER = ["grid_cell", "local_solar_date", "detections", "n_modis", "n_viirs",
          "frp_total", "frp_max", "frp_mean", "lat", "lon", "active_fire_cell"]


def cell_row(cell, date, lat, lon, nm, nv, ft, fm=0.0, active="1"):
    return {"grid_cell": cell, "local_solar_date": date,
            "detections": str(nm + nv), "n_modis": str(nm), "n_viirs": str(nv),
            "frp_total": str(ft), "frp_max": str(fm),
            "frp_mean": str(ft / max(1, nm + nv)),
            "lat": str(lat), "lon": str(lon), "active_fire_cell": active}


def seed(pairs):
    tmp = tempfile.mkdtemp()
    for cdir, year, rows in pairs:
        ydir = os.path.join(tmp, cdir, str(year))
        os.makedirs(ydir)
        with open(os.path.join(ydir, "harmonized_active_fire_cells.csv"),
                  "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=HEADER)
            w.writeheader()
            w.writerows(rows)
    return tmp


def query(tmp, bbox=None, year=None, country=None):
    with unittest.mock.patch.object(harmonized, "HARM_DIR", tmp):
        harmonized.reset_cache()
        trend.reset_cache()
        try:
            return trend.query(bbox, year, country)
        finally:
            trend.reset_cache()
            harmonized.reset_cache()


PRAINHA = (-54.0, -2.3, -53.0, -1.3)


def br_rows():
    return [
        cell_row("A", "2020-01-05", -1.80, -53.48, 2, 3, 12.0, 7.0),
        cell_row("B", "2020-01-05", -1.81, -53.48, 0, 2, 4.0, 4.0),
        cell_row("A", "2021-03-06", -1.80, -53.48, 1, 0, 6.0, 6.0),
        cell_row("C", "2020-01-05", 32.20, -90.20, 5, 5, 50.0, 9.0),
        cell_row("D", "2020-01-05", -1.82, -53.48, 1, 1, 9.0, 9.0,
                 active="0"),
    ]


class TestTrendBboxYear(unittest.TestCase):
    def _br(self):
        return seed([("Brazil", 2020,
                      [r for r in br_rows() if r["local_solar_date"][:4] == "2020"]),
                     ("Brazil", 2021,
                      [r for r in br_rows() if r["local_solar_date"][:4] == "2021"]),
                     ("United_States", 2020,
                      [cell_row("U", "2020-06-05", 32.20, -90.20, 1, 1, 5.0, 5.0)]),
                     ("United_States", 2021,
                      [cell_row("U", "2021-06-05", 32.20, -90.20, 1, 1, 5.0, 5.0)])])

    def test_area_year_scope(self):
        out = query(self._br(), PRAINHA, 2020)
        days = {d["date"]: d for d in out["daily"]}
        self.assertEqual(set(days), {"2020-01-05", "2021-03-06"})
        self.assertEqual(days["2020-01-05"]["fire_days"], 2)
        self.assertEqual(out["year"], 2020)
        self.assertEqual(out["scope"], "area")
        self.assertEqual(out["year_range"], "2020-2021")
        self.assertEqual(out["years"], [2020, 2021])
        self.assertEqual(len(out["hotspots"]), 2)
        self.assertIsNotNone(out["extent"])
        self.assertTrue(all("lat" in d and "lon" in d for d in out["detections"]))

    def test_global_year_scope(self):
        out = query(self._br(), None, 2020)
        self.assertEqual(out["scope"], "global")
        self.assertIsNone(out["bbox"])
        days = {d["date"]: d for d in out["daily"]}
        # Area rows plus the US row, all years present for calendar/chart.
        self.assertIn("2020-06-05", days)
        self.assertIn("2021-03-06", days)
        self.assertIn("Brazil", out["coverage_note"])
        self.assertIn("United States", out["coverage_note"])

    def test_year_validation(self):
        tmp = self._br()
        with unittest.mock.patch.object(harmonized, "HARM_DIR", tmp):
            harmonized.reset_cache()
            trend.reset_cache()
            try:
                with self.assertRaises(ValueError):
                    trend.query(PRAINHA, 2019)
            finally:
                trend.reset_cache()
                harmonized.reset_cache()

    def test_verdict_shape(self):
        out = query(self._br(), PRAINHA, 2020)
        self.assertIn("label", out["verdict"])
        self.assertIn("window", out["verdict"])
        self.assertIn("mean", out["month_stats"][1])

    def test_empty_bbox(self):
        out = query(self._br(), (0.0, 0.0, 1.0, 1.0), 2020)
        self.assertEqual(out["daily"], [])
        self.assertIsNone(out["extent"])
        self.assertIn("No fire-days", out["coverage_note"])

    def test_csv_year_area(self):
        tmp = self._br()
        with unittest.mock.patch.object(harmonized, "HARM_DIR", tmp):
            harmonized.reset_cache()
            trend.reset_cache()
            try:
                rows = list(trend.iter_csv_rows(PRAINHA, 2020))
                all_rows = list(trend.iter_csv_rows(None, 2020))
            finally:
                trend.reset_cache()
                harmonized.reset_cache()
        self.assertEqual(len(rows), 2)
        self.assertEqual(
            set(rows[0]),
            {"latitude", "longitude", "acq_date", "acq_time", "satellite",
             "instrument", "confidence", "frp", "daynight"})
        self.assertEqual(rows[0]["acq_date"], "2020-01-05")
        # Global scope adds the US row (plus the US-coords row stored
        # in the Brazil file) for the same year.
        self.assertEqual(len(all_rows), 4)

    def test_country_scope(self):
        tmp = self._br()
        out = query(tmp, None, 2020, "BR")
        self.assertEqual(out["scope"], "country")
        self.assertEqual(out["country"], "BR")
        self.assertEqual(out["year"], 2020)
        days = {d["date"]: d for d in out["daily"]}
        # All Brazil-file rows (the US-coords row C lives in the Brazil
        # file); the separate United_States file is excluded.
        self.assertEqual(set(days), {"2020-01-05", "2021-03-06"})
        self.assertEqual(days["2020-01-05"]["fire_days"], 3)
        self.assertIn("Brazil", out["coverage_note"])
        self.assertEqual(len(out["hotspots"]), 3)
        us = query(tmp, None, 2020, "US")
        self.assertEqual(
            {d["date"] for d in us["daily"] if d["date"][:4] == "2020"},
            {"2020-06-05"})
        self.assertIn("United States", us["coverage_note"])

    def test_bad_country_rejected(self):
        tmp = self._br()
        with unittest.mock.patch.object(harmonized, "HARM_DIR", tmp):
            harmonized.reset_cache()
            trend.reset_cache()
            try:
                with self.assertRaises(ValueError):
                    trend.query(None, 2020, "XX")
            finally:
                trend.reset_cache()
                harmonized.reset_cache()

    def test_country_csv(self):
        tmp = self._br()
        with unittest.mock.patch.object(harmonized, "HARM_DIR", tmp):
            harmonized.reset_cache()
            trend.reset_cache()
            try:
                rows = list(trend.iter_csv_rows(None, 2020, "BR"))
            finally:
                trend.reset_cache()
                harmonized.reset_cache()
        # Brazil 2020 file rows (A, B, and US-coords C; D inactive).
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]["acq_date"], "2020-01-05")

    def test_missing_layout_names_pipeline(self):
        with unittest.mock.patch.object(
                harmonized, "HARM_DIR", tempfile.mkdtemp()):
            harmonized.reset_cache()
            trend.reset_cache()
            try:
                with self.assertRaises(FileNotFoundError) as ctx:
                    trend.query(PRAINHA, 2020)
            finally:
                trend.reset_cache()
                harmonized.reset_cache()
        self.assertIn("Harmonization-Pipeline", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
