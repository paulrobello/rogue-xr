"""In-engine stills of the Cog Sentry through the running dev server (make dev-start, port 4260),
without touching src/main.ts: a same-origin page served through Playwright's request routing
imports src/enemies/sentry-proof.ts through Vite, loads the shipped GLB and shared brass sets, and
re-poses the actor through its real entry paths (play, hit, freeze, die) for each shot.

    ~/.local/share/uv/tools/playwright/bin/python3 -I assets-source/enemies/cog-sentry/engine_shot.py

Writes docs/verification/p4-sentry-<name>.jpg and prints each frame's GPU string and mean, so a
black frame or a software renderer is caught.
"""

from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[3]
OUT = REPO / "docs/verification"
ORIGIN = "http://localhost:4260"
W, H = 960, 720
SHOTS = {
    "idle": ("idle", 0.5),
    "attack": ("attack", 0.55),  # mid-swing: the strike key, at the impact event
    "hit": ("hit", 0.1),
    "frozen": ("frozen", 0.0),
    "death": ("death", 2.0),
}
PAGE = """<!doctype html><html><body style="margin:0;background:#000">
<script type="module">
import { mountStandaloneSentryProof } from '/src/enemies/sentry-proof.ts';
try {
  window.__proof = await mountStandaloneSentryProof(%W%, %H%);
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
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chromium", headless=True, args=["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"])
        page = browser.new_page(viewport={"width": W, "height": H})
        errors: list[str] = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.route(f"{ORIGIN}/__sentry-shot*", lambda route: route.fulfill(status=200, content_type="text/html", body=PAGE))
        page.goto(f"{ORIGIN}/__sentry-shot")
        page.wait_for_function("window.__shotReady || window.__shotError", timeout=120_000)
        err = page.evaluate("window.__shotError")
        if err:
            print(f"ERROR {err}")
            return 1
        gpu = page.evaluate("window.__gpu")
        print(f"gpu: {gpu}")
        failed = False
        for name, (clip, t) in SHOTS.items():
            info = page.evaluate(f"window.__proof.pose('{clip}', {t})")
            jpg = OUT / f"p4-sentry-{name}.jpg"
            page.locator("canvas").screenshot(path=str(jpg), type="jpeg", quality=88)
            mean = page.evaluate(MEAN_JS)
            print(f"{name}: {info} mean={mean} -> {jpg.relative_to(REPO)}")
            failed |= sum(mean) < 15
        browser.close()
    for e in errors:
        print(f"console error: {e}")
    return 1 if failed or errors else 0


if __name__ == "__main__":
    sys.exit(main())
