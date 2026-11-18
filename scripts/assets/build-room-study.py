"""Hero room template `study` (P4-T4): high and low builds, books high-to-low bake, UV1 lightmap
bake, image-free GLB, KTX2 maps, renders and a build report.

Build:
    "$BLENDER" -b --factory-startup --python-exit-code 1 -P scripts/assets/build-room-study.py -- \
        [--skip-bake] [--size 2048] [--samples 256] [--device GPU|CPU] [--no-renders]
Clean reimport check (fresh process):
    "$BLENDER" -b --factory-startup --python-exit-code 1 -P scripts/assets/build-room-study.py -- --reimport

Frame: Blender Z-up, runtime (x, y, z) = Blender (x, z, -y). Pivot at the floor centre. The
footprint, doors and sockets copy the greybox `study` in src/content/rooms.ts exactly.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import shutil
import subprocess
import sys
import time
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lightmap_helpers as lm  # noqa: E402
import room_panels as panels  # noqa: E402

PIECE = "study"
ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "assets-source/rooms/study"
STAGING = SRC / "staging"
BLEND_DIR = SRC / "blend"
SCRATCH = ROOT / ".local/rooms/study"  # gitignored: EXR intermediates
RUNTIME = ROOT / "public/assets/rooms/study"
MATERIAL_DIR = ROOT / "public/assets/materials"
KTX = Path.home() / ".local/opt/ktx-software-4.4.2/bin/ktx"

HALF = 4.0
HEIGHT = 4.0
WAINSCOT = 1.0
DOOR_W = 1.6
DOOR_H = 2.4
# Doors in Blender coordinates: runtime door s (-1, 0, 4) and e (4, 0, -1).
DOORS = {"s": {"wall": "S", "c": -1.0}, "e": {"wall": "E", "c": 1.0}}
WIN = {"x0": -0.6, "x1": 0.6, "sill": 1.4, "spring": 2.55}
WIN["apex"] = WIN["spring"] + math.sqrt(1.2**2 - 0.6**2)
SHELF_DEPTH = 0.38
BOOKCASES = [  # (wall, start, end) along the wall's own axis
    ("N", -3.4, -1.0),
    ("N", 1.0, 3.4),
    ("W", -1.4, 1.4),
]
DESK = {"cx": 2.4, "cy": -2.4, "w": 1.3, "d": 0.62, "top": 0.78, "angle": math.radians(-135)}
CANDLE_BASE_OFFSET = 0.29
CANDLES = [(-0.42, 0.18), (0.36, 0.2)]  # desk-local (x, y) of the two desk candles
SCONCES = [("E", -2.6), ("S", 2.8), ("W", 2.5)]  # clear of both doorways
GEARS = [  # z, tip radius, teeth, thickness
    (0.10, 0.56, 22, 0.08),
    (0.95, 0.34, 14, 0.06),
    (2.45, 0.95, 32, 0.09),
    (2.95, 0.66, 24, 0.08),
    (3.42, 0.86, 28, 0.08),
]
SHAFT_R = 0.16

# Material slots. Tiled slots bind the approved P4-T3 set by name; the rest are constants or the
# baked props atlas. Order is the slot order of every low object, so joins keep indices.
SLOTS = ["stone-floor", "wallpaper", "walnut", "brass-aged", "brass-polished", "stained-glass", "books", "wax", "flame"]
TILE = {"stone-floor": 1.5, "wallpaper": 0.75, "walnut": 0.5, "brass-aged": 0.5, "brass-polished": 0.5, "stained-glass": 0.6}
CONST = {  # linear base colour, roughness, metallic, emission strength
    "books": ((0.12, 0.06, 0.04), 0.7, 0.0, 0.0),
    "wax": ((0.80, 0.68, 0.48), 0.55, 0.0, 0.0),
    "flame": ((1.0, 0.62, 0.22), 0.5, 0.0, 6.0),
}
BOOK_COLORS = [  # linear: ruby, sapphire, emerald, oxblood, tan, walnut, warm black, ochre
    (0.29, 0.03, 0.04), (0.03, 0.07, 0.29), (0.02, 0.18, 0.08), (0.20, 0.04, 0.03),
    (0.40, 0.25, 0.12), (0.10, 0.05, 0.025), (0.03, 0.025, 0.02), (0.45, 0.30, 0.08),
]
CAMERAS = {
    # Runtime eye height 1.6 m. hero: from the south door looking north at the shaft and window.
    "hero": {"loc": (1.6, -3.2, 1.6), "look": (-0.4, 4.0, 2.2), "vfov": 70.0},
    "desk": {"loc": (-2.8, 0.6, 1.6), "look": (2.4, -2.4, 0.9), "vfov": 70.0},
}
RENDER_W, RENDER_H = 1280, 720
LIGHTMAP_PERCENTILE = 99.6
GLB_NAME = f"{PIECE}.glb"


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--size", type=int, default=2048)
    p.add_argument("--atlas", type=int, default=2048)
    p.add_argument("--samples", type=int, default=256)
    p.add_argument("--device", choices=["GPU", "CPU"], default="GPU")
    p.add_argument("--skip-bake", action="store_true")
    p.add_argument("--no-renders", action="store_true")
    p.add_argument("--glb-out", default="", help="write only the GLB here (determinism runs)")
    p.add_argument("--reimport", action="store_true")
    return p.parse_args(argv)


def load_avg() -> float:
    return round(os.getloadavg()[0], 2)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ---------------------------------------------------------------------------------------------
# Geometry builder
# ---------------------------------------------------------------------------------------------


class Builder:
    """One bmesh with slot-indexed faces. Every face is created with its own vertices; `finish`
    welds them, so coplanar neighbours share one lightmap island."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.bm = bmesh.new()
        self.xf = Matrix.Identity(4)
        self.smooth_faces: list = []

    def face(self, pts: list, normal: tuple, slot: str, smooth: bool = False) -> None:
        pts = [self.xf @ Vector(p) for p in pts]
        n = (self.xf.to_3x3() @ Vector(normal)).normalized()
        verts = [self.bm.verts.new(p) for p in pts]
        f = self.bm.faces.new(verts)
        f.normal_update()
        if f.normal.dot(n) < 0:
            f.normal_flip()
        f.material_index = SLOTS.index(slot)
        f.smooth = smooth

    def box(self, x0, x1, y0, y1, z0, z1, slot: str, drop: str = "") -> None:
        """Axis-aligned box; `drop` lists faces to leave out: b(ottom) t(op) x X y Y (min/max)."""
        if "t" not in drop:
            self.face([(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], (0, 0, 1), slot)
        if "b" not in drop:
            self.face([(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0)], (0, 0, -1), slot)
        if "x" not in drop:
            self.face([(x0, y0, z0), (x0, y1, z0), (x0, y1, z1), (x0, y0, z1)], (-1, 0, 0), slot)
        if "X" not in drop:
            self.face([(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)], (1, 0, 0), slot)
        if "y" not in drop:
            self.face([(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)], (0, -1, 0), slot)
        if "Y" not in drop:
            self.face([(x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)], (0, 1, 0), slot)

    def cylinder(self, cx, cy, r, z0, z1, seg: int, slot: str, caps: str = "bt", inward: bool = False) -> None:
        ring = [(cx + r * math.cos(2 * math.pi * i / seg), cy + r * math.sin(2 * math.pi * i / seg)) for i in range(seg)]
        sgn = -1 if inward else 1
        for i in range(seg):
            (ax, ay), (bx, by) = ring[i], ring[(i + 1) % seg]
            mx, my = (ax + bx) / 2 - cx, (ay + by) / 2 - cy
            self.face([(ax, ay, z0), (bx, by, z0), (bx, by, z1), (ax, ay, z1)], (sgn * mx, sgn * my, 0), slot, smooth=True)
        if "t" in caps:
            self.face([(x, y, z1) for x, y in ring], (0, 0, 1), slot)
        if "b" in caps:
            self.face([(x, y, z0) for x, y in ring], (0, 0, -1), slot)

    def annulus(self, cx, cy, r0, r1, z0, z1, seg: int, slot: str, sides: str = "tbio") -> None:
        for i in range(seg):
            a, b = 2 * math.pi * i / seg, 2 * math.pi * (i + 1) / seg
            p = lambda r, t, z: (cx + r * math.cos(t), cy + r * math.sin(t), z)  # noqa: E731
            if "t" in sides:
                self.face([p(r0, a, z1), p(r1, a, z1), p(r1, b, z1), p(r0, b, z1)], (0, 0, 1), slot)
            if "b" in sides:
                self.face([p(r0, a, z0), p(r1, a, z0), p(r1, b, z0), p(r0, b, z0)], (0, 0, -1), slot)
            m = (a + b) / 2
            if "o" in sides:
                self.face([p(r1, a, z0), p(r1, b, z0), p(r1, b, z1), p(r1, a, z1)], (math.cos(m), math.sin(m), 0), slot, smooth=True)
            if "i" in sides:
                self.face([p(r0, a, z0), p(r0, b, z0), p(r0, b, z1), p(r0, a, z1)], (-math.cos(m), -math.sin(m), 0), slot, smooth=True)

    def gear(self, zc: float, r_tip: float, teeth: int, thick: float, slot: str, high: bool) -> None:
        """Spur gear around the shaft: toothed rim, spokes and hub."""
        r_root = r_tip - min(0.08, r_tip * 0.12)
        rim_in = r_root - min(0.08, r_tip * 0.13)
        hub = SHAFT_R + 0.06
        z0, z1 = zc - thick / 2, zc + thick / 2
        prof = [(0.0, r_root), (0.18, r_tip), (0.5, r_tip), (0.68, r_root)] if not high else [
            (0.0, r_root), (0.1, r_root + (r_tip - r_root) * 0.55), (0.18, r_tip), (0.34, r_tip),
            (0.5, r_tip), (0.58, r_root + (r_tip - r_root) * 0.55), (0.68, r_root), (0.84, r_root)]
        outline = []
        for k in range(teeth):
            for frac, r in prof:
                t = 2 * math.pi * (k + frac) / teeth
                outline.append((r, t))
        n = len(outline)
        for i in range(n):
            (ra, ta), (rb, tb) = outline[i], outline[(i + 1) % n]
            if tb < ta:
                tb += 2 * math.pi
            pa = (ra * math.cos(ta), ra * math.sin(ta))
            pb = (rb * math.cos(tb), rb * math.sin(tb))
            ia = (rim_in * math.cos(ta), rim_in * math.sin(ta))
            ib = (rim_in * math.cos(tb), rim_in * math.sin(tb))
            self.face([(*ia, z1), (*pa, z1), (*pb, z1), (*ib, z1)], (0, 0, 1), slot)
            self.face([(*ia, z0), (*pa, z0), (*pb, z0), (*ib, z0)], (0, 0, -1), slot)
            ex, ey = pb[0] - pa[0], pb[1] - pa[1]
            self.face([(*pa, z0), (*pb, z0), (*pb, z1), (*pa, z1)], (ey, -ex, 0), slot)
            self.face([(*ia, z0), (*ib, z0), (*ib, z1), (*ia, z1)], (-(ia[0] + ib[0]), -(ia[1] + ib[1]), 0), slot, smooth=True)
        seg = 48 if high else 20
        self.annulus(0, 0, SHAFT_R, hub, z0 - 0.02, z1 + 0.02, seg, slot, sides="tbo")
        spokes = 6 if r_tip > 0.5 else 4
        w = 0.05 if r_tip > 0.5 else 0.04
        for s in range(spokes):
            a = 2 * math.pi * (s + 0.5) / spokes
            saved = self.xf
            self.xf = saved @ Matrix.Rotation(a, 4, "Z")
            self.box(hub - 0.01, rim_in + 0.01, -w / 2, w / 2, z0 + 0.012, z1 - 0.012, slot, drop="xX")
            self.xf = saved

    def finish(self, smooth_angle: float = 0.0) -> bpy.types.Object:
        bm = self.bm
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
        bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method="FIXED", ngon_method="BEAUTY")
        mesh = bpy.data.meshes.new(self.name)
        bm.to_mesh(mesh)
        bm.free()
        obj = bpy.data.objects.new(self.name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        for slot in SLOTS:
            mesh.materials.append(material(slot))
        return obj


# ---------------------------------------------------------------------------------------------
# Room parts. Every part is drawn by both the high and low builds; `high` adds segments, bevels
# and individual books.
# ---------------------------------------------------------------------------------------------


def wall_frame(wall: str) -> Matrix:
    """Maps wall-local (a along the wall, d into the room, z) to Blender coordinates.
    The along axis runs left to right for a viewer inside the room facing the wall."""
    H = HALF
    if wall == "N":  # y = +H, inward -y, viewer faces +y: right = +x
        return Matrix(((1, 0, 0, 0), (0, -1, 0, H), (0, 0, 1, 0), (0, 0, 0, 1)))
    if wall == "S":  # y = -H, inward +y, viewer faces -y: right = -x
        return Matrix(((-1, 0, 0, 0), (0, 1, 0, -H), (0, 0, 1, 0), (0, 0, 0, 1)))
    if wall == "E":  # x = +H, inward -x, viewer faces +x: right = -y
        return Matrix(((0, -1, 0, H), (-1, 0, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1)))
    if wall == "W":  # x = -H, inward +x, viewer faces -x: right = +y
        return Matrix(((0, 1, 0, -H), (1, 0, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1)))
    raise ValueError(wall)


def wall_openings(wall: str) -> list[tuple[float, float, float, float]]:
    """Openings in wall-local (a0, a1, z0, z1)."""
    out = []
    for door in DOORS.values():
        if door["wall"] == wall:
            # wall-local a of a Blender coordinate: S runs -x, E runs -y.
            a = -door["c"] if wall in ("S", "E") else door["c"]
            out.append((a - DOOR_W / 2, a + DOOR_W / 2, 0.0, DOOR_H))
    if wall == "N":
        out.append((WIN["x0"], WIN["x1"], WIN["sill"], WIN["apex"]))
    return out


def wall_rects(openings: list) -> list[tuple[float, float, float, float]]:
    """Rectangles covering the wall [-H, H] x [0, HEIGHT] minus the openings."""
    H = HALF
    cuts = sorted({-H, H, *[o[0] for o in openings], *[o[1] for o in openings]})
    rects = []
    for a0, a1 in zip(cuts, cuts[1:]):
        mid = (a0 + a1) / 2
        hole = next((o for o in openings if o[0] <= mid <= o[1]), None)
        if hole is None:
            rects.append((a0, a1, 0.0, HEIGHT))
        else:
            if hole[2] > 0:
                rects.append((a0, a1, 0.0, hole[2]))
            rects.append((a0, a1, hole[3], HEIGHT))
    return rects


def arch_points(seg: int) -> tuple[list, list]:
    """Equilateral pointed arch: left and right arcs from the springing line to the apex."""
    x0, x1, zs = WIN["x0"], WIN["x1"], WIN["spring"]
    w = x1 - x0
    t_end = math.acos(0.5)  # angle at which the arc reaches the centre line
    left = [(x1 - w * math.cos(t * t_end / seg), zs + w * math.sin(t * t_end / seg)) for t in range(seg + 1)]
    right = [(x0 + w * math.cos(t * t_end / seg), zs + w * math.sin(t * t_end / seg)) for t in range(seg + 1)]
    return left, right


def build_shell(b: Builder, high: bool) -> None:
    H, T = HALF, HEIGHT
    b.face([(-H, -H, 0), (H, -H, 0), (H, H, 0), (-H, H, 0)], (0, 0, 1), "stone-floor")
    b.face([(-H, -H, T), (H, -H, T), (H, H, T), (-H, H, T)], (0, 0, -1), "walnut")
    for wall in "NSEW":
        b.xf = wall_frame(wall)
        openings = wall_openings(wall)
        for a0, a1, z0, z1 in wall_rects(openings):
            # Wainscot below WAINSCOT, wallpaper above.
            if z0 < WAINSCOT < z1:
                b.face([(a0, 0, z0), (a1, 0, z0), (a1, 0, WAINSCOT), (a0, 0, WAINSCOT)], (0, 1, 0), "walnut")
                b.face([(a0, 0, WAINSCOT), (a1, 0, WAINSCOT), (a1, 0, z1), (a0, 0, z1)], (0, 1, 0), "wallpaper")
            else:
                slot = "walnut" if z1 <= WAINSCOT else "wallpaper"
                b.face([(a0, 0, z0), (a1, 0, z0), (a1, 0, z1), (a0, 0, z1)], (0, 1, 0), slot)
        # Chair rail and cornice, broken at doors.
        spans = [(-H, H)]
        gaps = [(o[0], o[1]) for o in openings if o[2] < WAINSCOT + 0.1]
        gaps += [(c0, c1) for w, c0, c1 in BOOKCASES if w == wall]
        for g0, g1 in gaps:
            spans = [s for sp in spans for s in ((sp[0], min(sp[1], g0)), (max(sp[0], g1), sp[1])) if s[1] - s[0] > 1e-6]
        for a0, a1 in spans:
            b.box(a0, a1, 0, 0.04, WAINSCOT - 0.03, WAINSCOT + 0.05, "walnut", drop="xXy")
        b.box(-H, H, 0, 0.14, T - 0.18, T, "walnut", drop="xXyt")
        # Door architraves are panels (build_door_panels): the shell leaves each opening bare.
        b.xf = Matrix.Identity(4)
    build_window(b, high)
    # Ceiling beams, east-west, ends buried in the walls.
    for y in (-2.0, 2.0):
        b.box(-H, H, y - 0.13, y + 0.13, T - 0.3, T, "walnut", drop="txX")


def lancet_mullion(b: Builder, left: list, sill: float, apex: float, slot: str) -> None:
    half_width = 0.02
    x, z = left[-2]
    shoulder = apex + (z - apex) * half_width / abs(x)
    b.box(-half_width, half_width, 0.012, 0.05, sill, shoulder, slot, drop="bt")
    for y, normal in ((0.012, (0, -1, 0)), (0.05, (0, 1, 0))):
        b.face([(-half_width, y, shoulder), (half_width, y, shoulder), (0, y, apex)], normal, slot)
    for sign in (-1, 1):
        b.face([(sign * half_width, 0.012, shoulder), (sign * half_width, 0.05, shoulder),
                (0, 0.05, apex), (0, 0.012, apex)], (sign, 0, 1), slot)


def build_window(b: Builder, high: bool) -> None:
    """Glass lancet in the north wall opening, spandrels filling the rectangle above the arch, a
    walnut surround, a deep sill and a brass mullion."""
    b.xf = wall_frame("N")
    seg = 24 if high else 10
    left, right = arch_points(seg)
    x0, x1, sill, zs, apex = WIN["x0"], WIN["x1"], WIN["sill"], WIN["spring"], WIN["apex"]
    glass = [(x0, sill), (x1, sill), (x1, zs), *right[1:-1], (0.0, apex), *reversed(left[1:-1]), (x0, zs)]
    b.face([(a, 0.01, z) for a, z in glass], (0, 1, 0), "stained-glass")
    b.face([(x0, 0, zs), *[(a, 0, z) for a, z in left[1:-1]], (0.0, 0, apex), (x0, 0, apex)], (0, 1, 0), "wallpaper")
    b.face([(x1, 0, zs), (x1, 0, apex), (0.0, 0, apex), *[(a, 0, z) for a, z in reversed(right[1:-1])]], (0, 1, 0), "wallpaper")
    f, d = 0.12, 0.08
    b.box(x0 - f, x0, 0, d, sill - 0.1, apex + f, "walnut", drop="y")
    b.box(x1, x1 + f, 0, d, sill - 0.1, apex + f, "walnut", drop="y")
    b.box(x0, x1, 0, d, apex, apex + f, "walnut", drop="yxX")
    b.box(x0 - f - 0.05, x1 + f + 0.05, 0, 0.26, sill - 0.1, sill, "walnut", drop="y")
    lancet_mullion(b, left, sill, apex, "brass-polished")
    b.xf = Matrix.Identity(4)


def build_bookcases(b: Builder, books: Builder | None, high: bool, rng: random.Random) -> list:
    """Walnut bookcases against the walls. Low: one two-face slab per shelf carries the baked
    books. High: individual books. Returns runtime collider boxes."""
    colliders = []
    d = SHELF_DEPTH
    levels = [0.10, 0.52, 0.94, 1.36, 1.78, 2.20]
    top = 2.62
    for wall, a0, a1 in BOOKCASES:
        b.xf = wall_frame(wall)
        if books is not None:
            books.xf = b.xf
        side = 0.04
        b.box(a0, a0 + side, 0, d, 0, top, "walnut", drop="yb")
        b.box(a1 - side, a1, 0, d, 0, top, "walnut", drop="yb")
        b.box(a0 - 0.03, a1 + 0.03, 0, d + 0.04, top, top + 0.1, "walnut", drop="y")
        b.box(a0 - 0.06, a1 + 0.06, 0, d + 0.07, top + 0.1, top + 0.16, "walnut", drop="y")
        b.box(a0 + side, a1 - side, 0, d - 0.02, 0, levels[0], "walnut", drop="ybxX")
        b.face([(a0 + side, 0.005, levels[0]), (a1 - side, 0.005, levels[0]), (a1 - side, 0.005, top), (a0 + side, 0.005, top)], (0, 1, 0), "walnut")
        for k, z in enumerate(levels[1:]):
            b.box(a0 + side, a1 - side, 0.005, d - 0.01, z - 0.03, z, "walnut", drop="yxX")
        for k, z in enumerate(levels):
            z_top = (levels[k + 1] - 0.03) if k + 1 < len(levels) else top
            span = (a0 + side + 0.01, a1 - side - 0.01)
            if high:
                place_books(b, span, z, z_top, d, rng)
            elif books is not None:
                h = min(0.28, z_top - z - 0.06)
                front = d - 0.035
                books.face([(span[0], front, z), (span[1], front, z), (span[1], front, z + h), (span[0], front, z + h)], (0, 1, 0), "books")
                books.face([(span[0], 0.01, z + h), (span[1], 0.01, z + h), (span[1], front, z + h), (span[0], front, z + h)], (0, 0, 1), "books")
        lo = b.xf @ Vector((a0 - 0.06, 0, 0))
        hi = b.xf @ Vector((a1 + 0.06, d + 0.07, 0))
        colliders.append(runtime_box(lo, hi, top + 0.16))
        b.xf = Matrix.Identity(4)
        if books is not None:
            books.xf = Matrix.Identity(4)
    return colliders


def place_books(b: Builder, span: tuple, z: float, z_top: float, d: float, rng: random.Random) -> None:
    a = span[0]
    while a < span[1] - 0.03:
        if rng.random() < 0.06:  # a gap
            a += rng.uniform(0.04, 0.12)
            continue
        w = rng.uniform(0.022, 0.055)
        if a + w > span[1]:
            break
        h = min(rng.uniform(0.17, 0.28), z_top - z - 0.06)
        depth = rng.uniform(0.17, d - 0.06)
        recess = rng.uniform(0.0, 0.025)
        front = d - 0.035 - recess
        color = rng.randrange(len(BOOK_COLORS))
        b.box(a, a + w - 0.003, front - depth, front, z, z + h, f"book{color}", drop="b")
        a += w


def build_desk(b: Builder, high: bool) -> list:
    D = DESK
    b.xf = Matrix.Translation((D["cx"], D["cy"], 0)) @ Matrix.Rotation(D["angle"], 4, "Z")
    w, d, top = D["w"] / 2, D["d"] / 2, D["top"]
    b.box(-w, w, -d, d, top - 0.05, top, "walnut")
    for x0, x1 in ((-w + 0.03, -w + 0.45), (w - 0.45, w - 0.03)):
        b.box(x0, x1, -d + 0.04, d - 0.04, 0, top - 0.05, "walnut", drop="bt")
        for k in range(3):  # drawer fronts with brass pulls
            zc = 0.14 + k * 0.22
            b.box(x0 + 0.02, x1 - 0.02, -d + 0.02, -d + 0.04, zc - 0.09, zc + 0.09, "walnut", drop="Y")
            b.box((x0 + x1) / 2 - 0.05, (x0 + x1) / 2 + 0.05, -d - 0.005, -d + 0.02, zc - 0.012, zc + 0.012, "brass-polished", drop="Y")
    b.box(-w, w, d - 0.16, d, top, top + 0.26, "walnut", drop="b")  # letter rack
    b.box(-w - 0.01, w + 0.01, d - 0.17, d + 0.01, top + 0.26, top + 0.29, "brass-aged", drop="b")
    seg = 24 if high else 10
    candle_base = top + CANDLE_BASE_OFFSET
    for cx, cy in CANDLES:
        b.cylinder(cx, cy, 0.05, candle_base, candle_base + 0.015, seg, "brass-polished", caps="t")
        b.cylinder(cx, cy, 0.012, candle_base + 0.015, candle_base + 0.12, seg // 2, "brass-polished", caps="")
        b.cylinder(cx, cy, 0.035, candle_base + 0.12, candle_base + 0.135, seg, "brass-polished", caps="tb")
        b.cylinder(cx, cy, 0.018, candle_base + 0.135, candle_base + 0.26, seg // 2, "wax", caps="t")
        flame(b, cx, cy, candle_base + 0.27)
    b.xf = Matrix.Identity(4)
    corners = [Matrix.Translation((D["cx"], D["cy"], 0)) @ Matrix.Rotation(D["angle"], 4, "Z") @ Vector((sx * w, sy * d, 0)) for sx in (-1, 1) for sy in (-1, 1)]
    lo = Vector((min(c.x for c in corners), min(c.y for c in corners), 0))
    hi = Vector((max(c.x for c in corners), max(c.y for c in corners), 0))
    return [runtime_box(lo, hi, top + 0.29)]


def flame(b: Builder, cx: float, cy: float, z: float) -> None:
    h, r = 0.05, 0.012
    for ang in (0.0, math.pi / 2):
        c, s = math.cos(ang), math.sin(ang)
        pts = [(cx - r * c, cy - r * s, z), (cx + r * c, cy + r * s, z), (cx, cy, z + h)]
        b.face(pts, (-s, c, 0), "flame")


def build_sconces(b: Builder, high: bool) -> list:
    """Wall sconces: brass-aged backplate, polished arm and cup, candle. Returns the flame points."""
    flames = []
    seg = 20 if high else 10
    for wall, a in SCONCES:
        b.xf = wall_frame(wall)
        b.box(a - 0.07, a + 0.07, 0, 0.025, 1.85, 2.15, "brass-aged", drop="y")
        b.box(a - 0.012, a + 0.012, 0.025, 0.16, 1.93, 1.96, "brass-polished", drop="y")
        b.cylinder(a, 0.17, 0.045, 1.96, 1.99, seg, "brass-polished", caps="tb")
        b.cylinder(a, 0.17, 0.016, 1.99, 2.12, seg // 2, "wax", caps="t")
        flame(b, a, 0.17, 2.13)
        flames.append(b.xf @ Vector((a, 0.17, 2.16)))
        b.xf = Matrix.Identity(4)
    return flames


def build_shaft(b: Builder, high: bool) -> None:
    seg = 48 if high else 20
    b.cylinder(0, 0, SHAFT_R, 0.0, HEIGHT, seg, "brass-polished", caps="")
    for z in (0.32, 1.6, 2.1, 3.85):
        b.annulus(0, 0, SHAFT_R, SHAFT_R + 0.07, z - 0.05, z + 0.05, seg, "brass-aged", sides="tbo")
    b.annulus(0, 0, SHAFT_R, 0.38, 3.88, HEIGHT, seg, "brass-aged", sides="bo")  # ceiling boss
    for z, r, teeth, thick in GEARS:
        b.gear(z, r, teeth, thick, "brass-polished" if r < 0.6 else "brass-aged", high)
    # Floor ring the bottom gear turns in: a flat brass ring with radial slats.
    b.annulus(0, 0, 0.95, 1.05, 0.0, 0.03, seg * 2, "brass-aged", sides="tio")
    b.annulus(0, 0, 0.60, 0.66, 0.0, 0.03, seg * 2, "brass-aged", sides="tio")
    for k in range(16):
        a = 2 * math.pi * k / 16
        b.xf = Matrix.Rotation(a, 4, "Z")
        b.box(0.66, 0.95, -0.02, 0.02, 0.0, 0.022, "brass-aged", drop="bxX")
        b.xf = Matrix.Identity(4)


def build_door_backing() -> bpy.types.Object:
    """Bake-only dark boxes behind the doorways so the threshold does not bake open sky."""
    b = Builder(f"{PIECE}_bake_backing")
    for door in DOORS.values():
        b.xf = wall_frame(door["wall"])
        a = -door["c"] if door["wall"] in ("S", "E") else door["c"]
        x0, x1 = a - DOOR_W / 2 - 0.2, a + DOOR_W / 2 + 0.2
        b.face([(x0, -1.2, 0), (x1, -1.2, 0), (x1, -1.2, DOOR_H + 0.3), (x0, -1.2, DOOR_H + 0.3)], (0, 1, 0), "walnut")
        b.face([(x0, -1.2, 0), (x1, -1.2, 0), (x1, 0, 0), (x0, 0, 0)], (0, 0, 1), "stone-floor")
        b.face([(x0, -1.2, DOOR_H + 0.3), (x1, -1.2, DOOR_H + 0.3), (x1, 0, DOOR_H + 0.3), (x0, 0, DOOR_H + 0.3)], (0, 0, -1), "walnut")
        b.face([(x0, -1.2, 0), (x0, 0, 0), (x0, 0, DOOR_H + 0.3), (x0, -1.2, DOOR_H + 0.3)], (1, 0, 0), "walnut")
        b.face([(x1, -1.2, 0), (x1, 0, 0), (x1, 0, DOOR_H + 0.3), (x1, -1.2, DOOR_H + 0.3)], (-1, 0, 0), "walnut")
        b.xf = Matrix.Identity(4)
    obj = b.finish()
    obj.data.materials.clear()
    obj.data.materials.append(void_material())
    return obj


def runtime_box(lo: Vector, hi: Vector, top: float) -> dict:
    """Blender XY box from 0 to `top` as a runtime Box ({min, max} with z = -y)."""
    xs = sorted((lo.x, hi.x))
    zs = sorted((-lo.y, -hi.y))
    return {"min": [r3(xs[0]), 0, r3(zs[0])], "max": [r3(xs[1]), r3(top), r3(zs[1])]}


def r3(v: float) -> float:
    return round(v + 0.0, 3) + 0.0


# ---------------------------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------------------------

_MATS: dict[str, bpy.types.Material] = {}


def bsdf_of(mat: bpy.types.Material):
    return next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")


def load_image(path: Path, colorspace: str) -> bpy.types.Image:
    img = bpy.data.images.load(str(path), check_existing=True)
    img.colorspace_settings.name = colorspace
    return img


def material(slot: str) -> bpy.types.Material:
    if slot in _MATS:
        return _MATS[slot]
    mat = bpy.data.materials.new(f"{PIECE}_{slot}")
    nt = mat.node_tree
    bsdf = bsdf_of(mat)
    if slot in [f"book{i}" for i in range(len(BOOK_COLORS))]:
        idx = int(slot[4:])
        bsdf.inputs["Base Color"].default_value = (*BOOK_COLORS[idx], 1.0)
        bsdf.inputs["Roughness"].default_value = 0.7
    elif slot in TILE:
        uv = nt.nodes.new("ShaderNodeUVMap")
        uv.uv_map = "UVMap"
        # UV0 v is authored negated (see uv0_tiled), so flip it back for Blender's image origin.
        mapping = nt.nodes.new("ShaderNodeMapping")
        mapping.inputs["Scale"].default_value = (1.0, -1.0, 1.0)
        nt.links.new(uv.outputs["UV"], mapping.inputs["Vector"])
        base = nt.nodes.new("ShaderNodeTexImage")
        base.image = load_image(MATERIAL_DIR / slot / f"{slot}.basecolor.png", "sRGB")
        orm = nt.nodes.new("ShaderNodeTexImage")
        orm.image = load_image(MATERIAL_DIR / slot / f"{slot}.orm.png", "Non-Color")
        for tex in (base, orm):
            nt.links.new(mapping.outputs["Vector"], tex.inputs["Vector"])
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(orm.outputs["Color"], sep.inputs["Color"])
        nt.links.new(base.outputs["Color"], bsdf.inputs["Base Color"])
        nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
        if slot == "stained-glass":
            em = nt.nodes.new("ShaderNodeTexImage")
            em.image = load_image(MATERIAL_DIR / slot / f"{slot}.emissive.png", "sRGB")
            nt.links.new(mapping.outputs["Vector"], em.inputs["Vector"])
            nt.links.new(em.outputs["Color"], bsdf.inputs["Emission Color"])
            bsdf.inputs["Emission Strength"].default_value = 0.0
            # Light through the glass is tinted by the glass colour: a mostly transparent mix.
            transp = nt.nodes.new("ShaderNodeBsdfTransparent")
            nt.links.new(base.outputs["Color"], transp.inputs["Color"])
            mix = nt.nodes.new("ShaderNodeMixShader")
            mix.inputs["Fac"].default_value = 0.85
            out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
            nt.links.new(bsdf.outputs["BSDF"], mix.inputs[1])
            nt.links.new(transp.outputs["BSDF"], mix.inputs[2])
            nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    else:
        color, rough, metal, emit = CONST[slot]
        bsdf.inputs["Base Color"].default_value = (*color, 1.0)
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Metallic"].default_value = metal
        if emit > 0:
            bsdf.inputs["Emission Color"].default_value = (*color, 1.0)
            bsdf.inputs["Emission Strength"].default_value = emit
    # glTF doubleSided follows backface culling; only the crossed flame cards are two-sided.
    mat.use_backface_culling = slot != "flame"
    _MATS[slot] = mat
    return mat


def set_metal_links(enabled: bool) -> None:
    """Tiled slots read metallic from ORM blue. lightmap_helpers zeroes Metallic's default value
    for the irradiance bake, which a linked socket ignores, so unlink it around the bake."""
    for slot in TILE:
        mat = _MATS.get(slot)
        if mat is None:
            continue
        nt = mat.node_tree
        bsdf = bsdf_of(mat)
        sep = next(n for n in nt.nodes if n.type == "SEPARATE_COLOR")
        for link in [lk for lk in nt.links if lk.to_socket == bsdf.inputs["Metallic"]]:
            nt.links.remove(link)
        bsdf.inputs["Metallic"].default_value = 0.0
        if enabled:
            nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])


def void_material() -> bpy.types.Material:
    mat = bpy.data.materials.new(f"{PIECE}_bake_void")
    b = bsdf_of(mat)
    b.inputs["Base Color"].default_value = (0.02, 0.016, 0.012, 1.0)
    b.inputs["Roughness"].default_value = 1.0
    return mat


def bind_books_atlas(base_png: Path) -> None:
    """Points the low `books` slot at the baked atlas (UV0) for the lightmap bake and renders."""
    mat = material("books")
    nt = mat.node_tree
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = load_image(base_png, "sRGB")
    nt.links.new(tex.outputs["Color"], bsdf_of(mat).inputs["Base Color"])


# ---------------------------------------------------------------------------------------------
# UVs
# ---------------------------------------------------------------------------------------------


def uv0_tiled(obj: bpy.types.Object) -> None:
    """UV0 for tiled slots in tile units (world metres / tileMeters), so the shared P4-T3 materials
    bind at repeat 1. v is negated: the glTF exporter writes 1 - v, giving v_gltf = 1 + up/tile,
    which matches the flipY = true upload of the approved PNG and KTX2 maps (src/world/materials.ts).
    Each face is projected on its dominant axis, oriented as seen from the front."""
    mesh = obj.data
    uv = mesh.uv_layers.new(name="UVMap") if "UVMap" not in mesh.uv_layers else mesh.uv_layers["UVMap"]
    for poly in mesh.polygons:
        slot = SLOTS[poly.material_index]
        if slot not in TILE:
            continue
        n = poly.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        tile = TILE[slot]
        for li in poly.loop_indices:
            p = mesh.vertices[mesh.loops[li].vertex_index].co
            if ax == 2:
                u, v = (p.x, p.y) if n.z > 0 else (p.x, -p.y)
            elif ax == 0:
                u, v = (p.y if n.x > 0 else -p.y), p.z
            else:
                u, v = (-p.x if n.y > 0 else p.x), p.z
            uv.data[li].uv = (u / tile, -v / tile)


def uv0_atlas(obj: bpy.types.Object, size: int) -> None:
    mesh = obj.data
    if "UVMap" not in mesh.uv_layers:
        mesh.uv_layers.new(name="UVMap")
    mesh.uv_layers.active = mesh.uv_layers["UVMap"]
    lm._edit_all(obj)
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.0, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(rotate=False, margin_method="FRACTION", margin=8 / size)
    bpy.ops.object.mode_set(mode="OBJECT")


def density_by_slot(obj: bpy.types.Object, size: int) -> dict:
    mesh = obj.data
    uv = mesh.uv_layers[lm.LIGHTMAP_UV].data
    acc: dict[str, list] = {}
    for poly in mesh.polygons:
        if poly.area <= 1e-9:
            continue
        pts = [uv[i].uv for i in poly.loop_indices]
        a = 0.0
        for i in range(1, len(pts) - 1):
            p0, p1, p2 = pts[0], pts[i], pts[i + 1]
            a += abs((p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y)) / 2
        acc.setdefault(SLOTS[poly.material_index], []).append((math.sqrt(a * size * size / poly.area), poly.area))
    out = {}
    for slot, vals in sorted(acc.items()):
        d = np.array([v[0] for v in vals])
        w = np.array([v[1] for v in vals])
        order = np.argsort(d)
        cum = np.cumsum(w[order]) / w.sum()
        out[slot] = {
            "area_m2": round(float(w.sum()), 2),
            "median_px_per_m": round(float(d[order][np.searchsorted(cum, 0.5)]), 1),
            "min_px_per_m": round(float(d.min()), 1),
        }
    return out


# ---------------------------------------------------------------------------------------------
# Lights, cameras, renders
# ---------------------------------------------------------------------------------------------


def build_lights(sconce_flames: list) -> None:
    scene = bpy.context.scene
    world = bpy.data.worlds.new(f"{PIECE}_world")
    scene.world = world
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (0.05, 0.035, 0.022, 1.0)
    bg.inputs["Strength"].default_value = 0.5

    def point(name: str, loc, energy: float, color=(1.0, 0.58, 0.26), radius: float = 0.02) -> None:
        data = bpy.data.lights.new(f"{PIECE}_{name}", "POINT")
        data.energy = energy
        data.shadow_soft_size = radius
        data.color = color
        obj = bpy.data.objects.new(f"{PIECE}_{name}", data)
        obj.location = loc
        scene.collection.objects.link(obj)

    D = DESK
    xf = Matrix.Translation((D["cx"], D["cy"], 0)) @ Matrix.Rotation(D["angle"], 4, "Z")
    for i, (cx, cy) in enumerate(CANDLES):
        point(f"candle_{i}", xf @ Vector((cx, cy, D["top"] + CANDLE_BASE_OFFSET + 0.3)), 30.0)
    for i, loc in enumerate(sconce_flames):
        point(f"sconce_{i}", loc, 45.0)
    # Late sun through the lancet: from the north, high, warm. Glass tints what passes.
    sun_data = bpy.data.lights.new(f"{PIECE}_sun", "SUN")
    sun_data.energy = 7.0
    sun_data.angle = math.radians(1.0)
    sun_data.color = (1.0, 0.86, 0.66)
    sun = bpy.data.objects.new(f"{PIECE}_sun", sun_data)
    sun.rotation_euler = Vector((0.12, -0.75, -0.65)).normalized().to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(sun)
    # Sky light entering the window: a warm area light just outside the glass.
    area_data = bpy.data.lights.new(f"{PIECE}_window_sky", "AREA")
    area_data.shape = "RECTANGLE"
    area_data.size, area_data.size_y = 1.2, 2.2
    area_data.energy = 60.0
    area_data.color = (1.0, 0.8, 0.6)
    area = bpy.data.objects.new(f"{PIECE}_window_sky", area_data)
    area.location = (0.0, HALF + 0.4, (WIN["sill"] + WIN["apex"]) / 2)
    area.rotation_euler = (math.radians(-90), 0, 0)  # area lights emit along local -Z: here -Y, into the room
    scene.collection.objects.link(area)


def make_camera(name: str) -> bpy.types.Object:
    c = CAMERAS[name]
    data = bpy.data.cameras.new(f"{PIECE}_cam_{name}")
    data.sensor_fit = "VERTICAL"
    data.angle = math.radians(c["vfov"])
    data.clip_start = 0.05
    cam = bpy.data.objects.new(f"{PIECE}_cam_{name}", data)
    cam.location = c["loc"]
    cam.rotation_euler = (Vector(c["look"]) - Vector(c["loc"])).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.collection.objects.link(cam)
    return cam


def render_settings(engine: str, samples: int) -> None:
    scene = bpy.context.scene
    scene.render.engine = engine
    scene.render.resolution_x, scene.render.resolution_y = RENDER_W, RENDER_H
    scene.render.resolution_percentage = 100
    scene.render.use_stamp_date = False
    scene.render.use_stamp_render_time = False
    scene.render.use_compositing = False
    scene.compositing_node_group = None
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "None"
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_depth = "8"
    if engine == "CYCLES":
        scene.cycles.samples = samples
        scene.cycles.use_denoising = True
    else:
        scene.eevee.taa_render_samples = samples


def render_to(cam: bpy.types.Object, path: Path) -> None:
    scene = bpy.context.scene
    scene.camera = cam
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def set_visible(objs: list, visible: bool) -> None:
    for o in objs:
        o.hide_render = not visible
        o.hide_set(not visible)


def lightmapped_preview_materials(obj: bpy.types.Object, lightmap_png: Path, scale: float) -> list:
    """Swaps each slot for an emission shader albedo x lightmap x scale (the runtime's diffuse
    term, specular left out) and returns the originals for restoring."""
    lmimg = load_image(lightmap_png, "sRGB")
    originals = list(obj.data.materials)
    for i, mat in enumerate(originals):
        prev = bpy.data.materials.new(f"{mat.name}_lmpreview")
        nt = prev.node_tree
        for n in list(nt.nodes):
            nt.nodes.remove(n)
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        emit = nt.nodes.new("ShaderNodeEmission")
        uv1 = nt.nodes.new("ShaderNodeUVMap")
        uv1.uv_map = lm.LIGHTMAP_UV
        lmtex = nt.nodes.new("ShaderNodeTexImage")
        lmtex.image = lmimg
        nt.links.new(uv1.outputs["UV"], lmtex.inputs["Vector"])
        mul = nt.nodes.new("ShaderNodeMix")
        mul.data_type = "RGBA"
        mul.blend_type = "MULTIPLY"
        mul.inputs["Factor"].default_value = 1.0
        nt.links.new(lmtex.outputs["Color"], mul.inputs["B"])
        src = bsdf_of(mat)
        link = next((lk for lk in mat.node_tree.links if lk.to_socket == src.inputs["Base Color"]), None)
        if link is not None:
            # Copy the albedo subgraph's texture: rebuild uv -> mapping -> image.
            img_node = link.from_node
            tex = nt.nodes.new("ShaderNodeTexImage")
            tex.image = img_node.image
            uv0 = nt.nodes.new("ShaderNodeUVMap")
            uv0.uv_map = "UVMap"
            if SLOTS[i] in TILE:
                mp = nt.nodes.new("ShaderNodeMapping")
                mp.inputs["Scale"].default_value = (1.0, -1.0, 1.0)
                nt.links.new(uv0.outputs["UV"], mp.inputs["Vector"])
                nt.links.new(mp.outputs["Vector"], tex.inputs["Vector"])
            else:
                nt.links.new(uv0.outputs["UV"], tex.inputs["Vector"])
            nt.links.new(tex.outputs["Color"], mul.inputs["A"])
        else:
            mul.inputs["A"].default_value = src.inputs["Base Color"].default_value
        emit.inputs["Strength"].default_value = scale
        nt.links.new(mul.outputs["Result"], emit.inputs["Color"])
        if SLOTS[i] in ("flame", "stained-glass"):
            add = nt.nodes.new("ShaderNodeAddShader")
            glow = nt.nodes.new("ShaderNodeEmission")
            glow.inputs["Strength"].default_value = 1.0 if SLOTS[i] == "stained-glass" else 6.0
            if link is not None:
                nt.links.new(tex.outputs["Color"], glow.inputs["Color"])
            else:
                glow.inputs["Color"].default_value = src.inputs["Base Color"].default_value
            nt.links.new(emit.outputs["Emission"], add.inputs[0])
            nt.links.new(glow.outputs["Emission"], add.inputs[1])
            nt.links.new(add.outputs["Shader"], out.inputs["Surface"])
        else:
            nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
        obj.data.materials[i] = prev
    return originals


# ---------------------------------------------------------------------------------------------
# Books bake (high to low)
# ---------------------------------------------------------------------------------------------


def bake_books(high: bpy.types.Object, low: bpy.types.Object, size: int, report: dict) -> dict:
    """Selected-to-active bakes of the individual high books (and the bookcase behind them) onto
    the low per-shelf slabs: albedo, tangent normal and AO packed as ORM."""
    scene = bpy.context.scene
    images = {}
    stats = {}
    others = [o for o in bpy.context.view_layer.objects if o.type == "MESH" and o not in (high, low)]
    set_visible(others, False)
    for other in bpy.context.view_layer.objects:
        other.select_set(False)
    high.select_set(True)
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    mat = low.data.materials[0]  # the books object carries only the books slot
    nt = mat.node_tree
    ao_distance = 0.12
    scene.world.light_settings.distance = ao_distance
    cage, ray = 0.03, 0.08
    timings = {}
    for channel, btype, kwargs, samples in (
        ("albedo", "DIFFUSE", {"pass_filter": {"COLOR"}}, 16),
        ("normal", "NORMAL", {"normal_space": "TANGENT"}, 16),
        ("ao", "AO", {}, 128),
    ):
        img = bpy.data.images.new(f"{PIECE}_books_{channel}", size, size, alpha=True, float_buffer=True)
        img.colorspace_settings.name = "Non-Color"
        img.generated_color = (0.5, 0.5, 1.0, 0.0) if channel == "normal" else (0.0, 0.0, 0.0, 0.0)
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = img
        nt.nodes.active = tex
        scene.cycles.samples = samples
        scene.render.bake.margin = 8
        started = time.monotonic()
        bpy.ops.object.bake(type=btype, use_selected_to_active=True, cage_extrusion=cage, max_ray_distance=ray,
                            margin=8, margin_type="EXTEND", use_clear=True, target="IMAGE_TEXTURES", **kwargs)
        timings[channel] = round(time.monotonic() - started, 2)
        nt.nodes.remove(tex)
        images[channel] = lm.image_rgba(img)
    set_visible(others, True)
    covered = images["albedo"][..., 3] > 0.5
    albedo = np.clip(images["albedo"][..., :3], 0, 1)
    ao = np.clip(images["ao"][..., 0], 0, 1)
    normal = np.clip(images["normal"][..., :3], 0, 1)
    # Unbaked texels: flat normal, mid albedo, no occlusion, so mips never pull in garbage.
    normal[~covered] = (0.5, 0.5, 1.0)
    ao[~covered] = 1.0
    out = {}
    base8 = np.round(lm.srgb_encode(albedo) * 255).astype(np.uint8)
    nrm8 = np.round(normal * 255).astype(np.uint8)
    orm = np.stack([ao, np.full_like(ao, 0.72), np.zeros_like(ao)], axis=-1)
    orm8 = np.round(orm * 255).astype(np.uint8)
    for channel, arr in (("basecolor", base8), ("normal", nrm8), ("orm", orm8)):
        path = STAGING / f"{PIECE}.{channel}.png"
        lm.write_png_rgb(path, arr)
        out[channel] = path
    stats = {
        "size": size,
        "device": report.get("device"),
        "cage_extrusion_m": cage,
        "max_ray_distance_m": ray,
        "ao_distance_m": ao_distance,
        "margin_px": 8,
        "seconds": timings,
        "coverage": round(float(covered.mean()), 4),
        "ao_mean": round(float(ao[covered].mean()), 4),
        "ao_p05": round(float(np.percentile(ao[covered], 5)), 4),
        "albedo_mean_srgb8": [round(float(v), 1) for v in base8[covered].mean(axis=0)],
        "normal_mean": [round(float(v), 4) for v in normal[covered].mean(axis=0)],
    }
    return {"files": out, "stats": stats}


# ---------------------------------------------------------------------------------------------
# Export and encode
# ---------------------------------------------------------------------------------------------


def export_glb(obj: bpy.types.Object, path: Path) -> None:
    for other in bpy.context.view_layer.objects:
        other.select_set(other == obj)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        use_active_scene=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="NONE",
        export_cameras=False,
        export_lights=False,
        export_apply=True,
        export_extras=False,
    )


def ktx2(png: Path, out: Path, color: bool, normal: bool = False) -> str:
    """UASTC with Zstandard and generated mips, default top-left origin: these maps are sampled
    through glTF UVs with flipY = false, unlike the code-bound tiling set."""
    cmd = [str(KTX), "create", "--format", "R8G8B8_SRGB" if color else "R8G8B8_UNORM",
           "--assign-tf", "srgb" if color else "linear", "--encode", "uastc", "--uastc-quality", "2",
           "--zstd", "18", "--generate-mipmap"]
    if normal:
        cmd.append("--normalize")
    subprocess.run([*cmd, str(png), str(out)], check=True)
    return " ".join(cmd[1:])


def count_tris(obj: bpy.types.Object) -> int:
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


# ---------------------------------------------------------------------------------------------
# Reimport check (separate fresh process)
# ---------------------------------------------------------------------------------------------


def reimport() -> None:
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    glb = RUNTIME / GLB_NAME
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
    for p in sorted(RUNTIME.glob("*.ktx2")):
        b = p.read_bytes()
        maps[p.name] = {"width": int.from_bytes(b[20:24], "little"), "height": int.from_bytes(b[24:28], "little")}
    result = {
        "glb": GLB_NAME,
        "glb_sha256": sha256(glb),
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
            "textures_le_2048": all(m["width"] <= 2048 and m["height"] <= 2048 for m in maps.values()),
            "two_uv_layers_every_mesh": all(len(u) == 2 for u in uv_layers),
            "no_embedded_images": images == 0,
            "floor_at_zero": abs(lo[2]) < 1e-3,
            "footprint_8m": abs(lo[0] + HALF) < 0.06 and abs(hi[0] - HALF) < 0.06,
        },
    }
    facts, checks = panels.reimport_checks({o.name: o for o in bpy.data.objects}, panels.door_slots(DOORS, DOOR_W, DOOR_H))
    result["panels"] = facts
    result["checks"].update(checks)
    result["pass"] = all(result["checks"].values())
    (STAGING / "reimport.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    if not result["pass"]:
        raise SystemExit("reimport check failed")


# ---------------------------------------------------------------------------------------------
# Main build
# ---------------------------------------------------------------------------------------------


def manifest_entry(colliders: list, lightmap: dict | None, budget: dict) -> dict:
    """Runtime manifest: the lightmap manifest (src/world/lightmap.ts) and the RoomTemplate
    (src/content/rooms.ts) in one object; both parsers accept it. Footprint, doors and sockets
    are the greybox study's, unchanged."""

    def sock(sid, x, z, yaw=0, y=0):
        return {"id": sid, "position": [x, y, z], "yaw": yaw}

    def door(did, facing, x, z):
        return {"id": did, "facing": facing, "position": [x, 0, z], "width": DOOR_W}

    perimeter = perimeter_colliders()
    return {
        "template": PIECE,
        "glb": GLB_NAME,
        "lightmap": lightmap,
        "id": PIECE,
        "kinds": ["combat", "treasure", "rest"],
        "footprint": {"min": [-4, -4], "max": [4, 4]},
        "doors": [door("s", "S", -1, 4), door("e", "E", 4, -1)],
        "rotations": [0, 1, 2, 3],
        "enemySockets": [sock("enemy-a", -1, -2, 180), sock("enemy-b", 1.5, -2.2, 200)],
        "lootSockets": [sock("desk-drawer", 2.6, 2.6, 270)],
        "dressingSockets": [sock("desk", 2.4, 2.4, 225), sock("shelf-w", -3.6, 0, 90), sock("gear-shaft", 0, 0)],
        "lightSockets": [sock("candles", 2.4, 2.4, 0, 1.1), sock("window", 0, -3.8, 0, 2.5)],
        "probe": [0, 1.6, 1],
        "walkable": [{"min": [-3.6, -3.6], "max": [3.6, 3.6]}],
        "colliders": [*perimeter, {"min": [-0.6, 0, -0.6], "max": [0.6, 4, 0.6]}, *colliders],
        "budget": budget,
        "materials": {
            **{f"{PIECE}_{s}": {"pbr": s, "tileMeters": TILE[s]} for s in TILE},
            f"{PIECE}_books": {"maps": {"basecolor": f"{PIECE}.basecolor.ktx2", "normal": f"{PIECE}.normal.ktx2", "orm": f"{PIECE}.orm.ktx2"}, "uv": 0},
            f"{PIECE}_wax": {"color": srgb_hex(CONST["wax"][0]), "roughness": CONST["wax"][1]},
            f"{PIECE}_flame": {"color": srgb_hex(CONST["flame"][0]), "emissive": srgb_hex(CONST["flame"][0]), "emissiveIntensity": 3.0},
        },
        "glassEmissiveIntensity": 0.8,
    }


def srgb_hex(rgb: tuple) -> str:
    enc = lm.srgb_encode(np.array(rgb))
    return "#" + "".join(f"{int(round(c * 255)):02x}" for c in enc)


def perimeter_colliders() -> list:
    """Same boxes as perimeterColliders() in src/content/rooms.ts for this footprint and doors."""
    t = 0.1
    out = []
    edges = [("N", -4, [], "x"), ("S", 4, [(-1.8, -0.2)], "x"), ("W", -4, [], "z"), ("E", 4, [(-1.8, -0.2)], "z")]
    for _facing, fixed, gaps, axis in edges:
        start = -4.0
        for g0, g1 in [*gaps, (4.0, 4.0)]:
            if g0 > start + 1e-6:
                if axis == "x":
                    out.append({"min": [start, 0, fixed - t], "max": [g0, 4, fixed + t]})
                else:
                    out.append({"min": [fixed - t, 0, start], "max": [fixed + t, 4, g0]})
            start = max(start, g1)
    return [{"min": [r3(v) for v in b["min"]], "max": [r3(v) for v in b["max"]]} for b in out]


def build_all(high: bool, rng: random.Random) -> tuple[bpy.types.Object, bpy.types.Object | None, list, list]:
    tag = "high" if high else "low"
    room = Builder(f"{PIECE}_{tag}" if high else PIECE)
    books = None if high else Builder(f"{PIECE}_books_low")
    if high:
        for i in range(len(BOOK_COLORS)):
            SLOTS.append(f"book{i}") if f"book{i}" not in SLOTS else None
    build_shell(room, high)
    colliders = build_bookcases(room, books, high, rng)
    colliders += build_desk(room, high)
    flames = build_sconces(room, high)
    build_shaft(room, high)
    room_obj = room.finish()
    books_obj = None
    if books:
        books_obj = books.finish()
        for poly in books_obj.data.polygons:
            poly.material_index = 0
        books_obj.data.materials.clear()
        books_obj.data.materials.append(material("books"))
    return room_obj, books_obj, colliders, flames, build_door_panels(high)


# The study's wall dressing a door plug continues: a 1 m wainscot under a chair rail, no skirting, no
# stiles, and no threshold plate in the frame.
STUDY_WALL = panels.WallSpec(wainscot=WAINSCOT, chair_rail=True, skirting=False, stile_step=None, threshold=False)


def build_door_panels(high: bool) -> dict:
    """The door panel slot of each study door (room_panels): `door-frame-<id>` and `door-plug-<id>`."""
    return panels.build_panels(Builder, wall_frame, panels.door_slots(DOORS, DOOR_W, DOOR_H), STUDY_WALL, high)


def apply_bevel(obj: bpy.types.Object) -> None:
    mod = obj.modifiers.new("bevel", "BEVEL")
    mod.width = 0.006
    mod.segments = 2
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(40)
    mod.harden_normals = True
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier="bevel")
    for p in obj.data.polygons:
        p.use_smooth = True


