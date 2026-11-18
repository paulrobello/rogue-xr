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
import math
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[3]
ROOMS = REPO / "assets-source/rooms"
OUT = REPO / "docs/verification"
ORIGIN = os.environ.get("RXR_ORIGIN", "http://localhost:4260")
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
    for room in ("study", "hall", "corridor", "gear-shaft", "guardian-vault"):
        cams = json.loads((ROOMS / room / "staging/report.json").read_text()).get("cameras_runtime") or FALLBACK_CAMERAS[room]
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
    def floor(at: list[float], eye: list[float], look: list[float], seed: str = "KA000013", kit: list[str] | None = None) -> dict:
        spec = {"seed": seed, "at": at, **({"kit": kit} if kit else {})}
        return {"rooms": [], "eye": eye, "look": look, "vfov": 70.0, "diffuse": False, "floor": spec}

    out.append(("hall", "floor-sealed-west", floor([0, 0], [-2.2, 1.6, 1.0], [-5.0, 1.4, -1.2])))
    out.append(("hall", "floor-sealed-west-close", floor([0, 0], [-4.1, 1.3, 0.5], [-5.0, 0.5, -1.6])))
    out.append(("corridor", "floor-sealed-north", floor([-1, -9], [-1.4, 1.6, -9.6], [-1.0, 1.3, -13.0])))

    # P5-T2. Gear-shaft: the train turned by an arbitrary 37 degrees of the crown gear through
    # getObjectByName (the P5-T12 integration path), every rigid node at its manifest rate from one
    # clock; the lightmap must still read (no baked shadow breaks); and the north door seam into a
    # corridor at (1, -10).
    gs = [{"id": "gear-shaft", "position": [0, 0], "turns": 0}]
    gcam = json.loads((ROOMS / "gear-shaft/staging/report.json").read_text())["cameras_runtime"]
    for name in ("hero", "ring"):
        c = gcam[name]
        out.append(("gear-shaft", f"{name}-gear-turned", {"rooms": gs, "eye": c["eye"], "look": c["look"], "vfov": c["vfov"], "diffuse": False,
                                                          "spin": train_spin(0.6458)}))
    c = gcam["hero"]
    out.append(("gear-shaft", "hero.diffuse-gear-turned", {"rooms": gs, "eye": c["eye"], "look": c["look"], "vfov": c["vfov"], "diffuse": True,
                                                           "spin": train_spin(0.6458)}))
    # The meshing train in the shaft void from under the ceiling hole, at eight crown angles over a
    # full turn (the counter gear at the manifest rate ratio): teeth must sit in gaps in every frame.
    for k in range(8):
        out.append(("gear-shaft", f"mesh-{k * 45:03d}", {"rooms": gs, "eye": [1.75, 4.7, 0.55], "look": [0.6, 5.85, -0.6], "vfov": 60.0,
                                                         "diffuse": False, "spin": train_spin(k * math.pi / 4)}))
    # The same eight frames as baked light alone (white albedo, no maps, metalness 0): the gears'
    # lighting must not turn with them, so a fixed screen region reads the same L* at every angle.
    for k in range(8):
        out.append(("gear-shaft", f"mesh-lm-{k * 45:03d}", {"rooms": gs, "eye": [1.75, 4.7, 0.55], "look": [0.6, 5.85, -0.6], "vfov": 60.0,
                                                            "diffuse": True, "light": {"whiteAlbedo": True}, "spin": train_spin(k * math.pi / 4)}))
    # A boarded door on the real floor path: seed KA000050 boards the north door of the gear shaft at
    # (-10, -1) (0 turns, door at world (-9, -7)); the frame shows with the walnut boards over it.
    gsf = {"seed": "KA000050", "kit": ["gear-shaft"]}
    out.append(("gear-shaft", "floor-boarded-n", floor([-10, -1], [-9.8, 1.3, -4.6], [-9.0, 1.0, -7.0], **gsf)))
    out.append(("gear-shaft", "floor-boarded-n-close", floor([-10, -1], [-9.0, 0.75, -6.1], [-9.75, 0.25, -7.0], **gsf)))
    gn = [*gs, {"id": "corridor", "position": [1, -10], "turns": 0}]
    out.append(("gear-shaft", "seam-north", {"rooms": gn, "eye": [0.4, 1.6, -3.0], "look": [1.0, 1.5, -14.0], "vfov": 70.0, "diffuse": False}))
    # Guardian vault: its only door (south) into a corridor at (1, 10), seen from the corridor and
    # back; and a brazier close-up beside a known object (the 0.8 m crate height is the scale cue
    # in the gear-shaft; here the 1 m pillar plinth).
    vn = [{"id": "guardian-vault", "position": [0, 0], "turns": 0}, {"id": "corridor", "position": [1, 10], "turns": 0}]
    out.append(("guardian-vault", "seam-from-corridor", {"rooms": vn, "eye": [1.0, 1.6, 12.6], "look": [0.4, 1.8, 0.0], "vfov": 70.0, "diffuse": False}))
    out.append(("guardian-vault", "seam-south", {"rooms": vn, "eye": [0.6, 1.6, 2.0], "look": [1.0, 1.3, 13.0], "vfov": 70.0, "diffuse": False}))
    out.append(("guardian-vault", "reward-eye", {"rooms": vn[:1], "eye": [0.3, 1.6, -1.0], "look": [0.0, 1.6, -6.0], "vfov": 70.0, "diffuse": False}))
    # Door panels (room_panels.py): one wall per room, seen from inside at the seated eye (1.2 m),
    # with the door plugged (dressRoom's wall-style seal: plug shown, frame hidden) and open.
    for room, door, eye, look in PLUG_SHOTS:
        alone = [{"id": room, "position": [0, 0], "turns": 0}]
        for state, plugged in (("in", [door]), ("out", [])):
            out.append((room, f"plug-{door}-{state}", {"rooms": alone, "eye": eye, "look": look, "vfov": 70.0, "diffuse": False,
                                                        "plugged": plugged}))
    return out


