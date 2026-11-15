import base64
import csv
import datetime
import io
import json
import logging
import os

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from sam_mask import (
    decode_mask_to_raster,
    mask_polygon_latlon,
    parse_output_records,
    polygon_area_km2,
)
import harmonized
import trend

load_dotenv()

logger = logging.getLogger("plumeroute")

app = FastAPI()

SOURCES = {"VIIRS_SNPP_NRT", "MODIS_C6_1_NRT"}

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _build_trend_cache():
    try:
        trend.ensure_cache()
    except FileNotFoundError as exc:
        logger.warning("trend cache not built: %s", exc)


SNAPSHOT_SIZE = 1024
SAM_MODEL_ID = "sam-3.1"
SAM_RESPONSES_URL = "https://api.meta.ai/v1/responses"


def parse_bbox(bbox):
    """Validate minLon,minLat,maxLon,maxLat; returns the four floats."""
    try:
        parts = [float(x) for x in bbox.split(",")]
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="bbox must be four numbers: minLon,minLat,maxLon,maxLat",
        )
    if len(parts) != 4:
        raise HTTPException(
            status_code=400,
            detail="bbox must be four numbers: minLon,minLat,maxLon,maxLat",
        )
    min_lon, min_lat, max_lon, max_lat = parts
    if not (-180 <= min_lon <= 180 and -180 <= max_lon <= 180):
        raise HTTPException(
            status_code=400, detail="bbox longitudes must be within -180 to 180"
        )
    if not (-90 <= min_lat <= 90 and -90 <= max_lat <= 90):
        raise HTTPException(
            status_code=400, detail="bbox latitudes must be within -90 to 90"
        )
    if min_lon >= max_lon or min_lat >= max_lat:
        raise HTTPException(
            status_code=400,
            detail="bbox must satisfy minLon<maxLon and minLat<maxLat "
            "(zoom in; a whole-world or antimeridian-wrapped view is not a valid area)",
        )
    return min_lon, min_lat, max_lon, max_lat


class SmokeRequest(BaseModel):
    bbox: str


class AssessRequest(BaseModel):
    latitude: float
    longitude: float
    place: str | None = None


SPARK_MODEL_ID = "muse-spark-1.3"
VOICE_MODEL_ID = "muse-voice-transcribe-1.0"
VOICE_ASR_URL = "https://api.meta.ai/v1/asr/transcribe"
MAX_VOICE_BYTES = 5_000_000
WAV_MIMES = {"audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"}

# Risk thresholds (km). Computed in code from the numbers, never by the model.
AVOID_FIRE_KM = 5.0
CAUTION_FIRE_KM = 25.0
DOWNWIND_KM = 100.0
DOWNWIND_DEG = 45.0


def _haversine_km(lat1, lon1, lat2, lon2):
    import math

    r = math.radians
    a = (
        math.sin(r(lat2 - lat1) / 2) ** 2
        + math.cos(r(lat1)) * math.cos(r(lat2)) * math.sin(r(lon2 - lon1) / 2) ** 2
    )
    return 2 * 6371.0 * math.asin(math.sqrt(a))


def _point_in_polygon(lat, lon, ring):
    inside = False
    n = len(ring)
    for i in range(n):
        lat1, lon1 = ring[i]
        lat2, lon2 = ring[(i + 1) % n]
        if (lon1 > lon) != (lon2 > lon):
            y = lat1 + (lat2 - lat1) * (lon - lon1) / (lon2 - lon1)
            if y > lat:
                inside = not inside
    return inside


