"""Builds the P5-T6 UI runtime assets from the immutable sources in assets-source/ui/.

Usage: python3 -I scripts/assets/build_ui_atlas.py [--ktx <path to ktx>] [--no-ktx] [--icons-only]

Deterministic: the same sources produce byte-identical PNG/JPG outputs. Writes
  public/assets/ui/icons.png          16 icons, 128 px slots (112 px medallion + 8 px padding), 512x512
  public/assets/ui/dice-d6.png        brass d6 faces, 256 px slots, 1024x512 (faces 0-5)
  public/assets/ui/dice-d8.png        glass d8 faces, 256 px slots, 1024x512 (faces 0-7)
  public/assets/ui/dice-d6-glow.png   emissive masks for the d6 page: amber pips on black, same slots
  public/assets/ui/dice-d8-glow.png   emissive masks for the d8 page: amber numerals on black, same slots
  (the dice pages are displayed through toneMapped false: their colours are the displayed colours)
  public/assets/ui/glyphs.png         Sigils drawn from src/sigil/templates.ts, 256 px slots, 1024x1024
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

# Dice faces render with toneMapped false (dice-asset.ts, slot `toneMapped`): a face pixel displays as
# its linear radiance, sRGB-encoded and clipped, so the pages carry the displayed colour itself. AgX
# cannot show this amber at this luminance (max S about 0.43 at relL 0.57 for hue 34-38).
# Lit pip and numeral core as displayed: H38, S 0.66, relL 0.57 (art bible candle amber #F3BE65 is
# H38, S 0.58, relL 0.57).
DICE_MARK_TARGET = (0xF8, 0xBC, 0x55)
# d6 pip: displayed linear = target x (D6_PIP_ALBEDO x E + D6_PIP_EMIT x slot emissiveIntensity 1.0).
# The walnut faces' illuminance E measures 1.1 to 1.6 in the engine stills (AgX-inverted walnut over
# the atlas walnut mean), so the pip lands at 0.92 to 1.04 of the target on every lit face. The emit is
# 0.78, not 0.66: the shadow-side pips measured relL 0.40 at 0.66 and 0.446 at 0.75 in the engine
# stills (floor 0.45).
D6_PIP_ALBEDO = 0.24
D6_PIP_EMIT = 0.78
# The lit pip core is 0.95 of the painted pip radius (0.072 slot, 18.4 px), and a warm-black bezel
# runs out to 1.15 (21.2 px): the dark rim at the cup lip. The cup rim (14 px) sits inside the core.
D6_PIP_CORE = 0.95
D6_PIP_BEZEL = 1.15
# Spill outside the bezel, blended in linear light: about 1.3 to 2.2x the walnut at 1.2 to 1.4 pip
# radii (the scored pass-2 spill was #825B39 against walnut relL 0.066). With the brighter walnut,
# 0.3 measured 2.1 to 2.9x and 0.2 measured 1.8 to 2.6x.
D6_GLOW_HALO = 0.15
# Warm-black band where the d6 well's lip and ledge sample the page (build-dice.py D6_LIP_UV_SCALE):
# slot pixels 46..52 and 203..209 around the 53..203 floor window, so the well walls read dark.
D6_WELL_BAND_PX = (74.5, 81.5)
# d8 numeral glow: emissive = target x D8_MARK_EMIT x slot emissiveIntensity 1.0, times opacity 0.97.
# The halo is blended in linear light (not sRGB code values), so the soft glow bleeds visibly past the
# stroke instead of falling to black within 2 screen pixels.
D8_MARK_EMIT = 1.03
D8_GLOW_HALO = 0.5

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
# moved WALNUT_HUE_MIX of the way to the target's (keeps some of the painted streak colour). The gain
# is 2x the AgX-era 1.46: at the faces' env scale 0.3 the engine walnut measured relL 0.031 (top)
# and 0.020 (front) against the bible's #583C26 (relL about 0.05), so the albedo carries the light the
# room probe no longer adds.
WALNUT_LUM_GAIN = 2.92
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
D4_VALUES = [1, 2, 3, 4]
# Outward CCW vertex order for each face opposite vertex 0..3. The atlas corners are
# apex, left, right, matching this order in the runtime geometry.
D4_FACE_VERTICES = ((3, 2, 1), (0, 2, 3), (3, 1, 0), (0, 1, 2))
SIGIL_IDS = ["gear", "flame", "ward", "bolt", "spiral", "anchor", "quench", "gear-plus", "flame-plus", "ward-plus", "bolt-plus", "spiral-plus", "anchor-plus", "quench-plus", "eye", "pendulum-ward", "pendulum-ward-plus"]


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
    ids: list[str] = [*spec["cells"], "status-plating", "status-rust"]
    page_cols = 4
    page_w = page_cols * ICON_SLOT
    page_h = math.ceil(len(ids) / page_cols) * ICON_SLOT
    page = np.zeros((page_h, page_w, 4), dtype=np.uint8)
    icons: dict = {}
    crops: list[dict] = []
    inner = ICON_SLOT - 2 * ICON_PAD
    for i, icon_id in enumerate(ids):
        px, py = (i % page_cols) * ICON_SLOT, (i // page_cols) * ICON_SLOT
        if i >= len(spec["cells"]):
            # Later status marks are drawn into the atlas without changing the source sheet.
            tile = Image.new("RGBA", (inner, inner), (0, 0, 0, 0))
            d = ImageDraw.Draw(tile)
            c = inner // 2
            if icon_id == "status-plating":
                for inset, color in ((30, (238, 207, 126, 255)), (20, (184, 145, 67, 255)), (10, (255, 229, 157, 255))):
                    d.rounded_rectangle((inset, inset, inner - inset, inner - inset), radius=8, outline=color, width=7)
            else:
                d.ellipse((18, 18, inner - 18, inner - 18), fill=(174, 64, 32, 220), outline=(255, 151, 49, 255), width=5)
                for dx, dy in ((-20, -8), (4, -24), (18, 12), (-6, 22)):
                    d.polygon([(c + dx, c + dy), (c + dx + 8, c + dy - 16), (c + dx + 16, c + dy + 5)], fill=(255, 190, 68, 255))
            page[py + ICON_PAD : py + ICON_PAD + inner, px + ICON_PAD : px + ICON_PAD + inner] = np.asarray(tile)
            icons[icon_id] = entry("icons", px, py, ICON_SLOT, ICON_SLOT, page_w, page_h)
            crops.append({"id": icon_id, "sourceRect": None})
            continue
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
        page[py + ICON_PAD : py + ICON_PAD + inner, px + ICON_PAD : px + ICON_PAD + inner] = arr
        icons[icon_id] = entry("icons", px, py, ICON_SLOT, ICON_SLOT, page_w, page_h)
        crops.append({"id": icon_id, "sourceRect": {"x": int(sx0), "y": int(sy0), "w": side, "h": side}})
    atlas = Image.fromarray(dilate_rgb(page), "RGBA")
    # Dilate the new badge in its own cell to retain all historical padding pixels.
    slot = len(ids)
    if slot >= page_cols * (page_h // ICON_SLOT):
        raise ValueError("No existing slot for the Charge badge")
    x, y = (slot % page_cols) * ICON_SLOT, (slot // page_cols) * ICON_SLOT
    tile = Image.new("RGBA", (ICON_SLOT * 3, ICON_SLOT * 3), (0, 0, 0, 0))
    draw = ImageDraw.Draw(tile)
    def px(value: int) -> int:
        return (ICON_PAD + value) * 3
    draw.ellipse(tuple(px(v) for v in (15, 15, inner - 15, inner - 15)), fill=(29, 76, 107, 250),
                 outline=(95, 211, 248, 255), width=15)
    draw.polygon([(px(x), px(y)) for x, y in [(58, 23), (35, 61), (53, 61), (47, 88),
                 (78, 48), (58, 48), (66, 23)]], fill=(207, 246, 255, 255))
    tile = tile.resize((ICON_SLOT, ICON_SLOT), Image.Resampling.LANCZOS)
    atlas.paste(Image.fromarray(dilate_rgb(np.asarray(tile)), "RGBA"), (x, y))
    icons["status-charge"] = entry("icons", x, y, ICON_SLOT, ICON_SLOT, page_w, page_h)
    crops.append({"id": "status-charge", "sourceRect": None})
    return atlas, icons, crops


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


def lit_mark(
    base: np.ndarray,
    draw_fn,
    scale: int,
    glow_fill: tuple[int, int, int] = GLOW_FILL,
    halo: float = GLOW_HALO,
    linear_halo: bool = False,
) -> tuple[np.ndarray, np.ndarray]:
    """Composites an amber glowing mark (pip or numeral) drawn by `draw_fn` at `scale`x onto `base`.

    Also returns the face's emissive glow tile: `glow_fill` over the mark core plus `halo` of its soft
    glow, black elsewhere, alpha 255. With `linear_halo` the coverage scales the fill in linear light,
    so the decoded emission is proportional to it.
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
    emit = np.clip(core_small + halo * glow, 0, 1)
    lit = np.full((h, w, 4), 255, np.uint8)
    if linear_halo:
        fill = linear_to_srgb(srgb_to_linear(np.array(glow_fill, np.float64)) * emit[..., None])
    else:
        fill = np.array(glow_fill, np.float64) * emit[..., None]
    lit[..., :3] = np.clip(np.rint(fill), 0, 255).astype(np.uint8)
    return res, lit


