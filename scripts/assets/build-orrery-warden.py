"""P5-T4 Orrery Warden: the elite automaton, a slender brass figure about 2.4 m tall under two
armillary rings (about 2.6 m to the ring tops) with an inclined orbit band carrying three jewel
planets, and a long plated skirt (concept assets-source/concepts/warden-sheet-1.png, notes
assets-source/concepts/p5-automatons-design.md, style docs/art-bible.md). Built procedurally from
shaped parts (lofted superellipse sections, bevelled wrap-around plates, lathed shells, swept
bands, extruded outlines), each weighted 1.0 to one bone of a 32-bone armature, with the five
automaton clips of the Cog Sentry contract (P4-T6): idle (loop: the rings and the orbit turn one
full revolution per 12 s loop on their own bones), attack (transit: the orbit whips the planets
round while the right arm thrusts), hit, death (the eclipse disc covers the sun core, the body
falls prone and the orbit folds flat) and frozen (the held mid-transit pose of the time freeze).
Exported as an image-free skinned GLB: the brass slot carries the name of the shared P4-T3 set
(`public/assets/materials/`), so the runtime binds it by name; the factor-only `warden-jewel`
slot takes its ruby, sapphire and emerald hues from COLOR_0 (every other corner is white). UV0
is in tile units (metres / tileMeters). The manifest uses the sentry's schema plus an optional
`cull` sphere measured over every clip frame.

Blender run (build, pose checks, export, reimport gate, manifest, renders, .blend sources):
    "$BLENDER" -b --factory-startup --python-exit-code 1 -P scripts/assets/build-orrery-warden.py -- \
        [--out assets-source/enemies/orrery-warden/staging] [--runtime public/assets/enemies/orrery-warden] \
        [--blend-dir assets-source/enemies/orrery-warden/blend] [--skip-renders] [--compare-only]
Review sheet (system Python with Pillow, after the Blender run and the engine shots):
    python3 -I scripts/assets/build-orrery-warden.py --sheet [--out ...]

Frame: Blender is Z-up; runtime (x, y, z) = Blender (x, z, -y). The warden faces Blender +Y,
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
PIECE = "orrery-warden"
BODY = "warden-body"
DEFAULT_OUT = REPO / f"assets-source/enemies/{PIECE}/staging"
DEFAULT_RUNTIME = REPO / f"public/assets/enemies/{PIECE}"
DEFAULT_BLEND = REPO / f"assets-source/enemies/{PIECE}/blend"
MATERIAL_DIR = REPO / "public/assets/materials"
CONCEPT = REPO / "assets-source/concepts/warden-sheet-1.png"
# Concept panels in sheet pixels (2752x1536): front, side, back (the stray sentry fragment below
# the front view is outside these boxes).
CONCEPT_CROPS = {"front": (150, 30, 890, 1045), "side": (1270, 30, 1680, 1045), "back": (1880, 30, 2600, 1045)}
FPS = 30
HEIGHT_RANGE = (2.5, 2.7)  # metres to the ring tops, rest pose (design notes: about 2.6 m)
DEATH_MAX_Z = 0.85  # lying prone with the rings and orbit folded flat over the back

LIMITS = {"tris": 25_000, "materials": 4, "bones": 40, "influences": 4}
GLOW = "warden-glow"
JEWEL = "warden-jewel"
MATS = ["brass-polished", "gunmetal", GLOW, JEWEL]
BP, GM, GL, JW = range(4)
SETS = {"brass-polished": 0.35}  # shared set -> normal scale (as on the combat table)
TILE_METERS = 0.5  # the brass set tiles at 0.5 m (public/assets/materials/materials.json)
FACTORS = {  # sRGB base, roughness, metallic: the GLB look, and the fallback when the set fails
    "brass-polished": ((0xDE, 0xC1, 0x6A), 0.3, 1.0),
    "gunmetal": ((0x2E, 0x2A, 0x2A), 0.5, 0.85),
    GLOW: ((0x6A, 0x34, 0x0C), 0.4, 0.0),
    JEWEL: ((0xFF, 0xFF, 0xFF), 0.12, 0.0),  # hue from COLOR_0
}
GLOW_SRGB = (0xF0, 0x8C, 0x2C)
GLOW_STRENGTH = 0.7
JEWELS = {"ruby": (0x93, 0x21, 0x2B), "sapphire": (0x2D, 0x4A, 0x93), "emerald": (0x19, 0x74, 0x4C)}  # art bible palette

# Armillary geometry (Blender metres). The halo rings stand behind the head; the orbit band is a
# circle inclined across the shoulders (low in front, high behind and to the right).
RING_C = (0.0, -0.23, 2.15)
RING_OUTER_R, RING_INNER_R = 0.45, 0.335
RING_INNER_YAW = 22.0  # degrees about Z
ORBIT_C = (0.0, -0.04, 2.04)
ORBIT_R = 0.66
ORBIT_TILT = (-26.0, -16.0)  # degrees about X then Y applied to +Z
PLANETS = {"ruby": 196.0, "sapphire": 28.0, "emerald": -38.0}  # angle along the band, from +X toward +Y


def _rx(v, deg):
    a = math.radians(deg)
    return (v[0], v[1] * math.cos(a) - v[2] * math.sin(a), v[1] * math.sin(a) + v[2] * math.cos(a))


def _ry(v, deg):
    a = math.radians(deg)
    return (v[0] * math.cos(a) + v[2] * math.sin(a), v[1], -v[0] * math.sin(a) + v[2] * math.cos(a))


def _rz(v, deg):
    a = math.radians(deg)
    return (v[0] * math.cos(a) - v[1] * math.sin(a), v[0] * math.sin(a) + v[1] * math.cos(a), v[2])


def _add(a, b, k=1.0):
    return tuple(x + k * y for x, y in zip(a, b))


ORBIT_N = _rx(_ry((0, 0, 1), ORBIT_TILT[1]), ORBIT_TILT[0])
ORBIT_U = _rx(_ry((1, 0, 0), ORBIT_TILT[1]), ORBIT_TILT[0])  # in-plane axis at band angle 0
ORBIT_V = _rx(_ry((0, 1, 0), ORBIT_TILT[1]), ORBIT_TILT[0])
RING_INNER_N = _rz((0, -1, 0), RING_INNER_YAW)


def orbit_point(deg: float, r: float = ORBIT_R) -> tuple:
    a = math.radians(deg)
    return _add(_add(ORBIT_C, ORBIT_U, r * math.cos(a)), ORBIT_V, r * math.sin(a))


# Armature: name, parent, head, tail (Blender metres). R is Blender +X. The arms rest in the
# concept's A-pose. Ring, orbit and planet bones sit at their circle's centre and point along its
# normal, so a roll about the bone's own axis turns the part in its plane ("spin" in the poses).
SH = (0.30, 0.0, 1.86)
EL = (0.54, 0.0, 1.52)
WR = (0.765, 0.0, 1.19)
BONES: list[tuple[str, str | None, tuple, tuple]] = [
    ("root", None, (0, 0, 0), (0, 0, 0.2)),
    ("pelvis", "root", (0, 0, 1.02), (0, 0, 1.18)),
    ("spine", "pelvis", (0, 0, 1.18), (0, 0, 1.50)),
    ("chest", "spine", (0, 0, 1.50), (0, 0, 1.95)),
    ("neck", "chest", (0, 0, 1.96), (0, 0, 2.10)),
    ("head", "neck", (0, 0, 2.10), (0, 0, 2.40)),
    ("eclipse", "chest", (0, 0.215, 1.98), (0, 0.33, 1.98)),
    ("mast", "chest", (0, -0.16, 1.62), (0, -0.23, 1.84)),
    ("ring.outer", "mast", RING_C, _add(RING_C, (0, -0.12, 0))),
    ("ring.inner", "mast", RING_C, _add(RING_C, RING_INNER_N, 0.12)),
    ("orbit", "chest", ORBIT_C, _add(ORBIT_C, ORBIT_N, 0.12)),
]
BONES += [(f"planet.{k}", "orbit", ORBIT_C, _add(ORBIT_C, ORBIT_N, 0.1)) for k in PLANETS]
for _s, _n in ((1, "R"), (-1, "L")):
    BONES += [
        (f"clavicle.{_n}", "chest", (_s * 0.06, 0, 1.90), (_s * 0.26, 0, 1.88)),
        (f"upperarm.{_n}", f"clavicle.{_n}", (_s * SH[0], 0, SH[2]), (_s * EL[0], 0, EL[2])),
        (f"forearm.{_n}", f"upperarm.{_n}", (_s * EL[0], 0, EL[2]), (_s * WR[0], 0, WR[2])),
        (f"hand.{_n}", f"forearm.{_n}", (_s * WR[0], 0, WR[2]), (_s * 0.85, 0.02, 1.05)),
        (f"thigh.{_n}", "pelvis", (_s * 0.12, 0, 1.02), (_s * 0.13, 0.01, 0.60)),
        (f"shin.{_n}", f"thigh.{_n}", (_s * 0.13, 0.01, 0.60), (_s * 0.13, -0.01, 0.12)),
        (f"foot.{_n}", f"shin.{_n}", (_s * 0.13, -0.01, 0.12), (_s * 0.13, 0.17, 0.03)),
        (f"skirt.F{_n}", "pelvis", (_s * 0.10, 0.12, 1.36), (_s * 0.16, 0.20, 0.80)),
        (f"skirt.B{_n}", "pelvis", (_s * 0.12, -0.10, 1.36), (_s * 0.20, -0.16, 0.80)),
    ]
BONE_NAMES = [b[0] for b in BONES]
PARENT = {b[0]: b[1] for b in BONES}
HEAD = {b[0]: b[2] for b in BONES}
TAIL = {b[0]: b[3] for b in BONES}
LOC_BONE = "pelvis"  # carries the body (in place: code owns root motion)
LOC_EXTRA = ("orbit",)  # the orbit slides behind the back as it folds (death)
SPIN_BONES = ("ring.outer", "ring.inner", "orbit", *(f"planet.{k}" for k in PLANETS))
# Planar leg solve: chain (upper, lower, distal) and knee side (+1 forward, -1 back).
LEGS = {f"leg.{n}": (f"thigh.{n}", f"shin.{n}", f"foot.{n}", 1) for n in ("R", "L")}

CLIPS = {
    "idle": {"duration": 12.0, "loop": "repeat", "events": {}},
    "attack": {"duration": 1.6, "loop": "once", "events": {"impact": 0.8}},
    "hit": {"duration": 0.7, "loop": "once", "events": {}},
    "death": {"duration": 2.6, "loop": "once", "events": {"down": 1.9}},
    "frozen": {"duration": 1.0, "loop": "repeat", "events": {}},
}

DETAIL = {"low": 0.6, "high": 1.6}  # segment multiplier


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


# Torso and skirt radii (half-width rx across X, half-depth ry along Y) by height.
def torso_r(z: float) -> tuple[float, float]:
    pts = [(1.42, 0.13, 0.10), (1.52, 0.14, 0.11), (1.62, 0.172, 0.13), (1.74, 0.215, 0.148), (1.86, 0.236, 0.152),
           (1.94, 0.215, 0.14), (1.985, 0.17, 0.115), (2.01, 0.11, 0.085)]
    for (z0, a0, b0), (z1, a1, b1) in zip(pts, pts[1:]):
        if z <= z1:
            u = min(1.0, max(0.0, (z - z0) / (z1 - z0)))
            return a0 + (a1 - a0) * u, b0 + (b1 - b0) * u
    return pts[-1][1], pts[-1][2]


def skirt_r(v: float) -> float:
    """Skirt radius by axial fraction v (0 at the belt, 1 at the hem): flaring like a tasset."""
    return 0.205 + 0.11 * v - 0.03 * v * v


def build_parts(P: Parts) -> None:
    from mathutils import Euler, Matrix, Vector

    up, fwd = (0, 0, 1), (0, 1, 0)
    I4 = Matrix.Identity(4)
    jewel = {k: tuple(lin(c) for c in v) for k, v in JEWELS.items()}

    # --- Head: a narrow helmet (superellipse lofts), crest, visor, glowing eyes, ear discs.
    hs = [(0.0, 0.040, 0.050, 2.2), (0.06, 0.066, 0.078, 2.2), (0.22, 0.090, 0.104, 2.5), (0.45, 0.100, 0.118, 2.6),
          (0.68, 0.098, 0.112, 2.5), (0.85, 0.083, 0.094, 2.3), (0.96, 0.052, 0.060, 2.1), (1.0, 0.012, 0.014, 2.0)]
    P.loft((0, 0.005, 2.09), (0, 0.005, 2.415), [(f, rx, ry, pw, 0, 0) for f, rx, ry, pw in hs], BP, "head")
    P.sweep([(0, 0.128 * math.cos(a), 2.245 + 0.178 * math.sin(a)) for a in [math.radians(d) for d in range(20, 171, 15)]],
            chamfer_rect(0.012, 0.022), BP, "head", hint=(1, 0, 0))
    P.wrap((0, 0.005, 2.272), (0, 0.005, 2.302), lambda v: 0.131 - 0.004 * v, -1.1, 1.1, 0.016, GM, "head", sx=0.80, nu=P.n(12), nv=2)
    for s in (1, -1):
        P.ball((s * 0.043, 0.121, 2.252), 0.019, GL, "head", (1.45, 0.55, 0.75))
        P.lathe((s * 0.095, 0.0, 2.25), (s, 0, 0), [(0.0, 0.0), (0.042, 0.0), (0.042, 0.018), (0.03, 0.026), (0.0, 0.026)], BP, "head")
        P.lathe((s * 0.12, 0.0, 2.25), (s, 0, 0), [(0.0, 0.0), (0.016, 0.0), (0.016, 0.008), (0.0, 0.008)], GM, "head")
    P.wrap((0, 0.0, 2.115), (0, 0.0, 2.18), lambda v: 0.088 + 0.025 * v, -0.55, 0.55, 0.012, GM, "head", sx=0.9, nu=P.n(8), nv=2)
    for x in (-0.018, 0.0, 0.018):
        P.bbox((x, 0.104, 2.148), (0.006, 0.012, 0.05), BP, "head", bevel=0.0)

    # --- Neck: ribbed gunmetal column, brass gorget.
    P.tube((0, 0, 1.95), (0, 0, 2.13), 0.046, 0.042, GM, "neck")
    for z in (2.0, 2.04, 2.08):
        P.sweep_ring((0, 0, z), up, 0.05, 0.05, chamfer_rect(0.014, 0.014), GM, "neck", n=P.n(18))

    # --- Chest: gunmetal torso under shaped brass breastplates around the sun core.
    zs = [1.48, 1.56, 1.66, 1.76, 1.86, 1.94, 1.985, 2.01]
    P.rings([sect(*torso_r(z), P.n(24), 2.2) for z in zs], zs, I4, GM, "chest")
    core_z = 1.80
    cut = lambda v: 0.11 + 0.42 * math.exp(-(((1.56 + 0.40 * v) - core_z) / 0.075) ** 2)  # noqa: E731
    for s in (1, -1):
        a0 = (lambda v: s * cut(v)) if s > 0 else (lambda v: -1.62)
        a1 = (lambda v: 1.62) if s > 0 else (lambda v: -cut(v))
        P.wrap((0, 0.0, 1.56), (0, 0.0, 1.96), lambda v: torso_r(1.56 + 0.4 * v)[0] + 0.022, a0, a1, 0.02, BP, "chest",
               sy=lambda v: (torso_r(1.56 + 0.4 * v)[1] + 0.022) / (torso_r(1.56 + 0.4 * v)[0] + 0.022), nu=P.n(12), nv=P.n(8), p=2.4, bevel=0.005)
    for s in (1, -1):  # breastplate ridges: the panel break below each plate
        P.sweep([(s * (0.05 + 0.18 * f), 0.13 - 0.03 * f * f, 1.585 + 0.03 * f) for f in (0.0, 0.33, 0.66, 1.0)],
                chamfer_rect(0.012, 0.012), BP, "chest", hint=(0, 1, 0))
    rb = lambda r: [(0.0, 0.0), (r, 0.0), (r, 0.012), (r * 0.82, 0.02), (r * 0.55, 0.014), (0.0, 0.014)]  # noqa: E731
    P.shell((0, 0.148, core_z), fwd, [(0.0, 0.0), (0.075, 0.0), (0.075, 0.016), (0.064, 0.03), (0.050, 0.022), (0.0, 0.022)], BP, "chest", sides=P.n(28))
    P.lathe((0, 0.16, core_z), fwd, [(0.0, 0.0), (0.050, 0.0), (0.048, 0.02), (0.03, 0.034), (0.0, 0.038)], GL, "chest", sides=P.n(24))
    for k in range(8):  # sun rays engraved round the bezel
        a = 2 * math.pi * k / 8 + math.pi / 8
        P.bbox((0.088 * math.cos(a), 0.162, core_z + 0.088 * math.sin(a)), (0.022, 0.01, 0.01), BP, "chest",
               rot=Euler((0, -a, 0)).to_matrix(), bevel=0.0)
    P.bbox((0, 0.135, 1.665), (0.016, 0.014, 0.13), GL, "chest", bevel=0.0)
    for s in (1, -1):
        P.bbox((s * 0.019, 0.142, 1.665), (0.012, 0.02, 0.15), BP, "chest", bevel=0.003)
    rbk = lambda v: torso_r(1.56 + 0.38 * v)[1] + 0.02  # noqa: E731
    for s in (1, -1):  # back plates either side of the spine channel
        lo, hi = (math.pi + 0.1, math.pi + 1.5) if s > 0 else (math.pi - 1.5, math.pi - 0.1)
        P.wrap((0, 0, 1.56), (0, 0, 1.94), lambda v: torso_r(1.56 + 0.38 * v)[0] + 0.02, lo, hi, 0.018, BP, "chest",
               sy=lambda v: rbk(v) / (torso_r(1.56 + 0.38 * v)[0] + 0.02), nu=P.n(10), nv=P.n(6), p=2.4)
    m = Matrix.Translation((0, -0.17, 1.76)) @ Euler((math.pi / 2, 0, 0)).to_matrix().to_4x4()
    P.annulus(gear_outline(0.06, 0.075, 10), circle(0.028, 50), m, 0.02, GM, "chest")
    P.lathe((0, -0.16, 1.76), (0, -1, 0), [(0.0, 0.0), (0.02, 0.0), (0.02, 0.022), (0.0, 0.026)], BP, "chest")
    P.sweep_ring((0, 0, 2.0), up, 0.165, 0.112, chamfer_rect(0.03, 0.026), BP, "chest", n=P.n(32))
    # Eclipse disc: a dark moon on a brass arm from the sternum pivot, resting over the left breast.
    P.tube((0, 0.215, 1.98), (-0.135, 0.215, 1.902), 0.008, 0.008, BP, "eclipse", sides=8)
    P.lathe((0, 0.207, 1.98), fwd, [(0.0, 0.0), (0.018, 0.0), (0.018, 0.016), (0.0, 0.016)], BP, "eclipse", sides=12)
    disc = (-0.156, 0.218, 1.89)
    P.lathe(disc, fwd, [(0.0, -0.006), (0.058, -0.006), (0.058, 0.006), (0.0, 0.006)], GM, "eclipse", sides=P.n(24))
    P.sweep_ring(disc, fwd, 0.058, 0.058, chamfer_rect(0.008, 0.014), BP, "eclipse", n=P.n(24))

    # --- Waist: gunmetal ribs with the glowing side vents, a brass abdominal plate.
    zs = [1.38, 1.44, 1.50, 1.56]
    P.rings([sect(0.13, 0.10, P.n(20), 2.2) for _ in zs], zs, I4, GM, "spine")
    for z in (1.43, 1.48, 1.53):
        P.sweep_ring((0, 0, z), up, 0.138, 0.106, chamfer_rect(0.016, 0.018), GM, "spine", n=P.n(24))
    for s in (1, -1):
        P.bbox((s * 0.118, 0.04, 1.48), (0.012, 0.03, 0.12), GL, "spine", bevel=0.0)
    P.wrap((0, 0, 1.40), (0, 0, 1.58), lambda v: 0.112, -0.42, 0.42, 0.016, BP, "spine", sx=1.2, nu=P.n(6), nv=3)

    # --- Pelvis: hip block, belt with a buckle plate, the narrow front centre tasset.
    zs = [1.04, 1.16, 1.30, 1.40]
    P.rings([sect(0.15, 0.11, P.n(20), 2.3), sect(0.175, 0.125, P.n(20), 2.3), sect(0.17, 0.125, P.n(20), 2.3), sect(0.14, 0.105, P.n(20), 2.3)], zs, I4, GM, "pelvis")
    P.sweep_ring((0, 0, 1.385), up, 0.188, 0.142, chamfer_rect(0.03, 0.05), BP, "pelvis", n=P.n(32))
    P.wrap((0, 0, 1.36), (0, 0, 0.60), lambda v: skirt_r(v) * 0.82 + 0.03, -0.15, 0.15, 0.016, BP, "pelvis",
           v1=lambda u: 0.90 + 0.10 * (1 - abs(2 * u - 1)), sy=1.0, nu=P.n(6), nv=P.n(8))
    P.wrap((0, 0, 1.37), (0, 0, 0.58), lambda v: skirt_r(v) * 0.8 + 0.02, -0.5, 0.5, 0.012, GM, "pelvis", sy=0.95, nu=P.n(8), nv=P.n(6), bevel=0.0)
    P.wrap((0, 0, 1.36), (0, 0, 0.66), lambda v: skirt_r(v) * 0.80, math.pi - 0.14, math.pi + 0.14, 0.016, BP, "pelvis", nu=P.n(4), nv=P.n(6))

    # --- Skirt: front, side and back tassets with pointed hems, layered so the edges overlap.
    for s, n_ in ((1, "R"), (-1, "L")):
        for bone, lo, hi, off, hem in ((f"skirt.F{n_}", 0.17, 0.98, 0.035, 0.98), (f"skirt.B{n_}", 1.0, 1.72, 0.012, 0.86),
                                       (f"skirt.B{n_}", 1.74, 2.52, 0.0, 0.95), (f"skirt.B{n_}", 2.54, 3.08, 0.022, 0.98)):
            a0, a1 = (lo, hi) if s > 0 else (-hi, -lo)
            P.wrap((0, 0, 1.37), (0, 0, 0.56), lambda v, o=off: skirt_r(v) + o, a0, a1, 0.018, BP, bone,
                   v1=lambda u, h=hem, sgn=s: h - 0.13 * abs(u - (0.62 if sgn > 0 else 0.38)), sy=0.80, nu=P.n(12), nv=P.n(8), bevel=0.006)
            a_mid = (a0 + a1) / 2  # raised rib down the middle of each tasset
            P.wrap((0, 0, 1.37), (0, 0, 0.56), lambda v, o=off: skirt_r(v) + o + 0.012, a_mid - 0.05, a_mid + 0.05, 0.014, BP, bone,
                   v0=0.08, v1=hem - 0.12, sy=0.80, nu=3, nv=P.n(6), bevel=0.003)

    # --- Arms: layered pauldrons with jewel inlays, plated upper arm, elbow, vambrace, hand.
    for s, n_ in ((1, "R"), (-1, "L")):
        sh, el, wr = (s * SH[0], 0.0, SH[2]), (s * EL[0], 0.0, EL[2]), (s * WR[0], 0.0, WR[2])
        cap = _add(sh, (s * 0.01, 0, 0.02))
        ax = (s * 0.42, 0.0, 0.91)
        P.shell(cap, ax, [(0.0, 0.115), (0.08, 0.105), (0.14, 0.07), (0.17, 0.0), (0.172, -0.035), (0.155, -0.035), (0.152, 0.0), (0.125, 0.06),
                          (0.07, 0.09), (0.0, 0.098)], BP, f"upperarm.{n_}", sx=1.0, sy=1.05)
        P.shell(_add(cap, (s * 0.05, 0, -0.09)), ax, [(0.0, 0.07), (0.11, 0.06), (0.185, 0.005), (0.19, -0.055), (0.172, -0.055), (0.17, 0.0),
                                                      (0.10, 0.045), (0.0, 0.052)], BP, f"upperarm.{n_}", sx=1.0, sy=1.05)
        P.sweep_ring(_add(cap, (s * 0.015, 0, 0.0)), ax, 0.172, 0.18, chamfer_rect(0.012, 0.018), GM, f"upperarm.{n_}", n=P.n(28))
        gem = _add(cap, (s * 0.06, 0.145, 0.03))
        P.ball(gem, 0.024, JW, f"upperarm.{n_}", color=jewel["ruby" if s > 0 else "emerald"])
        P.lathe(_add(gem, (0, -0.012, 0)), (0, 1, 0), [(0.0, -0.004), (0.034, -0.004), (0.034, 0.008), (0.0, 0.008)], BP, f"upperarm.{n_}", sides=12)
        P.ball(sh, 0.06, GM, f"upperarm.{n_}")
        P.loft(sh, el, [(0.05, 0.062, 0.064, 2.0, 0, 0), (0.95, 0.05, 0.052, 2.0, 0, 0)], GM, f"upperarm.{n_}")
        P.wrap(sh, el, lambda v: 0.076 - 0.014 * v, -0.4 if s > 0 else -2.4, 2.4 if s > 0 else 0.4, 0.014, BP, f"upperarm.{n_}",
               v0=0.25, v1=0.9, nu=P.n(8), nv=3)
        P.ball(el, 0.058, GM, f"forearm.{n_}")
        P.loft(el, wr, [(0.06, 0.058, 0.058, 2.3, 0, 0), (0.22, 0.074, 0.07, 2.6, 0, 0), (0.7, 0.064, 0.06, 2.6, 0, 0), (0.92, 0.046, 0.044, 2.2, 0, 0),
                        (1.0, 0.036, 0.036, 2.0, 0, 0)], BP, f"forearm.{n_}")
        for f in (0.12, 0.62):
            P.sweep_ring(lerp(el, wr, f), (s * (WR[0] - EL[0]), 0, WR[2] - EL[2]), 0.07 - 0.012 * f, 0.067 - 0.012 * f, chamfer_rect(0.01, 0.014), GM,
                         f"forearm.{n_}", n=P.n(18))
        # Hand: bevelled palm, two-segment fingers splayed and slightly curled, thumb forward.
        d = Vector((s * 0.08, 0.02, -0.14)).normalized()
        side = Vector((0, 1, 0)).cross(d).normalized() if s > 0 else d.cross(Vector((0, 1, 0))).normalized()
        palm = Vector(wr) + d * 0.045
        rot = Matrix((side, Vector((0, 1, 0)), d)).transposed()
        P.bbox(palm, (0.085, 0.038, 0.095), BP, f"hand.{n_}", rot=rot, bevel=0.008)
        P.ball(Vector(wr), 0.034, GM, f"hand.{n_}")
        for k in range(4):
            base = palm + d * 0.045 + side * (0.026 * (k - 1.5))
            spread = side * (0.008 * (k - 1.5))
            mid = base + (d + spread * 4) * 0.055 + Vector((0, 0.01, 0))
            tip = mid + (d + Vector((0, 0.4, 0))).normalized() * 0.05
            P.tube(base, mid, 0.012, 0.011, GM, f"hand.{n_}", sides=6)
            P.tube(mid, tip, 0.011, 0.008, BP, f"hand.{n_}", sides=6)
        tb = palm + side * (-0.04) + Vector((0, 0.025, 0))
        P.tube(tb, tb + (d * 0.5 + Vector((0, 0.8, 0))).normalized() * 0.06, 0.013, 0.009, BP, f"hand.{n_}", sides=6)

    # --- Legs: gunmetal hip and thigh, brass thigh plate, knee cop, shaped greave, layered sabaton.
    for s, n_ in ((1, "R"), (-1, "L")):
        hip, knee, ank = (s * 0.12, 0, 1.02), (s * 0.13, 0.01, 0.60), (s * 0.13, -0.01, 0.12)
        P.ball(hip, 0.075, GM, f"thigh.{n_}")
        P.loft(hip, knee, [(0.0, 0.085, 0.088, 2.0, 0, 0), (0.5, 0.08, 0.082, 2.0, 0, 0), (1.0, 0.064, 0.066, 2.0, 0, 0)], GM, f"thigh.{n_}")
        P.wrap(hip, knee, lambda v: 0.097 - 0.02 * v, -1.25, 1.25, 0.014, BP, f"thigh.{n_}", v0=0.3, v1=0.88, nu=P.n(8), nv=3)
        P.ball(knee, 0.066, GM, f"shin.{n_}")
        P.shell(_add(knee, (0, 0.05, 0.0)), (0, 1, 0), [(0.0, 0.04), (0.045, 0.034), (0.072, 0.0), (0.066, -0.005), (0.04, 0.022), (0.0, 0.028)],
                BP, f"shin.{n_}", sy=1.3)
        P.loft(knee, ank, [(0.08, 0.068, 0.07, 2.0, 0, 0.0), (0.25, 0.082, 0.09, 2.7, 0, -0.016), (0.55, 0.076, 0.082, 2.7, 0, -0.014),
                           (0.88, 0.056, 0.06, 2.4, 0, -0.006), (1.0, 0.046, 0.048, 2.0, 0, 0)], BP, f"shin.{n_}")
        P.loft(lerp(knee, ank, 0.12), lerp(knee, ank, 0.8), [(0.0, 0.05, 0.05, 2.0, 0, 0.03), (1.0, 0.04, 0.04, 2.0, 0, 0.03)], GM, f"shin.{n_}")
        P.sweep([_add(lerp(knee, ank, f), (0, 0.098 - 0.04 * f, 0)) for f in (0.14, 0.4, 0.7, 0.93)], chamfer_rect(0.012, 0.012), BP,
                f"shin.{n_}", hint=(0, 1, 0))
        P.ball(ank, 0.04, GM, f"foot.{n_}")
        m, _ = axis_frame((s * 0.13, -0.09, 0.0), (s * 0.13, 0.25, 0.0))
        secs = [(0.0, 0.05, 0.035, 2.4, 0, -0.035), (0.12, 0.058, 0.055, 2.6, 0, -0.055), (0.45, 0.06, 0.05, 2.8, 0, -0.05),
                (0.75, 0.055, 0.03, 2.8, 0, -0.03), (1.0, 0.03, 0.012, 2.4, 0, -0.012)]
        P.rings([sect(rx, ry, P.n(16), pw, cx, cy) for _, rx, ry, pw, cx, cy in secs], [f * 0.34 for f, *_ in secs], m, BP, f"foot.{n_}")
        P.wrap((s * 0.13, -0.09, 0.045), (s * 0.13, 0.20, 0.045), 0.062, math.pi - 1.3, math.pi + 1.3, 0.01, BP, f"foot.{n_}", v0=0.55, v1=0.85, sx=1.0, sy=1.05,
               nu=P.n(8), nv=2)
        P.lathe((s * 0.13, -0.035, 0.07), (0, -1, 0), [(0.0, 0.0), (0.05, 0.0), (0.045, 0.04), (0.0, 0.05)], GM, f"foot.{n_}", sx=1.1)

    # --- Armillary: two flat halo bands (with node bosses so the turn reads) on a back yoke.
    for r, bone, normal, nodes in ((RING_OUTER_R, "ring.outer", (0, -1, 0), 8), (RING_INNER_R, "ring.inner", RING_INNER_N, 6)):
        P.band(RING_C, normal, r, 0.04, 0.016, BP, bone, n=P.n(64))
        P.sweep_ring(RING_C, normal, r - 0.012, r - 0.012, chamfer_rect(0.006, 0.022), BP, bone, n=P.n(64))
        P.sweep_ring(RING_C, normal, r + 0.012, r + 0.012, chamfer_rect(0.006, 0.022), BP, bone, n=P.n(64))
        mm, _ = axis_frame(RING_C, _add(RING_C, normal))
        for k in range(nodes):
            a = 2 * math.pi * k / nodes
            c = mm @ Vector((r * math.cos(a), r * math.sin(a), 0.0))
            P.lathe(c - Vector(normal) * 0.018, normal, [(0.0, 0.0), (0.018, 0.0), (0.022, 0.018), (0.018, 0.036), (0.0, 0.036)], BP, bone, sides=10)
    P.loft((0, -0.15, 1.60), (0, -0.23, 1.86), [(0.0, 0.03, 0.026, 2.0, 0, 0), (1.0, 0.022, 0.02, 2.0, 0, 0)], GM, "mast")
    for z, r in ((RING_C[2] - RING_OUTER_R - 0.01, 0.026), (RING_C[2] - RING_INNER_R - 0.01, 0.022)):
        P.lathe((-0.035, -0.23, z - 0.02), (1, 0, 0), [(0.0, 0.0), (r, 0.0), (r, 0.07), (0.0, 0.07)], GM, "mast", sides=12)
    P.bbox((0, -0.23, RING_C[2] - RING_OUTER_R - 0.05), (0.08, 0.03, 0.04), GM, "mast")

    # --- Orbit band with the three jewel planets riding on it (brass collars and cap pins).
    P.band(ORBIT_C, ORBIT_N, ORBIT_R, 0.026, 0.012, BP, "orbit", n=P.n(72))
    for k in range(12):  # graduation ticks
        c = orbit_point(30.0 * k + 15.0)
        P.lathe(_add(c, ORBIT_N, -0.012), ORBIT_N, [(0.0, 0.0), (0.008, 0.0), (0.008, 0.024), (0.0, 0.024)], BP, "orbit", sides=6)
    for name, deg in PLANETS.items():
        c = orbit_point(deg)
        r = {"ruby": 0.058, "sapphire": 0.05, "emerald": 0.054}[name]
        P.ball(c, r, JW, f"planet.{name}", color=jewel[name], segs=(P.n(18), P.n(10)))
        P.sweep_ring(c, ORBIT_N, r * 0.98, r * 0.98, chamfer_rect(0.008, 0.012), BP, f"planet.{name}", n=P.n(20))
        P.lathe(_add(c, ORBIT_N, r * 0.9), ORBIT_N, [(0.0, 0.0), (0.008, 0.0), (0.005, 0.02), (0.0, 0.024)], BP, f"planet.{name}", sides=8)
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
    for v in P.bm.verts:  # flatten the sole rings onto the floor: the rest pose must stand on y = 0 (asset-check, test)
        if v.co.z < 0.002:
            v.co.z = 0.0
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
SKIRT = ("skirt.FR", "skirt.FL", "skirt.BR", "skirt.BL")


def idle_pose(t: float) -> dict:
    """12 s loop: breathing on a 3 s cycle, a 6 s head and body sway, and the armillary turning one
    full revolution per loop (outer ring and orbit one way, inner ring the other)."""
    w = 2 * math.pi * t / CLIPS["idle"]["duration"]
    br, sway, turn = math.sin(4 * w), math.sin(2 * w), 360.0 * t / CLIPS["idle"]["duration"]
    return {
        "pelvis_loc": (0, 0, 0.006 * br),
        "spine": (1.0 * br, 0, 1.2 * sway), "chest": (-0.8 * br, 0, 1.5 * sway), "neck": (0, 0, 2.0 * sway),
        "head": (2.5 * math.sin(2 * w + 0.6), 0, 7.0 * sway),
        "upperarm.R": (2.0 * br, -1.5 * sway, 0), "upperarm.L": (-2.0 * br, 1.5 * sway, 0),
        "forearm.R": (4 + 2 * br, 0, 0), "forearm.L": (4 - 2 * br, 0, 0),
        "hand.R": (3 * math.sin(4 * w + 1), 0, 0), "hand.L": (3 * math.sin(4 * w + 2), 0, 0),
        **{b: (0.8 * math.sin(4 * w + k), 0, 0) for k, b in enumerate(SKIRT)},
        "spin": {"ring.outer": turn, "ring.inner": -turn, "orbit": turn,
                 "planet.ruby": 6 * math.sin(4 * w), "planet.sapphire": 6 * math.sin(4 * w + 2.1), "planet.emerald": 6 * math.sin(4 * w + 4.2)},
        "ik": PLANT,
    }


START = {**ARMS_REST, "ik": PLANT}
WIND = {"pelvis_loc": (0, -0.02, -0.02), "spine": (3, 0, -6), "chest": (2, 0, -14), "head": (0, 0, 10),
        "upperarm.R": (40, -25, 0), "forearm.R": (35, 0, 0), "hand.R": (10, 0, 0), "upperarm.L": (-12, 10, 0), "forearm.L": (12, 0, 0),
        "skirt.FR": (4, 0, 0), "skirt.FL": (-3, 0, 0), "spin": {"orbit": -50, "ring.outer": -10, "ring.inner": 10}, "ik": PLANT}
THRUST = {"pelvis_loc": (0, 0.05, -0.04), "spine": (-6, 0, 6), "chest": (-6, 0, 14), "head": (-4, 0, -6),
          "upperarm.R": (86, -8, 0), "forearm.R": (4, 0, 0), "hand.R": (-15, 0, 0), "upperarm.L": (-20, 25, 0), "forearm.L": (20, 0, 0),
          "skirt.FR": (-6, 0, 0), "skirt.FL": (8, 0, 0), "skirt.BR": (6, 0, 0), "skirt.BL": (4, 0, 0),
          "spin": {"orbit": 230, "planet.ruby": 28, "planet.sapphire": 12, "planet.emerald": -16, "ring.outer": 30, "ring.inner": -30},
          "ik": planted(leg_R=(0.10, 0.12))}
ATTACK_KEYS = [
    (0.0, START),
    (0.45, WIND),
    (0.8, THRUST),
    (1.05, {**THRUST, "spin": {"orbit": 300, "planet.ruby": 20, "planet.sapphire": 8, "planet.emerald": -10, "ring.outer": 20, "ring.inner": -20}}),
    (1.6, {**START, "spin": {"orbit": 360}}),
]
HIT1 = {"pelvis_loc": (0, -0.05, -0.015), "spine": (7, 0, 3), "chest": (6, 0, 5), "head": (14, 0, -9),
        "upperarm.R": (-12, -14, 0), "upperarm.L": (-10, 12, 0), "forearm.R": (18, 0, 0), "forearm.L": (16, 0, 0),
        "skirt.FR": (8, 0, 0), "skirt.FL": (8, 0, 0), "skirt.BR": (-6, 0, 0), "skirt.BL": (-6, 0, 0),
        "spin": {"orbit": -22, "ring.outer": 8, "ring.inner": -10, "planet.ruby": -10, "planet.emerald": 12}, "ik": PLANT}
HIT_KEYS = [
    (0.0, START),
    (0.12, HIT1),
    (0.32, {"pelvis_loc": (0, -0.015, -0.005), "spine": (2, 0, 1), "chest": (2, 0, 2), "head": (4, 0, -3),
            "upperarm.R": (-4, -4, 0), "upperarm.L": (-3, 3, 0), "forearm.R": (8, 0, 0), "forearm.L": (8, 0, 0),
            "spin": {"orbit": 6, "ring.outer": -3, "ring.inner": 3, "planet.ruby": 4, "planet.emerald": -4}, "ik": PLANT}),
    (0.7, START),
]
ECLIPSE = (0, -60, 0)  # swings the dark disc from the left breast over the sun core
DEATH_LIE = {"pelvis_loc": (0, -0.15, -0.80), "pelvis": (-88, 0, 0), "spine": (-2, 0, 3), "chest": (2, 0, 0), "neck": (-6, 0, 0),
             "head": (-8, 0, 35), "eclipse": ECLIPSE, "fold": 1.0,
             "upperarm.R": (4, -12, 0), "upperarm.L": (6, 10, 0), "forearm.R": (8, 0, 0), "forearm.L": (6, 0, 0),
             "skirt.FR": (-10, 0, 0), "skirt.FL": (-10, 0, 0), "skirt.BR": (6, 0, 0), "skirt.BL": (4, 0, 0),
             "thigh.R": (6, 0, 0), "shin.R": (-6, 0, 0), "foot.R": (70, 0, 0), "thigh.L": (2, 0, 0), "shin.L": (-4, 0, 0), "foot.L": (70, 0, 0),
             "spin": {"orbit": 80, "ring.outer": 15, "ring.inner": -20}}
DEATH_KEYS = [
    (0.0, START),
    (0.3, {**HIT1, "eclipse": ECLIPSE}),
    (0.95, {"pelvis_loc": (0, 0.02, -0.30), "spine": (-14, 0, 0), "chest": (-10, 0, 0), "head": (-16, 0, 0),
            "upperarm.R": (20, -6, 0), "upperarm.L": (16, 6, 0), "forearm.R": (16, 0, 0), "forearm.L": (16, 0, 0),
            "skirt.FR": (25, 0, 0), "skirt.FL": (25, 0, 0), "eclipse": ECLIPSE, "fold": 0.5, "spin": {"orbit": 40, "ring.outer": 8, "ring.inner": -10},
            "ik": PLANT}),
    (1.9, DEATH_LIE),
    (2.05, {**DEATH_LIE, "pelvis_loc": (0, -0.15, -0.77), "head": (-4, 0, 31)}),
    (2.6, DEATH_LIE),
]
FROZEN_POSE = {"pelvis_loc": (0, 0.02, -0.03), "spine": (-3, 0, 4), "chest": (-3, 0, 10), "head": (2, 0, -8),
               "upperarm.R": (70, -15, 0), "forearm.R": (10, 0, 0), "hand.R": (-10, 0, 0), "upperarm.L": (-10, 20, 0), "forearm.L": (25, 0, 0),
               "skirt.FR": (-4, 0, 0), "spin": {"orbit": 70, "planet.ruby": 22, "planet.sapphire": 8, "planet.emerald": -14, "ring.outer": 20, "ring.inner": -25},
               "ik": planted(leg_R=(0.08, 0.12))}


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
    s0, s1 = p0.get("spin", {}), p1.get("spin", {})
    out["spin"] = {k: s0.get(k, 0.0) + (s1.get(k, 0.0) - s0.get(k, 0.0)) * u for k in sorted(set(s0) | set(s1))}
    out["fold"] = p0.get("fold", 0.0) + (p1.get("fold", 0.0) - p0.get("fold", 0.0)) * u
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


FOLD_SHIFT = (0.0, -0.38, 0.0)  # the folded orbit settles flat behind the back, clear of the halo rings


def apply_pose(arm_obj, pose: dict, frame: int | None) -> None:
    """Armature-axis rotations at each bone head, then `spin` (degrees) about the bone's own axis
    (rings, orbit and planets turn in their plane), and `fold` (0..1), which turns the orbit band
    into the body's frontal plane and slides it behind the back (death)."""
    from mathutils import Euler, Quaternion, Vector

    res = resolve(pose)
    spin = pose.get("spin", {})
    fold = pose.get("fold", 0.0)
    q_fold = Quaternion().slerp(Vector(ORBIT_N).rotation_difference(Vector((0, 1, 0))), fold)
    for pb in arm_obj.pose.bones:
        if pb.name == "root":
            continue
        r = pb.bone.matrix_local.to_quaternion()
        rx, ry, rz = res.get(pb.name, (0, 0, 0))
        q = Euler((math.radians(rx), math.radians(ry), math.radians(rz)), "XYZ").to_quaternion()
        if pb.name == "orbit":
            q = q_fold @ q
        pb.rotation_quaternion = r.inverted() @ q @ r @ Quaternion((0, 1, 0), math.radians(spin.get(pb.name, 0.0)))
        if frame is not None:
            pb.keyframe_insert("rotation_quaternion", frame=frame)
        if pb.name == LOC_BONE or pb.name in LOC_EXTRA:
            loc = pose.get("pelvis_loc", (0, 0, 0)) if pb.name == LOC_BONE else tuple(fold * c for c in FOLD_SHIFT)
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
    "socket-hit": ("chest", (0, 0.24, 1.80)),  # in front of the sun core: hit sparks and aim point
    "socket-eye": ("head", (0, 0.14, 2.255)),  # between the eyes
    "socket-weapon": ("hand.R", (0.85, 0.04, 1.04)),  # the thrusting right hand (transit)
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
        # ACTIVE, not MATERIAL: Blender 5.2 MATERIAL mode writes a white COLOR_0 placeholder and moves the
        # layer to COLOR_1, which three.js ignores.
        export_vertex_color="ACTIVE",  # COLOR_0 for the jewel slot (white on every other corner)
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

