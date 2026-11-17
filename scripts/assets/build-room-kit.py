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

Hall: 10 x 10 m entry hall, four brass-framed doorways, a 1.2 m panelled walnut wainscot, walnut
pilasters, frieze and panel mouldings over the wallpaper, a walnut cove and coffered ceiling, a
gear-ring chandelier over a brass floor compass, two walnut benches, four corner candelabra, a lit
niche on every wall, a stone fireplace in the north wall and a stained-glass lancet. Corridor: 2 x 8 m
passage, a 1.2 m wainscot, panel mouldings over small-motif wallpaper, a walnut cove, brass pilaster
ribs and walnut beams, three open-bottomed hexagonal lanterns alternating sides (the east one at the
lamp socket) and a ruby banner at the banner socket.
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
    # P5-T2 rework. Coals: deep ember red, a dark albedo with strong emission. The coals sit beside
    # the fire bake lights, so their lightmap term is large: at albedo 0.55 it alone pushed red past 1.0
    # and AgX turned the grate a pale salmon (engine R-B 76). Colour x 0.25 and strength x 4 keep the
    # emitted light (bake and runtime) unchanged and cut the lit term to a quarter. Gilt: a dielectric
    # brass for big gear faces: the PBR brass sets are fully metallic, so under the lightmap they have
    # no diffuse term and read dark (crown gear L 46, vault wall gears L 40).
    "coals": ((0.1375, 0.025, 0.00375), 0.9, 0.0, 12.0),
    "gilt": ((0.52, 0.31, 0.10), 0.42, 0.0, 0.0),
}
EMISSIVE_RUNTIME = {"flame": 3.0, "lamp-glass": 1.5, "coals": 5.6}
# Fire flames in the P5-T2 rooms: the shared flame (white-hot at 3.0, R-B 39 after AgX) made the
# furnace a white light box and the braziers white spikes. Same dark-albedo split as the coals: the
# emitted colour is (1.0, 0.33, 0.06) at Blender strength 6 and runtime intensity 1.4.
FIRE_FLAME = {"const": {"flame": ((0.25, 0.0825, 0.015), 0.5, 0.0, 24.0)}, "emissive": {"flame": 5.6}}
# Bake-light colour of fire (furnace, braziers): deeper than the candle colour build_lights defaults to.
FIRE = {"type": "POINT", "color": (1.0, 0.46, 0.16)}
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
        # 2048: at 1024 the corridor sat at 52.8 px/m against the study's 66.3, and the review asked
        # for the kit's density. It lands above the project file's 32-64 px/m guide (see the notes).
        "lightmap": 2048,
        "slots": ["stone-floor", "wallpaper", "walnut", "brass-aged", "brass-polished", "cloth", "lamp-glass"],
        # Motifs a third of the hall's size: at 2 m wide the walls are within arm's reach.
        "tile": {"wallpaper": 0.25},
        "cameras": {
            "hero": {"loc": (0.25, -3.5, 1.6), "look": (-0.1, 4.0, 1.5), "vfov": 70.0},
            "lamp": {"loc": (-0.55, 2.9, 1.6), "look": (0.9, -1.0, 1.7), "vfov": 70.0},
        },
        "stile_step": 0.8,
        "percentile": 98.0,
    },
    # P5-T2. The chamber ceiling is at 5 m; `height` bounds the shaft void that rises from a hole over
    # the drive shaft to 8 m (a well with a gallery ring and a gear train).
    "gear-shaft": {
        "height": 8.0,
        "ceiling": 5.0,
        "lightmap": 2048,
        "slots": ["stone-floor", "wallpaper", "walnut", "brass-aged", "brass-polished", "wax", "flame", "lamp-glass", "coals", "gilt"],
        # Brass scratches at 2.5x the kit scale: fewer, broader marks (the review: "calm the noise").
        "tile": {"brass-aged": 1.25, "brass-polished": 1.25},
        **FIRE_FLAME,
        "cameras": {
            "hero": {"loc": (-1.0, -5.0, 1.6), "look": (0.4, 3.0, 3.3), "vfov": 70.0},
            "ring": {"loc": (2.6, 2.4, 1.6), "look": (-0.6, -0.8, 3.5), "vfov": 70.0},
            "void": {"loc": (2.2, -2.6, 1.6), "look": (0.0, 0.0, 6.5), "vfov": 70.0},
        },
        "stile_step": 0.9,
        "percentile": 99.0,
    },
    "guardian-vault": {
        "height": 6.0,
        "lightmap": 2048,
        "slots": ["stone-floor", "wallpaper", "walnut", "brass-aged", "brass-polished", "stained-glass", "wax", "flame", "coals", "gilt"],
        **FIRE_FLAME,
        "cameras": {
            "hero": {"loc": (1.0, -5.2, 1.6), "look": (0.0, 5.5, 2.7), "vfov": 70.0},
            "brazier": {"loc": (-1.5, -2.5, 1.6), "look": (4.0, 4.0, 1.8), "vfov": 70.0},
        },
        "stile_step": 0.9,
        "percentile": 99.0,
    },
}
# Gear-shaft crown gear: a separate rigid glTF node spun at runtime about its own Y axis (P5-T12).
GEAR_RING = {"node": "gear-shaft_gear_ring", "pivot_z": 3.6, "r_tip": 2.0, "teeth": 56, "thick": 0.12, "hub_r": 0.36, "shaft_r": 0.3,
             "radPerSec": 0.35}