def _bearing_deg(lat1, lon1, lat2, lon2):
    import math

    r = math.radians
    dlon = r(lon2 - lon1)
    y = math.sin(dlon) * math.cos(r(lat2))
    x = math.cos(r(lat1)) * math.sin(r(lat2)) - math.sin(r(lat1)) * math.cos(
        r(lat2)
    ) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def _compute_risk(lat, lon, fires, polygon, hours):
    """Risk level from numbers only: plume distance + trajectory."""
    nearest_km = None
    for f in fires:
        d = _haversine_km(lat, lon, f["latitude"], f["longitude"])
        if nearest_km is None or d < nearest_km:
            nearest_km = d
    in_plume = bool(polygon) and _point_in_polygon(lat, lon, polygon)
    # Downwind exposure: wind (blowing toward from_deg+180) carries smoke
    # from the nearest fire/plume toward this point.
    downwind = False
    if hours:
        w = hours[0]
        blow_to = (w["direction_deg"] + 180) % 360
        sources = []
        if nearest_km is not None:
            nf = min(fires, key=lambda f: _haversine_km(lat, lon, f["latitude"], f["longitude"]))
            sources.append((nf["latitude"], nf["longitude"], nearest_km))
        if polygon:
            clat = sum(p[0] for p in polygon) / len(polygon)
            clon = sum(p[1] for p in polygon) / len(polygon)
            sources.append((clat, clon, _haversine_km(lat, lon, clat, clon)))
        for slat, slon, dist in sources:
            if dist > DOWNWIND_KM:
                continue
            diff = abs((_bearing_deg(slat, slon, lat, lon) - blow_to + 180) % 360 - 180)
            if diff <= DOWNWIND_DEG:
                downwind = True
                break
    if in_plume or (nearest_km is not None and nearest_km < AVOID_FIRE_KM):
        return "AVOID", nearest_km, in_plume, downwind
    if (downwind and nearest_km is not None and nearest_km < DOWNWIND_KM) or (
        nearest_km is not None and nearest_km < CAUTION_FIRE_KM
    ):
        return "CAUTION", nearest_km, in_plume, downwind
    return "SAFE", nearest_km, in_plume, downwind


def _assess_fires(lat, lon):
    return fires(bbox=f"{lon-1},{lat-1},{lon+1},{lat+1}", days=1, source="VIIRS_SNPP_NRT")


def _assess_smoke(lat, lon):
    return smoke(SmokeRequest(bbox=f"{lon-0.5},{lat-0.5},{lon+0.5},{lat+0.5}"))


def _assess_wind(lat, lon):
    return wind(latitude=lat, longitude=lon)


def _ask_spark(prompt):
    key = os.environ.get("MODEL_API_KEY")
    if not key:
        raise HTTPException(
            status_code=500, detail="MODEL_API_KEY is not set in the environment"
        )
    try:
        resp = requests.post(
            SAM_RESPONSES_URL,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
            json={
                "model": SPARK_MODEL_ID,
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": prompt}],
                    }
                ],
            },
            timeout=120,
        )
    except requests.RequestException as exc:
        raise HTTPException(
            status_code=502, detail=f"Model API request failed: {exc}"
        )
    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Model API error {resp.status_code}: {resp.text[:500]}",
        )
    try:
        body = resp.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=502, detail=f"Model API returned an unreadable body: {exc}"
        )
    text = _model_texts(body)
    if not text:
        raise HTTPException(
            status_code=502, detail="Model API returned no verdict text"
        )
    return text


def _model_texts(body):
    """Pull every output_text/text string out of a /responses body."""
    texts = []

    def collect(node):
        if isinstance(node, dict):
            if node.get("type") in ("output_text", "text") and isinstance(
                node.get("text"), str
            ):
                texts.append(node["text"])
            for v in node.values():
                collect(v)
        elif isinstance(node, list):
            for v in node:
                collect(v)
        elif isinstance(node, str) and not texts:
            pass

    collect(body)
    direct = body.get("output_text")
    if isinstance(direct, str) and direct.strip():
        texts.append(direct)
    return "\n".join(t for t in texts if t.strip()).strip()


class TranscribeRequest(BaseModel):
    audio_b64: str
    mime: str = "audio/wav"


@app.post("/transcribe")
def transcribe(req: TranscribeRequest):
    """Speech-to-text for the Ask-by-voice mic button. Returns {"text": ...}.

    Forwards the recording to the Muse Voice Transcribe file endpoint
    (multipart WAV upload) and returns its transcript verbatim.
    """
    import uuid

    key = os.environ.get("MODEL_API_KEY")
    if not key:
        raise HTTPException(
            status_code=500, detail="MODEL_API_KEY is not set in the environment"
        )
    if req.mime not in WAV_MIMES:
        raise HTTPException(
            status_code=400, detail="mime must be a WAV audio type"
        )
    try:
        raw = base64.b64decode(req.audio_b64, validate=True)
    except (ValueError, base64.binascii.Error):
        raise HTTPException(
            status_code=400, detail="audio_b64 is not valid base64"
        )
    if not raw or len(raw) > MAX_VOICE_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"audio must be 1 byte to {MAX_VOICE_BYTES} bytes after decoding",
        )
    if not (raw[:4] == b"RIFF" and raw[8:12] == b"WAVE"):
        raise HTTPException(
            status_code=400, detail="audio must be a RIFF/WAVE file"
        )
    try:
        resp = requests.post(
            VOICE_ASR_URL,
            headers={"Authorization": f"Bearer {key}"},
            params={"sessionId": uuid.uuid4().hex},
            data={"request": json.dumps({
                "mode": "ENDPOINTING",
                "model": VOICE_MODEL_ID,
                "audioEncoding": "WAV",
            })},
            files={"audio": ("query.wav", raw, "audio/wav")},
            timeout=120,
        )
    except requests.RequestException as exc:
        raise HTTPException(
            status_code=502, detail=f"Model API request failed: {exc}"
        )
    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Model API error {resp.status_code}: {resp.text[:500]}",
        )
    try:
        body = resp.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=502, detail=f"Model API returned an unreadable body: {exc}"
        )
    text = str(body.get("transcript", "") or "").strip()
    if not text:
        raise HTTPException(
            status_code=502, detail="Model API returned no transcript text"
        )
    return {"text": text}


