"""Builds the P5-T6 UI runtime assets from the immutable sources in assets-source/ui/.

Usage: python3 -I scripts/assets/build_ui_atlas.py [--ktx <path to ktx>] [--no-ktx]

Deterministic: the same sources produce byte-identical PNG/JPG outputs. Writes
  public/assets/ui/icons.png          16 icons, 128 px slots (112 px medallion + 8 px padding), 512x512
  public/assets/ui/dice-d6.png        brass d6 faces, 256 px slots, 1024x512 (faces 0-5)
  public/assets/ui/dice-d8.png        glass d8 faces, 256 px slots, 1024x512 (faces 0-7)
  public/assets/ui/dice-d6-glow.png   emissive masks for the d6 page: amber pips on black, same slots
  public/assets/ui/dice-d8-glow.png   emissive masks for the d8 page: amber numerals on black, same slots
  public/assets/ui/glyphs.png         5 sigil glyphs drawn from src/sigil/templates.ts, 256 px slots, 1024x512
  public/assets/ui/title-2048.jpg     title key art backdrop 2048x1152, and title-1024.jpg 1024x576
  public/assets/ui/*.ktx2             UASTC + Zstandard, mipmapped, bottom-left origin (when ktx exists)
  public/assets/ui/ui-atlas.json      manifest read by src/ui/icon-atlas.ts
  docs/verification/p5-ui-icons-legibility.png and p5-ui-review.png
and records output hashes under "derivatives" in assets-source/ui/provenance.json.

UV rects are in three.js texture space (origin bottom-left, v up).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "assets-source/ui"
OUT = ROOT / "public/assets/ui"
DOCS = ROOT / "docs/verification"
FONT = ROOT / "node_modules/@par/xr-workspace/assets/fonts/NotoSans-Regular.ttf"
DEFAULT_KTX = Path.home() / ".local/opt/ktx-software-4.4.2/bin/ktx"

ICON_SLOT = 128
ICON_PAD = 8
DIE_SLOT = 256
GLYPH_SLOT = 256

WARM_BLACK = (0x23, 0x1D, 0x1A)
AMBER = (0xF3, 0xBE, 0x65)
AMBER_HOT = (0xFF, 0xEC, 0xC0)
BRASS = (0xDE, 0xC1, 0x6A)

# Fraction of the title image kept clear for the runtime title (origin top-left): the dark left wall.
TITLE_SAFE = {"x": 0.03, "y": 0.3, "w": 0.27, "h": 0.4}

# Share of a mark's soft glow that also emits on the glow pages, so the halo glows a little.
GLOW_HALO = 0.35
# Glow-page fill: saturated candle amber, without the colour page's cream hot core. AgX tone mapping
# washes a bright emitter toward white, so the emitter itself must sit well past the target hue.
GLOW_FILL = (0xFF, 0x9A, 0x10)

# d6 walnut grade (art bible oiled walnut #583C26): the painted panel reads too red and dark.
# Panel: rounded rect in 256 px slot pixels (x0, y0, x1, y1), measured inside the brass bevel;
# the corner radius clears the bevel's chamfered corners. The mask starts WALNUT_INSET px inside
# the panel edge, ramps up over WALNUT_FEATHER px, and fades out between the two Rec.601
# luminances of WALNUT_LUM_GATE so no brass pixel is graded.
WALNUT_TARGET = (0x58, 0x3C, 0x26)
WALNUT_PANEL_PX = (26, 28, 204, 229)
WALNUT_CORNER_PX = 10
WALNUT_INSET_PX = 2
WALNUT_FEATHER_PX = 3
WALNUT_LUM_GATE = (72, 96)
# Linear-light grade: luminance x WALNUT_LUM_GAIN (keeps grain contrast exactly), chromaticity
# moved WALNUT_HUE_MIX of the way to the target's (keeps some of the painted streak colour).
WALNUT_LUM_GAIN = 1.46
WALNUT_HUE_MIX = 0.75

# Pip centres in a unit d6 face (origin top-left), per value.
PIPS = {
    1: [(0.5, 0.5)],
    2: [(0.3, 0.3), (0.7, 0.7)],
    3: [(0.3, 0.3), (0.5, 0.5), (0.7, 0.7)],
    4: [(0.3, 0.3), (0.7, 0.3), (0.3, 0.7), (0.7, 0.7)],
    5: [(0.3, 0.3), (0.7, 0.3), (0.5, 0.5), (0.3, 0.7), (0.7, 0.7)],
    6: [(0.3, 0.27), (0.7, 0.27), (0.3, 0.5), (0.7, 0.5), (0.3, 0.73), (0.7, 0.73)],
}

D6_VALUES = [1, 2, 3, 4, 5, 6]
D8_VALUES = [1, 2, 3, 4, 5, 6, 7, 8]
SIGIL_IDS = ["gear", "flame", "ward", "bolt", "spiral"]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def save_png(img: Image.Image, path: Path) -> None:
    img.save(path, format="PNG", optimize=True)


def dilate_rgb(rgba: np.ndarray, iterations: int = 24) -> np.ndarray:
    """Spreads opaque colours into fully transparent pixels so filtering and mips show no dark fringe."""
    out = rgba.astype(np.float64)
    known = rgba[..., 3] > 0
    h, w = known.shape
    for _ in range(iterations):
        if known.all():
            break
        pad_rgb = np.pad(out[..., :3] * known[..., None], ((1, 1), (1, 1), (0, 0)))
        pad_k = np.pad(known.astype(np.float64), 1)
        acc = np.zeros((h, w, 3))
        cnt = np.zeros((h, w))
        for dy in (0, 1, 2):
            for dx in (0, 1, 2):
                acc += pad_rgb[dy : dy + h, dx : dx + w]
                cnt += pad_k[dy : dy + h, dx : dx + w]
        grow = (~known) & (cnt > 0)
        out[grow, :3] = acc[grow] / cnt[grow, None]
        known = known | grow
    if not known.all() and known.any():
        out[~known, :3] = out[known, :3].mean(axis=0)
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)


def uv_rect(x: int, y: int, w: int, h: int, page_w: int, page_h: int) -> dict:
    return {
        "u0": x / page_w,
        "v0": 1 - (y + h) / page_h,
        "u1": (x + w) / page_w,
        "v1": 1 - y / page_h,
    }


def entry(page: str, x: int, y: int, w: int, h: int, page_w: int, page_h: int) -> dict:
    return {"page": page, "px": {"x": x, "y": y, "w": w, "h": h}, "uv": uv_rect(x, y, w, h, page_w, page_h)}


def content_bbox(mask: np.ndarray, min_count: int = 8) -> tuple[int, int, int, int]:
    """Bounding box (x0, y0, x1, y1) of rows and columns with at least `min_count` mask pixels."""
    cols = np.where(mask.sum(axis=0) >= min_count)[0]
    rows = np.where(mask.sum(axis=1) >= min_count)[0]
    return int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1


def disc_mask(size: int, inset: float) -> np.ndarray:
    """Anti-aliased disc filling a `size` square, its edge `inset` pixels inside the square."""
    c = (size - 1) / 2
    yy, xx = np.mgrid[0:size, 0:size]
    d = np.hypot(xx - c, yy - c)
    return np.clip(c - inset - d + 0.5, 0, 1)


# ---------------------------------------------------------------------------------------------- icons


def build_icons() -> tuple[Image.Image, dict, list[dict]]:
    spec = json.loads((SRC / "icon-map.json").read_text())
    sheet = np.asarray(Image.open(SRC / spec["source"]).convert("RGB"))
    cutout = np.asarray(Image.open(SRC / spec["cutout"]).convert("RGBA"))
    cols, rows = spec["grid"]["cols"], spec["grid"]["rows"]
    cw, ch = sheet.shape[1] // cols, sheet.shape[0] // rows
    ids: list[str] = spec["cells"]
    page_cols = 4
    page_w = page_cols * ICON_SLOT
    page_h = math.ceil(len(ids) / page_cols) * ICON_SLOT
    page = np.zeros((page_h, page_w, 4), dtype=np.uint8)
    icons: dict = {}
    crops: list[dict] = []
    inner = ICON_SLOT - 2 * ICON_PAD
    for i, icon_id in enumerate(ids):
        cx, cy = (i % cols) * cw, (i // cols) * ch
        alpha = cutout[cy : cy + ch, cx : cx + cw, 3]
        x0, y0, x1, y1 = content_bbox(alpha > 128)
        side = max(x1 - x0, y1 - y0)
        mx, my = (x0 + x1) // 2, (y0 + y1) // 2
        sx0, sy0 = cx + mx - side // 2, cy + my - side // 2
        rgb = sheet[sy0 : sy0 + side, sx0 : sx0 + side].astype(np.float64)
        a = cutout[sy0 : sy0 + side, sx0 : sx0 + side, 3].astype(np.float64) / 255
        a *= disc_mask(side, 1.5)
        # Despill only the outer rim band, where the green key can bleed; emerald symbols stay intact.
        c = (side - 1) / 2
        yy, xx = np.mgrid[0:side, 0:side]
        band = np.hypot(xx - c, yy - c) > c - side * 0.04
        g = rgb[..., 1]
        rgb[..., 1] = np.where(band, np.minimum(g, np.maximum(rgb[..., 0], rgb[..., 2])), g)
        tile = np.dstack([rgb, a * 255])
        tile = np.clip(np.rint(tile), 0, 255).astype(np.uint8)
        small = Image.fromarray(tile, "RGBA").resize((inner, inner), Image.Resampling.LANCZOS)
        arr = np.asarray(small).copy()
        arr[arr[..., 3] < 4] = 0
        px, py = (i % page_cols) * ICON_SLOT, (i // page_cols) * ICON_SLOT
        page[py + ICON_PAD : py + ICON_PAD + inner, px + ICON_PAD : px + ICON_PAD + inner] = arr
        icons[icon_id] = entry("icons", px, py, ICON_SLOT, ICON_SLOT, page_w, page_h)
        crops.append({"id": icon_id, "sourceRect": {"x": int(sx0), "y": int(sy0), "w": side, "h": side}})
    return Image.fromarray(dilate_rgb(page), "RGBA"), icons, crops


# ----------------------------------------------------------------------------------------------- dice


def plate_boxes(sheet: np.ndarray) -> tuple[tuple[int, int, int, int], tuple[int, int, int, int]]:
    lum = sheet.astype(np.float64) @ np.array([0.299, 0.587, 0.114])
    bright = lum > 70
    half = sheet.shape[1] // 2
    x0, y0, x1, y1 = content_bbox(bright[:, :half], 20)
    left = (x0, y0, x1, y1)
    x0, y0, x1, y1 = content_bbox(bright[:, half:], 20)
    return left, (x0 + half, y0, x1 + half, y1)


def glow_layer(size: tuple[int, int], draw_fn, blur: float) -> np.ndarray:
    mask = Image.new("L", size, 0)
    draw_fn(ImageDraw.Draw(mask))
    return np.asarray(mask.filter(ImageFilter.GaussianBlur(blur)), dtype=np.float64) / 255


def lit_mark(base: np.ndarray, draw_fn, scale: int) -> tuple[np.ndarray, np.ndarray]:
    """Composites an amber glowing mark (pip or numeral) drawn by `draw_fn` at `scale`x onto `base`.

    Also returns the face's emissive glow tile: `GLOW_FILL` over the mark core plus `GLOW_HALO` of
    its soft glow, black elsewhere, alpha 255.
    """
    h, w = base.shape[:2]
    big = (w * scale, h * scale)
    core = Image.new("L", big, 0)
    draw_fn(ImageDraw.Draw(core))
    core_small = np.asarray(core.resize((w, h), Image.Resampling.LANCZOS), dtype=np.float64) / 255
    shadow = np.asarray(
        Image.fromarray(np.uint8(core_small * 255)).filter(ImageFilter.GaussianBlur(3)), dtype=np.float64
    ) / 255
    glow = np.asarray(
        Image.fromarray(np.uint8(core_small * 255)).filter(ImageFilter.GaussianBlur(7)), dtype=np.float64
    ) / 255
    hot = np.asarray(
        Image.fromarray(np.uint8(core_small * 255)).filter(ImageFilter.MinFilter(9)), dtype=np.float64
    ) / 255
    out = base[..., :3].astype(np.float64)
    out *= 1 - 0.55 * shadow[..., None]
    out += np.array(AMBER) * 0.5 * glow[..., None]
    hot = 0.6 * hot
    fill = np.array(AMBER)[None, None, :] * (1 - hot[..., None]) + np.array(AMBER_HOT) * hot[..., None]
    out = out * (1 - core_small[..., None]) + fill * core_small[..., None]
    res = base.copy()
    res[..., :3] = np.clip(np.rint(out), 0, 255).astype(np.uint8)
    emit = np.clip(core_small + GLOW_HALO * glow, 0, 1)
    lit = np.full((h, w, 4), 255, np.uint8)
    lit[..., :3] = np.clip(np.rint(np.array(GLOW_FILL, np.float64) * emit[..., None]), 0, 255).astype(np.uint8)
    return res, lit


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    c = c / 255
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0, 1)
    return 255 * np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def walnut_mask(plate: np.ndarray) -> np.ndarray:
    """Soft 0..1 mask of the d6 plate's walnut panel (rounded-rect geometry times a luminance gate)."""
    h, w = plate.shape[:2]
    x0, y0, x1, y1 = WALNUT_PANEL_PX
    r = WALNUT_CORNER_PX
    ys, xs = np.mgrid[0:h, 0:w] + 0.5
    qx = np.abs(xs - (x0 + x1) / 2) - ((x1 - x0) / 2 - r)
    qy = np.abs(ys - (y0 + y1) / 2) - ((y1 - y0) / 2 - r)
    inside = r - np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) - np.minimum(np.maximum(qx, qy), 0)
    geo = np.clip((inside - WALNUT_INSET_PX) / WALNUT_FEATHER_PX, 0, 1)
    lum = plate.astype(np.float64) @ np.array([0.299, 0.587, 0.114])
    lo, hi = WALNUT_LUM_GATE
    t = np.clip((hi - lum) / (hi - lo), 0, 1)
    return geo * t * t * (3 - 2 * t)


