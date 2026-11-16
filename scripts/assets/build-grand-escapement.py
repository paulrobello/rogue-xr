"""P5-T4 Grand Escapement: the floor guardian, a 3.2 m automaton whose torso is a tall walnut
longcase clock (plinth with a bracket-foot apron, a trunk with glazed double doors over the
pendulum and the escapement wheel, a hood with the dial face between turned brass columns, a
broken-arch pediment) on long armoured brass legs, with long arms ending in anchor-shaped pallet
claws and a bell crown (concept assets-source/concepts/escapement-sheet-1.png, notes
assets-source/concepts/p5-automatons-design.md, style docs/art-bible.md; the sheet drifted to a
squat cabinet, so the case follows the notes: taller and narrower). Built procedurally from shaped
parts (bevelled boxes and mouldings, lofted superellipse limbs, lathed shells and columns, swept
bands and fluke arcs, extruded outlines for the wheel, hands, pediment, key and arrowheads), each
weighted 1.0 to one bone of a 40-bone armature. Clips: the five automaton clips of the Cog Sentry
contract (P4-T6) plus `phase-change` (one-shot, ends held open): the glazed doors and the side
case plates spring open on their hinge bones, the glowing corona slides out from behind the back
board round the escapement wheel, the wheel and the dial hands race and the key spins. Every part
that opens is a rigid bone already present, closed, in phase 1; every other clip keys it closed.
Exported as an image-free skinned GLB whose set-bound slots carry the names of the shared P4-T3
sets (`public/assets/materials/`: brass-polished and walnut), so the runtime binds them by name.
UV0 is in tile units (metres / tileMeters). The manifest uses the sentry's schema plus an optional
`cull` sphere measured over every clip frame.

Blender run (build, pose checks, export, reimport gate, manifest, renders, .blend sources):
    "$BLENDER" -b --factory-startup --python-exit-code 1 -P scripts/assets/build-grand-escapement.py -- \
        [--out assets-source/enemies/grand-escapement/staging] [--runtime public/assets/enemies/grand-escapement] \
        [--blend-dir assets-source/enemies/grand-escapement/blend] [--skip-renders] [--compare-only]
Review sheet (system Python with Pillow, after the Blender run and the engine shots):
    python3 -I scripts/assets/build-grand-escapement.py --sheet [--out ...]

Frame: Blender is Z-up; runtime (x, y, z) = Blender (x, z, -y). The guardian faces Blender +Y,
which is runtime -Z (encounter.ts sets rotation.y = -heading). The root sits at the feet (runtime
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
PIECE = "grand-escapement"
BODY = "escapement-body"
DEFAULT_OUT = REPO / f"assets-source/enemies/{PIECE}/staging"
DEFAULT_RUNTIME = REPO / f"public/assets/enemies/{PIECE}"
DEFAULT_BLEND = REPO / f"assets-source/enemies/{PIECE}/blend"
MATERIAL_DIR = REPO / "public/assets/materials"
CONCEPT = REPO / "assets-source/concepts/escapement-sheet-1.png"
# Concept panels in sheet pixels (2752x1536): front, side, back (top row, phase 1).
CONCEPT_CROPS = {"front": (140, 20, 1060, 850), "side": (1130, 20, 1630, 850), "back": (1762, 20, 2682, 850)}
FPS = 30
HEIGHT_RANGE = (3.1, 3.3)  # metres to the bell finial, rest pose (design notes: about 3.2 m)
DEATH_MAX_Z = 1.2  # lying prone: the case is 0.45 m deep, the anchors and pauldrons stand proud

LIMITS = {"tris": 40_000, "materials": 4, "bones": 60, "influences": 4}
GLOW = "escapement-glow"
MATS = ["brass-polished", "walnut", "gunmetal", GLOW]
BP, WN, GM, GL = range(4)
JW = GM  # no jewel slot on the guardian (4-material cap): the inlays are gunmetal
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
JEWEL = None


def _add(a, b, k=1.0):
    return tuple(x + k * y for x, y in zip(a, b))


# Case layout (Blender metres): plinth, trunk with doors, waist moulding, hood with dial, pediment.
PLINTH = (1.08, 1.36)
TRUNK = (1.36, 2.22)
HOOD = (2.24, 2.70)
CASE_W, CASE_D = 0.52, 0.34  # trunk outer width and depth
WHEEL_C = (0.0, -0.072, 1.97)
PALLET_C = (0.0, -0.03, 2.11)
BOB_Z = 1.56
DIAL_C = (0.0, 0.205, 2.46)
KEY_C = (0.0, -0.17, 1.98)
DOOR_Z = (1.43, 2.15)
SH = (0.35, 0.0, 2.17)
EL = (0.62, 0.0, 1.66)
WR = (0.86, 0.0, 1.12)
ANCHOR_LEN = 0.52

# Armature: name, parent, head, tail (Blender metres). R is Blender +X. Door, plate, wheel, dial,
# key bones sit on their hinge or axle and point along it, so a roll about the bone's own axis
# ("spin" in the poses) swings or turns the part.
BONES: list[tuple[str, str | None, tuple, tuple]] = [
    ("root", None, (0, 0, 0), (0, 0, 0.2)),
    ("pelvis", "root", (0, 0, 1.20), (0, 0, 1.36)),
    ("spine", "pelvis", (0, 0, 1.36), (0, 0, 1.70)),
    ("chest", "spine", (0, 0, 1.70), (0, 0, 2.70)),
    ("neck", "chest", (0, -0.02, 2.70), (0, -0.02, 2.86)),
    ("head", "neck", (0, -0.02, 2.86), (0, -0.02, 3.08)),
    ("bell", "head", (0, -0.02, 3.08), (0, -0.02, 3.18)),
    ("clapper", "bell", (0, -0.02, 3.15), (0, -0.02, 3.08)),
    ("door.R", "chest", (0.232, 0.17, DOOR_Z[0]), (0.232, 0.17, DOOR_Z[1])),
    ("door.L", "chest", (-0.232, 0.17, DOOR_Z[0]), (-0.232, 0.17, DOOR_Z[1])),
    ("plate.R", "chest", (0.262, -0.158, 1.40), (0.262, -0.158, 2.18)),
    ("plate.L", "chest", (-0.262, -0.158, 1.40), (-0.262, -0.158, 2.18)),
    ("pallet", "chest", PALLET_C, _add(PALLET_C, (0, 0, -0.12))),
    ("pendulum", "pallet", PALLET_C, (0, -0.03, BOB_Z + 0.08)),
    ("bob", "pendulum", (0, -0.03, BOB_Z + 0.08), (0, -0.03, BOB_Z - 0.08)),
    ("wheel", "chest", WHEEL_C, _add(WHEEL_C, (0, 0.1, 0))),
    ("corona", "chest", _add(WHEEL_C, (0, -0.064, 0)), _add(WHEEL_C, (0, 0.04, 0))),
    ("dial.hour", "chest", DIAL_C, _add(DIAL_C, (0, 0.1, 0))),
    ("dial.minute", "chest", DIAL_C, _add(DIAL_C, (0, 0.12, 0))),
    ("key", "chest", KEY_C, _add(KEY_C, (0, -0.12, 0))),
]
for _s, _n in ((1, "R"), (-1, "L")):
    _d = tuple((w - e) for w, e in zip(WR, EL))
    _dl = math.hypot(_d[0], _d[2])
    _u = (_d[0] / _dl, 0.0, _d[2] / _dl)
    _crown = (_s * (WR[0] + _u[0] * (ANCHOR_LEN + 0.06)), 0.0, WR[2] + _u[2] * (ANCHOR_LEN + 0.06))
    BONES += [
        (f"clavicle.{_n}", "chest", (_s * 0.08, 0, 2.18), (_s * 0.30, 0, 2.18)),
        (f"upperarm.{_n}", f"clavicle.{_n}", (_s * SH[0], 0, SH[2]), (_s * EL[0], 0, EL[2])),
        (f"forearm.{_n}", f"upperarm.{_n}", (_s * EL[0], 0, EL[2]), (_s * WR[0], 0, WR[2])),
        (f"hand.{_n}", f"forearm.{_n}", (_s * WR[0], 0, WR[2]), (_s * (WR[0] + _u[0] * 0.08), 0.0, WR[2] + _u[2] * 0.08)),
        (f"claw.{_n}", f"hand.{_n}", (_s * (WR[0] + _u[0] * 0.06), 0.0, WR[2] + _u[2] * 0.06), _crown),
        (f"fluke.in.{_n}", f"claw.{_n}", _crown, _add(_crown, (-_s * 0.12, 0, 0.06))),
        (f"fluke.out.{_n}", f"claw.{_n}", _crown, _add(_crown, (_s * 0.12, 0, 0.06))),
        (f"thigh.{_n}", "pelvis", (_s * 0.15, 0, 1.20), (_s * 0.17, 0.02, 0.66)),
        (f"shin.{_n}", f"thigh.{_n}", (_s * 0.17, 0.02, 0.66), (_s * 0.17, -0.01, 0.13)),
        (f"foot.{_n}", f"shin.{_n}", (_s * 0.17, -0.01, 0.13), (_s * 0.17, 0.21, 0.03)),
    ]
BONE_NAMES = [b[0] for b in BONES]
PARENT = {b[0]: b[1] for b in BONES}
HEAD = {b[0]: b[2] for b in BONES}
TAIL = {b[0]: b[3] for b in BONES}
LOC_BONE = "pelvis"  # carries the body (in place: code owns root motion)
LOC_EXTRA = ("corona",)  # the corona slides out from behind the back board (phase change)
# Bones whose idle loop ends turned by a symmetry of their part (the escape wheel advances one
# spoke pitch, 72 degrees, per 6 s idle); the loop-seam check compares their parts as sets.
SEAM_SYMMETRY = {"wheel": 72.0}
# Planar leg solve: chain (upper, lower, distal) and knee side (+1 forward, -1 back).
LEGS = {f"leg.{n}": (f"thigh.{n}", f"shin.{n}", f"foot.{n}", 1) for n in ("R", "L")}

CLIPS = {
    "idle": {"duration": 6.0, "loop": "repeat", "events": {}},
    "attack": {"duration": 1.6, "loop": "once", "events": {"impact": 0.85}},
    "hit": {"duration": 0.7, "loop": "once", "events": {}},
    "death": {"duration": 2.8, "loop": "once", "events": {"down": 2.0}},
    "frozen": {"duration": 1.0, "loop": "repeat", "events": {}},
    "phase-change": {"duration": 3.0, "loop": "once", "events": {"open": 1.0}},
}

DETAIL = {"low": 0.8, "high": 1.6}  # segment multiplier


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
    p.add_argument("--compare-only", action="store_true", help="model, then only the concept-angle renders (iteration)")
    p.add_argument("--sheet", action="store_true", help="compose the review sheet (system Python)")
    return p.parse_args(argv)


def lin(c: int) -> float:
    v = c / 255.0
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


# --------------------------------------------------------------------------------------------------
# Modeling toolkit: closed rigid parts, each weighted to one bone


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


def sect(rx: float, ry: float, n: int, p: float = 2.0, cx: float = 0.0, cy: float = 0.0) -> list:
    """Superellipse section (p = 2 ellipse, larger p squarer), n points counter-clockwise."""
    out = []
    for i in range(n):
        a = 2 * math.pi * i / n
        c, s = math.cos(a), math.sin(a)
        out.append((cx + rx * math.copysign(abs(c) ** (2 / p), c), cy + ry * math.copysign(abs(s) ** (2 / p), s)))
    return out


def chamfer_rect(w: float, h: float, c: float | None = None) -> list:
    """Rectangle section (w across, h along) with chamfered corners: a bevelled band profile."""
    c = min(w, h) * 0.22 if c is None else c
    x, y = w / 2, h / 2
    return [(-x + c, -y), (x - c, -y), (x, -y + c), (x, y - c), (x - c, y), (-x + c, y), (-x, y - c), (-x, -y + c)]


class Parts:
    def __init__(self, bmesh, detail: str):
        self.bmesh = bmesh
        self.bm = bmesh.new()
        self.deform = self.bm.verts.layers.deform.verify()
        self.k = DETAIL[detail]
        self.colored: list = []  # (faces, linear rgb) for the jewel slot

    def n(self, base: int) -> int:
        return max(3, int(round(base * self.k)))

    def _tag(self, verts, faces, mat: int, bone: str, color=None) -> None:
        gi = BONE_NAMES.index(bone)
        for v in verts:
            v[self.deform][gi] = 1.0
        for f in faces:
            f.material_index = mat
            f.smooth = True
        if color is not None:
            self.colored.append((list(faces), color))

    def _bevel(self, verts, faces, edges, mat: int, bone: str, offset: float, color=None) -> None:
        self._tag(verts, faces, mat, bone, color)
        if offset <= 0 or not edges:
            return
        res = self.bmesh.ops.bevel(self.bm, geom=list(edges), offset=offset, offset_type="OFFSET", segments=1,
                                   profile=0.5, affect="EDGES", clamp_overlap=True)
        self._tag(res["verts"], res["faces"], mat, bone, color)

    def rings(self, profile: list, zs: list, m, mat: int, bone: str, caps=True, color=None) -> None:
        from mathutils import Vector

        bm = self.bm
        vr = [[bm.verts.new(m @ Vector((x, y, z))) for x, y in ring] for ring, z in zip(profile, zs)]
        n = len(profile[0])
        faces = [bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i])) for a, b in zip(vr, vr[1:]) for i in range(n)]
        if caps:
            faces += [bm.faces.new(list(reversed(vr[0]))), bm.faces.new(vr[-1])]
        self._tag([v for r in vr for v in r], faces, mat, bone, color)

    def loft(self, p0, p1, secs: list, mat: int, bone: str, color=None) -> None:
        """Sections [(f, rx, ry, p, cx, cy)] at fraction f along p0->p1 (local X ~ world X)."""
        m, length = axis_frame(p0, p1)
        n = self.n(20)
        self.rings([sect(rx, ry, n, pw, cx, cy) for _, rx, ry, pw, cx, cy in secs], [f * length for f, *_ in secs], m, mat, bone, color=color)

    def tube(self, p0, p1, r0: float, r1: float, mat: int, bone: str, sides: int | None = None, sx=1.0, sy=1.0) -> None:
        m, length = axis_frame(p0, p1)
        n = sides or self.n(14)
        ring = lambda r: [(r * sx * math.cos(2 * math.pi * i / n), r * sy * math.sin(2 * math.pi * i / n)) for i in range(n)]  # noqa: E731
        self.rings([ring(r0), ring(r1)], [0.0, length], m, mat, bone)

    def lathe(self, c, axis, prof: list, mat: int, bone: str, sides: int | None = None, sx=1.0, sy=1.0, color=None) -> None:
        """Surface of revolution of [(r, z)] about c + t * axis."""
        from mathutils import Vector

        m, _ = axis_frame(c, Vector(c) + Vector(axis))
        n = sides or self.n(18)
        secs = [[(max(r, 1e-3) * sx * math.cos(2 * math.pi * i / n), max(r, 1e-3) * sy * math.sin(2 * math.pi * i / n)) for i in range(n)] for r, _ in prof]
        self.rings(secs, [z for _, z in prof], m, mat, bone, color=color)

    def ball(self, c, r: float, mat: int, bone: str, scale=(1.0, 1.0, 1.0), color=None, segs=None) -> None:
        from mathutils import Matrix

        u, v = segs or (self.n(16), self.n(9))
        m = Matrix.Translation(c) @ Matrix.Diagonal((r * scale[0], r * scale[1], r * scale[2], 1.0))
        verts = self.bmesh.ops.create_uvsphere(self.bm, u_segments=u, v_segments=v, radius=1.0, matrix=m)["verts"]
        faces = []
        for x in verts:
            faces += [f for f in x.link_faces if f not in faces]
        self._tag(verts, faces, mat, bone, color)

    def sweep_ring(self, c, normal, a: float, b: float, section: list, mat: int, bone: str, n: int | None = None,
                   sa=1.0, sb=1.0, arc=(0.0, 360.0), color=None) -> None:
        """Section [(radial, axial)] swept round an ellipse (semi-axes a, b) about `normal`; with a
        partial `arc` the ends are capped. Bands, rims, lathed shells (a = b = 0)."""
        from mathutils import Vector

        n = n or self.n(48)
        full = abs(arc[1] - arc[0]) >= 359.999
        m, _ = axis_frame(c, Vector(c) + Vector(normal))
        bm = self.bm
        k = len(section)
        cnt = n if full else n + 1
        grid = []
        for i in range(cnt):
            u = math.radians(arc[0] + (arc[1] - arc[0]) * i / n)
            grid.append([bm.verts.new(m @ Vector((math.cos(u) * (a + r * sa), math.sin(u) * (b + r * sb), z))) for r, z in section])
        faces = [bm.faces.new((grid[i][j], grid[(i + 1) % cnt][j], grid[(i + 1) % cnt][(j + 1) % k], grid[i][(j + 1) % k]))
                 for i in range(cnt if full else cnt - 1) for j in range(k)]
        if not full:
            faces += [bm.faces.new(grid[0]), bm.faces.new(list(reversed(grid[-1])))]
        self._tag([v for row in grid for v in row], faces, mat, bone, color)

    def band(self, c, normal, r: float, w: float, t: float, mat: int, bone: str, n: int | None = None, rb: float | None = None) -> None:
        """Flat ring band of radial width w and axial thickness t with chamfered edges."""
        self.sweep_ring(c, normal, r, r if rb is None else rb, chamfer_rect(w, t), mat, bone, n)

    def shell(self, c, axis, prof: list, mat: int, bone: str, sides: int | None = None, sx=1.0, sy=1.0, color=None) -> None:
        """Closed lathed shell from a closed (r, z) outline: pauldrons, cups, bezels, bells."""
        from mathutils import Vector

        n = sides or self.n(20)
        m, _ = axis_frame(c, Vector(c) + Vector(axis))
        bm = self.bm
        k = len(prof)
        grid = [[bm.verts.new(m @ Vector((math.cos(2 * math.pi * i / n) * max(r, 1e-3) * sx, math.sin(2 * math.pi * i / n) * max(r, 1e-3) * sy, z)))
                 for r, z in prof] for i in range(n)]
        faces = [bm.faces.new((grid[i][j], grid[(i + 1) % n][j], grid[(i + 1) % n][(j + 1) % k], grid[i][(j + 1) % k]))
                 for i in range(n) for j in range(k)]
        self._tag([v for row in grid for v in row], faces, mat, bone, color)

    def wrap(self, p0, p1, radius, a0, a1, t: float, mat: int, bone: str, v0=0.0, v1=1.0, nu: int | None = None,
             nv: int = 4, sx=1.0, sy=1.0, bevel=0.004, p: float = 2.0, color=None) -> None:
        """Bevelled plate of thickness t wrapped round the axis p0->p1: angle (radians from local +Y
        toward local +X) from a0 to a1 and axial fraction from v0 to v1. radius(v), a0(v), a1(v),
        v0(u), v1(u) may be callables, which shapes tapered, pointed and cut-out plates."""
        from mathutils import Vector

        m, length = axis_frame(p0, p1)
        f = lambda g, x: g(x) if callable(g) else g  # noqa: E731
        nu = nu or self.n(10)

        flip = (m.to_3x3() @ Vector((0, 1, 0))).y < -1e-6  # keep angle 0 on the world front for downward axes

        def pt(u: float, v: float, off: float):
            vv = f(v0, u) + (f(v1, u) - f(v0, u)) * v
            a = f(a0, vv) + (f(a1, vv) - f(a0, vv)) * u
            a = math.pi - a if flip else a
            r = f(radius, vv) + off
            s, c = math.sin(a), math.cos(a)
            return m @ Vector((r * sx * math.copysign(abs(s) ** (2 / p), s), r * f(sy, vv) * math.copysign(abs(c) ** (2 / p), c), vv * length))

        bm = self.bm
        front = [[bm.verts.new(pt(i / nu, j / nv, 0.0)) for j in range(nv + 1)] for i in range(nu + 1)]
        back = [[bm.verts.new(pt(i / nu, j / nv, -t)) for j in range(nv + 1)] for i in range(nu + 1)]
        faces = []
        for i in range(nu):
            for j in range(nv):
                faces.append(bm.faces.new((front[i][j], front[i + 1][j], front[i + 1][j + 1], front[i][j + 1])))
                faces.append(bm.faces.new((back[i][j + 1], back[i + 1][j + 1], back[i + 1][j], back[i][j])))
        border = [(i, 0) for i in range(nu)] + [(nu, j) for j in range(nv)] + [(i, nv) for i in range(nu, 0, -1)] + [(0, j) for j in range(nv, 0, -1)]
        nxt = border[1:] + border[:1]
        for (i0, j0), (i1, j1) in zip(border, nxt):
            faces.append(bm.faces.new((front[i1][j1], front[i0][j0], back[i0][j0], back[i1][j1])))
        edges = []
        for (i0, j0), (i1, j1) in zip(border, nxt):
            for g in (front, back):
                e = bm.edges.get((g[i0][j0], g[i1][j1]))
                if e and e not in edges:
                    edges.append(e)
        verts = [v for g in (front, back) for row in g for v in row]
        self._bevel(verts, faces, edges, mat, bone, bevel, color)

    def extrude(self, outline: list, m, depth: float, mat: int, bone: str, bevel=0.003, color=None) -> None:
        """Flat outline [(x, y)] in the local XY plane of m, extruded symmetrically along local Z."""
        from mathutils import Vector

        bm = self.bm
        n = len(outline)
        top = [bm.verts.new(m @ Vector((x, y, depth / 2))) for x, y in outline]
        bot = [bm.verts.new(m @ Vector((x, y, -depth / 2))) for x, y in outline]
        faces = [bm.faces.new(top), bm.faces.new(list(reversed(bot)))]
        faces += [bm.faces.new((bot[i], bot[(i + 1) % n], top[(i + 1) % n], top[i])) for i in range(n)]
        edges = [bm.edges.get((g[i], g[(i + 1) % n])) for g in (top, bot) for i in range(n)]
        self._bevel(top + bot, faces, [e for e in edges if e], mat, bone, bevel, color)

    def annulus(self, outer: list, inner: list, m, depth: float, mat: int, bone: str, color=None) -> None:
        """Flat ring between two equal-count outlines (outer toothed, inner round), extruded."""
        from mathutils import Vector

        bm = self.bm
        n = len(outer)
        lay = lambda pts, z: [bm.verts.new(m @ Vector((x, y, z))) for x, y in pts]  # noqa: E731
        ot, it, ob, ib = lay(outer, depth / 2), lay(inner, depth / 2), lay(outer, -depth / 2), lay(inner, -depth / 2)
        faces = []
        for i in range(n):
            j = (i + 1) % n
            faces += [bm.faces.new((ot[i], ot[j], it[j], it[i])), bm.faces.new((ob[j], ob[i], ib[i], ib[j])),
                      bm.faces.new((ob[i], ob[j], ot[j], ot[i])), bm.faces.new((ib[j], ib[i], it[i], it[j]))]
        self._tag(ot + it + ob + ib, faces, mat, bone, color)

    def bbox(self, c, size, mat: int, bone: str, rot=None, bevel=0.004) -> None:
        """Bevelled box centred at c, optionally rotated by a 3x3 (mathutils Matrix)."""
        from mathutils import Matrix

        m = Matrix.Translation(c) @ (rot.to_4x4() if rot is not None else Matrix.Identity(4)) @ Matrix.Diagonal((*size, 1.0))
        res = self.bmesh.ops.create_cube(self.bm, size=1.0, matrix=m)
        verts = res["verts"]
        faces, edges = [], []
        for v in verts:  # ordered walk (no sets: bevel output order must not depend on hashing)
            faces += [f for f in v.link_faces if f not in faces]
            edges += [e for e in v.link_edges if e not in edges]
        self._bevel(verts, faces, edges, mat, bone, bevel)

    def sweep(self, path: list, section: list, mat: int, bone: str, hint=(0, 0, 1), scales=None, color=None) -> None:
        """Section [(u, v)] swept along a polyline; u runs along the path normal from `hint`."""
        from mathutils import Vector

        P = [Vector(p) for p in path]
        bm = self.bm
        rows = []
        for i, p in enumerate(P):
            t = (P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]).normalized()
            up = Vector(hint)
            up = (up - t * up.dot(t)).normalized()
            side = t.cross(up)
            s = scales[i] if scales else 1.0
            rows.append([bm.verts.new(p + up * (u * s) + side * (v * s)) for u, v in section])
        k = len(section)
        faces = [bm.faces.new((a[j], a[(j + 1) % k], b[(j + 1) % k], b[j])) for a, b in zip(rows, rows[1:]) for j in range(k)]
        faces += [bm.faces.new(list(reversed(rows[0]))), bm.faces.new(rows[-1])]
        self._tag([v for r in rows for v in r], faces, mat, bone, color)


def lerp(p, q, f: float) -> tuple:
    return tuple(a + (b - a) * f for a, b in zip(p, q))


def smooth_step(x: float) -> float:
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def gear_outline(r_root: float, r_tip: float, teeth: int, per: int = 4, hook: float = 0.0) -> list:
    """Toothed outline; hook > 0 skews the tips (escape-wheel teeth)."""
    out = []
    for i in range(teeth):
        a0 = 2 * math.pi * i / teeth
        step = 2 * math.pi / teeth
        for f, r in ((0.0, r_root), (0.3, r_root), (0.45 + hook, r_tip), (0.6 + hook, r_tip), (0.75, r_root))[:per + 1]:
            a = a0 + f * step
            out.append((r * math.cos(a), r * math.sin(a)))
    return out


def circle(r: float, n: int, phase: float = 0.0) -> list:
    return [(r * math.cos(phase + 2 * math.pi * i / n), r * math.sin(phase + 2 * math.pi * i / n)) for i in range(n)]


def box(P: Parts, lo, hi, mat: int, bone: str, bevel=0.006) -> None:
    """Bevelled box from its min and max corners."""
    P.bbox(tuple((a + b) / 2 for a, b in zip(lo, hi)), tuple(b - a for a, b in zip(lo, hi)), mat, bone, bevel=bevel)


def xz_frame(y: float, flip: bool = False):
    """4x4 mapping an outline's local (x, y) to world (x, z) on the plane at depth y (normal +-Y)."""
    from mathutils import Matrix

    m = Matrix(((1, 0, 0, 0), (0, 0, -1 if flip else 1, y), (0, 1, 0, 0), (0, 0, 0, 1)))
    return m


