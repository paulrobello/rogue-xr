"""P5-T3 Bellows Golem: a squat, wide brass-and-walnut automaton (concept assets-source/concepts/
golem-sheet-1.png, notes assets-source/concepts/p5-automatons-design.md, style docs/art-bible.md),
built procedurally as rigid plated parts, each weighted 1.0 to one bone of a 22-bone armature, with
the five automaton clips of the Cog Sentry contract (P4-T6): idle (loop, the bellows pumping),
attack (the two-fist crush), hit, death (one-shot, ends lying prone) and frozen (the held mid-step
pose of the time freeze). The vent intent is modeled as an emissive chimney mouth only, with no
flame or smoke geometry (art bible). Exported as an image-free skinned GLB whose set-bound slots
carry the names of the shared P4-T3 tileable sets (`public/assets/materials/`: brass-polished and
walnut), so the runtime binds them by name. UV0 is in tile units (metres / tileMeters). The
manifest uses the sentry's schema plus an optional `cull` sphere measured over every clip frame.

Blender run (build, pose checks, export, reimport gate, manifest, renders, .blend sources):
    "$BLENDER" -b --factory-startup --python-exit-code 1 -P scripts/assets/build-bellows-golem.py -- \
        [--out assets-source/enemies/bellows-golem/staging] [--runtime public/assets/enemies/bellows-golem] \
        [--blend-dir assets-source/enemies/bellows-golem/blend] [--skip-renders]
Review sheet (system Python with Pillow, after the Blender run and the engine shots):
    python3 -I scripts/assets/build-bellows-golem.py --sheet [--out ...]

Frame: Blender is Z-up; runtime (x, y, z) = Blender (x, z, -y). The golem faces Blender +Y, which
is runtime -Z (encounter.ts sets rotation.y = -heading). The root sits at the feet (runtime
y = 0). Anatomical right is Blender +X. Root motion is code-owned: the `root` joint is never
animated and every clip plays in place.
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
PIECE = "bellows-golem"
BODY = "golem-body"
DEFAULT_OUT = REPO / f"assets-source/enemies/{PIECE}/staging"
DEFAULT_RUNTIME = REPO / f"public/assets/enemies/{PIECE}"
DEFAULT_BLEND = REPO / f"assets-source/enemies/{PIECE}/blend"
MATERIAL_DIR = REPO / "public/assets/materials"
CONCEPT = REPO / "assets-source/concepts/golem-sheet-1.png"
FPS = 30
HEIGHT_RANGE = (2.0, 2.2)  # metres, rest pose (design notes: about 2.1 m)
DEATH_MAX_Z = 1.1  # lying prone: the barrel alone is 0.94 m deep

LIMITS = {"tris": 25_000, "materials": 4, "bones": 40, "influences": 4}
GLOW = "golem-glow"
MATS = ["brass-polished", "walnut", "gunmetal", GLOW]
BP, WN, GM, GL = range(4)
SETS = {"brass-polished": 0.35, "walnut": 1.0}  # shared set -> normal scale (as on the combat table)
TILE_METERS = 0.5  # both sets tile at 0.5 m (public/assets/materials/materials.json)
FACTORS = {  # sRGB base, roughness, metallic: the GLB look, and the fallback when the sets fail
    "brass-polished": ((0xDE, 0xC1, 0x6A), 0.3, 1.0),
    "walnut": ((0x58, 0x3C, 0x26), 0.6, 0.0),
    "gunmetal": ((0x2E, 0x2A, 0x2A), 0.5, 0.85),
    GLOW: ((0x6A, 0x34, 0x0C), 0.4, 0.0),
}
GLOW_SRGB = (0xF0, 0x8C, 0x2C)
GLOW_STRENGTH = 0.7

# Armature: name, parent, head, tail (Blender metres). R is Blender +X.
BONES: list[tuple[str, str | None, tuple, tuple]] = [
    ("root", None, (0, 0, 0), (0, 0, 0.2)),
    ("pelvis", "root", (0, 0, 0.70), (0, 0, 0.86)),
    ("spine", "pelvis", (0, 0, 0.86), (0, 0, 1.12)),
    ("bellows", "spine", (0, 0, 0.98), (0, 0, 1.10)),
    ("chest", "spine", (0, 0, 1.12), (0, 0, 1.62)),
    ("head", "chest", (0, 0.06, 1.64), (0, 0.06, 1.90)),
]
for _s, _n in ((1, "R"), (-1, "L")):
    BONES += [
        (f"chimney.{_n}", "chest", (_s * 0.27, -0.14, 1.56), (_s * 0.29, -0.16, 2.0)),
        (f"clavicle.{_n}", "chest", (_s * 0.12, 0, 1.50), (_s * 0.50, 0, 1.50)),
        (f"upperarm.{_n}", f"clavicle.{_n}", (_s * 0.62, 0, 1.46), (_s * 0.66, 0, 1.06)),
        (f"forearm.{_n}", f"upperarm.{_n}", (_s * 0.66, 0, 1.06), (_s * 0.68, 0.04, 0.58)),
        (f"hand.{_n}", f"forearm.{_n}", (_s * 0.68, 0.04, 0.58), (_s * 0.68, 0.05, 0.30)),
        (f"thigh.{_n}", "pelvis", (_s * 0.24, 0, 0.72), (_s * 0.25, 0.04, 0.42)),
        (f"shin.{_n}", f"thigh.{_n}", (_s * 0.25, 0.04, 0.42), (_s * 0.25, 0, 0.11)),
        (f"foot.{_n}", f"shin.{_n}", (_s * 0.25, 0, 0.11), (_s * 0.25, 0.18, 0.04)),
    ]
BONE_NAMES = [b[0] for b in BONES]
PARENT = {b[0]: b[1] for b in BONES}
HEAD = {b[0]: b[2] for b in BONES}
TAIL = {b[0]: b[3] for b in BONES}
LOC_BONE = "pelvis"  # carries the body (in place: code owns root motion)
LOC_EXTRA = ("bellows",)  # the bellows pump slides on its bone
# Planar leg solve: chain (upper, lower, distal) and knee side (+1 forward, -1 back).
LEGS = {f"leg.{n}": (f"thigh.{n}", f"shin.{n}", f"foot.{n}", 1) for n in ("R", "L")}

CLIPS = {
    "idle": {"duration": 2.4, "loop": "repeat", "events": {}},
    "attack": {"duration": 1.5, "loop": "once", "events": {"impact": 0.85}},
    "hit": {"duration": 0.7, "loop": "once", "events": {}},
    "death": {"duration": 2.4, "loop": "once", "events": {"down": 1.7}},
    "frozen": {"duration": 1.0, "loop": "repeat", "events": {}},
}

DETAIL = {"low": {"sides": 12, "sphere": (14, 8), "ring": (20, 5)}, "high": {"sides": 28, "sphere": (28, 16), "ring": (44, 8)}}


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


def lin(c: int) -> float:
    v = c / 255.0
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


# --------------------------------------------------------------------------------------------------
# Geometry: closed rigid parts, each weighted to one bone


def axis_frame(a, b):
    """4x4 with origin a and local Z along a->b; local X stays as close to world X as possible."""
    from mathutils import Matrix, Vector

    a, b = Vector(a), Vector(b)
    d = (b - a).normalized()
    x = Vector((1, 0, 0)) if abs(d.x) < 0.9 else Vector((0, 1, 0))
    x = (x - d * x.dot(d)).normalized()
    y = d.cross(x)
    m = Matrix((x, y, d)).transposed().to_4x4()
    m.translation = a
    return m, (b - a).length


class Parts:
    def __init__(self, bmesh, detail: str):
        self.bmesh = bmesh
        self.bm = bmesh.new()
        self.deform = self.bm.verts.layers.deform.verify()
        self.d = DETAIL[detail]

    def _tag(self, verts, faces, mat: int, bone: str, smooth: bool) -> None:
        gi = BONE_NAMES.index(bone)
        for v in verts:
            v[self.deform][gi] = 1.0
        for f in faces:
            f.material_index = mat
            f.smooth = smooth

    def rings(self, profile: list[list[tuple[float, float]]], zs: list[float], m, mat: int, bone: str, smooth=False) -> None:
        from mathutils import Vector

        bm = self.bm
        vr = [[bm.verts.new(m @ Vector((x, y, z))) for x, y in ring] for ring, z in zip(profile, zs)]
        n = len(profile[0])
        faces = [bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i])) for a, b in zip(vr, vr[1:]) for i in range(n)]
        faces += [bm.faces.new(list(reversed(vr[0]))), bm.faces.new(vr[-1])]
        self._tag([v for r in vr for v in r], faces, mat, bone, smooth)

    def tube(self, p0, p1, r0: float, r1: float, mat: int, bone: str, sides: int | None = None, sx=1.0, sy=1.0, smooth=False) -> None:
        """Frustum p0->p1, elliptical section (r * sx across world X, r * sy across the other axis)."""
        m, length = axis_frame(p0, p1)
        n = sides or self.d["sides"]
        ring = lambda r: [(r * sx * math.cos(2 * math.pi * i / n), r * sy * math.sin(2 * math.pi * i / n)) for i in range(n)]  # noqa: E731
        self.rings([ring(r0), ring(r1)], [0.0, length], m, mat, bone, smooth)

    def box(self, c, size, mat: int, bone: str, taper=1.0) -> None:
        from mathutils import Matrix

        hx, hy, hz = (s / 2 for s in size)
        base = [(-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)]
        self.rings([base, [(x * taper, y * taper) for x, y in base]], [-hz, hz], Matrix.Translation(c), mat, bone)

    def ball(self, c, r: float, mat: int, bone: str, scale=(1.0, 1.0, 1.0)) -> None:
        from mathutils import Matrix

        u, v = self.d["sphere"]
        m = Matrix.Translation(c) @ Matrix.Diagonal((r * scale[0], r * scale[1], r * scale[2], 1.0))
        verts = self.bmesh.ops.create_uvsphere(self.bm, u_segments=u, v_segments=v, radius=1.0, matrix=m)["verts"]
        faces = {f for x in verts for f in x.link_faces}
        self._tag(verts, faces, mat, bone, smooth=True)

    def torus(self, c, normal, a: float, b: float, t: float, mat: int, bone: str) -> None:
        """Elliptical ring (semi-axes a across world X, b across the other axis) of tube radius t."""
        from mathutils import Vector

        n, k = self.d["ring"]
        m, _ = axis_frame(c, Vector(c) + Vector(normal))
        bm = self.bm
        grid = []
        for i in range(n):
            u = 2 * math.pi * i / n
            grid.append([bm.verts.new(m @ Vector((math.cos(u) * (a + t * math.cos(2 * math.pi * j / k)),
                                                  math.sin(u) * (b + t * math.cos(2 * math.pi * j / k)),
                                                  t * math.sin(2 * math.pi * j / k)))) for j in range(k)])
        faces = [bm.faces.new((grid[i][j], grid[(i + 1) % n][j], grid[(i + 1) % n][(j + 1) % k], grid[i][(j + 1) % k]))
                 for i in range(n) for j in range(k)]
        self._tag([v for row in grid for v in row], faces, mat, bone, smooth=True)


def lerp(p, q, f: float) -> tuple:
    return tuple(a + (b - a) * f for a, b in zip(p, q))


def build_parts(P: Parts) -> None:
    from mathutils import Matrix

    T, B = P.tube, P.ball
    # Barrel: walnut staves bulging between brass hoops, with two brass straps over the top.
    prof = [(1.12, 0.44), (1.22, 0.52), (1.36, 0.56), (1.50, 0.54), (1.60, 0.46), (1.66, 0.36)]
    n = P.d["sides"] * 2
    ring = lambda r: [(r * math.cos(2 * math.pi * i / n), 0.84 * r * math.sin(2 * math.pi * i / n)) for i in range(n)]  # noqa: E731
    P.rings([ring(r) for _, r in prof], [z for z, _ in prof], Matrix.Identity(4), WN, "chest", smooth=True)
    for z, r in ((1.17, 0.49), (1.55, 0.515)):
        P.torus((0, 0, z), (0, 0, 1), r, 0.84 * r, 0.024, BP, "chest")
    P.torus((0, 0, 1.645), (0, 0, 1), 0.37, 0.31, 0.022, BP, "chest")
    for s in (1, -1):
        P.torus((s * 0.22, 0, 1.37), (1, 0, 0), 0.448, 0.29, 0.02, BP, "chest")
    # Chest core: amber lamp behind brass grille bars in a brass bezel.
    P.torus((0, 0.475, 1.38), (0, 1, 0.05), 0.10, 0.115, 0.024, BP, "chest")
    B((0, 0.452, 1.38), 0.10, GL, "chest", (1.0, 0.42, 1.12))
    for x in (-0.048, -0.016, 0.016, 0.048):
        P.box((x, 0.49, 1.38), (0.014, 0.016, 0.2), BP, "chest")
    # Head: small brass dome sunk into the barrel top, two round amber eyes.
    T((0, 0.06, 1.60), (0, 0.06, 1.80), 0.13, 0.13, BP, "head")
    B((0, 0.06, 1.80), 0.13, BP, "head", (1.0, 1.0, 0.85))
    P.box((0, 0.185, 1.815), (0.16, 0.03, 0.02), BP, "head")
    for s in (1, -1):
        B((s * 0.05, 0.178, 1.76), 0.027, GL, "head")
    P.torus((0, 0.05, 1.655), (0, 0, 1), 0.17, 0.16, 0.025, GM, "head")
    # Chimneys: brass stacks with flared mouths; the mouth lip and throat glow (no flame geometry).
    for s, n_ in ((1, "R"), (-1, "L")):
        bone = f"chimney.{n_}"
        T((s * 0.27, -0.14, 1.56), (s * 0.29, -0.16, 1.95), 0.066, 0.06, BP, bone)
        T((s * 0.29, -0.16, 1.94), (s * 0.29, -0.165, 2.05), 0.062, 0.10, BP, bone)
        T((s * 0.29, -0.165, 1.99), (s * 0.29, -0.165, 2.045), 0.085, 0.088, GL, bone)
        P.torus((s * 0.29, -0.165, 2.05), (0, 0, 1), 0.094, 0.094, 0.013, GL, bone)
        P.torus((s * 0.28, -0.15, 1.72), (0, 0, 1), 0.07, 0.07, 0.016, GM, bone)
    # Bellows: dark leather pleats around a gunmetal drum; the upper pleats ride the pump.
    T((0, 0, 0.84), (0, 0, 1.14), 0.36, 0.38, GM, "spine", sy=0.84)
    for z, r, bone in ((0.90, 0.42, "spine"), (0.96, 0.44, "spine"), (1.02, 0.45, "bellows"), (1.08, 0.455, "bellows")):
        P.torus((0, 0, z), (0, 0, 1), r, 0.84 * r, 0.032, GM, bone)
    # Pelvis: brass hip skirt and front plate.
    T((0, 0, 0.60), (0, 0, 0.86), 0.30, 0.37, BP, "pelvis", sx=1.05, sy=0.8)
    P.box((0, 0.24, 0.64), (0.22, 0.06, 0.2), BP, "pelvis", taper=0.75)
    for s, n_ in ((1, "R"), (-1, "L")):
        # Arm: brass pauldron, gunmetal upper arm and elbow, a huge brass gauntlet and fist.
        B((s * 0.58, 0, 1.55), 0.22, BP, f"clavicle.{n_}", (1.0, 1.0, 0.82))
        B((s * 0.62, 0, 1.46), 0.11, GM, f"upperarm.{n_}")
        T((s * 0.62, 0, 1.44), (s * 0.66, 0, 1.08), 0.085, 0.08, GM, f"upperarm.{n_}")
        B((s * 0.66, 0, 1.06), 0.105, GM, f"forearm.{n_}")
        T((s * 0.664, 0.012, 1.00), (s * 0.68, 0.036, 0.62), 0.18, 0.21, BP, f"forearm.{n_}")
        for f in (0.2, 0.75):
            c = lerp((s * 0.664, 0.012, 1.00), (s * 0.68, 0.036, 0.62), f)
            P.torus(c, (0, 0.08, -1), 0.2 + 0.025 * f, 0.2 + 0.025 * f, 0.022, GM, f"forearm.{n_}")
        T((s * 0.68, 0.04, 0.62), (s * 0.68, 0.045, 0.56), 0.16, 0.16, GM, f"hand.{n_}")
        B((s * 0.68, 0.05, 0.39), 0.185, GM, f"hand.{n_}", (0.92, 0.95, 1.0))
        P.box((s * 0.68, -0.09, 0.40), (0.30, 0.08, 0.30), BP, f"hand.{n_}", taper=0.9)
        for k in range(4):
            z = 0.50 - 0.07 * k
            y = 0.17 - 0.014 * abs(k - 1.5)
            T((s * 0.68 - 0.12, y, z), (s * 0.68 + 0.12, y, z), 0.04, 0.04, BP, f"hand.{n_}")
        T((s * 0.53, 0.06, 0.47), (s * 0.55, 0.16, 0.37), 0.048, 0.04, BP, f"hand.{n_}")  # thumb on the inner side
        # Leg: gunmetal hip and thigh, kneecap, brass greave, ankle and a broad brass foot.
        B((s * 0.24, 0, 0.72), 0.11, GM, f"thigh.{n_}")
        T((s * 0.24, 0.0, 0.70), (s * 0.25, 0.04, 0.45), 0.10, 0.09, GM, f"thigh.{n_}")
        B((s * 0.25, 0.04, 0.42), 0.10, GM, f"shin.{n_}")
        B((s * 0.25, 0.13, 0.44), 0.09, BP, f"shin.{n_}", (1.0, 0.6, 1.0))
        T((s * 0.25, 0.035, 0.38), (s * 0.25, 0.005, 0.15), 0.14, 0.12, BP, f"shin.{n_}")
        B((s * 0.25, 0.0, 0.11), 0.075, GM, f"foot.{n_}")
        P.box((s * 0.25, 0.06, 0.05), (0.26, 0.40, 0.10), BP, f"foot.{n_}", taper=0.85)


def tile_uvs(bm) -> None:
    """UV0 in tile units: each face projected on the plane of its dominant normal axis."""
    layer = bm.loops.layers.uv.new("tile")
    for f in bm.faces:
        ax = max(range(3), key=lambda i: abs(f.normal[i]))
        u_i, v_i = ((1, 2), (0, 2), (0, 1))[ax]
        for loop in f.loops:
            loop[layer].uv = (loop.vert.co[u_i] / TILE_METERS, loop.vert.co[v_i] / TILE_METERS)


def build_body(bpy, bmesh, scene, detail: str, arm_obj):
    P = Parts(bmesh, detail)
    build_parts(P)
    bmesh.ops.recalc_face_normals(P.bm, faces=P.bm.faces[:])
    # Fixed triangulation here: the exporter's own quad split follows float noise between runs.
    bmesh.ops.triangulate(P.bm, faces=P.bm.faces[:], quad_method="FIXED", ngon_method="EAR_CLIP")
    P.bm.normal_update()
    tile_uvs(P.bm)
    me = bpy.data.meshes.new(f"{BODY}-{detail}")
    P.bm.to_mesh(me)
    P.bm.free()
    obj = bpy.data.objects.new(BODY if detail == "low" else f"{BODY}-{detail}", me)
    scene.collection.objects.link(obj)
    for name in BONE_NAMES:
        obj.vertex_groups.new(name=name)
    obj.parent = arm_obj
    obj.modifiers.new("armature", "ARMATURE").object = arm_obj
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
# Poses. Rotations are degrees about the armature axes, applied at each bone's head relative to its
# parent's posed frame: +X pitches a forward-pointing bone up (and swings a hanging limb forward),
# +Z yaws toward the left, +Y rolls the right side down. `pelvis_loc` is an armature-space offset.
# `ik` plants leg chains in the sagittal plane: {leg: (y, z[, distal extra pitch])} for the head of
# the distal bone (wrist or hock), which otherwise keeps its rest world orientation.


def _rot2(a: float, p):
    return (p[0] * math.cos(a) - p[1] * math.sin(a), p[0] * math.sin(a) + p[1] * math.cos(a))


def _ang(v) -> float:
    return math.atan2(v[1], v[0])


def _wrap(a: float) -> float:
    return math.atan2(math.sin(a), math.cos(a))


def world2d(name: str, pose: dict) -> tuple[float, tuple[float, float]]:
    """Sagittal (y, z) transform of a bone's posed frame: p -> R(A) p + t."""
    if PARENT[name] is None:
        return 0.0, (0.0, 0.0)
    ap, tp = world2d(PARENT[name], pose)
    rx, ry, rz = pose.get(name, (0, 0, 0))
    if abs(ry) > 1e-6 or abs(rz) > 1e-6:
        raise ValueError(f"leg solve needs a planar parent chain; {name} has ry/rz")
    th = math.radians(rx)
    h = HEAD[name][1:]
    loc = pose.get("pelvis_loc", (0, 0, 0))[1:] if name == LOC_BONE else (0.0, 0.0)
    rh = _rot2(th, h)
    local = (h[0] - rh[0] + loc[0], h[1] - rh[1] + loc[1])
    w = _rot2(ap, local)
    return ap + th, (w[0] + tp[0], w[1] + tp[1])


