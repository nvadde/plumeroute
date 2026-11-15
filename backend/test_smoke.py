"""Offline tests for POST /smoke geometry (mask codec, contour, area)."""

import os
import unittest
from unittest.mock import patch

os.environ["MODEL_API_KEY"] = "test-key"
os.environ["FIRMS_MAP_KEY"] = "test-key"

import main  # noqa: E402
import sam_mask  # noqa: E402
from fastapi.exceptions import HTTPException  # noqa: E402


def block_raster(w, h, x0, y0, x1, y1):
    return [1 if (x0 <= x < x1 and y0 <= y < y1) else 0 for y in range(h) for x in range(w)]


class TestMaskCodec(unittest.TestCase):
    def test_one_bit_round_trip(self):
        w, h = 12, 10
        raster = block_raster(w, h, 2, 3, 9, 8)
        payload = sam_mask.encode_raster(raster, w, h)
        self.assertTrue(payload.startswith("!"))
        self.assertEqual(sam_mask.decode_mask_to_raster("one_bit", payload, w, h), raster)

    def test_round_trip_all_zeros_and_checker(self):
        w, h = 8, 8
        zeros = [0] * (w * h)
        p = sam_mask.encode_raster(zeros, w, h)
        self.assertEqual(sam_mask.decode_mask_to_raster("one_bit", p, w, h), zeros)
        checker = [(x + y) % 2 for y in range(h) for x in range(w)]
        p2 = sam_mask.encode_raster(checker, w, h)
        self.assertEqual(sam_mask.decode_mask_to_raster("one_bit", p2, w, h), checker)

    def test_rejects_bad_payload(self):
        with self.assertRaises(ValueError):
            sam_mask.decode_mask_to_raster("one_bit", "!bogus", 4, 4)
        with self.assertRaises(ValueError):
            sam_mask.decode_mask_to_raster("nope", "!x", 4, 4)


class TestRecordsAndPolygon(unittest.TestCase):
    def test_parse_record(self):
        w, h = 12, 10
        payload = sam_mask.encode_raster(block_raster(w, h, 2, 3, 9, 8), w, h)
        text = (
            f"<0f>0<|box;x1=100;y1=100;x2=924;y2=924;w=1024;h=1024|>"
            f"<|mask;x=0;y=0;data={h},{w},{payload}|>"
        )
        recs = sam_mask.parse_output_records(text)
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["box"]["x1"], 100)
        self.assertEqual(recs[0]["mask"]["h"], h)
        self.assertEqual(recs[0]["mask"]["w"], w)

    def test_polygon_maps_box_to_bbox(self):
        w, h = 12, 10
        raster = block_raster(w, h, 0, 0, w, h)  # full mask
        box = {"x1": 0, "y1": 0, "x2": 1024, "y2": 1024, "w": 1024, "h": 1024}
        poly = sam_mask.mask_polygon_latlon(
            raster, w, h, box, 1024, 1024, (-120.0, 34.0, -114.0, 40.0)
        )
        self.assertTrue(len(poly) >= 4)
        lats = [p[0] for p in poly]
        lons = [p[1] for p in poly]
        self.assertAlmostEqual(max(lats), 40.0, places=1)
        self.assertAlmostEqual(min(lats), 34.0, places=1)
        self.assertAlmostEqual(max(lons), -114.0, places=1)
        self.assertAlmostEqual(min(lons), -120.0, places=1)

    def test_area_one_degree_square_equator(self):
        sq = [(0.0, 0.0), (0.0, 1.0), (1.0, 1.0), (1.0, 0.0), (0.0, 0.0)]
        area = sam_mask.polygon_area_km2(sq)
        # (111.19 km)^2 ~= 12364 km^2
        self.assertTrue(12000 < area < 12700, area)

    def test_area_empty(self):
        self.assertEqual(sam_mask.polygon_area_km2([]), 0.0)
        self.assertEqual(sam_mask.polygon_area_km2([(0.0, 0.0)]), 0.0)