def build_parts(P: Parts) -> None:
    from mathutils import Euler, Matrix, Vector

    up, fwd = (0, 0, 1), (0, 1, 0)
    W, D = CASE_W / 2, CASE_D / 2

    # --- Plinth (spine): bevelled walnut base, brass-edged mouldings, a bracket-foot apron.
    box(P, (-W - 0.05, -D - 0.04, PLINTH[0] + 0.05), (W + 0.05, D + 0.04, PLINTH[1] - 0.04), WN, "spine", 0.01)
    box(P, (-W - 0.07, -D - 0.06, PLINTH[1] - 0.045), (W + 0.07, D + 0.06, PLINTH[1] - 0.01), WN, "spine", 0.008)
    box(P, (-W - 0.035, -D - 0.025, PLINTH[1] - 0.012), (W + 0.035, D + 0.025, PLINTH[1] + 0.012), BP, "spine", 0.004)
    for y, flip in ((D + 0.05, False), (-D - 0.05, True)):
        apron = [(-W - 0.06, 0.0), (W + 0.06, 0.0), (W + 0.06, -0.10), (W + 0.02, -0.125)]
        apron += [(W - 2 * W * f, -0.125 + 0.075 * math.sin(math.pi * f) ** 0.7) for f in [k / 10 for k in range(11)]]
        apron += [(-W - 0.02, -0.125), (-W - 0.06, -0.10)]
        m = Matrix.Translation((0, 0, PLINTH[0] + 0.07)) @ xz_frame(y, flip)
        P.extrude(apron, m, 0.03, WN, "spine", bevel=0.004)
    for x in (-1, 1):  # brass escutcheon-style corner plates on the plinth front
        box(P, (x * (W + 0.02) - 0.03, D + 0.04, PLINTH[0] + 0.12), (x * (W + 0.02) + 0.03, D + 0.052, PLINTH[1] - 0.07), BP, "spine", 0.003)
    box(P, (-0.14, D + 0.04, PLINTH[0] + 0.12), (0.14, D + 0.05, PLINTH[1] - 0.07), WN, "spine", 0.004)
    P.sweep([(-0.14, D + 0.052, PLINTH[0] + 0.12), (0.14, D + 0.052, PLINTH[0] + 0.12), (0.14, D + 0.052, PLINTH[1] - 0.07),
             (-0.14, D + 0.052, PLINTH[1] - 0.07), (-0.14, D + 0.052, PLINTH[0] + 0.115)], chamfer_rect(0.012, 0.01), BP, "spine", hint=(0, 1, 0))

    # --- Trunk (chest): back wall, interior back board, front stiles and rails, mouldings.
    box(P, (-W + 0.026, -D, TRUNK[0]), (W - 0.026, -D + 0.025, TRUNK[1]), WN, "chest", 0.004)
    box(P, (-W + 0.03, -0.128, TRUNK[0] + 0.04), (W - 0.03, -0.112, TRUNK[1] - 0.04), WN, "chest", 0.0)
    for x in (-1, 1):
        box(P, (min(x * W, x * (W - 0.032)), D - 0.03, TRUNK[0]), (max(x * W, x * (W - 0.032)), D, TRUNK[1]), WN, "chest", 0.004)
    box(P, (-W, D - 0.03, TRUNK[0]), (W, D, DOOR_Z[0] - 0.005), WN, "chest", 0.004)
    box(P, (-W, D - 0.03, DOOR_Z[1] + 0.005), (W, D, TRUNK[1]), WN, "chest", 0.004)
    box(P, (-W - 0.035, -D - 0.035, TRUNK[1] - 0.005), (W + 0.035, D + 0.035, HOOD[0] + 0.005), WN, "chest", 0.008)
    box(P, (-W - 0.02, -D - 0.02, TRUNK[1] - 0.018), (W + 0.02, D + 0.02, TRUNK[1] - 0.004), BP, "chest", 0.003)
    # Back panel frame and a brass pull, as on the concept's back view.
    P.sweep([(-0.17, -D - 0.006, 1.50), (0.17, -D - 0.006, 1.50), (0.17, -D - 0.006, 2.10), (-0.17, -D - 0.006, 2.10), (-0.17, -D - 0.006, 1.495)],
            chamfer_rect(0.012, 0.01), BP, "chest", hint=(0, -1, 0))
    # Furnace: the soft amber disc behind the wheel (phase 1 glow through the glazing).
    P.lathe(_add(WHEEL_C, (0, -0.036, 0)), fwd, [(0.0, 0.0), (0.12, 0.0), (0.12, 0.004), (0.0, 0.006)], GL, "chest", sides=P.n(28))
    # Two fixed train gears glimpsed behind the wheel.
    m = Matrix.Translation(_add(WHEEL_C, (0.09, -0.024, -0.13))) @ Euler((math.pi / 2, 0, 0)).to_matrix().to_4x4()
    P.annulus(gear_outline(0.075, 0.088, 18), circle(0.03, 90), m, 0.01, BP, "chest")
    m = Matrix.Translation(_add(WHEEL_C, (-0.10, -0.024, -0.17))) @ Euler((math.pi / 2, 0, 0)).to_matrix().to_4x4()
    P.annulus(gear_outline(0.055, 0.066, 14), circle(0.02, 70), m, 0.01, BP, "chest")

    # --- Escape wheel (wheel bone): hooked teeth, five spokes, hub.
    m = Matrix.Translation(WHEEL_C) @ Euler((-math.pi / 2, 0, 0)).to_matrix().to_4x4()
    P.annulus(gear_outline(0.088, 0.112, 15, hook=0.12), circle(0.074, 75), m, 0.012, BP, "wheel")
    for k in range(5):  # flat spokes as rotated copies of one outline, so the wheel stays 72-degree symmetric
        a = 2 * math.pi * k / 5 + math.pi / 2
        spoke = [(0.012, -0.007), (0.078, -0.006), (0.078, 0.006), (0.012, 0.007)]
        P.extrude([(x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a)) for x, y in spoke], m, 0.01, BP, "wheel", bevel=0.0)
    P.lathe(_add(WHEEL_C, (0, -0.012, 0)), fwd, [(0.0, 0.0), (0.024, 0.0), (0.024, 0.024), (0.012, 0.03), (0.0, 0.03)], BP, "wheel", sides=10)  # 10 sides: symmetric under the 72 degree idle step
    # Corona: a flame-toothed glow ring parked between the back wall and the back board.
    m = Matrix.Translation(_add(WHEEL_C, (0, -0.064, 0))) @ Euler((-math.pi / 2, 0, 0)).to_matrix().to_4x4()
    P.annulus(gear_outline(0.15, 0.2, 12, hook=0.15), circle(0.118, 60), m, 0.008, GL, "corona")

    # --- Pallet anchor, pendulum rod and bob.
    pc = Vector(PALLET_C)
    arm_pts = lambda s: [pc + Vector((s * 0.02, 0.0, -0.01)), pc + Vector((s * 0.07, 0.0, -0.035)), pc + Vector((s * 0.095, 0.0, -0.075)),  # noqa: E731
                         pc + Vector((s * 0.09, 0.0, -0.11))]
    for s in (1, -1):
        P.sweep(arm_pts(s), chamfer_rect(0.016, 0.014), BP, "pallet", hint=(0, 1, 0))
    P.lathe(pc + Vector((0, -0.01, 0)), fwd, [(0.0, 0.0), (0.022, 0.0), (0.022, 0.03), (0.0, 0.03)], GM, "pallet", sides=12)
    P.tube((0, -0.03, PALLET_C[2] - 0.01), (0, -0.03, BOB_Z + 0.07), 0.007, 0.007, BP, "pendulum", sides=8)
    P.lathe((0, -0.05, BOB_Z), fwd, [(0.0, 0.0), (0.075, 0.0), (0.085, 0.012), (0.075, 0.03), (0.0, 0.034)], BP, "bob", sides=P.n(28))
    P.lathe((0, -0.02, BOB_Z), fwd, [(0.0, 0.0), (0.045, 0.0), (0.04, 0.008), (0.0, 0.012)], GL, "bob", sides=P.n(20))

    # --- Glazed doors (door bones on their outer hinge): walnut frames, brass beads and bars, knobs.
    for s, n_ in ((1, "R"), (-1, "L")):
        x0, x1 = s * 0.006, s * 0.232
        lo_x, hi_x = min(x0, x1), max(x0, x1)
        y0, y1 = D - 0.028, D - 0.006
        z0, z1 = DOOR_Z
        bone = f"door.{n_}"
        box(P, (lo_x, y0, z0), (lo_x + 0.03, y1, z1), WN, bone, 0.004)
        box(P, (hi_x - 0.03, y0, z0), (hi_x, y1, z1), WN, bone, 0.004)
        box(P, (lo_x + 0.03, y0, z0), (hi_x - 0.03, y1, z0 + 0.045), WN, bone, 0.004)
        box(P, (lo_x + 0.03, y0, z1 - 0.06), (hi_x - 0.03, y1, z1), WN, bone, 0.004)
        xa, xb, za, zb = lo_x + 0.03, hi_x - 0.03, z0 + 0.045, z1 - 0.06
        P.sweep([(xa, y1 + 0.002, za), (xb, y1 + 0.002, za), (xb, y1 + 0.002, zb), (xa, y1 + 0.002, zb), (xa, y1 + 0.002, za - 0.004)],
                chamfer_rect(0.01, 0.008), BP, bone, hint=(0, 1, 0))
        for z in (za + (zb - za) * 0.62,):  # glazing bar
            box(P, (xa, y0 + 0.008, z - 0.006), (xb, y0 + 0.016, z + 0.006), BP, bone, 0.002)
        knob_x = s * 0.03
        P.lathe((knob_x, y1, 1.80), fwd, [(0.0, 0.0), (0.008, 0.0), (0.006, 0.015), (0.016, 0.025), (0.012, 0.036), (0.0, 0.038)], BP, bone, sides=10)
        for z in (z0 + 0.08, z1 - 0.1):  # hinge knuckles
            P.lathe((s * 0.236, D - 0.004, z), up, [(0.0, 0.0), (0.009, 0.0), (0.009, 0.05), (0.0, 0.05)], BP, bone, sides=8)

    # --- Side case plates (plate bones on the rear hinge): walnut panels with brass frames.
    for s, n_ in ((1, "R"), (-1, "L")):
        bone = f"plate.{n_}"
        xo = s * W
        box(P, (min(xo, xo - s * 0.024), -D + 0.012, TRUNK[0] + 0.02), (max(xo, xo - s * 0.024), D - 0.032, TRUNK[1] - 0.02), WN, bone, 0.004)
        xf = xo + s * 0.004
        P.sweep([(xf, -D + 0.05, 1.47), (xf, D - 0.07, 1.47), (xf, D - 0.07, 2.12), (xf, -D + 0.05, 2.12), (xf, -D + 0.05, 1.466)],
                chamfer_rect(0.01, 0.01), BP, bone, hint=(1, 0, 0))
        P.lathe((xo + s * 0.006, 0.0, 1.80), (s, 0, 0), [(0.0, 0.0), (0.035, 0.0), (0.035, 0.008), (0.0, 0.01)], GM, bone, sides=12)  # inlay
        for z in (1.46, 2.14):
            P.lathe((xo, -D + 0.01, z - 0.03), up, [(0.0, 0.0), (0.009, 0.0), (0.009, 0.06), (0.0, 0.06)], BP, bone, sides=8)

    # --- Hood: walnut box, turned brass columns, dial, cornice, broken-arch pediment.
    HW, HD = W + 0.03, D + 0.03
    box(P, (-HW, -HD, HOOD[0]), (HW, HD, HOOD[1]), WN, "chest", 0.008)
    for x in (-1, 1):
        cx = x * (HW - 0.005)
        P.lathe((cx, HD + 0.006, HOOD[0] + 0.01), up, [(0.0, 0.0), (0.028, 0.0), (0.028, 0.03), (0.02, 0.04), (0.018, 0.2), (0.021, 0.3),
                                                      (0.018, 0.4), (0.026, 0.41), (0.028, 0.44), (0.0, 0.44)], BP, "chest", sides=12)
    P.lathe(_add(DIAL_C, (0, -0.012, 0)), fwd, [(0.0, 0.0), (0.18, 0.0), (0.18, 0.012), (0.0, 0.012)], GM, "chest", sides=P.n(40))
    P.band(_add(DIAL_C, (0, 0.002, 0)), fwd, 0.18, 0.026, 0.02, BP, "chest", n=P.n(48))
    P.band(_add(DIAL_C, (0, 0.002, 0)), fwd, 0.105, 0.012, 0.01, BP, "chest", n=P.n(36))
    for k in range(12):
        a = 2 * math.pi * k / 12
        L = 0.032 if k % 3 == 0 else 0.02
        c = _add(DIAL_C, (0.14 * math.sin(a), 0.004, 0.14 * math.cos(a)))
        P.bbox(c, (0.008 if k % 3 else 0.012, 0.006, L), BP, "chest", rot=Euler((0, a, 0)).to_matrix(), bevel=0.0)
    for x in (-1, 1):  # spandrel ornaments in the dial's upper corners
        P.lathe((x * 0.20, HD, HOOD[1] - 0.045), fwd, [(0.0, 0.0), (0.022, 0.0), (0.016, 0.012), (0.0, 0.016)], BP, "chest", sides=10)
    box(P, (-HW - 0.05, -HD - 0.05, HOOD[1] - 0.005), (HW + 0.05, HD + 0.05, HOOD[1] + 0.035), WN, "chest", 0.01)
    box(P, (-HW - 0.035, -HD - 0.035, HOOD[1] - 0.02), (HW + 0.035, HD + 0.035, HOOD[1] - 0.004), BP, "chest", 0.003)
    for s in (1, -1):  # broken swan-neck arch halves
        arc = [(s * (HW + 0.04), 0.0), (s * 0.075, 0.0), (s * 0.075, 0.06)] + [(s * (0.075 + 0.23 * (1 - math.cos(t))), 0.06 + 0.045 * math.cos(t) - 0.035 * (1 - math.cos(t)))
                                                                           for t in [math.radians(d) for d in range(15, 91, 15)]] + [(s * (HW + 0.04), 0.03)]
        if s < 0:
            arc = arc[::-1]
        m = Matrix.Translation((0, 0, HOOD[1] + 0.035)) @ xz_frame(HD + 0.03)
        P.extrude(arc, m, 0.035, WN, "chest", bevel=0.005)
        P.ball((s * 0.09, HD + 0.03, HOOD[1] + 0.135), 0.02, BP, "chest")
    P.lathe((0, HD + 0.02, HOOD[1] + 0.035), up, [(0.0, 0.0), (0.03, 0.0), (0.02, 0.03), (0.026, 0.05), (0.0, 0.09)], BP, "chest", sides=10)

    # --- Dial hands (spade tips), on their own bones.
    for bone, L, wdt, yoff, ang in (("dial.hour", 0.09, 0.016, 0.006, -60.0), ("dial.minute", 0.135, 0.011, 0.012, 60.0)):
        hand = [(-wdt / 2, -0.02), (wdt / 2, -0.02), (wdt / 2, L * 0.7), (wdt * 1.6, L * 0.8), (0.0, L), (-wdt * 1.6, L * 0.8), (-wdt / 2, L * 0.7)]
        a = math.radians(ang)
        hand = [(x * math.cos(a) + y * math.sin(a), -x * math.sin(a) + y * math.cos(a)) for x, y in hand]
        P.extrude(hand, xz_frame(DIAL_C[1] + yoff) @ Matrix.Translation((0, DIAL_C[2], 0)), 0.004, BP, bone, bevel=0.0)
    P.lathe(_add(DIAL_C, (0, 0.012, 0)), fwd, [(0.0, 0.0), (0.016, 0.0), (0.012, 0.01), (0.0, 0.012)], BP, "dial.minute", sides=10)

    # --- Winding key on the back (key bone, turning on its arbor).
    P.tube(KEY_C, _add(KEY_C, (0, -0.07, 0)), 0.014, 0.014, BP, "key", sides=10)
    P.lathe(_add(KEY_C, (0, 0.006, 0)), (0, -1, 0), [(0.0, 0.0), (0.03, 0.0), (0.03, 0.012), (0.0, 0.012)], BP, "key", sides=12)
    bow = [(0.085 * math.cos(math.radians(t)), 0.1 + 0.035 * math.sin(math.radians(t)) * (0.45 + 0.55 * abs(math.cos(math.radians(t)))))
           for t in range(0, 360, 20)]
    m = Matrix(((0, 0, 1, KEY_C[0]), (0, -1, 0, KEY_C[1]), (1, 0, 0, KEY_C[2]), (0, 0, 0, 1)))  # bow in the YZ plane, behind the arbor
    P.extrude(bow, m, 0.016, BP, "key", bevel=0.003)

    # --- Neck and head: ribbed column, narrow helmet with crest and amber eyes; bell crown.
    P.tube((0, -0.02, 2.68), (0, -0.02, 2.88), 0.05, 0.046, GM, "neck")
    for z in (2.76, 2.80, 2.84):
        P.sweep_ring((0, -0.02, z), up, 0.054, 0.054, chamfer_rect(0.014, 0.014), GM, "neck", n=P.n(18))
    hs = [(0.0, 0.045, 0.055, 2.2), (0.08, 0.068, 0.08, 2.2), (0.3, 0.088, 0.1, 2.5), (0.55, 0.094, 0.108, 2.6),
          (0.78, 0.088, 0.1, 2.4), (0.93, 0.06, 0.07, 2.2), (1.0, 0.03, 0.034, 2.0)]
    P.loft((0, -0.015, 2.85), (0, -0.015, 3.08), [(f, rx, ry, pw, 0, 0) for f, rx, ry, pw in hs], BP, "head")
    P.sweep([(0, -0.015 + 0.112 * math.cos(a), 2.95 + 0.13 * math.sin(a)) for a in [math.radians(d) for d in range(20, 161, 20)]],
            chamfer_rect(0.012, 0.02), BP, "head", hint=(1, 0, 0))
    P.wrap((0, -0.015, 2.955), (0, -0.015, 2.985), lambda v: 0.118, -1.1, 1.1, 0.014, GM, "head", sx=0.82, nu=P.n(12), nv=2)
    for s in (1, -1):
        P.ball((s * 0.04, 0.095, 2.94), 0.018, GL, "head", (1.4, 0.55, 0.8))
        P.lathe((s * 0.085, -0.015, 2.94), (s, 0, 0), [(0.0, 0.0), (0.036, 0.0), (0.036, 0.016), (0.026, 0.024), (0.0, 0.024)], BP, "head")
    P.lathe((0, -0.02, 3.065), up, [(0.0, 0.0), (0.02, 0.0), (0.012, 0.03), (0.0, 0.032)], BP, "head", sides=10)
    P.shell((0, -0.02, 3.09), up, [(0.0, 0.085), (0.02, 0.083), (0.032, 0.07), (0.038, 0.045), (0.048, 0.015), (0.06, 0.0), (0.052, -0.002),
                                   (0.04, 0.012), (0.03, 0.04), (0.024, 0.065), (0.0, 0.072)], BP, "bell", sides=P.n(20))
    P.lathe((0, -0.02, 3.17), up, [(0.0, 0.0), (0.006, 0.0), (0.006, 0.012), (0.012, 0.02), (0.0, 0.032)], BP, "bell", sides=8)
    P.tube((0, -0.02, 3.15), (0, -0.02, 3.10), 0.004, 0.004, GM, "clapper", sides=6)
    P.ball((0, -0.02, 3.095), 0.013, GM, "clapper")

    # --- Arms: domed pauldrons with inlays, gunmetal upper arm, brass vambrace, fist.
    for s, n_ in ((1, "R"), (-1, "L")):
        sh, el, wr = (s * SH[0], 0.0, SH[2]), (s * EL[0], 0.0, EL[2]), (s * WR[0], 0.0, WR[2])
        cap = _add(sh, (s * 0.0, 0, 0.03))
        ax = (s * 0.5, 0.0, 0.87)
        P.shell(cap, ax, [(0.0, 0.13), (0.09, 0.12), (0.155, 0.075), (0.18, 0.0), (0.18, -0.05), (0.165, -0.05), (0.163, 0.0), (0.14, 0.065),
                          (0.08, 0.105), (0.0, 0.115)], BP, f"upperarm.{n_}", sy=1.0)
        P.sweep_ring(_add(cap, (s * 0.01, 0, 0.0)), ax, 0.178, 0.178, chamfer_rect(0.012, 0.02), GM, f"upperarm.{n_}", n=P.n(28))
        gem = _add(cap, (s * 0.165, 0.0, 0.085))
        P.lathe(gem, ax, [(0.0, 0.0), (0.04, 0.0), (0.03, 0.02), (0.0, 0.026)], GM, f"upperarm.{n_}", sides=12)
        P.ball(sh, 0.065, GM, f"upperarm.{n_}")
        P.loft(sh, el, [(0.05, 0.058, 0.06, 2.0, 0, 0), (0.95, 0.05, 0.052, 2.0, 0, 0)], GM, f"upperarm.{n_}")
        for f in (0.35, 0.6, 0.85):
            P.sweep_ring(lerp(sh, el, f), (s * (EL[0] - SH[0]), 0, EL[2] - SH[2]), 0.056, 0.058, chamfer_rect(0.012, 0.014), GM, f"upperarm.{n_}", n=P.n(16))
        P.ball(el, 0.062, GM, f"forearm.{n_}")
        P.lathe(_add(el, (s * 0.0, 0.055, 0)), fwd, [(0.0, 0.0), (0.03, 0.0), (0.03, 0.012), (0.0, 0.018)], GM, f"forearm.{n_}", sides=12)
        P.loft(el, wr, [(0.06, 0.06, 0.06, 2.3, 0, 0), (0.25, 0.082, 0.078, 2.6, 0, 0), (0.75, 0.07, 0.066, 2.6, 0, 0), (0.94, 0.05, 0.048, 2.2, 0, 0),
                        (1.0, 0.04, 0.04, 2.0, 0, 0)], BP, f"forearm.{n_}")
        for f in (0.15, 0.68):
            P.sweep_ring(lerp(el, wr, f), (s * (WR[0] - EL[0]), 0, WR[2] - EL[2]), 0.08 - 0.012 * f, 0.077 - 0.012 * f, chamfer_rect(0.01, 0.014), GM,
                         f"forearm.{n_}", n=P.n(18))
        d = Vector((s * (WR[0] - EL[0]), 0, WR[2] - EL[2])).normalized()
        fist = Vector(wr) + d * 0.06
        P.ball(Vector(wr), 0.036, GM, f"hand.{n_}")
        P.ball(fist, 0.058, BP, f"hand.{n_}", (1.0, 0.9, 1.1))
        for k in range(4):  # knuckle row wrapped round the shank
            c = fist + Vector((0, 0.045, 0)) + d * (0.035 * (k - 1.5))
            P.ball(c, 0.017, GM, f"hand.{n_}")

        # Anchor claw: shank with a stock, crown, two curved flukes with barbed arrowheads.
        top = Vector(wr) + d * 0.02
        crown = Vector(HEAD[f"fluke.in.{n_}"])
        P.loft(top, crown, [(0.0, 0.026, 0.026, 2.0, 0, 0), (0.85, 0.032, 0.026, 2.4, 0, 0), (1.0, 0.04, 0.03, 2.4, 0, 0)], BP, f"claw.{n_}")
        stock = top + d * 0.13
        perp = Vector((-d.z, 0, d.x))
        P.tube(stock - perp * 0.11, stock + perp * 0.11, 0.016, 0.016, BP, f"claw.{n_}", sides=8)
        for e in (-1, 1):
            P.ball(stock + perp * e * 0.115, 0.024, BP, f"claw.{n_}")
        P.lathe(top - d * 0.025, -d, [(0.0, 0.0), (0.03, 0.0), (0.03, 0.01), (0.022, 0.014), (0.0, 0.014)], BP, f"claw.{n_}", sides=10)
        P.ball(crown, 0.045, BP, f"claw.{n_}")
        R = 0.25
        for side, bone in ((-1, f"fluke.in.{n_}"), (1, f"fluke.out.{n_}")):
            sd = perp * (side * s)
            pts = [crown + sd * (R * math.sin(t)) - d * (R * (1 - math.cos(t))) for t in [math.radians(a) for a in range(0, 76, 15)]]
            P.sweep(pts, chamfer_rect(0.036, 0.045), BP, bone, hint=(0, 1, 0), scales=[1.0, 0.95, 0.9, 0.85, 0.8, 0.75])
            tip = pts[-1]
            tang = (pts[-1] - pts[-2]).normalized()
            nrm = Vector((-tang.z, 0, tang.x))
            m = Matrix((tang, nrm, Vector((0, 1, 0)))).transposed().to_4x4()
            m.translation = tip
            P.extrude([(-0.015, -0.018), (0.0, -0.065), (0.11, 0.0), (0.0, 0.065), (-0.015, 0.018)], m, 0.026, BP, bone, bevel=0.004)

    # --- Pelvis and legs: gunmetal hip block, brass codpiece plate, armoured legs.
    zs = [1.02, 1.12, 1.22, 1.30]
    P.rings([sect(0.17, 0.12, P.n(20), 2.3), sect(0.2, 0.135, P.n(20), 2.3), sect(0.2, 0.14, P.n(20), 2.3), sect(0.18, 0.13, P.n(20), 2.3)], zs,
            Matrix.Identity(4), GM, "pelvis")
    P.wrap((0, 0, 1.24), (0, 0, 1.0), lambda v: 0.15 - 0.03 * v, -0.5, 0.5, 0.016, BP, "pelvis", sx=1.1, nu=P.n(8), nv=3)
    for s, n_ in ((1, "R"), (-1, "L")):
        hip, knee, ank = (s * 0.15, 0, 1.20), (s * 0.17, 0.02, 0.66), (s * 0.17, -0.01, 0.13)
        P.ball(hip, 0.085, GM, f"thigh.{n_}")
        P.loft(hip, knee, [(0.0, 0.088, 0.09, 2.0, 0, 0), (0.5, 0.084, 0.086, 2.0, 0, 0), (1.0, 0.066, 0.068, 2.0, 0, 0)], GM, f"thigh.{n_}")
        P.wrap(hip, knee, lambda v: 0.104 - 0.022 * v, -1.3, 1.3, 0.016, BP, f"thigh.{n_}", v0=0.12, v1=0.86, nu=P.n(8), nv=3)
        P.wrap(hip, knee, lambda v: 0.104 - 0.022 * v, math.pi - 0.9, math.pi + 0.9, 0.014, BP, f"thigh.{n_}", v0=0.2, v1=0.8, nu=P.n(6), nv=2)
        P.ball(knee, 0.07, GM, f"shin.{n_}")
        P.shell(_add(knee, (0, 0.055, 0.0)), (0, 1, 0), [(0.0, 0.042), (0.048, 0.036), (0.076, 0.0), (0.07, -0.005), (0.042, 0.024), (0.0, 0.03)],
                BP, f"shin.{n_}", sy=1.3)
        P.loft(knee, ank, [(0.08, 0.07, 0.072, 2.0, 0, 0.0), (0.25, 0.088, 0.096, 2.7, 0, -0.016), (0.55, 0.08, 0.088, 2.7, 0, -0.014),
                           (0.88, 0.058, 0.062, 2.4, 0, -0.006), (1.0, 0.048, 0.05, 2.0, 0, 0)], BP, f"shin.{n_}")
        P.sweep([_add(lerp(knee, ank, f), (0, 0.104 - 0.042 * f, 0)) for f in (0.14, 0.4, 0.7, 0.93)], chamfer_rect(0.014, 0.012), BP,
                f"shin.{n_}", hint=(0, 1, 0))
        P.ball(ank, 0.045, GM, f"foot.{n_}")
        m, _ = axis_frame((s * 0.17, -0.10, 0.0), (s * 0.17, 0.27, 0.0))
        secs = [(0.0, 0.055, 0.038, 2.4, 0, -0.038), (0.12, 0.064, 0.06, 2.6, 0, -0.06), (0.45, 0.066, 0.055, 2.8, 0, -0.055),
                (0.75, 0.06, 0.034, 2.8, 0, -0.034), (1.0, 0.034, 0.014, 2.4, 0, -0.014)]
        P.rings([sect(rx, ry, P.n(16), pw, cx, cy) for _, rx, ry, pw, cx, cy in secs], [f * 0.37 for f, *_ in secs], m, BP, f"foot.{n_}")
        P.wrap((s * 0.17, -0.10, 0.05), (s * 0.17, 0.22, 0.05), 0.066, math.pi - 1.3, math.pi + 1.3, 0.01, BP, f"foot.{n_}", v0=0.5, v1=0.82,
               nu=P.n(8), nv=2)
        P.lathe((s * 0.17, -0.04, 0.075), (0, -1, 0), [(0.0, 0.0), (0.055, 0.0), (0.05, 0.045), (0.0, 0.055)], GM, f"foot.{n_}", sx=1.1)


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
    col = P.bm.loops.layers.float_color.new("jewel")
    for f in P.bm.faces:
        for loop in f.loops:
            loop[col] = (1.0, 1.0, 1.0, 1.0)
    for faces, rgb in P.colored:
        for f in faces:
            if f.is_valid:
                for loop in f.loops:
                    loop[col] = (*rgb, 1.0)
    bmesh.ops.recalc_face_normals(P.bm, faces=P.bm.faces[:])
    # Fixed triangulation here: the exporter's own quad split follows float noise between runs.
    bmesh.ops.triangulate(P.bm, faces=P.bm.faces[:], quad_method="FIXED", ngon_method="EAR_CLIP")
    P.bm.normal_update()
    tile_uvs(P.bm)
    me = bpy.data.meshes.new(f"{BODY}-{detail}")
    P.bm.to_mesh(me)
    P.bm.free()
    me.set_sharp_from_angle(angle=math.radians(38))
    me.color_attributes.active_color_name = "jewel"
    me.color_attributes.render_color_index = me.color_attributes.active_color_index
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