def scaled_srgb(rgb: tuple[int, int, int], k: float) -> tuple[int, int, int]:
    """`rgb` scaled by `k` in linear light, as 8-bit sRGB."""
    out = linear_to_srgb(srgb_to_linear(np.array(rgb, np.float64)) * k)
    r, g, b = (int(v) for v in np.clip(np.rint(out), 0, 255))
    return r, g, b


def disc_coverage(size: int, centres: list[tuple[float, float]], radius: float, scale: int) -> np.ndarray:
    """Anti-aliased coverage of discs (slot pixels, origin top-left) drawn at `scale`x, 0..1."""
    big = Image.new("L", (size * scale, size * scale), 0)
    d = ImageDraw.Draw(big)
    r = radius * scale
    for x, y in centres:
        d.ellipse((x * scale - r, y * scale - r, x * scale + r, y * scale + r), fill=255)
    return np.asarray(big.resize((size, size), Image.Resampling.LANCZOS), dtype=np.float64) / 255


def blur(mask: np.ndarray, radius: float) -> np.ndarray:
    return np.asarray(Image.fromarray(np.uint8(np.rint(mask * 255))).filter(ImageFilter.GaussianBlur(radius)), dtype=np.float64) / 255


def lit_pips(base: np.ndarray, value: int, scale: int) -> tuple[np.ndarray, np.ndarray]:
    """d6 face `value`: a warm-black well band, then per pip an amber core (D6_PIP_CORE of the painted
    radius) inside a warm-black bezel ring (to D6_PIP_BEZEL), on the colour page; on the glow page the
    core emits D6_PIP_EMIT of the target and the soft spill emits outside the bezel only."""
    size = base.shape[0]
    centres = [(u * size, v * size) for u, v in PIPS[value]]
    r = 0.072 * size
    core = disc_coverage(size, centres, r * D6_PIP_CORE, scale)
    ring_disc = disc_coverage(size, centres, r * D6_PIP_BEZEL, scale)
    ring = np.clip(ring_disc - core, 0, 1)
    shadow = blur(ring_disc, 3)
    glow = blur(ring_disc, 7)
    outside = 1 - ring_disc

    c = (size - 1) / 2
    yy, xx = np.mgrid[0:size, 0:size]
    cheb = np.maximum(np.abs(xx - c), np.abs(yy - c))
    lo, hi = D6_WELL_BAND_PX
    band = np.clip(cheb - lo, 0, 1) * np.clip(hi + 1 - cheb, 0, 1)

    out = base[..., :3].astype(np.float64)
    out = out * (1 - band[..., None]) + np.array(WARM_BLACK) * band[..., None]
    out *= 1 - 0.55 * shadow[..., None]
    out += np.array(AMBER) * 0.5 * (glow * outside)[..., None]
    out = out * (1 - ring[..., None]) + np.array(WARM_BLACK) * ring[..., None]
    albedo = np.array(scaled_srgb(DICE_MARK_TARGET, D6_PIP_ALBEDO), np.float64)
    out = out * (1 - core[..., None]) + albedo * core[..., None]
    # The 6-face's outer rows reach past the floor window; the lip samples there, so the band wins.
    out = out * (1 - band[..., None]) + np.array(WARM_BLACK) * band[..., None]
    core = core * (1 - band)
    res = base.copy()
    res[..., :3] = np.clip(np.rint(out), 0, 255).astype(np.uint8)

    emit = np.clip(core + D6_GLOW_HALO * glow * outside * (1 - band), 0, 1)
    lit = np.full(base.shape[:2] + (4,), 255, np.uint8)
    fill = srgb_to_linear(np.array(scaled_srgb(DICE_MARK_TARGET, D6_PIP_EMIT), np.float64))
    lit[..., :3] = np.clip(np.rint(linear_to_srgb(fill * emit[..., None])), 0, 255).astype(np.uint8)
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