def train_spin(crown: float) -> list[dict]:
    """Every gear-shaft rigid node turned as the runtime turns it when the crown gear is at `crown`
    radians: angle = radPerSec x one shared clock (floor-view.ts rigidAngle)."""
    nodes = json.loads((REPO / "public/assets/rooms/gear-shaft/gear-shaft.manifest.json").read_text())["rigidNodes"]
    clock = crown / nodes[0]["radPerSec"]
    return [{"node": n["node"], "angle": n["radPerSec"] * clock} for n in nodes]


# (room, template door id, eye, look) in runtime coordinates, room at the origin unturned.
PLUG_SHOTS = [
    ("study", "e", [1.0, 1.2, 0.3], [4.0, 1.1, -1.0]),
    ("hall", "n", [-0.2, 1.2, -2.0], [-1.0, 1.1, -5.0]),
    ("corridor", "n", [0.35, 1.2, -1.2], [0.0, 1.1, -4.0]),
    ("gear-shaft", "w", [-2.1, 1.2, 2.6], [-4.0, 1.1, 1.0]),
    ("guardian-vault", "s", [0.3, 1.2, 3.2], [1.0, 1.1, 6.0]),
]


VARIANT_OUT = Path(os.environ.get("RXR_VARIANT_DIR", "/tmp/rxr-room-light"))
# Room-light investigation (engine-proof.ts `light` toggles). Written only under VARIANT_OUT as
# <room>.<camera>.<variant>.png, never to staging/renders or docs/verification (sha256-pinned evidence).
VARIANTS: dict[str, dict] = {
    "base": {},
    "lm-agx": {"envOff": True},
    "no-ibl-diffuse": {"envDiffuse": False},
    "no-ibl-diffuse-g115": {"envDiffuse": False, "lightmapGain": 1.15},
    "game": {"gameLights": True},
    "game-dynamic": {"gameLights": True, "dynamicLights": True},
    "fix-game-dynamic": {"envDiffuse": False, "gameLights": True, "dynamicLights": True},
    "no-ao": {"aoIntensity": 0},
    "lm-agx-no-ao": {"envOff": True, "aoIntensity": 0},
}
VARIANT_CAMERAS = {"hall": ["hero", "bench"], "corridor": ["hero", "lamp"], "guardian-vault": ["hero", "brazier"],
                   "gear-shaft": ["hero"], "study": ["hero", "desk"]}
# The study (P4-T4) predates cameras_runtime in staging/report.json: its Blender review cameras from
# scripts/assets/build-room-study.py CAMERAS, as runtime (x, y, z) = Blender (x, z, -y), the same
# values src/world/room-asset-proof.ts shoots for engine.hero.png and engine.desk.png.
FALLBACK_CAMERAS = {"study": {"hero": {"eye": [1.6, 1.6, 3.2], "look": [-0.4, 2.2, -4.0], "vfov": 70.0},
                              "desk": {"eye": [-2.8, 1.6, -0.6], "look": [2.4, 0.9, 2.4], "vfov": 70.0}}}