HALL = {
    "wainscot": 1.2,
    "fireplace": ("N", -3.55, 0.8),  # wall, wall-local centre, half width (kit.fireplace)
    "niches": [("N", 0.9), ("E", -3.75), ("S", -3.75), ("W", -3.75)],
    # Wall-local positions, on the coffer beam lines; N +2.5 is the lancet.
    "pilasters": {"N": [-2.5], "E": [-2.5, 2.5], "S": [-2.5, 2.5], "W": [-2.5, 2.5]},
    "frames": {"E": [(-2.3, -0.1), (2.7, 4.8)], "S": [(0.0, 2.3), (2.7, 4.8)], "W": [(-2.3, -0.1), (2.7, 4.8)]},
    # Frieze runs, clear of the chimney crown and the lancet surround.
    "frieze": {"N": [(-5.0, -4.39), (-2.71, 1.83), (3.37, 5.0)]},
}
CORRIDOR = {
    "wainscot": 1.2,
    "frames": [(-3.75, -2.25), (-1.75, -0.55), (0.55, 1.75), (2.25, 3.75)],  # both side walls
    # Wall lanterns alternate sides: east at the lamp socket, west 3 m either side, outside the hero frame.
    "lanterns": [("lamp", 0.8, 0.0), ("lantern_s", -0.8, -3.0), ("lantern_n", -0.8, 3.0)],
}
# A lantern's bake light: a point for the glow on the walls near it, and a downward spot standing in
# for the brass cap that throws its light down through the glass floor, so each lantern bakes its
# own pool. Point lights 2.2 m up and 3 m apart light a 2 m corridor floor almost evenly.
LANTERN_POOL = {"type": "SPOT", "spot_size": math.radians(70.0), "spot_blend": 0.35}
VAULT_WINDOWS = [{"wall": "N", "a": a, "half_w": 0.55, "sill": 1.7, "spring": 3.1} for a in (-2.6, 0.0, 2.6)]
# Gear-shaft void: ceiling hole half size (the crown gear's tip radius is 2.0), gallery ring height,
# and the two levels of the static gear train.
GEAR_SHAFT = {"hole": 2.1, "gallery_z": 7.0, "train_z": (5.55, 6.15)}


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


def room_tile(p: str) -> dict:
    """TILE for a room's slots, with the room's own overrides (the corridor's smaller wallpaper)."""
    return {k: v for k, v in {**TILE, **ROOMS[p].get("tile", {})}.items() if k in ROOMS[p]["slots"]}


def room_const(p: str) -> dict:
    """CONST for a room's slots, with the room's own overrides (the P5-T2 fire flame)."""
    return {k: v for k, v in {**CONST, **ROOMS[p].get("const", {})}.items() if k in ROOMS[p]["slots"]}


