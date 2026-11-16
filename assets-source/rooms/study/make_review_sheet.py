"""Owner review sheet for the study (system Python with Pillow):

    python3 -I assets-source/rooms/study/make_review_sheet.py

Panels: approved concept, lightmap-lit textured EEVEE still, same-camera high and low EEVEE renders,
Cycles diffuse reference, and two in-engine three.js frames. Writes staging/review-sheet.jpg.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
R = HERE / "staging/renders"
ROOT = HERE.parents[2]
TILE = (640, 360)
PANELS = [
    (ROOT / "assets-source/concepts/room-sheet-1.png", "Approved concept (room-sheet-1, panel 1)", (48, 28, 2712, 812)),
    (R / "hero.lightmapped.png", "Textured EEVEE still, lit by the shipped lightmap", None),
    (R / "hero.high.png", "High poly, EEVEE, hero camera (124,581 tris)", None),
    (R / "hero.low.png", "Low poly, EEVEE, same camera (6,948 tris)", None),
    (R / "hero.reference-diffuse.png", "Cycles diffuse reference (lightmap validation)", None),
    (R / "engine.hero.diffuse.png", "three.js, lightmap only, no tone mapping", None),
    (R / "engine.hero.png", "In engine: three.js 0.186.1, KTX2 maps, AgX", None),
    (R / "engine.desk.png", "In engine: desk corner, KTX2 maps, AgX", None),
]


def font(size: int) -> ImageFont.ImageFont:
    for path in ("/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main() -> None:
    cols, pad, label_h = 2, 12, 30
    rows = (len(PANELS) + cols - 1) // cols
    head = 56
    sheet = Image.new("RGB", (cols * TILE[0] + (cols + 1) * pad, head + rows * (TILE[1] + label_h + pad) + pad), (24, 20, 18))
    draw = ImageDraw.Draw(sheet)
    draw.text((pad, 14), "P4-T4 hero study: review sheet (owner and creative gates pending)", fill=(243, 190, 101), font=font(24))
    for i, (path, label, crop) in enumerate(PANELS):
        img = Image.open(path).convert("RGB")
        if crop:
            img = img.crop(crop)
        img = img.resize(TILE, Image.LANCZOS) if crop is None else _fit(img)
        x = pad + (i % cols) * (TILE[0] + pad)
        y = head + (i // cols) * (TILE[1] + label_h + pad)
        sheet.paste(img, (x + (TILE[0] - img.width) // 2, y))
        draw.text((x, y + TILE[1] + 4), label, fill=(222, 193, 106), font=font(18))
    out = HERE / "staging/review-sheet.jpg"
    sheet.save(out, quality=90)
    print(out)


def _fit(img: Image.Image) -> Image.Image:
    scale = min(TILE[0] / img.width, TILE[1] / img.height)
    return img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)


if __name__ == "__main__":
    main()
