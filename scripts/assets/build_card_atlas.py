"""Packs the P5-T5 card illustration layers and card frames into KTX2 atlas pages with a JSON index.

Usage: python3 -I scripts/assets/build_card_atlas.py [--ktx <path to ktx>] [--skip-ktx]

Inputs (immutable sources, see assets-source/cards/README.md):
  assets-source/cards/<card-id>/<card-id>-back.png, -mid.cutout.png, -front.cutout.png
  assets-source/cards/attack-strike/ for `strike` (the P4 portal-card proof art, reused)
  assets-source/cards/frames/<type>/frame-<type>-<pick>.png, picks in assets-source/cards/selection.json

Outputs in public/assets/cards/atlas/:
  card-atlas-0..2.png/.ktx2  2048x2048, five cards each as back, mid and front 512 px cells
  card-atlas-3.png/.ktx2     2048x2048, frames above the final three Wave A card illustrations
  card-atlas.json            card id and frame type -> page, pixel rect and UV rect

Every cell's content is inset from its cell edge and the edge pixels are extruded into the gutter,
so generated mips do not bleed between neighbours. Colour under fully transparent pixels is filled
from the nearest opaque colour, so filtering never pulls in the green or magenta key. The build is
deterministic: two runs give byte-identical PNG and KTX2 files.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "assets-source/cards"
OUT = ROOT / "public/assets/cards/atlas"
DEFAULT_KTX = Path.home() / ".local/opt/ktx-software-4.4.2/bin/ktx"

# CARDS order from src/content/cards.ts (base ids). tests/card-atlas.test.ts checks the coverage.
CARD_IDS: list[tuple[str, str]] = [
    ("strike", "attack"),
    ("cog-toss", "attack"),
    ("ratchet-flurry", "attack"),
    ("rivet-volley", "attack"),
    ("escapement-hammer", "attack"),
    ("defend", "skill"),
    ("lucky-rivets", "skill"),
    ("release-valve", "skill"),
    ("overwind", "skill"),
    ("spanner-jam", "skill"),
    ("cogstorm", "sigil"),
    ("furnace-brand", "sigil"),
    ("warding-glyph", "sigil"),
    ("arc-bolt", "sigil"),
    ("time-spiral", "sigil"),
]
FRAME_TYPES = ["attack", "skill", "sigil", "mechanism"]
LAYERS = ["back", "mid", "front"]
KEY_HUE = {"attack": "green", "skill": "green", "sigil": "magenta"}
GLOW = {"attack": "#ff6a2a", "skill": "#5a8cff", "sigil": "#3fe08a"}

PAGE = 2048
CELL = 512
CELL_INSET = 16  # content 480 px, extruded 16 px gutter: clean mips down to a 32 px cell
CARDS_PER_PAGE = 5

FRAME_W, FRAME_H = 672, 1016  # output frame size; 3 frames in a 2048x1024 page
FRAME_CELL_W, FRAME_CELL_H = 680, 1024
FRAME_INSET = 4
FRAME_CORNER = 24  # rounded card outline radius, output px
# The picked attack frame (1696x2528) has its card outline at x 44..1640 and y 30..2470. The crop
# keeps the card's full width (2 px inside the outline) at the output aspect, centred vertically.
ATTACK_CROP = (46.0, 47.0, 1592.0)  # left, top, width in source px
WINDOW_MARGIN = 2.0  # output px the alpha hole extends past the painted window, eating its green rim

# Measured on the built attack frame (output px). Runtime text goes here; the frames carry no text.
TEXT_REGIONS = {
    "cost": {"centre": [66, 70], "radius": 40, "note": "upper-left gem medallion"},
    "name": {"rect": [88, 722, 496, 60], "note": "top band of the parchment panel"},
    "description": {"rect": [88, 786, 496, 196], "note": "rest of the parchment panel"},
}

# Layer stack for createHoloCard, matching src/cards/card-proof.ts. Depth in metres, size and
# offset in window diameters.
LAYER_DEFAULTS = {
    "back": {"depth": 0.03, "size": 2.6, "opaque": True},
    "mid": {"depth": 0.016, "size": 0.95},
    "glow": {"depth": 0.007, "size": 0.7, "additive": True},
    "front": {"depth": 0.005, "size": 1.05},
}
# Feathered ellipse (centre x, centre y, radius x, radius y; 0..1 of the layer) kept from a cutout
# whose generation still painted scenery around the subject after the regeneration round.
LAYER_MASKS: dict[str, tuple[float, float, float, float]] = {
    "furnace-brand-front": (0.5, 0.55, 0.22, 0.36),
    "release-valve-front": (0.52, 0.68, 0.26, 0.34),
}
STRIKE_OVERRIDES ={"front": {"offset": [0.04, -0.02]}, "glow": {"offset": [0.27, 0.24]}}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def layer_source(card: str, layer: str) -> Path:
    if card == "strike":
        name = {"back": "back.png", "mid": "mid.cutout.png", "front": "front.cutout.png"}[layer]
        return SRC / "attack-strike" / f"attack-strike-{name}"
    # A layer pick in selection.json is a suffix ("-r1") or, when it names another file, a full stem.
    pick = json.loads((SRC / "selection.json").read_text()).get("layers", {}).get(f"{card}-{layer}", "")
    stem = f"{card}-{layer}{pick}" if pick == "" or pick.startswith("-") else pick
    suffix = "" if layer == "back" else ".cutout"
    return SRC / card / f"{stem}{suffix}.png"


def despill_fringe(rgba: np.ndarray, key: str) -> np.ndarray:
    """Removes key-colour spill from semi-transparent edge pixels only; opaque art is untouched."""
    out = rgba.astype(np.float32)
    a = out[..., 3]
    edge = (a > 0) & (a < 255)
    r, g, b = out[..., 0], out[..., 1], out[..., 2]
    if key == "green":
        out[..., 1] = np.where(edge, np.minimum(g, np.maximum(r, b)), g)
    else:
        excess = np.where(edge, np.maximum(np.minimum(r, b) - g, 0), 0)
        out[..., 0] = r - excess
        out[..., 2] = b - excess
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)


def bleed(rgba: np.ndarray, passes: int = 24) -> np.ndarray:
    """Fills RGB under alpha 0 from neighbouring visible colour, then with the visible mean."""
    rgb = rgba[..., :3].astype(np.float32)
    known = rgba[..., 3] > 0
    if not known.any():
        return rgba
    for _ in range(passes):
        if known.all():
            break
        acc = np.zeros_like(rgb)
        cnt = np.zeros(known.shape, np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                k = np.roll(np.roll(known, dy, 0), dx, 1)
                acc += np.roll(np.roll(rgb, dy, 0), dx, 1) * k[..., None]
                cnt += k
        fill = (~known) & (cnt > 0)
        rgb[fill] = acc[fill] / cnt[fill][:, None]
        known = known | fill
    rgb[~known] = rgb[known].mean(axis=0)
    out = rgba.copy()
    out[..., :3] = np.clip(np.rint(rgb), 0, 255).astype(np.uint8)
    return out


def extrude(content: np.ndarray, pad_x: int, pad_y: int) -> np.ndarray:
    return np.pad(content, ((pad_y, pad_y), (pad_x, pad_x), (0, 0)), mode="edge")


def resize_rgba(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    # Premultiplied resampling, so transparent pixels' colour cannot leak into edges.
    return img.convert("RGBa").resize(size, Image.Resampling.LANCZOS).convert("RGBA")


def key_matte(card: str, layer: str, key: str, size: tuple[int, int]) -> np.ndarray:
    """Alpha 0..1 from the untouched keyed layer. image_background_remover keeps enclosed key-colour
    regions (the inside of rings and glyphs) opaque, so its alpha is capped by this chroma matte."""
    src = layer_source(card, layer)
    raw = src.with_name(src.name.replace(".cutout", ""))
    rgb = np.asarray(Image.open(raw).convert("RGB").resize(size, Image.Resampling.BILINEAR)).astype(np.float32)
    return chroma_matte(rgb, key)


def chroma_matte(rgb: np.ndarray, key: str) -> np.ndarray:
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    keyness = g - np.maximum(r, b) if key == "green" else np.minimum(r, b) - g
    return np.clip((120.0 - keyness) / 80.0, 0.0, 1.0)


def despill(rgba: np.ndarray, key: str) -> np.ndarray:
    """Whole-image key despill (as the P4 strike layers). Green-key layers hold no green art and
    magenta-key layers no purple art, so only spill moves."""
    out = rgba.astype(np.float32)
    r, g, b = out[..., 0], out[..., 1], out[..., 2]
    if key == "green":
        out[..., 1] = np.minimum(g, np.maximum(r, b))
    else:
        excess = np.maximum(np.minimum(r, b) - g, 0)
        out[..., 0] = r - excess
        out[..., 2] = b - excess
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)


def ellipse_mask(size: tuple[int, int], spec: tuple[float, float, float, float]) -> np.ndarray:
    cx, cy, rx, ry = spec
    w, h = size
    yy, xx = np.mgrid[0:h, 0:w]
    d = np.hypot((xx + 0.5) / w - cx, ((yy + 0.5) / h - cy) * rx / ry) / rx
    return np.clip((1.0 - d) / 0.12, 0.0, 1.0)


def layer_cell(card: str, ctype: str, layer: str) -> np.ndarray:
    content = CELL - 2 * CELL_INSET
    img = Image.open(layer_source(card, layer))
    if layer == "back":
        rgb = img.convert("RGB").resize((content, content), Image.Resampling.LANCZOS)
        arr = np.dstack([np.asarray(rgb), np.full((content, content), 255, np.uint8)])
    else:
        rgba = np.asarray(img.convert("RGBA")).copy()
        if card != "strike":
            matte = key_matte(card, layer, KEY_HUE[ctype], img.size)
            mask = LAYER_MASKS.get(f"{card}-{layer}")
            if mask is not None:
                matte = matte * ellipse_mask(img.size, mask)
            rgba[..., 3] = np.rint(rgba[..., 3] * matte).astype(np.uint8)
            rgba = despill(rgba, KEY_HUE[ctype])
        rgba = despill_fringe(rgba, KEY_HUE[ctype])
        arr = np.asarray(resize_rgba(Image.fromarray(rgba, "RGBA"), (content, content)))
        arr = bleed(arr)
    return extrude(arr, CELL_INSET, CELL_INSET)


def green_disc(rgb: np.ndarray) -> tuple[float, float, float]:
    r, g, b = (rgb[..., i].astype(np.int32) for i in range(3))
    mask = (g > 200) & (r < 90) & (b < 90)
    ys, xs = np.nonzero(mask)
    cx, cy, rad = float(xs.mean()), float(ys.mean()), float(np.sqrt(mask.sum() / np.pi))
    # Emerald enamel highlights can pass the key test; keep only pixels near the first estimate.
    for _ in range(3):
        near = np.hypot(xs - cx, ys - cy) < rad * 1.05
        cx, cy = float(xs[near].mean()), float(ys[near].mean())
        rad = float(np.sqrt(near.sum() / np.pi))
    return cx, cy, rad


def frame_source(ftype: str) -> Path:
    pick = json.loads((SRC / "selection.json").read_text())["frames"][ftype]
    return SRC / "frames" / ftype / f"frame-{ftype}-{pick}.png"


def normalized_frame(ftype: str) -> Image.Image:
    """Read a source frame, falling back to the checked-in normalized atlas frame."""
    source = frame_source(ftype)
    if source.is_file():
        return Image.open(source).convert("RGB")
    rect = {"attack": (4, 4), "skill": (688, 4), "sigil": (1372, 4)}[ftype]
    with Image.open(OUT / "card-atlas-3.png") as atlas:
        x, y = rect
        return atlas.convert("RGB").crop((x, y, x + FRAME_W, y + FRAME_H))


def attack_window() -> tuple[float, float, float]:
    """The shared window (centre x, centre y, radius) in output px, from the attack frame."""
    source = frame_source("attack")
    if not source.is_file():
        manifest = json.loads((OUT / "card-atlas.json").read_text())
        frame = manifest["frames"]["attack"]
        return (
            frame["window"]["u"] * FRAME_W,
            frame["window"]["v"] * FRAME_H,
            frame["window"]["radius"] * FRAME_W - WINDOW_MARGIN,
        )
    image = normalized_frame("attack")
    cx, cy, r = green_disc(np.asarray(image))
    if image.size == (FRAME_W, FRAME_H):
        return cx, cy, r
    left, top, width = ATTACK_CROP
    s = FRAME_W / width
    return (cx - left) * s, (cy - top) * s, r * s


def frame_cell(ftype: str, window: tuple[float, float, float]) -> tuple[np.ndarray, dict]:
    if ftype == "mechanism":
        source = np.asarray(normalized_frame("skill"), dtype=np.uint8)
        hsv = np.asarray(Image.fromarray(source, "RGB").convert("HSV")).copy()
        hsv[..., 0] = (hsv[..., 0].astype(np.uint16) + 13) % 256
        hsv[..., 1] = np.clip(hsv[..., 1].astype(np.int16) + 10, 0, 255).astype(np.uint8)
        hsv[..., 2] = np.clip(hsv[..., 2].astype(np.int16) - 5, 0, 255).astype(np.uint8)
        derived = np.asarray(Image.fromarray(hsv, "HSV").convert("RGB")).copy()
        # The parchment panel remains the shared runtime text surface.
        derived[760:, 70:610] = source[760:, 70:610]
        derived_image = Image.fromarray(derived, "RGB")
        accent = ImageDraw.Draw(derived_image)
        for x, y in ((44, 82), (628, 82), (44, 930), (628, 930)):
            accent.ellipse((x - 18, y - 18, x + 18, y + 18), fill=(194, 139, 63), outline=(54, 37, 27), width=7)
        accent.arc((48, 48, 180, 180), 205, 325, fill=(214, 164, 79), width=9)
        accent.arc((492, 48, 624, 180), 215, 335, fill=(214, 164, 79), width=9)
        src = derived_image
    else:
        src = normalized_frame(ftype)
    # Measure the shared key window before Mechanism's palette treatment changes its chroma.
    if ftype == "mechanism":
        cx, cy, r = window
    else:
        cx, cy, r = green_disc(np.asarray(normalized_frame(ftype)))
    wx, wy, wr = window
    s = r / wr  # source px per output px; aligns this frame's window onto the shared window
    affine = (s, 0.0, cx - wx * s, 0.0, s, cy - wy * s)
    out = src.transform((FRAME_W, FRAME_H), Image.Transform.AFFINE, affine, Image.Resampling.BICUBIC)
    rgb = np.asarray(out).astype(np.float32)

    hole = wr + WINDOW_MARGIN
    yy, xx = np.mgrid[0:FRAME_H, 0:FRAME_W]
    dist = np.hypot(xx + 0.5 - wx, yy + 0.5 - wy)
    rim = (dist >= hole) & (dist < hole + 8)
    rgb[..., 1] = np.where(rim, np.minimum(rgb[..., 1], np.maximum(rgb[..., 0], rgb[..., 2])), rgb[..., 1])
    r_, g_, b_ = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    # Flat key green left in the rim band after the hole cut (emerald enamel further out is art).
    key_left = int(((g_ > 200) & (r_ < 90) & (b_ < 90) & (dist >= hole) & (dist < hole + 16)).sum())

    ss = 4  # supersampled card outline minus window
    mask = Image.new("L", (FRAME_W * ss, FRAME_H * ss), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, FRAME_W * ss - 1, FRAME_H * ss - 1), FRAME_CORNER * ss, fill=255)
    draw.ellipse(((wx - hole) * ss, (wy - hole) * ss, (wx + hole) * ss, (wy + hole) * ss), fill=0)
    alpha = np.asarray(mask.resize((FRAME_W, FRAME_H), Image.Resampling.BOX))
    rgba = np.dstack([np.clip(np.rint(rgb), 0, 255).astype(np.uint8), alpha])
    rgba = bleed(rgba)
    info = {"sourceWindow": [round(cx, 2), round(cy, 2), round(r, 2)], "keyPixelsOutsideHole": key_left}
    return extrude(rgba, FRAME_INSET, FRAME_INSET), info


def uv(x: int, y: int, w: int, h: int, pw: int, ph: int) -> list[float]:
    """[u0, v0, u1, v1] with v from the bottom (three.js flipY PNGs and bottom-left KTX2 agree)."""
    return [round(x / pw, 6), round(1 - (y + h) / ph, 6), round((x + w) / pw, 6), round(1 - y / ph, 6)]


def save_png(arr: np.ndarray, path: Path) -> None:
    Image.fromarray(arr, "RGBA").save(path, format="PNG", compress_level=6)


def encode_ktx2(ktx: Path, png: Path) -> Path:
    out = png.with_suffix(".ktx2")
    cmd = [
        str(ktx), "create",
        "--format", "R8G8B8A8_SRGB", "--assign-tf", "srgb",
        "--encode", "uastc", "--uastc-quality", "2", "--uastc-rdo",
        "--zstd", "18", "--generate-mipmap",
        # three.js flips PNGs on upload but cannot flip compressed data (materials README).
        "--convert-texcoord-origin", "bottom-left",
        "--threads", "1",
    ]
    subprocess.run([*cmd, str(png), str(out)], check=True)
    return out


def dumps(value: object, indent: int = 0) -> str:
    """JSON with objects expanded and scalar arrays on one line, the shape Biome keeps."""
    pad = "  " * indent
    if isinstance(value, dict):
        if not value:
            return "{}"
        items = [f'{pad}  {json.dumps(k)}: {dumps(v, indent + 1)}' for k, v in value.items()]
        return "{\n" + ",\n".join(items) + f"\n{pad}}}"
    if isinstance(value, list) and any(isinstance(v, (dict, list)) for v in value):
        items = [f"{pad}  {dumps(v, indent + 1)}" for v in value]
        return "[\n" + ",\n".join(items) + f"\n{pad}]"
    if isinstance(value, list):
        return "[" + ", ".join(json.dumps(v) for v in value) + "]"
    return json.dumps(value, ensure_ascii=False)


# Foundry subjects share a page with three pairs of background layers from the existing atlas.
FOUNDRY_ART = [
    ("rivet-plate", "skill", "guards", 0), ("brass-bulwark", "skill", "guards", 1),
    ("rust-spray", "skill", "guards", 2), ("shear-pin", "attack", "guards", 3),
    ("iron-knuckle", "attack", "strikes", 0), ("counterstroke", "attack", "strikes", 1),
    ("anchor-glyph", "sigil", "strikes", 2), ("quench-seal", "sigil", "strikes", 3),
]

DUNGEON_ART = [
    ("torque-wrench", "attack", "dungeon", 0),
    ("counterweight", "skill", "dungeon", 1),
    ("tension-coil", "skill", "dungeon", 2),
]

REPAIR_WAVE_ART = [
    ("spare-parts", "skill", "defend", 0),
    ("flywheel-swing", "attack", "strike", 1),
    ("patch-kit", "skill", "rivet-plate", 2),
]

CHARGE_WAVE_ART = [
    ("capacitor", "skill", "defend", 2, 0),
    ("copper-coil", "attack", "strike", 3, 1),
]

OVERDRIVE_WAVE_ART = [
    ("flash-boiler", "skill", "defend", 0),
    ("overdrive-piston", "attack", "strike", 1),
]

FIELD_WAVE_ART = [
    ("arc-chain", "sigil", "warding-glyph", 6, 0),
    ("gear-grinder", "attack", "strike", 7, 1),
    ("pendulum-ward", "sigil", "warding-glyph", 15, 2),
]

CRYSTAL_WAVE_ART = ("crystal-gambit", "attack", "strike", 14)
ECHO_WAVE_ART = ("echo-glyph", "sigil", "warding-glyph")
ECHO_CELL = (688, 1040, 320, 320)
LENS_WAVE_ART = ("lens-focus", "sigil", "warding-glyph")
LENS_CELL = (688, 1360, 320, 320)

DICE_WAVE_ART = [
    ("loaded-die", "skill", "defend", 0),
    ("reroll-lever", "skill", "defend", 1),
]

MECHANISM_ART = [
    ("gyro-stabilizer", "mechanism", 0),
    ("pressure-gauge", "mechanism", 1),
    ("clockwork-turret", "mechanism", 2),
    ("furnace-heart", "mechanism", 3),
]


def add_overdrive_wave(index: dict, ktx: Path, skip_ktx: bool) -> None:
    """Expand the shared page, relocate six frame-page cells, and add Mechanism art."""
    sources = [
        (SRC / "overdrive-wave" / "overdrive-wave.png", OVERDRIVE_WAVE_ART, 0),
        (SRC / "dice-wave" / "dice-wave.png", DICE_WAVE_ART, 1),
    ]
    page_id = next((i for i, p in enumerate(index["pages"])
                    if p["png"] == "overdrive-wave.png"), len(index["pages"]))
    old_path = OUT / "overdrive-wave.png"
    old = None
    if page_id < len(index["pages"]) and old_path.is_file():
        with Image.open(old_path) as image:
            old = np.array(image.convert("RGBA"))
    expanded = old is not None and old.shape == (PAGE, PAGE, 4)
    page = np.zeros((PAGE, PAGE, 4), np.uint8)
    if old is not None:
        if not expanded and old.shape != (CELL * 2, CELL * 2, 4):
            raise ValueError(f"Unexpected expansion page size: {old.shape[1::-1]}")
        page[: old.shape[0], : old.shape[1]] = old
    size = CELL - 2 * CELL_INSET
    for entry in index["cards"].values():
        for region in entry.get("layers", {}).values():
            if region.get("page") == page_id:
                region["uv"] = uv(*region["rect"], PAGE, PAGE)
    for source_path, placements, row in sources:
        if not source_path.is_file():
            raise FileNotFoundError(f"Missing expansion source: {source_path}")
        with Image.open(source_path) as source:
            source = source.convert("RGBA")
            if source.width != source.height or source.width % 2:
                raise ValueError(f"expansion source must be an even 2x2 sheet: {source.size}")
            quad = source.width // 2
            for card, family, backdrop, cell_index in placements:
                subject = source.crop((cell_index * quad, 0, (cell_index + 1) * quad, quad))
                bounds = subject.getchannel("A").point(lambda alpha: 255 if alpha >= 16 else 0).getbbox()
                if not bounds:
                    raise ValueError(f"Missing foreground for {card} in {source_path}")
                subject = subject.crop(bounds)
                subject.thumbnail((int(size * .82), int(size * .82)), Image.Resampling.LANCZOS)
                centred = Image.new("RGBA", (size, size))
                centred.paste(subject, ((size - subject.width) // 2, (size - subject.height) // 2))
                x, y = cell_index * CELL, row * CELL
                page[y:y + CELL, x:x + CELL] = extrude(bleed(np.array(centred)), CELL_INSET, CELL_INSET)
                rect = [x + CELL_INSET, y + CELL_INSET, size, size]
                front = {"page": page_id, "rect": rect, "uv": uv(*rect, PAGE, PAGE),
                     "source": str(source_path.relative_to(ROOT))}
                backdrop_layers = index["cards"][backdrop]["layers"]
                index["cards"][card] = {
                    "type": family, "frame": family, "glow": GLOW[family],
                    "layers": {"back": backdrop_layers["back"], "mid": backdrop_layers["mid"], "front": front},
                    "stack": LAYER_DEFAULTS,
                }
    # Repack page 3's six occupied lower-left cells into the expansion page's open cells.
    frame_page_id = index["frames"]["attack"]["page"]
    frame_entry = index["pages"][frame_page_id]
    frame_path = OUT / frame_entry["png"]
    frame_page = np.array(Image.open(frame_path).convert("RGBA"))
    if frame_page.shape != (PAGE, PAGE, 4):
        raise ValueError(f"Expected expanded frame page, got {frame_page.shape[1::-1]}")
    for old_slot in (8, 9, 12, 13, 14, 15) if not expanded else []:
        old_x, old_y = (old_slot % 4) * CELL, (old_slot // 4) * CELL
        if not frame_page[old_y:old_y + CELL, old_x:old_x + CELL, 3].any():
            raise ValueError(f"Missing page-3 cell {old_slot} to relocate")
        target_slot = {8: 2, 9: 3, 12: 10, 13: 11, 14: 14, 15: 15}[old_slot]
        target_x, target_y = (target_slot % 4) * CELL, (target_slot // 4) * CELL
        page[target_y:target_y + CELL, target_x:target_x + CELL] = frame_page[old_y:old_y + CELL, old_x:old_x + CELL]
        for entry in index["cards"].values():
            for region in entry.get("layers", {}).values():
                if region.get("page") == frame_page_id and region.get("rect", [])[:2] == [old_x + CELL_INSET, old_y + CELL_INSET]:
                    rect = [target_x + CELL_INSET, target_y + CELL_INSET, size, size]
                    region.update(page=page_id, rect=rect, uv=uv(*rect, PAGE, PAGE))

    mechanism_source = SRC / "mechanism-wave" / "mechanism-wave.png"
    with Image.open(mechanism_source) as source:
        source = source.convert("RGBA")
        quad = source.width // 2
        if source.size != (quad * 2, quad * 2):
            raise ValueError(f"Expected a square 2x2 Mechanism sheet: {source.size}")
        for card, family, quadrant in MECHANISM_ART:
            row, col = divmod(quadrant, 2)
            subject = source.crop((col * quad, row * quad, (col + 1) * quad, (row + 1) * quad))
            bounds = subject.getchannel("A").point(lambda alpha: 255 if alpha >= 16 else 0).getbbox()
            if not bounds:
                raise ValueError(f"Missing foreground for {card} in {mechanism_source}")
            subject = subject.crop(bounds)
            subject.thumbnail((int(size * .82), int(size * .82)), Image.Resampling.LANCZOS)
            centred = Image.new("RGBA", (size, size))
            centred.paste(subject, ((size - subject.width) // 2, (size - subject.height) // 2))
            slot = (8, 9, 12, 13)[quadrant]
            x, y = (slot % 4) * CELL, (slot // 4) * CELL
            page[y:y + CELL, x:x + CELL] = extrude(bleed(np.array(centred)), CELL_INSET, CELL_INSET)
            rect = [x + CELL_INSET, y + CELL_INSET, size, size]
            index["cards"][card] = {
                "type": family, "frame": family, "glow": "#39d6c7",
                "layers": {
                    "back": index["cards"]["strike"]["layers"]["back"],
                    "mid": index["cards"]["strike"]["layers"]["mid"],
                    "front": {"page": page_id, "rect": rect, "uv": uv(*rect, PAGE, PAGE), "source": str(mechanism_source.relative_to(ROOT))},
                },
                "stack": LAYER_DEFAULTS,
            }
    mechanism_frame, mechanism_info = frame_cell("mechanism", attack_window())
    mechanism_rect = [FRAME_INSET, PAGE // 2 + FRAME_INSET, FRAME_W, FRAME_H]
    mechanism = index["frames"].setdefault("mechanism", {
        "page": frame_page_id,
        "aspect": round(FRAME_H / FRAME_W, 6),
        "window": index["frames"]["attack"]["window"],
        "textRegions": TEXT_REGIONS,
        "source": str(frame_source("skill").relative_to(ROOT)),
    })
    mechanism.update(rect=mechanism_rect, uv=uv(*mechanism_rect, PAGE, PAGE), check=mechanism_info)
    # The original page-3 bottom-left area is now fully free for the fourth frame.
    frame_page[PAGE // 2:, :PAGE // 2] = frame_page[PAGE // 2:, :PAGE // 2] * 0
    frame_page[PAGE // 2:PAGE // 2 + FRAME_CELL_H, :FRAME_CELL_W] = mechanism_frame
    save_png(frame_page, frame_path)
    frame_entry.update(height=PAGE, pngSha256=sha256(frame_path), pngBytes=frame_path.stat().st_size)
    if not skip_ktx:
        compressed = encode_ktx2(ktx, frame_path)
        frame_entry.update(ktx2=compressed.name, ktx2Sha256=sha256(compressed), ktx2Bytes=compressed.stat().st_size)
    png = OUT / "overdrive-wave.png"
    save_png(page, png)
    entry = {"png": png.name, "width": page.shape[1], "height": page.shape[0],
             "pngSha256": sha256(png), "pngBytes": png.stat().st_size}
    if not skip_ktx:
        compressed = encode_ktx2(ktx, png)
        entry.update(ktx2=compressed.name, ktx2Sha256=sha256(compressed), ktx2Bytes=compressed.stat().st_size)
    if page_id == len(index["pages"]):
        index["pages"].append(entry)
    else:
        index["pages"][page_id] = entry


def add_field_wave(index: dict, ktx: Path, skip_ktx: bool) -> None:
    """Pack the Wave B field card foregrounds into reserved expansion cells."""
    source_path = SRC / "field-wave" / "field-wave.png"
    if not source_path.is_file():
        raise FileNotFoundError(f"Missing field-wave source: {source_path}")
    size = CELL - 2 * CELL_INSET
    page_id = next((i for i, p in enumerate(index["pages"]) if p["png"] == "overdrive-wave.png"), -1)
    if page_id < 0:
        raise ValueError("field-wave requires the overdrive expansion page")
    page_path = OUT / index["pages"][page_id]["png"]
    page = np.array(Image.open(page_path).convert("RGBA"))
    if page.shape != (PAGE, PAGE, 4):
        raise ValueError(f"Expected expanded field page, got {page.shape[1::-1]}")
    frame_page_id = index["frames"]["attack"]["page"]
    frame_page_path = OUT / index["pages"][frame_page_id]["png"]
    frame_page = np.array(Image.open(frame_page_path).convert("RGBA"))
    if frame_page.shape != (PAGE, PAGE, 4):
        raise ValueError(f"Expected expanded frame page, got {frame_page.shape[1::-1]}")
    with Image.open(source_path) as source:
        source = source.convert("RGBA")
        if source.size[0] != source.size[1] or source.size[0] % 2:
            raise ValueError(f"field-wave source must be a square 2x2 sheet: {source.size}")
        quad = source.width // 2
        for card, family, backdrop, slot, quadrant in FIELD_WAVE_ART:
            if slot < 8:
                target = page
                target_page = page_id
            else:
                target = frame_page
                target_page = frame_page_id
            row, col = divmod(quadrant, 2)
            subject = source.crop((col * quad, row * quad, (col + 1) * quad, (row + 1) * quad))
            bounds = subject.getchannel("A").point(lambda alpha: 255 if alpha >= 16 else 0).getbbox()
            if not bounds:
                raise ValueError(f"Missing foreground for {card} in {source_path}")
            subject = subject.crop(bounds)
            subject.thumbnail((int(size * .82), int(size * .82)), Image.Resampling.LANCZOS)
            centred = Image.new("RGBA", (size, size))
            centred.paste(subject, ((size - subject.width) // 2, (size - subject.height) // 2))
            x, y = (slot % 4) * CELL, (slot // 4) * CELL
            target[y:y + CELL, x:x + CELL] = extrude(bleed(np.array(centred)), CELL_INSET, CELL_INSET)
            rect = [x + CELL_INSET, y + CELL_INSET, size, size]
            backdrop_layers = index["cards"][backdrop]["layers"]
            index["cards"][card] = {
                "type": family, "frame": family, "glow": GLOW[family],
                "layers": {
                    "back": backdrop_layers["back"], "mid": backdrop_layers["mid"],
                    "front": {"page": target_page, "rect": rect, "uv": uv(*rect, PAGE, PAGE),
                               "source": str(source_path.relative_to(ROOT))},
                },
                "stack": LAYER_DEFAULTS,
            }
    save_png(frame_page, frame_page_path)
    frame_entry = index["pages"][frame_page_id]
    frame_entry.update(pngSha256=sha256(frame_page_path), pngBytes=frame_page_path.stat().st_size)
    if not skip_ktx:
        compressed = encode_ktx2(ktx, frame_page_path)
        frame_entry.update(ktx2=compressed.name, ktx2Sha256=sha256(compressed), ktx2Bytes=compressed.stat().st_size)
    save_png(page, page_path)
    page_entry = index["pages"][page_id]
    page_entry.update(pngSha256=sha256(page_path), pngBytes=page_path.stat().st_size)
    if not skip_ktx:
        compressed = encode_ktx2(ktx, page_path)
        page_entry.update(ktx2=compressed.name, ktx2Sha256=sha256(compressed), ktx2Bytes=compressed.stat().st_size)


def add_crystal_wave(index: dict, ktx: Path, skip_ktx: bool) -> None:
    """Pack the standalone Crystal Gambit foreground into page 3 slot 14."""
    source_path = SRC / "crystal-wave" / "crystal-wave.png"
    if not source_path.is_file():
        raise FileNotFoundError(f"Missing crystal-wave source: {source_path}")
    page_id = index["frames"]["attack"]["page"]
    page_entry = index["pages"][page_id]
    page_path = OUT / page_entry["png"]
    page = np.array(Image.open(page_path).convert("RGBA"))
    if page.shape != (PAGE, PAGE, 4):
        raise ValueError(f"Expected expanded frame page, got {page.shape[1::-1]}")
    size = CELL - 2 * CELL_INSET
    slot_x, slot_y = 2 * CELL, 3 * CELL
    rect = [slot_x + CELL_INSET, slot_y + CELL_INSET, size, size]
    existing = page[slot_y:slot_y + CELL, slot_x:slot_x + CELL]
    prior = index["cards"].get(CRYSTAL_WAVE_ART[0], {}).get("layers", {}).get("front", {})
    live_slot = any(
        region.get("page") == page_id and region.get("rect") == rect
        for entry in index["cards"].values()
        for region in entry.get("layers", {}).values()
    )
    if existing[..., 3].any() and live_slot and not (
        prior.get("page") == page_id and prior.get("rect") == rect
        and prior.get("source") == str(source_path.relative_to(ROOT))
    ):
        raise ValueError("Crystal-wave slot 14 collision on page 3")

    with Image.open(source_path) as source:
        source = source.convert("RGBA")
        if source.width != source.height:
            raise ValueError(f"crystal-wave source must be square: {source.size}")
        bounds = source.getchannel("A").point(lambda alpha: 255 if alpha >= 16 else 0).getbbox()
        if not bounds:
            raise ValueError(f"Missing foreground in {source_path}")
        subject = source.crop(bounds)
        subject.thumbnail((int(size * 0.82), int(size * 0.82)), Image.Resampling.LANCZOS)
        centred = Image.new("RGBA", (size, size))
        centred.paste(subject, ((size - subject.width) // 2, (size - subject.height) // 2))
    page[slot_y:slot_y + CELL, slot_x:slot_x + CELL] = extrude(bleed(np.array(centred)), CELL_INSET, CELL_INSET)
    front = {"page": page_id, "rect": rect, "uv": uv(*rect, PAGE, PAGE),
             "source": str(source_path.relative_to(ROOT))}
    backdrop = index["cards"][CRYSTAL_WAVE_ART[2]]["layers"]
    index["cards"][CRYSTAL_WAVE_ART[0]] = {
        "type": CRYSTAL_WAVE_ART[1], "frame": CRYSTAL_WAVE_ART[1], "glow": GLOW[CRYSTAL_WAVE_ART[1]],
        "layers": {"back": backdrop["back"], "mid": backdrop["mid"], "front": front},
        "stack": LAYER_DEFAULTS,
    }
    save_png(page, page_path)
    page_entry.update(pngSha256=sha256(page_path), pngBytes=page_path.stat().st_size)
    if not skip_ktx:
        compressed = encode_ktx2(ktx, page_path)
        page_entry.update(ktx2=compressed.name, ktx2Sha256=sha256(compressed), ktx2Bytes=compressed.stat().st_size)


def add_gap_wave(index: dict, ktx: Path, skip_ktx: bool,
                 art: tuple[str, str, str], cell: tuple[int, int, int, int], source_dir: str,
                 source_name: str | None = None, keyed: bool = True) -> None:
    """Pack one isolated sigil foreground into a reserved page-3 320 px gap."""
    card_id, card_type, backdrop_id = art
    source_path = SRC / source_dir / (source_name or f"{source_dir}.source.png")
    if not source_path.is_file():
        raise FileNotFoundError(f"Missing {source_dir} source: {source_path}")
    page_id = index["frames"]["mechanism"]["page"]
    page_entry = index["pages"][page_id]
    page_path = OUT / page_entry["png"]
    page = np.array(Image.open(page_path).convert("RGBA"))
    if page.shape != (PAGE, PAGE, 4):
        raise ValueError(f"Expected expanded frame page, got {page.shape[1::-1]}")

    cell_x, cell_y, cell_w, cell_h = cell
    content = cell_w - 2 * CELL_INSET
    rect = [cell_x + CELL_INSET, cell_y + CELL_INSET, content, content]
    cell_box = (cell_x, cell_y, cell_x + cell_w, cell_y + cell_h)

    def intersects(box: tuple[int, int, int, int], region: list[int]) -> bool:
        x, y, w, h = region
        return box[0] < x + w and x < box[2] and box[1] < y + h and y < box[3]

    for frame_name, frame in index["frames"].items():
        if frame["page"] == page_id and intersects(cell_box, frame["rect"]):
            raise ValueError(f"{source_dir} cell intersects the {frame_name} frame")
    prior = index["cards"].get(card_id, {}).get("layers", {}).get("front", {})
    for live_card_id, entry in index["cards"].items():
        for region in entry.get("layers", {}).values():
            if region.get("page") != page_id or not intersects(cell_box, region.get("rect", [])):
                continue
            if not (live_card_id == art[0] and region.get("rect") == rect
                    and region.get("source") == str(source_path.relative_to(ROOT))):
                raise ValueError(f"{source_dir} cell intersects live art rect for {live_card_id}")
    existing = page[cell_y:cell_y + cell_h, cell_x:cell_x + cell_w]
    if existing[..., 3].any() and not (
        prior.get("page") == page_id and prior.get("rect") == rect
        and prior.get("source") == str(source_path.relative_to(ROOT))
    ):
        raise ValueError(f"{source_dir} cell contains existing atlas pixels")

    with Image.open(source_path) as source:
        rgba = np.array(source.convert("RGBA"))
        if not keyed and (source.mode != "RGBA" or rgba[..., 3].min() != 0 or rgba[..., 3].max() != 255):
            raise ValueError(f"Expected an RGBA cutout with transparent and opaque pixels in {source_path}")
        if keyed:
            matte = chroma_matte(rgba[..., :3].astype(np.float32), "magenta")
            rgba[..., 3] = np.rint(rgba[..., 3] * matte).astype(np.uint8)
            prepared = Image.fromarray(despill_fringe(rgba, "magenta"))
        else:
            prepared = Image.fromarray(rgba)
        bounds = prepared.getchannel("A").point(lambda alpha: 255 if alpha >= 16 else 0).getbbox()
        if not bounds:
            raise ValueError(f"Missing foreground in {source_path}")
        subject = prepared.crop(bounds)
        side = int(content * 0.9)
        subject.thumbnail((side, side), Image.Resampling.LANCZOS)
        centred = Image.new("RGBA", (content, content))
        centred.paste(subject, ((content - subject.width) // 2, (content - subject.height) // 2))
    page[cell_y:cell_y + cell_h, cell_x:cell_x + cell_w] = extrude(
        bleed(np.array(centred)), CELL_INSET, CELL_INSET
    )
    backdrop = index["cards"][backdrop_id]["layers"]
    index["cards"][card_id] = {
        "type": card_type, "frame": card_type, "glow": GLOW[card_type],
        "layers": {
            "back": backdrop["back"], "mid": backdrop["mid"],
            "front": {"page": page_id, "rect": rect, "uv": uv(*rect, PAGE, PAGE),
                       "source": str(source_path.relative_to(ROOT))},
        },
        "stack": LAYER_DEFAULTS,
    }
    save_png(page, page_path)
    page_entry.update(pngSha256=sha256(page_path), pngBytes=page_path.stat().st_size)
    if not skip_ktx:
        compressed = encode_ktx2(ktx, page_path)
        page_entry.update(ktx2=compressed.name, ktx2Sha256=sha256(compressed), ktx2Bytes=compressed.stat().st_size)


def add_echo_wave(index: dict, ktx: Path, skip_ktx: bool) -> None:
    """Pack Echo Glyph into the reserved 320 px gap beside the Mechanism frame."""
    add_gap_wave(index, ktx, skip_ktx, ECHO_WAVE_ART, ECHO_CELL, "echo-wave")


def add_lens_wave(index: dict, ktx: Path, skip_ktx: bool) -> None:
    """Pack Lens Focus into the second reserved 320 px gap beside the Mechanism frame."""
    add_gap_wave(index, ktx, skip_ktx, LENS_WAVE_ART, LENS_CELL, "lens-wave",
                 source_name="lens-wave.cutout.png", keyed=False)


def add_charge_wave(index: dict, ktx: Path, skip_ktx: bool) -> None:
    """Pack the two Wave B charge foregrounds into the reserved slot 15 cells."""
    source_path = SRC / "charge-wave" / "charge-wave.png"
    if not source_path.is_file():
        raise FileNotFoundError(f"Missing charge-wave source: {source_path}")
    size = CELL - 2 * CELL_INSET
    with Image.open(source_path) as source:
        source = source.convert("RGBA")
        if source.width != source.height or source.width % 2:
            raise ValueError(f"charge-wave source must be a square 2x2 sheet: {source.size}")
        quad_w = source.width // 2
        prepared = []
        for card, family, backdrop, page_id, quadrant in CHARGE_WAVE_ART:
            page_entry = index["pages"][page_id]
            page_path = OUT / page_entry["png"]
            if not page_path.is_file():
                raise FileNotFoundError(f"Missing atlas page for {card}: {page_path}")
            slot_x, slot_y = CELL * 3, CELL * 3
            page = np.array(Image.open(page_path).convert("RGBA"))
            front = index["cards"].get(card, {}).get("layers", {}).get("front", {})
            prior = (
                front.get("page") == page_id
                and front.get("rect") == [slot_x + CELL_INSET, slot_y + CELL_INSET, size, size]
                and front.get("source") == str(source_path.relative_to(ROOT))
            )
            if page[slot_y:slot_y + CELL, slot_x:slot_x + CELL, 3].any() and not prior:
                raise ValueError(f"Charge-wave slot 15 collision on page {page_id} for {card}")
            row, col = divmod(quadrant, 2)
            subject = source.crop((col * quad_w, row * quad_w, (col + 1) * quad_w, (row + 1) * quad_w))
            bounds = subject.getchannel("A").point(lambda alpha: 255 if alpha >= 16 else 0).getbbox()
            if not bounds:
                raise ValueError(f"Missing foreground for {card} in {source_path}")
            prepared.append((card, family, backdrop, page_id, page_path, subject.crop(bounds)))

    for card, family, backdrop, page_id, page_path, subject in prepared:
        page = np.array(Image.open(page_path).convert("RGBA"))
        subject.thumbnail((int(size * .82), int(size * .82)), Image.Resampling.LANCZOS)
        centred = Image.new("RGBA", (size, size))
        centred.paste(subject, ((size - subject.width) // 2, (size - subject.height) // 2))
        cell = extrude(bleed(np.array(centred)), CELL_INSET, CELL_INSET)
        slot_x, slot_y = CELL * 3, CELL * 3
        page[slot_y:slot_y + CELL, slot_x:slot_x + CELL] = cell
        save_png(page, page_path)
        front = {"page": page_id, "rect": [slot_x + CELL_INSET, slot_y + CELL_INSET, size, size],
                 "uv": uv(slot_x + CELL_INSET, slot_y + CELL_INSET, size, size, PAGE, PAGE),
                 "source": str(source_path.relative_to(ROOT))}
        backdrop_entry = index["cards"][backdrop]["layers"]
        index["cards"][card] = {
            "type": family, "frame": family, "glow": GLOW[family],
            "layers": {"back": backdrop_entry["back"], "mid": backdrop_entry["mid"], "front": front},
            "stack": LAYER_DEFAULTS,
        }
        page_entry = index["pages"][page_id]
        page_entry.update(pngSha256=sha256(page_path), pngBytes=page_path.stat().st_size)
        if not skip_ktx:
            compressed = encode_ktx2(ktx, page_path)
            page_entry.update(ktx2=compressed.name, ktx2Sha256=sha256(compressed), ktx2Bytes=compressed.stat().st_size)


def add_foundry_page(index: dict, ktx: Path, skip_ktx: bool) -> None:
    filename = "foundry.png"
    page_id = next((i for i, p in enumerate(index["pages"]) if p["png"] == filename), len(index["pages"]))
    page = np.zeros((PAGE, PAGE, 4), np.uint8)
    size = CELL - 2 * CELL_INSET

    def put(slot: int, cell: np.ndarray, source: str) -> dict:
        row, col = divmod(slot, PAGE // CELL)
        x, y = col * CELL, row * CELL
        page[y:y+CELL,x:x+CELL] = cell
        x, y = x + CELL_INSET, y + CELL_INSET
        return {"page":page_id,"rect":[x,y,size,size],"uv":uv(x,y,size,size,PAGE,PAGE),"source":source}

    backdrops = {}
    for i, (family, original) in enumerate((("attack","strike"),("skill","defend"),("sigil","warding-glyph"))):
        backdrops[family] = {}
        for j, layer in enumerate(("back","mid")):
            entry = index["cards"][original]["layers"][layer]
            x,y,_,_ = entry["rect"]
            with Image.open(OUT / index["pages"][entry["page"]]["png"]) as img:
                cell = np.array(img.convert("RGBA").crop((x-CELL_INSET,y-CELL_INSET,x-CELL_INSET+CELL,y-CELL_INSET+CELL)))
            backdrops[family][layer] = put(8+2*i+j,cell,entry["source"])
    for slot,(card,family,sheet,quadrant) in enumerate(FOUNDRY_ART):
        path = SRC / "foundry" / f"{sheet}.png"
        with Image.open(path) as img:
            w,h = img.size
            row,col = divmod(quadrant,2)
            subject = img.convert("RGBA").crop((col*w//2,row*h//2,(col+1)*w//2,(row+1)*h//2))
            bounds = subject.getchannel("A").point(lambda a: 255 if a>=16 else 0).getbbox()
            if not bounds:
                raise ValueError(f"Missing foreground for {card}")
            subject = subject.crop(bounds)
            subject.thumbnail((int(size*.82),int(size*.82)),Image.Resampling.LANCZOS)
            centred = Image.new("RGBA",(size,size))
            centred.paste(subject,((size-subject.width)//2,(size-subject.height)//2))
        front = put(slot,extrude(bleed(np.array(centred)),CELL_INSET,CELL_INSET),str(path.relative_to(ROOT)))
        index["cards"][card] = {"type":family,"frame":family,"glow":GLOW[family],
                                "layers":{**backdrops[family],"front":front},"stack":LAYER_DEFAULTS}
    png = OUT / filename
    save_png(page,png)
    entry = {"png":filename,"pngSha256":sha256(png),"pngBytes":png.stat().st_size,"width":PAGE,"height":PAGE}
    if not skip_ktx:
        compressed = encode_ktx2(ktx,png)
        entry.update(ktx2=compressed.name,ktx2Sha256=sha256(compressed),ktx2Bytes=compressed.stat().st_size)
    if page_id == len(index["pages"]):
        index["pages"].append(entry)
    else:
        index["pages"][page_id] = entry


def add_dungeon_page(index: dict, ktx: Path, skip_ktx: bool) -> None:
    """Pack Wave A dungeon foregrounds into the unused slots on the Foundry page."""
    filename = "foundry.png"
    page_id = next((i for i, p in enumerate(index["pages"]) if p["png"] == filename), -1)
    if page_id < 0:
        raise ValueError("Foundry page must be built before dungeon art")
    with Image.open(OUT / filename) as existing:
        page = np.array(existing.convert("RGBA"))
    size = CELL - 2 * CELL_INSET

    def put(slot: int, cell: np.ndarray, source: str) -> dict:
        row, col = divmod(slot, PAGE // CELL)
        x, y = col * CELL, row * CELL
        page[y:y + CELL, x:x + CELL] = cell
        x, y = x + CELL_INSET, y + CELL_INSET
        return {"page": page_id, "rect": [x, y, size, size], "uv": uv(x, y, size, size, PAGE, PAGE), "source": source}

    backdrops = {
        "attack": {layer: index["cards"]["shear-pin"]["layers"][layer] for layer in ("back", "mid")},
        "skill": {layer: index["cards"]["rivet-plate"]["layers"][layer] for layer in ("back", "mid")},
    }

    source_path = SRC / "dungeon" / "dungeon.png"
    with Image.open(source_path) as img:
        w, h = img.size
        for slot, (card, family, _, quadrant) in enumerate(DUNGEON_ART, start=12):
            row, col = divmod(quadrant, 2)
            subject = img.convert("RGBA").crop((col * w // 2, row * h // 2, (col + 1) * w // 2, (row + 1) * h // 2))
            bounds = subject.getchannel("A").point(lambda a: 255 if a >= 16 else 0).getbbox()
            if not bounds:
                raise ValueError(f"Missing foreground for {card}")
            subject = subject.crop(bounds)
            subject.thumbnail((int(size * .82), int(size * .82)), Image.Resampling.LANCZOS)
            centred = Image.new("RGBA", (size, size))
            centred.paste(subject, ((size - subject.width) // 2, (size - subject.height) // 2))
            front = put(slot, extrude(bleed(np.array(centred)), CELL_INSET, CELL_INSET), str(source_path.relative_to(ROOT)))
            index["cards"][card] = {"type": family, "frame": family, "glow": GLOW[family],
                                    "layers": {**backdrops[family], "front": front}, "stack": LAYER_DEFAULTS}

    png = OUT / filename
    save_png(page, png)
    entry = {"png": filename, "pngSha256": sha256(png), "pngBytes": png.stat().st_size, "width": PAGE, "height": PAGE}
    if not skip_ktx:
        compressed = encode_ktx2(ktx, png)
        entry.update(ktx2=compressed.name, ktx2Sha256=sha256(compressed), ktx2Bytes=compressed.stat().st_size)
    if page_id == len(index["pages"]):
        index["pages"].append(entry)
    else:
        index["pages"][page_id] = entry


def add_repair_wave(index: dict, ktx: Path, skip_ktx: bool) -> None:
    """Add the three Wave A foregrounds to the reserved slot 15 on each art page."""
    source_path = SRC / "repair-wave" / "repair-wave.png"
    if not source_path.is_file():
        raise FileNotFoundError(f"Missing repair-wave source: {source_path}")
    size = CELL - 2 * CELL_INSET
    with Image.open(source_path) as source:
        source = source.convert("RGBA")
        if source.width % 2 or source.height % 2:
            raise ValueError(f"repair-wave source must be a 2x2 sheet: {source.size}")
        quad_w, quad_h = source.width // 2, source.height // 2
        prepared = []
        slot_x, slot_y = CELL * 3, CELL * 3
        for card, family, backdrop, quadrant in REPAIR_WAVE_ART:
            page_id = index["cards"].get(backdrop, {}).get("layers", {}).get("back", {}).get("page")
            if page_id is None:
                raise ValueError(f"Missing backdrop card {backdrop} for {card}")
            page_path = OUT / index["pages"][page_id]["png"]
            if not page_path.is_file():
                raise FileNotFoundError(f"Missing atlas page for {card}: {page_path}")
            page = np.array(Image.open(page_path).convert("RGBA"))
            existing = page[slot_y:slot_y + CELL, slot_x:slot_x + CELL]
            prior = next((entry for entry in index["cards"].values()
                          if entry.get("layers", {}).get("front", {}).get("page") == page_id
                          and entry.get("layers", {}).get("front", {}).get("rect") ==
                          [slot_x + CELL_INSET, slot_y + CELL_INSET, size, size]), None)
            if existing[..., 3].any() and not (card in index["cards"] and prior is index["cards"].get(card)):
                raise ValueError(f"Repair-wave slot 15 collision on page {page_id} for {card}")
            row, col = divmod(quadrant, 2)
            subject = source.crop((col * quad_w, row * quad_h, (col + 1) * quad_w, (row + 1) * quad_h))
            bounds = subject.getchannel("A").point(lambda alpha: 255 if alpha >= 16 else 0).getbbox()
            if not bounds:
                raise ValueError(f"Missing foreground for {card} in {source_path}")
            prepared.append((card, family, backdrop, page_id, page_path, subject.crop(bounds)))

        for card, family, backdrop, page_id, page_path, subject in prepared:
            page = np.array(Image.open(page_path).convert("RGBA"))
            subject.thumbnail((int(size * .82), int(size * .82)), Image.Resampling.LANCZOS)
            centred = Image.new("RGBA", (size, size))
            centred.paste(subject, ((size - subject.width) // 2, (size - subject.height) // 2))
            cell = extrude(bleed(np.array(centred)), CELL_INSET, CELL_INSET)
            page[slot_y:slot_y + CELL, slot_x:slot_x + CELL] = cell
            save_png(page, page_path)
            front = {"page": page_id, "rect": [slot_x + CELL_INSET, slot_y + CELL_INSET, size, size],
                     "uv": uv(slot_x + CELL_INSET, slot_y + CELL_INSET, size, size, PAGE, PAGE),
                     "source": str(source_path.relative_to(ROOT))}
            backdrop_entry = index["cards"][backdrop]["layers"]
            index["cards"][card] = {
                "type": family, "frame": family, "glow": GLOW[family],
                "layers": {"back": backdrop_entry["back"], "mid": backdrop_entry["mid"], "front": front},
                "stack": LAYER_DEFAULTS,
            }
            page_entry = index["pages"][page_id]
            page_entry["pngSha256"] = sha256(page_path)
            page_entry["pngBytes"] = page_path.stat().st_size
            if not skip_ktx:
                compressed = encode_ktx2(ktx, page_path)
                page_entry.update(ktx2=compressed.name, ktx2Sha256=sha256(compressed), ktx2Bytes=compressed.stat().st_size)

    kit = index["cards"]["patch-kit"]
    guard = index["cards"]["defend"]
    index["cards"]["field-dressing"] = {
        **kit,
        "glow": "#80cfa5",
        "layers": {**guard["layers"], "front": kit["layers"]["front"]},
    }


def add_complete_wave(index: dict, ktx: Path, skip_ktx: bool) -> None:
    """Use the lower half of the frame texture without allocating another texture sampler."""
    source_path = SRC / "complete-wave" / "complete-wave.png"
    placements = [
        ("grease-gun", "skill", 0),
        ("escapement-break", "attack", 1),
        ("lucky-strike", "attack", 2),
    ]
    card_ids = {card for card, _, _ in placements}
    page_id = index["frames"]["attack"]["page"]
    page_entry = index["pages"][page_id]
    page_path = OUT / page_entry["png"]
    with Image.open(page_path) as image:
        if image.width != PAGE or image.height not in (FRAME_CELL_H, PAGE):
            raise ValueError(f"Unexpected frame texture size: {image.size}")
        original = np.array(image.convert("RGBA"))
    size = CELL - 2 * CELL_INSET
    charge_front = [CELL * 3 + CELL_INSET, CELL * 3 + CELL_INSET, size, size]
    preserved = {
        card for card, _, _, front_page, _ in CHARGE_WAVE_ART
        if front_page == page_id
        and index["cards"].get(card, {}).get("layers", {}).get("front", {}).get("rect") == charge_front
    }
    if any(
        layer["page"] == page_id
        for card, entry in index["cards"].items() if card not in card_ids | preserved
        for layer in entry["layers"].values()
    ):
        raise ValueError("Wave A would overwrite existing art below the card frames")
    if original[FRAME_CELL_H:, :, 3].any() and not card_ids.issubset(index["cards"]):
        raise ValueError("Unindexed art occupies the lower half of the frame texture")

    page = np.zeros((PAGE, PAGE, 4), dtype=np.uint8)
    page[:FRAME_CELL_H] = original[:FRAME_CELL_H]
    if preserved:
        page[3 * CELL:, 3 * CELL:] = original[3 * CELL:, 3 * CELL:]

    def put(slot: int, cell: np.ndarray, source: str) -> dict:
        row, col = divmod(slot, PAGE // CELL)
        x, y = col * CELL, row * CELL
        page[y:y + CELL, x:x + CELL] = cell
        rect = [x + CELL_INSET, y + CELL_INSET, size, size]
        return {"page": page_id, "rect": rect, "uv": uv(*rect, PAGE, PAGE), "source": source}

    backgrounds = {}
    for slot, (family, backdrop) in enumerate([("attack", "strike"), ("skill", "defend")]):
        backgrounds[family] = {}
        for offset, name in enumerate(("back", "mid")):
            layer = index["cards"][backdrop]["layers"][name]
            x, y, w, h = layer["rect"]
            if (w, h) != (size, size):
                raise ValueError(f"Expected a full atlas cell for {backdrop} {name}")
            x, y = x - CELL_INSET, y - CELL_INSET
            with Image.open(OUT / index["pages"][layer["page"]]["png"]) as art:
                cell = np.array(art.crop((x, y, x + CELL, y + CELL)).convert("RGBA"))
            backgrounds[family][name] = put(8 + slot * 2 + offset, cell, layer["source"])

    with Image.open(source_path) as image:
        source = image.convert("RGBA")
        half = source.width // 2
        if source.size != (2 * half, 2 * half):
            raise ValueError(f"Expected a square 2x2 Wave A sheet: {source.size}")
        for card, family, quadrant in placements:
            row, col = divmod(quadrant, 2)
            subject = source.crop((col * half, row * half, (col + 1) * half, (row + 1) * half))
            bounds = subject.getchannel("A").point(lambda alpha: 255 if alpha >= 16 else 0).getbbox()
            if not bounds:
                raise ValueError(f"Missing foreground for {card} in {source_path}")
            subject = subject.crop(bounds)
            subject.thumbnail((int(size * .82), int(size * .82)), Image.Resampling.LANCZOS)
            centred = Image.new("RGBA", (size, size))
            centred.paste(subject, ((size - subject.width) // 2, (size - subject.height) // 2))
            front = put(12 + quadrant, extrude(bleed(np.array(centred)), CELL_INSET, CELL_INSET),
                        str(source_path.relative_to(ROOT)))
            index["cards"][card] = {
                "type": family, "frame": family, "glow": GLOW[family],
                "layers": {**backgrounds[family], "front": front}, "stack": LAYER_DEFAULTS,
            }

    for frame in index["frames"].values():
        if frame["page"] != page_id:
            raise ValueError("Expected the three card frames to share one page")
        frame["uv"] = uv(*frame["rect"], PAGE, PAGE)
    save_png(page, page_path)
    page_entry.update(height=PAGE, pngSha256=sha256(page_path), pngBytes=page_path.stat().st_size)
    if not skip_ktx:
        compressed = encode_ktx2(ktx, page_path)
        page_entry.update(ktx2=compressed.name, ktx2Sha256=sha256(compressed), ktx2Bytes=compressed.stat().st_size)


def add_risk_card_art(index: dict) -> None:
    """Reuse the piston and boiler foregrounds with different card backdrops."""
    cards = index["cards"]
    for card_id, subject_id, backdrop_id in [
        ("redline-shot", "overdrive-piston", "lucky-strike"),
        ("boiler-gamble", "flash-boiler", "spare-parts"),
    ]:
        subject = cards[subject_id]
        backdrop = cards[backdrop_id]
        cards[card_id] = {
            **subject,
            "layers": {**backdrop["layers"], "front": subject["layers"]["front"]},
        }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ktx", type=Path, default=DEFAULT_KTX)
    ap.add_argument("--skip-ktx", action="store_true")
    ap.add_argument("--foundry-only", action="store_true", help="extend the checked-in slice atlas using the Foundry source sheets")
    ap.add_argument("--dungeon-only", action="store_true", help="extend the checked-in atlas using the dungeon source sheet")
    ap.add_argument("--repair-wave-only", action="store_true", help="extend the checked-in atlas using the Wave A repair sheet")
    ap.add_argument("--complete-wave-only", action="store_true", help="pack the final Wave A art into the frame page")
    ap.add_argument("--charge-wave-only", action="store_true", help="extend the checked-in atlas using the Wave B charge sheet")
    ap.add_argument("--overdrive-only", action="store_true", help="rebuild the shared Overdrive and dice expansion page")
    ap.add_argument("--field-wave-only", action="store_true", help="extend the checked-in atlas using the Wave B field sheet")
    ap.add_argument("--crystal-wave-only", action="store_true", help="extend the checked-in atlas using the Crystal Gambit sheet")
    ap.add_argument("--echo-wave-only", action="store_true", help="pack Echo Glyph into the reserved frame-page gap")
    ap.add_argument("--lens-wave-only", action="store_true", help="pack Lens Focus into the second reserved frame-page gap")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    manifest = OUT / "card-atlas.json"
    if args.foundry_only:
        index = json.loads(manifest.read_text())
        add_foundry_page(index,args.ktx,args.skip_ktx)
        manifest.write_text(dumps(index) + "\n")
        return
    if args.dungeon_only:
        index = json.loads(manifest.read_text())
        add_dungeon_page(index,args.ktx,args.skip_ktx)
        manifest.write_text(dumps(index) + "\n")
        return
    if args.repair_wave_only:
        index = json.loads(manifest.read_text())
        add_repair_wave(index, args.ktx, args.skip_ktx)
        manifest.write_text(dumps(index) + "\n")
        return

    if args.complete_wave_only:
        index = json.loads(manifest.read_text())
        add_complete_wave(index, args.ktx, args.skip_ktx)
        manifest.write_text(dumps(index) + "\n")
        return
    if args.charge_wave_only:
        index = json.loads(manifest.read_text())
        add_charge_wave(index, args.ktx, args.skip_ktx)
        manifest.write_text(dumps(index) + "\n")
        return
    if args.overdrive_only:
        index = json.loads(manifest.read_text())
        add_overdrive_wave(index, args.ktx, args.skip_ktx)
        manifest.write_text(dumps(index) + "\n")
        return
    if args.field_wave_only:
        index = json.loads(manifest.read_text())
        add_field_wave(index, args.ktx, args.skip_ktx)
        manifest.write_text(dumps(index) + "\n")
        return
    if args.crystal_wave_only:
        index = json.loads(manifest.read_text())
        add_crystal_wave(index, args.ktx, args.skip_ktx)
        manifest.write_text(dumps(index) + "\n")
        return
    if args.echo_wave_only:
        index = json.loads(manifest.read_text())
        add_echo_wave(index, args.ktx, args.skip_ktx)
        manifest.write_text(dumps(index) + "\n")
        return
    if args.lens_wave_only:
        index = json.loads(manifest.read_text())
        add_lens_wave(index, args.ktx, args.skip_ktx)
        manifest.write_text(dumps(index) + "\n")
        return

    pages: list[np.ndarray] = []
    cards: dict[str, dict] = {}
    for i, (card, ctype) in enumerate(CARD_IDS):
        page_index, slot0 = divmod(i, CARDS_PER_PAGE)
        if page_index == len(pages):
            pages.append(np.zeros((PAGE, PAGE, 4), np.uint8))
        layers = {}
        for j, layer in enumerate(LAYERS):
            row, col = divmod(slot0 * 3 + j, PAGE // CELL)
            x, y = col * CELL, row * CELL
            pages[page_index][y:y + CELL, x:x + CELL] = layer_cell(card, ctype, layer)
            cx, cy, cw = x + CELL_INSET, y + CELL_INSET, CELL - 2 * CELL_INSET
            layers[layer] = {
                "page": page_index,
                "rect": [cx, cy, cw, cw],
                "uv": uv(cx, cy, cw, cw, PAGE, PAGE),
                "source": str(layer_source(card, layer).relative_to(ROOT)),
            }
        stack = {k: dict(v) for k, v in LAYER_DEFAULTS.items()}
        if card == "strike":
            for k, v in STRIKE_OVERRIDES.items():
                stack[k].update(v)
        cards[card] = {"type": ctype, "frame": ctype, "glow": GLOW[ctype], "layers": layers, "stack": stack}

    window = attack_window()
    frame_page = np.zeros((PAGE, PAGE, 4), np.uint8)
    frames: dict[str, dict] = {}
    frame_page_index = len(pages)
    for k, ftype in enumerate(FRAME_TYPES):
        cell, info = frame_cell(ftype, window)
        if ftype == "mechanism":
            # The bottom-left 1024px quadrant is populated after Complete Wave art is relocated.
            x, y = 0, PAGE // 2
        else:
            x, y = k * (FRAME_CELL_W + 4), 0
            frame_page[y:y + FRAME_CELL_H, x:x + FRAME_CELL_W] = cell
        fx, fy = x + FRAME_INSET, y + FRAME_INSET
        frames[ftype] = {
            "page": frame_page_index,
            "rect": [fx, fy, FRAME_W, FRAME_H],
            "uv": uv(fx, fy, FRAME_W, FRAME_H, PAGE, FRAME_CELL_H),
            "aspect": round(FRAME_H / FRAME_W, 6),
            "window": {
                "u": round(window[0] / FRAME_W, 6),
                "v": round(window[1] / FRAME_H, 6),
                "radius": round((window[2] + WINDOW_MARGIN) / FRAME_W, 6),
            },
            "textRegions": TEXT_REGIONS,
            "source": str(frame_source("skill" if ftype == "mechanism" else ftype).relative_to(ROOT)),
            "check": info,
        }

    page_entries = []
    for n, arr in enumerate([*pages, frame_page]):
        png = OUT / f"card-atlas-{n}.png"
        save_png(arr, png)
        entry = {"png": png.name, "width": arr.shape[1], "height": arr.shape[0], "pngSha256": sha256(png)}
        if not args.skip_ktx:
            ktx2 = encode_ktx2(args.ktx, png)
            entry |= {"ktx2": ktx2.name, "ktx2Sha256": sha256(ktx2), "ktx2Bytes": ktx2.stat().st_size}
        page_entries.append(entry)
        print(f"{png.name}: {arr.shape[1]}x{arr.shape[0]} {entry['pngSha256'][:16]} {entry.get('ktx2Sha256', '')[:16]}")

    index = {
        "version": 1,
        "uvOrigin": "bottom-left",
        "rectOrigin": "top-left",
        "colorSpace": "srgb",
        "ktx2": "uastc q2 rdo, zstd 18, generated mips, texcoord origin bottom-left, R8G8B8A8_SRGB",
        "pages": page_entries,
        "frames": frames,
        "cards": cards,
    }
    add_foundry_page(index,args.ktx,args.skip_ktx)
    add_dungeon_page(index,args.ktx,args.skip_ktx)
    add_repair_wave(index,args.ktx,args.skip_ktx)
    add_complete_wave(index,args.ktx,args.skip_ktx)
    add_charge_wave(index,args.ktx,args.skip_ktx)
    add_overdrive_wave(index,args.ktx,args.skip_ktx)
    add_field_wave(index,args.ktx,args.skip_ktx)
    add_crystal_wave(index,args.ktx,args.skip_ktx)
    add_echo_wave(index,args.ktx,args.skip_ktx)
    add_lens_wave(index,args.ktx,args.skip_ktx)
    add_risk_card_art(index)
    manifest.write_text(dumps(index) + "\n")
    print(f"card-atlas.json: {len(index['cards'])} cards, {len(frames)} frames, {len(page_entries)} pages")


if __name__ == "__main__":
    main()
