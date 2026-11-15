"""SAM 3.1 mask decoding and plume geometry, ported from the documented
Meta-SAM wire format (see Meta Model API docs: "Read Segment Anything Model
segmentation output" and the meta-sam parser sources).

Pure stdlib so it runs anywhere the backend does.
"""

import math
import re

_M32 = 0xFFFFFFFF
_TOP = 1 << 24
_BOTTOM = 1 << 16


def _u32(x):
    return x & _M32


# --- base85-ish codec (alphabet: 0x21..0x7e minus " \\ , ; < > |) ---

_EXCLUDED = set('"\\,;<>|')
_ALPHABET = "".join(
    chr(c) for c in range(0x21, 0x7F) if chr(c) not in _EXCLUDED
)
_RADIX = 85
_PREFIX_LEN = 5
_CHAR_VALUES = {}
for _i, _ch in enumerate(_ALPHABET):
    _CHAR_VALUES[_ch] = _i


def _digit(ch):
    v = _CHAR_VALUES.get(ch, -1)
    if v < 0 or v >= _RADIX:
        raise ValueError("Mask payload contains an invalid character.")
    return v


def pack(raw: bytes) -> str:
    data = list(raw)
    length = len(data)
    prefix = []
    for _ in range(_PREFIX_LEN):
        prefix.append(_ALPHABET[length % _RADIX])
        length //= _RADIX
    if length != 0:
        raise ValueError("Mask payload is too large.")
    out = list(reversed(prefix))
    offset = 0
    full = len(data) - (len(data) % 4)
    while offset < full:
        value = (
            (data[offset] << 24)
            | (data[offset + 1] << 16)
            | (data[offset + 2] << 8)
            | data[offset + 3]
        )
        digits = [0] * 5
        for i in range(4, -1, -1):
            digits[i] = value % _RADIX
            value //= _RADIX
        out.extend(_ALPHABET[d] for d in digits)
        offset += 4
    remainder = len(data) - offset
    if remainder > 0:
        value = 0
        for i in range(4):
            value = ((value << 8) | (data[offset + i] if i < remainder else 0)) & _M32
        digits = [0] * 5
        for i in range(4, -1, -1):
            digits[i] = value % _RADIX
            value //= _RADIX
        out.extend(_ALPHABET[digits[i]] for i in range(remainder + 1))
    return "".join(out)