ARMS_REST = {"forearm.R": (4, 0, 0), "forearm.L": (4, 0, 0)}
CLOSED = {"door.R": 0.0, "door.L": 0.0, "plate.R": 0.0, "plate.L": 0.0}


def _ticks(t: float) -> float:
    """Escape-wheel angle: a 12 degree step at each pendulum extreme (every 1 s), eased over 0.1 s."""
    k = math.floor(t - 0.5)
    frac = (t - 0.5) - k
    return -12.0 * ((k + 1) + smooth_step(frac / 0.1) - 1) if t >= 0.5 else 0.0


def idle_pose(t: float) -> dict:
    """6 s loop: the pendulum beats on a 2 s period (the pallet rocks with it and the wheel steps
    12 degrees per beat, one spoke pitch per loop), breathing and a slow sway on top."""
    D = CLIPS["idle"]["duration"]
    w = 2 * math.pi * t / D
    beat = math.sin(math.pi * t)  # 2 s period
    br = math.sin(2 * w)
    return {
        "pelvis_loc": (0, 0, 0.008 * br),
        "spine": (0.8 * br, 0, 0), "chest": (-0.6 * br, 0, 1.2 * math.sin(w)), "neck": (0, 0, 2.0 * math.sin(w)),
        "head": (2.0 * math.sin(2 * w + 0.5), 0, 6.0 * math.sin(w)),
        "upperarm.R": (2.0 * br, -1.5 * math.sin(w), 0), "upperarm.L": (-2.0 * br, 1.5 * math.sin(w), 0),
        "forearm.R": (4 + 2 * br, 0, 0), "forearm.L": (4 - 2 * br, 0, 0),
        "claw.R": (0, -2 * math.sin(w), 0), "claw.L": (0, 2 * math.sin(w), 0),
        "pendulum": (0, 11.0 * beat, 0), "pallet": (0, -3.5 * beat, 0),
        "clapper": (3.0 * math.sin(2 * w), 0, 0),
        "spin": {"wheel": _ticks(t)},
        "ik": PLANT,
    }


