#!/usr/bin/env python3
"""Generate the Clockwork Spire favicon and PWA icon suite into public/.

The brand mark is the hand-built SVG master in assets-source/brand/: mark.svg for 48 px and up,
mark-16.svg (simplified) for the 16 and 32 px favicon frames and favicon.svg. This script only
rasterizes those files and composites them onto generated backgrounds, so edits go to the SVGs.

Also writes docs/verification/launch-favicon-16-32.png and docs/verification/launch-icons.png,
built from the shipped files (decoded back from favicon.ico and the PNGs), not fresh renders.

Requires rsvg-convert (librsvg) on PATH and Pillow. Output is deterministic.
Usage: python3 -I scripts/assets/gen-icons.py
"""

from __future__ import annotations

import io
import math
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / "assets-source" / "brand"
PUBLIC = ROOT / "public"
VERIFY = ROOT / "docs" / "verification"
FONT = ROOT / "public" / "fonts" / "NotoSans-Regular.ttf"

# docs/art-bible.md palette, mirrored by src/palette.ts.
VOID = "#120c07"
WARM_BLACK = "#231d1a"
BRASS = "#dec16a"
BRASS_DARK = "#7a5522"
CANDLE = "#f3be65"

# mark.svg geometry in its 64-unit viewBox: the point the mark is centred on and the radius of
# the smallest circle around it that holds every painted pixel (outline included).
MARK_CENTRE = (32.0, 31.0)
MARK_RADIUS = 31.4

MASKABLE_SAFE = 0.4  # radius of the maskable safe circle as a fraction of the icon size


def rsvg(svg: bytes, size: int) -> Image.Image:
    png = subprocess.run(
        ["rsvg-convert", "-w", str(size), "-h", str(size)],
        input=svg,
        capture_output=True,
        check=True,
    ).stdout
    return Image.open(io.BytesIO(png)).convert("RGBA")


def mark(name: str, size: int) -> Image.Image:
    return rsvg((BRAND / name).read_bytes(), size)


def backdrop(size: int, disc: bool) -> Image.Image:
    """Warm-black ground with a low candle glow. disc=True is a brass-rimmed medallion like the
    UI icon sheet (transparent corners); disc=False is an opaque full-bleed square."""
    ground = (
        '<radialGradient id="ground" cx="0.5" cy="0.42" r="0.62">'
        f'<stop offset="0" stop-color="#3a2b1d"/><stop offset="0.55" stop-color="{WARM_BLACK}"/>'
        f'<stop offset="1" stop-color="{VOID}"/></radialGradient>'
        '<radialGradient id="glow" cx="0.5" cy="0.36" r="0.4">'
        f'<stop offset="0" stop-color="{CANDLE}" stop-opacity="0.28"/>'
        f'<stop offset="1" stop-color="{CANDLE}" stop-opacity="0"/></radialGradient>'
        '<linearGradient id="rim" x1="0.2" y1="0" x2="0.8" y2="1">'
        f'<stop offset="0" stop-color="#f6dc8e"/><stop offset="0.5" stop-color="{BRASS}"/>'
        f'<stop offset="1" stop-color="{BRASS_DARK}"/></linearGradient>'
    )
    if disc:
        body = (
            f'<circle cx="50" cy="50" r="49" fill="{VOID}"/>'
            '<circle cx="50" cy="50" r="45.5" fill="url(#ground)"/>'
            '<circle cx="50" cy="50" r="45.5" fill="url(#glow)"/>'
            '<circle cx="50" cy="50" r="46" fill="none" stroke="url(#rim)" stroke-width="3.2"/>'
            f'<circle cx="50" cy="50" r="44" fill="none" stroke="{VOID}" stroke-width="0.8"/>'
        )
    else:
        body = (
            '<rect width="100" height="100" fill="url(#ground)"/>'
            '<rect width="100" height="100" fill="url(#glow)"/>'
        )
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
        f"<defs>{ground}</defs>{body}</svg>"
    )
    return rsvg(svg.encode(), size)


