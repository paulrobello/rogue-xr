"""In-engine stills of the P5-T7 dice through the running dev server (port 4260), without touching
src/main.ts: a same-origin page routed through Playwright imports assets-source/dice/engine-proof.ts
through Vite, which loads the shipped GLBs with loadDice(), binds the UI atlas KTX2 pages and poses
each die with the presenter's correction.

    ~/.local/share/uv/tools/playwright/bin/python3 -I assets-source/dice/engine_shot.py [--bench]

Writes docs/verification/p5-dice-<id>.jpg and p5-dice-<id>-lineup.jpg, printing the GPU string, the
draw and program counts and each frame's mean colour, so a black frame or a software renderer is
caught. --bench adds a desktop-only A/B of the faked-glass face against an opaque face.
"""

from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "docs/verification"
ORIGIN = "http://localhost:4260"
W, H = 960, 640
DICE = {"d6": "brass-d6", "d8": "glass-d8"}
PAGE = """<!doctype html><html><body style="margin:0;background:#000">
<script type="module">
import { mountDiceProof } from '/assets-source/dice/engine-proof.ts';
try {
  window.__proof = await mountDiceProof(%W%, %H%);
  const gl = document.querySelector('canvas').getContext('webgl2');
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  window.__gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
  window.__shotReady = true;
} catch (e) { window.__shotError = String((e && e.stack) || e); }
</script></body></html>""".replace("%W%", str(W)).replace("%H%", str(H))

MEAN_JS = """(() => {
  const src = document.querySelector('canvas');
  const c = document.createElement('canvas');
  c.width = 64; c.height = 48;
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0, 64, 48);
  const d = g.getImageData(0, 0, 64, 48).data;
  const m = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) { m[0] += d[i]; m[1] += d[i + 1]; m[2] += d[i + 2]; }
  return m.map((v) => Math.round((v / (d.length / 4)) * 10) / 10);
})()"""


def main() -> int:
    bench = "--bench" in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chromium", headless=True, args=["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"])
        page = browser.new_page(viewport={"width": W, "height": H})
        errors: list[str] = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.route(f"{ORIGIN}/__dice-shot*", lambda route: route.fulfill(status=200, content_type="text/html", body=PAGE))
        page.goto(f"{ORIGIN}/__dice-shot")
        page.wait_for_function("window.__shotReady || window.__shotError", timeout=120_000)
        err = page.evaluate("window.__shotError")
        if err:
            print(f"ERROR {err}")
            return 1
        print(f"gpu: {page.evaluate('window.__gpu')}")
        failed = False
        for kind, die in DICE.items():
            for mode, suffix in (("hero", ""), ("lineup", "-lineup")):
                info = page.evaluate(f"window.__proof.show('{kind}', '{mode}')")
                jpg = OUT / f"p5-dice-{die}{suffix}.jpg"
                page.locator("canvas").screenshot(path=str(jpg), type="jpeg", quality=90)
                mean = page.evaluate(MEAN_JS)
                print(f"{die} {mode}: {info} mean={mean} -> {jpg.relative_to(REPO)}")
                failed |= sum(mean) < 15
        if bench:
            for kind in ("d8", "d6"):
                for opaque in (False, True):
                    print("bench", page.evaluate(f"window.__proof.bench('{kind}', 64, 400, {'true' if opaque else 'false'})"))
        browser.close()
    for e in errors:
        print(f"console error: {e}")
    return 1 if failed or errors else 0


if __name__ == "__main__":
    sys.exit(main())