START = {**ARMS_REST, "ik": PLANT}
RAISE = {"pelvis_loc": (0, -0.03, -0.02), "spine": (4, 0, 0), "chest": (6, 0, 0), "head": (8, 0, 0),
         "upperarm.R": (75, -10, 0), "upperarm.L": (75, 10, 0), "forearm.R": (35, 0, 0), "forearm.L": (35, 0, 0),
         "fluke.in.R": (0, 25, 0), "fluke.out.R": (0, -25, 0), "fluke.in.L": (0, -25, 0), "fluke.out.L": (0, 25, 0),
         "pendulum": (0, 18, 0), "pallet": (0, -6, 0), "spin": {"wheel": -12}, "ik": PLANT}
CLAMP = {"pelvis_loc": (0, 0.07, -0.07), "spine": (-8, 0, 0), "chest": (-10, 0, 0), "head": (-6, 0, 0),
         "upperarm.R": (42, 8, 0), "upperarm.L": (42, -8, 0), "forearm.R": (8, 0, 0), "forearm.L": (8, 0, 0),
         "fluke.in.R": (0, -18, 0), "fluke.out.R": (0, 18, 0), "fluke.in.L": (0, 18, 0), "fluke.out.L": (0, -18, 0),
         "pendulum": (0, -22, 0), "pallet": (0, 7, 0), "clapper": (14, 0, 0), "spin": {"wheel": -24, "door.R": -4, "door.L": 4},
         "ik": planted(leg_R=(0.12, 0.13))}
