#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = ["playwright==1.65.2", "pillow>=12"]
# ///
"""Render the Clockwork Spire share card (public/og-image.png, 1200x630) from og.html.

og.html composites the existing title key art (public/assets/ui/title-2048.jpg), the brand mark
(assets-source/brand/mark.svg) and the title set in the project's Noto Sans. Nothing is generated.
The screenshot is palette-quantized with Pillow to stay under the 600 KB share-image budget, and a
copy goes to docs/verification/launch-og-image.png.

Usage: uv run scripts/assets/og/render-og.py   (headless Chromium from the Playwright cache;
on a fresh host run `uvx playwright@1.65.2 install chromium` once first)
"""

from __future__ import annotations

import io
import shutil
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OUT = ROOT / "public" / "og-image.png"
VERIFY = ROOT / "docs" / "verification" / "launch-og-image.png"
WIDTH, HEIGHT = 1200, 630
BUDGET = 600 * 1024


def screenshot() -> bytes:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": WIDTH, "height": HEIGHT}, device_scale_factor=1)
        page.goto((HERE / "og.html").as_uri())
        page.evaluate(
            "async () => { await document.fonts.ready;"
            " await Promise.all([...document.images].map((i) => i.decode())); }"
        )
        status = page.evaluate(
            "[...document.fonts].filter((f) => f.family.replace(/\"/g, '') === 'Spire Noto Sans')"
            ".map((f) => f.status)"
        )
        if status != ["loaded"]:
            raise SystemExit(f"Noto Sans did not load: {status}")
        png = page.screenshot(clip={"x": 0, "y": 0, "width": WIDTH, "height": HEIGHT})
        browser.close()
    return png


def main() -> None:
    raw = Image.open(io.BytesIO(screenshot())).convert("RGB")
    if raw.size != (WIDTH, HEIGHT):
        raise SystemExit(f"screenshot is {raw.size}, expected {(WIDTH, HEIGHT)}")
    # 256-colour palette with Floyd-Steinberg dithering keeps the painted gradients free of banding.
    quant = raw.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    quant.save(OUT, optimize=True)
    size = OUT.stat().st_size
    if size > BUDGET:
        raise SystemExit(f"og-image.png is {size} bytes, budget {BUDGET}")
    VERIFY.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(OUT, VERIFY)
    print(f"wrote {OUT} ({size} bytes)")


if __name__ == "__main__":
    main()