def leg_solve(pose: dict, leg: str, target) -> dict:
    upper, lower, distal, side = LEGS[leg]
    ap, tp = world2d(PARENT[upper], pose)
    hh = _rot2(ap, HEAD[upper][1:])
    hip = (hh[0] + tp[0], hh[1] + tp[1])
    l1 = math.dist(HEAD[upper][1:], HEAD[lower][1:])
    l2 = math.dist(HEAD[lower][1:], HEAD[distal][1:])
    dv = (target[0] - hip[0], target[1] - hip[1])
    d = min(max(math.hypot(*dv), abs(l1 - l2) + 1e-4), l1 + l2 - 1e-4)
    a = math.acos(max(-1.0, min(1.0, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))))
    beta = _ang(dv) + side * a
    knee = (hip[0] + l1 * math.cos(beta), hip[1] + l1 * math.sin(beta))
    rest_l = _ang((HEAD[distal][1] - HEAD[lower][1], HEAD[distal][2] - HEAD[lower][2]))
    rest_u = _ang((HEAD[lower][1] - HEAD[upper][1], HEAD[lower][2] - HEAD[upper][2]))
    tu = _wrap(beta - rest_u - ap)
    tl = _wrap(_ang((target[0] - knee[0], target[1] - knee[1])) - rest_l - ap - tu)
    extra = math.radians(target[2]) if len(target) > 2 else 0.0
    td = _wrap(extra - ap - tu - tl)
    return {upper: (math.degrees(tu), 0, 0), lower: (math.degrees(tl), 0, 0), distal: (math.degrees(td), 0, 0)}