def main() -> None:
    args = parse_args()
    if args.reimport:
        reimport()
        return
    for d in (STAGING, BLEND_DIR, SCRATCH, RUNTIME):
        d.mkdir(parents=True, exist_ok=True)
    bpy.context.preferences.filepaths.save_version = 0  # no .blend1 backups beside the sources
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    scene = bpy.context.scene
    report: dict = {
        "piece": PIECE,
        "blender": bpy.app.version_string,
        "host_load_start": load_avg(),
        "lightmap_size": args.size,
        "atlas_size": args.atlas,
        "samples": args.samples,
    }

    # High: individual books, more segments, bevelled edges. Built first so its RNG stream is fixed.
    high, _, _, _, high_door = build_all(True, random.Random(4242))
    high_panels = [*high_door["door-frame"], *high_door["door-plug"]]
    high_slots = list(SLOTS)
    for obj in (high, *high_panels):
        uv0_tiled(obj)
    del SLOTS[len(SLOTS) - len(BOOK_COLORS):]
    for obj in (high, *high_panels):
        apply_bevel(obj)
    report["high"] = {"triangles": sum(count_tris(o) for o in (high, *high_panels)), "slots": len(high_slots)}

    low, books_low, colliders, flames, door = build_all(False, random.Random(4242))
    frames, plugs = door["door-frame"], door["door-plug"]
    door_backing = build_door_backing()
    build_lights(flames)
    cams = {name: make_camera(name) for name in CAMERAS}
    for obj in (low, *frames, *plugs):
        uv0_tiled(obj)
    uv0_atlas(books_low, args.atlas)
    bpy.context.view_layer.update()

    if not args.glb_out:
        set_visible([low, books_low, *frames, *plugs], False)
        bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_DIR / f"{PIECE}_high.blend"), copy=True, compress=True)
        set_visible([low, books_low, *frames, *plugs], True)

    if not args.skip_bake:
        report["device"] = lm.select_device(args.device)
        load0 = load_avg()
        books = bake_books(high, books_low, args.atlas, report)
        books["stats"]["host_load"] = [load0, load_avg()]
        report["books_bake"] = books["stats"]

    # Join the books slabs into the room: one object, one shared UV1 atlas.
    for other in bpy.context.view_layer.objects:
        other.select_set(other in (low, books_low))
    bpy.context.view_layer.objects.active = low
    bpy.ops.object.join()

    # One atlas for the room and its door panels (PRD lightmap contract: 10 px island pad).
    low_all = [low, *frames, *plugs]
    panels.unwrap_lightmap_uv_multi(low_all, args.size, gap_px=10)
    report["low"] = {
        "triangles": sum(count_tris(o) for o in low_all),
        "vertices": len(low.data.vertices),
        "materials": len({p.material_index for p in low.data.polygons}),
        "lightmap_density": lm.lightmap_texel_density(low, args.size),
        "lightmap_density_by_slot": density_by_slot(low, args.size),
        "panels": {o.name: {"triangles": count_tris(o), "lightmap_density": lm.lightmap_texel_density(o, args.size)} for o in (*frames, *plugs)},
    }
    print(f"[{PIECE}] high tris={report['high']['triangles']} low tris={report['low']['triangles']}")
    print(json.dumps(report["low"]["lightmap_density_by_slot"], indent=1))

    # Export before any bake output is bound, so the GLB is the same with or without bakes.
    glb = Path(args.glb_out) if args.glb_out else STAGING / GLB_NAME
    panels.export_glb_multi(low_all, glb)
    report["glb_bytes"] = glb.stat().st_size
    if args.glb_out:
        print(f"[{PIECE}] determinism GLB {glb} {sha256(glb)}")
        return

    set_visible([high, *high_panels], False)
    lightmap = None
    if not args.skip_bake:
        bind_books_atlas(STAGING / f"{PIECE}.basecolor.png")
        set_metal_links(False)
        load0 = load_avg()
        raw, passes = panels.bake_with_panels([low], frames, plugs, args.size, args.samples, no_shadow=[])
        set_metal_links(True)
        report["lightmap_bake"] = {"seconds": round(sum(passes), 2), "pass_seconds": passes, "host_load": [load0, load_avg()],
                                   "timing_valid": max(load0, load_avg()) <= 15,
                                   "panels": "pass 1: room and door frames, every door frame and plug invisible to shadow, diffuse, glossy, "
                                             "transmission and volume rays; pass 2: door plugs only into the same image, plugs fully visible, "
                                             "frames hidden from render (room_panels.bake_with_panels)"}
        lm.save_exr(raw, SCRATCH / f"{PIECE}.lightmap.raw.exr")
        image = lm.denoise_image(raw, SCRATCH)
        report["denoise"] = "compositor OIDN, HDR, accurate prefilter, high quality"
        # 99.6th percentile: the top 0.4% are texels beside sconce and candle flames. At the helper's
        # default 99.9 they set a scale of 24 and the median texel encoded at 13/255.
        encoded, scale, stats = lm.encode_scaled_srgb(lm.image_rgba(image), percentile=LIGHTMAP_PERCENTILE)
        stats["percentile"] = LIGHTMAP_PERCENTILE
        png = STAGING / f"{PIECE}.lightmap.png"
        lm.write_png_rgb(png, encoded)
        report["lightmap"] = stats
        lightmap = {
            "file": f"{PIECE}.lightmap.ktx2",
            "uv": 1,
            "encoding": "srgb-scaled",
            "scale": scale,
            "intensity": round(math.pi * scale, 6),
        }

    budget = {"tris": report["low"]["triangles"], "materials": len(SLOTS), "texturePx": max(args.size, args.atlas)}
    if lightmap is not None:
        manifest = manifest_entry(colliders, lightmap, budget)
        (STAGING / f"{PIECE}.manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        # The repo's lint gate formats JSON with Biome; write the manifest in its canonical form.
        mpath = STAGING / f"{PIECE}.manifest.json"
        formatted = subprocess.run([str(ROOT / "node_modules/.bin/biome"), "format", f"--stdin-file-path=public/assets/rooms/{PIECE}/{mpath.name}"],
                                   input=mpath.read_text(), capture_output=True, text=True, check=True, cwd=ROOT).stdout
        mpath.write_text(formatted)
        encodes = {}
        encodes[f"{PIECE}.lightmap.ktx2"] = ktx2(STAGING / f"{PIECE}.lightmap.png", STAGING / f"{PIECE}.lightmap.ktx2", color=True)
        for channel in ("basecolor", "normal", "orm"):
            encodes[f"{PIECE}.{channel}.ktx2"] = ktx2(STAGING / f"{PIECE}.{channel}.png", STAGING / f"{PIECE}.{channel}.ktx2",
                                                       color=channel == "basecolor", normal=channel == "normal")
        report["ktx2"] = {"tool": subprocess.run([str(KTX), "--version"], capture_output=True, text=True, check=True).stdout.strip(), "encodes": encodes}
        # Promote: the runtime set is the GLB, the four KTX2 maps and the manifest.
        for name in [GLB_NAME, f"{PIECE}.manifest.json", *encodes]:
            shutil.copyfile(STAGING / name, RUNTIME / name)

    if not args.no_renders:
        renders = STAGING / "renders"
        renders.mkdir(exist_ok=True)
        render_settings("BLENDER_EEVEE", 64)
        set_visible([door_backing], True)
        for name, cam in cams.items():
            set_visible([low, *frames, *plugs], False)
            set_visible([high, *high_door["door-frame"]], True)
            render_to(cam, renders / f"{name}.high.png")
            set_visible([high, *high_panels], False)
            set_visible([low, *frames], True)
            render_to(cam, renders / f"{name}.low.png")
        if lightmap is not None:
            originals = lightmapped_preview_materials(low, STAGING / f"{PIECE}.lightmap.png", lightmap["scale"])
            for obj in (*frames, *plugs):  # same slot order: the panels take the same preview materials
                for i, mat in enumerate(low.data.materials):
                    obj.data.materials[i] = mat
            scene.view_settings.view_transform = "Standard"
            for name, cam in cams.items():
                render_to(cam, renders / f"{name}.lightmapped.png")
            for obj in (low, *frames, *plugs):
                for i, mat in enumerate(originals):
                    obj.data.materials[i] = mat
            # Cycles diffuse-only reference for the engine comparison (same path tracer as the bake).
            render_settings("CYCLES", 96)
            scene.view_settings.view_transform = "Standard"
            set_metal_links(False)
            for mat in low.data.materials:
                bsdf_of(mat).inputs["Specular IOR Level"].default_value = 0.0
            render_to(cams["hero"], renders / "hero.reference-diffuse.png")
            for mat in low.data.materials:
                bsdf_of(mat).inputs["Specular IOR Level"].default_value = 0.5
            set_metal_links(True)
        report["renders"] = sorted(p.name for p in renders.glob("*.png"))

    set_visible([high, *high_panels], False)
    for obj in (high, *high_panels):
        bpy.data.objects.remove(obj)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_DIR / f"{PIECE}_low.blend"), copy=True, compress=True)
    report["blend"] = {p.name: {"sha256": sha256(p), "bytes": p.stat().st_size} for p in sorted(BLEND_DIR.glob("*.blend"))}
    report["colliders_added"] = colliders
    report["host_load_end"] = load_avg()
    report["files"] = {p.name: sha256(p) for p in sorted(STAGING.iterdir()) if p.suffix in {".glb", ".png", ".json", ".ktx2"} and p.name not in ("report.json", "reimport.json")}
    (STAGING / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: report[k] for k in ("low", "high")}, indent=2))


if __name__ == "__main__":
    main()