ATTACK_KEYS = [
    (0.0, START),
    (0.5, RAISE),
    (0.85, CLAMP),
    (1.1, {**CLAMP, "pendulum": (0, 14, 0), "spin": {"wheel": -24}}),
    (1.6, {**START, "spin": {"wheel": -24}}),
]
HIT1 = {"pelvis_loc": (0, -0.05, -0.02), "spine": (6, 0, 3), "chest": (5, 0, 4), "head": (12, 0, -8),
        "upperarm.R": (-12, -12, 0), "upperarm.L": (-10, 10, 0), "forearm.R": (16, 0, 0), "forearm.L": (14, 0, 0),
        "pendulum": (0, -16, 0), "pallet": (0, 5, 0), "clapper": (-16, 0, 0),
        "spin": {"wheel": 6, "door.R": -6, "door.L": 5, "plate.R": -3, "plate.L": 3}, "ik": PLANT}
HIT_KEYS = [
    (0.0, START),
    (0.12, HIT1),
    (0.32, {"pelvis_loc": (0, -0.015, -0.006), "spine": (2, 0, 1), "chest": (2, 0, 1), "head": (4, 0, -3),
            "upperarm.R": (-4, -4, 0), "upperarm.L": (-3, 3, 0), "forearm.R": (8, 0, 0), "forearm.L": (8, 0, 0),
            "pendulum": (0, 9, 0), "clapper": (8, 0, 0), "spin": {"door.R": 2, "door.L": -2}, "ik": PLANT}),
    (0.7, START),
]
DEATH_LIE = {"pelvis_loc": (0, -0.25, -0.98), "pelvis": (-88, 0, 0), "spine": (-2, 0, 2), "chest": (2, 0, 0), "neck": (-8, 0, 0),
             "head": (-10, 0, 30), "upperarm.R": (10, -20, 0), "upperarm.L": (14, 18, 0), "forearm.R": (8, 0, 0), "forearm.L": (6, 0, 0),
             "claw.R": (0, -20, 0), "claw.L": (0, 20, 0), "thigh.R": (6, 0, 0), "shin.R": (-6, 0, 0), "foot.R": (70, 0, 0),
             "thigh.L": (2, 0, 0), "shin.L": (-4, 0, 0), "foot.L": (70, 0, 0), "pendulum": (0, 0, 0),
             "spin": {"wheel": -36, "door.R": -25, "door.L": 10}}
