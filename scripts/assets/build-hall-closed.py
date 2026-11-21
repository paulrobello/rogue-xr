"""Build the windowless hall with the existing hall geometry and bake pipeline.

Blender -b --factory-startup --python-exit-code 1 -P scripts/assets/build-hall-closed.py -- \\
    --room hall --samples 256 --device GPU --no-renders
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys

import bpy

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("build_room_kit", HERE / "build-room-kit.py")
assert spec and spec.loader
roomkit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(roomkit)
kit, S = roomkit.kit, roomkit.S

if os.environ.get("ROGUE_XR_KTX"):
    S.KTX = Path(os.environ["ROGUE_XR_KTX"]).expanduser().resolve()
args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if "--room" not in args or args[args.index("--room") + 1] != "hall":
    raise ValueError("This variant only supports --room hall")

roomkit.ROOMS["hall"]["slots"].remove("stained-glass")
configure = kit.configure

def configure_closed(room, slots, tile, const, cameras):
    configure(room, slots, tile, const, cameras)
    S.SRC = ROOT / "assets-source/rooms/hall-closed"
    S.STAGING = S.SRC / "staging"
    S.BLEND_DIR = S.SRC / "blend"
    S.SCRATCH = ROOT / ".local/rooms/hall-closed"
    S.RUNTIME = ROOT / "public/assets/rooms/hall-closed"

kit.configure = configure_closed
shell = kit.build_shell

def closed_shell(b, room, openings, *args, **kwargs):
    window = roomkit.window_opening()
    assert openings["N"].count(window) == 1
    closed = {wall: [opening for opening in holes if opening != window] for wall, holes in openings.items()}
    wall, center, half_width = roomkit.HALL["fireplace"]
    assert wall == "N" and closed["N"] == [(center - half_width, center + half_width, 0.0, room.height - 0.2)], (
        "Only the fireplace breast opening may remain on the north wall"
    )
    return shell(b, room, closed, *args, **kwargs)

kit.build_shell = closed_shell
S.build_window = lambda *_args, **_kwargs: None
build_lights = roomkit.build_lights

def closed_lights(room, lights):
    build_lights(room, lights)
    for name in ("hall_sun", "hall_window_sky"):
        obj = bpy.data.objects.get(name)
        assert obj is not None, f"Expected existing hall light {name}"
        bpy.data.objects.remove(obj, do_unlink=True)
    assert not any(o.type == "LIGHT" and (o.data.type == "SUN" or o.name.startswith("hall_window_sky"))
                   for o in bpy.context.scene.objects)
    assert any(name.startswith("hearth_") for name, *_ in lights), "Fireplace bake lights missing"

roomkit.build_lights = closed_lights
roomkit.main()

if not any(flag in args for flag in ("--glb-out", "--skip-bake", "--reimport")):
    report_path = S.STAGING / "report.json"
    report = json.loads(report_path.read_text())
    report["generator"] = "scripts/assets/build-hall-closed.py (wraps scripts/assets/build-room-kit.py)"
    report["variant"] = "hall-closed"
    report["window"] = "north lancet opening and frame omitted; hall sun and window sky removed"
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    source_files = [HERE / "build-room-kit.py", HERE / "room_kit.py", HERE / "build-room-study.py",
                    HERE / "lightmap_helpers.py", HERE / "room_panels.py", HERE / "build-cog-sentry.py"]
    output_files = [S.RUNTIME / name for name in ("hall.glb", "hall.manifest.json", "hall.lightmap.ktx2")]

    def digest(path):
        return {"path": str(path.relative_to(ROOT)), "sha256": S.sha256(path)}

    provenance = {
        "pieceId": "hall", "variant": "hall-closed", "route": "scripted",
        "blender": bpy.app.version_string,
        "generator": digest(Path(__file__)),
        "generatorDeps": [digest(path) for path in source_files],
        "derivedFiles": [digest(path) for path in output_files],
        "validation": {"pass": True},
        "blendFiles": report["blend"], "bake": {"size": report["lightmap_size"], "samples": report["samples"],
                                                  "device": report["device"], "ktx2": report["ktx2"]},
        "geometry": "North lancet cutout and frame omitted; fireplace breast opening retained.",
        "lighting": "Hall sun and window sky removed before baking; fireplace and other hall lights retained.",
    }
    (S.SRC / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