class TestSmokeEndpoint(unittest.TestCase):
    def test_missing_key_never_fakes(self):
        del os.environ["MODEL_API_KEY"]
        try:
            with self.assertRaises(HTTPException) as ctx:
                main.smoke(main.SmokeRequest(bbox="-120,34,-114,40"))
            self.assertEqual(ctx.exception.status_code, 500)
        finally:
            os.environ["MODEL_API_KEY"] = "test-key"

    def test_bad_bbox_rejected(self):
        with self.assertRaises(HTTPException) as ctx:
            main.smoke(main.SmokeRequest(bbox="bad"))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_full_path_with_canned_model_output(self):
        w, h = 12, 10
        payload = sam_mask.encode_raster(block_raster(w, h, 2, 3, 9, 8), w, h)
        text = (
            f"<0f>0<|box;x1=100;y1=100;x2=924;y2=924;w=1024;h=1024|>"
            f"<|mask;x=0;y=0;data={h},{w},{payload}|>"
        )
        with patch.object(main, "_fetch_snapshot", return_value=b"png"), patch.object(
            main, "_sam_segment", return_value=text
        ):
            out = main.smoke(main.SmokeRequest(bbox="-120,34,-114,40"))
        self.assertTrue(len(out["polygon"]) >= 4)
        self.assertEqual(out["polygon"][0], out["polygon"][-1])  # closed ring
        self.assertTrue(out["area_km2"] > 0)
        for lat, lon in out["polygon"]:
            self.assertTrue(34.0 <= lat <= 40.0)
            self.assertTrue(-120.0 <= lon <= -114.0)


