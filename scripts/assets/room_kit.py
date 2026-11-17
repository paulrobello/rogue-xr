"""Shared helper for the kit room templates (P5-T1 `hall`, `corridor`; P5-T2 `gear-shaft`,
`guardian-vault`), built by build-room-kit.py.

Reuses the approved study generator (scripts/assets/build-room-study.py): it is imported as a
module (its `main()` runs only under `__main__`), so importing never rebuilds the study. The kit then points that namespace's module globals
(PIECE, paths, SLOTS, TILE, CONST, HALF, DOORS, WIN, wall_frame) at the room being built and calls
the study's Builder, material, UV, light, render and export functions unchanged. Only what the
study cannot express is new here: rectangular rooms, the room specs and props.

Frame: Blender Z-up, runtime (x, y, z) = Blender (x, z, -y). Pivot at the floor centre. Footprint,
doors, sockets, walkable and perimeter colliders copy GREYBOX_TEMPLATES in src/content/rooms.ts
with the same float arithmetic, so the manifests equal the greybox templates exactly.
"""

from __future__ import annotations

import importlib.util
import math
import types
from pathlib import Path

from mathutils import Matrix, Vector

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
STUDY_GENERATOR = HERE / "build-room-study.py"
SENTRY_GENERATOR = HERE / "build-cog-sentry.py"


def load_study() -> types.ModuleType:
    """The study generator as a module (its `main()` runs only under `__main__`)."""
    spec = importlib.util.spec_from_file_location("build_room_study", STUDY_GENERATOR)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_canonicalize():
    """`canonicalize_indices` from the Cog Sentry generator (import-safe, the dice precedent)."""
    spec = importlib.util.spec_from_file_location("build_cog_sentry", SENTRY_GENERATOR)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.canonicalize_indices


S = load_study()

# ---------------------------------------------------------------------------------------------
# Room specs: verbatim copies of GREYBOX_TEMPLATES (src/content/rooms.ts), runtime coordinates.
# ---------------------------------------------------------------------------------------------

DOOR_WIDTH = 1.6
GREY_WALL_HEIGHT = 4
GREY_WALL_THICKNESS = 0.2
WALK_INSET = 0.4


def _sock(sid: str, x: float, z: float, yaw: float = 0, y: float = 0) -> dict:
    return {"id": sid, "position": [x, y, z], "yaw": yaw}


def _door(did: str, facing: str, x: float, z: float) -> dict:
    return {"id": did, "facing": facing, "position": [x, 0, z], "width": DOOR_WIDTH}


SPECS = {
    "hall": {
        "kinds": ["entry", "combat", "rest"],
        "footprint": {"min": [-5, -5], "max": [5, 5]},
        "doors": [_door("n", "N", -1, -5), _door("e", "E", 5, 1), _door("s", "S", 1, 5), _door("w", "W", -5, -1)],
        "rotations": [0, 1, 2, 3],
        "enemySockets": [_sock("enemy-a", 0, -2.5, 180), _sock("enemy-b", 2, -2, 200)],
        "lootSockets": [_sock("chest", -3.5, 3.5, 45)],
        "dressingSockets": [_sock("bench-w", -4, 0, 90), _sock("bench-e", 4, 0, 270), _sock("rug", 0, 0)],
        "lightSockets": [_sock("sconce-nw", -4.6, -4.6, 0, 2.2), _sock("sconce-se", 4.6, 4.6, 0, 2.2)],
        "probe": [0, 1.6, 0],
    },
    "corridor": {
        "kinds": ["corridor"],
        "footprint": {"min": [-1, -4], "max": [1, 4]},
        "doors": [_door("n", "N", 0, -4), _door("s", "S", 0, 4)],
        "rotations": [0, 1],
        "enemySockets": [],
        "lootSockets": [],
        "dressingSockets": [_sock("banner", -0.8, 0, 90)],
        "lightSockets": [_sock("lamp", 0.8, 0, 0, 2.2)],
        "probe": [0, 1.6, 0],
    },
}


def walkable(spec: dict) -> list:
    """`template()` in rooms.ts: the footprint inset by 0.4, with the same float operations."""
    fp = spec["footprint"]
    return [{"min": [fp["min"][0] + WALK_INSET, fp["min"][1] + WALK_INSET], "max": [fp["max"][0] - WALK_INSET, fp["max"][1] - WALK_INSET]}]


def perimeter_colliders(spec: dict) -> list:
    """`perimeterColliders()` in rooms.ts, operation for operation, so the doubles match."""
    boxes = []
    (x0, z0), (x1, z1) = spec["footprint"]["min"], spec["footprint"]["max"]
    t = GREY_WALL_THICKNESS / 2
    for facing, fixed, lo, hi in (("N", z0, x0, x1), ("S", z1, x0, x1), ("W", x0, z0, z1), ("E", x1, z0, z1)):
        gaps = []
        for d in spec["doors"]:
            if d["facing"] != facing:
                continue
            along = d["position"][0] if facing in "NS" else d["position"][2]
            gaps.append((along - d["width"] / 2, along + d["width"] / 2))
        gaps.sort()
        start = lo
        for g0, g1 in [*gaps, (hi, hi)]:
            if g0 > start + 1e-6:
                if facing in "NS":
                    boxes.append({"min": [start, 0, fixed - t], "max": [g0, GREY_WALL_HEIGHT, fixed + t]})
                else:
                    boxes.append({"min": [fixed - t, 0, start], "max": [fixed + t, GREY_WALL_HEIGHT, g0]})
            start = max(start, g1)
    return boxes


# ---------------------------------------------------------------------------------------------
# Rectangular room frame (the study's wall_frame assumes a square room)
# ---------------------------------------------------------------------------------------------


class Room:
    """Blender-frame dimensions of a template: half extents hx (x) and hy (y), ceiling height."""

    def __init__(self, piece: str, height: float) -> None:
        fp = SPECS[piece]["footprint"]
        self.piece = piece
        self.hx = float(fp["max"][0])
        self.hy = float(fp["max"][1])
        assert fp["min"][0] == -fp["max"][0] and fp["min"][1] == -fp["max"][1], "kit rooms are centred"
        self.height = height
        # Doors in the study's {wall, c} form, c in Blender coordinates along the wall's axis.
        self.doors = {}
        for d in SPECS[piece]["doors"]:
            x, _, z = d["position"]
            self.doors[d["id"]] = {"wall": d["facing"], "c": float(x) if d["facing"] in "NS" else float(-z)}

    def half(self, wall: str) -> float:
        return self.hx if wall in "NS" else self.hy

    def frame(self, wall: str) -> Matrix:
        """The study's wall_frame (wall-local a along the wall, d into the room, z up) for hx != hy."""
        hx, hy = self.hx, self.hy
        if wall == "N":
            return Matrix(((1, 0, 0, 0), (0, -1, 0, hy), (0, 0, 1, 0), (0, 0, 0, 1)))
        if wall == "S":
            return Matrix(((-1, 0, 0, 0), (0, 1, 0, -hy), (0, 0, 1, 0), (0, 0, 0, 1)))
        if wall == "E":
            return Matrix(((0, -1, 0, hx), (-1, 0, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1)))
        if wall == "W":
            return Matrix(((0, 1, 0, -hx), (1, 0, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1)))
        raise ValueError(wall)

    def door_openings(self, wall: str) -> list:
        out = []
        for door in self.doors.values():
            if door["wall"] == wall:
                a = -door["c"] if wall in ("S", "E") else door["c"]
                out.append((a - S.DOOR_W / 2, a + S.DOOR_W / 2, 0.0, S.DOOR_H))
        return out


def configure(room: Room, slots: list, tile: dict, const: dict, cameras: dict) -> None:
    """Points the study namespace at this room. Every path is re-derived and checked."""
    p = room.piece
    S.PIECE = p
    S.SRC = ROOT / f"assets-source/rooms/{p}"
    S.STAGING = S.SRC / "staging"
    S.BLEND_DIR = S.SRC / "blend"
    S.SCRATCH = ROOT / f".local/rooms/{p}"
    S.RUNTIME = ROOT / f"public/assets/rooms/{p}"
    S.GLB_NAME = f"{p}.glb"
    S.SLOTS[:] = slots
    S.TILE = tile
    S.CONST = const
    S.CAMERAS = cameras
    S.HEIGHT = room.height
    S.HALF = room.hx
    S.DOORS = room.doors
    S.wall_frame = room.frame
    S._MATS.clear()
    for name in ("SRC", "STAGING", "BLEND_DIR", "SCRATCH", "RUNTIME"):
        assert "study" not in str(getattr(S, name)), f"{name} still points at the study"
    assert S.GLB_NAME == f"{p}.glb" and S.PIECE == p


# ---------------------------------------------------------------------------------------------
# Shell: floor, ceiling, panelled walls, door architraves
# ---------------------------------------------------------------------------------------------