def resolve(pose: dict) -> dict:
    out = {k: v for k, v in pose.items() if k in PARENT}
    for leg, target in pose.get("ik", {}).items():
        out.update(leg_solve(pose, leg, target))
    return out


REST_TARGET = {leg: HEAD[LEGS[leg][2]][1:] for leg in LEGS}
PLANT = dict(REST_TARGET)


def planted(**moved) -> dict:
    return {**PLANT, **{k.replace("_", "."): v for k, v in moved.items()}}


ARMS_REST = {"forearm.R": (6, 0, 0), "forearm.L": (6, 0, 0)}


def idle_pose(t: float) -> dict:
    w = 2 * math.pi * t / CLIPS["idle"]["duration"]
    b = math.sin(w)
    return {
        "pelvis_loc": (0, 0, 0.01 * b),
        "spine": (1.5 * b, 0, 0), "chest": (-1.0 * b, 0, 1.5 * math.sin(w)),
        "head": (2.0 * math.sin(2 * w), 0, 8.0 * math.sin(w)),
        "upperarm.R": (2.5 * b, 0, 0), "upperarm.L": (-2.5 * b, 0, 0),
        "forearm.R": (6 + 2 * b, 0, 0), "forearm.L": (6 - 2 * b, 0, 0),
        "chimney.R": (2.0 * math.sin(2 * w), 0, 0), "chimney.L": (-2.0 * math.sin(2 * w), 0, 0),
        "loc": {"bellows": (0, 0, -0.016 * (1 - math.cos(2 * w)))},
        "ik": PLANT,
    }