def unpack(payload: str) -> bytes:
    if len(payload) < _PREFIX_LEN:
        raise ValueError("Mask payload is missing its length prefix.")
    length = 0
    for i in range(_PREFIX_LEN):
        length = length * _RADIX + _digit(payload[i])
    remainder = length % 4
    expected = _PREFIX_LEN + (length // 4) * 5 + (0 if remainder == 0 else remainder + 1)
    if len(payload) != expected:
        raise ValueError("Mask payload length does not match its prefix.")
    out = bytearray(length)
    source = _PREFIX_LEN
    destination = 0
    full = length - remainder
    while destination < full:
        value = 0
        for i in range(5):
            value = value * _RADIX + _digit(payload[source + i])
        if value > _M32:
            raise ValueError("Mask payload contains an out-of-range group.")
        source += 5
        out[destination] = (value >> 24) & 0xFF
        out[destination + 1] = (value >> 16) & 0xFF
        out[destination + 2] = (value >> 8) & 0xFF
        out[destination + 3] = value & 0xFF
        destination += 4
    if remainder > 0:
        value = 0
        for i in range(5):
            value = value * _RADIX + (
                _digit(payload[source + i]) if i < remainder + 1 else _RADIX - 1
            )
        if value > _M32:
            raise ValueError("Mask payload contains an out-of-range tail.")
        for i in range(remainder):
            out[destination + i] = (value >> (24 - i * 8)) & 0xFF
    if pack(bytes(out)) != payload:
        raise ValueError("Mask payload is not in canonical form.")
    return bytes(out)


# --- range coder ---


class RangeDecoder:
    def __init__(self, data: bytes):
        if len(data) < 4:
            raise ValueError("Mask payload is missing its finalization.")
        self._data = data
        self._pos = 0
        self._low = 0
        self._range = _M32
        self._code = 0
        self._scaled = 0
        for _ in range(4):
            self._code = _u32((self._code << 8) | self._read())

    def _read(self):
        if self._pos >= len(self._data):
            raise ValueError("Mask payload ended before decoding completed.")
        b = self._data[self._pos]
        self._pos += 1
        return b

    def frequency(self, total):
        self._scaled = self._range // total
        if self._scaled == 0:
            raise ValueError("Mask payload has invalid coding state.")
        value = _u32(self._code - self._low) // self._scaled
        return total - 1 if value >= total else value

    def decode(self, cumulative, frequency):
        self._low = _u32(self._low + self._scaled * cumulative)
        self._range = self._scaled * frequency
        self._renorm(read_code=True)

    def _renorm(self, read_code):
        while (_u32(self._low ^ _u32(self._low + self._range)) < _TOP) or (
            self._range < _BOTTOM
            and (setattr(self, "_range", _u32(-self._low) & (_BOTTOM - 1)) or True)
        ):
            if read_code:
                self._code = _u32((self._code << 8) | self._read())
            self._low = _u32(self._low << 8)
            self._range = _u32(self._range << 8)


class RangeEncoder:
    def __init__(self):
        self._low = 0
        self._range = _M32
        self._out = []

    def encode(self, cumulative, frequency, total):
        scaled = self._range // total
        self._low = _u32(self._low + scaled * cumulative)
        self._range = scaled * frequency
        while (_u32(self._low ^ _u32(self._low + self._range)) < _TOP) or (
            self._range < _BOTTOM
            and (setattr(self, "_range", _u32(-self._low) & (_BOTTOM - 1)) or True)
        ):
            self._out.append((self._low >> 24) & 0xFF)
            self._low = _u32(self._low << 8)
            self._range = _u32(self._range << 8)

    def finish(self):
        for _ in range(4):
            self._out.append((self._low >> 24) & 0xFF)
            self._low = _u32(self._low << 8)
        return bytes(self._out)


# --- one_bit raster codec ---

_SYMBOLS = 256
_COUNT_LIMIT = 4096
_CONTEXT_COUNT = 1 << 12
_PADDING = 2
_INCREMENT = 14


def _context_at(raster, position, prior, earlier):
    return (
        raster[position - 1]
        | (raster[position - 2] << 1)
        | (raster[prior - 2] << 2)
        | (raster[prior - 1] << 3)
        | (raster[prior] << 4)
        | (raster[prior + 1] << 5)
        | (raster[prior + 2] << 6)
        | (raster[earlier - 2] << 7)
        | (raster[earlier - 1] << 8)
        | (raster[earlier] << 9)
        | (raster[earlier + 1] << 10)
        | (raster[earlier + 2] << 11)
    )


def _update_counts(counts, offset, bit):
    counts[offset + bit] += _INCREMENT
    if counts[offset] + counts[offset + 1] >= _COUNT_LIMIT:
        counts[offset] = counts[offset] >> 1 or 1
        counts[offset + 1] = counts[offset + 1] >> 1 or 1


def encode_raster(raster, width, height):
    encoder = RangeEncoder()
    counts = [1] * (_CONTEXT_COUNT * 2)
    padded_width = width + 2 * _PADDING
    padded = [0] * (padded_width * (height + _PADDING))
    for y in range(height):
        row = (y + _PADDING) * padded_width + _PADDING
        for x in range(width):
            position = row + x
            context = _context_at(
                padded, position, position - padded_width, position - 2 * padded_width
            )
            offset = context << 1
            zero, one = counts[offset], counts[offset + 1]
            bit = raster[y * width + x]
            if bit not in (0, 1):
                raise ValueError("Decoded mask is not binary.")
            if bit == 0:
                encoder.encode(0, zero, zero + one)
            else:
                encoder.encode(zero, one, zero + one)
            padded[position] = bit
            _update_counts(counts, offset, bit)
    return "!" + pack(encoder.finish())


def decode_one_bit(payload, width, height):
    decoder = RangeDecoder(unpack(payload[1:]))
    counts = [1] * (_CONTEXT_COUNT * 2)
    padded_width = width + 2 * _PADDING
    padded = [0] * (padded_width * (height + _PADDING))
    out = [0] * (width * height)
    for y in range(height):
        row = (y + _PADDING) * padded_width + _PADDING
        for x in range(width):
            position = row + x
            context = _context_at(
                padded, position, position - padded_width, position - 2 * padded_width
            )
            offset = context << 1
            zero, one = counts[offset], counts[offset + 1]
            value = decoder.frequency(zero + one)
            bit = 0 if value < zero else 1
            if bit == 0:
                decoder.decode(0, zero)
            else:
                decoder.decode(zero, one)
            padded[position] = bit
            out[y * width + x] = bit
            _update_counts(counts, offset, bit)
    return out


# --- lossless raster codec ---

_SPATIAL_MODES = 5
_ZERO_INCREMENT = 32
_ZERO_LIMIT = 16384
_ORDER_ONE_INCREMENT = 56
_ORDER_ONE_LIMIT = 8192
_ORDER_TWO_STEP = 14 * 44
_ORDER_TWO_LIMIT = 14 * 3584
_ORDER_ZERO_STEP = 2 * 16
_ORDER_ZERO_LIMIT = 2 * 2048
_ORDER_ZERO_INITIAL = 2
_ORDER_ONE_INITIAL = 1


def _paeth(left, up, upper_left):
    estimate = left + up - upper_left
    ld, ud, uld = abs(estimate - left), abs(estimate - up), abs(estimate - upper_left)
    if ld <= ud and ld <= uld:
        return left
    return up if ud <= uld else upper_left


def _predict_byte(output, offset, x, y, mode, width):
    if mode < 0 or mode >= _SPATIAL_MODES:
        raise ValueError("Lossless mask payload uses an invalid predictor.")
    left = output[offset - 1] if x > 0 else 0
    up = output[offset - width] if y > 0 else 0
    if mode == 1:
        return up
    if mode == 2:
        return left
    if mode == 3:
        return (left + up) >> 1
    upper_left = output[offset - width - 1] if (x > 0 and y > 0) else 0
    if mode == 0:
        return _paeth(left, up, upper_left)
    if upper_left >= max(left, up):
        return min(left, up)
    if upper_left <= min(left, up):
        return max(left, up)
    return left + up - upper_left


def _unzig(value, prediction):
    delta = -((value + 1) >> 1) if (value & 1) else value >> 1
    return (prediction + delta) & 0xFF


def _zero_context(residuals, offset, x, y, width):
    left = 1 if (x == 0 or residuals[offset - 1] == 0) else 0
    up = 1 if (y == 0 or residuals[offset - width] == 0) else 0
    upper_left = (
        1 if (x == 0 or y == 0 or residuals[offset - width - 1] == 0) else 0
    )
    upper_right = (
        1
        if (y == 0 or x >= width - 1 or residuals[offset - width + 1] == 0)
        else 0
    )
    return left | (up << 1) | (upper_left << 2) | (upper_right << 3)


def decode_lossless(payload, width, height):
    if not payload.startswith("~"):
        raise ValueError("lossless mask payloads must start with ~.")
    packed = unpack(payload[1:])
    if len(packed) < 5:
        raise ValueError("Lossless mask payload is truncated.")
    selector = packed[0]
    decoder = RangeDecoder(packed[1:])
    length = width * height
    output = [0] * length
    residuals = [0] * length
    zero_counts = [1] * 32
    order_one = [_ORDER_ONE_INITIAL] * (_SYMBOLS * _SYMBOLS)
    order_one_totals = [_SYMBOLS * _ORDER_ONE_INITIAL] * _SYMBOLS
    order_zero = [_ORDER_ZERO_INITIAL] * _SYMBOLS
    order_zero_total = _SYMBOLS * _ORDER_ZERO_INITIAL
    order_two = {}
    previous = 0
    for offset in range(length):
        x = offset % width
        y = offset // width
        zero_offset = _zero_context(residuals, offset, x, y, width) << 1
        zero, nonzero = zero_counts[zero_offset], zero_counts[zero_offset + 1]
        zero_frequency = decoder.frequency(zero + nonzero)
        bit = 0 if zero_frequency < zero else 1
        decoder.decode(0 if bit == 0 else zero, zero if bit == 0 else nonzero)
        zero_counts[zero_offset + bit] += _ZERO_INCREMENT
        if zero_counts[zero_offset] + zero_counts[zero_offset + 1] >= _ZERO_LIMIT:
            zero_counts[zero_offset] = zero_counts[zero_offset] >> 1 or 1
            zero_counts[zero_offset + 1] = zero_counts[zero_offset + 1] >> 1 or 1
        symbol = 0
        if bit == 1:
            above = residuals[offset - width] if offset >= width else 0
            key = (previous << 8) | above
            second = order_two.get(key)
            if second is None:
                second = [0] * (_SYMBOLS + 1)
                order_two[key] = second
            first_offset = previous << 8
            excluded_zero = second[0] + order_one[first_offset] + order_zero[0]
            total = (
                second[_SYMBOLS]
                + order_one_totals[previous]
                + order_zero_total
                - excluded_zero
            )
            target = decoder.frequency(total)
            cumulative = 0
            symbol = 1
            frequency = (
                second[1] + order_one[first_offset + 1] + order_zero[1]
            )
            while cumulative + frequency <= target:
                cumulative += frequency
                symbol += 1
                if symbol >= _SYMBOLS:
                    raise ValueError("Lossless mask payload is malformed.")
                frequency = (
                    second[symbol]
                    + order_one[first_offset + symbol]
                    + order_zero[symbol]
                )
            decoder.decode(cumulative, frequency)
            second[symbol] += _ORDER_TWO_STEP
            second[_SYMBOLS] += _ORDER_TWO_STEP
            if second[_SYMBOLS] >= _ORDER_TWO_LIMIT:
                total_after = 0
                for v in range(_SYMBOLS):
                    second[v] >>= 1
                    total_after += second[v]
                second[_SYMBOLS] = total_after
            order_one[first_offset + symbol] += _ORDER_ONE_INCREMENT
            order_one_totals[previous] += _ORDER_ONE_INCREMENT
            if order_one_totals[previous] >= _ORDER_ONE_LIMIT:
                total_after = 0
                for v in range(_SYMBOLS):
                    scaled = order_one[first_offset + v] >> 1 or 1
                    order_one[first_offset + v] = scaled
                    total_after += scaled
                order_one_totals[previous] = total_after
            order_zero[symbol] += _ORDER_ZERO_STEP
            order_zero_total += _ORDER_ZERO_STEP
            if order_zero_total >= _ORDER_ZERO_LIMIT:
                total_after = 0
                for v in range(_SYMBOLS):
                    order_zero[v] >>= 1
                    total_after += order_zero[v]
                order_zero_total = total_after
        residuals[offset] = symbol
        output[offset] = _unzig(
            symbol, _predict_byte(output, offset, x, y, selector, width)
        )
        previous = symbol
    return output


def decode_mask_to_raster(enc, payload, width, height):
    """Decode one SAM mask token to a row-major list of 0/1, length W*H."""
    if width <= 0 or height <= 0:
        raise ValueError("Mask dimensions must be positive.")
    if enc == "one_bit":
        if not payload.startswith("!"):
            raise ValueError("one_bit mask payloads must start with !.")
        raster = decode_one_bit(payload, width, height)
        if encode_raster(raster, width, height) != payload:
            raise ValueError("Mask payload is not canonical.")
        return raster
    if enc == "lossless":
        coverage = decode_lossless(payload, width, height)
        return [1 if v >= 129 else 0 for v in coverage]
    raise ValueError(f"Unsupported mask encoding: {enc}.")


# --- output_text record parsing ---

_RECORD_RE = re.compile(
    r"(\d+)<\|box;([^|]*)\|><\|mask;([^|]*)\|>"
)
_BOX_FLOAT = re.compile(r"([a-z0-9]+)=(-?[0-9]+(?:\.[0-9]+)?)")


def _parse_fields(token):
    return dict(_BOX_FLOAT.findall(token))


def parse_output_records(text):
    """Parse SAM output_text into [{id, box, mask}] records."""
    records = []
    for m in _RECORD_RE.finditer(text):
        box = _parse_fields(m.group(2))
        mask = _parse_fields(m.group(3))
        try:
            data = m.group(3).split("data=")[1]
        except IndexError:
            continue
        h, w, rest = data.split(",", 2)
        records.append(
            {
                "id": int(m.group(1)),
                "box": {
                    "x1": int(box["x1"]),
                    "y1": int(box["y1"]),
                    "x2": int(box["x2"]),
                    "y2": int(box["y2"]),
                    "w": int(box["w"]),
                    "h": int(box["h"]),
                },
                "mask": {
                    "h": int(h),
                    "w": int(w),
                    "enc": "one_bit" if rest.startswith("!") else "lossless",
                    "payload": rest,
                },
            }
        )
    return records


# --- mask raster -> polygon (marching squares, largest loop) ---


def _marching_segments(raster, width, height):
    def v(x, y):
        if x < 0 or y < 0 or x >= width or y >= height:
            return 0
        return raster[y * width + x]

    segs = []
    for y in range(height):
        for x in range(width):
            if not v(x, y):
                continue
            # cell corners (x,y) top-left; emit edges bordering empty space
            if not v(x, y - 1):
                segs.append(((x, y), (x + 1, y)))
            if not v(x, y + 1):
                segs.append(((x, y + 1), (x + 1, y + 1)))
            if not v(x - 1, y):
                segs.append(((x, y), (x, y + 1)))
            if not v(x + 1, y):
                segs.append(((x + 1, y), (x + 1, y + 1)))
    return segs


def largest_contour(raster, width, height):
    """Trace the boundary of the largest 1-region; returns [(x, y)] in cell units."""
    segs = _marching_segments(raster, width, height)
    if not segs:
        return []
    adj = {}
    for a, b in segs:
        adj.setdefault(a, []).append(b)
        adj.setdefault(b, []).append(a)
    seen_edges = set()
    best = []
    for start in adj:
        if all(
            (start, n) in seen_edges and (n, start) in seen_edges for n in adj[start]
        ):
            continue
        loop = [start]
        prev, cur = None, start
        while True:
            nxt = None
            for n in adj[cur]:
                if n != prev and (cur, n) not in seen_edges:
                    nxt = n
                    break
            if nxt is None:
                break
            seen_edges.add((cur, nxt))
            prev, cur = cur, nxt
            if cur == start:
                break
            loop.append(cur)
            if len(loop) > len(segs) + 1:
                break
        if loop and cur == start and len(loop) > len(best):
            best = loop
    return best


def simplify(points, max_points=200):
    if len(points) <= max_points or not points:
        return points
    step = len(points) / max_points
    return [points[int(i * step)] for i in range(max_points)]


# --- geo mapping + area ---

_EARTH_R_KM = 6371.0


def mask_polygon_latlon(raster, mask_w, mask_h, box, img_w, img_h, bbox):
    """Largest mask contour as [(lat, lon)], mapping mask cells through the box."""
    min_lon, min_lat, max_lon, max_lat = bbox
    contour = largest_contour(raster, mask_w, mask_h)
    bw = box["x2"] - box["x1"]
    bh = box["y2"] - box["y1"]
    pts = []
    for cx, cy in contour:
        px = box["x1"] + (cx / mask_w) * bw
        py = box["y1"] + (cy / mask_h) * bh
        lon = min_lon + (px / img_w) * (max_lon - min_lon)
        lat = max_lat - (py / img_h) * (max_lat - min_lat)
        pts.append((lat, lon))
    return simplify(pts)


def polygon_area_km2(points):
    """Spherical-excess area of a [(lat, lon)] polygon via triangle fan (l'Huilier)."""
    if len(points) < 3:
        return 0.0
    rad = [(math.radians(lat), math.radians(lon)) for lat, lon in points]

    def ang(a, b):
        # central angle between two unit vectors
        lat1, lon1 = a
        lat2, lon2 = b
        return math.acos(
            max(
                -1.0,
                min(
                    1.0,
                    math.sin(lat1) * math.sin(lat2)
                    + math.cos(lat1) * math.cos(lat2) * math.cos(lon2 - lon1),
                ),
            )
        )

    def tri_excess(a, b, c):
        A, B, C = ang(b, c), ang(a, c), ang(a, b)
        s = (A + B + C) / 2
        t = (
            math.tan(s / 2)
            * math.tan((s - A) / 2)
            * math.tan((s - B) / 2)
            * math.tan((s - C) / 2)
        )
        return 4 * math.atan(math.sqrt(max(0.0, t)))

    total = 0.0
    p0 = rad[0]
    for i in range(1, len(rad) - 1):
        total += tri_excess(p0, rad[i], rad[i + 1])
    return total * _EARTH_R_KM * _EARTH_R_KM