def build_hall(b, room: kit.Room, high: bool) -> tuple[list, list]:
    """Returns runtime colliders and (name, Blender point, watts[, light options]) bake lights."""
    T = room.height
    fw, fa, fh = HALL["fireplace"]
    breast = (fa - fh, fa + fh, 0.0, T - 0.2)  # the shell leaves the wall open behind the chimney breast
    openings = {"N": [window_opening()]}
    openings.setdefault(fw, []).append(breast)
    kit.build_shell(b, room, openings, ROOMS["hall"]["stile_step"], cornice=False, wainscot=HALL["wainscot"])
    kit.cove_cornice(b, room, {fw: [(-room.half(fw), breast[0]), (breast[1], room.half(fw))]})
    # The study's lancet is authored centred on its wall: shift its frame to the window's centre.
    S.WIN = {"x0": -WINDOW["half_w"], "x1": WINDOW["half_w"], "sill": WINDOW["sill"], "spring": WINDOW["spring"]}
    S.WIN["apex"] = window_opening()[3]
    S.wall_frame = lambda wall: room.frame(wall) @ Matrix.Translation((WINDOW["a"], 0, 0))
    S.build_window(b, high)
    S.wall_frame = room.frame
    # Panelled bays: pilasters on the beam lines, a frieze under the cove, mouldings in the free bays.
    W = HALL["wainscot"]
    for wall in "NSEW":
        b.xf = room.frame(wall)
        for a in HALL["pilasters"].get(wall, []):
            kit.pilaster(b, a, W + 0.05, T - 0.3)
        for a0, a1 in HALL["frieze"].get(wall, [(-room.half(wall), room.half(wall))]):
            b.box(a0, a1, 0, 0.025, T - 0.56, T - 0.3, "walnut", drop="y")
        for a0, a1 in HALL["frames"].get(wall, []):
            kit.moulding_frame(b, a0, a1, W + 0.25, T - 0.76)
        b.xf = Matrix.Identity(4)
    # Coffered ceiling: walnut beams both ways at +-2.5 m, ends buried in the walls.
    for c in (-2.5, 2.5):
        b.box(-room.hx, room.hx, c - 0.14, c + 0.14, T - 0.3, T, "walnut", drop="txX")
        b.box(c - 0.14, c + 0.14, -room.hy, room.hy, T - 0.26, T, "walnut", drop="tyY")
    kit.medallion(b, high)
    lights = [(f"chandelier_{i}", p, 12.0) for i, p in enumerate(kit.chandelier(b, room, high, 2.85))]
    colliders = []
    for sx, sy in ((-1, 1), (1, -1), (1, 1), (-1, -1)):  # sconce-nw, sconce-se sockets first
        flames, box = kit.candelabrum(b, sx * 4.6, sy * 4.6, 2.2, high)
        lights += [(f"torchere_{len(colliders)}_{k}", f, 15.0) for k, f in enumerate(flames)]
        colliders.append(box)
    for cx in (-4.0, 4.0):  # bench-w and bench-e sockets
        colliders.append(kit.bench(b, cx, 0.0, 0.9, high))
    fire_lights, fire_box, _ = kit.fireplace(b, room, fw, fa, high)
    colliders.append(fire_box)
    lights += fire_lights
    for wall, a in HALL["niches"]:
        lights.append((f"niche_{wall}", kit.wall_niche(b, room, wall, a, high), 5.0))
    return colliders, lights


def build_corridor(b, room: kit.Room, high: bool) -> tuple[list, list]:
    kit.build_shell(b, room, {}, ROOMS["corridor"]["stile_step"], cornice=False, wainscot=CORRIDOR["wainscot"])
    kit.cove_cornice(b, room)
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
    for wall in "WE":
        b.xf = room.frame(wall)
        for a0, a1 in CORRIDOR["frames"]:
            kit.moulding_frame(b, a0, a1, CORRIDOR["wainscot"] + 0.2, T - 0.45)
        b.xf = Matrix.Identity(4)
    lights = []
    for name, x, y in CORRIDOR["lanterns"]:
        flame = kit.lantern_open(b, x, y, 2.2, room.hx if x > 0 else -room.hx, high)
        lights += [(name, flame, 12.0), (f"{name}_pool", flame - Vector((0, 0, 0.05)), 28.0, LANTERN_POOL)]
    kit.banner(b, -room.hx, -room.hx + 0.04, 0.0, high)
    assert (lights[0][1] - Vector((0.8, 0.0, 2.2))).length < 0.05, lights[0]  # the lamp light socket
    return [], lights


def lancet_opening(w: dict) -> tuple:
    apex = w["spring"] + math.sqrt((2 * w["half_w"]) ** 2 - w["half_w"] ** 2)
    return (w["a"] - w["half_w"], w["a"] + w["half_w"], w["sill"], apex)