START = {**ARMS_REST, "ik": PLANT}
RAISED = {"pelvis_loc": (0, -0.03, 0.0), "spine": (7, 0, 0), "chest": (4, 0, 0), "head": (10, 0, 0),
          "upperarm.R": (158, 0, 0), "upperarm.L": (158, 0, 0), "forearm.R": (30, 0, 0), "forearm.L": (30, 0, 0),
          "hand.R": (10, 0, 0), "hand.L": (10, 0, 0), "loc": {"bellows": (0, 0, 0.01)}, "ik": PLANT}
SLAM = {"pelvis_loc": (0, 0.06, -0.16), "spine": (-16, 0, 0), "chest": (-12, 0, 0), "head": (-4, 0, 0),
        "upperarm.R": (34, 0, 0), "upperarm.L": (34, 0, 0), "forearm.R": (12, 0, 0), "forearm.L": (12, 0, 0),
        "hand.R": (-8, 0, 0), "hand.L": (-8, 0, 0), "chimney.R": (-8, 0, 0), "chimney.L": (-8, 0, 0),
        "loc": {"bellows": (0, 0, -0.03)}, "ik": PLANT}
ATTACK_KEYS = [
    (0.0, START),
    (0.45, RAISED),
    (0.62, {**RAISED, "upperarm.R": (166, 0, 0), "upperarm.L": (166, 0, 0), "spine": (9, 0, 0)}),
    (0.85, SLAM),
    (1.05, {**SLAM, "pelvis_loc": (0, 0.05, -0.14), "chimney.R": (4, 0, 0), "chimney.L": (4, 0, 0)}),
    (1.5, START),
]
HIT_KEYS = [
    (0.0, START),
    (0.12, {"pelvis_loc": (0, -0.06, -0.02), "spine": (8, 0, 4), "chest": (6, 0, 6), "head": (14, 0, -10),
            "upperarm.R": (-20, 0, 0), "upperarm.L": (-14, 0, 0), "forearm.R": (24, 0, 0), "forearm.L": (20, 0, 0),
            "chimney.R": (10, 0, 0), "chimney.L": (12, 0, 0), "loc": {"bellows": (0, 0, -0.03)}, "ik": PLANT}),
    (0.32, {"pelvis_loc": (0, -0.02, -0.008), "spine": (3, 0, 1), "chest": (2, 0, 2), "head": (5, 0, -3),
            "upperarm.R": (-6, 0, 0), "upperarm.L": (-4, 0, 0), "forearm.R": (12, 0, 0), "forearm.L": (10, 0, 0),
            "chimney.R": (-4, 0, 0), "chimney.L": (-4, 0, 0), "ik": PLANT}),
    (0.7, START),
]
DEATH_LIE = {"pelvis_loc": (0, 0.0, -0.30), "pelvis": (-84, 0, 0), "spine": (-4, 0, 2), "chest": (-2, 0, 0), "head": (-10, 0, 24),
             "upperarm.R": (8, -40, 0), "upperarm.L": (10, 36, 0), "forearm.R": (6, 0, 0), "forearm.L": (4, 0, 0),
             "hand.R": (0, 0, 0), "hand.L": (-4, 0, 0), "chimney.R": (-6, 0, 0), "chimney.L": (4, 0, 0),
             "thigh.R": (18, 0, 0), "shin.R": (-10, 0, 0), "foot.R": (30, 0, 0),
             "thigh.L": (12, 0, 0), "shin.L": (-6, 0, 0), "foot.L": (30, 0, 0)}
DEATH_KEYS = [
    (0.0, START),
    (0.25, HIT_KEYS[1][1]),
    (0.95, {"pelvis_loc": (0, 0.0, -0.24), "spine": (-12, 0, 0), "chest": (-8, 0, 0), "head": (-18, 0, 0),
            "upperarm.R": (22, 0, 0), "upperarm.L": (18, 0, 0), "forearm.R": (16, 0, 0), "forearm.L": (18, 0, 0),
            "loc": {"bellows": (0, 0, -0.04)}, "ik": PLANT}),
    (1.7, DEATH_LIE),
    (1.85, {**DEATH_LIE, "pelvis_loc": (0, 0.0, -0.27), "head": (-6, 0, 20)}),
    (2.4, DEATH_LIE),
]
FROZEN_POSE = {"pelvis_loc": (0, 0.03, -0.06), "spine": (-4, 0, -6), "chest": (-3, 0, -6), "head": (4, 0, 12),
               "upperarm.R": (58, 0, 0), "forearm.R": (52, 0, 0), "upperarm.L": (18, 0, 0), "forearm.L": (28, 0, 0),
               "chimney.R": (-5, 0, 0), "loc": {"bellows": (0, 0, -0.02)},
               "ik": planted(leg_R=(0.20, 0.15, 12))}


def clip_keys(name: str) -> list[tuple[float, dict]]:
    if name == "frozen":
        return [(0.0, FROZEN_POSE), (CLIPS["frozen"]["duration"], FROZEN_POSE)]
    return {"attack": ATTACK_KEYS, "hit": HIT_KEYS, "death": DEATH_KEYS}[name]


def _mix(a, b, u: float) -> tuple:
    return tuple(x + (y - x) * u for x, y in zip(a, b))


def blend(p0: dict, p1: dict, u: float) -> dict:
    """Pose between two keys. Legs planted in both keys interpolate their targets and are solved on
    the frame, so planted paws stay planted; everything else interpolates its angles."""
    ik0, ik1 = p0.get("ik", {}), p1.get("ik", {})
    common = set(ik0) & set(ik1)

    def angles(p: dict) -> dict:
        a = {k: v for k, v in p.items() if k in PARENT}
        for leg, target in p.get("ik", {}).items():
            if leg not in common:
                a.update(leg_solve(p, leg, target))
        return a

    a0, a1 = angles(p0), angles(p1)
    out: dict = {k: _mix(a0.get(k, (0, 0, 0)), a1.get(k, (0, 0, 0)), u) for k in sorted(set(a0) | set(a1))}
    out["pelvis_loc"] = _mix(p0.get("pelvis_loc", (0, 0, 0)), p1.get("pelvis_loc", (0, 0, 0)), u)
    l0, l1 = p0.get("loc", {}), p1.get("loc", {})
    out["loc"] = {k: _mix(l0.get(k, (0, 0, 0)), l1.get(k, (0, 0, 0)), u) for k in LOC_EXTRA}
    pad = lambda t: (*t, 0.0) if len(t) == 2 else tuple(t)  # noqa: E731
    out["ik"] = {leg: _mix(pad(ik0[leg]), pad(ik1[leg]), u) for leg in sorted(common)}
    return out


