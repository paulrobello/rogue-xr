#!/usr/bin/env -S uv run --no-project --with pillow python
"""Build the study's 8 x 4 book atlas; UV row zero is the top of the image."""

from __future__ import annotations

import math
import random
import shutil
import struct
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageStat

ROOT = Path(__file__).resolve().parents[2]
REVIEW = ROOT / ".local/review"
OUTPUT = ROOT / "public/assets/props/study-books/book-bindings.ktx2"
KTX = Path.home() / ".local/opt/ktx-software-4.4.2/bin/ktx"
FONT = Path("/System/Library/Fonts/Supplemental/Georgia.ttf")
SIZE = 2
W, H = 128 * SIZE, 256 * SIZE
PALETTE = [
    (102, 43, 35),
    (55, 79, 70),
    (89, 62, 42),
    (44, 61, 76),
    (103, 72, 45),
    (78, 43, 56),
    (67, 70, 46),
    (91, 50, 37),
]
TITLES = [
    ("HOROLOGIA", "THE STARS"),
    ("HERBARIUM", "BOTANICA"),
    ("MECHANICA", "THE TIDES"),
    ("ASTRONOMIA", "NOCTURNE"),
    ("THE ATLAS", "CHRONICLES"),
    ("ARCANA", "ALMANAC"),
    ("NATURALIS", "THE GARDEN"),
    ("THE SPIRE", "VOYAGES"),
]
GOLD = (192, 159, 99)
DARK_GOLD = (113, 85, 49)


def shade(c: tuple[int, int, int], factor: float) -> tuple[int, int, int]:
    return tuple(max(8, min(247, round(v * factor))) for v in c)


def text_center(
    draw: ImageDraw.ImageDraw,
    y: int,
    text: str,
    font: ImageFont.FreeTypeFont,
    color: tuple[int, int, int] = GOLD,
) -> None:
    box = draw.textbbox((0, 0), text, font=font)
    draw.text(
        ((W - (box[2] - box[0])) / 2, y), text, fill=color, font=font, stroke_width=0
    )


def base(col: int, row: int, color: tuple[int, int, int]) -> Image.Image:
    rng = random.Random(10819 + col * 541 + row * 101)
    im = Image.new("RGB", (W, H), color)
    d = ImageDraw.Draw(im, "RGBA")
    # Broad translucent wear gives a leather grain without noisy pinpoints.
    for _ in range(160):
        x, y = rng.randrange(W), rng.randrange(H)
        rx, ry = rng.randrange(4, 24), rng.randrange(5, 38)
        light = rng.choice((True, False))
        d.ellipse(
            (x - rx, y - ry, x + rx, y + ry),
            fill=(226, 187, 133, rng.randrange(3, 10))
            if light
            else (20, 13, 10, rng.randrange(4, 12)),
        )
    im = im.filter(ImageFilter.GaussianBlur(1.2))
    return im