def build_dice() -> tuple[Image.Image, Image.Image, Image.Image, Image.Image, Image.Image, Image.Image, dict, dict]:
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
    d4_page = np.zeros((DIE_SLOT * 2, DIE_SLOT * 4, 4), np.uint8)
    d6_glow = np.zeros((DIE_SLOT * 2, DIE_SLOT * 4, 4), np.uint8)
    d8_glow = np.zeros((DIE_SLOT * 2, DIE_SLOT * 4, 4), np.uint8)
    d4_glow = np.zeros((DIE_SLOT * 2, DIE_SLOT * 4, 4), np.uint8)
    d6_glow[..., 3] = 255
    d8_glow[..., 3] = 255
    d6_faces, d8_faces, d4_faces = [], [], []
    for index, value in enumerate(D6_VALUES):
        face, lit = lit_pips(d6_base, value, scale)
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

        face, lit = lit_mark(
            d8_base, numeral, scale, scaled_srgb(DICE_MARK_TARGET, D8_MARK_EMIT), D8_GLOW_HALO, linear_halo=True
        )
        px, py = (index % 4) * DIE_SLOT, (index // 4) * DIE_SLOT
        d8_page[py : py + DIE_SLOT, px : px + DIE_SLOT] = face
        d8_glow[py : py + DIE_SLOT, px : px + DIE_SLOT] = lit
        d8_faces.append({"index": index, "value": value, **entry("dice-d8", px, py, DIE_SLOT, DIE_SLOT, 1024, 512)})
    yy, xx = np.mgrid[:DIE_SLOT, :DIE_SLOT]
    edge_distance = np.minimum.reduce([
        np.abs((x1 - x0) * (yy - y0) - (y1 - y0) * (xx - x0)) / math.hypot(x1 - x0, y1 - y0)
        for (x0, y0), (x1, y1) in zip(tri, (*tri[1:], tri[0]))
    ])
    brush = 3 * np.sin(0.81 * yy + 0.012 * xx) + 2 * np.sin(2.12 * yy - 0.008 * xx)
    bevel = np.select([edge_distance < 4, edge_distance < 8, edge_distance < 12], [46, -30, 20], 0)
    steel = np.array([96, 106, 116]) + (brush + bevel)[..., None]
    d4_base = np.dstack([steel.astype(np.uint8), tri_alpha])
    corner_font = ImageFont.truetype(str(FONT), 47 * scale)
    for index, value in enumerate(D4_VALUES):
        corner_values = tuple(vertex + 1 for vertex in D4_FACE_VERTICES[index])

        def numeral(d: ImageDraw.ImageDraw, corner_values: tuple[int, int, int] = corner_values) -> None:
            # Each numeral faces its vertex, so the result reads upright on all three adjacent faces.
            for (vx, vy), label, angle in zip((tri[0], tri[2], tri[1]), corner_values, (0, 120, -120)):
                cx = DIE_SLOT / 2 + 0.53 * (vx - DIE_SLOT / 2)
                cy = (top + 2 * tri_h / 3) + 0.53 * (vy - (top + 2 * tri_h / 3))
                side = 72 * scale
                glyph = Image.new("L", (side, side))
                ImageDraw.Draw(glyph).text((side / 2, side / 2), str(label), font=corner_font,
                                          fill=255, anchor="mm", stroke_width=scale, stroke_fill=255)
                imprint = glyph.rotate(angle, resample=Image.Resampling.BICUBIC)
                d.bitmap((round(cx * scale - side / 2), round(cy * scale - side / 2)), imprint, fill=255)
        face, lit = lit_mark(d4_base, numeral, scale, scaled_srgb(DICE_MARK_TARGET, 0.68), 0.045, linear_halo=True)
        px, py = (index % 4) * DIE_SLOT, (index // 4) * DIE_SLOT
        d4_page[py : py + DIE_SLOT, px : px + DIE_SLOT] = face
        d4_glow[py : py + DIE_SLOT, px : px + DIE_SLOT] = lit
        d4_faces.append({"index": index, "value": value, "corners": list(corner_values), **entry("dice-d4", px, py, DIE_SLOT, DIE_SLOT, 1024, 512)})
    triangle = [[round(x / DIE_SLOT, 6), round(y / DIE_SLOT, 6)] for x, y in tri]
    dice = {
        "brass-d6": {"kind": "d6", "shape": "square", "triangle": None, "faces": d6_faces, "glowPage": "dice-d6-glow"},
        "glass-d8": {"kind": "d8", "shape": "triangle", "triangle": triangle, "faces": d8_faces, "glowPage": "dice-d8-glow"},
        "iron-d4": {"kind": "d4", "shape": "triangle", "triangle": triangle, "faces": d4_faces, "glowPage": "dice-d4-glow"},
    }
    sources = {
        "d6PlateRect": {"x": ax0, "y": ay0, "w": ax1 - ax0, "h": ay1 - ay0},
        "d8PlateRect": {"x": bx0, "y": by0, "w": bx1 - bx0, "h": by1 - by0},
    }
    return (
        Image.fromarray(dilate_rgb(d6_page), "RGBA"),
        Image.fromarray(dilate_rgb(d8_page), "RGBA"),
        Image.fromarray(dilate_rgb(d4_page), "RGBA"),
        Image.fromarray(d6_glow, "RGBA"),
        Image.fromarray(d8_glow, "RGBA"),
        Image.fromarray(d4_glow, "RGBA"),
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
    page = np.zeros((GLYPH_SLOT * math.ceil(len(SIGIL_IDS) / 4), GLYPH_SLOT * 4, 4), np.uint8)
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
        glyphs[sigil_id] = entry("glyphs", px, py, GLYPH_SLOT, GLYPH_SLOT, GLYPH_SLOT * 4, page.shape[0])
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
    d.text((32, y3), f"Sigil glyphs (glyphs.png): {', '.join(SIGIL_IDS)}", font=f, fill=BRASS)
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


def write_icons_only(ktx: Path, no_ktx: bool, page: Image.Image, icons: dict, crops: list[dict]) -> None:
    manifest_path = OUT / "ui-atlas.json"
    manifest = json.loads(manifest_path.read_text())
    before = manifest["pages"]["icons"]
    if page.size != (before["width"], before["height"]):
        raise ValueError("Icon-only rebuild must preserve the page size")
    if any(icons.get(key) != region for key, region in manifest["icons"].items()):
        raise ValueError("Icon-only rebuild must preserve existing icon rects")
    png = OUT / before["png"]
    save_png(page, png)
    packed = encode_ktx2(ktx, png) if not no_ktx else None
    if not no_ktx and (not packed or packed.name != before["ktx2"]):
        raise ValueError("Icon-only rebuild must preserve the compressed page path")
    if no_ktx:
        before["ktx2"] = None
    manifest["icons"] = icons
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

    prov_path = SRC / "provenance.json"
    prov = json.loads(prov_path.read_text())
    prov["procedural"]["chargeIcon"] = "Original lightning medallion drawn by scripts/assets/build_ui_atlas.py."
    prov["derivatives"]["iconCrops"] = crops
    changed = {path for path in (png, packed, manifest_path) if path}
    prov["derivatives"]["files"] = [
        {"file": rel(path), "bytes": path.stat().st_size, "sha256": sha256(path)}
        if (path := ROOT / item["file"]) in changed else item
        for item in prov["derivatives"]["files"]
    ]
    prov_path.write_text(json.dumps(prov, indent=2) + "\n")


def write_glyph_only(glyph: str, ktx: Path, no_ktx: bool) -> None:
    manifest_path = OUT / "ui-atlas.json"
    manifest = json.loads(manifest_path.read_text())
    page = manifest["pages"]["glyphs"]
    rendered, glyphs = build_glyphs()
    if rendered.size != (page["width"], page["height"]):
        raise ValueError("Glyph rebuild must preserve the page size")
    if any(glyphs[key] != region for key, region in manifest["glyphs"].items()):
        raise ValueError("Glyph rebuild must preserve existing glyph rects")
    png = OUT / page["png"]
    image = Image.open(png).convert("RGBA")
    slot = glyphs[glyph]["px"]
    x, y, w, h = (slot[key] for key in ("x", "y", "w", "h"))
    image.paste(rendered.crop((x, y, x + w, y + h)), (x, y))
    save_png(image, png)
    packed = encode_ktx2(ktx, png) if not no_ktx else None
    page["ktx2"] = packed.name if packed else None
    manifest["glyphs"][glyph] = glyphs[glyph]
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

    prov_path = SRC / "provenance.json"
    prov = json.loads(prov_path.read_text())
    files = {item["file"]: item for item in prov["derivatives"]["files"]}
    for path in (png, packed, manifest_path):
        if path:
            files[rel(path)] = {"file": rel(path), "bytes": path.stat().st_size, "sha256": sha256(path)}
    prov["derivatives"]["files"] = list(files.values())
    prov_path.write_text(json.dumps(prov, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ktx", type=Path, default=DEFAULT_KTX)
    parser.add_argument("--no-ktx", action="store_true")
    targets = parser.add_mutually_exclusive_group()
    targets.add_argument("--icons-only", action="store_true")
    targets.add_argument("--glyph-only", choices=SIGIL_IDS)
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    DOCS.mkdir(parents=True, exist_ok=True)

    if args.glyph_only:
        write_glyph_only(args.glyph_only, args.ktx, args.no_ktx)
        return
    icons_page, icons, crops = build_icons()
    if args.icons_only:
        write_icons_only(args.ktx, args.no_ktx, icons_page, icons, crops)
        return
    d6_page, d8_page, d4_page, d6_glow, d8_glow, d4_glow, dice, dice_src = build_dice()
    glyph_page, glyphs = build_glyphs()
    key_variants = build_key_art()

    pages_img = {
        "icons": icons_page,
        "dice-d6": d6_page,
        "dice-d8": d8_page,
        "dice-d4": d4_page,
        "glyphs": glyph_page,
        "dice-d6-glow": d6_glow,
        "dice-d8-glow": d8_glow,
        "dice-d4-glow": d4_glow,
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
    prov["procedural"]["chargeIcon"] = "Original lightning medallion drawn by scripts/assets/build_ui_atlas.py."
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
        "diceGlowPages": (
            "displayed through toneMapped false: dice-d6-glow pips #{:02X}{:02X}{:02X} times (core + {} x soft glow outside the "
            "bezel, linear light), dice-d8-glow numerals #{:02X}{:02X}{:02X} times (core + {} x soft glow, linear light); black elsewhere; "
            "same slots as the colour pages. d6 colour page: amber pip core #{:02X}{:02X}{:02X} ({} of the pip radius), "
            "warm-black bezel to {}, warm-black well band at slot px {}"
        ).format(
            *scaled_srgb(DICE_MARK_TARGET, D6_PIP_EMIT), D6_GLOW_HALO, *scaled_srgb(DICE_MARK_TARGET, D8_MARK_EMIT), D8_GLOW_HALO,
            *scaled_srgb(DICE_MARK_TARGET, D6_PIP_ALBEDO), D6_PIP_CORE, D6_PIP_BEZEL, list(D6_WELL_BAND_PX),
        ),
        "files": [{"file": rel(p), "bytes": p.stat().st_size, "sha256": sha256(p)} for p in outputs],
    }
    prov_path.write_text(json.dumps(prov, indent=2) + "\n")
    for p in outputs:
        print(f"{p.stat().st_size:>9}  {rel(p)}")


if __name__ == "__main__":
    main()
