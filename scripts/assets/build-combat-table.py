"""P4-T5 combat table (form after assets-source/concepts/table-sheet-1.png): a brass and walnut
drop-leaf table on a brass-banded drum, with two hinged leaves, a felt dice tray recessed into the top
inside a bevelled brass frame, brass strap inlays and scroll flourishes, draw and discard slots and a
sigil plate socket. Built procedurally and exported as an image-free GLB whose materials are named
after the approved P4-T3 tileable sets (`public/assets/materials/`). UV0 is in tile units (metres /
tileMeters, so the shared sets bind at repeat 1); UV1 is a unique atlas holding the table's own baked
ambient occlusion (`combat-table.ao.png` / `.ktx2`). The felt's nap maps (`combat-table.felt.*.png`)
are generated beside the GLB; the manifest's materialSlots carry the runtime look.

Blender run (build, AO bake, export, reimport gate, manifest, renders, .blend sources):
    "$BLENDER" -b --factory-startup --python-exit-code 1 -P scripts/assets/build-combat-table.py -- \
        [--out assets-source/props/combat-table/staging] [--runtime public/assets/props/combat-table] \
        [--size 2048] [--samples 64] [--device GPU|CPU] [--skip-bake] [--skip-renders]
Review sheet (system Python with Pillow, after the Blender run):
    python3 -I scripts/assets/build-combat-table.py --sheet [--out ...]

Frame: Blender is Z-up; runtime (x, y, z) = Blender (x, z, -y). The player sits at runtime +Z
(Blender -Y) and the enemies stand beyond the table at runtime -Z (Blender +Y).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PIECE = "combat-table"
DEFAULT_OUT = REPO / "assets-source/props/combat-table/staging"
DEFAULT_RUNTIME = REPO / "public/assets/props/combat-table"
MATERIAL_DIR = REPO / "public/assets/materials"
CONCEPT = REPO / "assets-source/concepts/table-sheet-1.png"
KTX = Path.home() / ".local/opt/ktx-software-4.4.2/bin/ktx"

# Dimensions in metres, Blender frame.
TOP = 0.75  # authored playing-surface height; the runtime scales the root to the seated waist height
SLAB = 0.035  # top thickness
# Unfolded top: a superellipse 1.50 m wide by 0.80 m deep inside the footprint src/combat/placement.ts
# reserves (TABLE_HALF_WIDTH 0.75, TABLE_HALF_DEPTH 0.4). The exponent squares the leaves off so a
# folded leaf hangs as a near-rectangular drum wall (table-sheet-1 panel 1) instead of a D skirt.
R = (0.75, 0.40)
SUPER_N = 3.0
R_IN = (R[0] - 0.02, R[1] - 0.02)  # inner edge of the polished rim lip
HINGE_X = 0.40
LIP = 0.004  # polished brass lip proud of the top along the rim
HINGE_Z = TOP - SLAB  # hinge axis runs along Blender Y at the slab's bottom outer edge
# Dice tray recessed into the top (table-sheet-1 panel 3). The felt floor keeps the 0.31 x 0.19 m
# size src/dice/world.ts AUTHORED_TRAY_HALF matches; a bevelled brass frame rings the opening.
TRAY = {"cy": -0.18, "inner_w": 0.31, "inner_d": 0.19, "frame": 0.03, "depth": 0.026}
# Frame profile from the outer edge inward: (inset, height above TOP, material of the step ending here).
TRAY_PROFILE = [(0.0, 0.0, None), (0.0, 0.003, 2), (0.010, 0.010, 2), (0.018, 0.010, 2), (0.030, 0.0, 2), (0.030, -0.026, 3)]
SLOT = {"cx": 0.56, "cy": -0.13, "inner_w": 0.069, "inner_d": 0.094, "frame": 0.011, "felt": 0.0015}
SLOT_PROFILE = [(0.0, 0.0, None), (0.0, 0.0015, 2), (0.004, 0.0035, 2), (0.007, 0.0035, 2), (0.011, 0.0015, 2)]
MEDALLION = {"cy": 0.15, "root": 0.09, "tip": 0.105, "teeth": 20, "h": 0.006}
SIGIL_SOCKET = (0.0, 0.15, TOP + 0.30)  # floats above the gear medallion, between centre and far edge
FOLD_DEG = 90.0
# Drum under the top (folded, the table reads as table-sheet-1 panel 1: a brass-banded drum).
DRUM_R = 0.32
GEAR_ROOT, GEAR_TIP = DRUM_R + 0.015, DRUM_R + 0.032
# Brass bands round the drum (Blender z). The leaf straps sit where these bands land when folded.
DRUM_BANDS = ((0.455, 0.485), (0.665, 0.69))
# Brass strap inlays (proud of the top), x ranges on each side. Body straps flank the hinge; leaf
# straps run parallel to it, so a hanging leaf shows them as horizontal bands level with the drum's.
STRAP_H = 0.0015
BODY_STRAP_X = (0.375, 0.395)
LEAF_STRAPS_X = ((0.405, 0.435), (HINGE_X + (HINGE_Z - DRUM_BANDS[0][1]), HINGE_X + (HINGE_Z - DRUM_BANDS[0][0])))
CROSS_STRAP_Y = (-0.012, 0.008)  # between the tray frame and the gear medallion
FLOURISH = {"w": 0.007, "h": 0.0012}

# Material slots. The tileable sets are the approved P4-T3 materials; felt is a ruby velvet with a
# generated nap (basecolor + normal beside the GLB, bound at runtime with a sheen).
MATS = ["walnut", "brass-aged", "brass-polished", "felt"]
W, A, P, F = range(4)
FELT_SRGB = (0x86, 0x1C, 0x27)  # nap map mean, toward the art-bible ruby #93212B
FELT_TILE_M = 0.25
FELT_PX = 512
FELT_SHEEN = {"color": "#7A1A28", "roughness": 0.5}
# Per-slot normal strength on the table. The brass sets' turned-ring relief draws a concentric swirl
# on the table's straight rims and frames, so the table brass runs almost smooth; the walnut relief
# turns bark-like at grazing light at full strength. The shared sets themselves are unchanged.
NORMAL_SCALE = {"walnut": 0.5, "brass-aged": 0.15, "brass-polished": 0.06, "felt": 0.7}
# Runtime look (bindTableMaterials), tuned in the fight under the hero probe and AgX: walnut tint and
# lower environment gain toward oiled walnut #583C26 (the leaves greyed out under env specular), brass
# tint, ORM roughness scale and environment gain for saturated highlights, a felt tint toward ruby
# #93212B, and how much of the baked AO multiplies base colour (three applies aoMap to indirect light
# only, so contact needs this).
RUNTIME_LOOK = {
    "walnut": {"tint": "#9AA088", "envScale": 0.6, "contact": 0.9},
    "brass-aged": {"tint": "#E6C050", "roughnessScale": 0.6, "envScale": 2.0, "contact": 0.7},
    "brass-polished": {"tint": "#E6C050", "roughnessScale": 0.4, "envScale": 2.6, "contact": 0.7},
    "felt": {"tint": "#FF3858", "contact": 1.0},
}
# Factor-only GLB materials (sRGB, roughness, metallic): the fallback look when the sets fail to load.
EXPORT_FACTORS = {
    "walnut": ((0x58, 0x3C, 0x26), 0.6, 0.0),
    "brass-aged": ((0xA8, 0x86, 0x48), 0.45, 1.0),
    "brass-polished": ((0xDE, 0xC1, 0x6A), 0.25, 1.0),
    "felt": (FELT_SRGB, 0.95, 0.0),
}
TILE_PX = 1024  # runtime size of every shared map; one UV0 unit is one tile

DETAIL = {
    "low": {"segs": 48, "arc": 40, "gear_samples": 3, "bevel": 0.0},
    "high": {"segs": 128, "arc": 120, "gear_samples": 6, "bevel": 0.0015},
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_args() -> argparse.Namespace:
    in_blender = "-P" in sys.argv or "--python" in sys.argv
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else ([] if in_blender else sys.argv[1:])
    p = argparse.ArgumentParser()
    p.add_argument("--out", type=Path, default=DEFAULT_OUT)
    p.add_argument("--runtime", type=Path, default=DEFAULT_RUNTIME)
    p.add_argument("--size", type=int, default=2048)
    p.add_argument("--samples", type=int, default=64)
    p.add_argument("--device", choices=["GPU", "CPU"], default="GPU")
    p.add_argument("--skip-bake", action="store_true")
    p.add_argument("--skip-renders", action="store_true")
    p.add_argument("--sheet", action="store_true", help="compose the review sheet (system Python)")
    return p.parse_args(argv)


# --------------------------------------------------------------------------------------------------
# 2D outlines (counter-clockwise, Blender XY)


def circle_pts(cx: float, cy: float, r: float, n: int) -> list[tuple[float, float]]:
    return [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)]


Ellipse = tuple[float, float]  # semi-axes (x, y) of the SUPER_N superellipse


def se_pt(r: Ellipse, a: float) -> tuple[float, float]:
    c, s = math.cos(a), math.sin(a)
    return (r[0] * math.copysign(abs(c) ** (2 / SUPER_N), c), r[1] * math.copysign(abs(s) ** (2 / SUPER_N), s))


def se_angle_at_x(r: Ellipse, c: float) -> float:
    """Parameter angle in [0, pi/2] where the superellipse r crosses x = c."""
    return math.acos((c / r[0]) ** (SUPER_N / 2))


def se_y_at_x(r: Ellipse, x: float) -> float:
    return r[1] * max(0.0, 1 - (abs(x) / r[0]) ** SUPER_N) ** (1 / SUPER_N)


def arc_pts(r: Ellipse, a0: float, a1: float, n_full: int) -> list[tuple[float, float]]:
    steps = max(2, math.ceil(abs(a1 - a0) / (2 * math.pi) * n_full))
    return [se_pt(r, a0 + (a1 - a0) * i / steps) for i in range(steps + 1)]


def centre_band(r: Ellipse, c: float, n_full: int) -> list[tuple[float, float]]:
    """The superellipse r clipped to |x| <= c."""
    t = se_angle_at_x(r, c)
    back = arc_pts(r, t, math.pi - t, n_full)  # from (c, h) over the far side to (-c, h)
    front = arc_pts(r, math.pi + t, 2 * math.pi - t, n_full)  # from (-c, -h) to (c, -h)
    return back + front


def leaf_d(r: Ellipse, c: float, n_full: int, side: int) -> list[tuple[float, float]]:
    """The segment of superellipse r beyond x = side * c."""
    t = se_angle_at_x(r, c)
    if side > 0:
        return arc_pts(r, -t, t, n_full)
    return arc_pts(r, math.pi - t, math.pi + t, n_full)


def band_segment(r_out: Ellipse, r_in: Ellipse, c: float, n_full: int, a_mid: float, side_clip: int) -> list[tuple[float, float]]:
    """Superelliptical ring between r_in and r_out, clipped by the line x = side_clip * c.

    side_clip = +1 / -1 keeps the leaf side; 0 keeps |x| <= c on the half where sign(y) = sign(a_mid).
    """
    to = se_angle_at_x(r_out, c)
    ti = se_angle_at_x(r_in, c)
    if side_clip == 0:
        if a_mid > 0:  # far side, y > 0
            return arc_pts(r_out, to, math.pi - to, n_full) + arc_pts(r_in, math.pi - ti, ti, n_full)
        return arc_pts(r_out, math.pi + to, 2 * math.pi - to, n_full) + arc_pts(r_in, 2 * math.pi - ti, math.pi + ti, n_full)
    if side_clip > 0:
        return arc_pts(r_out, -to, to, n_full) + arc_pts(r_in, ti, -ti, n_full)
    return arc_pts(r_out, math.pi - to, math.pi + to, n_full) + arc_pts(r_in, math.pi + ti, math.pi - ti, n_full)


def gear_pts(cx: float, cy: float, root: float, tip: float, teeth: int, samples: int) -> list[tuple[float, float]]:
    """A gear outline: each tooth is a trapezoid (root, rise, tip, fall) sampled along its arcs."""
    pts: list[tuple[float, float]] = []
    pitch = 2 * math.pi / teeth
    # Fractions of a pitch: root land, flank up, tip land, flank down.
    for k in range(teeth):
        a = k * pitch
        for frac, r in ((0.0, root), (0.30, root), (0.40, tip), (0.70, tip), (0.80, root)):
            pts.append((cx + r * math.cos(a + frac * pitch), cy + r * math.sin(a + frac * pitch)))
        for s in range(1, samples):
            f = 0.80 + 0.20 * s / samples
            pts.append((cx + root * math.cos(a + f * pitch), cy + root * math.sin(a + f * pitch)))
    return pts


def scroll(x0: float, y0: float, sign: int, lead: float, wave: float, r0: float, r1: float, turns: float, n_full: int) -> list[tuple[float, float]]:
    """A C-scroll: a gently waved lead from (x0, y0) along sign * X, ending in a spiral curl that rolls
    over the top and inward (radius r0 down to r1)."""
    pts = []
    k = 10
    for i in range(k):
        u = i / k
        pts.append((x0 + sign * lead * u, y0 - wave * math.sin(math.pi * u)))
    cx, cy = x0 + sign * (lead + r0), y0
    steps = max(8, math.ceil(turns * n_full))
    for i in range(steps + 1):
        s = i / steps
        a = math.pi - 2 * math.pi * turns * s  # from the lead's end, over the top, clockwise
        r = r0 + (r1 - r0) * s
        pts.append((cx + sign * r * math.cos(a), cy + r * math.sin(a)))
    return pts


def flourish_curves(n_full: int) -> list[list[tuple[float, float]]]:
    """Brass scroll inlays: a mirrored pair in front of the tray and a pair flanking the medallion."""
    front_y = TRAY["cy"] - TRAY["inner_d"] / 2 - TRAY["frame"] - 0.04
    out = []
    for sign in (-1, 1):
        out.append(scroll(sign * 0.006, front_y, sign, 0.058, 0.008, 0.02, 0.008, 1.3, n_full))
        out.append(scroll(sign * (MEDALLION["tip"] + 0.012), MEDALLION["cy"], sign, 0.09, -0.01, 0.024, 0.009, 1.3, n_full))
    return out


# --------------------------------------------------------------------------------------------------
# Blender build


def build_scene(bpy, bmesh, detail: str, scene) -> dict:
    """Builds root, body and both leaves (unfolded, origins on their hinges) into `scene`."""
    from mathutils import Matrix, Vector

    d = DETAIL[detail]
    segs, arc_n = d["segs"], d["arc"]
    sfx = "" if detail == "low" else "-high"

    def new_bm():
        return bmesh.new()

    def face(bm, coords, mat, smooth=False):
        verts = [bm.verts.new(c) for c in coords]
        f = bm.faces.new(verts)
        f.material_index = mat
        f.smooth = smooth
        return f

    def prism(bm, outline, z0, z1, top_mat, side_mat, bottom_mat=None, top=True, side_fn=None):
        """Extrudes a CCW outline. side_fn(i, a, b) may return a material per edge (None skips it)."""
        n = len(outline)
        if top:
            face(bm, [(x, y, z1) for x, y in outline], top_mat)
        if bottom_mat is not None:
            face(bm, [(x, y, z0) for x, y in reversed(outline)], bottom_mat)
        for i in range(n):
            a, b = outline[i], outline[(i + 1) % n]
            m = side_fn(i, a, b) if side_fn else side_mat
            if m is None:
                continue
            face(bm, [(a[0], a[1], z0), (b[0], b[1], z0), (b[0], b[1], z1), (a[0], a[1], z1)], m)

    def box(bm, x0, x1, y0, y1, z0, z1, mat, bottom=False):
        prism(bm, [(x0, y0), (x1, y0), (x1, y1), (x0, y1)], z0, z1, mat, mat, mat if bottom else None)

    def lathe(bm, profile, n, cx=0.0, cy=0.0):
        """Revolves [(r, z, mat_of_segment_ending_here), ...] about Z. r = 0 points close a fan."""
        rings = []
        for r, z, _m in profile:
            rings.append([(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n), z) for i in range(n)])
        vrings = [[bm.verts.new(c) for c in ring] for ring in rings]
        for j in range(1, len(profile)):
            mat = profile[j][2]
            lo, hi = vrings[j - 1], vrings[j]
            for i in range(n):
                k = (i + 1) % n
                f = bm.faces.new([lo[i], lo[k], hi[k], hi[i]])
                f.material_index = mat
                f.smooth = True
        bmesh.ops.remove_doubles(bm, verts=[v for ring in vrings for v in ring], dist=1e-6)

    def cylinder_y(bm, x, y0, y1, z, r, n, mat):
        """A cylinder along Blender Y (hinge knuckle), with caps."""
        ring0 = [bm.verts.new((x + r * math.cos(2 * math.pi * i / n), y0, z + r * math.sin(2 * math.pi * i / n))) for i in range(n)]
        ring1 = [bm.verts.new((x + r * math.cos(2 * math.pi * i / n), y1, z + r * math.sin(2 * math.pi * i / n))) for i in range(n)]
        for i in range(n):
            k = (i + 1) % n
            f = bm.faces.new([ring0[i], ring1[i], ring1[k], ring0[k]])
            f.material_index = mat
            f.smooth = True
        for ring in (ring0, list(reversed(ring1))):
            f = bm.faces.new(ring)
            f.material_index = mat

    def gear_bottom_strip(bm, outline, r_in, z, mat):
        """Annular underside between a gear outline and a hidden inner circle."""
        n = len(outline)
        outer = [bm.verts.new((x, y, z)) for x, y in outline]
        inner = [bm.verts.new((r_in * math.cos(math.atan2(y, x)), r_in * math.sin(math.atan2(y, x)), z)) for x, y in outline]
        for i in range(n):
            k = (i + 1) % n
            f = bm.faces.new([outer[i], inner[i], inner[k], outer[k]])
            f.material_index = mat

    def top_with_hole(bm, outline, hole, z, mat):
        """Flat upward face over a CCW outline with a CCW hole, triangulated."""
        from mathutils.geometry import tessellate_polygon

        loops = [[Vector((x, y, z)) for x, y in outline], [Vector((x, y, z)) for x, y in hole]]
        flat = [p for loop in loops for p in loop]
        verts = [bm.verts.new(p) for p in flat]
        for tri in tessellate_polygon(loops):
            a, b, c = (flat[i] for i in tri)
            order = tri if (b - a).cross(c - a).z > 0 else (tri[0], tri[2], tri[1])
            f = bm.faces.new([verts[i] for i in order])
            f.material_index = mat

    def bevel_frame(bm, cx, cy, hx, hy, profile, floor_mat):
        """A rectangular frame lofted through `profile` [(inset, height above TOP, mat), ...] from the
        outer edge (half extents hx, hy) inward, closed by a floor face at the last ring."""
        rings = []
        for inset, h, _m in profile:
            x0, x1, y0, y1 = cx - hx + inset, cx + hx - inset, cy - hy + inset, cy + hy - inset
            rings.append([bm.verts.new((x, y, TOP + h)) for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))])
        for k in range(1, len(rings)):
            lo, hi = rings[k - 1], rings[k]
            for i in range(4):
                j = (i + 1) % 4
                f = bm.faces.new([lo[i], lo[j], hi[j], hi[i]])
                f.material_index = profile[k][2]
        f = bm.faces.new(rings[-1])
        f.material_index = floor_mat

    def strap(bm, x0, x1):
        """A strap inlay across the top between x0 < x1, ending at the rim lip's inner edge."""
        y0, y1 = se_y_at_x(R_IN, x0), se_y_at_x(R_IN, x1)
        prism(bm, [(x0, -y0), (x1, -y1), (x1, y1), (x0, y0)], TOP, TOP + STRAP_H, P, P)

    def ribbon(bm, curve, width, z0, z1, mat):
        """A flat strip of `width` along a polyline, extruded from z0 to z1 (top, both sides, ends)."""
        n = len(curve)
        left, right = [], []
        for i, (x, y) in enumerate(curve):
            ax, ay = curve[max(0, i - 1)]
            bx, by = curve[min(n - 1, i + 1)]
            tx, ty = bx - ax, by - ay
            ln = math.hypot(tx, ty) or 1.0
            nx, ny = -ty / ln * width / 2, tx / ln * width / 2
            left.append((x + nx, y + ny))
            right.append((x - nx, y - ny))
        lt = [bm.verts.new((x, y, z1)) for x, y in left]
        rt = [bm.verts.new((x, y, z1)) for x, y in right]
        lb = [bm.verts.new((x, y, z0)) for x, y in left]
        rb = [bm.verts.new((x, y, z0)) for x, y in right]
        for i in range(n - 1):
            # Wound outward: top up, the left wall toward +normal, the right wall toward -normal.
            for quad in ([rt[i], rt[i + 1], lt[i + 1], lt[i]], [lb[i + 1], lb[i], lt[i], lt[i + 1]], [rb[i], rb[i + 1], rt[i + 1], rt[i]]):
                f = bm.faces.new(quad)
                f.material_index = mat
        for quad in ([rb[0], rt[0], lt[0], lb[0]], [lb[-1], lt[-1], rt[-1], rb[-1]]):
            f = bm.faces.new(quad)
            f.material_index = mat

    parts: list = []  # (bm, owner) owner in {"body", "leaf-left", "leaf-right"}

    # Pedestal: foot, column and the cup under the drum (lathe, one profile).
    bm = new_bm()
    lathe(
        bm,
        [
            (0.30, 0.0, A),
            (0.30, 0.03, A),
            (0.27, 0.05, P),
            (0.13, 0.085, P),
            (0.085, 0.105, P),
            (0.07, 0.125, P),
            (0.07, 0.37, P),
            (0.09, 0.39, P),
            (0.09, 0.41, A),
            (0.16, 0.425, A),
            (0.26, 0.435, A),
            (DRUM_R - 0.005, 0.44, A),
            (DRUM_R, 0.445, A),
            (DRUM_R, 0.70, W),
        ],
        segs,
    )
    parts.append((bm, "body", True))
    # Polished brass bands round the drum, and aged straps over the box-projection seams at 45 degrees.
    for z0, z1 in DRUM_BANDS:
        bm = new_bm()
        lathe(bm, [(DRUM_R, z0, P), (DRUM_R + 0.01, z0, P), (DRUM_R + 0.01, z1, P), (DRUM_R, z1, P)], segs)
        parts.append((bm, "body", True))
    bm = new_bm()
    for k in range(8):
        ang = math.radians(45 * k)
        local = [(DRUM_R - 0.004, -0.011), (DRUM_R + 0.006, -0.011), (DRUM_R + 0.006, 0.011), (DRUM_R - 0.004, 0.011)]
        outline = [(x * math.cos(ang) - y * math.sin(ang), x * math.sin(ang) + y * math.cos(ang)) for x, y in local]
        prism(bm, outline, DRUM_BANDS[0][1], DRUM_BANDS[1][0], A, A)
    parts.append((bm, "body", False))
    # Gear ring under the top, visible in the shadow line between drum and slab.
    bm = new_bm()
    gear = gear_pts(0, 0, GEAR_ROOT, GEAR_TIP, 44, d["gear_samples"])
    prism(bm, gear, 0.70, HINGE_Z, P, P, top=False)
    gear_bottom_strip(bm, gear, DRUM_R - 0.005, 0.70, P)
    parts.append((bm, "body", False))
    # Fixed centre band of the top: polished brass on its curved rim, walnut on the hinge edges, and
    # the dice tray's opening cut out of the walnut top.
    t = TRAY
    tx = t["inner_w"] / 2 + t["frame"]
    ty0, ty1 = t["cy"] - t["inner_d"] / 2 - t["frame"], t["cy"] + t["inner_d"] / 2 + t["frame"]
    bm = new_bm()
    band = centre_band(R, HINGE_X, arc_n)
    prism(bm, band, HINGE_Z, TOP, W, None, W, top=False, side_fn=lambda i, a, b: W if abs(a[0] - b[0]) < 1e-9 and abs(abs(a[0]) - HINGE_X) < 1e-6 else P)
    top_with_hole(bm, band, [(-tx, ty0), (tx, ty0), (tx, ty1), (-tx, ty1)], TOP, W)
    parts.append((bm, "body", False))
    bm = new_bm()
    for mid in (1, -1):
        prism(bm, band_segment(R, R_IN, HINGE_X, arc_n, mid, 0), TOP, TOP + LIP, P, P)
    parts.append((bm, "body", False))
    # Gear medallion under the sigil plate, with a hub.
    bm = new_bm()
    m = MEDALLION
    prism(bm, gear_pts(0, m["cy"], m["root"], m["tip"], m["teeth"], d["gear_samples"]), TOP, TOP + m["h"], P, P)
    parts.append((bm, "body", False))
    bm = new_bm()
    lathe(bm, [(0.03, TOP + m["h"], P), (0.03, TOP + m["h"] + 0.008, P), (0.022, TOP + m["h"] + 0.012, P), (0.0, TOP + m["h"] + 0.012, P)], max(16, segs // 2), 0.0, m["cy"])
    parts.append((bm, "body", True))
    # Dice tray recessed into the top: bevelled polished frame, felt walls and floor.
    bm = new_bm()
    bevel_frame(bm, 0.0, t["cy"], tx, (ty1 - ty0) / 2, TRAY_PROFILE, F)
    parts.append((bm, "body", False))
    # Brass strap inlays between the top's panels: along both hinge lines and across the centre band.
    bm = new_bm()
    for sgn in (-1, 1):
        x0, x1 = sorted((sgn * BODY_STRAP_X[0], sgn * BODY_STRAP_X[1]))
        strap(bm, x0, x1)
    cy0, cy1 = CROSS_STRAP_Y
    prism(bm, [(-BODY_STRAP_X[0], cy0), (BODY_STRAP_X[0], cy0), (BODY_STRAP_X[0], cy1), (-BODY_STRAP_X[0], cy1)], TOP, TOP + STRAP_H, P, P)
    parts.append((bm, "body", False))
    # Brass flourishes (flat inlay scrolls, table-sheet-1 panel 3): in front of the tray, and
    # flanking the gear medallion.
    bm = new_bm()
    for curve in flourish_curves(d["arc"]):
        ribbon(bm, curve, FLOURISH["w"], TOP, TOP + FLOURISH["h"], P)
    parts.append((bm, "body", False))

    # Leaves, built in table coordinates (unfolded) and moved onto their hinge origins later.
    for name, side in (("leaf-left", -1), ("leaf-right", 1)):
        bm = new_bm()
        outline = leaf_d(R, HINGE_X, arc_n, side)
        # leaf_d is an open arc; closing it adds the hinge edge (walnut, hidden when unfolded).
        prism(bm, outline, HINGE_Z, TOP, W, None, W, side_fn=lambda i, a, b: W if abs(a[0] - b[0]) < 1e-9 else P)
        parts.append((bm, name, False))
        bm = new_bm()
        prism(bm, band_segment(R, R_IN, HINGE_X, arc_n, 0, side), TOP, TOP + LIP, P, P)
        parts.append((bm, name, False))
        # Straps parallel to the hinge: folded, they hang level with the drum's bands.
        bm = new_bm()
        for x0, x1 in LEAF_STRAPS_X:
            a, b = side * x0, side * x1
            strap(bm, min(a, b), max(a, b))
        parts.append((bm, name, False))
        s = SLOT
        cx = side * s["cx"]
        bm = new_bm()
        bevel_frame(bm, cx, s["cy"], s["inner_w"] / 2 + s["frame"], s["inner_d"] / 2 + s["frame"], SLOT_PROFILE, F)
        parts.append((bm, name, False))
        bm = new_bm()
        for ky in (-0.22, 0.0, 0.22):
            cylinder_y(bm, side * HINGE_X, ky - 0.03, ky + 0.03, HINGE_Z, 0.009, max(12, segs // 4), P)
        parts.append((bm, name, True))

    # Turn each part into an object (bevel on the high build), then join per owner.
    mats = [bpy.data.materials.get(f"{PIECE}-{m}") for m in MATS]
    owners: dict[str, list] = {"body": [], "leaf-left": [], "leaf-right": []}
    for i, (bm, owner, _curved) in enumerate(parts):
        # Winding is outward by construction; recalc_face_normals guesses wrong on open shells.
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-7)
        mesh = bpy.data.meshes.new(f"{PIECE}{sfx}-part{i}")
        for mat in mats:
            mesh.materials.append(mat)
        bm.to_mesh(mesh)
        bm.free()
        obj = bpy.data.objects.new(f"{PIECE}{sfx}-part{i}", mesh)
        scene.collection.objects.link(obj)
        if d["bevel"] > 0:
            mod = obj.modifiers.new("bevel", "BEVEL")
            mod.width = d["bevel"]
            mod.segments = 2
            mod.limit_method = "ANGLE"
            mod.angle_limit = math.radians(40)
            mod.harden_normals = False
        owners[owner].append(obj)

    def join(objs, name):
        for o in bpy.context.view_layer.objects:
            o.select_set(False)
        for o in objs:
            o.select_set(True)
            if o.modifiers:
                bpy.context.view_layer.objects.active = o
                bpy.ops.object.modifier_apply(modifier="bevel")
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.join()
        obj = bpy.context.view_layer.objects.active
        obj.name = name
        obj.data.name = f"{name}-mesh"
        return obj

    window_scene = bpy.context.window.scene if bpy.context.window else None
    if window_scene is not None:
        bpy.context.window.scene = scene
    root = bpy.data.objects.new(f"{PIECE}{sfx}", None)
    root.empty_display_size = 0.2
    scene.collection.objects.link(root)
    out = {"root": root}
    for owner, objs in owners.items():
        node = "table-body" if owner == "body" else owner
        obj = join(objs, f"{node}{sfx}")
        me = obj.data
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        bm.to_mesh(me)
        bm.free()
        for poly in me.polygons:
            poly.use_smooth = True
        me.set_sharp_from_angle(angle=math.radians(35))
        obj.parent = root
        out[owner] = obj
    # Move leaf origins onto their hinge axes; unfolded rotation is identity, folded is +-90 deg.
    for owner, side in (("leaf-left", -1), ("leaf-right", 1)):
        obj = out[owner]
        hinge = Vector((side * HINGE_X, 0.0, HINGE_Z))
        obj.data.transform(Matrix.Translation(-hinge))
        obj.location = hinge
    bpy.context.view_layer.update()
    return out


def fold(objs: dict, unfolded: bool) -> None:
    # Blender rotation about +Y by -90 deg swings leaf-left's outer edge (-X) down to -Z.
    for owner, sign in (("leaf-left", -1), ("leaf-right", 1)):
        objs[owner].rotation_mode = "XYZ"
        objs[owner].rotation_euler = (0.0, 0.0 if unfolded else math.radians(sign * FOLD_DEG), 0.0)


def add_sockets(bpy, objs: dict) -> dict:
    """Sockets ride the node they sit on: tray and sigil under the root, card slots under a leaf."""
    root = objs["root"]
    t, s = TRAY, SLOT
    specs = [
        ("socket-dice-tray", root, (0.0, t["cy"], TOP - t["depth"])),
        ("socket-sigil-plate", root, SIGIL_SOCKET),
        ("socket-draw", objs["leaf-left"], (-s["cx"] + HINGE_X, s["cy"], TOP + s["felt"] - HINGE_Z)),
        ("socket-discard", objs["leaf-right"], (s["cx"] - HINGE_X, s["cy"], TOP + s["felt"] - HINGE_Z)),
    ]
    out = {}
    for name, parent, loc in specs:
        e = bpy.data.objects.new(name, None)
        e.empty_display_type = "ARROWS"
        e.empty_display_size = 0.05
        e.parent = parent
        e.location = loc
        bpy.context.scene.collection.objects.link(e)
        out[name] = e
    return out


def tile_uvs(bpy, objs: dict) -> None:
    """Adds the `tile` UV layer: per-face box projection in table metres / the set's tile size."""
    tile_m = {name: json.loads((MATERIAL_DIR / "materials.json").read_text())[name]["tileMeters"] for name in MATS[:3]}
    tile_m["felt"] = FELT_TILE_M
    for owner in ("body", "leaf-left", "leaf-right"):
        obj = objs[owner]
        me = obj.data
        uv = me.uv_layers.new(name="tile")
        off = obj.location.copy()
        for poly in me.polygons:
            nx, ny, nz = (abs(c) for c in poly.normal)
            scale = 1.0 / tile_m[MATS[poly.material_index]]
            for li in poly.loop_indices:
                co = me.vertices[me.loops[li].vertex_index].co + off
                if nz >= nx and nz >= ny:
                    u, v = co.x, co.y  # walnut planks run along Y, toward the player
                elif nx >= ny:
                    u, v = co.y, co.z
                else:
                    u, v = co.x, co.z
                uv.data[li].uv = (u * scale, v * scale)


def atlas_uvs(bpy, objs: dict, size: int, margin_px: int) -> None:
    meshes = [objs[o] for o in ("body", "leaf-left", "leaf-right")]
    for obj in meshes:
        obj.data.uv_layers.active = obj.data.uv_layers["ao"]
    for o in bpy.context.view_layer.objects:
        o.select_set(o in meshes)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.0, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(rotate=True, margin_method="FRACTION", margin=margin_px / size)
    bpy.ops.object.mode_set(mode="OBJECT")


def texel_density(objs: dict, size: int, layer: str) -> dict:
    """Median px/m per material on a UV layer, from 3D and UV triangle areas."""
    import statistics

    per: dict[str, list[float]] = {m: [] for m in MATS}
    for owner in ("body", "leaf-left", "leaf-right"):
        me = objs[owner].data
        uv = me.uv_layers[layer].data
        for poly in me.polygons:
            li = list(poly.loop_indices)
            if len(li) != 3:
                continue
            p = [me.vertices[me.loops[i].vertex_index].co for i in li]
            q = [uv[i].uv for i in li]
            a3 = ((p[1] - p[0]).cross(p[2] - p[0])).length / 2
            a2 = abs((q[1].x - q[0].x) * (q[2].y - q[0].y) - (q[2].x - q[0].x) * (q[1].y - q[0].y)) / 2
            if a3 > 1e-9:
                per[MATS[poly.material_index]].append(math.sqrt(a2 / a3) * size)
    return {m: round(statistics.median(v), 1) for m, v in per.items() if v}


# --------------------------------------------------------------------------------------------------
# Materials and bakes


def srgb_to_linear(c: float) -> float:
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def make_source_materials(bpy, felt_dir: Path) -> None:
    """Tile-mapped materials built from the approved P4-T3 PNG maps (render and bake sources)."""
    for name in MATS:
        mat = bpy.data.materials.new(f"{PIECE}-{name}")
        nt = mat.node_tree
        bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
        if name == "felt":
            # The generated nap maps (felt_maps), as the runtime binds them, with a velvet sheen.
            bsdf.inputs["Roughness"].default_value = 0.9
            bsdf.inputs["Metallic"].default_value = 0.0
            bsdf.inputs["Sheen Weight"].default_value = 1.0
            bsdf.inputs["Sheen Roughness"].default_value = FELT_SHEEN["roughness"]
            sheen = FELT_SHEEN["color"]
            bsdf.inputs["Sheen Tint"].default_value = (*(srgb_to_linear(int(sheen[i : i + 2], 16)) for i in (1, 3, 5)), 1.0)
            uvn = nt.nodes.new("ShaderNodeUVMap")
            uvn.uv_map = "tile"
            for role, socket in (("basecolor", "Base Color"), ("normal", None)):
                img = bpy.data.images.load(str(felt_dir / f"{PIECE}.felt.{role}.png"), check_existing=True)
                img.colorspace_settings.name = "sRGB" if role == "basecolor" else "Non-Color"
                tex = nt.nodes.new("ShaderNodeTexImage")
                tex.image = img
                nt.links.new(uvn.outputs["UV"], tex.inputs["Vector"])
                if socket:
                    nt.links.new(tex.outputs["Color"], bsdf.inputs[socket])
                else:
                    nm = nt.nodes.new("ShaderNodeNormalMap")
                    nm.uv_map = "tile"
                    nm.inputs["Strength"].default_value = NORMAL_SCALE["felt"]
                    nt.links.new(tex.outputs["Color"], nm.inputs["Color"])
                    nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
            continue
        uvn = nt.nodes.new("ShaderNodeUVMap")
        uvn.uv_map = "tile"
        texs = {}
        for role in ("basecolor", "normal", "orm"):
            img = bpy.data.images.load(str(MATERIAL_DIR / name / f"{name}.{role}.png"), check_existing=True)
            img.colorspace_settings.name = "sRGB" if role == "basecolor" else "Non-Color"
            tex = nt.nodes.new("ShaderNodeTexImage")
            tex.name = f"src-{role}"
            tex.image = img
            nt.links.new(uvn.outputs["UV"], tex.inputs["Vector"])
            texs[role] = tex
        nt.links.new(texs["basecolor"].outputs["Color"], bsdf.inputs["Base Color"])
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(texs["orm"].outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.uv_map = "tile"
        nm.inputs["Strength"].default_value = NORMAL_SCALE[name]
        nt.links.new(texs["normal"].outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])


def felt_maps(size: int = FELT_PX, seed: int = 1715) -> dict:
    """Tileable velvet nap: crushed-pile mottling, a pile grain and fine fibres combed along the
    plank direction, as an sRGB basecolor around FELT_SRGB and a matching tangent-space normal map.
    Periodic by construction (filtered in the frequency domain), deterministic for a seed."""
    import numpy as np

    rng = np.random.default_rng(seed)
    fy = np.fft.fftfreq(size)[:, None]
    fx = np.fft.fftfreq(size)[None, :]

    def field(sigma_px: float, stretch: float = 1.0):
        w = np.fft.fft2(rng.standard_normal((size, size)))
        g = np.exp(-2 * (np.pi * sigma_px) ** 2 * (fx**2 + (fy * stretch) ** 2))
        out = np.real(np.fft.ifft2(w * g))
        return out / out.std()

    mottle = field(36.0)  # crushed pile, about 2 cm across at FELT_TILE_M
    grain = field(4.0, 0.35)  # pile tufts, combed along the tile's V (the planks' run)
    fibre = field(1.2, 0.25)
    shade = 1.0 + 0.13 * mottle + 0.08 * grain + 0.05 * fibre
    base = np.array([srgb_to_linear(c) for c in FELT_SRGB])
    lin = np.clip(base[None, None, :] * shade[..., None], 0.0, 1.0)
    srgb = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1 / 2.4) - 0.055)
    height = 0.55 * grain + 0.35 * fibre + 0.25 * mottle
    gx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) / 2
    gy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) / 2
    k = 0.6
    n = np.stack([-k * gx, k * gy, np.ones_like(gx)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    to8 = lambda a: np.round(np.clip(a, 0, 1) * 255).astype(np.uint8)  # noqa: E731
    return {"basecolor": to8(srgb), "normal": to8(n * 0.5 + 0.5)}


def bake_ao(bpy, objs: dict, size: int, samples: int, device: str, margin_px: int) -> dict:
    """Cycles AO into the UV1 atlas, one node at a time with the other nodes hidden, so neither pose
    (folded or unfolded) darkens a leaf or the body with the other's geometry."""
    import numpy as np

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import lightmap_helpers as lm

    scene = bpy.context.scene
    report = {"device": lm.select_device(device), "samples": samples, "margin_px": margin_px, "size": size}
    scene.cycles.samples = samples
    scene.render.bake.margin = margin_px
    scene.render.bake.margin_type = "EXTEND"
    if scene.world is None:
        scene.world = bpy.data.worlds.new(f"{PIECE}-world")
    scene.world.light_settings.distance = 0.12
    report["ao_distance_m"] = 0.12
    meshes = [objs[o] for o in ("body", "leaf-left", "leaf-right")]
    img = bpy.data.images.new(f"{PIECE}-bake-ao", size, size, alpha=True, float_buffer=True)
    img.generated_color = (0.0, 0.0, 0.0, 0.0)
    img.colorspace_settings.name = "Non-Color"
    for name in MATS:
        nt = bpy.data.materials[f"{PIECE}-{name}"].node_tree
        node = nt.nodes.new("ShaderNodeTexImage")
        node.name = "bake-target"
        node.image = img
        nt.nodes.active = node
    fold(objs, unfolded=True)
    seconds = []
    for k, obj in enumerate(meshes):
        for other in meshes:
            other.hide_render = other is not obj
            other.select_set(other is obj)
        bpy.context.view_layer.objects.active = obj
        t0 = time.monotonic()
        bpy.ops.object.bake(type="AO", target="IMAGE_TEXTURES", uv_layer="ao", margin=margin_px, margin_type="EXTEND", use_clear=k == 0)
        seconds.append(round(time.monotonic() - t0, 2))
    for other in meshes:
        other.hide_render = False
    # Coverage mask: an emission pass of white with no margin marks the texels faces own (AO's alpha
    # is 1 everywhere, so it cannot tell islands from background).
    mask = bpy.data.images.new(f"{PIECE}-bake-mask", size, size, alpha=True, float_buffer=True)
    mask.colorspace_settings.name = "Non-Color"
    for name in MATS:
        nt = bpy.data.materials[f"{PIECE}-{name}"].node_tree
        nt.nodes["bake-target"].image = mask
        out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
        em = nt.nodes.new("ShaderNodeEmission")
        em.name = "bake-emit"
        em.inputs["Color"].default_value = (1.0, 1.0, 1.0, 1.0)
        nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    for o in meshes:
        o.select_set(True)
    scene.cycles.samples = 1
    bpy.ops.object.bake(type="EMIT", target="IMAGE_TEXTURES", uv_layer="ao", margin=0, use_clear=True)
    for name in MATS:
        nt = bpy.data.materials[f"{PIECE}-{name}"].node_tree
        bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
        out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
        nt.nodes.remove(nt.nodes["bake-emit"])
        nt.nodes.remove(nt.nodes["bake-target"])
    report["seconds_per_node"] = dict(zip(("table-body", "leaf-left", "leaf-right"), seconds))
    rgba = lm.image_rgba(img)
    covered = lm.image_rgba(mask)[..., 0] > 0.5
    ao = rgba[..., 0]
    report["coverage"] = round(float(covered.mean()), 4)
    report["ao_mean"] = round(float(ao[covered].mean()), 4)
    report["ao_p05"] = round(float(np.percentile(ao[covered], 5)), 4)
    # Texels beyond the bake margin go white so a deep mip never pulls black background into an
    # island; the margin itself keeps the extended AO values.
    near = covered.copy()
    for _ in range(margin_px):
        grown = near.copy()
        grown[1:] |= near[:-1]
        grown[:-1] |= near[1:]
        grown[:, 1:] |= near[:, :-1]
        grown[:, :-1] |= near[:, 1:]
        near = grown
    ao = np.where(near, ao, 1.0)
    grey = np.round(np.clip(ao, 0.0, 1.0) * 255).astype(np.uint8)
    return {"report": report, "ao": np.repeat(grey[..., None], 3, axis=2)}


def write_png(rgb, path: Path) -> Path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import lightmap_helpers as lm

    lm.write_png_rgb(path, rgb)
    return path


def encode_ktx2(png: Path) -> Path:
    """The AO map is read through the GLB's UV1, so it keeps the default top-left origin and three
    loads it with flipY = false (unlike the shared tiling sets, which are stored bottom-left)."""
    out = png.with_suffix(".ktx2")
    cmd = [
        str(KTX), "create",
        "--format", "R8G8B8_UNORM", "--assign-tf", "linear",
        "--encode", "uastc", "--uastc-quality", "2", "--uastc-rdo",
        "--zstd", "18", "--generate-mipmap",
    ]
    if out.exists():
        out.unlink()
    subprocess.run([*cmd, str(png), str(out)], check=True)
    return out


def add_ao_to_materials(bpy, png: Path) -> None:
    """Review stills only: EEVEE's Principled BSDF has no AO input, so multiply AO into base colour."""
    img = bpy.data.images.load(str(png), check_existing=False)
    img.colorspace_settings.name = "Non-Color"
    for name in MATS:
        nt = bpy.data.materials[f"{PIECE}-{name}"].node_tree
        bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
        uvn = nt.nodes.new("ShaderNodeUVMap")
        uvn.uv_map = "ao"
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = img
        nt.links.new(uvn.outputs["UV"], tex.inputs["Vector"])
        mul = nt.nodes.new("ShaderNodeMix")
        mul.data_type = "RGBA"
        mul.blend_type = "MULTIPLY"
        mul.inputs["Factor"].default_value = 1.0
        base = bsdf.inputs["Base Color"]
        if base.links:
            nt.links.new(base.links[0].from_socket, mul.inputs["A"])
        else:
            mul.inputs["A"].default_value = base.default_value
        nt.links.new(tex.outputs["Color"], mul.inputs["B"])
        nt.links.new(mul.outputs["Result"], base)


def export_materials(bpy) -> list:
    """Factor-only materials named exactly after the shared sets: the runtime binds by name."""
    out = []
    for name in MATS:
        rgb, rough, metal = EXPORT_FACTORS[name]
        mat = bpy.data.materials.new(name)
        if mat.name != name:
            raise RuntimeError(f"material name {name} is taken ({mat.name})")
        bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Base Color"].default_value = (*(srgb_to_linear(c) for c in rgb), 1.0)
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Metallic"].default_value = metal
        out.append(mat)
    return out


def assign_slots(objs: dict, mats: list) -> None:
    """Swaps slot materials in place; material indices (and so the primitives) are unchanged."""
    for owner in ("body", "leaf-left", "leaf-right"):
        me = objs[owner].data
        for i, mat in enumerate(mats):
            me.materials[i] = mat


# --------------------------------------------------------------------------------------------------
# Export and reimport gate


def export_glb(bpy, objs: dict, sockets: dict, path: Path) -> None:
    keep = [objs["root"], objs["body"], objs["leaf-left"], objs["leaf-right"], *sockets.values()]
    for o in bpy.context.view_layer.objects:
        o.select_set(o in keep)
    bpy.context.view_layer.objects.active = objs["root"]
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        use_active_scene=True,
        export_texcoords=True,
        export_normals=True,
        # No TANGENT: the shared sets upload with flipY = true (PNG via TextureLoader, KTX2 stored
        # bottom-left), so the exporter's flipY = false tangent frame would invert normal-map green.
        # three derives tangents from UV derivatives instead, as on every other surface using the sets.
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="NONE",
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_apply=False,
        export_yup=True,
    )


def read_glb(path: Path):
    import numpy as np

    data = path.read_bytes()
    magic, _version, _length = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67, "not a GLB"
    jlen, _jtype = struct.unpack_from("<II", data, 12)
    gltf = json.loads(data[20 : 20 + jlen])
    blen, _btype = struct.unpack_from("<II", data, 20 + jlen)
    binary = data[28 + jlen : 28 + jlen + blen]

    def accessor(i: int):
        acc = gltf["accessors"][i]
        view = gltf["bufferViews"][acc["bufferView"]]
        dtype = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}[acc["componentType"]]
        ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[acc["type"]]
        start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
        arr = np.frombuffer(binary, dtype=dtype, count=acc["count"] * ncomp, offset=start)
        return arr.reshape(acc["count"], ncomp) if ncomp > 1 else arr

    return gltf, accessor