def grade_walnut(plate: np.ndarray) -> np.ndarray:
    """Moves the d6 walnut panel toward WALNUT_TARGET; brass rim and bevel are left as painted."""
    lin = srgb_to_linear(plate.astype(np.float64))
    weights = np.array([0.2126, 0.7152, 0.0722])
    lum = np.maximum(lin @ weights, 1e-6)[..., None]
    target = srgb_to_linear(np.array(WALNUT_TARGET, np.float64))
    chroma = lin / lum
    chroma += WALNUT_HUE_MIX * (target / (target @ weights) - chroma)
    graded = linear_to_srgb(lum * WALNUT_LUM_GAIN * chroma)
    mask = walnut_mask(plate)[..., None]
    out = plate * (1 - mask) + graded * mask
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)


def build_dice() -> tuple[Image.Image, Image.Image, Image.Image, Image.Image, dict, dict]:
    sheet = np.asarray(Image.open(SRC / "raw/dice-plates.png").convert("RGB"))
    (ax0, ay0, ax1, ay1), (bx0, by0, bx1, by1) = plate_boxes(sheet)
    d6_plate = Image.fromarray(sheet[ay0:ay1, ax0:ax1]).resize((DIE_SLOT, DIE_SLOT), Image.Resampling.LANCZOS)
    d6_base = np.dstack([grade_walnut(np.asarray(d6_plate)), np.full((DIE_SLOT, DIE_SLOT), 255, np.uint8)])

    # Equilateral triangle, apex up, inscribed in the slot with an 8 px margin.
    side = DIE_SLOT - 16
    tri_h = side * math.sqrt(3) / 2
    top = (DIE_SLOT - tri_h) / 2
    tri = [(DIE_SLOT / 2, top), (DIE_SLOT / 2 + side / 2, top + tri_h), (DIE_SLOT / 2 - side / 2, top + tri_h)]
    d8_plate = Image.fromarray(sheet[by0:by1, bx0:bx1]).resize(
        (side, round(tri_h)), Image.Resampling.LANCZOS
    )
    canvas = Image.new("RGB", (DIE_SLOT, DIE_SLOT), WARM_BLACK)
    canvas.paste(d8_plate, (8, round(top)))
    scale = 4
    tri_mask = Image.new("L", (DIE_SLOT * scale, DIE_SLOT * scale), 0)
    ImageDraw.Draw(tri_mask).polygon([(x * scale, y * scale) for x, y in tri], fill=255)
    tri_alpha = np.asarray(tri_mask.resize((DIE_SLOT, DIE_SLOT), Image.Resampling.LANCZOS))
    d8_base = np.dstack([np.asarray(canvas), tri_alpha])
    centroid = (DIE_SLOT / 2, top + tri_h * 2 / 3)

    font = ImageFont.truetype(str(FONT), 92 * scale)
    d6_page = np.zeros((DIE_SLOT * 2, DIE_SLOT * 4, 4), np.uint8)
    d8_page = np.zeros((DIE_SLOT * 2, DIE_SLOT * 4, 4), np.uint8)
    d6_glow = np.zeros((DIE_SLOT * 2, DIE_SLOT * 4, 4), np.uint8)
    d8_glow = np.zeros((DIE_SLOT * 2, DIE_SLOT * 4, 4), np.uint8)
    d6_glow[..., 3] = 255
    d8_glow[..., 3] = 255
    d6_faces, d8_faces = [], []
    for index, value in enumerate(D6_VALUES):

        def pips(d: ImageDraw.ImageDraw, value: int = value) -> None:
            r = 0.072 * DIE_SLOT * scale
            for u, v in PIPS[value]:
                x, y = u * DIE_SLOT * scale, v * DIE_SLOT * scale
                d.ellipse((x - r, y - r, x + r, y + r), fill=255)

        face, lit = lit_mark(d6_base, pips, scale)
        px, py = (index % 4) * DIE_SLOT, (index // 4) * DIE_SLOT
        d6_page[py : py + DIE_SLOT, px : px + DIE_SLOT] = face
        d6_glow[py : py + DIE_SLOT, px : px + DIE_SLOT] = lit
        d6_faces.append({"index": index, "value": value, **entry("dice-d6", px, py, DIE_SLOT, DIE_SLOT, 1024, 512)})
    for index, value in enumerate(D8_VALUES):

        def numeral(d: ImageDraw.ImageDraw, value: int = value) -> None:
            cx, cy = centroid[0] * scale, centroid[1] * scale
            d.text((cx, cy), str(value), font=font, fill=255, anchor="mm", stroke_width=3 * scale, stroke_fill=255)
            if value == 6:
                y = cy + 46 * scale
                d.rectangle((cx - 20 * scale, y, cx + 20 * scale, y + 7 * scale), fill=255)

        face, lit = lit_mark(d8_base, numeral, scale)
        px, py = (index % 4) * DIE_SLOT, (index // 4) * DIE_SLOT
        d8_page[py : py + DIE_SLOT, px : px + DIE_SLOT] = face
        d8_glow[py : py + DIE_SLOT, px : px + DIE_SLOT] = lit
        d8_faces.append({"index": index, "value": value, **entry("dice-d8", px, py, DIE_SLOT, DIE_SLOT, 1024, 512)})
    triangle = [[round(x / DIE_SLOT, 6), round(y / DIE_SLOT, 6)] for x, y in tri]
    dice = {
        "brass-d6": {"kind": "d6", "shape": "square", "triangle": None, "faces": d6_faces, "glowPage": "dice-d6-glow"},
        "glass-d8": {"kind": "d8", "shape": "triangle", "triangle": triangle, "faces": d8_faces, "glowPage": "dice-d8-glow"},
    }
    sources = {
        "d6PlateRect": {"x": ax0, "y": ay0, "w": ax1 - ax0, "h": ay1 - ay0},
        "d8PlateRect": {"x": bx0, "y": by0, "w": bx1 - bx0, "h": by1 - by0},
    }
    return (
        Image.fromarray(dilate_rgb(d6_page), "RGBA"),
        Image.fromarray(dilate_rgb(d8_page), "RGBA"),
        Image.fromarray(d6_glow, "RGBA"),
        Image.fromarray(d8_glow, "RGBA"),
        dice,
        sources,
    )


# --------------------------------------------------------------------------------------------- glyphs


def build_glyphs() -> tuple[Image.Image, dict]:
    templates = json.loads((SRC / "sigil-strokes.json").read_text())
    scale = 4
    big = GLYPH_SLOT * scale
    margin = 30 * scale
    span = big - 2 * margin
    page = np.zeros((GLYPH_SLOT * 2, GLYPH_SLOT * 4, 4), np.uint8)
    glyphs: dict = {}
    for i, sigil_id in enumerate(SIGIL_IDS):
        strokes = templates[sigil_id]["strokes"]
        paths = [[(margin + p["x"] * span, margin + (1 - p["y"]) * span) for p in s] for s in strokes]

        def draw(width: float, paths: list = paths) -> np.ndarray:
            mask = Image.new("L", (big, big), 0)
            d = ImageDraw.Draw(mask)
            for path in paths:
                d.line(path, fill=255, width=round(width), joint="curve")
                r = width / 2
                for x, y in (path[0], path[-1]):
                    d.ellipse((x - r, y - r, x + r, y + r), fill=255)
            return np.asarray(mask.resize((GLYPH_SLOT, GLYPH_SLOT), Image.Resampling.LANCZOS), np.float64) / 255

        core = draw(9 * scale)
        hot = draw(3.5 * scale)
        wide = draw(16 * scale)
        glow = np.asarray(Image.fromarray(np.uint8(wide * 255)).filter(ImageFilter.GaussianBlur(9)), np.float64) / 255
        alpha = np.clip(core + 0.75 * glow, 0, 1)
        rgb = np.array(AMBER, np.float64)[None, None, :] * (1 - hot[..., None]) + np.array(AMBER_HOT) * hot[..., None]
        tile = np.dstack([np.broadcast_to(rgb, (GLYPH_SLOT, GLYPH_SLOT, 3)), alpha * 255])
        tile = np.clip(np.rint(tile), 0, 255).astype(np.uint8)
        tile[tile[..., 3] < 2] = 0
        px, py = (i % 4) * GLYPH_SLOT, (i // 4) * GLYPH_SLOT
        page[py : py + GLYPH_SLOT, px : px + GLYPH_SLOT] = tile
        glyphs[sigil_id] = entry("glyphs", px, py, GLYPH_SLOT, GLYPH_SLOT, 1024, 512)
    return Image.fromarray(dilate_rgb(page, 40), "RGBA"), glyphs


# -------------------------------------------------------------------------------------------- key art


def build_key_art() -> list[dict]:
    src = Image.open(SRC / "raw/key-art.png").convert("RGB")
    variants = []
    for w, h in ((2048, 1152), (1024, 576)):
        img = ImageOps.fit(src, (w, h), Image.Resampling.LANCZOS, centering=(0.5, 0.5))
        path = OUT / f"title-{w}.jpg"
        img.save(path, format="JPEG", quality=88, optimize=True, progressive=True)
        variants.append({"file": path.name, "width": w, "height": h})
    return variants


# ---------------------------------------------------------------------------------------------- KTX2


def encode_ktx2(ktx: Path, png: Path) -> Path:
    out = png.with_suffix(".ktx2")
    cmd = [
        str(ktx), "create",
        "--format", "R8G8B8A8_SRGB", "--assign-tf", "srgb",
        "--encode", "uastc", "--uastc-quality", "2", "--uastc-rdo",
        "--zstd", "18", "--generate-mipmap",
        "--convert-texcoord-origin", "bottom-left",
        str(png), str(out),
    ]  # fmt: skip
    subprocess.run(cmd, check=True, capture_output=True)
    return out


# -------------------------------------------------------------------------------------- verification


def label_font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONT), size)


def legibility_sheet(icons_page: Image.Image, icons: dict) -> Image.Image:
    """Each icon downscaled from the atlas slot to 24, 32 and 48 px on the warm-black UI panel, unscaled."""
    ids = list(icons)
    sizes = [24, 32, 48]
    col_w = 64
    left = 90
    width = left + col_w * len(ids) + 20
    height = 60 + 70 * len(sizes) + 30 + 18 * 9
    img = Image.new("RGB", (width, height), WARM_BLACK)
    d = ImageDraw.Draw(img)
    d.text((20, 16), "P5-T6 icon legibility: atlas slots downscaled (Lanczos), shown at 1:1 on #231D1A", font=label_font(18), fill=BRASS)
    for r, size in enumerate(sizes):
        y = 60 + r * 70
        d.text((20, y + size // 2 - 9), f"{size} px", font=label_font(16), fill=AMBER)
        for c, icon_id in enumerate(ids):
            px = icons[icon_id]["px"]
            slot = icons_page.crop((px["x"], px["y"], px["x"] + px["w"], px["y"] + px["h"]))
            small = slot.resize((size, size), Image.Resampling.LANCZOS)
            img.paste(small, (left + c * col_w + (col_w - size) // 2, y), small)
    y0 = 60 + 70 * len(sizes) + 10
    for c, icon_id in enumerate(ids):
        col, row = c // 8, c % 8
        d.text((20 + col * 420, y0 + row * 18), f"{c + 1:>2}. {icon_id}", font=label_font(14), fill=BRASS)
    for c in range(len(ids)):
        d.text((left + c * col_w + col_w // 2 - 6, 44), str(c + 1), font=label_font(12), fill=(150, 130, 100))
    return img


def review_sheet(icons_page: Image.Image, d6: Image.Image, d8: Image.Image, glyphs: Image.Image, dice: dict) -> Image.Image:
    w, h = 32 + 512 + 32 + 1024 + 32, 1720
    img = Image.new("RGB", (w, h), WARM_BLACK)
    d = ImageDraw.Draw(img)
    f = label_font(20)
    d.text((32, 12), "Icons (icons.png, 128 px slots)", font=f, fill=BRASS)
    img.paste(icons_page, (32, 44), icons_page)
    x2 = 32 + 512 + 32
    d.text((x2, 12), "Brass d6 faces 0-5 (dice-d6.png); value = index + 1", font=f, fill=BRASS)
    img.paste(d6, (x2, 44), d6)
    d.text((x2, 44 + 512 + 8), "Glass d8 faces 0-7 (dice-d8.png); apex up, value = index + 1", font=f, fill=BRASS)
    img.paste(d8, (x2, 44 + 512 + 40), d8)
    small = label_font(16)
    for face in dice["brass-d6"]["faces"]:
        p = face["px"]
        d.text((x2 + p["x"] + 6, 44 + p["y"] + 4), f"i{face['index']}", font=small, fill=(200, 200, 200))
    for face in dice["glass-d8"]["faces"]:
        p = face["px"]
        d.text((x2 + p["x"] + 6, 44 + 512 + 40 + p["y"] + 4), f"i{face['index']}", font=small, fill=(200, 200, 200))
    y3 = 44 + 512 + 40 + 512 + 16
    d.text((32, y3), "Sigil glyphs (glyphs.png): gear, flame, ward, bolt, spiral", font=f, fill=BRASS)
    gl = glyphs.resize((512, 256), Image.Resampling.LANCZOS)
    img.paste(gl, (32, y3 + 32), gl)
    d.text((x2, y3), "Title key art (title-1024.jpg); dashed box = titleSafe", font=f, fill=BRASS)
    key = Image.open(OUT / "title-1024.jpg").convert("RGB")
    img.paste(key, (x2, y3 + 32))
    s = TITLE_SAFE
    rx0, ry0 = x2 + s["x"] * 1024, y3 + 32 + s["y"] * 576
    rx1, ry1 = rx0 + s["w"] * 1024, ry0 + s["h"] * 576
    for t in range(0, 1024, 16):
        for a, b, c_, e in (
            (rx0 + t, ry0, rx0 + t + 8, ry0),
            (rx0 + t, ry1, rx0 + t + 8, ry1),
        ):
            if a < rx1:
                d.line((a, b, min(c_, rx1), e), fill=AMBER, width=2)
    for t in range(0, 576, 16):
        for a in (rx0, rx1):
            if ry0 + t < ry1:
                d.line((a, ry0 + t, a, min(ry0 + t + 8, ry1)), fill=AMBER, width=2)
    d.text((rx0 + 10, ry0 + 10), "CLOCKWORK SPIRE", font=label_font(26), fill=AMBER)
    return img


# ----------------------------------------------------------------------------------------------- main


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ktx", type=Path, default=DEFAULT_KTX)
    parser.add_argument("--no-ktx", action="store_true")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    DOCS.mkdir(parents=True, exist_ok=True)

    icons_page, icons, crops = build_icons()
    d6_page, d8_page, d6_glow, d8_glow, dice, dice_src = build_dice()
    glyph_page, glyphs = build_glyphs()
    key_variants = build_key_art()

    pages_img = {
        "icons": icons_page,
        "dice-d6": d6_page,
        "dice-d8": d8_page,
        "glyphs": glyph_page,
        "dice-d6-glow": d6_glow,
        "dice-d8-glow": d8_glow,
    }
    ktx_available = not args.no_ktx and args.ktx.exists()
    pages = {}
    for name, image in pages_img.items():
        png = OUT / f"{name}.png"
        save_png(image, png)
        ktx2 = encode_ktx2(args.ktx, png) if ktx_available else None
        pages[name] = {
            "png": png.name,
            "ktx2": ktx2.name if ktx2 else None,
            "width": image.width,
            "height": image.height,
        }

    manifest = {
        "version": 1,
        "uvOrigin": "bottom-left",
        "pages": pages,
        "icons": icons,
        "dice": dice,
        "glyphs": glyphs,
        "keyArt": {"variants": key_variants, "titleSafe": TITLE_SAFE},
    }
    (OUT / "ui-atlas.json").write_text(json.dumps(manifest, indent=2) + "\n")

    save_png(legibility_sheet(icons_page, icons), DOCS / "p5-ui-icons-legibility.png")
    save_png(review_sheet(icons_page, d6_page, d8_page, glyph_page, dice), DOCS / "p5-ui-review.png")

    outputs = sorted(p for p in OUT.iterdir() if p.is_file())
    prov_path = SRC / "provenance.json"
    prov = json.loads(prov_path.read_text())
    prov["derivatives"] = {
        "script": "scripts/assets/build_ui_atlas.py",
        "ktx": str(args.ktx.name) + " 4.4.2" if ktx_available else None,
        "font": {"file": rel(FONT), "sha256": sha256(FONT), "license": "SIL OFL 1.1"},
        "iconCrops": crops,
        "dicePlateRects": dice_src,
        "d6WalnutGrade": {
            "target": "#{:02X}{:02X}{:02X}".format(*WALNUT_TARGET),
            "panelPx": list(WALNUT_PANEL_PX),
            "cornerPx": WALNUT_CORNER_PX,
            "insetPx": WALNUT_INSET_PX,
            "featherPx": WALNUT_FEATHER_PX,
            "lumGate": list(WALNUT_LUM_GATE),
            "lumGain": WALNUT_LUM_GAIN,
            "hueMix": WALNUT_HUE_MIX,
            "method": "linear-light luminance x lumGain, chromaticity moved hueMix toward target, masked to the walnut panel before the pips are composited",
        },
        "diceGlowPages": "dice-d6-glow and dice-d8-glow: saturated amber #{:02X}{:02X}{:02X} times (core + {} x soft glow), black elsewhere; same slots as the colour pages".format(*GLOW_FILL, GLOW_HALO),
        "files": [{"file": rel(p), "bytes": p.stat().st_size, "sha256": sha256(p)} for p in outputs],
    }
    prov_path.write_text(json.dumps(prov, indent=2) + "\n")
    for p in outputs:
        print(f"{p.stat().st_size:>9}  {rel(p)}")


if __name__ == "__main__":
    main()