def build_shell(b, room: Room, extra_openings: dict, stile_step: float, cornice: bool = True, wainscot: float | None = None,
                ceiling_z: float | None = None, ceiling_hole: float | None = None) -> None:
    """Stone floor, walnut ceiling, walnut wainscot under wallpaper, chair rail, skirting, cornice,
    wainscot stiles and brass-aged door architraves. `extra_openings` maps a wall to window holes.
    The defaults reproduce the original P5-T2 rooms exactly; the hall and corridor pass `cornice=False`
    (they build `cove_cornice`) and a taller `wainscot`. The gear shaft passes `ceiling_z` (walls and
    ceiling stop below `room.height`, which bounds the shaft void above) and `ceiling_hole`, the half
    size of a square hole in the ceiling centred on the room."""
    hx, hy, T = room.hx, room.hy, room.height if ceiling_z is None else ceiling_z
    W = S.WAINSCOT if wainscot is None else wainscot
    height = S.HEIGHT
    S.HEIGHT = T  # wall_rects runs to S.HEIGHT; unchanged when ceiling_z is None
    b.face([(-hx, -hy, 0), (hx, -hy, 0), (hx, hy, 0), (-hx, hy, 0)], (0, 0, 1), "stone-floor")
    if ceiling_hole is None:
        b.face([(-hx, -hy, T), (hx, -hy, T), (hx, hy, T), (-hx, hy, T)], (0, 0, -1), "walnut")
    else:
        h = ceiling_hole
        for x0, x1, y0, y1 in ((-hx, hx, h, hy), (-hx, hx, -hy, -h), (-hx, -h, -h, h), (h, hx, -h, h)):
            b.face([(x0, y0, T), (x1, y0, T), (x1, y1, T), (x0, y1, T)], (0, 0, -1), "walnut")
    for wall in "NSEW":
        half = room.half(wall)
        b.xf = room.frame(wall)
        openings = room.door_openings(wall) + extra_openings.get(wall, [])
        S.HALF = half
        for a0, a1, z0, z1 in S.wall_rects(openings):
            if z0 < W < z1:
                b.face([(a0, 0, z0), (a1, 0, z0), (a1, 0, W), (a0, 0, W)], (0, 1, 0), "walnut")
                b.face([(a0, 0, W), (a1, 0, W), (a1, 0, z1), (a0, 0, z1)], (0, 1, 0), "wallpaper")
            else:
                slot = "walnut" if z1 <= W else "wallpaper"
                b.face([(a0, 0, z0), (a1, 0, z0), (a1, 0, z1), (a0, 0, z1)], (0, 1, 0), slot)
        spans = [(-half, half)]
        for o in openings:
            if o[2] < W + 0.1:
                spans = [s for sp in spans for s in ((sp[0], min(sp[1], o[0])), (max(sp[0], o[1]), sp[1])) if s[1] - s[0] > 1e-6]
        for a0, a1 in spans:
            b.box(a0, a1, 0, 0.04, W - 0.03, W + 0.05, "walnut", drop="xXy")  # chair rail
            b.box(a0, a1, 0, 0.025, 0, 0.14, "walnut", drop="xXyb")  # skirting
            # Wainscot stiles, evenly spaced inside the span, clear of door architraves.
            lo, hi = a0 + 0.2, a1 - 0.2
            if hi - lo > 0.3:
                n = max(1, round((hi - lo) / stile_step))
                for k in range(n + 1):
                    a = lo + (hi - lo) * k / n
                    b.box(a - 0.03, a + 0.03, 0, 0.018, 0.14, W - 0.03, "walnut", drop="ybt")
        if cornice:
            b.box(-half, half, 0, 0.14, T - 0.18, T, "walnut", drop="xXyt")  # cornice
        for o in room.door_openings(wall):
            f = 0.12
            b.box(o[0] - f, o[0], 0, 0.05, 0, o[3] + f, "brass-aged", drop="yb")
            b.box(o[1], o[1] + f, 0, 0.05, 0, o[3] + f, "brass-aged", drop="yb")
            b.box(o[0], o[1], 0, 0.05, o[3], o[3] + f, "brass-aged", drop="yxX")
            b.face([(o[0], 0, 0), (o[0], 0.05, 0), (o[0], 0.05, o[3]), (o[0], 0, o[3])], (1, 0, 0), "brass-aged")
            b.face([(o[1], 0, 0), (o[1], 0.05, 0), (o[1], 0.05, o[3]), (o[1], 0, o[3])], (-1, 0, 0), "brass-aged")
            b.face([(o[0], 0, o[3]), (o[1], 0, o[3]), (o[1], 0.05, o[3]), (o[0], 0.05, o[3])], (0, 0, -1), "brass-aged")
            # Brass threshold plate across the doorway, inside the footprint: the neighbour room's
            # plate meets it on the shared edge.
            b.box(o[0], o[1], 0, 0.06, 0, 0.012, "brass-aged", drop="by")
        b.xf = Matrix.Identity(4)
    S.HALF = room.hx
    S.HEIGHT = height


# ---------------------------------------------------------------------------------------------
# Props (runtime colliders returned as runtime Box dicts)
# ---------------------------------------------------------------------------------------------


def candle(b, cx: float, cy: float, z: float, h: float, high: bool, r: float = 0.018) -> Vector:
    """Wax candle standing at z with a crossed-card flame. Returns the flame centre."""
    seg = 16 if high else 8
    b.cylinder(cx, cy, r, z, z + h, seg, "wax", caps="t")
    S.flame(b, cx, cy, z + h + 0.01)
    return b.xf @ Vector((cx, cy, z + h + 0.035))


def bench(b, cx: float, cy: float, length_y: float, high: bool) -> dict:
    """Backless walnut hall bench, long axis along Blender y, with brass-aged foot caps."""
    w, l2, top = 0.21, length_y / 2, 0.47
    b.box(cx - w, cx + w, cy - l2, cy + l2, top - 0.06, top, "walnut")
    for sx in (-1, 1):
        for sy in (-1, 1):
            lx, ly = cx + sx * (w - 0.06), cy + sy * (l2 - 0.08)
            b.box(lx - 0.025, lx + 0.025, ly - 0.025, ly + 0.025, 0.04, top - 0.06, "walnut", drop="bt")
            b.box(lx - 0.032, lx + 0.032, ly - 0.032, ly + 0.032, 0.0, 0.04, "brass-aged", drop="b")
    b.box(cx - 0.02, cx + 0.02, cy - l2 + 0.1, cy + l2 - 0.1, 0.16, 0.2, "walnut", drop="xX")  # stretcher
    b.box(cx - w - 0.005, cx + w + 0.005, cy - l2 - 0.005, cy + l2 + 0.005, top - 0.075, top - 0.06, "brass-aged", drop="t")  # apron band
    return S.runtime_box(Vector((cx - w - 0.005, cy - l2 - 0.005, 0)), Vector((cx + w + 0.005, cy + l2 + 0.005, 0)), top)


def medallion(b, high: bool) -> None:
    """Brass compass medallion inlaid in the floor at the room centre (the `rug` socket)."""
    seg = 64 if high else 32
    b.annulus(0, 0, 1.12, 1.24, 0.0, 0.006, seg, "brass-aged", sides="to")
    b.annulus(0, 0, 0.56, 0.62, 0.0, 0.006, seg, "brass-aged", sides="tio")
    for k in range(16):
        b.xf = Matrix.Rotation(2 * math.pi * k / 16, 4, "Z")
        b.box(0.62, 1.12, -0.018, 0.018, 0.0, 0.005, "brass-aged", drop="bxX")
        b.xf = Matrix.Identity(4)
    # Eight-point star, long points on the cardinal axes.
    pts = []
    for k in range(16):
        r = 0.52 if k % 4 == 0 else (0.3 if k % 2 == 0 else 0.12)
        a = 2 * math.pi * k / 16
        pts.append((r * math.cos(a), r * math.sin(a)))
    z = 0.007
    for i in range(16):
        (ax, ay), (bx_, by_) = pts[i], pts[(i + 1) % 16]
        b.face([(0, 0, z), (ax, ay, z), (bx_, by_, z)], (0, 0, 1), "brass-polished")
        b.face([(ax, ay, 0), (bx_, by_, 0), (bx_, by_, z), (ax, ay, z)], (ax + bx_, ay + by_, 0), "brass-polished")