def quat_mat(q):
    import numpy as np

    x, y, z, w = q
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )


def gate_glb(path: Path) -> dict:
    """Reimport gate on the GLB bytes: node names, budgets, attributes and the unfold contract."""
    import numpy as np

    gltf, accessor = read_glb(path)
    nodes = gltf["nodes"]
    names = [n.get("name") for n in nodes]
    required = {PIECE, "table-body", "leaf-left", "leaf-right", "socket-dice-tray", "socket-draw", "socket-discard", "socket-sigil-plate"}
    errors: list[str] = []
    if set(names) != required:
        errors.append(f"node names {sorted(names)} != {sorted(required)}")
    by = {n.get("name"): (i, n) for i, n in enumerate(nodes)}
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}
    scene_roots = gltf["scenes"][gltf.get("scene", 0)]["nodes"]
    if [names[i] for i in scene_roots] != [PIECE]:
        errors.append(f"scene roots {[names[i] for i in scene_roots]} != [{PIECE}]")

    tris = 0
    prim_report = {}
    density: dict[str, list[float]] = {}
    for name in ("table-body", "leaf-left", "leaf-right"):
        mesh = gltf["meshes"][by[name][1]["mesh"]]
        count = 0
        for prim in mesh["primitives"]:
            attrs = prim["attributes"]
            for need in ("POSITION", "NORMAL", "TEXCOORD_0", "TEXCOORD_1"):
                if need not in attrs:
                    errors.append(f"{name}: missing {need}")
            if "TANGENT" in attrs:
                errors.append(f"{name}: TANGENT exported (see export_glb)")
            for key, idx in attrs.items():
                if gltf["accessors"][idx]["componentType"] != 5126:
                    errors.append(f"{name}: {key} not FLOAT")
            idx = accessor(prim["indices"]).astype(np.int64).reshape(-1, 3)
            count += len(idx)
            # Texel density of the shared set on UV0: one UV unit is one TILE_PX tile.
            pos = accessor(attrs["POSITION"]).astype(float)
            uv0 = accessor(attrs["TEXCOORD_0"]).astype(float)
            a3 = np.linalg.norm(np.cross(pos[idx[:, 1]] - pos[idx[:, 0]], pos[idx[:, 2]] - pos[idx[:, 0]]), axis=1) / 2
            e1, e2 = uv0[idx[:, 1]] - uv0[idx[:, 0]], uv0[idx[:, 2]] - uv0[idx[:, 0]]
            a2 = np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]) / 2
            ok = a3 > 1e-9
            mname = gltf["materials"][prim["material"]]["name"]
            density.setdefault(mname, []).extend((np.sqrt(a2[ok] / a3[ok]) * TILE_PX).tolist())
            uv1 = accessor(attrs["TEXCOORD_1"]).astype(float)
            if uv1.min() < -1e-6 or uv1.max() > 1 + 1e-6:
                errors.append(f"{name}: TEXCOORD_1 outside 0..1")
        tris += count
        prim_report[name] = {"triangles": count, "primitives": len(mesh["primitives"])}
    materials = [m.get("name") for m in gltf.get("materials", [])]
    if tris > 20000:
        errors.append(f"triangles {tris} > 20000")
    if len(materials) > 4:
        errors.append(f"materials {len(materials)} > 4")
    if sorted(materials) != sorted(MATS):
        errors.append(f"materials {materials} != {MATS}")
    density_med = {m: round(float(np.median(v)), 1) for m, v in density.items()}
    for m in MATS[:3]:
        # Box projection compresses slanted faces (lathe flares) by the cosine of their tilt, so the
        # median sits a little under the flat-face value; a wrong unit would be off by 2x or more.
        if not 0.97 * TILE_PX / 0.5 <= density_med.get(m, 0) <= 1.001 * TILE_PX / 0.5:
            errors.append(f"{m}: UV0 density {density_med.get(m)} px/m != {TILE_PX / 0.5}")
    if gltf.get("images") or gltf.get("textures"):
        errors.append("GLB embeds images; the contract is image-free with maps beside it")

    def trs(node):
        t = np.array(node.get("translation", [0, 0, 0]), dtype=float)
        q = node.get("rotation", [0, 0, 0, 1])
        s = np.array(node.get("scale", [1, 1, 1]), dtype=float)
        return t, q, s

    def world(i, override=None):
        """World matrix of node i; override maps node index to a rotation quaternion."""
        m = np.eye(4)
        chain = []
        while True:
            chain.append(i)
            if i not in parent:
                break
            i = parent[i]
        for j in reversed(chain):
            t, q, s = trs(nodes[j])
            if override and j in override:
                q = override[j]
            local = np.eye(4)
            local[:3, :3] = quat_mat(q) * s
            local[:3, 3] = t
            m = m @ local
        return m

    def positions(name, override=None):
        i, node = by[name]
        mesh = gltf["meshes"][node["mesh"]]
        pts = np.concatenate([accessor(p["attributes"]["POSITION"]) for p in mesh["primitives"]]).astype(float)
        m = world(i, override)
        return pts @ m[:3, :3].T + m[:3, 3]

    unfold = {by["leaf-left"][0]: [0, 0, 0, 1], by["leaf-right"][0]: [0, 0, 0, 1]}
    body = positions("table-body")
    checks = {}
    for name, side in (("leaf-left", -1), ("leaf-right", 1)):
        open_pts = positions(name, unfold)
        hinge = np.array(nodes[by[name][0]]["translation"])
        # Unfolded: the leaf's walnut top lies flush with the centre top at TOP.
        tops = open_pts[np.abs(open_pts[:, 1] - TOP) < 0.0005]
        far = open_pts[(side * open_pts[:, 0]) > HINGE_X + 0.05]
        top_ok = len(tops) > 10 and float(np.max(far[:, 1])) <= TOP + LIP + 1e-4
        edge_ok = float(np.min(side * open_pts[:, 0])) >= HINGE_X - 0.0095  # knuckles reach 9 mm inside
        reach = float(np.max(side * open_pts[:, 0]))
        # Folded (rest pose): nothing of the leaf except its hinge knuckles enters the centre band.
        fold_pts = positions(name)
        off_axis = np.hypot(fold_pts[:, 0] - side * HINGE_X, fold_pts[:, 1] - HINGE_Z) > 0.0095 + 1e-4
        inside = (side * fold_pts[:, 0] < HINGE_X - 1e-4) & off_axis
        hang = float(np.min(fold_pts[:, 1]))
        drum_gap = float(np.min(side * fold_pts[off_axis][:, 0])) - GEAR_TIP
        checks[name] = {
            "hinge": [round(float(v), 6) for v in hinge],
            "unfolded_top_flush": bool(top_ok),
            "unfolded_inner_edge_ok": bool(edge_ok),
            "unfolded_reach_m": round(reach, 4),
            "folded_intrusions": int(inside.sum()),
            "folded_lowest_y_m": round(hang, 4),
            "folded_clearance_to_gear_ring_m": round(drum_gap, 4),
        }
        if not top_ok or not edge_ok or inside.sum() or drum_gap < 0.005:
            errors.append(f"{name}: unfold contract failed {checks[name]}")
    if abs(float(body[:, 1].min())) > 1e-5:
        errors.append(f"body base at y={body[:, 1].min()} not 0")
    sockets = {}
    for name in ("socket-dice-tray", "socket-draw", "socket-discard", "socket-sigil-plate"):
        m = world(by[name][0], unfold)
        sockets[name] = [round(float(v), 5) for v in m[:3, 3]]
    return {
        "errors": errors,
        "triangles": tris,
        "primitives": prim_report,
        "materials": materials,
        "uv0_density_px_per_m": density_med,
        "nodes": names,
        "unfold_checks": checks,
        "sockets_unfolded_world": sockets,
        "bounds_unfolded": {
            "min": [round(float(v), 4) for v in np.min(np.concatenate([body, positions("leaf-left", unfold), positions("leaf-right", unfold)]), axis=0)],
            "max": [round(float(v), 4) for v in np.max(np.concatenate([body, positions("leaf-left", unfold), positions("leaf-right", unfold)]), axis=0)],
        },
        "gltf": gltf,
    }