def tile(size: int, mark_radius: float, disc: bool) -> Image.Image:
    """Backdrop plus mark.svg scaled so its bounding circle has radius mark_radius * size."""
    scale = mark_radius * size / MARK_RADIUS  # pixels per mark unit
    render = round(64 * scale)
    scale = render / 64
    img = backdrop(size, disc)
    m = mark("mark.svg", render)
    x = round(size / 2 - MARK_CENTRE[0] * scale)
    y = round(size / 2 - MARK_CENTRE[1] * scale)
    img.alpha_composite(m, (x, y))
    return img


def painted_radius(m: Image.Image, cx: float, cy: float) -> float:
    """Largest distance from (cx, cy) to a pixel with any alpha."""
    alpha = m.getchannel("A")
    w, h = m.size
    px = alpha.load()
    best = 0.0
    for yy in range(h):
        for xx in range(w):
            if px[xx, yy] > 0:
                d = math.hypot(xx + 0.5 - cx, yy + 0.5 - cy)
                best = max(best, d)
    return best


def save_png(img: Image.Image, path: Path, opaque: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    (img.convert("RGB") if opaque else img).save(path, optimize=True)


def font(px: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONT), px)


def verify_favicons() -> None:
    """Favicon frames decoded from the shipped favicon.ico (16, 32) and favicon-96x96.png on light
    and dark tab colours, at 1x and nearest-neighbour enlarged."""
    ico = Image.open(PUBLIC / "favicon.ico")
    frames: dict[int, Image.Image] = {}
    for s in (16, 32, 48):
        ico.size = (s, s)
        ico.load()
        frames[s] = ico.convert("RGBA").copy()
    svg32 = rsvg((PUBLIC / "favicon.svg").read_bytes(), 32)
    backgrounds = [("light", "#ffffff"), ("light grey", "#f1f3f4"), ("dark", "#202124"), ("tab dark", "#35363a")]
    cols = [("ico 16", frames[16], 10), ("ico 32", frames[32], 5), ("svg @32", svg32, 5), ("ico 48", frames[48], 4)]
    cell = 200
    label_h = 34
    out = Image.new("RGB", (len(cols) * cell + 150, len(backgrounds) * cell + label_h), VOID)
    d = ImageDraw.Draw(out)
    f = font(18)
    for ci, (name, _, _) in enumerate(cols):
        d.text((150 + ci * cell + 12, 8), name, fill=BRASS, font=f)
    for ri, (bname, bg) in enumerate(backgrounds):
        y0 = label_h + ri * cell
        d.text((12, y0 + cell // 2 - 12), bname, fill=BRASS, font=f)
        for ci, (_, img, zoom) in enumerate(cols):
            x0 = 150 + ci * cell
            swatch = Image.new("RGBA", (cell - 8, cell - 8), bg)
            big = img.resize((img.width * zoom, img.height * zoom), Image.NEAREST)
            swatch.alpha_composite(big, ((swatch.width - big.width) // 2, (swatch.height - big.height) // 2 - 14))
            swatch.alpha_composite(img, (8, swatch.height - img.height - 8))
            out.paste(swatch.convert("RGB"), (x0 + 4, y0 + 4))
    out.save(VERIFY / "launch-favicon-16-32.png", optimize=True)


def verify_icons() -> None:
    """The shipped 192, 512, maskable and apple-touch icons with the maskable safe circle drawn on
    the maskable one, plus the maskable icon under circle and squircle masks."""
    names = [
        ("icon-192 (any)", PUBLIC / "icons" / "icon-192.png"),
        ("icon-512 (any)", PUBLIC / "icons" / "icon-512.png"),
        ("maskable-512 + 80% safe circle", PUBLIC / "icons" / "icon-maskable-512.png"),
        ("apple-touch-icon 180", PUBLIC / "apple-touch-icon.png"),
    ]
    cell = 300
    label_h = 36
    out = Image.new("RGB", (cell * 4, cell + label_h + cell), "#3b3f45")
    d = ImageDraw.Draw(out)
    f = font(17)
    for i, (name, path) in enumerate(names):
        img = Image.open(path).convert("RGBA")
        shown = img.resize((256, 256), Image.LANCZOS) if img.width != 256 else img
        if "maskable" in name:
            ov = Image.new("RGBA", shown.size, (0, 0, 0, 0))
            od = ImageDraw.Draw(ov)
            r = MASKABLE_SAFE * 256
            od.ellipse((128 - r, 128 - r, 128 + r, 128 + r), outline=(80, 220, 255, 255), width=2)
            shown = Image.alpha_composite(shown, ov)
        x0 = i * cell + (cell - 256) // 2
        out.paste(shown.convert("RGB"), (x0, label_h + 22), shown)
        d.text((i * cell + 12, 8), name, fill="#f2dfb8", font=f)
    # Masked previews of the maskable icon: circle, squircle, rounded square, and Android 48 px.
    mk = Image.open(PUBLIC / "icons" / "icon-maskable-512.png").convert("RGBA").resize((256, 256), Image.LANCZOS)
    y0 = cell + label_h
    masks = []
    circle = Image.new("L", (256, 256), 0)
    ImageDraw.Draw(circle).ellipse((0, 0, 255, 255), fill=255)
    masks.append(("mask: circle", circle))
    rr = Image.new("L", (256, 256), 0)
    ImageDraw.Draw(rr).rounded_rectangle((0, 0, 255, 255), radius=60, fill=255)
    masks.append(("mask: rounded square", rr))
    small_safe = Image.new("L", (256, 256), 0)
    ImageDraw.Draw(small_safe).ellipse((26, 26, 230, 230), fill=255)
    masks.append(("mask: 80% circle (minimum)", small_safe))
    for i, (name, m) in enumerate(masks):
        x0 = i * cell + (cell - 256) // 2
        out.paste(mk.convert("RGB"), (x0, y0 + 22), m)
        d.text((i * cell + 12, y0 + 2), name, fill="#f2dfb8", font=f)
    d.text((3 * cell + 12, y0 + 2), "maskable at 48 px (x4)", fill="#f2dfb8", font=f)
    tiny = Image.open(PUBLIC / "icons" / "icon-maskable-512.png").convert("RGBA").resize((48, 48), Image.LANCZOS)
    cm = Image.new("L", (48, 48), 0)
    ImageDraw.Draw(cm).ellipse((0, 0, 47, 47), fill=255)
    tiny_bg = Image.new("RGBA", (48, 48), (0, 0, 0, 0))
    tiny_bg.paste(tiny, (0, 0), cm)
    tiny_big = tiny_bg.resize((192, 192), Image.NEAREST)
    out.paste(tiny_big, (3 * cell + (cell - 192) // 2, y0 + 50), tiny_big)
    out.save(VERIFY / "launch-icons.png", optimize=True)


def main() -> None:
    # Favicons: the 16 px cut is what browsers draw in tabs, so it ships as favicon.svg and the
    # 16 and 32 px ICO frames; the detailed master takes 48 px and up.
    (PUBLIC / "favicon.svg").write_bytes((BRAND / "mark-16.svg").read_bytes())
    f16 = mark("mark-16.svg", 16)
    f32 = mark("mark-16.svg", 32)
    f48 = mark("mark.svg", 48)
    f48.save(PUBLIC / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)], append_images=[f16, f32])
    save_png(mark("mark.svg", 96), PUBLIC / "favicon-96x96.png")

    save_png(tile(192, 0.36, disc=True), PUBLIC / "icons" / "icon-192.png")
    save_png(tile(512, 0.36, disc=True), PUBLIC / "icons" / "icon-512.png")
    save_png(tile(180, 0.38, disc=False), PUBLIC / "apple-touch-icon.png", opaque=True)

    maskable = tile(512, 0.37, disc=False)
    save_png(maskable, PUBLIC / "icons" / "icon-maskable-512.png", opaque=True)
    # The mark (outline included) must sit inside the 80% safe circle.
    scale = round(64 * 0.37 * 512 / MARK_RADIUS) / 64
    probe = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    probe.alpha_composite(
        mark("mark.svg", round(64 * scale)),
        (round(256 - MARK_CENTRE[0] * scale), round(256 - MARK_CENTRE[1] * scale)),
    )
    reach = painted_radius(probe, 256, 256)
    limit = MASKABLE_SAFE * 512
    if reach > limit:
        raise SystemExit(f"maskable mark reaches {reach:.1f} px, safe circle is {limit:.1f} px")
    print(f"maskable mark reach {reach:.1f} px of {limit:.1f} px safe radius")

    VERIFY.mkdir(parents=True, exist_ok=True)
    verify_favicons()
    verify_icons()
    print("icons written to", PUBLIC)


if __name__ == "__main__":
    main()