def build_gear_shaft(b, room: kit.Room, high: bool) -> tuple[list, list]:
    """Furnace-driven gear shaft: masonry firebox with four coal grates at the centre in a grated coal
    pit behind a stone kerb, polished drive shaft rising through a hole in the 5 m ceiling into a shaft
    void to 8 m, with a static gear train meshing up the shaft and a gallery ring with four candles; a
    parts crate, two lanterns and four candle sconces. The turning crown gear is built separately
    (rigid_parts)."""
    C, H = ROOMS["gear-shaft"]["ceiling"], GEAR_SHAFT["hole"]
    kit.build_shell(b, room, {}, ROOMS["gear-shaft"]["stile_step"], cornice=False, ceiling_z=C, ceiling_hole=H)
    kit.cove_cornice(b, room, top=C)
    for c in (-3.5, 3.5):  # walnut beams across the chamber, clear of the shaft hole
        b.box(-room.hx, room.hx, c - 0.14, c + 0.14, C - 0.3, C, "walnut", drop="txX")
    furnace = kit.furnace_shaft(b, high, room.height, GEAR_RING["shaft_r"])
    colliders = [kit.crate(b, 3.0, -4.5, 0.8)]  # crate socket (runtime 3, 4.5)
    colliders.append(kit.furnace_pit(b, high))
    gallery = kit.shaft_well(b, C, room.height, H, GEAR_SHAFT["gallery_z"], high)
    kit.gear_train(b, high, *GEAR_SHAFT["train_z"], GEAR_RING["shaft_r"])
    lamps = [kit.lantern(b, 3.6, 5.6, 2.4, room.hx, high), kit.lantern(b, -3.6, -5.6, 2.4, -room.hx, high)]  # lamp-n, lamp-s
    S.SCONCES = [("E", 3.0), ("E", -3.0), ("W", 3.6), ("W", -3.8)]
    sconces = S.build_sconces(b, high)
    lights = [(f"furnace_{i}", p, 40.0, FIRE) for i, p in enumerate(furnace)]
    lights += [(n, p, 40.0) for n, p in zip(("lamp_n", "lamp_s"), lamps)]
    lights += [(f"sconce_{i}", p, 18.0) for i, p in enumerate(sconces)]
    lights += [(f"gallery_{i}", p, 6.0) for i, p in enumerate(gallery)]  # 4-fold symmetric about the ring axis
    return colliders, lights


def build_guardian_vault(b, room: kit.Room, high: bool) -> tuple[list, list]:
    """Guardian arena: 6 m vault, four stone pillars with brazier troughs at the light sockets, three
    stained-glass lancets and a brass gear rosette behind the reward, walnut ceiling grid, a gear
    chandelier over the brass duelling circle and a processional inlay from the door."""
    # The apse piers and altar steps stand on the north wall: the wall is left open behind them.
    north = [lancet_opening(w) for w in VAULT_WINDOWS] + kit.apse_openings()
    kit.build_shell(b, room, {"N": sorted(north)}, ROOMS["guardian-vault"]["stile_step"], cornice=False)
    p1 = kit.APSE["p1"]
    kit.cove_cornice(b, room, {"N": [(-room.hx, -p1), (p1, room.hx)]})  # the apse sides close the cove ends
    for w in VAULT_WINDOWS:
        S.WIN = {"x0": -w["half_w"], "x1": w["half_w"], "sill": w["sill"], "spring": w["spring"], "apex": lancet_opening(w)[3]}
        kit.lancet_frame(b, room, w["a"], high)
    T = room.height
    for c in (-4.0, 4.0):
        b.box(-room.hx, room.hx, c - 0.16, c + 0.16, T - 0.32, T, "walnut", drop="txX")
        b.box(c - 0.16, c + 0.16, -room.hy, room.hy, T - 0.28, T, "walnut", drop="tyY")
    # Gilt wall gears; the north one sits inside the apse arch, over the centre lancet.
    kit.wall_gear(b, room, "N", 0.0, 4.8, 0.6, 24, high, slot="gilt")
    kit.wall_gear(b, room, "W", 0.0, 3.4, 1.0, 32, high, slot="gilt")
    kit.wall_gear(b, room, "E", 0.0, 3.4, 1.0, 32, high, slot="gilt")
    kit.arena_circle(b, 0.0, 3.0, high)  # guardian socket (runtime 0, -3)
    for x in (0.35, 1.65):  # processional inlay from the south door to the circle (top face only)
        b.box(x - 0.03, x + 0.03, -room.hy + 0.06, 0.95, 0.0, 0.005, "brass-aged", drop="bxXyY")
    lights = [(f"chandelier_{i}", p, 14.0) for i, p in enumerate(kit.chandelier(b, room, high, 4.3))]
    colliders, apse_lights = kit.apse(b, room, high)
    lights += apse_lights
    for name, (x, z) in zip(("nw", "ne", "sw", "se"), ((-4, -4), (4, -4), (-4, 4), (4, 4))):  # runtime pillar sockets
        pts, box = kit.pillar(b, float(x), float(-z), T)
        colliders.append(box)
        lights += [(f"brazier_{name}_in", pts[0], 30.0, FIRE), (f"brazier_{name}_out", pts[1], 15.0, FIRE)]
    return colliders, lights


