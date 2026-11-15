"""Focused regression tests for the /fires endpoint validation.

Run from backend/:  ../.venv/Scripts/python.exe -m unittest test_fires -v
(venv uses --system-site-packages; needs fastapi, requests, python-dotenv)
"""

import os
import unittest
from unittest.mock import patch

os.environ["FIRMS_MAP_KEY"] = "test-key"

import main  # noqa: E402
from fastapi.exceptions import HTTPException  # noqa: E402

CSV_OK = (
    "latitude,longitude,acq_date,acq_time,satellite,confidence,frp\n"
    "37.0,-117.0,2026-11-14,1200,N,l,12.3\n"
)


class FakeResp:
    def __init__(self, status_code, text):
        self.status_code = status_code
        self.text = text


def call(**kwargs):
    try:
        return ("ok", main.fires(**kwargs))
    except HTTPException as exc:
        return (exc.status_code, exc.detail)


class TestFiresValidation(unittest.TestCase):
    def test_rejects_wrapped_bbox_min_lon_above_max_lon(self):
        # Exact bbox from the reported 502: map wrapped past the antimeridian.
        status, _ = call(
            bbox="121.59815848723974,-46.80808129074153,0.13331473723974252,"
            "73.96784134283602",
            days=1,
            source="VIIRS_SNPP_NRT",
        )
        self.assertEqual(status, 400)

    def test_rejects_min_lat_above_max_lat(self):
        status, _ = call(
            bbox="-120,40,-114,34", days=1, source="VIIRS_SNPP_NRT"
        )
        self.assertEqual(status, 400)

    def test_rejects_out_of_range_coords(self):
        status, _ = call(
            bbox="-200,34,-114,40", days=1, source="VIIRS_SNPP_NRT"
        )
        self.assertEqual(status, 400)

    def test_rejects_bad_source(self):
        status, _ = call(bbox="-120,34,-114,40", days=1, source="NOPE")
        self.assertEqual(status, 400)

    @patch.object(main.requests, "get")
    def test_valid_bbox_parses_csv(self, mock_get):
        mock_get.return_value = FakeResp(200, CSV_OK)
        status, rows = call(
            bbox="-120,34,-114,40", days=1, source="MODIS_C6_1_NRT"
        )
        self.assertEqual(status, "ok")
        self.assertEqual(len(rows), 1)
        self.assertEqual(
            rows[0]["latitude"],
            37.0,
        )
        self.assertIn("MODIS_C6_1_NRT", mock_get.call_args[0][0])

    @patch.object(main.requests, "get")
    def test_firms_error_passes_through_real_message(self, mock_get):
        mock_get.return_value = FakeResp(400, "Invalid MAP_KEY")
        status, detail = call(
            bbox="-120,34,-114,40", days=1, source="VIIRS_SNPP_NRT"
        )
        self.assertEqual(status, 502)
        self.assertIn("Invalid MAP_KEY", detail)

    def test_missing_key_never_returns_fake_data(self):
        del os.environ["FIRMS_MAP_KEY"]
        try:
            status, _ = call(
                bbox="-120,34,-114,40", days=1, source="VIIRS_SNPP_NRT"
            )
            self.assertEqual(status, 500)
        finally:
            os.environ["FIRMS_MAP_KEY"] = "test-key"


if __name__ == "__main__":
    unittest.main()
