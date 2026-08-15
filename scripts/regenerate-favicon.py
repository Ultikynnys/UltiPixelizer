#!/usr/bin/env python3
"""Regenerate public/favicon.ico to mirror public/favicon.svg.

Rasterizes the UltiPixelizer brand mark — a 2x2 pixel grid (7px cells,
2px gaps) rotated 45deg — with the same geometry and colors as the SVG:

    <g transform="translate(32 32) rotate(45) scale(2.2627)">
      <rect x="-8" y="-8" width="7" height="7" fill="var(--paper)"/>
      <rect x="1" y="-8" width="7" height="7" fill="var(--paper)"/>
      <rect x="-8" y="1" width="7" height="7" fill="var(--paper)"/>
      <rect x="1" y="1" width="7" height="7" fill="var(--accent)"/>
    </g>

Colors mirror src/style.css :root --paper #f3f0e6, --accent #8b5cf6.
Run from the project root:  python3 scripts/regenerate-favicon.py
"""

import binascii
import math
import os
import struct
import sys
import zlib

# ── brand colors (mirror src/style.css :root) ────────────────────────────
PAPER = (243, 240, 230)   # --paper: #f3f0e6
ACCENT = (139, 92, 246)   # --accent: #8b5cf6

# ── brand mark geometry (mirror public/favicon.svg) ──────────────────────
VIEWBOX = 64.0
ROTATE = math.radians(45.0)
SCALE = 2.2627
CELL = 7
GAP = 2
CELLS = [  # (x, y, color)
    (-8, -8, PAPER),
    (1, -8, PAPER),
    (-8, 1, PAPER),
    (1, 1, ACCENT),
]

SIZES = (16, 32, 48)
SUPERSAMPLE = 4  # sub-samples per pixel axis for anti-aliasing


def cell_at(lx: float, ly: float):
    """Return the color of the cell containing local point (lx, ly), or None."""
    for x, y, color in CELLS:
        if x <= lx < x + CELL and y <= ly < y + CELL:
            return color
    return None


def rasterize(size: int):
    """Render the brand mark at `size` px; returns list of RGBA rows."""
    cos = math.cos(ROTATE)
    sin = math.sin(ROTATE)
    rows = []
    for py in range(size):
        row = []
        for px in range(size):
            # Premultiplied-alpha accumulation across sub-samples.
            acc_r = acc_g = acc_b = acc_a = 0.0
            for sy in range(SUPERSAMPLE):
                for sx in range(SUPERSAMPLE):
                    # Pixel-center → viewBox coords.
                    u = (px + (sx + 0.5) / SUPERSAMPLE) / size * VIEWBOX
                    v = (py + (sy + 0.5) / SUPERSAMPLE) / size * VIEWBOX
                    # viewBox → local coords (inverse of the SVG transform).
                    t = u - VIEWBOX / 2
                    s = v - VIEWBOX / 2
                    lx = ((t * cos + s * sin) / SCALE)
                    ly = ((-t * sin + s * cos) / SCALE)
                    color = cell_at(lx, ly)
                    if color is not None:
                        r, g, b = color
                        acc_r += r
                        acc_g += g
                        acc_b += b
                        acc_a += 255.0
            if acc_a == 0:
                row.append((0, 0, 0, 0))
            else:
                row.append((
                    round(acc_r * 255 / acc_a),
                    round(acc_g * 255 / acc_a),
                    round(acc_b * 255 / acc_a),
                    round(acc_a / (SUPERSAMPLE * SUPERSAMPLE)),
                ))
        rows.append(row)
    return rows


def png_chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack('>I', len(data))
        + tag
        + data
        + struct.pack('>I', binascii.crc32(tag + data) & 0xFFFFFFFF)
    )


def encode_png(size: int, rows) -> bytes:
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)  # RGBA8
    raw = b''.join(b'\x00' + b''.join(bytes(px) for px in row) for row in rows)
    return (
        b'\x89PNG\r\n\x1a\n'
        + png_chunk(b'IHDR', ihdr)
        + png_chunk(b'IDAT', zlib.compress(raw, 9))
        + png_chunk(b'IEND', b'')
    )


def build_ico(images) -> bytes:
    count = len(images)
    header = struct.pack('<HHH', 0, 1, count)
    offset = 6 + 16 * count
    entries = b''
    payload = b''
    for size, png in images:
        entries += struct.pack('<BBBBHHII', size, size, 0, 0, 1, 32, len(png), offset)
        payload += png
        offset += len(png)
    return header + entries + payload


def main() -> int:
    images = []
    for size in SIZES:
        rows = rasterize(size)
        png = encode_png(size, rows)
        images.append((size, png))
        print(f'rasterized {size}x{size} ({len(png)} bytes PNG)')

    ico = build_ico(images)
    out = os.path.join('public', 'favicon.ico')
    with open(out, 'wb') as f:
        f.write(ico)
    print(f'wrote {out} ({len(ico)} bytes, sizes={SIZES})')
    return 0


if __name__ == '__main__':
    sys.exit(main())