@app.get("/trend")
def get_trend(
    bbox: str | None = Query(
        None,
        description="Bounding box as minLon,minLat,maxLon,maxLat; "
                    "omit for all loaded Brazil + USA rows",
    ),
    year: int | None = Query(
        None, description="Season year; defaults to the latest loaded year"
    ),
    country: str | None = Query(
        None, description="Country preset: BR or US; ignored when bbox is set"
    ),
    format: str = Query("json", description='json or csv (filtered rows)'),
):
    from fastapi.responses import StreamingResponse

    parsed = parse_bbox(bbox) if bbox is not None else None
    ctry = country.strip().upper() if country else None
    if format == "csv":
        try:
            years = trend._loaded_years()
            gen = trend.iter_csv_rows(
                parsed, year if year is not None else years[-1], ctry)
            first = next(gen, None)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=500, detail=str(exc))
        if first is None:
            raise HTTPException(
                status_code=404, detail="No archive rows in this area")
        header = ",".join(first.keys())

        def lines():
            yield header + "\n"
            yield ",".join(str(first[k]) for k in first) + "\n"
            for row in gen:
                yield ",".join(str(row[k]) for k in row) + "\n"

        return StreamingResponse(
            lines(), media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=fires.csv"},
        )
    try:
        payload = trend.query(parsed, year, ctry)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {
        "complete": True,
        **payload,
    }


@app.get("/harmonized")
def get_harmonized(
    country: str = Query(
        ...,
        description="Country code: BR or US",
        examples=["BR"],
    ),
    year: int | None = Query(
        None, description="Season year; defaults to the latest loaded year"
    ),
):
    """Country harmonized fire history, computed from the archive CSVs."""
    try:
        payload = harmonized.get_payload(country.strip().upper(), year)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"complete": True, **payload}


@app.get("/harmonized/years")
def get_harmonized_years():
    """Loaded countries and years for the Harmonized tab controls."""
    try:
        return harmonized.get_years()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/assess")