BUILDERS = {"hall": build_hall, "corridor": build_corridor, "gear-shaft": build_gear_shaft, "guardian-vault": build_guardian_vault}


def rigid_parts(room: kit.Room, high: bool) -> list:
    """Separate rigid objects a template animates at runtime (each its own glTF node)."""
    if room.piece != "gear-shaft":
        return []
    g = GEAR_RING
    return [kit.gear_ring(f"{g['node']}_high" if high else g["node"], g["pivot_z"], high, g["r_tip"], g["teeth"], g["thick"], g["hub_r"])]


def build(room: kit.Room, high: bool):
    b = S.Builder(f"{room.piece}_high" if high else room.piece)
    colliders, lights = BUILDERS[room.piece](b, room, high)
    obj = b.finish()
    return obj, colliders, lights, rigid_parts(room, high)


def build_lights(room: kit.Room, lights: list) -> None:
    scene = bpy.context.scene
    world = bpy.data.worlds.new(f"{room.piece}_world")
    scene.world = world
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (0.05, 0.035, 0.022, 1.0)
    bg.inputs["Strength"].default_value = 0.5
    for name, loc, energy, *opts in lights:
        o = opts[0] if opts else {}
        data = bpy.data.lights.new(f"{room.piece}_{name}", o.get("type", "POINT"))
        data.energy = energy
        data.shadow_soft_size = 0.02
        data.color = o.get("color", (1.0, 0.58, 0.26))
        if "spot_size" in o:  # a SPOT points down -Z unrotated
            data.spot_size = o["spot_size"]
            data.spot_blend = o["spot_blend"]
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
    if room.piece == "guardian-vault":  # the same late sun, and sky behind each of the three lancets
        sun_data = bpy.data.lights.new("guardian-vault_sun", "SUN")
        sun_data.energy = 7.0
        sun_data.angle = math.radians(1.0)
        sun_data.color = (1.0, 0.86, 0.66)
        sun = bpy.data.objects.new("guardian-vault_sun", sun_data)
        sun.rotation_euler = Vector((0.12, -0.75, -0.65)).normalized().to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(sun)
        for i, w in enumerate(VAULT_WINDOWS):
            o = lancet_opening(w)
            area_data = bpy.data.lights.new(f"guardian-vault_window_sky_{i}", "AREA")
            area_data.shape = "RECTANGLE"
            area_data.size, area_data.size_y = 1.1, o[3] - o[2]
            area_data.energy = 60.0
            area_data.color = (1.0, 0.8, 0.6)
            area = bpy.data.objects.new(f"guardian-vault_window_sky_{i}", area_data)
            area.location = (w["a"], room.hy + 0.4, (o[2] + o[3]) / 2)
            area.rotation_euler = (math.radians(-90), 0, 0)
            scene.collection.objects.link(area)


# ---------------------------------------------------------------------------------------------
# Manifest, reimport
# ---------------------------------------------------------------------------------------------


