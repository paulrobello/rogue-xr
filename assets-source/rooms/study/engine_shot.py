"""In-engine shots of the study through the running dev server (make dev-start, port 4260), without
touching src/main.ts: a same-origin page served through Playwright's request routing imports
src/world/room-asset-proof.ts through Vite and renders one frame per query.

    ~/.local/share/uv/tools/playwright/bin/python3 -I assets-source/rooms/study/engine_shot.py

Writes staging/renders/engine.<name>.png and prints each frame's mean so a black frame is caught.
"""

from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
OUT = HERE / "staging/renders"
ORIGIN = "http://localhost:4260"
W, H = 1280, 720
SHOTS = {
    "hero": "cam=hero&tex=ktx2",
    "desk": "cam=desk&tex=ktx2",
    "hero.png-maps": "cam=hero&tex=png",
    "hero.diffuse": "cam=hero&tex=ktx2&tone=none&diffuse=1",
}
PAGE = """<!doctype html><html><body style="margin:0;background:#000">
<script type="module">
import { mountStandaloneRoomAssetProof } from '/src/world/room-asset-proof.ts';
try {
  window.__shotInfo = await mountStandaloneRoomAssetProof(%W%, %H%);
  const gl = document.querySelector('canvas').getContext('webgl2');
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  window.__shotInfo.gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
  window.__shotReady = true;
} catch (e) { window.__shotError = String((e && e.stack) || e); }
</script></body></html>""".replace("%W%", str(W)).replace("%H%", str(H))


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    failed = False
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chromium", headless=True, args=["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"])
        for name, query in SHOTS.items():
            page = browser.new_page(viewport={"width": W, "height": H})
            page.on("console", lambda m: print("  console:", m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: print("  pageerror:", e))
            page.route(f"{ORIGIN}/__room-shot*", lambda route: route.fulfill(status=200, content_type="text/html", body=PAGE))
            page.goto(f"{ORIGIN}/__room-shot?view=room-asset-proof&{query}")
            page.wait_for_function("window.__shotReady || window.__shotError", timeout=90_000)
            err = page.evaluate("window.__shotError")
            if err:
                print(f"{name}: ERROR {err}")
                failed = True
                continue
            info = page.evaluate("window.__shotInfo")
            path = OUT / f"engine.{name}.png"
            page.locator("canvas").screenshot(path=str(path))
            print(f"{name}: {info} -> {path.name}")
            page.close()
        browser.close()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
