"""Packs the P5-T5 card illustration layers and card frames into KTX2 atlas pages with a JSON index.

Usage: python3 -I scripts/assets/build_card_atlas.py [--ktx <path to ktx>] [--skip-ktx]

Inputs (immutable sources, see assets-source/cards/README.md):
  assets-source/cards/<card-id>/<card-id>-back.png, -mid.cutout.png, -front.cutout.png
  assets-source/cards/attack-strike/ for `strike` (the P4 portal-card proof art, reused)
  assets-source/cards/frames/<type>/frame-<type>-<pick>.png, picks in assets-source/cards/selection.json

Outputs in public/assets/cards/atlas/:
  card-atlas-0..2.png/.ktx2  2048x2048, five cards each as back, mid and front 512 px cells
  card-atlas-3.png/.ktx2     2048x1024, the attack, skill and sigil frames side by side
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
FRAME_TYPES = ["attack", "skill", "sigil"]
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


def attack_window() -> tuple[float, float, float]:
    """The shared window (centre x, centre y, radius) in output px, from the attack frame."""
    cx, cy, r = green_disc(np.asarray(Image.open(frame_source("attack")).convert("RGB")))
    left, top, width = ATTACK_CROP
    s = FRAME_W / width
    return (cx - left) * s, (cy - top) * s, r * s


def frame_cell(ftype: str, window: tuple[float, float, float]) -> tuple[np.ndarray, dict]:
    src = Image.open(frame_source(ftype)).convert("RGB")
    cx, cy, r = green_disc(np.asarray(src))
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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ktx", type=Path, default=DEFAULT_KTX)
    ap.add_argument("--skip-ktx", action="store_true")
    ap.add_argument("--foundry-only", action="store_true", help="extend the checked-in slice atlas using the Foundry source sheets")
    ap.add_argument("--dungeon-only", action="store_true", help="extend the checked-in atlas using the dungeon source sheet")
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
    frame_page = np.zeros((FRAME_CELL_H, PAGE, 4), np.uint8)
    frames: dict[str, dict] = {}
    frame_page_index = len(pages)
    for k, ftype in enumerate(FRAME_TYPES):
        cell, info = frame_cell(ftype, window)
        x = k * (FRAME_CELL_W + 4)
        frame_page[0:FRAME_CELL_H, x:x + FRAME_CELL_W] = cell
        fx, fy = x + FRAME_INSET, FRAME_INSET
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
            "source": str(frame_source(ftype).relative_to(ROOT)),
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
    manifest.write_text(dumps(index) + "\n")
    print(f"card-atlas.json: {len(cards)} cards, {len(frames)} frames, {len(page_entries)} pages")


if __name__ == "__main__":
    main()
