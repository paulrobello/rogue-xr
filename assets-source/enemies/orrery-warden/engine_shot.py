"""In-engine stills of this folder's automaton through the running dev server (make dev-start, port
4260), without touching src/: a same-origin page served through Playwright's request routing
imports engine-proof.ts from this folder through Vite, loads the shipped GLB, manifest and shared
material sets, and poses each clip at the seated player's play distance (2.6 m, eye height 1.2 m).

    ~/.local/share/uv/tools/playwright/bin/python3 -I assets-source/enemies/<id>/engine_shot.py

Writes assets-source/enemies/<id>/staging/engine/<shot>.jpg and prints each frame's GPU string,
draw calls and mean colour, so a black frame or a software renderer is caught.
"""

from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
ID = HERE.name
REPO = HERE.parents[2]
OUT = HERE / "staging/engine"
PROOF = f"/assets-source/enemies/{ID}/engine-proof.ts"
ORIGIN = "http://localhost:4260"
W, H = 960, 720
SHOTS = {"idle": 0.5, "attack": None, "hit": 0.1, "frozen": 0.0, "death": None}  # None: the clip's event time
PAGE = """<!doctype html><html><body style="margin:0;background:#000">
<script type="module">
import { mountAutomatonProof } from '%PROOF%';
try {
  window.__proof = await mountAutomatonProof('%ID%', %W%, %H%);
  const gl = document.querySelector('canvas').getContext('webgl2');
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  window.__gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
  window.__shotReady = true;
} catch (e) { window.__shotError = String((e && e.stack) || e); }
</script></body></html>"""
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
    import json

    manifest = json.loads((REPO / f"public/assets/enemies/{ID}/{ID}.manifest.json").read_text())
    times = {"attack": manifest["clips"]["attack"]["events"]["impact"], "death": manifest["clips"]["death"]["duration"]}
    shots = dict(SHOTS)
    if "phase-change" in manifest["clips"]:  # guardian: mid-transition and the held open end
        pc = manifest["clips"]["phase-change"]
        shots["phase-change-mid"], shots["phase-change-end"] = pc["events"]["open"], pc["duration"]
    page_html = PAGE.replace("%PROOF%", PROOF).replace("%ID%", ID).replace("%W%", str(W)).replace("%H%", str(H))
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chromium", headless=True, args=["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"])
        page = browser.new_page(viewport={"width": W, "height": H})
        errors: list[str] = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.route(f"{ORIGIN}/__automaton-shot*", lambda route: route.fulfill(status=200, content_type="text/html", body=page_html))
        page.goto(f"{ORIGIN}/__automaton-shot")
        page.wait_for_function("window.__shotReady || window.__shotError", timeout=120_000)
        err = page.evaluate("window.__shotError")
        if err:
            print(f"ERROR {err}")
            return 1
        print(f"gpu: {page.evaluate('window.__gpu')}")
        failed = False
        for name, t in shots.items():
            t = times[name] if t is None else t
            clip = "phase-change" if name.startswith("phase-change") else name
            info = page.evaluate(f"window.__proof.pose('{clip}', {t})")
            jpg = OUT / f"{name}.jpg"
            page.locator("canvas").screenshot(path=str(jpg), type="jpeg", quality=88)
            mean = page.evaluate(MEAN_JS)
            print(f"{name}: {info} mean={mean} -> {jpg.relative_to(REPO)}")
            failed |= sum(mean) < 15 or bool(info["unbound"])
        browser.close()
    for e in errors:
        print(f"console error: {e}")
    return 1 if failed or errors else 0


if __name__ == "__main__":
    sys.exit(main())
