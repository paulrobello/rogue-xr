"""In-engine stills of the P5-T1 kit rooms through the running dev server (port 4260), without
touching src/main.ts: a same-origin page routed through Playwright imports
assets-source/rooms/hall/engine-proof.ts through Vite, which loads each room with the runtime's
loadStudyAsset() (shared KTX2 set, lightmap on UV1, baked-room shader patch).

    ~/.local/share/uv/tools/playwright/bin/python3 -I assets-source/rooms/hall/engine_shot.py [--room <id>] [--only <shot-prefix>]

`--room` limits the run to one room's shots, so re-shooting one room never rewrites another room's
provenance-pinned evidence. Shared by P5-T1 (hall, corridor) and P5-T2 (gear-shaft, guardian-vault).

Cameras come from each room's staging/report.json (the Blender review cameras in runtime
coordinates). Writes staging/renders/engine.<shot>.png per room and docs/verification/
p5-rooms-<room>-<shot>.jpg, printing the GPU string, draw calls and each frame's mean colour so a
black frame or a software renderer is caught.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[3]
ROOMS = REPO / "assets-source/rooms"
OUT = REPO / "docs/verification"
ORIGIN = "http://localhost:4260"
W, H = 1280, 720
PAGE = """<!doctype html><html><body style="margin:0;background:#000">
<script type="module">
import { mountKitProof } from '/assets-source/rooms/hall/engine-proof.ts';
try {
  const shot = JSON.parse(decodeURIComponent(location.hash.slice(1)));
  window.__info = await mountKitProof(%W%, %H%, shot);
  const gl = document.querySelector('canvas').getContext('webgl2');
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  window.__gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
  window.__shotReady = true;
} catch (e) { window.__shotError = String((e && e.stack) || e); }
</script></body></html>""".replace("%W%", str(W)).replace("%H%", str(H))

MEAN_JS = """(() => {
  const src = document.querySelector('canvas');
  const c = document.createElement('canvas');
  c.width = 64; c.height = 36;
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0, 64, 36);
  const d = g.getImageData(0, 0, 64, 36).data;
  const m = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) { m[0] += d[i]; m[1] += d[i + 1]; m[2] += d[i + 2]; }
  return m.map((v) => Math.round((v / (d.length / 4)) * 10) / 10);
})()"""


def shots() -> list[tuple[str, str, dict]]:
    """(room the shot belongs to, shot name, Shot config)."""
    out = []
    for room in ("hall", "corridor", "gear-shaft", "guardian-vault"):
        cams = json.loads((ROOMS / room / "staging/report.json").read_text())["cameras_runtime"]
        alone = [{"id": room, "position": [0, 0], "turns": 0}]
        for name, cam in cams.items():
            out.append((room, name, {"rooms": alone, "eye": cam["eye"], "look": cam["look"], "vfov": cam["vfov"], "diffuse": False}))
        hero = cams["hero"]
        out.append((room, "hero.diffuse", {"rooms": alone, "eye": hero["eye"], "look": hero["look"], "vfov": hero["vfov"], "diffuse": True}))
    # Seams: the corridor (0 turns) at (-1, -9) meets the hall's north door; the corridor turned once
    # at (-7, -1) meets the hall's west door.
    north = [{"id": "hall", "position": [0, 0], "turns": 0}, {"id": "corridor", "position": [-1, -9], "turns": 0}]
    west = [{"id": "hall", "position": [0, 0], "turns": 0}, {"id": "corridor", "position": [-9, -1], "turns": 1}]
    out.append(("hall", "seam-north", {"rooms": north, "eye": [-0.6, 1.6, -1.2], "look": [-1.0, 1.5, -12.0], "vfov": 70.0, "diffuse": False}))
    out.append(("corridor", "seam-from-corridor", {"rooms": north, "eye": [-1.0, 1.6, -11.6], "look": [-0.6, 1.2, 0.0], "vfov": 70.0, "diffuse": False}))
    out.append(("hall", "seam-west-turned", {"rooms": west, "eye": [-1.5, 1.6, -0.6], "look": [-12.0, 1.4, -1.0], "vfov": 70.0, "diffuse": False}))

    # Real floor-world path (buildFloorWorld + dressRoom, sealed-door caps): seed KA000013 seals the
    # hall's west door at (-5, -1) (hall at the origin, 0 turns) and the corridor at (-1, -9)'s north
    # door at (-1, -13).
    def floor(at: list[float], eye: list[float], look: list[float]) -> dict:
        return {"rooms": [], "eye": eye, "look": look, "vfov": 70.0, "diffuse": False, "floor": {"seed": "KA000013", "at": at}}

    out.append(("hall", "floor-sealed-west", floor([0, 0], [-2.2, 1.6, 1.0], [-5.0, 1.4, -1.2])))
    out.append(("hall", "floor-sealed-west-close", floor([0, 0], [-4.1, 1.3, 0.5], [-5.0, 0.5, -1.6])))
    out.append(("corridor", "floor-sealed-north", floor([-1, -9], [-1.4, 1.6, -9.6], [-1.0, 1.3, -13.0])))

    # P5-T2. Gear-shaft: the crown gear turned by an arbitrary 37 degrees through getObjectByName (the
    # P5-T12 integration path); the lightmap must still read (no baked shadow breaks); and the north
    # door seam into a corridor at (1, -10).
    gs = [{"id": "gear-shaft", "position": [0, 0], "turns": 0}]
    gcam = json.loads((ROOMS / "gear-shaft/staging/report.json").read_text())["cameras_runtime"]
    for name in ("hero", "ring"):
        c = gcam[name]
        out.append(("gear-shaft", f"{name}-gear-turned", {"rooms": gs, "eye": c["eye"], "look": c["look"], "vfov": c["vfov"], "diffuse": False,
                                                          "spin": {"node": "gear-shaft_gear_ring", "angle": 0.6458}}))
    c = gcam["hero"]
    out.append(("gear-shaft", "hero.diffuse-gear-turned", {"rooms": gs, "eye": c["eye"], "look": c["look"], "vfov": c["vfov"], "diffuse": True,
                                                           "spin": {"node": "gear-shaft_gear_ring", "angle": 0.6458}}))
    gn = [*gs, {"id": "corridor", "position": [1, -10], "turns": 0}]
    out.append(("gear-shaft", "seam-north", {"rooms": gn, "eye": [0.4, 1.6, -3.0], "look": [1.0, 1.5, -14.0], "vfov": 70.0, "diffuse": False}))
    # Guardian vault: its only door (south) into a corridor at (1, 10), seen from the corridor and
    # back; and a brazier close-up beside a known object (the 0.8 m crate height is the scale cue
    # in the gear-shaft; here the 1 m pillar plinth).
    vn = [{"id": "guardian-vault", "position": [0, 0], "turns": 0}, {"id": "corridor", "position": [1, 10], "turns": 0}]
    out.append(("guardian-vault", "seam-from-corridor", {"rooms": vn, "eye": [1.0, 1.6, 12.6], "look": [0.4, 1.8, 0.0], "vfov": 70.0, "diffuse": False}))
    out.append(("guardian-vault", "seam-south", {"rooms": vn, "eye": [0.6, 1.6, 2.0], "look": [1.0, 1.3, 13.0], "vfov": 70.0, "diffuse": False}))
    out.append(("guardian-vault", "reward-eye", {"rooms": vn[:1], "eye": [0.3, 1.6, -1.0], "look": [0.0, 1.6, -6.0], "vfov": 70.0, "diffuse": False}))
    return out


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    failed = False
    errors: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chromium", headless=True, args=["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"])
        only = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else ""
        only_room = sys.argv[sys.argv.index("--room") + 1] if "--room" in sys.argv else ""
        for room, name, shot in shots():
            if not name.startswith(only) or (only_room and room != only_room):
                continue
            page = browser.new_page(viewport={"width": W, "height": H})
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.route(f"{ORIGIN}/__kit-shot*", lambda route: route.fulfill(status=200, content_type="text/html", body=PAGE))
            from urllib.parse import quote

            page.goto(f"{ORIGIN}/__kit-shot#{quote(json.dumps(shot))}")
            page.wait_for_function("window.__shotReady || window.__shotError", timeout=120_000)
            err = page.evaluate("window.__shotError")
            if err:
                print(f"{room} {name}: ERROR {err}")
                failed = True
                page.close()
                continue
            renders = ROOMS / room / "staging/renders"
            png = renders / f"engine.{name}.png"
            page.locator("canvas").screenshot(path=str(png))
            jpg = OUT / f"p5-rooms-{room}-{name}.jpg"
            page.locator("canvas").screenshot(path=str(jpg), type="jpeg", quality=90)
            mean = page.evaluate(MEAN_JS)
            print(f"{room} {name}: {page.evaluate('window.__info')} gpu={page.evaluate('window.__gpu')} mean={mean} -> {jpg.relative_to(REPO)}")
            failed |= sum(mean) < 15
            page.close()
        browser.close()
    for e in errors:
        print(f"console error: {e}")
    return 1 if failed or errors else 0


if __name__ == "__main__":
    sys.exit(main())