def manifest_entry(room: kit.Room, colliders: list, lightmap: dict | None, budget: dict) -> dict:
    spec = kit.SPECS[room.piece]
    p = room.piece
    materials = {}
    tile = room_tile(p)
    const = room_const(p)
    emissive = {**EMISSIVE_RUNTIME, **ROOMS[p].get("emissive", {})}
    for slot in ROOMS[p]["slots"]:
        if slot in tile:
            materials[f"{p}_{slot}"] = {"pbr": slot, "tileMeters": tile[slot]}
        else:
            color, rough = const[slot][0], const[slot][1]
            entry = {"color": S.srgb_hex(color)}
            if slot in emissive:
                entry.update({"emissive": S.srgb_hex(color), "emissiveIntensity": emissive[slot]})
            else:
                entry["roughness"] = rough
            materials[f"{p}_{slot}"] = entry
    entry = {
        "template": p,
        "glb": S.GLB_NAME,
        "lightmap": lightmap,
        "id": p,
        **{k: spec[k] for k in ("kinds", "footprint", "doors", "rotations", "enemySockets", "lootSockets", "dressingSockets", "lightSockets", "probe")},
        "walkable": kit.walkable(spec),
        "colliders": [*kit.greybox_colliders(spec), *colliders],
        "budget": budget,
        "materials": materials,
        "glassEmissiveIntensity": 0.8,
    }
    if p == "gear-shaft":
        g = GEAR_RING
        entry["rigidNodes"] = [{
            "node": g["node"], "pivot": [0, g["pivot_z"], 0], "axis": [0, 1, 0], "radPerSec": g["radPerSec"],
            "note": "spin node.rotation.y; lightmap baked at rest with the node invisible to shadow rays, so turning it breaks no baked shadow",
        }]
    return entry


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
    if room.piece == "gear-shaft":
        g = GEAR_RING
        ring = bpy.data.objects.get(g["node"])
        found = ring is not None
        loc = ring.matrix_world.to_translation() if found else Vector((9, 9, 9))
        angle = ring.matrix_world.to_quaternion().angle if found else 9.0
        result["rigid_nodes"] = {g["node"]: {"found": found, "location_blender": [round(v, 4) for v in loc], "rotation_angle": round(angle, 6),
                                             "parent": ring.parent.name if found and ring.parent else None,
                                             "triangles": sum(len(p.vertices) - 2 for p in ring.data.polygons) if found else 0}}
        result["checks"]["gear_ring_node_on_axis"] = found and (loc - Vector((0, 0, g["pivot_z"]))).length < 1e-4 and angle < 1e-6
    result["pass"] = all(result["checks"].values())
    (S.STAGING / "reimport.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    if not result["pass"]:
        raise SystemExit("reimport check failed")


# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------


def export(low, path: Path, rigid: list) -> int:
    if rigid:
        kit.export_glb_multi([low, *rigid], path)
    else:
        S.export_glb(low, path)
    return CANONICALIZE(path)


def main() -> None:
    args = parse_args()
    cfg = ROOMS[args.room]
    room = kit.Room(args.room, cfg["height"])
    kit.configure(room, list(cfg["slots"]), room_tile(args.room), room_const(args.room), cfg["cameras"])
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

    high, _, _, high_rigid = build(room, True)
    grain = P in ("hall", "corridor", "gear-shaft", "guardian-vault")  # P5 rework: lengthwise walnut grain on mouldings and beams
    for obj in (high, *high_rigid):
        S.uv0_tiled(obj)
        if grain:
            report["lengthwise_grain_high"] = report.get("lengthwise_grain_high", 0) + kit.lengthwise_grain(obj)
        S.apply_bevel(obj)
    report["high"] = {"triangles": sum(S.count_tris(o) for o in (high, *high_rigid)), "slots": len(S.SLOTS)}
    high_all = [high, *high_rigid]

    low, colliders, lights, rigid = build(room, False)
    low_all = [low, *rigid]
    backing = S.build_door_backing()
    build_lights(room, lights)
    cams = {name: S.make_camera(name) for name in cfg["cameras"]}
    for obj in low_all:
        S.uv0_tiled(obj)
        if grain:
            report["lengthwise_grain_low"] = report.get("lengthwise_grain_low", 0) + kit.lengthwise_grain(obj)
    bpy.context.view_layer.update()
    if not args.glb_out:
        S.set_visible(low_all, False)
        bpy.ops.wm.save_as_mainfile(filepath=str(S.BLEND_DIR / f"{P}_high.blend"), copy=True, compress=True)
        S.set_visible(low_all, True)

    if rigid:
        kit.unwrap_lightmap_uv_multi(low_all, size, gap_px=10)
    else:
        lm.unwrap_lightmap_uv(low, size, gap_px=10)
    tris = sum(S.count_tris(o) for o in low_all)
    report["low"] = {
        "triangles": tris,
        "vertices": sum(len(o.data.vertices) for o in low_all),
        "materials": len({p.material_index for o in low_all for p in o.data.polygons}),
        "lightmap_density": lm.lightmap_texel_density(low, size),
        "lightmap_density_by_slot": S.density_by_slot(low, size),
    }
    if rigid:
        report["low"]["rigid_nodes"] = {o.name: {"triangles": S.count_tris(o), "lightmap_density": lm.lightmap_texel_density(o, size),
                                                 "location_blender": [round(v, 4) for v in o.location]} for o in rigid}
    print(f"[{P}] high tris={report['high']['triangles']} low tris={tris} density={report['low']['lightmap_density']} by_slot={report['low']['lightmap_density_by_slot']}")
    assert tris <= 100_000 and len(S.SLOTS) <= 16, "PRD room budget exceeded"
    assert report["low"]["materials"] == len(S.SLOTS), "every slot must be used (manifest lists all)"

    glb = Path(args.glb_out) if args.glb_out else S.STAGING / S.GLB_NAME
    report["canonicalized_primitives"] = export(low, glb, rigid)
    report["glb_bytes"] = glb.stat().st_size
    if args.glb_out:
        print(f"[{P}] determinism GLB {glb} {S.sha256(glb)}")
        return

    S.set_visible(high_all, False)
    if "lamp-glass" in S.SLOTS:  # after export, so the GLB's material factors do not depend on it
        kit.bake_transmitting_glass("lamp-glass")
    lightmap = None
    if not args.skip_bake:
        report["device"] = lm.select_device(args.device)
        S.set_metal_links(False)
        load0 = S.load_avg()
        if rigid:
            raw, seconds = kit.bake_irradiance_multi(low_all, size, args.samples, no_shadow=rigid)
        else:
            raw, seconds = lm.bake_irradiance(low, size, args.samples)
        S.set_metal_links(True)
        report["lightmap_bake"] = {"seconds": round(seconds, 2), "host_load": [load0, S.load_avg()], "timing_valid": max(load0, S.load_avg()) <= 15}
        lm.save_exr(raw, S.SCRATCH / f"{P}.lightmap.raw.exr")
        image = lm.denoise_image(raw, S.SCRATCH)
        if rigid:
            rgba = lm.image_rgba(image)
            report["rigid_lightmap"] = {o.name: {"azimuth": kit.azimuth_uniformity(o, rgba, size), "casts_baked_shadow": False} for o in rigid}
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
            S.set_visible(low_all, False)
            S.set_visible(high_all, True)
            S.render_to(cam, renders / f"{name}.high.png")
            S.set_visible(high_all, False)
            S.set_visible(low_all, True)
            S.render_to(cam, renders / f"{name}.low.png")
        if lightmap is not None:
            originals = S.lightmapped_preview_materials(low, S.STAGING / f"{P}.lightmap.png", lightmap["scale"])
            for obj in rigid:  # same slot order: the rigid nodes take the same preview materials
                for i, mat in enumerate(low.data.materials):
                    obj.data.materials[i] = mat
            scene.view_settings.view_transform = "Standard"
            for name, cam in cams.items():
                S.render_to(cam, renders / f"{name}.lightmapped.png")
            for obj in low_all:
                for i, mat in enumerate(originals):
                    obj.data.materials[i] = mat
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

    S.set_visible(high_all, False)
    for obj in high_all:
        bpy.data.objects.remove(obj)
    bpy.ops.wm.save_as_mainfile(filepath=str(S.BLEND_DIR / f"{P}_low.blend"), copy=True, compress=True)
    report["blend"] = {p.name: {"sha256": S.sha256(p), "bytes": p.stat().st_size} for p in sorted(S.BLEND_DIR.glob("*.blend"))}
    report["colliders_added"] = colliders
    report["bake_lights"] = [{"name": n, "blender": [round(v, 4) for v in p], "watts": w, **({"light": o[0]} if o else {})} for n, p, w, *o in lights]
    report["cameras_runtime"] = {k: {"eye": [v["loc"][0], v["loc"][2], -v["loc"][1]], "look": [v["look"][0], v["look"][2], -v["look"][1]], "vfov": v["vfov"]}
                                 for k, v in cfg["cameras"].items()}
    report["host_load_end"] = S.load_avg()
    report["files"] = {p.name: S.sha256(p) for p in sorted(S.STAGING.iterdir()) if p.suffix in {".glb", ".png", ".json", ".ktx2"} and p.name not in ("report.json", "reimport.json")}
    (S.STAGING / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: report[k] for k in ("low", "high")}, indent=2))


CANONICALIZE = kit.load_canonicalize()

if __name__ == "__main__":
    main()
