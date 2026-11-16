"""Kit room templates `hall` and `corridor` (P5-T1): high and low builds, UV1 Cycles lightmap,
image-free GLB with sorted indices, KTX2 lightmap, manifest, renders and a build report. Same route
and contract as the study (P4-T4); shared code comes from scripts/assets/room_kit.py, which reuses
the study generator's functions without editing it.

Build (one room per run):
    "$BLENDER" -b --factory-startup --python-exit-code 1 -P scripts/assets/build-room-kit.py -- \
        --room hall|corridor [--skip-bake] [--samples 256] [--device GPU|CPU] [--no-renders]
Determinism (GLB only, written elsewhere):
    ... build-room-kit.py -- --room hall --glb-out /tmp/hall.glb
Clean reimport check (fresh process):
    ... build-room-kit.py -- --room hall --reimport

Hall: 10 x 10 m entry hall, four brass-framed doorways, panelled walnut wainscot under wallpaper,
coffered walnut ceiling, a gear-ring chandelier over a brass floor compass, two walnut benches, four
corner candelabra and a stained-glass lancet in the north wall. Corridor: 2 x 8 m passage, brass
pilaster ribs and walnut beams, a hexagonal wall lantern at the lamp socket, four candle sconces
and a ruby banner at the banner socket.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
import room_kit as kit  # noqa: E402

S = kit.S
lm = S.lm

TILE = {"stone-floor": 1.5, "wallpaper": 0.75, "walnut": 0.5, "brass-aged": 0.5, "brass-polished": 0.5, "stained-glass": 0.6}
CONST = {  # linear base colour, roughness, metallic, emission strength (study values for wax and flame)
    "wax": ((0.80, 0.68, 0.48), 0.55, 0.0, 0.0),
    "flame": ((1.0, 0.62, 0.22), 0.5, 0.0, 6.0),
    "cloth": ((0.29, 0.03, 0.04), 0.85, 0.0, 0.0),  # ruby (art bible), the study's ruby book cloth
    "lamp-glass": ((1.0, 0.70, 0.32), 0.3, 0.0, 2.0),
}
EMISSIVE_RUNTIME = {"flame": 3.0, "lamp-glass": 1.5}
# Encode percentile per room: candle flames sit centimetres from wax and brass, and those texels are a
# larger share of a small room's map. Above it they clip; the report records the clipped fraction.
WINDOW = {"wall": "N", "a": 2.6, "half_w": 0.6, "sill": 1.4, "spring": 2.55}

ROOMS = {
    "hall": {
        "height": 4.0,
        "lightmap": 2048,
        "slots": ["stone-floor", "wallpaper", "walnut", "brass-aged", "brass-polished", "stained-glass", "wax", "flame"],
        "cameras": {
            # Runtime eye height 1.6 m. hero: inside the south door looking north at the chandelier and lancet.
            "hero": {"loc": (1.0, -4.2, 1.6), "look": (-0.4, 5.0, 1.9), "vfov": 70.0},
            "bench": {"loc": (3.6, 3.4, 1.6), "look": (-4.2, -1.5, 0.8), "vfov": 70.0},
        },
        "stile_step": 0.9,
        "percentile": 99.0,
    },
    "corridor": {
        "height": 3.4,
        # 1024: the project file's 32-64 px/m lightmap target; 2048 would put ~110 m2 near 120 px/m.
        "lightmap": 1024,
        "slots": ["stone-floor", "wallpaper", "walnut", "brass-aged", "brass-polished", "wax", "flame", "cloth", "lamp-glass"],
        "cameras": {
            "hero": {"loc": (0.25, -3.5, 1.6), "look": (-0.1, 4.0, 1.5), "vfov": 70.0},
            "lamp": {"loc": (-0.55, 2.9, 1.6), "look": (0.9, -1.0, 1.7), "vfov": 70.0},
        },
        "stile_step": 0.8,
        "percentile": 98.0,
    },
}


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--room", choices=sorted(ROOMS), required=True)
    p.add_argument("--samples", type=int, default=256)
    p.add_argument("--device", choices=["GPU", "CPU"], default="GPU")
    p.add_argument("--skip-bake", action="store_true")
    p.add_argument("--no-renders", action="store_true")
    p.add_argument("--glb-out", default="", help="write only the GLB here (determinism runs)")
    p.add_argument("--reimport", action="store_true")
    return p.parse_args(argv)


# ---------------------------------------------------------------------------------------------
# Rooms
# ---------------------------------------------------------------------------------------------


def window_opening() -> tuple:
    apex = WINDOW["spring"] + math.sqrt((2 * WINDOW["half_w"]) ** 2 - WINDOW["half_w"] ** 2)
    return (WINDOW["a"] - WINDOW["half_w"], WINDOW["a"] + WINDOW["half_w"], WINDOW["sill"], apex)


def build_hall(b, room: kit.Room, high: bool) -> tuple[list, list]:
    """Returns runtime colliders and (name, Blender point, watts) bake lights."""
    kit.build_shell(b, room, {"N": [window_opening()]}, ROOMS["hall"]["stile_step"])
    # The study's lancet is authored centred on its wall: shift its frame to the window's centre.
    S.WIN = {"x0": -WINDOW["half_w"], "x1": WINDOW["half_w"], "sill": WINDOW["sill"], "spring": WINDOW["spring"]}
    S.WIN["apex"] = window_opening()[3]
    S.wall_frame = lambda wall: room.frame(wall) @ Matrix.Translation((WINDOW["a"], 0, 0))
    S.build_window(b, high)
    S.wall_frame = room.frame
    T = room.height
    # Coffered ceiling: walnut beams both ways at +-2.5 m, ends buried in the walls.
    for c in (-2.5, 2.5):
        b.box(-room.hx, room.hx, c - 0.14, c + 0.14, T - 0.3, T, "walnut", drop="txX")
        b.box(c - 0.14, c + 0.14, -room.hy, room.hy, T - 0.26, T, "walnut", drop="tyY")
    kit.medallion(b, high)
    lights = [(f"chandelier_{i}", p, 14.0) for i, p in enumerate(kit.chandelier(b, room, high, 2.85))]
    colliders = []
    for sx, sy in ((-1, 1), (1, -1), (1, 1), (-1, -1)):  # sconce-nw, sconce-se sockets first
        flames, box = kit.torchere(b, sx * 4.6, sy * 4.6, 2.2, high)
        colliders.append(box)
        lights.append((f"torchere_{len(colliders) - 1}", Vector((sx * 4.6, sy * 4.6, 2.2)), 40.0))
    for cx in (-4.0, 4.0):  # bench-w and bench-e sockets
        colliders.append(kit.bench(b, cx, 0.0, 0.9, high))
    return colliders, lights


def build_corridor(b, room: kit.Room, high: bool) -> tuple[list, list]:
    kit.build_shell(b, room, {}, ROOMS["corridor"]["stile_step"])
    T = room.height
    for y in (-2.0, 2.0):  # brass pilaster ribs and a walnut beam
        b.box(-room.hx, room.hx, y - 0.11, y + 0.11, T - 0.24, T, "walnut", drop="txX")
        for wall, a in (("W", y), ("E", -y)):
            b.xf = room.frame(wall)
            # Walnut shaft: a metal has no diffuse lobe, so a tall brass strip reads dark under the
            # lightmap and the dim probe. Brass stays on the plinth and capital.
            b.box(a - 0.09, a + 0.09, 0, 0.06, 0.18, T - 0.32, "walnut", drop="ybt")
            b.box(a - 0.12, a + 0.12, 0, 0.08, 0, 0.18, "brass-aged", drop="yb")  # plinth
            b.box(a - 0.12, a + 0.12, 0, 0.08, T - 0.32, T - 0.24, "brass-aged", drop="y")  # capital
            b.xf = Matrix.Identity(4)
    flame = kit.lantern(b, 0.8, 0.0, 2.2, room.hx, high)
    kit.banner(b, -room.hx, -room.hx + 0.04, 0.0, high)
    S.SCONCES = [("W", 2.9), ("W", -2.9), ("E", 2.9), ("E", -2.9)]
    sconces = S.build_sconces(b, high)
    lights = [("lamp", Vector((0.8, 0.0, 2.2)), 35.0)] + [(f"sconce_{i}", p, 18.0) for i, p in enumerate(sconces)]
    assert (flame - Vector((0.8, 0.0, 2.2))).length < 0.05, flame
    return [], lights


BUILDERS = {"hall": build_hall, "corridor": build_corridor}


def build(room: kit.Room, high: bool):
    b = S.Builder(f"{room.piece}_high" if high else room.piece)
    colliders, lights = BUILDERS[room.piece](b, room, high)
    return b.finish(), colliders, lights


def build_lights(room: kit.Room, lights: list) -> None:
    scene = bpy.context.scene
    world = bpy.data.worlds.new(f"{room.piece}_world")
    scene.world = world
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (0.05, 0.035, 0.022, 1.0)
    bg.inputs["Strength"].default_value = 0.5
    for name, loc, energy in lights:
        data = bpy.data.lights.new(f"{room.piece}_{name}", "POINT")
        data.energy = energy
        data.shadow_soft_size = 0.02
        data.color = (1.0, 0.58, 0.26)
        obj = bpy.data.objects.new(f"{room.piece}_{name}", data)
        obj.location = loc
        scene.collection.objects.link(obj)
    if room.piece == "hall":  # late sun and sky through the north lancet, as in the study
        sun_data = bpy.data.lights.new("hall_sun", "SUN")
        sun_data.energy = 7.0
        sun_data.angle = math.radians(1.0)
        sun_data.color = (1.0, 0.86, 0.66)
        sun = bpy.data.objects.new("hall_sun", sun_data)
        sun.rotation_euler = Vector((0.12, -0.75, -0.65)).normalized().to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(sun)
        area_data = bpy.data.lights.new("hall_window_sky", "AREA")
        area_data.shape = "RECTANGLE"
        area_data.size, area_data.size_y = 1.2, 2.2
        area_data.energy = 60.0
        area_data.color = (1.0, 0.8, 0.6)
        area = bpy.data.objects.new("hall_window_sky", area_data)
        o = window_opening()
        area.location = (WINDOW["a"], room.hy + 0.4, (o[2] + o[3]) / 2)
        area.rotation_euler = (math.radians(-90), 0, 0)
        scene.collection.objects.link(area)


# ---------------------------------------------------------------------------------------------
# Manifest, reimport
# ---------------------------------------------------------------------------------------------


def manifest_entry(room: kit.Room, colliders: list, lightmap: dict | None, budget: dict) -> dict:
    spec = kit.SPECS[room.piece]
    p = room.piece
    materials = {}
    for slot in ROOMS[p]["slots"]:
        if slot in TILE:
            materials[f"{p}_{slot}"] = {"pbr": slot, "tileMeters": TILE[slot]}
        else:
            color, rough = CONST[slot][0], CONST[slot][1]
            entry = {"color": S.srgb_hex(color)}
            if slot in EMISSIVE_RUNTIME:
                entry.update({"emissive": S.srgb_hex(color), "emissiveIntensity": EMISSIVE_RUNTIME[slot]})
            else:
                entry["roughness"] = rough
            materials[f"{p}_{slot}"] = entry
    return {
        "template": p,
        "glb": S.GLB_NAME,
        "lightmap": lightmap,
        "id": p,
        **{k: spec[k] for k in ("kinds", "footprint", "doors", "rotations", "enemySockets", "lootSockets", "dressingSockets", "lightSockets", "probe")},
        "walkable": kit.walkable(spec),
        "colliders": [*kit.perimeter_colliders(spec), *colliders],
        "budget": budget,
        "materials": materials,
        "glassEmissiveIntensity": 0.8,
    }


def reimport(room: kit.Room) -> None:
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    glb = S.RUNTIME / S.GLB_NAME
    bpy.ops.import_scene.gltf(filepath=str(glb))
    bpy.context.view_layer.update()
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    tris = sum(len(p.vertices) - 2 for o in meshes for p in o.data.polygons)
    mats = sorted({m.name for o in meshes for m in o.data.materials if m})
    uv_layers = sorted({tuple(uv.name for uv in o.data.uv_layers) for o in meshes})
    corners = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    lo = [round(min(c[i] for c in corners), 4) for i in range(3)]
    hi = [round(max(c[i] for c in corners), 4) for i in range(3)]
    images = len([i for i in bpy.data.images if i.source == "FILE"])
    maps = {}
    for p in sorted(S.RUNTIME.glob("*.ktx2")):
        bts = p.read_bytes()
        maps[p.name] = {"width": int.from_bytes(bts[20:24], "little"), "height": int.from_bytes(bts[24:28], "little")}
    slots = {f"{room.piece}_{s}" for s in ROOMS[room.piece]["slots"]}
    result = {
        "glb": S.GLB_NAME,
        "glb_sha256": S.sha256(glb),
        "blender": bpy.app.version_string,
        "meshes": [o.name for o in meshes],
        "triangles": tris,
        "materials": mats,
        "material_count": len(mats),
        "uv_layers": [list(u) for u in uv_layers],
        "embedded_images": images,
        "bounds_blender": {"min": lo, "max": hi},
        "texture_px": maps,
        "checks": {
            "triangles_le_100k": tris <= 100_000,
            "materials_le_16": len(mats) <= 16,
            "materials_are_manifest_slots": set(mats) <= slots,
            "textures_le_2048": all(m["width"] <= 2048 and m["height"] <= 2048 for m in maps.values()),
            "two_uv_layers_every_mesh": all(len(u) == 2 for u in uv_layers),
            "no_embedded_images": images == 0,
            "floor_at_zero": abs(lo[2]) < 1e-3,
            "inside_ceiling": hi[2] <= room.height + 1e-3,
            "footprint_x": abs(lo[0] + room.hx) < 0.06 and abs(hi[0] - room.hx) < 0.06,
            "footprint_y": abs(lo[1] + room.hy) < 0.06 and abs(hi[1] - room.hy) < 0.06,
            "inside_footprint": lo[0] >= -room.hx - 1e-3 and hi[0] <= room.hx + 1e-3 and lo[1] >= -room.hy - 1e-3 and hi[1] <= room.hy + 1e-3,
        },
    }
    result["pass"] = all(result["checks"].values())
    (S.STAGING / "reimport.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    if not result["pass"]:
        raise SystemExit("reimport check failed")


# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------


def export(low, path: Path) -> int:
    S.export_glb(low, path)
    return CANONICALIZE(path)


def main() -> None:
    args = parse_args()
    cfg = ROOMS[args.room]
    room = kit.Room(args.room, cfg["height"])
    kit.configure(room, list(cfg["slots"]), {k: v for k, v in TILE.items() if k in cfg["slots"]}, {k: v for k, v in CONST.items() if k in cfg["slots"]}, cfg["cameras"])
    if args.reimport:
        reimport(room)
        return
    P = room.piece
    for d in (S.STAGING, S.BLEND_DIR, S.SCRATCH, S.RUNTIME):
        d.mkdir(parents=True, exist_ok=True)
    bpy.context.preferences.filepaths.save_version = 0
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    scene = bpy.context.scene
    size = cfg["lightmap"]
    report: dict = {"piece": P, "blender": bpy.app.version_string, "host_load_start": S.load_avg(), "lightmap_size": size, "samples": args.samples,
                    "generator": "scripts/assets/build-room-kit.py", "helper": "scripts/assets/room_kit.py (reuses build-room-study.py functions)"}

    high, _, _ = build(room, True)
    S.uv0_tiled(high)
    S.apply_bevel(high)
    report["high"] = {"triangles": S.count_tris(high), "slots": len(S.SLOTS)}

    low, colliders, lights = build(room, False)
    backing = S.build_door_backing()
    build_lights(room, lights)
    cams = {name: S.make_camera(name) for name in cfg["cameras"]}
    S.uv0_tiled(low)
    bpy.context.view_layer.update()
    if not args.glb_out:
        S.set_visible([low], False)
        bpy.ops.wm.save_as_mainfile(filepath=str(S.BLEND_DIR / f"{P}_high.blend"), copy=True, compress=True)
        S.set_visible([low], True)

    lm.unwrap_lightmap_uv(low, size, gap_px=10)
    tris = S.count_tris(low)
    report["low"] = {
        "triangles": tris,
        "vertices": len(low.data.vertices),
        "materials": len({p.material_index for p in low.data.polygons}),
        "lightmap_density": lm.lightmap_texel_density(low, size),
        "lightmap_density_by_slot": S.density_by_slot(low, size),
    }
    print(f"[{P}] high tris={report['high']['triangles']} low tris={tris} density={report['low']['lightmap_density']}")
    assert tris <= 100_000 and len(S.SLOTS) <= 16, "PRD room budget exceeded"
    assert report["low"]["materials"] == len(S.SLOTS), "every slot must be used (manifest lists all)"

    glb = Path(args.glb_out) if args.glb_out else S.STAGING / S.GLB_NAME
    report["canonicalized_primitives"] = export(low, glb)
    report["glb_bytes"] = glb.stat().st_size
    if args.glb_out:
        print(f"[{P}] determinism GLB {glb} {S.sha256(glb)}")
        return

    S.set_visible([high], False)
    if "lamp-glass" in S.SLOTS:  # after export, so the GLB's material factors do not depend on it
        kit.bake_transmitting_glass("lamp-glass")
    lightmap = None
    if not args.skip_bake:
        report["device"] = lm.select_device(args.device)
        S.set_metal_links(False)
        load0 = S.load_avg()
        raw, seconds = lm.bake_irradiance(low, size, args.samples)
        S.set_metal_links(True)
        report["lightmap_bake"] = {"seconds": round(seconds, 2), "host_load": [load0, S.load_avg()], "timing_valid": max(load0, S.load_avg()) <= 15}
        lm.save_exr(raw, S.SCRATCH / f"{P}.lightmap.raw.exr")
        image = lm.denoise_image(raw, S.SCRATCH)
        report["denoise"] = "compositor OIDN, HDR, accurate prefilter, high quality"
        encoded, scale, stats = lm.encode_scaled_srgb(lm.image_rgba(image), percentile=cfg["percentile"])
        stats["percentile"] = cfg["percentile"]
        cov = lm.image_rgba(image)[..., 3] > 0.5
        enc_peak = encoded.max(axis=2)[cov]
        stats["encoded_p05_255"] = int(sorted(enc_peak.tolist())[len(enc_peak) // 20])
        stats["encoded_median_255"] = int(sorted(enc_peak.tolist())[len(enc_peak) // 2])
        lm.write_png_rgb(S.STAGING / f"{P}.lightmap.png", encoded)
        report["lightmap"] = stats
        lightmap = {"file": f"{P}.lightmap.ktx2", "uv": 1, "encoding": "srgb-scaled", "scale": scale, "intensity": round(math.pi * scale, 6)}

    budget = {"tris": tris, "materials": len(S.SLOTS), "texturePx": size}
    if lightmap is not None:
        mpath = S.STAGING / f"{P}.manifest.json"
        mpath.write_text(json.dumps(manifest_entry(room, colliders, lightmap, budget), indent=2) + "\n")
        formatted = subprocess.run([str(S.ROOT / "node_modules/.bin/biome"), "format", f"--stdin-file-path=public/assets/rooms/{P}/{mpath.name}"],
                                   input=mpath.read_text(), capture_output=True, text=True, check=True, cwd=S.ROOT).stdout
        mpath.write_text(formatted)
        encodes = {f"{P}.lightmap.ktx2": S.ktx2(S.STAGING / f"{P}.lightmap.png", S.STAGING / f"{P}.lightmap.ktx2", color=True)}
        report["ktx2"] = {"tool": subprocess.run([str(S.KTX), "--version"], capture_output=True, text=True, check=True).stdout.strip(), "encodes": encodes}
        for name in [S.GLB_NAME, mpath.name, *encodes]:
            shutil.copyfile(S.STAGING / name, S.RUNTIME / name)

    if not args.no_renders:
        renders = S.STAGING / "renders"
        renders.mkdir(exist_ok=True)
        S.render_settings("BLENDER_EEVEE", 64)
        S.set_visible([backing], True)
        for name, cam in cams.items():
            S.set_visible([low], False)
            S.set_visible([high], True)
            S.render_to(cam, renders / f"{name}.high.png")
            S.set_visible([high], False)
            S.set_visible([low], True)
            S.render_to(cam, renders / f"{name}.low.png")
        if lightmap is not None:
            originals = S.lightmapped_preview_materials(low, S.STAGING / f"{P}.lightmap.png", lightmap["scale"])
            scene.view_settings.view_transform = "Standard"
            for name, cam in cams.items():
                S.render_to(cam, renders / f"{name}.lightmapped.png")
            for i, mat in enumerate(originals):
                low.data.materials[i] = mat
            S.render_settings("CYCLES", 96)
            scene.view_settings.view_transform = "Standard"
            S.set_metal_links(False)
            for mat in low.data.materials:
                S.bsdf_of(mat).inputs["Specular IOR Level"].default_value = 0.0
            S.render_to(cams["hero"], renders / "hero.reference-diffuse.png")
            for mat in low.data.materials:
                S.bsdf_of(mat).inputs["Specular IOR Level"].default_value = 0.5
            S.set_metal_links(True)
        report["renders"] = sorted(p.name for p in renders.glob("*.png"))

    S.set_visible([high], False)
    bpy.data.objects.remove(high)
    bpy.ops.wm.save_as_mainfile(filepath=str(S.BLEND_DIR / f"{P}_low.blend"), copy=True, compress=True)
    report["blend"] = {p.name: {"sha256": S.sha256(p), "bytes": p.stat().st_size} for p in sorted(S.BLEND_DIR.glob("*.blend"))}
    report["colliders_added"] = colliders
    report["bake_lights"] = [{"name": n, "blender": [round(v, 4) for v in p], "watts": w} for n, p, w in lights]
    report["cameras_runtime"] = {k: {"eye": [v["loc"][0], v["loc"][2], -v["loc"][1]], "look": [v["look"][0], v["look"][2], -v["look"][1]], "vfov": v["vfov"]}
                                 for k, v in cfg["cameras"].items()}
    report["host_load_end"] = S.load_avg()
    report["files"] = {p.name: S.sha256(p) for p in sorted(S.STAGING.iterdir()) if p.suffix in {".glb", ".png", ".json", ".ktx2"} and p.name not in ("report.json", "reimport.json")}
    (S.STAGING / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: report[k] for k in ("low", "high")}, indent=2))


CANONICALIZE = kit.load_canonicalize()

if __name__ == "__main__":
    main()