def ornament(
    draw: ImageDraw.ImageDraw, cx: int, cy: int, radius: int, kind: int
) -> None:
    draw.ellipse(
        (cx - radius, cy - radius, cx + radius, cy + radius), outline=DARK_GOLD, width=4
    )
    draw.ellipse(
        (cx - radius + 5, cy - radius + 5, cx + radius - 5, cy + radius - 5),
        outline=GOLD,
        width=2,
    )
    if kind % 2:
        draw.line((cx - radius // 2, cy, cx + radius // 2, cy), fill=GOLD, width=3)
        draw.line((cx, cy - radius // 2, cx, cy + radius // 2), fill=GOLD, width=3)
        draw.polygon(
            [
                (cx, cy - radius // 2),
                (cx + radius // 4, cy),
                (cx, cy + radius // 2),
                (cx - radius // 4, cy),
            ],
            outline=GOLD,
            width=2,
        )
    else:
        for i in range(8):
            a = math.tau * i / 8
            draw.line(
                (
                    cx + radius * 0.25 * math.cos(a),
                    cy + radius * 0.25 * math.sin(a),
                    cx + radius * 0.55 * math.cos(a),
                    cy + radius * 0.55 * math.sin(a),
                ),
                fill=GOLD,
                width=3,
            )
        draw.ellipse((cx - 5, cy - 5, cx + 5, cy + 5), fill=GOLD)


def spine(col: int, row: int) -> Image.Image:
    c = PALETTE[col]
    im = base(col, row, c)
    d = ImageDraw.Draw(im)
    d.rectangle((10, 10, W - 11, H - 11), outline=shade(c, 0.58), width=5)
    d.line((18, 14, 18, H - 14), fill=shade(c, 1.3), width=3)
    d.line((W - 19, 14, W - 19, H - 14), fill=shade(c, 0.72), width=4)
    band_sets = (
        (68, 145, 345, 431),
        (82, 153, 352, 420),
        (62, 160, 330, 437),
        (76, 166, 342, 425),
    )
    for y in band_sets[(col + row * 2) % 4]:
        d.rectangle((14, y - 8, W - 15, y + 9), fill=shade(c, 0.68))
        d.line((19, y - 5, W - 20, y - 5), fill=GOLD, width=2)
        d.line((19, y + 5, W - 20, y + 5), fill=DARK_GOLD, width=3)
    font = ImageFont.truetype(str(FONT), 18)
    small = ImageFont.truetype(str(FONT), 15)
    text_center(d, 185, TITLES[col][row], font)
    text_center(d, 213, "VOL. %s" % ("I" if row == 0 else "II"), small)
    ornament(d, W // 2, 293, 24 + (col % 3) * 5, col + row)
    if (col + row) % 3 == 0:
        for x in (47, W - 48):
            d.line((x, 255, x, 320), fill=DARK_GOLD, width=2)
            d.polygon(
                [(x, 263), (x + 6, 275), (x, 287), (x - 6, 275)], outline=GOLD, width=2
            )
    elif (col + row) % 3 == 1:
        for y in (266, 320):
            d.line((51, y, 88, y), fill=DARK_GOLD, width=2)
            d.line((W - 89, y, W - 52, y), fill=DARK_GOLD, width=2)
    text_center(d, 372, ("MDCCLXXXIV", "LONDON")[row], small)
    return im


def cover(col: int) -> Image.Image:
    c = PALETTE[col]
    im = base(col, 2, c)
    d = ImageDraw.Draw(im)
    d.rectangle((14, 14, W - 15, H - 15), outline=shade(c, 0.57), width=5)
    d.rectangle((23, 23, W - 24, H - 24), outline=DARK_GOLD, width=3)
    d.rectangle((30, 30, W - 31, H - 31), outline=GOLD, width=2)
    for x in (43, W - 44):
        for y in (44, H - 45):
            d.line((x - 10, y, x + 10, y), fill=GOLD, width=2)
            d.line((x, y - 10, x, y + 10), fill=GOLD, width=2)
    ornament(d, W // 2, H // 2, 53, col)
    if col % 3 == 0:
        d.arc((56, 173, W - 57, 339), 25, 155, fill=GOLD, width=2)
        d.arc((56, 173, W - 57, 339), 205, 335, fill=GOLD, width=2)
    elif col % 3 == 1:
        d.polygon(
            [(W // 2, 173), (W - 56, H // 2), (W // 2, 339), (56, H // 2)],
            outline=DARK_GOLD,
            width=3,
        )
    else:
        for y in (185, 327):
            d.line((69, y, W - 70, y), fill=DARK_GOLD, width=3)
    text_center(d, 119, TITLES[col][0], ImageFont.truetype(str(FONT), 16))
    text_center(d, 365, "A PRIVATE LIBRARY", ImageFont.truetype(str(FONT), 14))
    return im


def pages(col: int) -> Image.Image:
    rng = random.Random(7501 + col)
    c = PALETTE[col]
    im = Image.new("RGB", (W, H), shade(c, 0.82))
    d = ImageDraw.Draw(im)
    d.rectangle((17, 9, W - 18, H - 10), fill=(190 + col * 2, 176 + col, 145 + col))
    # Page edges are parallel to the long axis; boards bound both long sides.
    for x in range(21, W - 20, 4):
        v = rng.randrange(-12, 13)
        d.line(
            (x, 11, x + rng.choice((-1, 0, 0, 1)), H - 18),
            fill=(max(1, 174 + v), max(1, 157 + v), max(1, 125 + v)),
            width=1,
        )
    for y in (13, H - 19):
        d.line((20, y, W - 21, y), fill=(222, 207, 174), width=3)
    d.rectangle((5, 7, 17, H - 8), fill=shade(c, 0.68))
    d.rectangle((W - 18, 7, W - 6, H - 8), fill=shade(c, 0.68))
    d.line((11, 12, 11, H - 13), fill=shade(c, 1.3), width=2)
    d.line((W - 12, 12, W - 12, H - 13), fill=shade(c, 1.3), width=2)
    d.rectangle((17, H - 20, W - 18, H - 9), fill=shade(c, 0.77))
    for x in range(20, W - 20, 9):
        d.line((x, H - 18, x + 3, H - 11), fill=GOLD, width=2)
    return im


def main() -> None:
    if not FONT.is_file() or not KTX.is_file():
        raise SystemExit("Georgia font and KTX-Software 4.4.2 are required")
    REVIEW.mkdir(parents=True, exist_ok=True)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    atlas = Image.new("RGB", (1024, 1024))
    for row in range(4):
        for col in range(8):
            tile = (
                spine(col, row) if row < 2 else cover(col) if row == 2 else pages(col)
            )
            atlas.paste(
                tile.resize((128, 256), Image.Resampling.LANCZOS),
                (col * 128, row * 256),
            )
    assert atlas.size == (1024, 1024)
    for row in range(4):
        for col in range(8):
            tile = atlas.crop((col * 128, row * 256, (col + 1) * 128, (row + 1) * 256))
            assert (
                min(ImageStat.Stat(tile).mean) > 25
                and max(ImageStat.Stat(tile).stddev) > 5
            ), (row, col)
    preview = REVIEW / "book-bindings-atlas.png"
    atlas.save(preview)
    staged = REVIEW / "book-bindings.staged.ktx2"
    subprocess.run(
        [
            str(KTX),
            "create",
            "--format",
            "R8G8B8_SRGB",
            "--assign-tf",
            "srgb",
            "--assign-texcoord-origin",
            "top-left",
            "--encode",
            "uastc",
            "--uastc-quality",
            "2",
            "--zstd",
            "18",
            "--generate-mipmap",
            str(preview),
            str(staged),
        ],
        check=True,
    )
    raw = staged.read_bytes()
    assert raw[:12] == b"\xabKTX 20\xbb\r\n\x1a\n"
    width, height, levels = (
        struct.unpack_from("<II", raw, 20)[0],
        struct.unpack_from("<I", raw, 24)[0],
        struct.unpack_from("<I", raw, 40)[0],
    )
    assert (width, height, levels) == (1024, 1024, 11), (width, height, levels)
    subprocess.run([str(KTX), "validate", str(staged)], check=True)
    shutil.copyfile(staged, OUTPUT)
    print(
        f"{OUTPUT}: {width}x{height}, {levels} levels, {len(raw)} bytes; preview {preview}"
    )


if __name__ == "__main__":
    main()