def chandelier(b, room: Room, high: bool, ring_z: float) -> list:
    """Gear-ring chandelier on a drop rod from the ceiling, eight candles on the rim."""
    seg = 32 if high else 12
    S.SHAFT_R = 0.025
    T = room.height
    b.cylinder(0, 0, 0.025, ring_z, T, seg // 2, "brass-polished", caps="")
    b.annulus(0, 0, 0.025, 0.16, T - 0.05, T, seg, "brass-aged", sides="bo")  # ceiling rose
    b.annulus(0, 0, 0.025, 0.05, (ring_z + T) / 2 - 0.03, (ring_z + T) / 2 + 0.03, seg, "brass-aged", sides="tbo")
    b.gear(ring_z, 0.72, 30, 0.06, "brass-aged", high)
    b.cylinder(0, 0, 0.06, ring_z - 0.16, ring_z - 0.03, seg, "brass-polished", caps="b")  # finial
    flames = []
    top = ring_z + 0.03
    for k in range(8):
        a = 2 * math.pi * (k + 0.5) / 8
        cx, cy = 0.585 * math.cos(a), 0.585 * math.sin(a)
        b.cylinder(cx, cy, 0.034, top, top + 0.02, seg, "brass-polished", caps="tb")
        flames.append(candle(b, cx, cy, top + 0.02, 0.12, high, r=0.016))
    return flames


def lantern(b, x: float, y: float, z: float, wall_x: float, high: bool) -> Vector:
    """Hexagonal brass wall lantern centred at (x, y, z) on a bracket from the wall at x = wall_x,
    amber glass panes around a candle. Returns the flame point."""
    seg = 6
    sgn = 1 if wall_x > x else -1
    b.box(min(wall_x, wall_x - sgn * 0.025), max(wall_x, wall_x - sgn * 0.025), y - 0.07, y + 0.07, z + 0.05, z + 0.37, "brass-aged", drop="x" if sgn < 0 else "X")
    b.box(min(x, wall_x), max(x, wall_x), y - 0.012, y + 0.012, z + 0.3, z + 0.33, "brass-polished", drop="")
    # The runtime glass is opaque and emissive, so nothing is built inside it: inner faces would
    # only bake next to the lamp's bake light and set the lightmap scale.
    r, z0, z1 = 0.09, z - 0.13, z + 0.13
    b.cylinder(x, y, r + 0.015, z0 - 0.03, z0, seg, "brass-aged", caps="b")  # base
    b.cylinder(x, y, r * 0.95, z0, z1, seg, "lamp-glass", caps="")  # panes
    for k in range(seg):  # corner posts
        a = 2 * math.pi * k / seg
        px, py = x + r * math.cos(a), y + r * math.sin(a)
        b.box(px - 0.008, px + 0.008, py - 0.008, py + 0.008, z0, z1, "brass-aged", drop="bt")
    b.cylinder(x, y, r + 0.015, z1, z1 + 0.025, seg, "brass-aged", caps="t")
    b.cylinder(x, y, 0.05, z1 + 0.025, z1 + 0.07, seg, "brass-aged", caps="t")  # cap
    b.cylinder(x, y, 0.012, z1 + 0.07, z + 0.33, 6, "brass-polished", caps="")
    return Vector((x, y, z))


def bake_transmitting_glass(slot: str) -> None:
    """Lets bake light pass a constant glass slot (the study's stained-glass mix, 85% transparent);
    the runtime material stays opaque and emissive."""
    mat = S.material(slot)
    nt = mat.node_tree
    bsdf = S.bsdf_of(mat)
    transp = nt.nodes.new("ShaderNodeBsdfTransparent")
    transp.inputs["Color"].default_value = bsdf.inputs["Base Color"].default_value
    mix = nt.nodes.new("ShaderNodeMixShader")
    mix.inputs["Fac"].default_value = 0.85
    out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
    nt.links.new(bsdf.outputs["BSDF"], mix.inputs[1])
    nt.links.new(transp.outputs["BSDF"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])


def banner(b, wall_x: float, x_face: float, y: float, high: bool) -> None:
    """Ruby swallow-tail banner on a brass rod in front of the west wall (wall at x = wall_x, cloth
    face at x = x_face), with a flat brass gear emblem. Flush with the wall, so no collider."""
    w2, top, bottom, notch = 0.34, 2.85, 1.25, 0.22
    pts = [(y - w2, top), (y + w2, top), (y + w2, bottom), (y, bottom + notch), (y - w2, bottom)]
    b.face([(x_face, py, pz) for py, pz in pts], (1, 0, 0), "cloth")
    b.face([(x_face - 0.004, py, pz) for py, pz in pts], (-1, 0, 0), "cloth")
    seg = 24 if high else 12
    for sy in (-1, 1):  # wall arms
        b.box(wall_x, x_face + 0.03, y + sy * w2 - 0.012, y + sy * w2 + 0.012, top + 0.015, top + 0.04, "brass-polished", drop="x")
    b.box(x_face - 0.02, x_face + 0.02, y - w2 - 0.05, y + w2 + 0.05, top, top + 0.03, "brass-polished")  # rod
    for sy in (-1, 1):
        b.cylinder(x_face, y + sy * (w2 + 0.06), 0.022, top - 0.01, top + 0.045, seg, "brass-aged", caps="tb")  # finials
    b.xf = Matrix.Translation((x_face + 0.006, y, 2.25)) @ Matrix.Rotation(math.pi / 2, 4, "Y")
    S.SHAFT_R = 0.03
    b.gear(0.0, 0.2, 14, 0.01, "brass-polished", high)
    b.xf = Matrix.Identity(4)


# ---------------------------------------------------------------------------------------------
# P5-T1 rework (hall and corridor only; the gear-shaft and vault builds never call these)
# ---------------------------------------------------------------------------------------------


def cove_cornice(b, room: Room, spans: dict | None = None, depth: float = 0.36, height: float = 0.3, top: float | None = None) -> None:
    """Sloped walnut cove where each wall meets the ceiling, mitred at the room corners. It faces down
    into the room, so it is lit by the lamps below; a vertical cornice face seen from below reflects
    the probe at grazing angles and reads as grey streaks. `spans` maps a wall to wall-local (a0, a1)
    runs (default: the whole wall); an end inside a wall must be closed by the caller's geometry.
    `top` is the ceiling height when it is below `room.height` (the gear shaft)."""
    T = room.height if top is None else top
    for wall in "NSEW":
        half = room.half(wall)
        b.xf = room.frame(wall)
        for a0, a1 in (spans or {}).get(wall, [(-half, half)]):
            m0 = depth if a0 <= -half + 1e-6 else 0.0
            m1 = depth if a1 >= half - 1e-6 else 0.0
            b.face([(a0, 0, T - height), (a1, 0, T - height), (a1 - m1, depth, T), (a0 + m0, depth, T)], (0, height, -depth), "walnut")
        b.xf = Matrix.Identity(4)


def lengthwise_grain(obj, slot: str = "walnut", ratio: float = 2.5, max_short: float = 0.5) -> int:
    """Turns UV0 a quarter turn on long, narrow faces of a tiled slot, after S.uv0_tiled. The walnut
    grain runs along the texture's v axis, which uv0_tiled maps to z on vertical faces and y on
    horizontal ones, so a chair rail, skirting, frieze or beam side otherwise shows short cross-grain
    streaks. Returns the number of faces turned."""
    mesh = obj.data
    uv = mesh.uv_layers["UVMap"].data
    index = S.SLOTS.index(slot)
    turned = 0
    for poly in mesh.polygons:
        if poly.material_index != index:
            continue
        pts = [mesh.vertices[mesh.loops[li].vertex_index].co for li in poly.loop_indices]
        n = poly.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        ext = [max(p[i] for p in pts) - min(p[i] for p in pts) for i in range(3)]
        grain, across = (ext[1], ext[0]) if ax == 2 else (ext[2], ext[1] if ax == 0 else ext[0])
        if grain <= max_short and across > ratio * grain:
            for li in poly.loop_indices:
                u, v = uv[li].uv
                uv[li].uv = (-v, u)
            turned += 1
    return turned


def pilaster(b, a: float, z0: float, z1: float) -> None:
    """Flat walnut pilaster with brass-aged base and capital, in the current wall frame."""
    b.box(a - 0.09, a + 0.09, 0, 0.05, z0 + 0.06, z1 - 0.08, "walnut", drop="ybt")
    b.box(a - 0.11, a + 0.11, 0, 0.07, z0, z0 + 0.06, "brass-aged", drop="y")
    b.box(a - 0.11, a + 0.11, 0, 0.07, z1 - 0.08, z1, "brass-aged", drop="y")


def moulding_frame(b, a0: float, a1: float, z0: float, z1: float, w: float = 0.04, proud: float = 0.015, d0: float = 0.0) -> None:
    """Applied walnut panel moulding (a rectangle of strips) on a surface at depth `d0`, in the current
    wall frame."""
    d1 = d0 + proud
    b.box(a0, a1, d0, d1, z0, z0 + w, "walnut", drop="y")
    b.box(a0, a1, d0, d1, z1 - w, z1, "walnut", drop="y")
    b.box(a0, a0 + w, d0, d1, z0 + w, z1 - w, "walnut", drop="ybt")
    b.box(a1 - w, a1, d0, d1, z0 + w, z1 - w, "walnut", drop="ybt")


def wall_niche(b, room: Room, wall: str, a: float, high: bool) -> Vector:
    """Walnut aedicule niche (0.7 m wide, 1.45 to 2.5 m, 0.29 m proud) with a candle on a brass stand.
    Inside the 0.4 m walkable inset, so it needs no collider. Returns the flame point."""
    b.xf = room.frame(wall)
    seg = 16 if high else 8
    b.face([(a - 0.27, 0.012, 1.5), (a + 0.27, 0.012, 1.5), (a + 0.27, 0.012, 2.35), (a - 0.27, 0.012, 2.35)], (0, 1, 0), "walnut")
    for s in (-1, 1):
        b.box(a + s * 0.31 - 0.04, a + s * 0.31 + 0.04, 0, 0.22, 1.5, 2.35, "walnut", drop="ybt")
    b.box(a - 0.38, a + 0.38, 0, 0.26, 1.41, 1.5, "walnut", drop="y")  # sill
    b.box(a - 0.4, a + 0.4, 0, 0.27, 2.35, 2.47, "walnut", drop="y")  # head
    b.box(a - 0.42, a + 0.42, 0, 0.29, 2.47, 2.5, "brass-aged", drop="y")  # cap
    b.cylinder(a, 0.12, 0.05, 1.5, 1.52, seg, "brass-polished", caps="t")
    flame = candle(b, a, 0.12, 1.52, 0.16, high)
    b.xf = Matrix.Identity(4)
    return flame


def candelabrum(b, x: float, y: float, flame_z: float, high: bool) -> tuple[list, dict]:
    """Standing brass candelabrum (replaces the torchere): weighted foot and column, three arms carry the candles
    0.2 m out from the column, each on its own small bobeche. The old shared drip pan under all three
    flames shadowed a 1.3 m disc of floor, so the corners were the darkest floor in the bake. One
    arm points at the room centre. Returns flame points and the collider (the old torchere footprint)."""
    seg = 24 if high else 12
    arm_z = flame_z - 0.195
    b.cylinder(x, y, 0.17, 0.0, 0.035, seg, "brass-aged", caps="t")
    b.cylinder(x, y, 0.09, 0.035, 0.11, seg, "brass-aged", caps="t")
    b.cylinder(x, y, 0.022, 0.11, arm_z + 0.1, seg // 2, "brass-polished", caps="t")
    b.annulus(x, y, 0.022, 0.05, 0.9, 0.96, seg, "brass-aged", sides="tbo")  # knop
    b.annulus(x, y, 0.022, 0.045, arm_z - 0.03, arm_z + 0.03, seg, "brass-aged", sides="tbo")  # arm boss
    flames = []
    a0 = math.atan2(-y, -x)
    for k in range(3):
        t = a0 + 2 * math.pi * k / 3
        b.xf = Matrix.Translation((x, y, 0)) @ Matrix.Rotation(t, 4, "Z")
        b.box(0.04, 0.2, -0.011, 0.011, arm_z - 0.011, arm_z + 0.011, "brass-polished", drop="x")
        b.xf = Matrix.Identity(4)
        cx, cy = x + 0.2 * math.cos(t), y + 0.2 * math.sin(t)
        b.cylinder(cx, cy, 0.032, arm_z - 0.011, arm_z + 0.02, seg // 2, "brass-polished", caps="tb")
        flames.append(candle(b, cx, cy, arm_z + 0.02, 0.14, high))
    lo, hi = Vector((x - 0.17, y - 0.17, 0)), Vector((x + 0.17, y + 0.17, 0))
    return flames, S.runtime_box(lo, hi, arm_z + 0.02)


def fireplace(b, room: Room, wall: str, a: float, high: bool) -> tuple[list, dict, tuple]:
    """Hall role anchor: a stone chimney breast 1.6 m wide and 0.45 m deep to the ceiling, an open
    firebox (0.9 x 0.8 m, 0.37 m deep) with grate, logs, ember bed and flames, a walnut mantel at
    1.1 m, a wallpaper overmantel framed in walnut with a brass gear, a stone hearth slab and a
    brass fender. The shell must leave the wall open behind it (pass `breast_span` to build_shell).
    Returns [(name, Blender point, watts)] bake lights, the collider and the breast's (a0, a1)."""
    T = room.height
    D, a0, a1 = 0.45, a - 0.8, a + 0.8
    o0, o1, oz, back = a - 0.45, a + 0.45, 0.8, 0.08
    seg = 24 if high else 12
    b.xf = room.frame(wall)
    # Breast front: stone surround, wallpaper overmantel, walnut crown; stone and wallpaper sides.
    b.face([(a0, D, 0), (o0, D, 0), (o0, D, 1.1), (a0, D, 1.1)], (0, 1, 0), "stone-floor")
    b.face([(o1, D, 0), (a1, D, 0), (a1, D, 1.1), (o1, D, 1.1)], (0, 1, 0), "stone-floor")
    b.face([(o0, D, oz), (o1, D, oz), (o1, D, 1.1), (o0, D, 1.1)], (0, 1, 0), "stone-floor")
    b.face([(a0, D, 1.1), (a1, D, 1.1), (a1, D, T - 0.2), (a0, D, T - 0.2)], (0, 1, 0), "wallpaper")
    for s, x in ((-1, a0), (1, a1)):
        b.face([(x, 0, 0), (x, D, 0), (x, D, 1.1), (x, 0, 1.1)], (s, 0, 0), "stone-floor")
        b.face([(x, 0, 1.1), (x, D, 1.1), (x, D, T - 0.2), (x, 0, T - 0.2)], (s, 0, 0), "wallpaper")
    b.box(a0 - 0.04, a1 + 0.04, 0, D + 0.04, T - 0.2, T, "walnut", drop="yt")  # crown
    b.box(a0 - 0.08, a1 + 0.08, D - 0.02, D + 0.14, 1.1, 1.18, "walnut", drop="y")  # mantel shelf
    for x in (a0 + 0.1, a1 - 0.1):  # mantel corbels
        b.box(x - 0.05, x + 0.05, D, D + 0.08, 0.86, 1.1, "walnut", drop="yt")
    moulding_frame(b, a0 + 0.12, a1 - 0.12, 1.32, T - 0.36, d0=D)
    b.xf = room.frame(wall) @ Matrix.Translation((a, D + 0.05, 2.45)) @ Matrix.Rotation(-math.pi / 2, 4, "X")
    S.SHAFT_R = 0.08
    b.gear(0.0, 0.42, 24, 0.04, "brass-aged", high)
    b.cylinder(0, 0, 0.08, -0.03, 0.05, seg, "brass-polished", caps="t")
    b.xf = room.frame(wall)
    # Firebox lining (stone; the room floor is its hearth floor).
    b.face([(o0, back, 0), (o1, back, 0), (o1, back, oz), (o0, back, oz)], (0, 1, 0), "stone-floor")
    b.face([(o0, back, 0), (o0, D, 0), (o0, D, oz), (o0, back, oz)], (1, 0, 0), "stone-floor")
    b.face([(o1, back, 0), (o1, D, 0), (o1, D, oz), (o1, back, oz)], (-1, 0, 0), "stone-floor")
    b.face([(o0, back, oz), (o1, back, oz), (o1, D, oz), (o0, D, oz)], (0, 0, -1), "stone-floor")
    # Grate, logs, ember bed, flames.
    for d0 in (0.12, 0.36):
        b.box(o0 + 0.08, o1 - 0.08, d0, d0 + 0.02, 0.02, 0.1, "brass-aged", drop="b")
    for k in range(5):
        x = o0 + 0.15 + k * (o1 - o0 - 0.3) / 4
        b.box(x - 0.01, x + 0.01, 0.14, 0.36, 0.08, 0.1, "brass-aged", drop="bxX")
    b.face([(o0 + 0.1, 0.14, 0.1), (o1 - 0.1, 0.14, 0.1), (o1 - 0.1, 0.36, 0.1), (o0 + 0.1, 0.36, 0.1)], (0, 0, 1), "flame")
    b.box(o0 + 0.14, o1 - 0.16, 0.16, 0.24, 0.1, 0.18, "walnut", drop="b")  # logs
    b.box(o0 + 0.18, o1 - 0.12, 0.26, 0.33, 0.1, 0.17, "walnut", drop="b")
    for da, h, r in ((-0.2, 0.26, 0.07), (0.0, 0.36, 0.09), (0.2, 0.24, 0.07)):
        big_flame(b, a + da, 0.25, 0.17, h, r)
    # Hearth slab and fender.
    b.box(a0 - 0.05, a1 + 0.05, D, D + 0.4, 0.0, 0.04, "stone-floor", drop="by")
    b.box(o0 - 0.12, o1 + 0.12, D + 0.28, D + 0.3, 0.1, 0.13, "brass-polished")
    for x in (o0 - 0.11, o1 + 0.11):
        b.cylinder(x, D + 0.29, 0.018, 0.04, 0.16, seg // 2, "brass-polished", caps="t")
    fire = b.xf @ Vector((a + 0.05, 0.34, 0.32))  # in front of the flame cards, above the front grate bar
    glow = b.xf @ Vector((a, D + 0.15, 0.45))
    lo, hi = b.xf @ Vector((a0 - 0.08, 0, 0)), b.xf @ Vector((a1 + 0.08, D + 0.4, 0))
    b.xf = Matrix.Identity(4)
    return [("hearth_fire", fire, 25.0), ("hearth_glow", glow, 12.0)], S.runtime_box(lo, hi, T), (a0, a1)


def lantern_open(b, x: float, y: float, z: float, wall_x: float, high: bool) -> Vector:
    """`lantern` with a glass floor pane inside a thin brass rim instead of a solid base. The solid
    base under the bake light shadowed a 1.6 m disc of floor, so the corridor was darkest under its
    own lamp. Returns the flame point."""
    seg = 6
    sgn = 1 if wall_x > x else -1
    b.box(min(wall_x, wall_x - sgn * 0.025), max(wall_x, wall_x - sgn * 0.025), y - 0.07, y + 0.07, z + 0.05, z + 0.37, "brass-aged", drop="x" if sgn < 0 else "X")
    b.box(min(x, wall_x), max(x, wall_x), y - 0.012, y + 0.012, z + 0.3, z + 0.33, "brass-polished", drop="")
    r, z0, z1 = 0.09, z - 0.13, z + 0.13
    b.annulus(x, y, r * 0.95, r + 0.015, z0 - 0.03, z0, seg, "brass-aged")  # rim
    ring = [(x + r * 0.95 * math.cos(2 * math.pi * k / seg), y + r * 0.95 * math.sin(2 * math.pi * k / seg)) for k in range(seg)]
    b.face([(px, py, z0 - 0.015) for px, py in ring], (0, 0, -1), "lamp-glass")  # floor pane
    b.cylinder(x, y, r * 0.95, z0, z1, seg, "lamp-glass", caps="")  # panes
    for k in range(seg):  # corner posts
        a = 2 * math.pi * k / seg
        px, py = x + r * math.cos(a), y + r * math.sin(a)
        b.box(px - 0.008, px + 0.008, py - 0.008, py + 0.008, z0, z1, "brass-aged", drop="bt")
    b.cylinder(x, y, r + 0.015, z1, z1 + 0.025, seg, "brass-aged", caps="t")
    b.cylinder(x, y, 0.05, z1 + 0.025, z1 + 0.07, seg, "brass-aged", caps="t")  # cap
    b.cylinder(x, y, 0.012, z1 + 0.07, z + 0.33, 6, "brass-polished", caps="")
    return Vector((x, y, z))


# ---------------------------------------------------------------------------------------------
# P5-T2: gear-shaft chamber and guardian vault
# ---------------------------------------------------------------------------------------------

SPECS["gear-shaft"] = {
    "kinds": ["combat", "corridor"],
    "footprint": {"min": [-4, -6], "max": [4, 6]},
    "doors": [_door("n", "N", 1, -6), _door("s", "S", -1, 6), _door("w", "W", -4, 1)],
    "rotations": [0, 1, 2, 3],
    "enemySockets": [_sock("enemy-a", 0, -3.5, 180), _sock("enemy-b", -2, -3, 160), _sock("enemy-c", 2, -3, 200)],
    "lootSockets": [],
    "dressingSockets": [_sock("shaft", 0, 0), _sock("crate", 3, 4.5)],
    "lightSockets": [_sock("furnace", 0, 0, 0, 0.5), _sock("lamp-n", 3.6, -5.6, 0, 2.4), _sock("lamp-s", -3.6, 5.6, 0, 2.4)],
    "probe": [2, 1.6, 2],
    "extraColliders": [{"min": [-1.2, 0, -1.2], "max": [1.2, 4, 1.2]}],
}
SPECS["guardian-vault"] = {
    "kinds": ["guardian"],
    "footprint": {"min": [-6, -6], "max": [6, 6]},
    "doors": [_door("s", "S", 1, 6)],
    "rotations": [0, 1, 2, 3],
    "enemySockets": [_sock("guardian", 0, -3, 180)],
    "lootSockets": [_sock("reward", 0, -5, 180)],
    "dressingSockets": [_sock("pillar-nw", -4, -4), _sock("pillar-ne", 4, -4), _sock("pillar-sw", -4, 4), _sock("pillar-se", 4, 4)],
    "lightSockets": [_sock("brazier-nw", -4, -4, 0, 1.4), _sock("brazier-ne", 4, -4, 0, 1.4), _sock("brazier-sw", -4, 4, 0, 1.4),
                     _sock("brazier-se", 4, 4, 0, 1.4)],
    "probe": [0, 2, 0],
    # rooms.ts: [-4, 4].flatMap((x) => [-4, 4].map((z) => ...)), same order and arithmetic.
    "extraColliders": [{"min": [x - 0.5, 0, z - 0.5], "max": [x + 0.5, 4, z + 0.5]} for x in (-4, 4) for z in (-4, 4)],
}


def greybox_colliders(spec: dict) -> list:
    """`template()` in rooms.ts: perimeter boxes, then the greybox's extraColliders verbatim."""
    return [*perimeter_colliders(spec), *spec.get("extraColliders", [])]


def unwrap_lightmap_uv_multi(objs: list, size: int, gap_px: int = 10) -> None:
    """lightmap_helpers.unwrap_lightmap_uv for several objects packed into ONE UV1 atlas (multi-object
    edit mode packs every island together), so a rigid animated node shares the room's lightmap."""
    import bpy

    for obj in objs:
        mesh = obj.data
        if S.lm.LIGHTMAP_UV not in mesh.uv_layers:
            mesh.uv_layers.new(name=S.lm.LIGHTMAP_UV)
        mesh.uv_layers.active = mesh.uv_layers[S.lm.LIGHTMAP_UV]
    if bpy.context.object is not None and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    for other in bpy.context.view_layer.objects:
        other.select_set(other in objs)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.0, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(rotate=True, margin_method="FRACTION", margin=gap_px / size)
    bpy.ops.object.mode_set(mode="OBJECT")


def bake_irradiance_multi(objs: list, size: int, samples: int, no_shadow: list, margin_px: int = 8):
    """lightmap_helpers.bake_irradiance for several objects into one image in one bake call. Objects
    in `no_shadow` (rigid animated nodes) are invisible to shadow rays, so the static surfaces carry
    no baked shadow of a part that moves at runtime."""
    import time

    import bpy

    scene = bpy.context.scene
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    image = bpy.data.images.new(f"{objs[0].name}_lightmap", size, size, alpha=True, float_buffer=True)
    image.generated_color = (0.0, 0.0, 0.0, 0.0)
    image.colorspace_settings.name = "Non-Color"
    mats = []
    for obj in objs:
        for slot in obj.material_slots:
            if slot.material not in mats:
                mats.append(slot.material)
    restore = []
    for mat in mats:
        nodes = mat.node_tree.nodes
        metallic = next(n for n in nodes if n.type == "BSDF_PRINCIPLED").inputs["Metallic"]
        restore.append((mat, metallic.default_value))
        metallic.default_value = 0.0
        tex = nodes.new("ShaderNodeTexImage")
        tex.name = "lightmap_bake_target"
        tex.image = image
        nodes.active = tex
    for obj in objs:
        obj.data.uv_layers.active = obj.data.uv_layers[S.lm.LIGHTMAP_UV]
    for obj in no_shadow:
        obj.visible_shadow = False
    for other in bpy.context.view_layer.objects:
        other.select_set(other in objs)
    bpy.context.view_layer.objects.active = objs[0]
    started = time.monotonic()
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, margin=margin_px, margin_type="EXTEND",
                        use_clear=True, target="IMAGE_TEXTURES")
    elapsed = time.monotonic() - started
    for obj in no_shadow:
        obj.visible_shadow = True
    for mat, value in restore:
        nodes = mat.node_tree.nodes
        next(n for n in nodes if n.type == "BSDF_PRINCIPLED").inputs["Metallic"].default_value = value
        nodes.remove(nodes["lightmap_bake_target"])
    for obj in objs:
        obj.data.uv_layers.active = obj.data.uv_layers[0]
    return image, elapsed


def export_glb_multi(objs: list, path: Path) -> None:
    """The study's export_glb with several selected objects (room plus its rigid animated nodes)."""
    import bpy

    for other in bpy.context.view_layer.objects:
        other.select_set(other in objs)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", use_selection=True, use_active_scene=True, export_texcoords=True,
                              export_normals=True, export_tangents=False, export_materials="EXPORT", export_image_format="NONE",
                              export_cameras=False, export_lights=False, export_apply=True, export_extras=False)


def azimuth_uniformity(obj, rgba, size: int, sectors: int = 8) -> dict:
    """Area-weighted mean baked irradiance of a rigid node's faces per azimuth sector about its local
    Z axis. A node spinning about Z carries its texels with it, so similar sectors mean the turned
    node still reads as lit by the static lights. `rgba` is lightmap_helpers.image_rgba (row 0 top)."""
    import numpy as np

    mesh = obj.data
    uv = mesh.uv_layers[S.lm.LIGHTMAP_UV].data
    lum = rgba[..., :3] @ np.array([0.2126, 0.7152, 0.0722])
    acc = [[0.0, 0.0] for _ in range(sectors)]
    for poly in mesh.polygons:
        if poly.area <= 1e-9:
            continue
        n = len(poly.loop_indices)
        u = sum(uv[i].uv.x for i in poly.loop_indices) / n
        v = sum(uv[i].uv.y for i in poly.loop_indices) / n
        px, py = min(size - 1, max(0, int(u * size))), min(size - 1, max(0, int((1 - v) * size)))
        c = poly.center
        k = int(((math.atan2(c.y, c.x) % (2 * math.pi)) / (2 * math.pi)) * sectors) % sectors
        acc[k][0] += float(lum[py, px]) * poly.area
        acc[k][1] += poly.area
    means = [a / w if w else 0.0 for a, w in acc]
    lo, hi = min(means), max(means)
    return {"sector_means": [round(m, 5) for m in means], "min_over_max": round(lo / hi, 3) if hi else 0.0, "sectors": sectors}


def gear_ring(name: str, pivot_z: float, high: bool, r_tip: float, teeth: int, thick: float, hub_r: float):
    """The gear-shaft's turning crown gear: its own Builder and object (never welded to the shaft),
    built around its own Z axis, origin on the rotation axis at height `pivot_z`."""
    b = S.Builder(name)
    S.SHAFT_R = hub_r
    b.gear(0.0, r_tip, teeth, thick, "gilt", high)
    seg = 64 if high else 32
    rim_in = r_tip - min(0.08, r_tip * 0.12) - min(0.08, r_tip * 0.13)
    b.annulus(0, 0, rim_in - 0.09, rim_in, -thick / 2 + 0.015, thick / 2 - 0.015, seg, "brass-polished", sides="tbi")  # inner bead
    b.annulus(0, 0, hub_r, hub_r + 0.16, thick / 2 + 0.02, thick / 2 + 0.07, seg // 2, "brass-polished", sides="tbo")  # hub collars
    b.annulus(0, 0, hub_r, hub_r + 0.16, -thick / 2 - 0.07, -thick / 2 - 0.02, seg // 2, "brass-polished", sides="tbo")
    for s in range(6):  # heavy spokes between the gear's own light ones
        b.xf = Matrix.Rotation(2 * math.pi * s / 6, 4, "Z")
        b.box(hub_r + 0.12, rim_in - 0.08, -0.045, 0.045, -thick / 2 + 0.01, thick / 2 - 0.01, "gilt", drop="xX")
        b.xf = Matrix.Identity(4)
    obj = b.finish()
    obj.location = (0.0, 0.0, pivot_z)
    return obj


def furnace_shaft(b, high: bool, height: float, shaft_r: float) -> list:
    """Masonry firebox inside the greybox's 2.4 m shaft collider with a grate on each face over a bed of
    coals and a row of flame cards, and the polished drive shaft rising from it to a boss at `height`
    (the top of the shaft void). Returns four bake-light points in open air outside the grates: 4-fold
    symmetric about the axis, so the turning ring sees even light."""
    h = 1.1
    seg = 48 if high else 20
    fz = 1.3
    b.box(-h - 0.05, h + 0.05, -h - 0.05, h + 0.05, 0.0, 0.16, "brass-aged", drop="b")  # plinth
    b.box(-h - 0.05, h + 0.05, -h - 0.05, h + 0.05, fz - 0.12, fz, "brass-aged", drop="")  # cap band
    lights = []
    for k in range(4):
        b.xf = Matrix.Rotation(math.pi / 2 * k, 4, "Z")
        # Stone face around a recessed grate opening (y -0.45..0.45, z 0.25..0.8).
        b.face([(h, -h, 0.16), (h, -0.45, 0.16), (h, -0.45, fz - 0.12), (h, -h, fz - 0.12)], (1, 0, 0), "stone-floor")
        b.face([(h, 0.45, 0.16), (h, h, 0.16), (h, h, fz - 0.12), (h, 0.45, fz - 0.12)], (1, 0, 0), "stone-floor")
        b.face([(h, -0.45, 0.16), (h, 0.45, 0.16), (h, 0.45, 0.25), (h, -0.45, 0.25)], (1, 0, 0), "stone-floor")
        b.face([(h, -0.45, 0.8), (h, 0.45, 0.8), (h, 0.45, fz - 0.12), (h, -0.45, fz - 0.12)], (1, 0, 0), "stone-floor")
        d = h - 0.1  # ember panel depth
        b.face([(d, -0.45, 0.25), (d, 0.45, 0.25), (d, 0.45, 0.8), (d, -0.45, 0.8)], (1, 0, 0), "coals")
        for y, fh in ((-0.3, 0.3), (-0.1, 0.42), (0.1, 0.38), (0.3, 0.28)):  # flames in front of the coals
            b.face([(h - 0.06, y - 0.09, 0.27), (h - 0.06, y + 0.09, 0.27), (h - 0.06, y, 0.27 + fh)], (1, 0, 0), "flame")
        b.face([(d, -0.45, 0.25), (h, -0.45, 0.25), (h, 0.45, 0.25), (d, 0.45, 0.25)], (0, 0, 1), "stone-floor")
        b.face([(d, -0.45, 0.8), (h, -0.45, 0.8), (h, 0.45, 0.8), (d, 0.45, 0.8)], (0, 0, -1), "stone-floor")
        b.face([(d, -0.45, 0.25), (h, -0.45, 0.25), (h, -0.45, 0.8), (d, -0.45, 0.8)], (0, 1, 0), "stone-floor")
        b.face([(d, 0.45, 0.25), (h, 0.45, 0.25), (h, 0.45, 0.8), (d, 0.45, 0.8)], (0, -1, 0), "stone-floor")
        for j in range(7):
            y = -0.39 + j * 0.13
            b.box(h - 0.04, h + 0.01, y - 0.015, y + 0.015, 0.25, 0.8, "brass-polished", drop="bt")
        b.box(h - 0.02, h + 0.04, -0.52, 0.52, 0.8, 0.87, "brass-polished", drop="")  # lintel
        lights.append(b.xf @ Vector((h + 0.45, 0.0, 0.55)))
        b.xf = Matrix.Identity(4)
    b.annulus(0, 0, shaft_r, 0.75, fz, fz + 0.12, seg, "brass-aged", sides="to")  # collar
    b.cylinder(0, 0, shaft_r, fz + 0.12, height, seg, "brass-polished", caps="")
    for z in (2.2, 2.9, 4.4, 7.4):
        b.annulus(0, 0, shaft_r, shaft_r + 0.06, z - 0.04, z + 0.04, seg, "brass-aged", sides="tbo")
    b.annulus(0, 0, shaft_r, 0.85, height - 0.14, height, seg, "brass-aged", sides="bo")  # ceiling boss
    return lights


def crate(b, cx: float, cy: float, s: float) -> dict:
    """Walnut parts crate with brass-aged corner straps. Returns its runtime collider."""
    h = s / 2
    b.box(cx - h, cx + h, cy - h, cy + h, 0.0, s, "walnut", drop="b")
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = cx + sx * (h - 0.03), cy + sy * (h - 0.03)
            b.box(x - 0.035, x + 0.035, y - 0.035, y + 0.035, 0.0, s + 0.01, "brass-aged", drop="b")
    b.box(cx - h - 0.01, cx + h + 0.01, cy - h - 0.01, cy + h + 0.01, s * 0.45, s * 0.55, "brass-aged", drop="bt")  # band
    return S.runtime_box(Vector((cx - h - 0.04, cy - h - 0.04, 0)), Vector((cx + h + 0.04, cy + h + 0.04, 0)), s + 0.01)


def big_flame(b, cx: float, cy: float, z: float, h: float, r: float) -> None:
    """Crossed-card brazier flame (the study's candle flame, scaled)."""
    for ang in (0.0, math.pi / 2):
        c, s = math.cos(ang), math.sin(ang)
        b.face([(cx - r * c, cy - r * s, z), (cx + r * c, cy + r * s, z), (cx, cy, z + h)], (-s, c, 0), "flame")


def pillar(b, cx: float, cy: float, height: float) -> tuple[list, dict]:
    """Stone vault pillar inside the greybox's 1 m collider: brass plinth and capital, and a brass
    brazier trough around it at the 1.4 m light socket. Returns two bake-light points in open air
    (room-facing and wall-facing diagonals) and the brazier's added collider."""
    b.box(cx - 0.5, cx + 0.5, cy - 0.5, cy + 0.5, 0.0, 0.2, "brass-aged", drop="b")
    b.box(cx - 0.42, cx + 0.42, cy - 0.42, cy + 0.42, 0.2, height - 0.42, "stone-floor", drop="bt")
    b.box(cx - 0.5, cx + 0.5, cy - 0.5, cy + 0.5, height - 0.42, height - 0.3, "brass-aged", drop="")
    b.box(cx - 0.46, cx + 0.46, cy - 0.46, cy + 0.46, height - 0.3, height, "walnut", drop="t")
    z0, z1, ro = 1.2, 1.4, 0.66
    b.box(cx - ro, cx + ro, cy - ro, cy + ro, z0, z1, "brass-aged", drop="t")
    b.box(cx - ro - 0.03, cx + ro + 0.03, cy - ro - 0.03, cy + ro + 0.03, z1 - 0.03, z1 + 0.01, "brass-polished", drop="")  # lip
    for k in range(4):  # coal bed between the pillar and the lip, solid flame tongues along it
        b.xf = Matrix.Translation((cx, cy, 0)) @ Matrix.Rotation(math.pi / 2 * k, 4, "Z")
        b.face([(0.42, -0.42, z1 + 0.012), (ro, -ro, z1 + 0.012), (ro, ro, z1 + 0.012), (0.42, 0.42, z1 + 0.012)], (0, 0, 1), "coals")
        for t, fh, fr in ((-0.33, 0.24, 0.05), (-0.11, 0.34, 0.065), (0.11, 0.3, 0.06), (0.33, 0.22, 0.05)):
            flame_tongue(b, 0.54, t, z1 + 0.012, fh, fr)
        b.xf = Matrix.Identity(4)
    for sx in (-1, 1):  # bracket feet down the pillar corners
        for sy in (-1, 1):
            x, y = cx + sx * 0.47, cy + sy * 0.47
            b.box(x - 0.03, x + 0.03, y - 0.03, y + 0.03, 0.9, z0, "brass-polished", drop="t")
    toward = Vector((-cx, -cy, 0)).normalized()
    lights = [Vector((cx, cy, 1.75)) + toward * 0.95, Vector((cx, cy, 1.75)) - toward * 0.95]
    collider = S.runtime_box(Vector((cx - ro - 0.04, cy - ro - 0.04, 0)), Vector((cx + ro + 0.04, cy + ro + 0.04, 0)), z1 + 0.01)
    return lights, collider


def arena_circle(b, cx: float, cy: float, high: bool) -> None:
    """Brass duelling circle inlaid in the floor under the guardian socket (6 mm proud, no collider)."""
    seg = 72 if high else 40
    sides = "tio" if high else "t"
    b.annulus(cx, cy, 1.9, 2.02, 0.0, 0.006, seg, "brass-aged", sides=sides)
    b.annulus(cx, cy, 1.55, 1.6, 0.0, 0.006, seg, "brass-polished", sides=sides)
    for k in range(24):
        b.xf = Matrix.Translation((cx, cy, 0)) @ Matrix.Rotation(2 * math.pi * k / 24, 4, "Z")
        b.box(1.6, 1.9, -0.02, 0.02, 0.0, 0.005, "brass-aged", drop="bxX" if high else "bxXyY")
        b.xf = Matrix.Identity(4)


def wall_gear(b, room: Room, wall: str, a: float, z: float, r_tip: float, teeth: int, high: bool, slot: str = "brass-aged") -> None:
    """Flat gear relief on a wall (wall-local a, centre height z), its face toward the room."""
    S.SHAFT_R = 0.1
    # Hub collars reach 0.04 m behind the gear's mid-plane: 0.05 keeps everything inside the wall.
    b.xf = room.frame(wall) @ Matrix.Translation((a, 0.05, z)) @ Matrix.Rotation(-math.pi / 2, 4, "X")
    b.gear(0.0, r_tip, teeth, 0.04, slot, high)
    b.cylinder(0, 0, 0.1, -0.03, 0.05, 24 if high else 12, "brass-polished", caps="t")
    b.xf = Matrix.Identity(4)


# ---------------------------------------------------------------------------------------------
# P5-T2 rework (gear-shaft and guardian vault only; the hall and corridor builds never call these)
# ---------------------------------------------------------------------------------------------


def flame_tongue(b, cx: float, cy: float, z: float, h: float, r: float, seg: int = 6) -> None:
    """Solid low-poly flame: a six-sided spindle standing at z, widest at 0.3 h, closed at both ends."""
    zr = z + 0.3 * h
    ring = [(cx + r * math.cos(2 * math.pi * (i + 0.5) / seg), cy + r * math.sin(2 * math.pi * (i + 0.5) / seg)) for i in range(seg)]
    for i in range(seg):
        (ax, ay), (bx_, by_) = ring[i], ring[(i + 1) % seg]
        mx, my = (ax + bx_) / 2 - cx, (ay + by_) / 2 - cy
        b.face([(cx, cy, z), (bx_, by_, zr), (ax, ay, zr)], (mx, my, -0.3), "flame")
        b.face([(ax, ay, zr), (bx_, by_, zr), (cx, cy, z + h)], (mx, my, 0.3), "flame")


def furnace_pit(b, high: bool) -> dict:
    """Grated coal pit around the furnace plinth behind a 0.31 m stone kerb with a brass cap. The floor
    stays at z = 0, so the kerb gives the pit its depth: coals glow 6 cm under brass bars. Returns the
    kerb's runtime collider (clear of the enemy sockets and door aprons)."""
    p, k0, k1, kz = 1.15, 1.6, 1.8, 0.28
    for x0, x1, y0, y1 in ((-k0, k0, p, k0), (-k0, k0, -k0, -p), (p, k0, -p, p), (-k0, -p, -p, p)):
        b.face([(x0, y0, 0.004), (x1, y0, 0.004), (x1, y1, 0.004), (x0, y1, 0.004)], (0, 0, 1), "coals")
    for s in (-1, 1):
        y0, y1 = sorted((s * k0, s * k1))
        b.box(-k1, k1, y0, y1, 0.0, kz, "stone-floor", drop="bt")
        b.box(-k1 - 0.02, k1 + 0.02, y0 - 0.02, y1 + 0.02, kz, kz + 0.03, "brass-aged", drop="b")
        x0, x1 = sorted((s * k0, s * k1))
        b.box(x0, x1, -k0, k0, 0.0, kz, "stone-floor", drop="btyY")
        b.box(x0 - 0.02, x1 + 0.02, -k0 + 0.02, k0 - 0.02, kz, kz + 0.03, "brass-aged", drop="byY")
        # Bars bridge plinth and kerb (ends buried). The low build keeps only their tops: 3 cm sides seen
        # from a seated eye barely show, and each is a lightmap island with its own gutter.
        yb0, yb1 = sorted((s * p, s * k0))
        for i in range(21):
            x = -1.5 + 0.15 * i
            b.box(x - 0.015, x + 0.015, yb0, yb1, 0.06, 0.09, "brass-aged", drop="byY" if high else "bxXyY")
        xb0, xb1 = sorted((s * p, s * k0))
        for i in range(15):
            y = -1.05 + 0.15 * i
            b.box(xb0, xb1, y - 0.015, y + 0.015, 0.06, 0.09, "brass-aged", drop="bxX" if high else "bxXyY")
    return S.runtime_box(Vector((-k1 - 0.02, -k1 - 0.02, 0)), Vector((k1 + 0.02, k1 + 0.02, 0)), kz + 0.03)


def shaft_well(b, z0: float, z1: float, h: float, zg: float, high: bool) -> list:
    """The shaft void over the ceiling hole (half size h): masonry well walls from the ceiling at z0 to a
    walnut lid at z1, a brass lip round the mouth, and a walnut gallery ring at zg with a brass rail and
    a candle in each corner. Everything is 4-fold symmetric about the shaft axis, so the turning crown
    gear below bakes evenly. Returns the four candle flame points."""
    for k in range(4):
        b.xf = Matrix.Rotation(math.pi / 2 * k, 4, "Z")
        b.face([(h, -h, z0), (h, h, z0), (h, h, z1), (h, -h, z1)], (-1, 0, 0), "stone-floor")
        b.box(h, h + 0.12, -h - 0.12, h, z0 - 0.14, z0, "brass-aged", drop="tY")  # mouth lip
        g = h - 0.45  # gallery ledge, inner edge at g
        b.box(g, h, -h, g, zg - 0.08, zg, "walnut", drop="XY")
        # Rail and post faces toward the well wall or up are not seen from the floor below.
        b.box(g - 0.02, g + 0.02, -g, g, zg + 0.86, zg + 0.9, "brass-aged", drop="tX")  # top rail
        b.box(g - 0.015, g + 0.015, -g, g, zg + 0.44, zg + 0.47, "brass-aged", drop="tX")  # mid rail
        for i in range(6):
            y = -g + 2 * g * i / 6
            b.box(g - 0.02, g + 0.02, y - 0.02, y + 0.02, zg, zg + 0.86, "brass-aged", drop="btX")
        b.xf = Matrix.Identity(4)
    b.face([(-h, -h, z1), (h, -h, z1), (h, h, z1), (-h, h, z1)], (0, 0, -1), "walnut")  # lid
    flames = []
    c = h - 0.22
    for sx, sy in ((1, 1), (-1, 1), (-1, -1), (1, -1)):
        b.cylinder(sx * c, sy * c, 0.05, zg, zg + 0.02, 16 if high else 8, "brass-polished", caps="t")
        flames.append(candle(b, sx * c, sy * c, zg + 0.02, 0.16, high))
    return flames


def gear_train(b, high: bool, z_lo: float, z_hi: float, shaft_r: float) -> None:
    """Static gear train up the shaft void: gear A on the drive shaft meshes B on a secondary shaft on
    the diagonal; C on the secondary shaft meshes D on the drive shaft above. Centre distance 1.47 m is
    the sum of the pitch radii (tip less half the tooth depth) of both pairs. Each gear is turned so a
    tooth meets the other gear's gap on the line of centres."""
    c = 1.47 / math.sqrt(2)
    gears = [  # x, y, z, tip radius, teeth, phase frac (0.34 tooth centre, 0.84 gap centre), at angle, shaft radius
        (0.0, 0.0, z_lo, 0.95, 32, 0.34, 45.0, shaft_r),
        (c, c, z_lo, 0.6, 20, 0.84, 225.0, 0.07),
        (c, c, z_hi, 0.9, 30, 0.34, 225.0, 0.07),
        (0.0, 0.0, z_hi, 0.65, 22, 0.84, 45.0, shaft_r),
    ]
    for x, y, z, r, n, frac, at, sr in gears:
        S.SHAFT_R = sr
        b.xf = Matrix.Translation((x, y, 0)) @ Matrix.Rotation(math.radians(at) - 2 * math.pi * frac / n, 4, "Z")
        b.gear(z, r, n, 0.08, "gilt", high)
        b.xf = Matrix.Identity(4)
    seg = 16 if high else 8
    b.cylinder(c, c, 0.07, z_lo - 0.35, z_hi + 0.35, seg, "brass-polished", caps="tb")  # secondary shaft
    for z in (z_lo - 0.3, z_hi + 0.3):  # bearing arms to the well corner
        b.xf = Matrix.Translation((c, c, 0)) @ Matrix.Rotation(math.pi / 4, 4, "Z")
        b.box(0.07, 1.46, -0.03, 0.03, z - 0.03, z + 0.03, "brass-aged", drop="xX")
        b.xf = Matrix.Identity(4)


def lancet_frame(b, room: Room, a: float, high: bool) -> None:
    """The study's lancet (S.WIN: glass, wallpaper spandrels, deep sill, brass mullion) in the north
    wall at wall-local a, with a pointed walnut frame that follows the arch: jambs to the springing line
    and an arch band of the same 0.12 m width round the point, so no rectangle frames the glass."""
    b.xf = room.frame("N") @ Matrix.Translation((a, 0, 0))
    seg = 24 if high else 10
    left, right = S.arch_points(seg)
    x0, x1, sill, zs, apex = S.WIN["x0"], S.WIN["x1"], S.WIN["sill"], S.WIN["spring"], S.WIN["apex"]
    glass = [(x0, sill), (x1, sill), (x1, zs), *right[1:-1], (0.0, apex), *reversed(left[1:-1]), (x0, zs)]
    b.face([(u, 0.01, z) for u, z in glass], (0, 1, 0), "stained-glass")
    b.face([(x0, 0, zs), *[(u, 0, z) for u, z in left[1:-1]], (0.0, 0, apex), (x0, 0, apex)], (0, 1, 0), "wallpaper")
    b.face([(x1, 0, zs), (x1, 0, apex), (0.0, 0, apex), *[(u, 0, z) for u, z in reversed(right[1:-1])]], (0, 1, 0), "wallpaper")
    f, d = 0.12, 0.08
    b.box(x0 - f, x0, 0, d, sill - 0.1, zs, "walnut", drop="yt")
    b.box(x1, x1 + f, 0, d, sill - 0.1, zs, "walnut", drop="yt")
    w = x1 - x0
    t_in, t_out = math.acos(0.5), math.acos(x1 / (w + f))
    for sgn, cx in ((1, x1), (-1, x0)):  # left arc (centre x1), right arc (centre x0)
        inner = [(cx - sgn * w * math.cos(t_in * i / seg), zs + w * math.sin(t_in * i / seg)) for i in range(seg + 1)]
        outer = [(cx - sgn * (w + f) * math.cos(t_out * i / seg), zs + (w + f) * math.sin(t_out * i / seg)) for i in range(seg + 1)]
        for i in range(seg):
            (ia, iz), (ib, jz) = inner[i], inner[i + 1]
            (oa, oz), (ob, pz) = outer[i], outer[i + 1]
            b.face([(ia, d, iz), (ib, d, jz), (ob, d, pz), (oa, d, oz)], (0, 1, 0), "walnut")  # front
            mx, mz = (ia + ib) / 2 - cx, (iz + jz) / 2 - zs
            b.face([(ia, 0, iz), (ib, 0, jz), (ib, d, jz), (ia, d, iz)], (-mx, 0, -mz), "walnut")  # soffit
            b.face([(oa, 0, oz), (ob, 0, pz), (ob, d, pz), (oa, d, oz)], (mx, 0, mz), "walnut")  # extrados
    b.box(x0 - f - 0.05, x1 + f + 0.05, 0, 0.26, sill - 0.1, sill, "walnut", drop="y")
    b.box(-0.02, 0.02, 0.012, 0.05, sill, apex - 0.15, "brass-polished", drop="bt")
    b.xf = Matrix.Identity(4)


APSE = {"p0": 1.15, "p1": 1.75, "front": 4.7, "spring": 3.7}  # Blender: inner and outer half width, front y, springing


def apse_openings() -> list:
    """North-wall holes behind the apse piers (the piers stand on the wall). No hole behind the altar:
    its x range overlaps the centre lancet, and wall_rects takes one opening per span."""
    p0, p1, zs = APSE["p0"], APSE["p1"], APSE["spring"]
    return [(-p1, -p0, 0.0, zs), (p0, p1, 0.0, zs)]


def apse(b, room: Room, high: bool) -> tuple[list, list]:
    """The vault's focal structure on the north wall behind the guardian: a stone frontispiece 3.5 m
    wide and 1.3 m deep, full height, opened by an equilateral pointed arch (2.3 m span, springing at
    3.7 m) over a barrel soffit to the wall, framing the centre lancet; brass-aged plinth and impost
    bands; inside it a stepped stone altar and reredos behind the reward socket with a gilt gear
    reliquary and two candles. The sockets and the floor stay where the greybox puts them. Returns
    runtime colliders (piers, altar) and (name, point, watts) bake lights."""
    p0, p1, y0, zs = APSE["p0"], APSE["p1"], APSE["front"], APSE["spring"]
    y1, T = room.hy, room.height
    seg = 24 if high else 12
    t_end = math.acos(0.5)
    w = 2 * p0
    left = [(p0 - w * math.cos(t_end * i / seg), zs + w * math.sin(t_end * i / seg)) for i in range(seg + 1)]  # x < 0 arc
    apex = left[-1][1]
    for s in (-1, 1):
        arc = [(-s * x, z) for x, z in left]  # s = -1: the arc on the x < 0 side; s = 1 mirrors it
        b.face([(s * p0, y0, 0), (s * p1, y0, 0), (s * p1, y0, zs), (s * p0, y0, zs)], (0, -1, 0), "stone-floor")  # pier front
        b.face([(s * p1, y0, zs), *[(x, y0, z) for x, z in arc[:-1]], (0.0, y0, apex), (0.0, y0, T), (s * p1, y0, T)], (0, -1, 0), "stone-floor")
        b.face([(s * p1, y0, 0), (s * p1, y1, 0), (s * p1, y1, T), (s * p1, y0, T)], (s, 0, 0), "stone-floor")  # outer side
        b.face([(s * p0, y0, 0), (s * p0, y1, 0), (s * p0, y1, zs), (s * p0, y0, zs)], (-s, 0, 0), "stone-floor")  # inner side
        for i in range(seg):  # barrel soffit from the arch front to the wall
            (xa, za), (xb, zb) = arc[i], arc[i + 1]
            mx, mz = (xa + xb) / 2 - (-s * p0), (za + zb) / 2 - zs
            b.face([(xa, y0, za), (xb, y0, zb), (xb, y1, zb), (xa, y1, za)], (-mx, 0, -mz), "stone-floor")
        x0, x1 = sorted((s * (p0 - 0.03), s * (p1 + 0.03)))
        b.box(x0, x1, y0 - 0.04, y1, 0.0, 0.22, "brass-aged", drop="bY")  # plinth band
        b.box(x0, x1, y0 - 0.04, y1, zs - 0.15, zs, "brass-aged", drop="tY")  # impost band
    # Altar: two steps, a plinth with brass bands, a reredos, a gilt gear reliquary and two candles.
    b.box(-0.9, 0.9, 5.45, y1, 0.0, 0.15, "stone-floor", drop="bY")
    b.box(-0.75, 0.75, 5.6, y1, 0.15, 0.3, "stone-floor", drop="bY")
    b.box(-0.45, 0.45, 5.62, y1, 0.36, 0.89, "stone-floor", drop="bY")
    b.box(-0.49, 0.49, 5.6, y1, 0.3, 0.36, "brass-aged", drop="bY")
    b.box(-0.5, 0.5, 5.58, y1, 0.89, 0.95, "brass-polished", drop="Y")
    b.box(-0.9, 0.9, 5.92, y1, 0.95, 1.3, "stone-floor", drop="Y")  # reredos
    b.box(-0.93, 0.93, 5.89, y1, 1.3, 1.36, "brass-aged", drop="Y")
    b.box(-0.04, 0.04, 5.63, 5.69, 0.95, 1.08, "brass-aged", drop="bt")  # reliquary post
    b.xf = Matrix.Translation((0.0, 5.66, 1.36)) @ Matrix.Rotation(-math.pi / 2, 4, "X")
    S.SHAFT_R = 0.05
    b.gear(0.0, 0.3, 16, 0.04, "gilt", high)
    b.cylinder(0, 0, 0.05, -0.03, 0.05, 16 if high else 8, "brass-polished", caps="t")
    b.xf = Matrix.Identity(4)
    lights = []
    for name, x in (("altar_w", -0.72), ("altar_e", 0.72)):
        b.cylinder(x, 5.55, 0.045, 0.15, 0.17, 16 if high else 8, "brass-polished", caps="t")
        lights.append((name, candle(b, x, 5.55, 0.17, 0.22, high, r=0.022), 6.0))
    colliders = [S.runtime_box(Vector((-p1 - 0.03, y0 - 0.04, 0)), Vector((-p0 + 0.03, y1, 0)), T),
                 S.runtime_box(Vector((p0 - 0.03, y0 - 0.04, 0)), Vector((p1 + 0.03, y1, 0)), T),
                 S.runtime_box(Vector((-0.93, 5.45, 0)), Vector((0.93, y1, 0)), 1.36)]
    return colliders, lights