VIEWS = {"front": ((0, 6.4, 1.4), (0, 0, 1.3)), "side": ((6.4, 0, 1.4), (0, 0, 1.3)),
         "back": ((0, -6.4, 1.4), (0, 0, 1.3)), "three-quarter": ((4.0, 5.0, 2.2), (0, 0, 1.3))}
ANIM_CAMERA = ((3.3, 3.3, 2.0), (0, 0.1, 1.2), 40.0)
ROM = {"rig-rom-reach": {"upperarm.R": (150, 0, 0), "forearm.R": (30, 0, 0), "upperarm.L": (0, 40, 0), "forearm.L": (60, 0, 0),
                         "head": (0, 0, 30), "chest": (0, 0, 15), "spin": {"orbit": 90, "ring.outer": 22, "ring.inner": -30}, "ik": PLANT},
       "rig-rom-crouch": {"pelvis_loc": (0, 0, -0.25), "spine": (-12, 0, 0), "skirt.FR": (25, 0, 0), "skirt.FL": (25, 0, 0),
                          "upperarm.R": (30, 0, 0), "upperarm.L": (30, 0, 0), "forearm.R": (40, 0, 0), "forearm.L": (40, 0, 0),
                          "eclipse": ECLIPSE, "fold": 0.5, "ik": PLANT}}