def blender_reimport(bpy, path: Path) -> list[str]:
    scene = bpy.data.scenes.new(f"{PIECE}-reimport")
    window = bpy.context.window
    prev = bpy.context.scene
    if window is not None:
        window.scene = scene
    with bpy.context.temp_override(scene=scene, view_layer=scene.view_layers[0]):
        bpy.ops.import_scene.gltf(filepath=str(path))
        names = sorted(o.name.split(".")[0] for o in scene.objects)
    if window is not None:
        window.scene = prev
    for o in list(scene.objects):
        bpy.data.objects.remove(o)
    bpy.data.scenes.remove(scene)
    return names


def build_manifest(gate: dict, glb: Path, ao_png: Path | None, ao_ktx: Path | None) -> dict:
    tile_m = {name: entry["tileMeters"] for name, entry in json.loads((MATERIAL_DIR / "materials.json").read_text()).items()}
    draw_calls = sum(p["primitives"] for p in gate["primitives"].values())
    gltf = gate["gltf"]
    nodes = gltf["nodes"]
    names = [n.get("name") for n in nodes]
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}

    def local(i):
        n = nodes[i]
        return {
            "parent": names[parent[i]] if i in parent else None,
            "translation": [round(v, 6) for v in n.get("translation", [0, 0, 0])],
            "rotation": [round(v, 6) for v in n.get("rotation", [0, 0, 0, 1])],
            "scale": [round(v, 6) for v in n.get("scale", [1, 1, 1])],
        }

    s = math.sqrt(0.5)
    leaves = {}
    for name, sign in (("leaf-left", 1), ("leaf-right", -1)):
        rest = nodes[names.index(name)].get("rotation", [0, 0, 0, 1])
        leaves[name] = {
            "hinge": local(names.index(name))["translation"],
            "axis": [0, 0, 1],
            "foldedRotation": [round(v, 6) for v in rest],
            "unfoldedRotation": [0, 0, 0, 1],
            "openAngleDeg": FOLD_DEG,
            "note": f"Rest pose is folded: {FOLD_DEG:.0f} degrees about runtime {'+' if sign > 0 else '-'}Z through the hinge, leaf hanging down. Unfold slerps the node rotation to identity.",
        }
        expected = [0.0, 0.0, round(sign * s, 6), round(s, 6)]
        if [round(v, 6) for v in rest] != expected:
            raise RuntimeError(f"{name} rest rotation {rest} != expected folded {expected}")
    t = TRAY
    floor = round(TOP - t["depth"], 4)
    return {
        "piece": PIECE,
        "glb": glb.name,
        "frame": "runtime metres, +Y up, player at +Z looking toward -Z; enemies beyond the table at -Z",
        "origin": "table centre on the floor",
        "authoredTopHeight": TOP,
        "unfoldRoute": "node-transforms",
        "nodes": {names[i]: local(i) for i in range(len(nodes))},
        "leaves": leaves,
        "socketsUnfoldedWorld": gate["sockets_unfolded_world"],
        "sockets": {
            "socket-dice-tray": "felt floor centre of the dice tray, recessed below the top; +Y up",
            "socket-draw": "felt pad centre of the draw slot on leaf-left; card long axis along Z",
            "socket-discard": "felt pad centre of the discard slot on leaf-right; card long axis along Z",
            "socket-sigil-plate": "floating plate centre above the gear medallion; the plate faces +Z (the player)",
        },
        "surface": {
            "topHeight": TOP,
            "ellipseSemiAxesUnfolded": {"x": R[0], "z": R[1]},
            "centreHalfWidth": HINGE_X,
            "rimLipHeight": LIP,
            "rimLipWidth": 0.02,
            "trayInner": {
                "centre": [0.0, floor, round(-t["cy"], 4)],
                "size": [t["inner_w"], t["inner_d"]],
                "floorHeight": floor,
                "wallTopHeight": round(TOP + max(h for _i, h, _m in TRAY_PROFILE), 4),
            },
            "trayFrameWidth": t["frame"],
            "trayRecessDepth": t["depth"],
            "medallion": {"centre": [0.0, round(TOP + MEDALLION["h"], 4), round(-MEDALLION["cy"], 4)], "radius": MEDALLION["tip"]},
        },
        "boundsUnfolded": gate["bounds_unfolded"],
        "budgets": {"triangles": gate["triangles"], "triangleLimit": 20000, "materials": len(gate["materials"]), "materialLimit": 4},
        "materialSlots": {
            name: (
                {
                    "set": None,
                    "factorOnly": False,
                    "maps": {"basecolor": f"{PIECE}.felt.basecolor.png", "normal": f"{PIECE}.felt.normal.png"},
                    "uv0": "tile units (metres / tileMeters): bind the maps at repeat (1, 1)",
                    "tileMeters": FELT_TILE_M,
                    "normalScale": NORMAL_SCALE[name],
                    "sheen": FELT_SHEEN,
                    "note": "ruby velvet: generated nap maps beside the GLB, bound on a sheen material; the GLB's factor-only felt is the fallback",
                    **RUNTIME_LOOK[name],
                }
                if name == "felt"
                else {
                    "set": name,
                    "setManifest": "/assets/materials/materials.json",
                    "uv0": "tile units (metres / tileMeters): bind the set at repeat (1, 1)",
                    "tileMeters": tile_m[name],
                    "normalScale": NORMAL_SCALE[name],
                    **RUNTIME_LOOK[name],
                }
            )
            for name in MATS
        },
        "ao": {
            "png": ao_png.name if ao_png else None,
            "ktx2": ao_ktx.name if ao_ktx else None,
            "uv": 1,
            "channel": 1,
            "flipY": False,
            "colorSpace": "linear",
            "binding": "replaces aoMap on every slot (felt included), read through UV1; the shared ORM still drives roughness and metalness on UV0. Each slot's `contact` also multiplies it into base colour, because three applies aoMap to indirect light only",
        },
        "binder": [
            "Clone each shared material (and its textures) before changing it: loadPbrSet shares textures across consumers that set repeat.",
            "Bind a slot by its exact GLB material name; never by substring.",
            "The GLB has no TANGENT: three derives the tangent frame from UV0 derivatives, matching the shared sets' flipY = true upload.",
            "If the sets or the AO map fail to load, the GLB's factor-only materials stay bound (fallback).",
            "Slot look: `tint` multiplies the bound colour (sRGB hex), `roughnessScale` multiplies the ORM roughness, `envScale` scales the environment radiance whatever envMapIntensity the room sets, `contact` mixes the UV1 AO into base colour.",
        ],
        "drawCalls": {"perEye": draw_calls, "stereo": 2 * draw_calls},
    }


