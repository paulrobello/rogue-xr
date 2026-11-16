"""P4-T6 Cog Sentry: the first rigged automaton. A slender brass automaton (docs/art-bible.md,
concept assets-source/concepts/sentry-sheet-1.png) built procedurally as rigid plated segments,
each weighted 1.0 to one bone of a 21-bone armature, with five clips: idle (loop), attack, hit,
death (one-shot, ends lying on the floor) and frozen (the held "frozen mid-step" pose of the time
freeze). Exported as an image-free skinned GLB whose brass slots are named after the approved
P4-T3 tileable sets (`public/assets/materials/`), so the runtime binds them by name, like the
combat table. UV0 is in tile units (metres / tileMeters).

Blender run (build, pose checks, export, reimport gate, manifest, renders, .blend sources):
    "$BLENDER" -b --factory-startup --python-exit-code 1 -P scripts/assets/build-cog-sentry.py -- \
        [--out assets-source/enemies/cog-sentry/staging] [--runtime public/assets/enemies/cog-sentry] \
        [--blend-dir assets-source/enemies/cog-sentry/blend] [--skip-renders]
Review sheet (system Python with Pillow, after the Blender run and the engine shots):
    python3 -I scripts/assets/build-cog-sentry.py --sheet [--out ...]

Frame: Blender is Z-up; runtime (x, y, z) = Blender (x, z, -y). The sentry faces Blender +Y, which
is runtime -Z: src/combat/encounter.ts sets rotation.y = -heading, which turns local -Z onto the
heading (sin h, -cos h) that src/combat/placement.ts gives an enemy facing the player. The root
sits at the feet (runtime y = 0). Anatomical right is Blender +X (the sentry's own right hand).
Root motion is code-owned: the `root` joint is never animated and every clip plays in place.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import struct
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PIECE = "cog-sentry"
DEFAULT_OUT = REPO / "assets-source/enemies/cog-sentry/staging"
DEFAULT_RUNTIME = REPO / "public/assets/enemies/cog-sentry"
DEFAULT_BLEND = REPO / "assets-source/enemies/cog-sentry/blend"
MATERIAL_DIR = REPO / "public/assets/materials"
CONCEPT = REPO / "assets-source/concepts/sentry-sheet-1.png"
FPS = 30

LIMITS = {"tris": 25_000, "materials": 4, "bones": 40, "influences": 4}
# Material slots in index order. The brass slots bind the shared sets by name at runtime.
MATS = ["brass-polished", "brass-aged", "gunmetal", "sentry-glow"]
BP, BA, GM, GL = range(4)
TILE_METERS = 0.5  # both brass sets tile at 0.5 m (public/assets/materials/materials.json)
NORMAL_SCALE = {"brass-polished": 0.35, "brass-aged": 0.35}  # as on the combat table's narrow rims
# Factor-only GLB materials (sRGB, roughness, metallic): the fallback look when the sets fail to load.
EXPORT_FACTORS = {
    "brass-polished": ((0xDE, 0xC1, 0x6A), 0.3, 1.0),
    "brass-aged": ((0xA8, 0x86, 0x48), 0.45, 1.0),
    "gunmetal": ((0x2E, 0x2A, 0x2A), 0.5, 0.85),
    "sentry-glow": ((0x6A, 0x34, 0x0C), 0.4, 0.0),  # dark amber glass: the emission carries the colour
}
GLOW_SRGB = (0xF0, 0x8C, 0x2C)  # emission: deeper than candle amber #F3BE65, which AgX renders as pale cream
GLOW_STRENGTH = 0.7  # higher values wash the core to cream or white under AgX tone mapping

# Armature: name, parent, head, tail (Blender metres). R is Blender +X.
BONES: list[tuple[str, str | None, tuple, tuple]] = [
    ("root", None, (0, 0, 0), (0, 0, 0.25)),
    ("hips", "root", (0, 0, 0.98), (0, 0, 1.10)),
    ("spine", "hips", (0, 0, 1.10), (0, 0, 1.30)),
    ("chest", "spine", (0, 0, 1.30), (0, 0, 1.58)),
    ("neck", "chest", (0, 0, 1.58), (0, 0, 1.70)),
    ("head", "neck", (0, 0, 1.70), (0, 0, 1.96)),
    ("cog", "chest", (0, -0.13, 1.44), (0, -0.23, 1.44)),
]
for _s, _n in ((1, "R"), (-1, "L")):
    BONES += [
        (f"clavicle.{_n}", "chest", (_s * 0.05, 0, 1.53), (_s * 0.23, 0, 1.53)),
        (f"upperarm.{_n}", f"clavicle.{_n}", (_s * 0.25, 0, 1.51), (_s * 0.27, 0, 1.20)),
        (f"forearm.{_n}", f"upperarm.{_n}", (_s * 0.27, 0, 1.20), (_s * 0.29, 0.02, 0.90)),
        (f"hand.{_n}", f"forearm.{_n}", (_s * 0.29, 0.02, 0.90), (_s * 0.30, 0.03, 0.74)),
        (f"thigh.{_n}", "hips", (_s * 0.11, 0, 1.00), (_s * 0.12, 0, 0.56)),
        (f"shin.{_n}", f"thigh.{_n}", (_s * 0.12, 0, 0.56), (_s * 0.12, 0, 0.11)),
        (f"foot.{_n}", f"shin.{_n}", (_s * 0.12, 0, 0.11), (_s * 0.12, 0.15, 0.03)),
    ]
BONE_NAMES = [b[0] for b in BONES]
THIGH, SHIN = 0.44, 0.45  # leg segment lengths for the planar leg solve
HIP_Z, ANKLE_Z = 1.00, 0.11

# Clips: name -> duration (s), loop mode, gameplay events (s).
CLIPS = {
    "idle": {"duration": 2.0, "loop": "repeat", "events": {}},
    "attack": {"duration": 1.2, "loop": "once", "events": {"impact": 0.55}},
    "hit": {"duration": 0.6, "loop": "once", "events": {}},
    "death": {"duration": 2.0, "loop": "once", "events": {"down": 1.5}},
    "frozen": {"duration": 1.0, "loop": "repeat", "events": {}},
}

DETAIL = {"low": {"sides": 10, "sphere": (12, 6), "gear": 1}, "high": {"sides": 24, "sphere": (24, 14), "gear": 3}}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_args() -> argparse.Namespace:
    in_blender = "-P" in sys.argv or "--python" in sys.argv
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else ([] if in_blender else sys.argv[1:])
    p = argparse.ArgumentParser()
    p.add_argument("--out", type=Path, default=DEFAULT_OUT)
    p.add_argument("--runtime", type=Path, default=DEFAULT_RUNTIME)
    p.add_argument("--blend-dir", type=Path, default=DEFAULT_BLEND)
    p.add_argument("--skip-renders", action="store_true")
    p.add_argument("--sheet", action="store_true", help="compose the review sheet (system Python)")
    return p.parse_args(argv)


def srgb_to_linear(c: float) -> float:
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


# --------------------------------------------------------------------------------------------------
# Geometry: rigid parts, each on one bone


class Builder:
    def __init__(self, bmesh, detail: str):
        self.bmesh = bmesh
        self.bm = bmesh.new()
        self.deform = self.bm.verts.layers.deform.verify()
        self.d = DETAIL[detail]

    def _finish(self, verts, faces, mat: int, bone: str, smooth: bool) -> None:
        gi = BONE_NAMES.index(bone)
        for v in verts:
            v[self.deform][gi] = 1.0
        for f in faces:
            f.material_index = mat
            f.smooth = smooth

    def loft(self, rings: list[list[tuple[float, float]]], zs: list[float], m, mat: int, bone: str, smooth=False, caps=True) -> None:
        """Rings of 2D points (same count) at local heights zs, transformed by matrix m."""
        from mathutils import Vector

        bm = self.bm
        vrings = [[bm.verts.new(m @ Vector((x, y, z))) for x, y in ring] for ring, z in zip(rings, zs)]
        faces = []
        n = len(rings[0])
        for a, b in zip(vrings, vrings[1:]):
            for i in range(n):
                j = (i + 1) % n
                faces.append(bm.faces.new((a[i], a[j], b[j], b[i])))
        if caps:
            faces.append(bm.faces.new(list(reversed(vrings[0]))))
            faces.append(bm.faces.new(vrings[-1]))
        self._finish([v for r in vrings for v in r], faces, mat, bone, smooth)

    def segment(self, p0, p1, r0: float, r1: float, mat: int, bone: str, sides: int | None = None, sx=1.0, sy=1.0, smooth=False, phase=0.0) -> None:
        """Frustum from p0 to p1 with elliptical section (radius r * (sx, sy) in the local frame)."""
        from mathutils import Vector

        a, b = Vector(p0), Vector(p1)
        axis = b - a
        n = sides or self.d["sides"]
        rot = axis.to_track_quat("Z", "Y").to_matrix().to_4x4()
        # Keep the section's local X on world X so sx / sy mean width / depth on vertical parts.
        m = __import__("mathutils").Matrix.Translation(a) @ rot
        ring = lambda r: [(r * sx * math.cos(2 * math.pi * i / n + phase), r * sy * math.sin(2 * math.pi * i / n + phase)) for i in range(n)]  # noqa: E731
        self.loft([ring(r0), ring(r1)], [0.0, axis.length], m, mat, bone, smooth)

    def box(self, c, size, mat: int, bone: str, taper=1.0) -> None:
        from mathutils import Matrix

        hx, hy, hz = (s / 2 for s in size)
        bottom = [(-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)]
        top = [(x * taper, y * taper) for x, y in bottom]
        self.loft([bottom, top], [-hz, hz], Matrix.Translation(c), mat, bone)

    def sphere(self, c, r: float, mat: int, bone: str, scale=(1.0, 1.0, 1.0)) -> None:
        from mathutils import Matrix

        u, v = self.d["sphere"]
        m = Matrix.Translation(c) @ Matrix.Diagonal((r * scale[0], r * scale[1], r * scale[2], 1.0))
        res = self.bmesh.ops.create_uvsphere(self.bm, u_segments=u, v_segments=v, radius=1.0, matrix=m)
        verts = res["verts"]
        faces = list({f for v_ in verts for f in v_.link_faces})
        self._finish(verts, faces, mat, bone, smooth=True)

    def gear(self, c, normal_axis: str, r_root: float, r_tip: float, teeth: int, depth: float, mat: int, bone: str) -> None:
        """Toothed disc; normal along Blender -Y ('-Y') or +Y."""
        from mathutils import Matrix, Vector

        k = self.d["gear"]
        pts = []
        for t in range(teeth):
            for s in range(4 * k):
                u = (t + s / (4 * k)) / teeth
                phase = s / (4 * k)
                r = r_tip if 0.1 < phase < 0.5 else r_root
                pts.append((r * math.cos(2 * math.pi * u), r * math.sin(2 * math.pi * u)))
        rot = Vector((0, -1 if normal_axis == "-Y" else 1, 0)).to_track_quat("Z", "X").to_matrix().to_4x4()
        self.loft([pts, pts], [0.0, depth], Matrix.Translation(c) @ rot, mat, bone)

    def hexplate(self, c, normal_axis: str, r: float, depth: float, mat: int, bone: str, sides=6) -> None:
        from mathutils import Matrix, Vector

        pts = [(r * math.cos(2 * math.pi * i / sides + math.pi / 2), r * math.sin(2 * math.pi * i / sides + math.pi / 2)) for i in range(sides)]
        rot = Vector((0, 1 if normal_axis == "+Y" else -1, 0)).to_track_quat("Z", "X").to_matrix().to_4x4()
        self.loft([pts, pts], [0.0, depth], Matrix.Translation(c) @ rot, mat, bone)


def build_parts(b: Builder) -> None:
    S = b.segment
    # Head: a narrow, tall brass helm with a darker face plate and two amber eye slits.
    S((0, 0.0, 1.70), (0, 0.0, 1.90), 0.064, 0.072, BP, "head", sx=0.9, sy=1.25)
    b.sphere((0, 0.0, 1.90), 0.072, BP, "head", (0.9, 1.25, 0.85))
    S((0, 0.055, 1.72), (0, 0.06, 1.88), 0.035, 0.045, BA, "head", sides=6, sx=1.25, sy=0.9)
    for s in (1, -1):
        b.box((s * 0.03, 0.098, 1.835), (0.034, 0.012, 0.011), GL, "head")
    S((0, 0.02, 1.695), (0, 0.035, 1.72), 0.03, 0.04, GM, "head", sides=6)  # jaw
    # Neck: gunmetal column with brass collar rings.
    S((0, 0, 1.56), (0, 0, 1.71), 0.028, 0.026, GM, "neck")
    S((0, 0, 1.62), (0, 0, 1.635), 0.042, 0.042, BA, "neck")
    # Chest: tapered cuirass, hexagonal amber core in a brass-aged bezel, shoulder yoke, back cog.
    S((0, 0, 1.30), (0, 0, 1.58), 0.165, 0.225, BP, "chest", sx=1.0, sy=0.62)
    b.hexplate((0, 0.098, 1.43), "+Y", 0.072, 0.03, BA, "chest")
    b.hexplate((0, 0.118, 1.43), "+Y", 0.048, 0.022, GL, "chest")
    b.box((0, 0, 1.585), (0.42, 0.16, 0.035), BA, "chest", taper=0.85)
    b.box((0, -0.11, 1.44), (0.22, 0.04, 0.2), BA, "chest", taper=0.9)  # back plate behind the cog
    b.gear((0, -0.13, 1.44), "-Y", 0.075, 0.092, 12, 0.025, BA, "cog")
    S((0, -0.13, 1.44), (0, -0.165, 1.44), 0.03, 0.022, GM, "cog", sides=6)  # hub
    # Spine: gunmetal column with three narrow abdominal bands.
    S((0, 0, 1.06), (0, 0, 1.34), 0.065, 0.07, GM, "spine")
    for z in (1.15, 1.205, 1.26):
        S((0, 0, z), (0, 0, z + 0.035), 0.125, 0.13, BA, "spine", sx=1.0, sy=0.62)
    # Hips: pelvis plate and a front tasset.
    S((0, 0, 0.93), (0, 0, 1.10), 0.12, 0.16, BP, "hips", sx=1.0, sy=0.65)
    b.box((0, 0.085, 0.95), (0.12, 0.03, 0.12), BA, "hips", taper=0.8)
    for s, n in ((1, "R"), (-1, "L")):
        # Shoulder: gunmetal ball under a brass pauldron.
        b.sphere((s * 0.245, 0, 1.51), 0.052, GM, f"upperarm.{n}")
        b.sphere((s * 0.26, 0, 1.545), 0.098, BP, f"clavicle.{n}", (1.0, 0.95, 0.75))
        # Arm: brass sleeves over gunmetal rods, ball joints, a three-finger gunmetal claw.
        S((s * 0.25, 0, 1.50), (s * 0.27, 0, 1.22), 0.02, 0.02, GM, f"upperarm.{n}", sides=6)
        S((s * 0.252, 0, 1.46), (s * 0.266, 0, 1.25), 0.05, 0.04, BP, f"upperarm.{n}")
        b.sphere((s * 0.27, 0, 1.20), 0.038, GM, f"forearm.{n}")
        S((s * 0.272, 0.002, 1.17), (s * 0.288, 0.018, 0.93), 0.05, 0.034, BP, f"forearm.{n}")
        b.sphere((s * 0.29, 0.02, 0.90), 0.027, GM, f"hand.{n}")
        b.box((s * 0.293, 0.025, 0.845), (0.03, 0.065, 0.08), BA, f"hand.{n}", taper=0.9)
        for k, dy in enumerate((-0.022, 0.0, 0.022)):
            tip = 0.75 if k == 1 else 0.765
            S((s * 0.295, 0.025 + dy, 0.81), (s * 0.30, 0.03 + dy * 1.2, tip), 0.009, 0.006, GM, f"hand.{n}", sides=5)
        # Leg: hip ball, thigh plate, knee ball and cap, greave, ankle ball, sabaton.
        b.sphere((s * 0.11, 0, 1.0), 0.058, GM, f"thigh.{n}")
        S((s * 0.11, 0, 0.97), (s * 0.12, 0, 0.61), 0.085, 0.064, BP, f"thigh.{n}", sx=1.0, sy=1.1)
        b.sphere((s * 0.12, 0, 0.56), 0.05, GM, f"shin.{n}")
        b.box((s * 0.12, 0.05, 0.575), (0.07, 0.03, 0.08), BA, f"shin.{n}", taper=0.8)
        S((s * 0.12, 0, 0.52), (s * 0.12, 0, 0.15), 0.066, 0.044, BP, f"shin.{n}", sx=1.0, sy=1.15)
        b.sphere((s * 0.12, 0, 0.11), 0.034, GM, f"foot.{n}")
        b.box((s * 0.12, 0.035, 0.035), (0.085, 0.2, 0.07), BA, f"foot.{n}", taper=0.85)
        b.box((s * 0.12, 0.155, 0.0225), (0.07, 0.05, 0.045), BP, f"foot.{n}", taper=0.8)


def tile_uvs(bm) -> None:
    """UV0 in tile units: each face projected onto the plane of its dominant normal axis."""
    uv = bm.loops.layers.uv.new("tile")
    for f in bm.faces:
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        u_i, v_i = [(1, 2), (0, 2), (0, 1)][ax]
        for loop in f.loops:
            co = loop.vert.co
            loop[uv].uv = (co[u_i] / TILE_METERS, co[v_i] / TILE_METERS)


def build_body(bpy, bmesh, scene, detail: str, arm_obj) -> object:
    b = Builder(bmesh, detail)
    build_parts(b)
    # Triangulate here with fixed rules: the exporter's own quad split follows the shorter
    # diagonal of the evaluated mesh, which flips between runs on float noise (GLB not byte-stable).
    bmesh.ops.triangulate(b.bm, faces=b.bm.faces[:], quad_method="FIXED", ngon_method="EAR_CLIP")
    b.bm.normal_update()
    tile_uvs(b.bm)
    me = bpy.data.meshes.new(f"sentry-body-{detail}")
    b.bm.to_mesh(me)
    b.bm.free()
    obj = bpy.data.objects.new("sentry-body" if detail == "low" else f"sentry-body-{detail}", me)
    scene.collection.objects.link(obj)
    for name in BONE_NAMES:
        obj.vertex_groups.new(name=name)
    obj.parent = arm_obj
    mod = obj.modifiers.new("armature", "ARMATURE")
    mod.object = arm_obj
    return obj


def build_armature(bpy, scene, name: str):
    arm = bpy.data.armatures.new(f"{name}-rig")
    obj = bpy.data.objects.new(name, arm)
    scene.collection.objects.link(obj)
    with bpy.context.temp_override(scene=scene, view_layer=scene.view_layers[0], active_object=obj, object=obj):
        scene.view_layers[0].objects.active = obj
        bpy.ops.object.mode_set(mode="EDIT")
        for bname, parent, head, tail in BONES:
            eb = arm.edit_bones.new(bname)
            eb.head, eb.tail, eb.roll = head, tail, 0.0
            if parent:
                eb.parent = arm.edit_bones[parent]
                eb.use_connect = False
        bpy.ops.object.mode_set(mode="OBJECT")
    for pb in obj.pose.bones:
        pb.rotation_mode = "QUATERNION"
    return obj


# --------------------------------------------------------------------------------------------------
# Poses and clips. Rotations are degrees about the rest (armature) axes: +X is the sentry's right,
# so +X on a hanging limb swings it forward and on the spine tips it backward; +Z turns the sentry
# toward its left. `hips` carries an armature-space offset; `ik` plants the ankles (Blender y, z).


def leg_solve(hips_loc, hips_rx: float, ankle) -> tuple[float, float, float]:
    """Planar two-bone solve in the sagittal plane: thigh, shin, foot local X rotations (degrees)."""
    a = math.radians(hips_rx)
    hy0, hz0 = 0.0, HIP_Z - 0.98  # thigh head relative to the hips head
    hy = hips_loc[1] + hy0 * math.cos(a) - hz0 * math.sin(a)
    hz = 0.98 + hips_loc[2] + hy0 * math.sin(a) + hz0 * math.cos(a)
    dy, dz = ankle[0] - hy, ankle[1] - hz
    dist = min(math.hypot(dy, dz), THIGH + SHIN - 1e-4)
    phi = math.atan2(dy, -dz)
    a1 = math.acos(max(-1.0, min(1.0, (THIGH**2 + dist**2 - SHIN**2) / (2 * THIGH * dist))))
    t1 = phi + a1  # knee forward
    ky, kz = hy + THIGH * math.sin(t1), hz - THIGH * math.cos(t1)
    t2 = math.atan2(ankle[0] - ky, -(ankle[1] - kz))
    return math.degrees(t1) - hips_rx, math.degrees(t2 - t1), -math.degrees(t2)


def resolve(pose: dict) -> dict:
    out = {k: v for k, v in pose.items() if k not in ("ik",)}
    hips = pose.get("hips_loc", (0, 0, 0))
    hrx = pose.get("hips", (0, 0, 0))[0]
    for side, ankle in pose.get("ik", {}).items():
        t, s, f = leg_solve(hips, hrx, ankle)
        out[f"thigh.{side}"] = (t, *out.get(f"thigh.{side}", (0, 0, 0))[1:])
        out[f"shin.{side}"] = (s, 0, 0)
        out[f"foot.{side}"] = (f, 0, 0)
    return out


PLANT = {"R": (0.0, ANKLE_Z), "L": (0.0, ANKLE_Z)}
REST: dict = {"ik": PLANT}


def idle_pose(t: float) -> dict:
    w = 2 * math.pi * t / CLIPS["idle"]["duration"]
    breathe = math.sin(w)
    return {
        "spine": (1.5 * breathe, 0, 0),
        "chest": (-1.5 * breathe, 0, 1.5 * math.sin(w)),
        "head": (2.0 * math.sin(2 * w), 0, 9.0 * math.sin(w)),
        "upperarm.R": (3 * breathe, -5, 0), "upperarm.L": (-3 * breathe, 5, 0),
        "forearm.R": (8 + 3 * breathe, 0, 0), "forearm.L": (8 - 3 * breathe, 0, 0),
        "cog": (0, -60.0 * t / CLIPS["idle"]["duration"], 0),
        "ik": PLANT,
    }


ATTACK_KEYS = [
    (0.0, {"forearm.R": (8, 0, 0), "forearm.L": (8, 0, 0), "ik": PLANT}),
    (0.35, {"hips_loc": (0, -0.04, -0.06), "spine": (6, 0, -10), "chest": (4, 0, -18), "head": (-6, 0, 24),
            "upperarm.R": (-35, 0, -10), "forearm.R": (85, 0, 0), "hand.R": (20, 0, 0),
            "upperarm.L": (25, 0, 8), "forearm.L": (30, 0, 0), "ik": PLANT}),
    (0.55, {"hips_loc": (0, 0.12, -0.10), "spine": (-14, 0, 12), "chest": (-6, 0, 16), "head": (14, 0, -24),
            "upperarm.R": (92, 0, 6), "forearm.R": (4, 0, 0), "hand.R": (-6, 0, 0),
            "upperarm.L": (-35, 0, 10), "forearm.L": (25, 0, 0), "ik": PLANT}),
    (0.75, {"hips_loc": (0, 0.10, -0.09), "spine": (-12, 0, 10), "chest": (-5, 0, 14), "head": (12, 0, -20),
            "upperarm.R": (86, 0, 6), "forearm.R": (10, 0, 0), "hand.R": (-4, 0, 0),
            "upperarm.L": (-30, 0, 10), "forearm.L": (25, 0, 0), "ik": PLANT}),
    (1.2, {"forearm.R": (8, 0, 0), "forearm.L": (8, 0, 0), "ik": PLANT}),
]
HIT_KEYS = [
    (0.0, {"forearm.R": (8, 0, 0), "forearm.L": (8, 0, 0), "ik": PLANT}),
    (0.1, {"hips_loc": (0, -0.05, -0.03), "spine": (12, 0, 4), "chest": (9, 0, 6), "head": (18, 0, -8), "cog": (0, 0, 0),
           "upperarm.R": (-22, 0, -14), "upperarm.L": (-18, 0, 16), "forearm.R": (35, 0, 0), "forearm.L": (40, 0, 0), "ik": PLANT}),
    (0.28, {"hips_loc": (0, -0.02, -0.015), "spine": (4, 0, 1), "chest": (3, 0, 2), "head": (5, 0, -2),
            "upperarm.R": (-6, 0, -4), "upperarm.L": (-5, 0, 4), "forearm.R": (18, 0, 0), "forearm.L": (20, 0, 0), "ik": PLANT}),
    (0.6, {"forearm.R": (8, 0, 0), "forearm.L": (8, 0, 0), "ik": PLANT}),
]
DEATH_LIE = {"hips_loc": (0, -0.30, -0.844), "hips": (88, 0, 4), "spine": (-4, 0, 0), "chest": (-4, 0, 0), "head": (-18, 0, 20),
             "upperarm.R": (10, -38, 0), "upperarm.L": (6, 34, 0), "forearm.R": (20, 0, 0), "forearm.L": (12, 0, 0),
             "hand.R": (10, 0, 0), "hand.L": (10, 0, 0),
             "thigh.R": (8, 0, 4), "shin.R": (-16, 0, 0), "foot.R": (-10, 0, 0),
             "thigh.L": (14, 0, -6), "shin.L": (-26, 0, 0), "foot.L": (-6, 0, 0)}
DEATH_KEYS = [
    (0.0, {"forearm.R": (8, 0, 0), "forearm.L": (8, 0, 0), "ik": PLANT}),
    (0.15, {"hips_loc": (0, -0.04, -0.02), "spine": (10, 0, 3), "chest": (8, 0, 4), "head": (16, 0, -6),
            "upperarm.R": (-18, 0, -12), "upperarm.L": (-14, 0, 12), "forearm.R": (30, 0, 0), "forearm.L": (34, 0, 0), "ik": PLANT}),
    (0.7, {"hips_loc": (0, 0.02, -0.36), "spine": (-16, 0, 4), "chest": (-10, 0, 2), "head": (-24, 0, 8),
           "upperarm.R": (4, -6, 0), "upperarm.L": (2, 6, 0), "forearm.R": (12, 0, 0), "forearm.L": (10, 0, 0), "ik": PLANT}),
    (1.0, {"hips_loc": (0, -0.08, -0.52), "hips": (30, 0, 2), "spine": (-6, 0, 2), "chest": (-4, 0, 0), "head": (-10, 0, 10),
           "upperarm.R": (12, -16, 0), "upperarm.L": (8, 14, 0), "forearm.R": (16, 0, 0), "forearm.L": (12, 0, 0),
           "thigh.R": (60, 0, 0), "shin.R": (-110, 0, 0), "foot.R": (20, 0, 0),
           "thigh.L": (60, 0, 0), "shin.L": (-110, 0, 0), "foot.L": (20, 0, 0)}),
    (1.5, DEATH_LIE),
    (1.65, {**DEATH_LIE, "hips_loc": (0, -0.30, -0.815), "head": (-12, 0, 18)}),
    (2.0, DEATH_LIE),
]
FROZEN_POSE = {"hips_loc": (0, 0.0, -0.045), "spine": (-4, 0, -4), "chest": (-2, 0, -4), "head": (6, 0, 10),
               "upperarm.R": (-18, 0, -6), "forearm.R": (24, 0, 0), "upperarm.L": (24, 0, 6), "forearm.L": (38, 0, 0),
               "hand.L": (-10, 0, 0), "ik": {"L": (0.2, ANKLE_Z + 0.015), "R": (-0.17, ANKLE_Z)}}


def clip_keys(name: str) -> list[tuple[float, dict]]:
    if name == "idle":
        return [(t / 4, idle_pose(t / 4)) for t in range(9)]
    if name == "frozen":
        return [(0.0, FROZEN_POSE), (CLIPS["frozen"]["duration"], FROZEN_POSE)]
    return {"attack": ATTACK_KEYS, "hit": HIT_KEYS, "death": DEATH_KEYS}[name]


def apply_pose(arm_obj, pose: dict, frame: float | None) -> None:
    from mathutils import Euler, Vector

    pose = resolve(pose)
    for pb in arm_obj.pose.bones:
        if pb.name == "root":
            continue
        r = pb.bone.matrix_local.to_quaternion()
        rx, ry, rz = pose.get(pb.name, (0, 0, 0))
        q = Euler((math.radians(rx), math.radians(ry), math.radians(rz)), "XYZ").to_quaternion()
        pb.rotation_quaternion = r.inverted() @ q @ r
        if frame is not None:
            pb.keyframe_insert("rotation_quaternion", frame=frame)
        if pb.name == "hips":
            pb.location = r.inverted() @ Vector(pose.get("hips_loc", (0, 0, 0)))
            if frame is not None:
                pb.keyframe_insert("location", frame=frame)


def clear_pose(arm_obj) -> None:
    for pb in arm_obj.pose.bones:
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)


def author_clips(bpy, arm_obj) -> dict:
    arm_obj.animation_data_create()
    actions = {}
    edit = bpy.context.preferences.edit
    for name in CLIPS:
        act = bpy.data.actions.new(name)
        act.use_fake_user = True
        arm_obj.animation_data.action = act
        # Idle is sampled densely from a periodic function; its cog spin must not ease.
        edit.keyframe_new_interpolation_type = "LINEAR" if name == "idle" else "BEZIER"
        for t, pose in clip_keys(name):
            apply_pose(arm_obj, pose, round(t * FPS))
        actions[name] = act
    edit.keyframe_new_interpolation_type = "BEZIER"
    arm_obj.animation_data.action = None
    clear_pose(arm_obj)
    return actions


def evaluated_min_z(bpy, body) -> float:
    import numpy as np

    dg = bpy.context.evaluated_depsgraph_get()
    ev = body.evaluated_get(dg)
    me = ev.to_mesh()
    co = np.empty(len(me.vertices) * 3, dtype=np.float64)
    me.vertices.foreach_get("co", co)
    ev.to_mesh_clear()
    return float(co.reshape(-1, 3)[:, 2].min()) + body.matrix_world.translation.z


def ground_clamp(bpy, scene, arm_obj, body, act, floor: float = 0.004) -> list:
    """Death falls through the floor between keys; key the hips height on every frame so the lowest
    deformed vertex never goes below `floor` (the hips carry every other bone, so a hips lift moves
    the whole body rigidly). Deterministic: two passes over the sampled frames."""
    from mathutils import Vector

    arm_obj.animation_data.action = act
    pb = arm_obj.pose.bones["hips"]
    r_inv = pb.bone.matrix_local.to_quaternion().inverted()
    last = round(CLIPS[act.name]["duration"] * FPS)
    lifts = []
    for _ in range(2):
        plan = []
        for f in range(last + 1):
            scene.frame_set(f)
            lift = floor - evaluated_min_z(bpy, body)
            plan.append((f, Vector(pb.location), max(0.0, lift)))
        changed = False
        for f, loc, lift in plan:
            if lift > 1e-5:
                pb.location = loc + r_inv @ Vector((0, 0, lift))
                pb.keyframe_insert("location", frame=f)
                changed = True
        lifts.append(round(max(p[2] for p in plan), 4))
        if not changed:
            break
    arm_obj.animation_data.action = None
    clear_pose(arm_obj)
    scene.frame_set(0)
    return lifts


def pose_checks(bpy, scene, arm_obj, body, actions: dict) -> dict:
    """Evaluated (deformed) mesh per clip frame: floor penetration, death on the floor, loop seams."""
    import numpy as np

    out = {}
    # The back cog turns one 6-fold symmetry step (60 deg) per idle loop: identical in shape, so the
    # seam is measured on every other vertex.
    cog_gi = body.vertex_groups["cog"].index
    keep = np.array([not any(g.group == cog_gi for g in v.groups) for v in body.data.vertices])
    for name, act in actions.items():
        arm_obj.animation_data.action = act
        last = round(CLIPS[name]["duration"] * FPS)
        mins, maxs, firsts = [], [], None
        for f in range(0, last + 1):
            scene.frame_set(f)
            dg = bpy.context.evaluated_depsgraph_get()
            ev = body.evaluated_get(dg)
            me = ev.to_mesh()
            co = np.empty(len(me.vertices) * 3, dtype=np.float64)
            me.vertices.foreach_get("co", co)
            ev.to_mesh_clear()
            co = co.reshape(-1, 3) @ np.array(body.matrix_world.to_3x3()).T + np.array(body.matrix_world.translation)
            mins.append(float(co[:, 2].min()))
            maxs.append(float(co[:, 2].max()))
            if f == 0:
                firsts = co
            if f == last:
                seam = float(np.abs(co[keep] - firsts[keep]).max())
        out[name] = {"frames": last + 1, "min_z": round(min(mins), 4), "min_z_frame": int(np.argmin(mins)),
                     "final_max_z": round(maxs[-1], 4), "final_min_z": round(mins[-1], 4), "loop_seam_m": round(seam, 5)}
    arm_obj.animation_data.action = None
    clear_pose(arm_obj)
    scene.frame_set(0)
    return out


# --------------------------------------------------------------------------------------------------
# Materials


def export_materials(bpy) -> list:
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
        if name == "sentry-glow":
            bsdf.inputs["Emission Color"].default_value = (*(srgb_to_linear(c) for c in GLOW_SRGB), 1.0)
            bsdf.inputs["Emission Strength"].default_value = GLOW_STRENGTH
        mat.use_backface_culling = True  # closed parts: export single-sided, half the fragment work
        out.append(mat)
    return out


def source_materials(bpy) -> list:
    """Review/edit materials: the shared PNG sets on UV0 for the brass slots."""
    out = []
    for name in MATS:
        mat = bpy.data.materials.new(f"{PIECE}-{name}")
        nt = mat.node_tree
        bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
        rgb, rough, metal = EXPORT_FACTORS[name]
        bsdf.inputs["Base Color"].default_value = (*(srgb_to_linear(c) for c in rgb), 1.0)
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Metallic"].default_value = metal
        if name == "sentry-glow":
            bsdf.inputs["Emission Color"].default_value = (*(srgb_to_linear(c) for c in GLOW_SRGB), 1.0)
            bsdf.inputs["Emission Strength"].default_value = GLOW_STRENGTH
        if name in NORMAL_SCALE:
            uvn = nt.nodes.new("ShaderNodeUVMap")
            uvn.uv_map = "tile"
            texs = {}
            for role in ("basecolor", "normal", "orm"):
                img = bpy.data.images.load(str(MATERIAL_DIR / name / f"{name}.{role}.png"), check_existing=True)
                img.colorspace_settings.name = "sRGB" if role == "basecolor" else "Non-Color"
                tex = nt.nodes.new("ShaderNodeTexImage")
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
        out.append(mat)
    return out


def set_slots(obj, mats: list) -> None:
    me = obj.data
    if len(me.materials) == 0:
        for m in mats:
            me.materials.append(m)
    else:
        for i, m in enumerate(mats):
            me.materials[i] = m


# --------------------------------------------------------------------------------------------------
# Sockets, export, reimport gate


SOCKETS = {
    "socket-hit": ("chest", (0, 0.15, 1.43)),  # in front of the amber core: hit sparks and aim point
    "socket-eye": ("head", (0, 0.11, 1.835)),  # between the eye slits
    "socket-weapon": ("hand.R", (0.30, 0.03, 0.78)),  # the striking claw
}


def add_sockets(bpy, scene, arm_obj) -> dict:
    from mathutils import Matrix

    out = {}
    for name, (bone, loc) in SOCKETS.items():
        e = bpy.data.objects.new(name, None)
        e.empty_display_size = 0.05
        scene.collection.objects.link(e)
        e.parent = arm_obj
        e.parent_type = "BONE"
        e.parent_bone = bone
        bpy.context.view_layer.update()
        e.matrix_world = Matrix.Translation(loc)
        out[name] = e
    bpy.context.view_layer.update()
    return out


def export_glb(bpy, keep: list, active, path: Path) -> None:
    for o in bpy.context.view_layer.objects:
        o.select_set(o in keep)
    bpy.context.view_layer.objects.active = active
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        use_active_scene=True,
        export_texcoords=True,
        export_normals=True,
        # No TANGENT: three derives tangents for the shared sets, as on the table (see its generator).
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="NONE",
        export_cameras=False,
        export_lights=False,
        export_skins=True,
        export_all_influences=False,
        export_def_bones=False,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_force_sampling=True,
        export_optimize_animation_size=False,  # `frozen` is constant and must keep its channels
        export_frame_range=False,
        export_anim_single_armature=True,
        export_reset_pose_bones=True,
        export_rest_position_armature=True,
        export_apply=False,
        export_yup=True,
    )


def canonicalize_indices(path: Path) -> int:
    """Sorts each primitive's triangles in place (each rotated to start at its lowest index, so the
    winding is kept). The exporter emits the same triangles in a run-dependent order for primitives
    holding smooth-shaded parts; sorting makes the GLB byte-reproducible. Returns primitives touched."""
    import numpy as np

    data = bytearray(path.read_bytes())
    jlen = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20 : 20 + jlen])
    bin_start = 28 + jlen
    touched = 0
    for mesh in gltf["meshes"]:
        for prim in mesh["primitives"]:
            acc = gltf["accessors"][prim["indices"]]
            view = gltf["bufferViews"][acc["bufferView"]]
            dtype = {5125: np.uint32, 5123: np.uint16, 5121: np.uint8}[acc["componentType"]]
            start = bin_start + view.get("byteOffset", 0) + acc.get("byteOffset", 0)
            size = acc["count"] * np.dtype(dtype).itemsize
            tri = np.frombuffer(bytes(data[start : start + size]), dtype=dtype).reshape(-1, 3)
            shift = np.argmin(tri, axis=1)
            rows = np.arange(len(tri))[:, None]
            rot = tri[rows, (shift[:, None] + np.arange(3)[None, :]) % 3]
            rot = rot[np.lexsort((rot[:, 2], rot[:, 1], rot[:, 0]))]
            data[start : start + size] = rot.astype(dtype).tobytes()
            touched += 1
    path.write_bytes(bytes(data))
    return touched


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
        ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[acc["type"]]
        start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
        stride = view.get("byteStride")
        item = np.dtype(dtype).itemsize * ncomp
        if stride and stride != item:
            raw = np.frombuffer(binary, dtype=np.uint8, count=stride * acc["count"], offset=start).reshape(acc["count"], stride)[:, :item]
            arr = raw.copy().view(dtype).reshape(acc["count"], ncomp)
        else:
            arr = np.frombuffer(binary, dtype=dtype, count=acc["count"] * ncomp, offset=start).reshape(acc["count"], ncomp)
        if acc.get("normalized"):
            arr = arr.astype(np.float64) / float(np.iinfo(dtype).max)
        return arr if ncomp > 1 else arr[:, 0]

    return gltf, accessor


def node_matrix(node) -> list:
    import numpy as np

    if "matrix" in node:
        return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
    t = node.get("translation", [0, 0, 0])
    x, y, z, w = node.get("rotation", [0, 0, 0, 1])
    s = node.get("scale", [1, 1, 1])
    r = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])
    m = np.eye(4)
    m[:3, :3] = r * np.array(s)
    m[:3, 3] = t
    return m


def gate_glb(path: Path) -> dict:
    """Reimport gate on the shipped bytes: budgets, skin, clips, root motion, bounds, sockets."""
    import numpy as np

    g, acc = read_glb(path)
    errors: list[str] = []
    nodes = g["nodes"]
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}

    def world(i: int):
        m = node_matrix(nodes[i])
        while i in parent:
            i = parent[i]
            m = node_matrix(nodes[i]) @ m
        return m

    names = [n.get("name", "") for n in nodes]
    tris = 0
    prims = []
    for mesh in g.get("meshes", []):
        for p in mesh["primitives"]:
            if p.get("mode", 4) != 4:
                errors.append("non-triangle primitive")
            tris += (g["accessors"][p["indices"]]["count"] if "indices" in p else g["accessors"][p["attributes"]["POSITION"]]["count"]) // 3
            prims.append(p)
    mats = [m.get("name") for m in g.get("materials", [])]
    if tris > LIMITS["tris"]:
        errors.append(f"{tris} triangles over {LIMITS['tris']}")
    if sorted(mats) != sorted(MATS):
        errors.append(f"materials {mats} != {MATS}")
    if g.get("images") or g.get("textures"):
        errors.append("GLB must be image-free")
    skins = g.get("skins", [])
    if len(skins) != 1:
        errors.append(f"{len(skins)} skins, want 1")
    joints = skins[0]["joints"] if skins else []
    joint_names = [names[j] for j in joints]
    if len(joints) > LIMITS["bones"] or sorted(joint_names) != sorted(BONE_NAMES):
        errors.append(f"joints {len(joints)}: {joint_names}")
    ibm = acc(skins[0]["inverseBindMatrices"]).reshape(-1, 4, 4).transpose(0, 2, 1) if skins else []
    if skins and not np.all(np.isfinite(ibm)):
        errors.append("non-finite inverse bind matrices")

    # Skin: every vertex of every primitive, weights normalized, <= 4 influences, none unweighted.
    wsum_err = 0.0
    max_inf = 0
    zero = 0
    nverts = 0
    pos_world = []
    skinned_nodes = [i for i, n in enumerate(nodes) if "mesh" in n]
    for p in prims:
        if "WEIGHTS_0" not in p["attributes"] or "JOINTS_0" not in p["attributes"]:
            errors.append("primitive without JOINTS_0/WEIGHTS_0")
            continue
        if "WEIGHTS_1" in p["attributes"]:
            errors.append("more than 4 influences exported (WEIGHTS_1)")
        w = acc(p["attributes"]["WEIGHTS_0"]).astype(np.float64)
        j = acc(p["attributes"]["JOINTS_0"])
        nverts += len(w)
        s = w.sum(axis=1)
        wsum_err = max(wsum_err, float(np.abs(s - 1).max()))
        zero += int((s <= 1e-6).sum())
        max_inf = max(max_inf, int((w > 1e-6).sum(axis=1).max()))
        if int(j.max()) >= len(joints):
            errors.append("joint index out of range")
        pos_world.append(acc(p["attributes"]["POSITION"]).astype(np.float64))
    if wsum_err > 2e-3:
        errors.append(f"weight sums off by {wsum_err}")
    if zero:
        errors.append(f"{zero} unweighted vertices")
    if max_inf > LIMITS["influences"]:
        errors.append(f"{max_inf} influences")
    mesh_world = world(skinned_nodes[0]) if skinned_nodes else np.eye(4)
    pts = np.concatenate(pos_world) @ mesh_world[:3, :3].T + mesh_world[:3, 3]
    bmin, bmax = pts.min(axis=0), pts.max(axis=0)
    if abs(bmin[1]) > 1e-3:
        errors.append(f"rest pose min y {bmin[1]:.4f}, want 0 (root at the feet)")
    if not 1.8 <= bmax[1] <= 2.1:
        errors.append(f"height {bmax[1]:.3f} outside 1.8-2.1 m")

    # Clips: exact set, durations, channels, root never animated.
    clips = {}
    root_idx = names.index("root") if "root" in names else -1
    for a in g.get("animations", []):
        dur = max(float(g["accessors"][s["input"]]["max"][0]) for s in a["samplers"])
        start = min(float(g["accessors"][s["input"]]["min"][0]) for s in a["samplers"])
        root_moves = []
        for ch in a["channels"]:
            if ch["target"].get("node") == root_idx:
                out = acc(a["samplers"][ch["sampler"]]["output"]).astype(np.float64)
                if out.size and float(np.abs(out - out[0]).max()) > 1e-5:
                    root_moves.append(ch["target"]["path"])
        clips[a["name"]] = {"duration": round(dur, 4), "start": round(start, 4), "channels": len(a["channels"]), "rootAnimated": root_moves}
    if sorted(clips) != sorted(CLIPS):
        errors.append(f"clips {sorted(clips)} != {sorted(CLIPS)}")
    for name, spec in CLIPS.items():
        c = clips.get(name)
        if not c:
            continue
        if abs(c["duration"] - spec["duration"]) > 1.5 / FPS or c["start"] > 1e-4:
            errors.append(f"clip {name} spans {c['start']}..{c['duration']} s, want 0..{spec['duration']}")
        if c["channels"] == 0:
            errors.append(f"clip {name} has no channels")
        if c["rootAnimated"]:
            errors.append(f"clip {name} animates the root ({c['rootAnimated']}); root motion is code-owned")

    sockets = {}
    for sname, (bone, loc) in SOCKETS.items():
        if sname not in names:
            errors.append(f"socket {sname} missing")
            continue
        i = names.index(sname)
        p = world(i)[:3, 3]
        want = np.array([loc[0], loc[2], -loc[1]])
        if float(np.abs(p - want).max()) > 2e-3:
            errors.append(f"{sname} rests at {p.round(3).tolist()}, want {want.tolist()}")
        sockets[sname] = {"bone": bone, "parent": names[parent[i]] if i in parent else None, "position": [round(float(v), 4) for v in p]}
    root_nodes = [i for i in g["scenes"][g.get("scene", 0)]["nodes"]]
    return {
        "glb_sha256": sha256(path),
        "glb_bytes": path.stat().st_size,
        "triangles": tris,
        "materials": mats,
        "vertices": nverts,
        "joints": joint_names,
        "bone_count": len(joints),
        "max_influences": max_inf,
        "max_weight_sum_error": round(wsum_err, 6),
        "unweighted_vertices": zero,
        "bounds": {"min": [round(float(v), 4) for v in bmin], "max": [round(float(v), 4) for v in bmax]},
        "clips": clips,
        "sockets": sockets,
        "scene_roots": [names[i] for i in root_nodes],
        "errors": errors,
        "pass": not errors,
    }


def blender_reimport(bpy, path: Path) -> dict:
    scene = bpy.data.scenes.new("reimport")
    with bpy.context.temp_override(scene=scene, view_layer=scene.view_layers[0]):
        if bpy.context.window is not None:
            bpy.context.window.scene = scene
        before = set(bpy.data.actions)
        bpy.ops.import_scene.gltf(filepath=str(path))
        arms = [o for o in scene.objects if o.type == "ARMATURE"]
        meshes = [o for o in scene.objects if o.type == "MESH"]
        actions = sorted(a.name for a in bpy.data.actions if a not in before)
        out = {"armatures": len(arms), "bones": len(arms[0].data.bones) if arms else 0, "meshes": len(meshes),
               "actions": actions, "objects": sorted(o.name for o in scene.objects)}
    for o in list(scene.objects):
        bpy.data.objects.remove(o)
    for a in [a for a in bpy.data.actions if a.name in out["actions"] and not a.use_fake_user]:
        bpy.data.actions.remove(a)
    bpy.data.scenes.remove(scene)
    return out


def build_manifest(gate: dict) -> dict:
    return {
        "id": PIECE,
        "version": 1,
        "glb": f"{PIECE}.glb",
        "frame": {"units": "m", "up": "+Y", "forward": "-Z", "origin": "feet centre on the floor (y = 0)",
                  "note": "encounter.ts rotation.y = -heading turns local -Z onto the heading"},
        "root": PIECE,
        "mesh": "sentry-body",
        "bounds": gate["bounds"],
        "skeleton": {"root": "root", "bones": gate["bone_count"], "joints": gate["joints"], "maxInfluences": gate["max_influences"],
                     "skinning": "rigid: every vertex weighted 1.0 to one bone"},
        "rootMotion": "code-owned: the root joint is never animated and every clip plays in place",
        "clips": {name: {"duration": gate["clips"][name]["duration"], "loop": spec["loop"], "events": spec["events"],
                         **({"held": True} if name == "frozen" else {}), **({"endsOnFloor": True} if name == "death" else {})}
                  for name, spec in CLIPS.items()},
        "sockets": gate["sockets"],
        "emissive": {"material": "sentry-glow", "color": "#{:02X}{:02X}{:02X}".format(*GLOW_SRGB), "intensity": GLOW_STRENGTH,
                     "nodes": ["socket-eye", "socket-hit"]},
        "materialSlots": {
            "brass-polished": {"set": "brass-polished", "tileMeters": TILE_METERS, "normalScale": NORMAL_SCALE["brass-polished"]},
            "brass-aged": {"set": "brass-aged", "tileMeters": TILE_METERS, "normalScale": NORMAL_SCALE["brass-aged"]},
            "gunmetal": {"set": None, "factorOnly": True},
            "sentry-glow": {"set": None, "factorOnly": True, "emissive": True},
        },
        "budget": {"tris": gate["triangles"], "materials": len(gate["materials"]), "bones": gate["bone_count"], "influences": LIMITS["influences"]},
    }


# --------------------------------------------------------------------------------------------------
# Review renders (EEVEE)


def setup_render(scene, w: int = 640, h: int = 640) -> None:
    for engine in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.render.resolution_x = w
    scene.render.resolution_y = h
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"
    try:
        scene.eevee.taa_render_samples = 16
    except AttributeError:
        pass


def lights(bpy, scene) -> None:
    from mathutils import Vector

    world = bpy.data.worlds.new(f"{PIECE}-review-world")
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (0.16, 0.11, 0.07, 1.0)
    bg.inputs["Strength"].default_value = 1.0
    scene.world = world
    for name, loc, energy, color in (("key", (-1.6, 2.2, 2.6), 420.0, (1.0, 0.8, 0.55)),
                                     ("fill", (2.2, 1.6, 1.4), 120.0, (1.0, 0.88, 0.72)),
                                     ("rim", (0.8, -2.4, 2.2), 260.0, (1.0, 0.72, 0.42))):
        data = bpy.data.lights.new(f"{PIECE}-{name}", "AREA")
        data.energy, data.color, data.size = energy, color, 1.5
        o = bpy.data.objects.new(data.name, data)
        o.location = loc
        o.rotation_euler = (Vector((0, 0, 1.0)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(o)
    me = bpy.data.meshes.new("review-floor")
    me.from_pydata([(-3, -3, 0), (3, -3, 0), (3, 3, 0), (-3, 3, 0)], [], [(0, 1, 2, 3)])
    mat = bpy.data.materials.new("review-floor")
    next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = (0.05, 0.04, 0.035, 1)
    me.materials.append(mat)
    floor = bpy.data.objects.new("review-floor", me)
    scene.collection.objects.link(floor)


def camera(bpy, scene, loc, target, lens: float = 50.0) -> None:
    from mathutils import Vector

    cam = bpy.data.objects.get("review-cam")
    if cam is None:
        cam = bpy.data.objects.new("review-cam", bpy.data.cameras.new("review-cam"))
        scene.collection.objects.link(cam)
    cam.data.lens = lens
    cam.location = loc
    cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam


def render(bpy, scene, path: Path) -> None:
    bpy.context.view_layer.update()
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True, scene=scene.name)


def renders(bpy, low_scene, high_scene, arm, arm_high, actions: dict, out: Path) -> list[str]:
    rdir = out / "renders"
    rdir.mkdir(parents=True, exist_ok=True)
    done = []
    for sc in (low_scene, high_scene):
        setup_render(sc)
        lights(bpy, sc)
    views = {"front": ((0, 4.2, 1.15), (0, 0, 1.0)), "side": ((4.2, 0, 1.15), (0, 0, 1.0)),
             "back": ((0, -4.2, 1.15), (0, 0, 1.0)), "three-quarter": ((2.6, 3.3, 1.5), (0, 0, 1.0))}
    for view, (loc, tgt) in views.items():
        camera(bpy, low_scene, loc, tgt)
        render(bpy, low_scene, rdir / f"model-low-{view}.png")
        done.append(f"model-low-{view}")
    with bpy.context.temp_override(scene=high_scene, view_layer=high_scene.view_layers[0]):
        if bpy.context.window is not None:
            bpy.context.window.scene = high_scene
        camera(bpy, high_scene, *views["three-quarter"])
        render(bpy, high_scene, rdir / "model-high-three-quarter.png")
        done.append("model-high-three-quarter")
    if bpy.context.window is not None:
        bpy.context.window.scene = low_scene
    # Rig: range-of-motion poses (not clips) to show the rigid joints deforming.
    rom = {"rig-rom-reach": {"upperarm.R": (150, 0, 0), "forearm.R": (60, 0, 0), "upperarm.L": (0, -80, 0), "forearm.L": (90, 0, 0),
                             "head": (0, 0, 35), "chest": (0, 0, 20), "ik": PLANT},
           "rig-rom-crouch": {"hips_loc": (0, 0, -0.32), "spine": (-25, 0, 0), "head": (20, 0, 0), "upperarm.R": (45, 0, 0),
                              "upperarm.L": (45, 0, 0), "forearm.R": (60, 0, 0), "forearm.L": (60, 0, 0), "ik": PLANT}}
    camera(bpy, low_scene, *views["three-quarter"])
    for name, pose in rom.items():
        apply_pose(arm, pose, None)
        render(bpy, low_scene, rdir / f"{name}.png")
        done.append(name)
    clear_pose(arm)
    # Animation: representative frames.
    frames = {"anim-idle": ("idle", 0.5), "anim-attack-windup": ("attack", 0.35), "anim-attack-strike": ("attack", 0.55),
              "anim-hit": ("hit", 0.1), "anim-frozen": ("frozen", 0.0), "anim-death-kneel": ("death", 0.7), "anim-death-end": ("death", 2.0)}
    camera(bpy, low_scene, (3.0, 3.0, 1.6), (0, 0.1, 0.8), 45.0)
    for name, (clip, t) in frames.items():
        arm.animation_data.action = actions[clip]
        low_scene.frame_set(round(t * FPS))
        render(bpy, low_scene, rdir / f"{name}.png")
        done.append(name)
    arm.animation_data.action = None
    clear_pose(arm)
    low_scene.frame_set(0)
    return done


# --------------------------------------------------------------------------------------------------
# Review sheet (system Python + Pillow)


def compose_sheet(out: Path) -> Path:
    from PIL import Image, ImageDraw

    r = out / "renders"
    eng = REPO / "docs/verification"
    sections = [
        ("CONCEPT - approved by Paul 2026-11-15 (docs/art-bible.md)", [("sentry-sheet-1 (approved concept)", CONCEPT)]),
        ("MODEL - approval PENDING (Paul)", [("low front", r / "model-low-front.png"), ("low side", r / "model-low-side.png"),
                                             ("low back", r / "model-low-back.png"), ("low 3/4", r / "model-low-three-quarter.png"),
                                             ("high source 3/4 (same camera)", r / "model-high-three-quarter.png")]),
        ("RIG - approval PENDING (Paul): 21 bones, rigid 1-bone skinning", [("range of motion: reach", r / "rig-rom-reach.png"),
                                                                          ("range of motion: crouch (planted feet)", r / "rig-rom-crouch.png"),
                                                                          ("attack strike (deformed)", r / "anim-attack-strike.png"),
                                                                          ("death kneel (deformed)", r / "anim-death-kneel.png")]),
        ("ANIMATION - approval PENDING (Paul): Blender frames", [("idle 0.5 s", r / "anim-idle.png"), ("attack windup 0.35 s", r / "anim-attack-windup.png"),
                                                                ("hit 0.1 s", r / "anim-hit.png"), ("frozen (held)", r / "anim-frozen.png"),
                                                                ("death end 2.0 s", r / "anim-death-end.png")]),
        ("ANIMATION - in engine (three.js 0.186.1, headless Chromium on the GPU)", [("idle", eng / "p4-sentry-idle.jpg"), ("attack mid-swing", eng / "p4-sentry-attack.jpg"),
                                                                                 ("hit", eng / "p4-sentry-hit.jpg"), ("frozen", eng / "p4-sentry-frozen.jpg"),
                                                                                 ("death end", eng / "p4-sentry-death.jpg")]),
    ]
    tw, th, pad, cap, head = 360, 360, 10, 24, 34
    cols = 5
    height = 50 + sum(head + th + cap + pad for _ in sections) + pad
    sheet = Image.new("RGB", (cols * (tw + pad) + pad, height), (28, 24, 22))
    d = ImageDraw.Draw(sheet)
    d.text((pad, 14), "P4-T6 Cog Sentry - owner review. Concept approved; model, rig and animation approvals pending (not self-recorded).", fill=(243, 190, 101))
    y = 50
    for title, tiles in sections:
        d.text((pad, y + 10), title, fill=(243, 190, 101))
        y += head
        for k, (label, path) in enumerate(tiles):
            x = pad + k * (tw + pad)
            w = tw if path != CONCEPT else cols * (tw + pad) - pad
            if path.exists():
                img = Image.open(path).convert("RGB")
                img.thumbnail((w, th))
                sheet.paste(img, (x + (w - img.width) // 2, y + cap + (th - img.height) // 2))
            else:
                d.text((x + 8, y + cap + 8), f"missing: {path.name}", fill=(200, 80, 80))
            d.text((x, y + 4), label, fill=(222, 193, 106))
        y += th + cap + pad
    path = out.parent / "cog-sentry.review-sheet.jpg"
    sheet.save(path, quality=86)
    return path


# --------------------------------------------------------------------------------------------------


def main_blender(args: argparse.Namespace) -> None:
    import bmesh
    import bpy

    t_start = time.monotonic()
    out, runtime, blend_dir = args.out.resolve(), args.runtime.resolve(), args.blend_dir.resolve()
    for d in (out, runtime, blend_dir):
        d.mkdir(parents=True, exist_ok=True)
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    low_scene = bpy.context.scene
    low_scene.name = f"{PIECE}-low"
    high_scene = bpy.data.scenes.new(f"{PIECE}-high")
    for sc in (low_scene, high_scene):
        sc.render.fps = FPS
        sc.frame_start, sc.frame_end = 0, round(max(c["duration"] for c in CLIPS.values()) * FPS)

    # High source: denser sections, same parts, rig and skin (its own scene, unexported).
    with bpy.context.temp_override(scene=high_scene, view_layer=high_scene.view_layers[0]):
        if bpy.context.window is not None:
            bpy.context.window.scene = high_scene
        arm_high = build_armature(bpy, high_scene, f"{PIECE}-high")
        body_high = build_body(bpy, bmesh, high_scene, "high", arm_high)
    if bpy.context.window is not None:
        bpy.context.window.scene = low_scene
    arm = build_armature(bpy, low_scene, PIECE)
    body = build_body(bpy, bmesh, low_scene, "low", arm)
    tris_low = sum(len(p.vertices) - 2 for p in body.data.polygons)
    tris_high = sum(len(p.vertices) - 2 for p in body_high.data.polygons)
    print(f"[{PIECE}] tris low={tris_low} high={tris_high}")
    assert tris_low <= LIMITS["tris"], tris_low

    report: dict = {
        "piece": PIECE,
        "blender": bpy.app.version_string,
        "generator": "scripts/assets/build-cog-sentry.py",
        "generator_sha256": sha256(Path(__file__).resolve()),
        "concept": {"file": str(CONCEPT.relative_to(REPO)), "sha256": sha256(CONCEPT), "picked_by": "Paul, 2026-11-15 (docs/art-bible.md)"},
        "source_materials": {name: {role: sha256(MATERIAL_DIR / name / f"{name}.{role}.png") for role in ("basecolor", "normal", "orm")} for name in NORMAL_SCALE},
        "triangles": {"low": tris_low, "high": tris_high},
        "bones": len(BONES),
        "authoringAgent": "Claude Code subagent (claude-opus-5-5), dispatched by the rogue-xr primary session",
    }

    export_mats = export_materials(bpy)
    src_mats = source_materials(bpy)
    set_slots(body, export_mats)
    set_slots(body_high, src_mats)
    actions = author_clips(bpy, arm)
    with bpy.context.temp_override(scene=high_scene, view_layer=high_scene.view_layers[0]):
        arm_high.animation_data_create()
    report["ground_clamp_death_max_lift_m"] = ground_clamp(bpy, low_scene, arm, body, actions["death"])
    report["pose_checks"] = pose_checks(bpy, low_scene, arm, body, actions)
    pc = report["pose_checks"]
    pose_errors = [f"{n}: min z {c['min_z']} at frame {c['min_z_frame']}" for n, c in pc.items() if c["min_z"] < -0.03]
    if pc["death"]["final_max_z"] > 0.6 or pc["death"]["final_min_z"] < -0.02:
        pose_errors.append(f"death does not end lying on the floor: {pc['death']}")
    for n in ("idle", "frozen"):
        if pc[n]["loop_seam_m"] > 1e-3:
            pose_errors.append(f"{n} loop seam {pc[n]['loop_seam_m']} m")
    print(json.dumps(pc, indent=1))

    sockets = add_sockets(bpy, low_scene, arm)
    arm.animation_data.action = None
    clear_pose(arm)
    low_scene.frame_set(0)
    glb = runtime / f"{PIECE}.glb"
    export_glb(bpy, [arm, body, *sockets.values()], arm, glb)
    report["canonicalized_primitives"] = canonicalize_indices(glb)
    gate = gate_glb(glb)
    gate["errors"] += pose_errors
    gate["pass"] = not gate["errors"]
    gate["blender_reimport"] = blender_reimport(bpy, glb)
    br = gate["blender_reimport"]
    # Reimported names carry a numeric suffix because the authored datablocks are still loaded.
    if br["bones"] != len(BONES) or {re.sub(r"\.\d{3}$", "", a) for a in br["actions"]} != set(CLIPS):
        gate["errors"].append(f"blender reimport mismatch: {br}")
        gate["pass"] = False
    report["reimport"] = gate
    (out / "reimport.json").write_text(json.dumps(gate, indent=2) + "\n")
    if gate["errors"]:
        (out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        raise RuntimeError(f"gate failed: {gate['errors']}")
    manifest = build_manifest(gate)
    (runtime / f"{PIECE}.manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    # Editable sources: low (rig, skin, clips, sockets, shared-set materials) and high.
    set_slots(body, src_mats)
    bpy.data.libraries.write(str(blend_dir / f"{PIECE}.low.blend"), {low_scene, *actions.values()}, path_remap="RELATIVE_ALL", compress=True)
    bpy.data.libraries.write(str(blend_dir / f"{PIECE}.high.blend"), {high_scene}, path_remap="RELATIVE_ALL", compress=True)

    if not args.skip_renders:
        t0 = time.monotonic()
        report["renders"] = renders(bpy, low_scene, high_scene, arm, arm_high, actions, out)
        report["render_seconds"] = round(time.monotonic() - t0, 1)

    report["files"] = {
        (str(p.relative_to(REPO)) if p.is_relative_to(REPO) else str(p)): sha256(p)
        for p in sorted([*runtime.iterdir(), *blend_dir.iterdir(), out / "reimport.json"])
        if p.is_file() and p.suffix in {".glb", ".json", ".blend"}
    }
    report["total_seconds"] = round(time.monotonic() - t_start, 1)
    (out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: gate[k] for k in ("triangles", "bone_count", "max_influences", "max_weight_sum_error", "unweighted_vertices", "bounds", "clips", "sockets")}, indent=1))
    print(f"[{PIECE}] PASS glb sha256 {gate['glb_sha256']}")


if __name__ == "__main__":
    ARGS = parse_args()
    if ARGS.sheet:
        print(compose_sheet(ARGS.out.resolve()))
    else:
        main_blender(ARGS)