FRAMES = {"anim-idle": ("idle", 3.0), "anim-attack-wind": ("attack", 0.45), "anim-attack-thrust": ("attack", 0.8),
          "anim-hit": ("hit", 0.12), "anim-frozen": ("frozen", 0.0), "anim-death-kneel": ("death", 0.95), "anim-death-end": ("death", 2.6)}
# Concept-angle comparison: orthographic, framed like the concept panels (camera side, offset).
COMPARE = {"front": (0, 1, 0), "side": (-1, 0, 0), "back": (0, -1, 0)}  # camera direction from the figure (side: its left, as drawn)
COMPARE_Z = 1.317  # crop centre height (figure feet to ring top span 2.62 m over the crop)
COMPARE_SCALE = 2.70  # metres covered by the crop height


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
    setup_render(cs, 370, 507)
    world = bpy.data.worlds.new(f"{PIECE}-compare-world")
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (0.046, 0.039, 0.036, 1.0)
    cs.world = world
    cam = bpy.data.objects.new("compare-cam", bpy.data.cameras.new("compare-cam"))
    cs.collection.objects.link(cam)
    cs.camera = cam
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = COMPARE_SCALE
    key = bpy.data.objects.new("compare-key", bpy.data.lights.new("compare-key", "AREA"))
    fill = bpy.data.objects.new("compare-fill", bpy.data.lights.new("compare-fill", "AREA"))
    for o, e in ((key, 520.0), (fill, 160.0)):
        o.data.energy, o.data.size, o.data.color = e, 2.5, (1.0, 0.86, 0.66)
        cs.collection.objects.link(o)
    done = []
    with bpy.context.temp_override(scene=cs, view_layer=cs.view_layers[0]):
        if bpy.context.window is not None:
            bpy.context.window.scene = cs
        for view, d in COMPARE.items():
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
TITLE = f"P5-T4 Orrery Warden ({PIECE}) - owner review sheet"


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
        ("REFERENCE - warden-sheet-1.png (concept; owner approval PENDING; the stray sentry fragment lower left is not part of the design)", [("concept sheet", CONCEPT)]),
        ("FIDELITY - concept view beside the model at the same angle (orthographic, same framing)", pairs),
        ("MODEL - textured Blender renders (shared brass-polished set; gunmetal, glow and jewel are factor-only), approval PENDING", [
            ("low front", r / "model-low-front.png"), ("low side", r / "model-low-side.png"), ("low back", r / "model-low-back.png"),
            ("low 3/4", r / "model-low-three-quarter.png"), ("high source 3/4", r / "model-high-three-quarter.png")]),
        (f"RIG - approval PENDING: {len(BONES)} bones, rigid 1-bone skinning, planar leg solve, ring/orbit/planet bones spin in plane", [
            ("range of motion: reach", r / "rig-rom-reach.png"), ("range of motion: crouch, eclipse, orbit half-folded", r / "rig-rom-crouch.png"),
            ("attack wind-up 0.45 s", r / "anim-attack-wind.png"), ("attack thrust (impact) 0.8 s", r / "anim-attack-thrust.png"),
            ("death kneel, core eclipsed 0.95 s", r / "anim-death-kneel.png")]),
        ("ANIMATION - Blender frames, approval PENDING (idle turns rings and orbit one revolution per 12 s loop)", [
            ("idle 3.0 s", r / "anim-idle.png"), ("attack (impact) 0.8 s", r / "anim-attack-thrust.png"), ("hit 0.12 s", r / "anim-hit.png"),
            ("frozen (held)", r / "anim-frozen.png"), ("death end 2.6 s", r / "anim-death-end.png")]),
        ("IN ENGINE - three.js 0.186.1, headless Chromium on the GPU, seated player 2.6 m away", [
            (name, eng / f"{name}.jpg") for name in ENGINE_SHOTS]),
    ]
    sheet = _grid(sections, 6, TITLE, APPROVAL_NOTE + "\n" + note)
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