def assess(req: AssessRequest):
    if not (-90 <= req.latitude <= 90 and -180 <= req.longitude <= 180):
        raise HTTPException(status_code=400, detail="latitude/longitude out of range")
    fire_list = _assess_fires(req.latitude, req.longitude)
    smoke_out = _assess_smoke(req.latitude, req.longitude)
    wind_out = _assess_wind(req.latitude, req.longitude)
    polygon = smoke_out.get("polygon", [])
    level, nearest_km, in_plume, downwind = _compute_risk(
        req.latitude, req.longitude, fire_list, polygon, wind_out.get("hours", [])
    )
    where = req.place or f"{req.latitude:.3f}, {req.longitude:.3f}"
    fire_desc = (
        f"{len(fire_list)} active fire(s) nearby, nearest "
        f"{nearest_km:.1f} km away" if nearest_km is not None
        else "no active fires detected nearby"
    )
    plume_desc = (
        f"a mapped smoke plume of {smoke_out.get('area_km2', 0):.1f} km², "
        + ("covering this location" if in_plume else "not covering this location")
        if polygon
        else "no mapped smoke plume"
    )
    w0 = wind_out["hours"][0] if wind_out.get("hours") else None
    wind_desc = (
        f"850 hPa wind {w0['speed_ms']:.1f} m/s from {w0['direction_deg']:.0f}°"
        if w0
        else "no wind data"
    )
    prompt = (
        f"You are a wildfire safety assistant. Location: {where} "
        f"({req.latitude:.3f}, {req.longitude:.3f}). Assessed risk level: {level}. "
        f"Facts: {fire_desc}; {plume_desc}; {wind_desc}. "
        "Write 3-5 plain sentences for a hiker: what is burning, "
        "where the smoke is heading, and what to do. End with a line "
        "'Safer direction: <compass direction and short reason>'."
    )
    verdict = _ask_spark(prompt)
    safer = ""
    for line in verdict.splitlines():
        if line.strip().lower().startswith("safer direction:"):
            safer = line.split(":", 1)[1].strip()
            break
    return {"level": level, "verdict": verdict, "safer_direction": safer}

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/fires")
def fires(
    bbox: str = Query(
        ...,
        description="Bounding box as minLon,minLat,maxLon,maxLat",
        examples=["-120,34,-114,40"],
    ),
    days: int = Query(..., ge=1, le=10, description="Days back (1-10)"),
    source: str = Query("VIIRS_SNPP_NRT"),
):
    key = os.environ.get("FIRMS_MAP_KEY")
    if not key:
        raise HTTPException(
            status_code=500, detail="FIRMS_MAP_KEY is not set in the environment"
        )

    min_lon, min_lat, max_lon, max_lat = parse_bbox(bbox)

    dataset = source.strip().upper()
    if dataset == "MODIS":
        dataset = "MODIS_C6_1_NRT"
    elif dataset in ("VIIRS", "SNPP"):
        dataset = "VIIRS_SNPP_NRT"
    if dataset not in SOURCES:
        raise HTTPException(
            status_code=400,
            detail=f"source must be one of {sorted(SOURCES)}",
        )

    url = (
        f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}"
        f"/{dataset}/{min_lon},{min_lat},{max_lon},{max_lat}/{days}"
    )
    try:
        resp = requests.get(url, timeout=30)
    except requests.RequestException as exc:
        raise HTTPException(
            status_code=502, detail=f"FIRMS request failed: {exc}"
        )

    text = resp.text.strip()
    if resp.status_code != 200 or not text.startswith("latitude,"):
        raise HTTPException(
            status_code=502, detail=f"FIRMS error: {text[:500]}"
        )

    out = []
    for row in csv.DictReader(io.StringIO(text)):
        try:
            out.append(
                {
                    "latitude": float(row["latitude"]),
                    "longitude": float(row["longitude"]),
                    "acq_date": row["acq_date"],
                    "acq_time": row["acq_time"],
                    "satellite": row.get("satellite", ""),
                    "confidence": row.get("confidence", ""),
                    "frp": float(row["frp"]) if row.get("frp") else None,
                }
            )
        except (KeyError, ValueError):
            continue
    return out


def _fetch_snapshot(min_lon, min_lat, max_lon, max_lat, date):
    # GIBS snapshot BBOX for EPSG:4326 is south,west,north,east.
    url = (
        "https://wvs.earthdata.nasa.gov/api/v1/snapshot?REQUEST=GetSnapshot"
        "&LAYERS=MODIS_Terra_CorrectedReflectance_TrueColor"
        f"&BBOX={min_lat},{min_lon},{max_lat},{max_lon}"
        "&CRS=EPSG:4326&FORMAT=image/png"
        f"&TIME={date}&WIDTH={SNAPSHOT_SIZE}&HEIGHT={SNAPSHOT_SIZE}"
    )
    try:
        resp = requests.get(url, timeout=60)
    except requests.RequestException as exc:
        raise HTTPException(
            status_code=502, detail=f"GIBS snapshot request failed: {exc}"
        )
    ctype = resp.headers.get("Content-Type", "")
    if resp.status_code != 200 or "image" not in ctype:
        raise HTTPException(
            status_code=502,
            detail=f"GIBS snapshot error: {resp.text[:500]}",
        )
    return resp.content