def sampled(name: str) -> list[tuple[int, dict]]:
    """One pose per frame: idle from its periodic function, the rest eased between keys."""
    last = round(CLIPS[name]["duration"] * FPS)
    if name == "idle":
        return [(f, idle_pose(f / FPS)) for f in range(last + 1)]
    keys = clip_keys(name)
    out = []
    for f in range(last + 1):
        t = f / FPS
        i = max(k for k in range(len(keys) - 1) if keys[k][0] <= t + 1e-9) if t < keys[-1][0] else len(keys) - 2
        (t0, p0), (t1, p1) = keys[i], keys[i + 1]
        u = min(1.0, max(0.0, (t - t0) / (t1 - t0)))
        out.append((f, blend(p0, p1, 0.5 - 0.5 * math.cos(math.pi * u))))
    return out


def apply_pose(arm_obj, pose: dict, frame: int | None) -> None:
    from mathutils import Euler, Vector

    res = resolve(pose)
    for pb in arm_obj.pose.bones:
        if pb.name == "root":
            continue
        r = pb.bone.matrix_local.to_quaternion()
        rx, ry, rz = res.get(pb.name, (0, 0, 0))
        q = Euler((math.radians(rx), math.radians(ry), math.radians(rz)), "XYZ").to_quaternion()
        pb.rotation_quaternion = r.inverted() @ q @ r
        if frame is not None:
            pb.keyframe_insert("rotation_quaternion", frame=frame)
        if pb.name == LOC_BONE or pb.name in LOC_EXTRA:
            loc = pose.get("pelvis_loc", (0, 0, 0)) if pb.name == LOC_BONE else pose.get("loc", {}).get(pb.name, (0, 0, 0))
            pb.location = r.inverted() @ Vector(loc)
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
        # Every frame is keyed (the leg solve runs per frame), so keys interpolate linearly.
        edit.keyframe_new_interpolation_type = "LINEAR"
        for f, pose in sampled(name):
            apply_pose(arm_obj, pose, f)
        actions[name] = act
    edit.keyframe_new_interpolation_type = "BEZIER"
    arm_obj.animation_data.action = None
    clear_pose(arm_obj)
    return actions


def deformed(bpy, body):
    import numpy as np

    ev = body.evaluated_get(bpy.context.evaluated_depsgraph_get())
    me = ev.to_mesh()
    co = np.empty(len(me.vertices) * 3, dtype=np.float64)
    me.vertices.foreach_get("co", co)
    ev.to_mesh_clear()
    return co.reshape(-1, 3) @ np.array(body.matrix_world.to_3x3()).T + np.array(body.matrix_world.translation)


def ground_clamp(bpy, scene, arm_obj, body, act, floor: float = 0.004) -> list:
    """Key the pelvis height on every frame so the lowest deformed vertex stays at `floor` or above
    (the pelvis carries every other bone, so a lift moves the whole body rigidly)."""
    from mathutils import Vector

    arm_obj.animation_data.action = act
    pb = arm_obj.pose.bones[LOC_BONE]
    r_inv = pb.bone.matrix_local.to_quaternion().inverted()
    last = round(CLIPS[act.name]["duration"] * FPS)
    lifts = []
    for _ in range(2):
        plan = []
        for f in range(last + 1):
            scene.frame_set(f)
            plan.append((f, Vector(pb.location), max(0.0, floor - float(deformed(bpy, body)[:, 2].min()))))
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


def pose_checks(bpy, scene, arm_obj, body, actions: dict) -> tuple[dict, dict]:
    """Deformed mesh on every clip frame: floor penetration, loop seams, final pose, and the sphere
    (runtime frame) that holds every frame of every clip, for the runtime's culling bound."""
    import numpy as np

    out = {}
    clouds = []
    for name, act in actions.items():
        arm_obj.animation_data.action = act
        last = round(CLIPS[name]["duration"] * FPS)
        mins, maxs, first, seam = [], [], None, 0.0
        for f in range(last + 1):
            scene.frame_set(f)
            co = deformed(bpy, body)
            clouds.append(co)
            mins.append(float(co[:, 2].min()))
            maxs.append(float(co[:, 2].max()))
            if f == 0:
                first = co
            if f == last:
                seam = float(np.abs(co - first).max())
        out[name] = {"frames": last + 1, "min_z": round(min(mins), 4), "min_z_frame": int(np.argmin(mins)),
                     "max_z": round(max(maxs), 4), "final_max_z": round(maxs[-1], 4), "final_min_z": round(mins[-1], 4),
                     "loop_seam_m": round(seam, 5)}
    arm_obj.animation_data.action = None
    clear_pose(arm_obj)
    scene.frame_set(0)
    pts = np.concatenate(clouds)
    c = (pts.min(axis=0) + pts.max(axis=0)) / 2
    radius = float(np.linalg.norm(pts - c, axis=1).max())
    rt = [float(c[0]), float(c[2]), float(-c[1])]
    d_sentry = float(np.linalg.norm(pts - np.array([0.0, 0.0, 1.0]), axis=1).max())
    cull = {"center": [round(v, 3) + 0.0 for v in rt], "radius": round(radius + 0.05, 3),
            "maxDistanceFromSentryCullCentre": round(d_sentry, 3)}
    return out, cull


# --------------------------------------------------------------------------------------------------
# Materials


def _principled(mat, name: str):
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    rgb, rough, metal = FACTORS[name]
    bsdf.inputs["Base Color"].default_value = (*(lin(c) for c in rgb), 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if name == GLOW:
        bsdf.inputs["Emission Color"].default_value = (*(lin(c) for c in GLOW_SRGB), 1.0)
        bsdf.inputs["Emission Strength"].default_value = GLOW_STRENGTH
    return bsdf


def export_materials(bpy) -> list:
    out = []
    for name in MATS:
        mat = bpy.data.materials.new(name)
        if mat.name != name:
            raise RuntimeError(f"material name {name} is taken ({mat.name})")
        _principled(mat, name)
        mat.use_backface_culling = True  # closed parts: single-sided export
        out.append(mat)
    return out


def source_materials(bpy) -> list:
    """Review and edit materials: the shared PNG sets on UV0 for the set-bound slots."""
    out = []
    for name in MATS:
        mat = bpy.data.materials.new(f"{PIECE}-{name}")
        bsdf = _principled(mat, name)
        if name in SETS:
            nt = mat.node_tree
            uvn = nt.nodes.new("ShaderNodeUVMap")
            uvn.uv_map = "tile"
            tex = {}
            for role in ("basecolor", "normal", "orm"):
                img = bpy.data.images.load(str(MATERIAL_DIR / name / f"{name}.{role}.png"), check_existing=True)
                img.colorspace_settings.name = "sRGB" if role == "basecolor" else "Non-Color"
                tex[role] = nt.nodes.new("ShaderNodeTexImage")
                tex[role].image = img
                nt.links.new(uvn.outputs["UV"], tex[role].inputs["Vector"])
            nt.links.new(tex["basecolor"].outputs["Color"], bsdf.inputs["Base Color"])
            sep = nt.nodes.new("ShaderNodeSeparateColor")
            nt.links.new(tex["orm"].outputs["Color"], sep.inputs["Color"])
            nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
            nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
            nm = nt.nodes.new("ShaderNodeNormalMap")
            nm.uv_map = "tile"
            nm.inputs["Strength"].default_value = SETS[name]
            nt.links.new(tex["normal"].outputs["Color"], nm.inputs["Color"])
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
    "socket-hit": ("chest", (0, 0.56, 1.38)),  # in front of the amber core: hit sparks and aim point
    "socket-eye": ("head", (0, 0.2, 1.76)),  # between the eyes
    "socket-weapon": ("hand.R", (0.68, 0.22, 0.40)),  # the striking right fist
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
        filepath=str(path), export_format="GLB", use_selection=True, use_active_scene=True,
        export_texcoords=True, export_normals=True, export_tangents=False,  # three derives tangents
        export_materials="EXPORT", export_image_format="NONE", export_cameras=False, export_lights=False,
        export_skins=True, export_all_influences=False, export_def_bones=False,
        export_animations=True, export_animation_mode="ACTIONS", export_force_sampling=True,
        export_optimize_animation_size=False,  # `frozen` is constant and must keep its channels
        export_frame_range=False, export_anim_single_armature=True, export_reset_pose_bones=True,
        export_rest_position_armature=True, export_apply=False, export_yup=True,
    )