DEATH_KEYS = [
    (0.0, START),
    (0.3, HIT1),
    (1.0, {"pelvis_loc": (0, 0.02, -0.34), "spine": (-12, 0, 0), "chest": (-10, 0, 0), "head": (-16, 0, 0),
           "upperarm.R": (22, -6, 0), "upperarm.L": (18, 6, 0), "forearm.R": (16, 0, 0), "forearm.L": (16, 0, 0),
           "pendulum": (0, 20, 0), "spin": {"wheel": -24, "door.R": -18, "door.L": 12}, "ik": PLANT}),
    (2.0, DEATH_LIE),
    (2.15, {**DEATH_LIE, "pelvis_loc": (0, -0.25, -0.95), "head": (-6, 0, 26)}),
    (2.8, DEATH_LIE),
]
FROZEN_POSE = {"pelvis_loc": (0, 0.03, -0.05), "spine": (-3, 0, -5), "chest": (-4, 0, -6), "head": (4, 0, 10),
               "upperarm.R": (62, -6, 0), "forearm.R": (30, 0, 0), "upperarm.L": (14, 12, 0), "forearm.L": (20, 0, 0),
               "fluke.in.R": (0, 20, 0), "fluke.out.R": (0, -20, 0), "pendulum": (0, 14, 0), "pallet": (0, -4, 0),
               "spin": {"wheel": -12}, "ik": planted(leg_R=(0.12, 0.13))}