# --------------------------------------------------------------------------------------------------
# Renders (EEVEE)


def setup_render(bpy, scene, w: int = 960, h: int = 720) -> None:
    for engine in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.render.resolution_x = w
    scene.render.resolution_y = h
    scene.render.resolution_percentage = 100
    scene.render.use_stamp_date = False
    scene.render.use_stamp_render_time = False
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "None"
    try:
        scene.eevee.taa_render_samples = 32
    except AttributeError:
        pass


def lights(bpy, scene, tag: str, grazing: bool = False) -> None:
    for o in [o for o in scene.objects if o.get("review_light")]:
        bpy.data.objects.remove(o)
    world = bpy.data.worlds.get(f"{PIECE}-review-world") or bpy.data.worlds.new(f"{PIECE}-review-world")
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    # A warm room-tone world so metals have something to reflect (a dark void reads them black).
    bg.inputs["Color"].default_value = (0.16, 0.11, 0.07, 1.0)
    bg.inputs["Strength"].default_value = 1.0
    scene.world = world
    specs = (
        [("graze", "SUN", (math.radians(84), 0, math.radians(-30)), (0, 0, 0), 4.0, (1, 0.92, 0.8))]
        if grazing
        else [
            ("key", "AREA", None, (-1.4, -1.6, 2.2), 260.0, (1.0, 0.78, 0.5)),
            ("fill", "AREA", None, (1.8, -0.8, 1.4), 70.0, (1.0, 0.85, 0.7)),
            ("rim", "AREA", None, (0.6, 2.0, 1.8), 120.0, (1.0, 0.7, 0.4)),
        ]
    )
    from mathutils import Vector

    for name, kind, rot, loc, energy, color in specs:
        data = bpy.data.lights.new(f"{PIECE}-{tag}-{name}", kind)
        data.energy = energy
        data.color = color
        if kind == "AREA":
            data.size = 1.2
        o = bpy.data.objects.new(data.name, data)
        o["review_light"] = True
        o.location = loc
        if rot is not None:
            o.rotation_euler = rot
        else:
            o.rotation_euler = (Vector((0, 0, 0.6)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(o)


def camera(bpy, scene, name: str, loc, target, lens: float = 40.0):
    from mathutils import Vector

    cam = bpy.data.objects.get(name)
    if cam is None:
        cam = bpy.data.objects.new(name, bpy.data.cameras.new(name))
        scene.collection.objects.link(cam)
    cam.data.lens = lens
    cam.data.clip_start = 0.02
    cam.location = loc
    cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    return cam


def render(bpy, scene, path: Path) -> None:
    bpy.context.view_layer.update()
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True, scene=scene.name)


def scale_reference(bpy, scene) -> list:
    """A 1.6 m pole with 10 cm bands at the player's seat, a 1.2 m seated-eye ball and a seat block."""
    import bmesh

    mats = {}
    for name, rgb in (("ref-light", (0.8, 0.8, 0.78)), ("ref-dark", (0.05, 0.05, 0.05)), ("ref-eye", (0.1, 0.5, 0.9))):
        m = bpy.data.materials.new(name)
        next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = (*rgb, 1)
        mats[name] = m
    objs = []
    for k in range(16):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=16, radius1=0.015, radius2=0.015, depth=0.1)
        me = bpy.data.meshes.new(f"ref-band{k}")
        bm.to_mesh(me)
        bm.free()
        me.materials.append(mats["ref-light" if k % 2 == 0 else "ref-dark"])
        o = bpy.data.objects.new(me.name, me)
        o.location = (0.45, -0.85, 0.05 + 0.1 * k)
        scene.collection.objects.link(o)
        objs.append(o)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=8, radius=0.04)
    me = bpy.data.meshes.new("ref-eye")
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mats["ref-eye"])
    o = bpy.data.objects.new("ref-eye", me)
    o.location = (0.0, -0.85, 1.2)
    scene.collection.objects.link(o)
    objs.append(o)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    me = bpy.data.meshes.new("ref-seat")
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mats["ref-dark"])
    o = bpy.data.objects.new("ref-seat", me)
    o.scale = (0.45, 0.45, 0.45)
    o.location = (0.0, -1.0, 0.225)
    scene.collection.objects.link(o)
    objs.append(o)
    return objs