class TestWindEndpoint(unittest.TestCase):
    def _canned(self):
        import datetime as dt

        now = dt.datetime.now(dt.timezone.utc).replace(
            minute=0, second=0, microsecond=0
        )
        times = [(now + dt.timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M") for i in range(8)]
        return {
            "hourly": {
                "time": times,
                "wind_speed_850hPa": [5.0] * 8,
                "wind_direction_850hPa": [270.0] * 8,
            }
        }

    def test_next_six_hours(self):
        class Resp:
            status_code = 200

            def __init__(self, body):
                self._body = body

            def json(self):
                return self._body

        with patch.object(main.requests, "get", return_value=Resp(self._canned())):
            out = main.wind(latitude=37.0, longitude=-117.0)
        self.assertEqual(len(out["hours"]), 6)
        self.assertEqual(out["hours"][0]["speed_ms"], 5.0)
        self.assertEqual(out["hours"][0]["direction_deg"], 270.0)

    def test_upstream_error_passes_through(self):
        class Resp:
            status_code = 500
            text = "boom"

        with patch.object(main.requests, "get", return_value=Resp()):
            with self.assertRaises(HTTPException) as ctx:
                main.wind(latitude=37.0, longitude=-117.0)
        self.assertEqual(ctx.exception.status_code, 502)
        self.assertIn("boom", ctx.exception.detail)

    def test_network_failure_passes_through(self):
        with patch.object(
            main.requests, "get", side_effect=main.requests.RequestException("down")
        ):
            with self.assertRaises(HTTPException) as ctx:
                main.wind(latitude=37.0, longitude=-117.0)
        self.assertEqual(ctx.exception.status_code, 502)


class TestAssessEndpoint(unittest.TestCase):
    def _run(self, lat, lon, fires, polygon, hours):
        verdict = (
            "Stay clear. Smoke is heading east.\nSafer direction: west, upwind of the fire"
        )
        with patch.object(main, "_assess_fires", return_value=fires), patch.object(
            main, "_assess_smoke",
            return_value={"polygon": polygon, "area_km2": 10.0},
        ), patch.object(
            main, "_assess_wind", return_value={"hours": hours}
        ), patch.object(
            main, "_ask_spark", return_value=verdict
        ) as asker:
            out = main.assess(main.AssessRequest(latitude=lat, longitude=lon))
        return out, asker

    def test_avoid_inside_plume(self):
        poly = [[36.9, -117.1], [36.9, -116.9], [37.1, -116.9], [37.1, -117.1]]
        out, _ = self._run(37.0, -117.0, [], poly, [])
        self.assertEqual(out["level"], "AVOID")
        self.assertIn("west", out["safer_direction"])

    def test_avoid_near_fire(self):
        fires = [{"latitude": 37.01, "longitude": -117.0, "acq_date": "d",
                  "acq_time": "t", "satellite": "s", "confidence": "h", "frp": 1.0}]
        out, _ = self._run(37.0, -117.0, fires, [], [])
        self.assertEqual(out["level"], "AVOID")

    def test_caution_nearby_fire(self):
        fires = [{"latitude": 37.1, "longitude": -117.0, "acq_date": "d",
                  "acq_time": "t", "satellite": "s", "confidence": "h", "frp": 1.0}]
        out, _ = self._run(37.0, -117.0, fires, [], [])
        self.assertEqual(out["level"], "CAUTION")

    def test_safe_nothing_nearby(self):
        out, _ = self._run(37.0, -117.0, [], [], [])
        self.assertEqual(out["level"], "SAFE")

    def test_level_ignores_model_claim(self):
        # Model text claims safety; numbers say AVOID -> code wins.
        poly = [[36.9, -117.1], [36.9, -116.9], [37.1, -116.9], [37.1, -117.1]]
        with patch.object(main, "_assess_fires", return_value=[]), patch.object(
            main, "_assess_smoke",
            return_value={"polygon": poly, "area_km2": 10.0},
        ), patch.object(
            main, "_assess_wind", return_value={"hours": []}
        ), patch.object(
            main, "_ask_spark", return_value="All SAFE here.\nSafer direction: anywhere"
        ):
            out = main.assess(main.AssessRequest(latitude=37.0, longitude=-117.0))
        self.assertEqual(out["level"], "AVOID")

    def test_bad_coords_rejected(self):
        with self.assertRaises(HTTPException) as ctx:
            main.assess(main.AssessRequest(latitude=99.0, longitude=0.0))
        self.assertEqual(ctx.exception.status_code, 400)


class TestTranscribeEndpoint(unittest.TestCase):
    def _wav_b64(self, n=44):
        import base64

        raw = b"RIFF" + b"\x00" * 4 + b"WAVE" + b"\x00" * (n - 12)
        return base64.b64encode(raw).decode()

    def _canned_post(self, body, status=200, capture=None):
        import json as jsonlib

        class Resp:
            status_code = status
            text = "model says no" if status != 200 else ""

            def json(self):
                return body

        def fake_post(url, headers=None, params=None, data=None, files=None, timeout=None, **kwargs):
            if capture is not None:
                capture["url"] = url
                capture["params"] = params
                capture["settings"] = jsonlib.loads(data["request"])
                capture["audio"] = files["audio"]
            return Resp()

        return fake_post

    def test_happy_path_returns_transcript(self):
        capture = {}
        fake = self._canned_post({"transcript": "Is Prainha safe?"}, capture=capture)
        with patch.object(main.requests, "post", side_effect=fake):
            out = main.transcribe(
                main.TranscribeRequest(audio_b64=self._wav_b64(), mime="audio/wav")
            )
        self.assertEqual(out, {"text": "Is Prainha safe?"})
        self.assertTrue(capture["url"].endswith("/v1/asr/transcribe"))
        self.assertIn("sessionId", capture["params"])
        self.assertEqual(capture["settings"]["model"], "muse-voice-transcribe-1.0")
        self.assertEqual(capture["settings"]["audioEncoding"], "WAV")
        name, raw, mime = capture["audio"]
        self.assertEqual(name, "query.wav")
        self.assertEqual(mime, "audio/wav")
        self.assertTrue(raw[:4] == b"RIFF")

    def test_missing_key_never_fakes(self):
        del os.environ["MODEL_API_KEY"]
        try:
            with self.assertRaises(HTTPException) as ctx:
                main.transcribe(
                    main.TranscribeRequest(audio_b64=self._wav_b64())
                )
            self.assertEqual(ctx.exception.status_code, 500)
        finally:
            os.environ["MODEL_API_KEY"] = "test-key"

    def test_bad_audio_rejected(self):
        with self.assertRaises(HTTPException) as ctx:
            main.transcribe(main.TranscribeRequest(audio_b64="!!!not-base64!!!"))
        self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException) as ctx:
            main.transcribe(main.TranscribeRequest(audio_b64=self._wav_b64(), mime="audio/webm"))
        self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException) as ctx:
            import base64

            not_wav = base64.b64encode(b"definitely not a wave file" + b"\x00" * 24).decode()
            main.transcribe(main.TranscribeRequest(audio_b64=not_wav))
        self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException) as ctx:
            with patch.object(main, "MAX_VOICE_BYTES", 2):
                main.transcribe(main.TranscribeRequest(audio_b64=self._wav_b64()))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_empty_transcript_and_model_error(self):
        b64 = self._wav_b64()
        with patch.object(main.requests, "post", side_effect=self._canned_post({})):
            with self.assertRaises(HTTPException) as ctx:
                main.transcribe(main.TranscribeRequest(audio_b64=b64))
            self.assertEqual(ctx.exception.status_code, 502)
        with patch.object(main.requests, "post", side_effect=self._canned_post({}, status=500)):
            with self.assertRaises(HTTPException) as ctx:
                main.transcribe(main.TranscribeRequest(audio_b64=b64))
            self.assertEqual(ctx.exception.status_code, 502)

    def test_spark_still_extracts_verdict_text(self):
        # Refactor guard: _ask_spark keeps working through _model_texts.
        with patch.object(main.requests, "post", side_effect=self._canned_post(
            {"output_text": "Stay clear.\nSafer direction: west"}
        )):
            self.assertIn("Stay clear", main._ask_spark("prompt"))


if __name__ == "__main__":
    unittest.main()