OPEN = {"door.R": -105.0, "door.L": 105.0, "plate.R": -70.0, "plate.L": 70.0}
PHASE_KEYS = [
    (0.0, START),
    (0.6, {"pelvis_loc": (0, -0.02, -0.07), "spine": (4, 0, 0), "chest": (7, 0, 0), "head": (12, 0, 0),
           "upperarm.R": (-6, -22, 0), "upperarm.L": (-6, 22, 0), "forearm.R": (18, 0, 0), "forearm.L": (18, 0, 0),
           "pendulum": (0, 28, 0), "pallet": (0, -8, 0), "clapper": (18, 0, 0),
           "spin": {"wheel": -90, "dial.minute": -180, "dial.hour": -15, "key": 180, "door.R": -6, "door.L": 6}, "ik": PLANT}),
    (1.0, {"pelvis_loc": (0, 0.0, -0.03), "spine": (-3, 0, 0), "chest": (-4, 0, 0), "head": (-6, 0, 0),
           "upperarm.R": (6, -34, 0), "upperarm.L": (6, 34, 0), "forearm.R": (24, 0, 0), "forearm.L": (24, 0, 0),
           "fluke.in.R": (0, 20, 0), "fluke.out.R": (0, -20, 0), "fluke.in.L": (0, -20, 0), "fluke.out.L": (0, 20, 0),
           "pendulum": (0, -30, 0), "pallet": (0, 9, 0), "clapper": (-20, 0, 0), "loc": {"corona": (0, 0.06, 0)},
           "spin": {"wheel": -300, "dial.minute": -540, "dial.hour": -45, "key": 540, **OPEN}, "ik": PLANT}),
    (1.25, {"pelvis_loc": (0, 0.0, -0.04), "chest": (-2, 0, 0), "upperarm.R": (4, -30, 0), "upperarm.L": (4, 30, 0),
            "forearm.R": (20, 0, 0), "forearm.L": (20, 0, 0), "pendulum": (0, 26, 0), "clapper": (16, 0, 0), "loc": {"corona": (0, 0.078, 0)},
            "spin": {"wheel": -420, "dial.minute": -720, "dial.hour": -60, "key": 720, "door.R": -116, "door.L": 116, "plate.R": -78, "plate.L": 78},
            "ik": PLANT}),
    (1.7, {"pelvis_loc": (0, 0.0, -0.03), "upperarm.R": (2, -26, 0), "upperarm.L": (2, 26, 0), "forearm.R": (16, 0, 0), "forearm.L": (16, 0, 0),
           "pendulum": (0, -18, 0), "loc": {"corona": (0, 0.075, 0)},
           "spin": {"wheel": -560, "dial.minute": -900, "dial.hour": -75, "key": 900, **OPEN}, "ik": PLANT}),
    (3.0, {"pelvis_loc": (0, 0.0, -0.025), "upperarm.R": (0, -24, 0), "upperarm.L": (0, 24, 0), "forearm.R": (14, 0, 0), "forearm.L": (14, 0, 0),
           "fluke.in.R": (0, 12, 0), "fluke.out.R": (0, -12, 0), "fluke.in.L": (0, -12, 0), "fluke.out.L": (0, 12, 0),
           "pendulum": (0, 0, 0), "loc": {"corona": (0, 0.075, 0)},
           "spin": {"wheel": -720, "dial.minute": -1080, "dial.hour": -90, "key": 1080, **OPEN}, "ik": PLANT}),
]


def clip_keys(name: str) -> list[tuple[float, dict]]:
    if name == "frozen":
        return [(0.0, FROZEN_POSE), (CLIPS["frozen"]["duration"], FROZEN_POSE)]
    return {"attack": ATTACK_KEYS, "hit": HIT_KEYS, "death": DEATH_KEYS, "phase-change": PHASE_KEYS}[name]


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
    s0, s1 = p0.get("spin", {}), p1.get("spin", {})
    out["spin"] = {k: s0.get(k, 0.0) + (s1.get(k, 0.0) - s0.get(k, 0.0)) * u for k in sorted(set(s0) | set(s1))}
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
    """Armature-axis rotations at each bone head, then `spin` (degrees) about the bone's own axis:
    door and plate hinges, the wheel, dial and key arbors."""
    from mathutils import Euler, Quaternion, Vector

    res = resolve(pose)
    spin = pose.get("spin", {})
    for pb in arm_obj.pose.bones:
        if pb.name == "root":
            continue
        r = pb.bone.matrix_local.to_quaternion()
        rx, ry, rz = res.get(pb.name, (0, 0, 0))
        q = Euler((math.radians(rx), math.radians(ry), math.radians(rz)), "XYZ").to_quaternion()
        pb.rotation_quaternion = r.inverted() @ q @ r @ Quaternion((0, 1, 0), math.radians(spin.get(pb.name, 0.0)))
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
    gnames = [g.name for g in body.vertex_groups]
    owner = np.array([gnames[max(v.groups, key=lambda g: g.weight).group] for v in body.data.vertices])
    keep = ~np.isin(owner, list(SEAM_SYMMETRY))
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
                seam = float(np.abs(co[keep] - first[keep]).max())
                if name == "idle":  # symmetric parts: each vertex must land on some vertex of the rest set
                    for bone in SEAM_SYMMETRY:
                        sel = owner == bone
                        a, b = co[sel], first[sel]
                        dmin = np.sqrt(((a[:, None, :] - b[None, :, :]) ** 2).sum(-1)).min(axis=1)
                        seam = max(seam, float(dmin.max()))
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
    if name == JEWEL:  # ruby, sapphire and emerald from the corner colours (exported as COLOR_0)
        attr = mat.node_tree.nodes.new("ShaderNodeVertexColor")
        attr.layer_name = "jewel"
        mat.node_tree.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
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
    "socket-hit": ("chest", (0, 0.30, 1.90)),  # in front of the glazed doors: hit sparks and aim point
    "socket-eye": ("head", (0, 0.13, 2.94)),  # between the eyes
    "socket-weapon": ("claw.R", (1.095, 0.0, 0.62)),  # the right anchor's crown
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
        export_vertex_color="NONE",  # no jewel slot on the guardian
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

VIEWS = {"front": ((0, 7.6, 1.6), (0, 0, 1.6)), "side": ((7.6, 0, 1.6), (0, 0, 1.6)),
         "back": ((0, -7.6, 1.6), (0, 0, 1.6)), "three-quarter": ((4.8, 6.0, 2.6), (0, 0, 1.55))}