def variant_shots() -> list[tuple[str, str, dict]]:
    out = []
    for room, names in VARIANT_CAMERAS.items():
        report = ROOMS / room / "staging/report.json"
        if not report.exists():
            continue
        cams = json.loads(report.read_text()).get("cameras_runtime") or FALLBACK_CAMERAS.get(room, {})
        alone = [{"id": room, "position": [0, 0], "turns": 0}]
        for cam_name in names:
            cam = cams.get(cam_name)
            if not cam:
                continue
            for variant, light in VARIANTS.items():
                shot = {"rooms": alone, "eye": cam["eye"], "look": cam["look"], "vfov": cam["vfov"], "diffuse": False, "light": light}
                out.append((room, f"{cam_name}.{variant}", shot))
            if cam_name == "hero":
                # Lightmap only, as the pinned engine.hero.diffuse.png: checks camera, placement and binding.
                out.append((room, "hero.diffuse", {"rooms": alone, "eye": cam["eye"], "look": cam["look"], "vfov": cam["vfov"], "diffuse": True}))
    # Gilt-slot masks of the mesh-* frames (same camera and train angles), to measure the gears' light
    # in a fixed screen region on gear pixels only.
    for k in range(8):
        out.append(("gear-shaft", f"mesh.mask-{k * 45:03d}", {"rooms": [{"id": "gear-shaft", "position": [0, 0], "turns": 0}], "eye": [1.75, 4.7, 0.55],
                                                             "look": [0.6, 5.85, -0.6], "vfov": 60.0, "diffuse": True, "light": {"mask": ["_gilt"]},
                                                             "spin": train_spin(k * math.pi / 4)}))
    # The boarded door (seed KA000050) as baked light alone, to measure its contact shadow.
    floor = {"seed": "KA000050", "at": [-10, -1], "kit": ["gear-shaft"]}
    for name, eye, look in (("floor-boarded.lm", [-9.8, 1.3, -4.6], [-9.0, 1.0, -7.0]), ("floor-boarded-close.lm", [-9.0, 0.75, -6.1], [-9.75, 0.25, -7.0])):
        out.append(("gear-shaft", name, {"rooms": [], "eye": eye, "look": look, "vfov": 70.0, "diffuse": True, "light": {"whiteAlbedo": True},
                                         "floor": floor}))
    return out


EMITTERS = ["_flame", "_coals", "_lamp-glass"]
# Colour-wash investigation (--wash): every room camera as base and lightmap-only, and on the five
# diagnosis cameras one variable at a time plus region masks per slot.
WASH_DIAG = {
    "tone-none": {"tone": "none"},
    "env-off": {"envOff": True},
    "glass-env-off": {"envOffSlots": ["_stained-glass"]},
    "emit-env-off": {"envOffSlots": EMITTERS},
    "emit-untoned": {"untonedSlots": EMITTERS},
    "emit-toned": {"tonedSlots": EMITTERS},
    "glass-untoned": {"untonedSlots": ["_stained-glass"]},
    "mask-fire": {"mask": ["_flame", "_coals"]},
    "mask-lampglass": {"mask": ["_lamp-glass"]},
    "mask-glass": {"mask": ["_stained-glass"]},
    "mask-gilt": {"mask": ["_gilt"]},
}
WASH_DIAG_CAMERAS = {("guardian-vault", "hero"), ("guardian-vault", "brazier"), ("guardian-vault", "reward-eye"),
                     ("gear-shaft", "hero"), ("gear-shaft", "ring"), ("gear-shaft", "void")}
WASH_EXTRA = {"guardian-vault": {"reward-eye": {"eye": [0.3, 1.6, -1.0], "look": [0.0, 1.6, -6.0], "vfov": 70.0}}}


def wash_shots() -> list[tuple[str, str, dict]]:
    out = []
    for room in ("study", "hall", "corridor", "guardian-vault", "gear-shaft"):
        report = ROOMS / room / "staging/report.json"
        cams = dict(json.loads(report.read_text()).get("cameras_runtime") or FALLBACK_CAMERAS.get(room, {}))
        cams.update(WASH_EXTRA.get(room, {}))
        alone = [{"id": room, "position": [0, 0], "turns": 0}]
        for cam_name, cam in cams.items():
            view = {"rooms": alone, "eye": cam["eye"], "look": cam["look"], "vfov": cam["vfov"]}
            out.append((room, f"{cam_name}.base", {**view, "diffuse": False}))
            out.append((room, f"{cam_name}.diffuse", {**view, "diffuse": True}))
            touched = {"mask": [*EMITTERS, "_stained-glass"]}
            out.append((room, f"{cam_name}.mask-touched", {**view, "diffuse": False, "light": touched}))
            if (room, cam_name) in WASH_DIAG_CAMERAS:
                for variant, light in WASH_DIAG.items():
                    out.append((room, f"{cam_name}.{variant}", {**view, "diffuse": False, "light": light}))
    return out


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    failed = False
    errors: list[str] = []
    wash = "--wash" in sys.argv
    variants = "--variants" in sys.argv or wash
    if variants:
        VARIANT_OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chromium", headless=True, args=["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"])
        only = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else ""
        only_room = sys.argv[sys.argv.index("--room") + 1] if "--room" in sys.argv else ""
        for room, name, shot in wash_shots() if wash else variant_shots() if variants else shots():
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
            if variants:
                png = VARIANT_OUT / f"{room}.{name}.png"
                page.locator("canvas").screenshot(path=str(png))
                mean = page.evaluate(MEAN_JS)
                print(f"{room} {name}: {page.evaluate('window.__info')} gpu={page.evaluate('window.__gpu')} mean={mean} -> {png}")
                failed |= sum(mean) < 5 and ".mask-" not in name
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