def _sam_segment(image_png):
    key = os.environ.get("MODEL_API_KEY")
    if not key:
        raise HTTPException(
            status_code=500, detail="MODEL_API_KEY is not set in the environment"
        )
    data_url = (
        "data:image/png;base64," + base64.b64encode(image_png).decode("ascii")
    )
    try:
        resp = requests.post(
            SAM_RESPONSES_URL,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
            },
            json={
                "model": SAM_MODEL_ID,
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [
                            {
                                "type": "input_text",
                                "text": "wildfire smoke plume",
                            },
                            {"type": "input_image", "image_url": data_url},
                        ],
                    }
                ],
                "stream": True,
                "metadata": {"mask_encoding": "one_bit"},
            },
            timeout=180,
            stream=True,
        )
    except requests.RequestException as exc:
        raise HTTPException(
            status_code=502, detail=f"Model API request failed: {exc}"
        )
    if resp.status_code != 200:
        try:
            detail = resp.text[:500]
        except Exception:
            detail = "unreadable error body"
        raise HTTPException(
            status_code=502, detail=f"Model API error {resp.status_code}: {detail}"
        )
    output_text = []
    try:
        for line in resp.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            try:
                event = json.loads(payload)
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            etype = event.get("type", "")
            if "output_text.delta" in etype and isinstance(event.get("delta"), str):
                output_text.append(event["delta"])
            elif etype == "response.completed":
                break
    except requests.RequestException as exc:
        raise HTTPException(
            status_code=502, detail=f"Model API stream failed: {exc}"
        )
    return "".join(output_text)


@app.get("/wind")
def wind(
    latitude: float = Query(..., ge=-90, le=90),
    longitude: float = Query(..., ge=-180, le=180),
):
    """Hourly 850 hPa winds (~1,500 m, plume height) for the next 6 hours."""
    url = (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={latitude}&longitude={longitude}"
        "&hourly=wind_speed_850hPa,wind_direction_850hPa"
        "&wind_speed_unit=ms&timezone=UTC&forecast_days=1"
    )
    try:
        resp = requests.get(url, timeout=30)
    except requests.RequestException as exc:
        raise HTTPException(
            status_code=502, detail=f"Open-Meteo request failed: {exc}"
        )
    if resp.status_code != 200:
        raise HTTPException(
            status_code=502, detail=f"Open-Meteo error: {resp.text[:500]}"
        )
    try:
        body = resp.json()
        times = body["hourly"]["time"]
        speeds = body["hourly"]["wind_speed_850hPa"]
        dirs = body["hourly"]["wind_direction_850hPa"]
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(
            status_code=502, detail=f"Open-Meteo returned an unreadable body: {exc}"
        )
    now = datetime.datetime.now(datetime.timezone.utc).replace(
        minute=0, second=0, microsecond=0
    )
    hours = []
    for t, s, d in zip(times, speeds, dirs):
        try:
            stamp = datetime.datetime.fromisoformat(t).replace(
                tzinfo=datetime.timezone.utc
            )
        except ValueError:
            continue
        if stamp < now or s is None or d is None:
            continue
        hours.append(
            {"time": stamp.isoformat(), "speed_ms": float(s), "direction_deg": float(d)}
        )
        if len(hours) == 6:
            break
    if not hours:
        raise HTTPException(
            status_code=502,
            detail="Open-Meteo returned no upcoming hourly 850 hPa winds",
        )
    return {"hours": hours}


@app.post("/smoke")
def smoke(req: SmokeRequest):
    min_lon, min_lat, max_lon, max_lat = parse_bbox(req.bbox)
    if not os.environ.get("MODEL_API_KEY"):
        raise HTTPException(
            status_code=500, detail="MODEL_API_KEY is not set in the environment"
        )
    today = datetime.date.today().isoformat()
    image_png = _fetch_snapshot(min_lon, min_lat, max_lon, max_lat, today)
    output_text = _sam_segment(image_png)
    records = parse_output_records(output_text)
    frame = [r for r in records if r["box"]["w"] == SNAPSHOT_SIZE]
    if not frame:
        # No plume found is a valid outcome, never a reason to invent one.
        return {"polygon": [], "area_km2": 0.0}
    # Segment the largest detection by box area.
    rec = max(
        frame,
        key=lambda r: (r["box"]["x2"] - r["box"]["x1"])
        * (r["box"]["y2"] - r["box"]["y1"]),
    )
    try:
        raster = decode_mask_to_raster(
            rec["mask"]["enc"],
            rec["mask"]["payload"],
            rec["mask"]["w"],
            rec["mask"]["h"],
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=502, detail=f"Model API returned an undecodable mask: {exc}"
        )
    polygon = mask_polygon_latlon(
        raster,
        rec["mask"]["w"],
        rec["mask"]["h"],
        rec["box"],
        SNAPSHOT_SIZE,
        SNAPSHOT_SIZE,
        (min_lon, min_lat, max_lon, max_lat),
    )
    if not polygon:
        return {"polygon": [], "area_km2": 0.0}
    ring = polygon + [polygon[0]]
    return {
        "polygon": [[lat, lon] for lat, lon in ring],
        "area_km2": polygon_area_km2(ring),
    }