# --------------------------------------------------------------------------------------------------
# Review sheet (system Python + Pillow)


def compose_sheet(out: Path) -> Path:
    from PIL import Image, ImageDraw

    tiles = [
        ("Approved concept (table-sheet-1)", CONCEPT),
        ("Runtime low, shared sets + baked AO, folded (rest pose)", out / "render-low-folded.png"),
        ("Runtime low, shared sets + baked AO, unfolded", out / "render-low-unfolded.png"),
        ("High source (128 segs, bevels), same camera, no AO", out / "render-high-unfolded.png"),
        ("Runtime low (48 segs), same camera, no AO", out / "render-low-unfolded-cmp.png"),
        ("Grazing light: shared normal maps on the low", out / "render-low-grazing.png"),
        ("Scale: 1.6 m pole (10 cm bands), 1.2 m seated eye", out / "render-scale.png"),
        ("Player view from the seat (eye 1.2 m)", out / "render-player-view.png"),
        # src/combat/table-asset-proof.ts (three.js 0.186.1, AgX, headless Chromium on ANGLE Metal).
        ("In engine (proof page): unfolded", out / "engine-unfolded.jpg"),
        ("In engine (proof page): folded rest pose", out / "engine-folded.jpg"),
        ("In engine (proof page): seated player view", out / "engine-player-view.jpg"),
        ("In engine (proof page): grazing light", out / "engine-grazing.jpg"),
        # The real game page (/?seed=SPIRE002&debug), eye at the seated 1.2 m.
        ("In game: fight, die in the tray, hand and piles", out / "game-fight.jpg"),
        ("In game: unfolding, leaves still hanging", out / "game-folded.jpg"),
    ]
    tw, th, pad, cap = 640, 480, 12, 28
    cols = 2
    rows = math.ceil(len(tiles) / cols)
    sheet = Image.new("RGB", (cols * (tw + pad) + pad, rows * (th + cap + pad) + pad + 40), (28, 24, 22))
    draw = ImageDraw.Draw(sheet)
    draw.text((pad, 12), "P4-T5 combat table - owner review (creative and owner gates pending)", fill=(243, 190, 101))
    for k, (label, path) in enumerate(tiles):
        r, c = divmod(k, cols)
        x, y = pad + c * (tw + pad), 40 + pad + r * (th + cap + pad)
        if path.exists():
            img = Image.open(path).convert("RGB")
            img.thumbnail((tw, th))
            sheet.paste(img, (x + (tw - img.width) // 2, y + cap + (th - img.height) // 2))
        else:
            draw.text((x + 10, y + cap + 10), f"missing: {path.name}", fill=(200, 80, 80))
        draw.text((x, y + 6), label, fill=(222, 193, 106))
    path = out / "combat-table.review-sheet.jpg"
    sheet.save(path, quality=88)
    return path


# --------------------------------------------------------------------------------------------------


def main_blender(args: argparse.Namespace) -> None:
    import bmesh
    import bpy

    t_start = time.monotonic()
    out = args.out.resolve()
    runtime = args.runtime.resolve()
    out.mkdir(parents=True, exist_ok=True)
    runtime.mkdir(parents=True, exist_ok=True)
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    margin_px = 8
    pack_px = 10  # per-island pad, so islands sit 20 px apart (>= 2 x margin + 2)

    felt = felt_maps()
    for role, rgb in felt.items():
        write_png(rgb, runtime / f"{PIECE}.felt.{role}.png")
    make_source_materials(bpy, runtime)
    low_scene = bpy.context.scene
    low_scene.name = f"{PIECE}-low"
    high_scene = bpy.data.scenes.new(f"{PIECE}-high")

    # High source first (its own scene), then the runtime low.
    if bpy.context.window is not None:
        bpy.context.window.scene = high_scene
    with bpy.context.temp_override(scene=high_scene, view_layer=high_scene.view_layers[0]):
        high = build_scene(bpy, bmesh, "high", high_scene)
    tile_uvs(bpy, high)
    if bpy.context.window is not None:
        bpy.context.window.scene = low_scene
    low = build_scene(bpy, bmesh, "low", low_scene)
    meshes = (low["body"], low["leaf-left"], low["leaf-right"])
    tile_uvs(bpy, low)  # UV0, created first
    for o in meshes:
        o.data.uv_layers.new(name="ao")  # UV1
    atlas_uvs(bpy, low, args.size, pack_px)
    tris_low = sum(len(o.data.polygons) for o in meshes)
    tris_high = sum(len(high[o].data.polygons) for o in ("body", "leaf-left", "leaf-right"))
    density = {"uv0_tile": texel_density(low, TILE_PX, "tile"), "uv1_ao": texel_density(low, args.size, "ao")}
    print(f"[{PIECE}] tris low={tris_low} high={tris_high} density px/m={density}")
    assert tris_low <= 20000, tris_low

    report: dict = {
        "piece": PIECE,
        "blender": bpy.app.version_string,
        "generator": "scripts/assets/build-combat-table.py",
        "generator_sha256": sha256(Path(__file__).resolve()),
        "helper_sha256": {"lightmap_helpers.py": sha256(Path(__file__).resolve().parent / "lightmap_helpers.py")},
        "concept": {"file": str(CONCEPT.relative_to(REPO)), "sha256": sha256(CONCEPT), "picked_by": "Paul, 2026-11-15 (docs/art-bible.md)"},
        "source_materials": {
            name: {role: sha256(MATERIAL_DIR / name / f"{name}.{role}.png") for role in ("basecolor", "normal", "orm")} for name in MATS[:3]
        },
        "triangles": {"low": tris_low, "high": tris_high},
        "ao_atlas_size": args.size,
        "felt_maps": {"size": FELT_PX, "seed": 1715, "tile_m": FELT_TILE_M, "files": [f"{PIECE}.felt.basecolor.png", f"{PIECE}.felt.normal.png"]},
        "texel_density_px_per_m": density,
        "authoringAgent": "Claude Code subagent (claude-opus-5-5), dispatched by the rogue-xr primary session",
    }

    ao_png = runtime / f"{PIECE}.ao.png"
    if not args.skip_bake:
        baked = bake_ao(bpy, low, args.size, args.samples, args.device, margin_px)
        report["bake"] = baked["report"]
        write_png(baked["ao"], ao_png)
    if not ao_png.exists():
        ao_png = None

    # Runtime export: factor-only slot materials, folded rest pose, UV0 tile + UV1 AO atlas.
    source_mats = [bpy.data.materials[f"{PIECE}-{m}"] for m in MATS]
    assign_slots(low, export_materials(bpy))
    for o in meshes:
        o.data.uv_layers["tile"].active = True
        o.data.uv_layers["tile"].active_render = True
    fold(low, unfolded=False)
    sockets = add_sockets(bpy, low)
    bpy.context.view_layer.update()
    glb = runtime / f"{PIECE}.glb"
    export_glb(bpy, low, sockets, glb)
    gate = gate_glb(glb)
    report["reimport"] = {k: v for k, v in gate.items() if k != "gltf"}
    report["reimport"]["blender_objects"] = blender_reimport(bpy, glb)
    if gate["errors"]:
        (out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        raise RuntimeError(f"GLB gate failed: {gate['errors']}")

    ao_ktx = encode_ktx2(ao_png) if ao_png and KTX.exists() else None
    if ao_ktx is None and (runtime / f"{PIECE}.ao.ktx2").exists():
        (runtime / f"{PIECE}.ao.ktx2").unlink()  # never ship a KTX2 that no longer matches the PNG
    manifest = build_manifest(gate, glb, ao_png, ao_ktx)
    (runtime / f"{PIECE}.manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    # Editable sources: high and low scenes as separate .blend files, with the tile materials bound.
    assign_slots(low, source_mats)
    for scene_obj, tag in ((high_scene, "high"), (low_scene, "low")):
        bpy.data.libraries.write(str(out / f"{PIECE}.{tag}.blend"), {scene_obj}, path_remap="RELATIVE_ALL", compress=True)

    if not args.skip_renders:
        for scene_obj in (low_scene, high_scene):
            setup_render(bpy, scene_obj)
            lights(bpy, scene_obj, scene_obj.name)
        t0 = time.monotonic()
        # Geometry comparison first: both builds under the same tile materials, no baked AO.
        fold(low, unfolded=True)
        fold(high, unfolded=True)
        cmp_loc, cmp_target = (0.0, -1.25, 1.35), (0.0, 0.0, 0.70)
        camera(bpy, low_scene, "cam-cmp", cmp_loc, cmp_target, 35.0)
        render(bpy, low_scene, out / "render-low-unfolded-cmp.png")
        camera(bpy, high_scene, "cam-cmp-high", cmp_loc, cmp_target, 35.0)
        render(bpy, high_scene, out / "render-high-unfolded.png")
        if ao_png:
            add_ao_to_materials(bpy, ao_png)
        ref_target = (0.0, 0.0, 0.62)
        fold(low, unfolded=False)
        camera(bpy, low_scene, "cam-34", (1.35, -1.75, 1.45), ref_target)
        render(bpy, low_scene, out / "render-low-folded.png")
        fold(low, unfolded=True)
        render(bpy, low_scene, out / "render-low-unfolded.png")
        camera(bpy, low_scene, "cam-player", (0.0, -0.85, 1.2), (0.0, 0.4, 0.6), 22.0)
        render(bpy, low_scene, out / "render-player-view.png")
        lights(bpy, low_scene, "graze", grazing=True)
        camera(bpy, low_scene, "cam-graze", (0.25, -0.75, 1.05), (0.0, -0.1, 0.75), 35.0)
        render(bpy, low_scene, out / "render-low-grazing.png")
        lights(bpy, low_scene, "scale")
        refs = scale_reference(bpy, low_scene)
        camera(bpy, low_scene, "cam-scale", (2.6, -1.6, 1.0), (0.0, -0.3, 0.75), 35.0)
        render(bpy, low_scene, out / "render-scale.png")
        for o in refs:
            bpy.data.objects.remove(o)
        report["render_seconds"] = round(time.monotonic() - t0, 1)

    report["files"] = {
        str(p.relative_to(REPO)): sha256(p)
        for p in sorted([*runtime.iterdir(), *out.iterdir()])
        if p.is_file() and p.suffix in {".glb", ".png", ".ktx2", ".json", ".blend"} and p.name != "report.json"
    }
    report["total_seconds"] = round(time.monotonic() - t_start, 1)
    (out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: report[k] for k in ("triangles", "texel_density_px_per_m")}, indent=2))
    print(json.dumps(report["reimport"], indent=2))


if __name__ == "__main__":
    ARGS = parse_args()
    if ARGS.sheet:
        print(compose_sheet(ARGS.out.resolve()))
    else:
        main_blender(ARGS)
