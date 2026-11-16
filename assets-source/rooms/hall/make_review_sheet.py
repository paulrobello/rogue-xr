"""Owner review sheet for a P5-T1 kit room (system Python with Pillow):

    python3 -I assets-source/rooms/hall/make_review_sheet.py hall|corridor

Panels: the kit-language reference (no template-specific concept exists), the lightmap-lit
textured EEVEE still, same-camera high and low EEVEE renders, the Cycles diffuse reference beside
the three.js lightmap-only frame, and in-engine frames (both cameras and the door seams). Writes
assets-source/rooms/<room>/staging/review-sheet.jpg.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[3]
TILE = (640, 360)


def panels(room: str) -> list[tuple[Path, str, tuple | None]]:
    src = ROOT / f"assets-source/rooms/{room}"
    r = src / "staging/renders"
    report = json.loads((src / "staging/report.json").read_text())
    cams = list(report["cameras_runtime"])
    second = cams[1]
    v = ROOT / "docs/verification"
    seams = {"hall": [("seam-north", "In engine: north door into the corridor (seam)"), ("seam-west-turned", "In engine: west door, corridor turned once (seam)"),
                      ("floor-sealed-west", "Floor world KA000013: sealed west door (runtime cap)")],
             "corridor": [("seam-from-corridor", "In engine: corridor into the hall's north door (seam)"),
                          ("floor-sealed-north", "Floor world KA000013: sealed north door (runtime cap)")]}[room]
    out = [
        (ROOT / "assets-source/concepts/room-sheet-1.png", "Kit reference: study concept (no hall/corridor sheet)", (48, 28, 2712, 812)),
        (r / "hero.lightmapped.png", "Textured EEVEE still, lit by the shipped lightmap", None),
        (r / "hero.high.png", f"High poly, EEVEE, hero camera ({report['high']['triangles']:,} tris)", None),
        (r / "hero.low.png", f"Low poly, EEVEE, same camera ({report['low']['triangles']:,} tris)", None),
        (r / "hero.reference-diffuse.png", "Cycles diffuse reference (lightmap validation)", None),
        (r / "engine.hero.diffuse.png", "three.js, lightmap only, no tone mapping", None),
        (r / "engine.hero.png", "In engine: three.js 0.186.1, KTX2 set + lightmap, AgX", None),
        (r / f"engine.{second}.png", f"In engine: {second} camera", None),
    ]
    out += [(v / f"p5-rooms-{room}-{name}.jpg", label, None) for name, label in seams]
    return out


def font(size: int) -> ImageFont.ImageFont:
    for path in ("/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def fit(img: Image.Image) -> Image.Image:
    scale = min(TILE[0] / img.width, TILE[1] / img.height)
    return img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)


def main(room: str) -> None:
    items = panels(room)
    cols, pad, label_h, head = 2, 12, 30, 56
    rows = (len(items) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * TILE[0] + (cols + 1) * pad, head + rows * (TILE[1] + label_h + pad) + pad), (24, 20, 18))
    draw = ImageDraw.Draw(sheet)
    draw.text((pad, 14), f"P5-T1 {room}: review sheet (concept, creative and owner gates pending)", fill=(243, 190, 101), font=font(24))
    for i, (path, label, crop) in enumerate(items):
        img = Image.open(path).convert("RGB")
        img = fit(img.crop(crop)) if crop else img.resize(TILE, Image.LANCZOS)
        x = pad + (i % cols) * (TILE[0] + pad)
        y = head + (i // cols) * (TILE[1] + label_h + pad)
        sheet.paste(img, (x + (TILE[0] - img.width) // 2, y))
        draw.text((x, y + TILE[1] + 4), label, fill=(222, 193, 106), font=font(18))
    out = ROOT / f"assets-source/rooms/{room}/staging/review-sheet.jpg"
    sheet.save(out, quality=90)
    print(out)


if __name__ == "__main__":
    main(sys.argv[1])
