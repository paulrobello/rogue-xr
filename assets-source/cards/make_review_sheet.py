"""Builds the P5-T5 owner review sheet from the shipped atlas (not the composite key references).

Usage: python3 -I assets-source/cards/make_review_sheet.py

Each illustration is the flattened portal stack seen front-on from 0.32 m: back, mid, glow and
front layers at their card-atlas.json stack sizes, each shrunk by its depth's perspective factor,
clipped to the window. Writes assets-source/cards/p5t5-review-sheet.jpg.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
ATLAS = ROOT / "public/assets/cards/atlas"
OUT = ROOT / "assets-source/cards/p5t5-review-sheet.jpg"
VIEW_DISTANCE = 0.32  # metres, the card-proof XR position
HEADSET_WIDTH = 280  # px: a 63 mm card at 0.32 m spans about 11 degrees, about 25 px per degree on Quest 3
BG = (28, 18, 11)

index = json.loads((ATLAS / "card-atlas.json").read_text())
pages = [Image.open(ATLAS / p["png"]).convert("RGBA") for p in index["pages"]]
font = ImageFont.load_default(size=22)
small = ImageFont.load_default(size=16)


def region(entry: dict) -> Image.Image:
    x, y, w, h = entry["rect"]
    return pages[entry["page"]].crop((x, y, x + w, y + h))


def glow(colour: str, size: int) -> Image.Image:
    r, g, b = (int(colour[i:i + 2], 16) for i in (1, 3, 5))
    yy, xx = np.mgrid[0:size, 0:size]
    c = (size - 1) / 2
    d = np.hypot(xx - c, yy - c) / (size / 2)
    a = np.clip(1 - d, 0, 1) ** 1.6 * 0.8
    arr = np.dstack([np.full((size, size), v, np.uint8) for v in (r, g, b)] + [np.rint(a * 255).astype(np.uint8)])
    return Image.fromarray(arr, "RGBA")


def window_art(card_id: str, diameter: int) -> Image.Image:
    card = index["cards"][card_id]
    canvas = Image.new("RGBA", (diameter, diameter), (0, 0, 0, 255))
    for name in ("back", "mid", "glow", "front"):
        spec = card["stack"][name]
        f = VIEW_DISTANCE / (VIEW_DISTANCE + spec["depth"])
        size = max(1, round(spec["size"] * diameter * f))
        ox, oy = spec.get("offset", [0, 0])
        art = glow(card["glow"], size) if name == "glow" else region(card["layers"][name]).resize(
            (size, size), Image.Resampling.LANCZOS
        )
        x = round(diameter / 2 + ox * diameter * f - size / 2)
        y = round(diameter / 2 - oy * diameter * f - size / 2)
        layer = Image.new("RGBA", canvas.size)
        layer.alpha_composite(art.crop((max(0, -x), max(0, -y), size, size)), (max(0, x), max(0, y)))
        if name == "glow":
            base = np.asarray(canvas).astype(np.int32)
            add = np.asarray(layer).astype(np.int32)
            base[..., :3] += add[..., :3] * add[..., 3:4] // 255
            canvas = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8), "RGBA")
        else:
            canvas.alpha_composite(layer)
    mask = Image.new("L", (diameter * 4, diameter * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, diameter * 4 - 1, diameter * 4 - 1), fill=255)
    out = Image.new("RGBA", canvas.size)
    out.paste(canvas, (0, 0), mask.resize(canvas.size, Image.Resampling.BOX))
    return out


def composed(card_id: str, width: int) -> Image.Image:
    frame_entry = index["frames"][index["cards"][card_id]["frame"]]
    frame = region(frame_entry)
    w, h = frame.size
    win = frame_entry["window"]
    d = round(win["radius"] * w * 2)
    card = Image.new("RGBA", (w, h))
    art = window_art(card_id, d)
    card.alpha_composite(art, (round(win["u"] * w - d / 2), round(win["v"] * h - d / 2)))
    card.alpha_composite(frame)
    return card.resize((width, round(width * h / w)), Image.Resampling.LANCZOS)


def label(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, f=font) -> None:
    draw.text(xy, text, fill=(236, 214, 170), font=f)


def main() -> None:
    ids = list(index["cards"])
    disc = 300
    cols = 5
    margin = 30
    sheet_w = margin + cols * (disc + margin)
    frame_w = 300
    frame_h = round(frame_w * 1016 / 672)
    head_h = round(HEADSET_WIDTH * 1016 / 672)
    big_w = 560
    big_h = round(big_w * 1016 / 672)
    rows = (len(ids) + cols - 1) // cols
    y_frames = 60 + rows * (disc + 50) + 30
    y_head = y_frames + 50 + frame_h + 40
    y_big = y_head + 50 + head_h + 40
    sheet_h = y_big + 50 + big_h + 30
    sheet = Image.new("RGBA", (sheet_w, sheet_h), BG + (255,))
    draw = ImageDraw.Draw(sheet)
    label(draw, (margin, 18), "P5-T5 card illustrations (flattened portal stack, front-on). Creative and owner gates pending.")
    for i, cid in enumerate(ids):
        r, c = divmod(i, cols)
        x, y = margin + c * (disc + margin), 60 + r * (disc + 50)
        sheet.alpha_composite(window_art(cid, disc), (x, y))
        note = " (P4 proof art, reused)" if cid == "strike" else ""
        label(draw, (x, y + disc + 8), f"{cid} [{index['cards'][cid]['type']}]{note}", small)
    label(draw, (margin, y_frames), "Frames: attack, skill, sigil spell (alpha shown over the sheet background)")
    for k, ftype in enumerate(index["frames"]):
        frame = region(index["frames"][ftype]).resize((frame_w, frame_h), Image.Resampling.LANCZOS)
        sheet.alpha_composite(frame, (margin + k * (frame_w + margin), y_frames + 40))
    picks = ["strike", "escapement-hammer", "defend", "release-valve", "cogstorm"]
    label(draw, (margin, y_head), f"Composed at in-headset size ({HEADSET_WIDTH} px wide: 63 mm card at 0.32 m on Quest 3)")
    for k, cid in enumerate(picks):
        sheet.alpha_composite(composed(cid, HEADSET_WIDTH), (margin + k * (HEADSET_WIDTH + 20), y_head + 40))
    label(draw, (margin, y_big), "Composed at 2x for inspection")
    for k, cid in enumerate(["rivet-volley", "lucky-rivets", "arc-bolt"]):
        sheet.alpha_composite(composed(cid, big_w), (margin + k * (big_w + margin), y_big + 40))
    sheet.convert("RGB").save(OUT, quality=90)
    print(OUT.relative_to(ROOT), sheet.size)


if __name__ == "__main__":
    main()