ANIM_CAMERA = ((4.2, 4.2, 2.4), (0, 0.1, 1.45), 40.0)
ROM = {"rig-rom-reach": {"upperarm.R": (140, 0, 0), "forearm.R": (30, 0, 0), "upperarm.L": (0, 40, 0), "forearm.L": (60, 0, 0),
                         "head": (0, 0, 30), "chest": (0, 0, 10), "fluke.in.R": (0, 25, 0), "fluke.out.R": (0, -25, 0), "ik": PLANT},
       "rig-rom-crouch": {"pelvis_loc": (0, 0, -0.3), "spine": (-8, 0, 0), "upperarm.R": (30, 0, 0), "upperarm.L": (30, 0, 0),
                          "forearm.R": (40, 0, 0), "forearm.L": (40, 0, 0), "pendulum": (0, 25, 0), "spin": {"door.R": -60, "plate.L": 50}, "ik": PLANT}}
FRAMES = {"anim-idle": ("idle", 1.5), "anim-attack-raise": ("attack", 0.5), "anim-attack-clamp": ("attack", 0.85),
          "anim-hit": ("hit", 0.12), "anim-frozen": ("frozen", 0.0), "anim-death-kneel": ("death", 1.0), "anim-death-end": ("death", 2.8),
          "anim-phase-mid": ("phase-change", 1.0), "anim-phase-end": ("phase-change", 3.0)}
# Concept-angle comparison: orthographic, framed like the concept panels (camera side, offset).
COMPARE = {"front": (0, 1, 0), "side": (-1, 0, 0), "back": (0, -1, 0)}  # camera direction from the figure (side: its left, as drawn)
COMPARE_Z = 1.58  # crop centre height (sheet feet at y 835 px, crop centre at y 435 px)
M_PER_PX = 3.2 / 808  # concept sheet: feet to bell finial is 808 px for the 3.2 m design height


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


def stage(bpy, scene, floor: bool = True) -> None:
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
    if not floor:
        return
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


def compare_renders(bpy, scene, out: Path) -> list[str]:
    """Orthographic renders at the concept's front, side and back angles, framed like the concept
    crops (CONCEPT_CROPS), on a grey close to the sheet's, for the side-by-side fidelity check."""
    from mathutils import Vector

    rdir = out / "renders"
    rdir.mkdir(parents=True, exist_ok=True)
    cs = bpy.data.scenes.new(f"{PIECE}-compare")
    for o in scene.objects:
        if o.type in {"MESH", "ARMATURE"} and not o.name.startswith("review-"):
            cs.collection.objects.link(o)
    w_, h_ = 460, 415
    setup_render(cs, w_, h_)
    world = bpy.data.worlds.new(f"{PIECE}-compare-world")
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (0.046, 0.039, 0.036, 1.0)
    cs.world = world
    cam = bpy.data.objects.new("compare-cam", bpy.data.cameras.new("compare-cam"))
    cs.collection.objects.link(cam)
    cs.camera = cam
    cam.data.type = "ORTHO"
    key = bpy.data.objects.new("compare-key", bpy.data.lights.new("compare-key", "AREA"))
    fill = bpy.data.objects.new("compare-fill", bpy.data.lights.new("compare-fill", "AREA"))
    for o, e in ((key, 300.0), (fill, 90.0)):
        o.data.energy, o.data.size, o.data.color = e, 2.5, (1.0, 0.86, 0.66)
        cs.collection.objects.link(o)
    done = []
    with bpy.context.temp_override(scene=cs, view_layer=cs.view_layers[0]):
        if bpy.context.window is not None:
            bpy.context.window.scene = cs
        for view, d in COMPARE.items():
            box_ = CONCEPT_CROPS[view]
            cs.render.resolution_x, cs.render.resolution_y = (box_[2] - box_[0]) // 2, (box_[3] - box_[1]) // 2
            cam.data.ortho_scale = max(box_[2] - box_[0], box_[3] - box_[1]) * M_PER_PX
            d = Vector(d)
            side = d.cross(Vector((0, 0, 1)))
            target = Vector((0, 0, COMPARE_Z))
            cam.location = target + d * 8.0
            cam.rotation_euler = (-d).to_track_quat("-Z", "Y").to_euler()
            for o, loc in ((key, target + d * 3.0 + side * 1.6 + Vector((0, 0, 1.4))), (fill, target + d * 3.0 - side * 2.0)):
                o.location = loc
                o.rotation_euler = (target - loc).to_track_quat("-Z", "Y").to_euler()
            shoot(bpy, cs, rdir / f"compare-{view}.png")
            done.append(f"compare-{view}")
    if bpy.context.window is not None:
        bpy.context.window.scene = scene
    return done


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
TITLE = f"P5-T4 Grand Escapement ({PIECE}) - owner review sheet"
ENGINE_SHOTS = ENGINE_SHOTS + ["phase-change-mid", "phase-change-end"]


def fidelity_pairs(out: Path) -> list:
    """(label, image) tiles: each concept view crop beside the textured render at the same angle."""
    from PIL import Image

    sheet = Image.open(CONCEPT).convert("RGB")
    tiles = []
    for view, box in CONCEPT_CROPS.items():
        tiles.append((f"concept {view}", sheet.crop(box)))
        tiles.append((f"model {view} (ortho, same framing)", out / "renders" / f"compare-{view}.png"))
    return tiles


def _grid(sections, cols: int, title: str, note: str, tw=360, th=360):
    from PIL import Image, ImageDraw

    pad, cap, head = 10, 24, 34
    lines = note.split("\n")
    top = 50 + 18 * len(lines)
    sheet = Image.new("RGB", (cols * (tw + pad) + pad, top + len(sections) * (head + th + cap + pad) + pad), (28, 24, 22))
    d = ImageDraw.Draw(sheet)
    d.text((pad, 12), title, fill=(243, 190, 101))
    for i, line in enumerate(lines):
        d.text((pad, 34 + 18 * i), line, fill=(222, 193, 106))
    y = top
    for stitle, tiles in sections:
        d.text((pad, y + 10), stitle, fill=(243, 190, 101))
        y += head
        for k, (label, src) in enumerate(tiles):
            x = pad + k * (tw + pad)
            w = tw if src != CONCEPT else cols * (tw + pad) - pad
            img = src if isinstance(src, Image.Image) else (Image.open(src).convert("RGB") if src.exists() else None)
            if img is not None:
                img = img.copy()
                img.thumbnail((w, th))
                sheet.paste(img, (x + (w - img.width) // 2, y + cap + (th - img.height) // 2))
            else:
                d.text((x + 8, y + cap + 8), f"missing: {src.name}", fill=(200, 80, 80))
            d.text((x, y + 4), label, fill=(222, 193, 106))
        y += th + cap + pad
    return sheet


def fidelity_note(out: Path) -> str:
    f = out / "fidelity.json"
    if not f.exists():
        return "Fidelity self-assessment: not yet scored."
    j = json.loads(f.read_text())
    gaps = "".join(f"\n  - {g}" for g in j.get("gaps", []))
    return f"Fidelity self-assessment (author, not an independent score): {j['score']}/100. Remaining gaps: {gaps}"


def compose_sheet(out: Path) -> Path:
    r = out / "renders"
    eng = out / "engine"
    note = fidelity_note(out)
    pairs = fidelity_pairs(out)
    compare = _grid([("FIDELITY - concept view beside the model at the same angle and framing", pairs)], 6, TITLE.replace("owner review sheet", "fidelity comparison"),
                    note, tw=300, th=420)
    compare.save(out.parent / f"{PIECE}.fidelity-compare.jpg", quality=88)
    sections = [
        ("REFERENCE - escapement-sheet-1.png (concept; owner approval PENDING; the case follows the design notes: taller and narrower than the sheet)", [("concept sheet", CONCEPT)]),
        ("FIDELITY - concept view beside the model at the same angle (orthographic, same framing)", pairs),
        ("MODEL - textured Blender renders (shared brass-polished and walnut sets; gunmetal and glow are factor-only), approval PENDING", [
            ("low front", r / "model-low-front.png"), ("low side", r / "model-low-side.png"), ("low back", r / "model-low-back.png"),
            ("low 3/4", r / "model-low-three-quarter.png"), ("high source 3/4", r / "model-high-three-quarter.png")]),
        (f"RIG - approval PENDING: {len(BONES)} bones, rigid 1-bone skinning, planar leg solve, door/plate hinge bones closed in phase 1", [
            ("range of motion: reach, flukes open", r / "rig-rom-reach.png"), ("range of motion: crouch, door and plate hinges", r / "rig-rom-crouch.png"),
            ("attack claws raised 0.5 s", r / "anim-attack-raise.png"), ("attack clamp (impact) 0.85 s", r / "anim-attack-clamp.png"),
            ("death kneel 1.0 s", r / "anim-death-kneel.png")]),
        ("ANIMATION - Blender frames, approval PENDING (idle: pendulum beats 2 s, wheel steps per beat)", [
            ("idle 1.5 s", r / "anim-idle.png"), ("hit 0.12 s", r / "anim-hit.png"), ("frozen (held)", r / "anim-frozen.png"),
            ("death end 2.8 s", r / "anim-death-end.png"), ("phase-change open 1.0 s", r / "anim-phase-mid.png"),
            ("phase-change end 3.0 s (held open)", r / "anim-phase-end.png")]),
        ("IN ENGINE - three.js 0.186.1, headless Chromium on the GPU, seated player 2.6 m away (64 deg lens for the 3.2 m height)", [
            (name, eng / f"{name}.jpg") for name in ENGINE_SHOTS]),
    ]
    sheet = _grid(sections, max(6, len(ENGINE_SHOTS)), TITLE, APPROVAL_NOTE + "\n" + note)
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
    if args.compare_only:
        set_slots(body, source_materials(bpy))
        print(f"[{PIECE}] tris low={len(body.data.polygons)}")
        compare_renders(bpy, low_scene, args.out.resolve())
        return
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
        report["renders"] = renders(bpy, low_scene, high_scene, arm, actions, out) + compare_renders(bpy, low_scene, out)
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