def parse_glb(data: bytes):
    import numpy as np

    magic, _v, _len = struct.unpack_from("<III", data, 0)
    if magic != 0x46546C67:
        raise ValueError("not a GLB")
    jlen = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20 : 20 + jlen])
    blen = struct.unpack_from("<I", data, 20 + jlen)[0]
    bin_off = 28 + jlen

    def accessor(i: int):
        acc = gltf["accessors"][i]
        view = gltf["bufferViews"][acc["bufferView"]]
        dtype = np.dtype({5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}[acc["componentType"]])
        ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[acc["type"]]
        start = bin_off + view.get("byteOffset", 0) + acc.get("byteOffset", 0)
        stride = view.get("byteStride") or dtype.itemsize * ncomp
        rows = np.frombuffer(data, dtype=np.uint8, count=stride * (acc["count"] - 1) + dtype.itemsize * ncomp, offset=start)
        idx = (np.arange(acc["count"])[:, None] * stride + np.arange(dtype.itemsize * ncomp)[None, :])
        arr = rows[idx].copy().view(dtype).reshape(acc["count"], ncomp)
        if acc.get("normalized"):
            arr = arr.astype(np.float64) / float(np.iinfo(dtype).max)
        return arr if ncomp > 1 else arr[:, 0]

    return gltf, accessor, (bin_off, blen)


def sort_triangles(path: Path) -> int:
    """Rewrites each primitive's index buffer with its triangles in a canonical order (each rotated
    to start at its lowest index, which keeps the winding, then sorted). The exporter emits the same
    triangles in a run-dependent order for smooth-shaded parts; this makes the GLB byte-stable."""
    import numpy as np

    data = bytearray(path.read_bytes())
    gltf, _acc, (bin_off, _blen) = parse_glb(bytes(data))
    n = 0
    for mesh in gltf["meshes"]:
        for prim in mesh["primitives"]:
            a = gltf["accessors"][prim["indices"]]
            view = gltf["bufferViews"][a["bufferView"]]
            dtype = np.dtype({5125: np.uint32, 5123: np.uint16, 5121: np.uint8}[a["componentType"]])
            start = bin_off + view.get("byteOffset", 0) + a.get("byteOffset", 0)
            end = start + a["count"] * dtype.itemsize
            tri = np.frombuffer(bytes(data[start:end]), dtype=dtype).reshape(-1, 3)
            k = np.argmin(tri, axis=1)[:, None]
            tri = np.take_along_axis(tri, (k + np.arange(3)[None, :]) % 3, axis=1)
            tri = tri[np.lexsort((tri[:, 2], tri[:, 1], tri[:, 0]))]
            data[start:end] = tri.astype(dtype).tobytes()
            n += 1
    path.write_bytes(bytes(data))
    return n


def trs(node):
    import numpy as np

    if "matrix" in node:
        return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
    x, y, z, w = node.get("rotation", [0, 0, 0, 1])
    r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                  [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                  [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    m = np.eye(4)
    m[:3, :3] = r * np.array(node.get("scale", [1, 1, 1]))
    m[:3, 3] = node.get("translation", [0, 0, 0])
    return m


def gate_glb(path: Path) -> dict:
    """Reimport gate on the shipped bytes: budgets, skin, clips, root motion, bounds, sockets."""
    import numpy as np

    g, acc, _ = parse_glb(path.read_bytes())
    errors: list[str] = []
    nodes = g["nodes"]
    names = [n.get("name", "") for n in nodes]
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}

    def world(i: int):
        m = trs(nodes[i])
        while i in parent:
            i = parent[i]
            m = trs(nodes[i]) @ m
        return m

    prims = [p for mesh in g.get("meshes", []) for p in mesh["primitives"]]
    tris = 0
    for p in prims:
        if p.get("mode", 4) != 4:
            errors.append("non-triangle primitive")
        tris += g["accessors"][p["indices"]]["count"] // 3
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
    if skins and not np.all(np.isfinite(acc(skins[0]["inverseBindMatrices"]))):
        errors.append("non-finite inverse bind matrices")

    wsum_err, max_inf, zero, nverts, pos = 0.0, 0, 0, 0, []
    for p in prims:
        at = p["attributes"]
        if "WEIGHTS_0" not in at or "JOINTS_0" not in at:
            errors.append("primitive without JOINTS_0/WEIGHTS_0")
            continue
        if "WEIGHTS_1" in at:
            errors.append("more than 4 influences exported (WEIGHTS_1)")
        w = acc(at["WEIGHTS_0"]).astype(np.float64)
        s = w.sum(axis=1)
        nverts += len(w)
        wsum_err = max(wsum_err, float(np.abs(s - 1).max()))
        zero += int((s <= 1e-6).sum())
        max_inf = max(max_inf, int((w > 1e-6).sum(axis=1).max()))
        if int(acc(at["JOINTS_0"]).max()) >= len(joints):
            errors.append("joint index out of range")
        pos.append(acc(at["POSITION"]).astype(np.float64))
    if wsum_err > 2e-3:
        errors.append(f"weight sums off by {wsum_err}")
    if zero:
        errors.append(f"{zero} unweighted vertices")
    if max_inf > LIMITS["influences"]:
        errors.append(f"{max_inf} influences")
    mesh_nodes = [i for i, n in enumerate(nodes) if "mesh" in n]
    mw = world(mesh_nodes[0]) if mesh_nodes else np.eye(4)
    pts = np.concatenate(pos) @ mw[:3, :3].T + mw[:3, 3]
    bmin, bmax = pts.min(axis=0), pts.max(axis=0)
    if abs(bmin[1]) > 1e-3:
        errors.append(f"rest pose min y {bmin[1]:.4f}, want 0 (root on the floor)")
    if not HEIGHT_RANGE[0] <= bmax[1] <= HEIGHT_RANGE[1]:
        errors.append(f"height {bmax[1]:.3f} outside {HEIGHT_RANGE} m")

    clips = {}
    root_i = names.index("root") if "root" in names else -1
    for a in g.get("animations", []):
        dur = max(float(g["accessors"][s["input"]]["max"][0]) for s in a["samplers"])
        start = min(float(g["accessors"][s["input"]]["min"][0]) for s in a["samplers"])
        moved = []
        for ch in a["channels"]:
            if ch["target"].get("node") == root_i:
                out = acc(a["samplers"][ch["sampler"]]["output"]).astype(np.float64)
                if out.size and float(np.abs(out - out[0]).max()) > 1e-5:
                    moved.append(ch["target"]["path"])
        clips[a["name"]] = {"duration": round(dur, 4), "start": round(start, 4), "channels": len(a["channels"]), "rootAnimated": moved}
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
        if i not in parent or names[parent[i]] != bone:
            errors.append(f"{sname} is not parented to {bone}")
        sockets[sname] = {"bone": bone, "parent": names[parent[i]] if i in parent else None, "position": [round(float(v), 4) + 0.0 for v in p]}
    return {
        "glb_sha256": sha256(path), "glb_bytes": path.stat().st_size, "triangles": tris, "materials": mats, "vertices": nverts,
        "joints": joint_names, "bone_count": len(joints), "max_influences": max_inf, "max_weight_sum_error": round(wsum_err, 6),
        "unweighted_vertices": zero,
        "bounds": {"min": [round(float(v), 4) + 0.0 for v in bmin], "max": [round(float(v), 4) + 0.0 for v in bmax]},
        "clips": clips, "sockets": sockets, "scene_roots": [names[i] for i in g["scenes"][g.get("scene", 0)]["nodes"]],
        "errors": errors, "pass": not errors,
    }


def blender_reimport(bpy, path: Path) -> dict:
    scene = bpy.data.scenes.new("reimport")
    with bpy.context.temp_override(scene=scene, view_layer=scene.view_layers[0]):
        before = set(bpy.data.actions)
        bpy.ops.import_scene.gltf(filepath=str(path), disable_bone_shape=True)
        arms = [o for o in scene.objects if o.type == "ARMATURE"]
        out = {"armatures": len(arms), "bones": len(arms[0].data.bones) if arms else 0,
               "meshes": len([o for o in scene.objects if o.type == "MESH"]),
               "actions": sorted(a.name for a in bpy.data.actions if a not in before), "objects": sorted(o.name for o in scene.objects)}
    for o in list(scene.objects):
        bpy.data.objects.remove(o)
    for a in [a for a in bpy.data.actions if a.name in out["actions"] and not a.use_fake_user]:
        bpy.data.actions.remove(a)
    bpy.data.scenes.remove(scene)
    return out


def build_manifest(gate: dict, cull: dict) -> dict:
    return {
        "id": PIECE,
        "version": 1,
        "glb": f"{PIECE}.glb",
        "frame": {"units": "m", "up": "+Y", "forward": "-Z", "origin": "feet centre on the floor (y = 0)",
                  "note": "encounter.ts rotation.y = -heading turns local -Z onto the heading"},
        "root": PIECE,
        "mesh": BODY,
        "bounds": gate["bounds"],
        "skeleton": {"root": "root", "bones": gate["bone_count"], "joints": gate["joints"], "maxInfluences": gate["max_influences"],
                     "skinning": "rigid: every vertex weighted 1.0 to one bone"},
        "rootMotion": "code-owned: the root joint is never animated and every clip plays in place",
        "clips": {name: {"duration": gate["clips"][name]["duration"], "loop": spec["loop"], "events": spec["events"],
                         **({"held": True} if name == "frozen" else {}), **({"endsOnFloor": True} if name == "death" else {})}
                  for name, spec in CLIPS.items()},
        "sockets": gate["sockets"],
        "emissive": {"material": GLOW, "color": "#{:02X}{:02X}{:02X}".format(*GLOW_SRGB), "intensity": GLOW_STRENGTH,
                     "nodes": ["socket-eye", "socket-hit"]},
        "materialSlots": {name: ({"set": name, "tileMeters": TILE_METERS, "normalScale": SETS[name]} if name in SETS
                                 else {"set": None, "factorOnly": True, **({"emissive": True} if name == GLOW else {})}) for name in MATS},
        "budget": {"tris": gate["triangles"], "materials": len(gate["materials"]), "bones": gate["bone_count"], "influences": LIMITS["influences"]},
        "cull": {"center": cull["center"], "radius": cull["radius"]},
    }


# --------------------------------------------------------------------------------------------------
# Review renders (EEVEE)

VIEWS = {"front": ((0, 5.4, 1.2), (0, 0, 1.0)), "side": ((5.4, 0, 1.2), (0, 0, 1.0)),
         "back": ((0, -5.4, 1.2), (0, 0, 1.0)), "three-quarter": ((3.4, 4.2, 1.9), (0, 0, 1.0))}
ANIM_CAMERA = ((3.8, 3.8, 2.0), (0, 0.2, 0.95), 40.0)
ROM = {"rig-rom-reach": {"upperarm.R": (150, 0, 0), "forearm.R": (40, 0, 0), "upperarm.L": (0, -50, 0), "forearm.L": (70, 0, 0),
                         "head": (0, 0, 30), "chest": (0, 0, 15), "chimney.R": (14, 0, 0), "ik": PLANT},
       "rig-rom-crouch": {"pelvis_loc": (0, 0, -0.2), "spine": (-15, 0, 0), "upperarm.R": (30, 0, 0), "upperarm.L": (30, 0, 0),
                          "forearm.R": (40, 0, 0), "forearm.L": (40, 0, 0), "loc": {"bellows": (0, 0, -0.04)}, "ik": PLANT}}
FRAMES = {"anim-idle": ("idle", 0.6), "anim-attack-raise": ("attack", 0.55), "anim-attack-slam": ("attack", 0.85),
          "anim-hit": ("hit", 0.12), "anim-frozen": ("frozen", 0.0), "anim-death-kneel": ("death", 0.95), "anim-death-end": ("death", 2.4)}


def setup_render(scene, w: int = 640, h: int = 640) -> None:
    for engine in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = w, h, 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"
    try:
        scene.eevee.taa_render_samples = 16
    except AttributeError:
        pass


def stage(bpy, scene) -> None:
    from mathutils import Vector

    world = bpy.data.worlds.new(f"{PIECE}-review-world")
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (0.16, 0.11, 0.07, 1.0)
    scene.world = world
    for name, loc, energy, color in (("key", (-1.6, 2.2, 2.4), 380.0, (1.0, 0.8, 0.55)),
                                     ("fill", (2.2, 1.6, 1.2), 110.0, (1.0, 0.88, 0.72)),
                                     ("rim", (0.8, -2.4, 2.0), 240.0, (1.0, 0.72, 0.42))):
        data = bpy.data.lights.new(f"{PIECE}-{name}", "AREA")
        data.energy, data.color, data.size = energy, color, 1.5
        o = bpy.data.objects.new(data.name, data)
        o.location = loc
        o.rotation_euler = (Vector((0, 0, 0.7)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(o)
    me = bpy.data.meshes.new("review-floor")
    me.from_pydata([(-3, -3, 0), (3, -3, 0), (3, 3, 0), (-3, 3, 0)], [], [(0, 1, 2, 3)])
    mat = bpy.data.materials.new("review-floor")
    next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = (0.05, 0.04, 0.035, 1)
    me.materials.append(mat)
    scene.collection.objects.link(bpy.data.objects.new("review-floor", me))


def aim(bpy, scene, loc, target, lens: float = 50.0) -> None:
    from mathutils import Vector

    cam = scene.camera
    if cam is None:
        cam = bpy.data.objects.new(f"review-cam-{scene.name}", bpy.data.cameras.new(f"review-cam-{scene.name}"))
        scene.collection.objects.link(cam)
        scene.camera = cam
    cam.data.lens = lens
    cam.location = loc
    cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()


def shoot(bpy, scene, path: Path) -> None:
    bpy.context.view_layer.update()
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True, scene=scene.name)


def renders(bpy, low_scene, high_scene, arm, actions: dict, out: Path) -> list[str]:
    rdir = out / "renders"
    rdir.mkdir(parents=True, exist_ok=True)
    done = []
    for sc in (low_scene, high_scene):
        setup_render(sc)
        stage(bpy, sc)
    for view, (loc, tgt) in VIEWS.items():
        aim(bpy, low_scene, loc, tgt)
        shoot(bpy, low_scene, rdir / f"model-low-{view}.png")
        done.append(f"model-low-{view}")
    with bpy.context.temp_override(scene=high_scene, view_layer=high_scene.view_layers[0]):
        if bpy.context.window is not None:
            bpy.context.window.scene = high_scene
        aim(bpy, high_scene, *VIEWS["three-quarter"])
        shoot(bpy, high_scene, rdir / "model-high-three-quarter.png")
        done.append("model-high-three-quarter")
    if bpy.context.window is not None:
        bpy.context.window.scene = low_scene
    aim(bpy, low_scene, *VIEWS["three-quarter"])
    for name, pose in ROM.items():
        apply_pose(arm, pose, None)
        shoot(bpy, low_scene, rdir / f"{name}.png")
        done.append(name)
    clear_pose(arm)
    aim(bpy, low_scene, *ANIM_CAMERA)
    for name, (clip, t) in FRAMES.items():
        arm.animation_data.action = actions[clip]
        low_scene.frame_set(round(t * FPS))
        shoot(bpy, low_scene, rdir / f"{name}.png")
        done.append(name)
    arm.animation_data.action = None
    clear_pose(arm)
    low_scene.frame_set(0)
    return done


# --------------------------------------------------------------------------------------------------
# Review sheet (system Python + Pillow)

ENGINE_SHOTS = ["idle", "attack", "hit", "frozen", "death"]
APPROVAL_NOTE = ('Concept approval PENDING (Paul). Modeled under Paul\'s standing approval of 2026-11-15: "you have standing approval '
                 'for all spending / modeling / deployments needed for this project". Model, rig, animation approvals pending.')


def compose_sheet(out: Path) -> Path:
    from PIL import Image, ImageDraw

    r = out / "renders"
    eng = out / "engine"
    sections = [
        ("REFERENCE - golem-sheet-1.png (concept; owner approval PENDING)", [("concept sheet", CONCEPT)]),
        ("MODEL - textured Blender renders (shared brass and walnut sets), approval PENDING", [
            ("low front", r / "model-low-front.png"), ("low side", r / "model-low-side.png"), ("low back", r / "model-low-back.png"),
            ("low 3/4", r / "model-low-three-quarter.png"), ("high source 3/4", r / "model-high-three-quarter.png")]),
        (f"RIG - approval PENDING: {len(BONES)} bones, rigid 1-bone skinning, planar leg solve", [
            ("range of motion: reach", r / "rig-rom-reach.png"), ("range of motion: crouch", r / "rig-rom-crouch.png"),
            ("attack fists raised 0.55 s", r / "anim-attack-raise.png"), ("attack slam 0.85 s", r / "anim-attack-slam.png"),
            ("death kneel 0.95 s", r / "anim-death-kneel.png")]),
        ("ANIMATION - Blender frames, approval PENDING", [
            ("idle 0.6 s", r / "anim-idle.png"), ("attack slam (impact) 0.85 s", r / "anim-attack-slam.png"), ("hit 0.12 s", r / "anim-hit.png"),
            ("frozen (held)", r / "anim-frozen.png"), ("death end 2.4 s", r / "anim-death-end.png")]),
        ("IN ENGINE - three.js 0.186.1, headless Chromium on the GPU, seated player 2.6 m away", [
            (name, eng / f"{name}.jpg") for name in ENGINE_SHOTS]),
    ]
    tw, th, pad, cap, head = 360, 360, 10, 24, 34
    cols = 5
    sheet = Image.new("RGB", (cols * (tw + pad) + pad, 70 + len(sections) * (head + th + cap + pad) + pad), (28, 24, 22))
    d = ImageDraw.Draw(sheet)
    d.text((pad, 12), f"P5-T3 Bellows Golem ({PIECE}) - owner review sheet", fill=(243, 190, 101))
    d.text((pad, 34), APPROVAL_NOTE, fill=(222, 193, 106))
    y = 70
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
    path = out.parent / f"{PIECE}.review-sheet.jpg"
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
    if tris_low > LIMITS["tris"]:
        raise RuntimeError(f"{tris_low} triangles over budget")

    report: dict = {
        "piece": PIECE,
        "blender": bpy.app.version_string,
        "generator": f"scripts/assets/build-{PIECE}.py",
        "generator_sha256": sha256(Path(__file__).resolve()),
        "concept": {"file": str(CONCEPT.relative_to(REPO)), "sha256": sha256(CONCEPT),
                    "status": "owner approval pending; modeled under Paul's standing approval of 2026-11-15"},
        "source_materials": {n: {role: sha256(MATERIAL_DIR / n / f"{n}.{role}.png") for role in ("basecolor", "normal", "orm")} for n in SETS},
        "triangles": {"low": tris_low, "high": tris_high},
        "bones": len(BONES),
        "authoringAgent": "Claude Code subagent (claude-opus-5-5), dispatched by the rogue-xr primary session",
    }

    export_mats = export_materials(bpy)
    src_mats = source_materials(bpy)
    set_slots(body, export_mats)
    set_slots(body_high, src_mats)
    actions = author_clips(bpy, arm)
    report["ground_clamp_death_max_lift_m"] = ground_clamp(bpy, low_scene, arm, body, actions["death"])
    pc, cull = pose_checks(bpy, low_scene, arm, body, actions)
    report["pose_checks"] = pc
    report["cull"] = cull
    pose_errors = [f"{n}: min z {c['min_z']} at frame {c['min_z_frame']}" for n, c in pc.items() if c["min_z"] < -0.03]
    if pc["death"]["final_max_z"] > DEATH_MAX_Z or pc["death"]["final_min_z"] < -0.02:
        pose_errors.append(f"death does not end lying on the floor: {pc['death']}")
    for n in ("idle", "frozen"):
        if pc[n]["loop_seam_m"] > 1e-3:
            pose_errors.append(f"{n} loop seam {pc[n]['loop_seam_m']} m")
    print(json.dumps(pc, indent=1), json.dumps(cull))

    sockets = add_sockets(bpy, low_scene, arm)
    arm.animation_data.action = None
    clear_pose(arm)
    low_scene.frame_set(0)
    glb = runtime / f"{PIECE}.glb"
    export_glb(bpy, [arm, body, *sockets.values()], arm, glb)
    report["canonicalized_primitives"] = sort_triangles(glb)
    gate = gate_glb(glb)
    gate["errors"] += pose_errors
    br = blender_reimport(bpy, glb)
    gate["blender_reimport"] = br
    # Reimported names carry a numeric suffix because the authored datablocks are still loaded.
    if br["bones"] != len(BONES) or {re.sub(r"\.\d{3}$", "", a) for a in br["actions"]} != set(CLIPS):
        gate["errors"].append(f"blender reimport mismatch: {br}")
    gate["pass"] = not gate["errors"]
    report["reimport"] = gate
    (out / "reimport.json").write_text(json.dumps(gate, indent=2) + "\n")
    if gate["errors"]:
        (out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        raise RuntimeError(f"gate failed: {gate['errors']}")
    (runtime / f"{PIECE}.manifest.json").write_text(json.dumps(build_manifest(gate, cull), indent=2) + "\n")

    set_slots(body, src_mats)
    bpy.data.libraries.write(str(blend_dir / f"{PIECE}.low.blend"), {low_scene, *actions.values()}, path_remap="RELATIVE_ALL", compress=True)
    bpy.data.libraries.write(str(blend_dir / f"{PIECE}.high.blend"), {high_scene}, path_remap="RELATIVE_ALL", compress=True)

    if not args.skip_renders:
        t0 = time.monotonic()
        report["renders"] = renders(bpy, low_scene, high_scene, arm, actions, out)
        report["render_seconds"] = round(time.monotonic() - t0, 1)

    report["files"] = {
        (str(p.relative_to(REPO)) if p.is_relative_to(REPO) else str(p)): sha256(p)
        for p in sorted([*runtime.iterdir(), *blend_dir.iterdir(), out / "reimport.json"])
        if p.is_file() and p.suffix in {".glb", ".json", ".blend"}
    }
    report["total_seconds"] = round(time.monotonic() - t_start, 1)
    (out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: gate[k] for k in ("triangles", "bone_count", "max_influences", "bounds", "clips", "sockets")}, indent=1))
    print(f"[{PIECE}] PASS glb sha256 {gate['glb_sha256']}")


if __name__ == "__main__":
    ARGS = parse_args()
    if ARGS.sheet:
        print(compose_sheet(ARGS.out.resolve()))
    else:
        main_blender(ARGS)
