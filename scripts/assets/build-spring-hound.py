"""P5-T3 Spring Hound: a greyhound-built brass automaton (concept assets-source/concepts/
hound-sheet-1.png, notes assets-source/concepts/p5-automatons-design.md, style docs/art-bible.md),
built procedurally as lofted, bevel-capped plates and swept springs, each vertex weighted 1.0 to
one bone of a 33-bone armature, with the five automaton clips of the Cog Sentry contract (P4-T6):
idle (loop), attack (pounce and snap), hit, death (one-shot, ends lying on its side) and frozen
(the held snarl of the time freeze). Exported as an image-free skinned GLB whose brass slots carry
the names of the shared P4-T3 tileable sets (`public/assets/materials/`), so the runtime binds them
by name. UV0 is in tile units (metres / tileMeters). The manifest uses the sentry's schema plus an
optional `cull` sphere measured over every clip frame.

Proportions come from the concept's side view: 1.2 m from the paws to the ear tips over 855 px of
the side figure, so every landmark below is a measured pixel of that view converted to metres
(see `CX`). The body is a deep egg-shaped chest cuirass with a glowing grille, a true coiled-spring
spine (a helix swept around the body profile, deep at the chest, tucked at the loin) between the
cuirass and the haunches, a coiled neck, a long narrow skull with a separate hinged jaw, rose ears
and amber eye slits, shaped thighs, gaskins and hocks, toed paws, and a segmented tail ending in a
winding key.

Blender run (build, pose checks, export, reimport gate, manifest, renders, .blend sources):
    "$BLENDER" -b --factory-startup --python-exit-code 1 -P scripts/assets/build-spring-hound.py -- \
        [--out assets-source/enemies/spring-hound/staging] [--runtime public/assets/enemies/spring-hound] \
        [--blend-dir assets-source/enemies/spring-hound/blend] [--skip-renders] [--compare-only]
Review sheet and fidelity compare (system Python with Pillow, after the Blender run, the engine
shots and the author's staging/fidelity.json):
    python3 -I scripts/assets/build-spring-hound.py --sheet [--out ...]
Author self-score into provenance (after `asset-check.py --assemble-enemy spring-hound`):
    python3 -I scripts/assets/build-spring-hound.py --record-fidelity

Frame: Blender is Z-up; runtime (x, y, z) = Blender (x, z, -y). The hound faces Blender +Y, which
is runtime -Z (encounter.ts sets rotation.y = -heading). The root sits on the floor under the
middle of the body (runtime y = 0). Anatomical right is Blender +X. Root motion is code-owned:
the `root` joint is never animated and every clip plays in place.
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
PIECE = "spring-hound"
BODY = "hound-body"
DEFAULT_OUT = REPO / f"assets-source/enemies/{PIECE}/staging"
DEFAULT_RUNTIME = REPO / f"public/assets/enemies/{PIECE}"
DEFAULT_BLEND = REPO / f"assets-source/enemies/{PIECE}/blend"
MATERIAL_DIR = REPO / "public/assets/materials"
CONCEPT = REPO / "assets-source/concepts/hound-sheet-1.png"
FPS = 30
HEIGHT_RANGE = (1.1, 1.3)  # metres, rest pose (design notes: about 1.2 m to the head)
DEATH_MAX_Z = 0.6  # lying on its side

LIMITS = {"tris": 25_000, "materials": 4, "bones": 40, "influences": 4}
GLOW = "hound-glow"
MATS = ["brass-polished", "brass-aged", "gunmetal", GLOW]
BP, BA, GM, GL = range(4)
RB = 20  # pseudo slot: build_body maps it to GM and writes the ruby into COLOR_0
RUBY_SRGB = (0xA0, 0x00, 0x48)  # deep crimson: the warm key lights shift it orange, and 0xB8005C read pink (engine S 0.63)
GM_SRGB = (0x2E, 0x2A, 0x2A)  # gunmetal, carried by COLOR_0 on the white gunmetal slot
SETS = {"brass-polished": 0.18, "brass-aged": 0.18}  # shared set -> normal scale on this model (0.35 read as crumpled foil)
TINTS = {"brass-polished": [1.0, 0.86, 0.90], "brass-aged": [1.0, 0.86, 0.90]}  # runtime set tint toward the concept's hue
TILE_METERS = 0.5  # both brass sets tile at 0.5 m (public/assets/materials/materials.json)
FACTORS = {  # sRGB base, roughness, metallic: the GLB look, and the fallback when the sets fail
    "brass-polished": ((0xDE, 0xC1, 0x6A), 0.3, 1.0),
    "brass-aged": ((0xA8, 0x86, 0x48), 0.45, 1.0),
    # hue from COLOR_0 (gunmetal and ruby). Engine ruby saturation rises with metallic (0.6: S 0.61, 0.8: S 0.70
    # to 0.76) and roughness 0.42 spread a white sheen; at 0.85 the ruby read near black.
    "gunmetal": ((0xFF, 0xFF, 0xFF), 0.25, 0.8),
    GLOW: ((0x6A, 0x34, 0x0C), 0.4, 0.0),
}
GLOW_SRGB = (0xF0, 0x8C, 0x2C)
GLOW_STRENGTH = 0.7

# Concept side view (hound-sheet-1.png crop at (80, 30)): paws at y = 900 px, ear tips at 45 px.
CX_PX = 1.2 / 855.0  # metres per concept pixel


def CX(x: float, y: float) -> tuple[float, float]:
    """Concept side-view pixel (crop coordinates) -> Blender (y, z) in metres."""
    return ((x - 600.0) * CX_PX, (900.0 - y) * CX_PX)


# Armature: name, parent, head, tail (Blender metres), fitted to the concept side view. The body
# runs along Y, nose at +Y.
BONES: list[tuple[str, str | None, tuple, tuple]] = [
    ("root", None, (0, 0, 0), (0, 0, 0.2)),
    ("pelvis", "root", (0, -0.36, 0.80), (0, -0.20, 0.815)),
    ("spine.1", "pelvis", (0, -0.20, 0.815), (0, -0.06, 0.81)),
    ("spine.2", "spine.1", (0, -0.06, 0.81), (0, 0.07, 0.80)),
    ("spine.3", "spine.2", (0, 0.07, 0.80), (0, 0.20, 0.79)),
    ("chest", "spine.3", (0, 0.20, 0.79), (0, 0.42, 0.85)),
    ("neck.1", "chest", (0, 0.41, 0.84), (0, 0.48, 0.955)),
    ("neck.2", "neck.1", (0, 0.48, 0.955), (0, 0.55, 1.07)),
    ("head", "neck.2", (0, 0.55, 1.07), (0, 0.89, 1.05)),
    ("jaw", "head", (0, 0.62, 1.035), (0, 0.84, 0.98)),
    ("ear.R", "head", (0.045, 0.565, 1.16), (0.12, 0.518, 1.19)),
    ("ear.L", "head", (-0.045, 0.565, 1.16), (-0.12, 0.518, 1.19)),
    ("tail.1", "pelvis", (0, -0.468, 0.815), (0, -0.48, 0.69)),
    ("tail.2", "tail.1", (0, -0.48, 0.69), (0, -0.50, 0.57)),
    ("tail.3", "tail.2", (0, -0.50, 0.57), (0, -0.54, 0.49)),
    ("tail.4", "tail.3", (0, -0.54, 0.49), (0, -0.60, 0.455)),
    ("key", "tail.4", (0, -0.60, 0.455), (0, -0.70, 0.45)),
]
FORE_X, HIND_X = 0.125, 0.105
for _s, _n in ((1, "R"), (-1, "L")):
    fx, hx = _s * FORE_X, _s * HIND_X
    BONES += [
        (f"upperarm.{_n}", "chest", (_s * 0.13, 0.32, 0.70), (fx, 0.27, 0.49)),
        (f"forearm.{_n}", f"upperarm.{_n}", (fx, 0.27, 0.49), (fx, 0.275, 0.14)),
        (f"wrist.{_n}", f"forearm.{_n}", (fx, 0.275, 0.14), (fx, 0.30, 0.05)),
        (f"forepaw.{_n}", f"wrist.{_n}", (fx, 0.30, 0.05), (fx, 0.45, 0.02)),
        (f"thigh.{_n}", "pelvis", (hx, -0.34, 0.77), (hx, -0.36, 0.49)),
        (f"shin.{_n}", f"thigh.{_n}", (hx, -0.36, 0.49), (hx, -0.547, 0.264)),
        (f"hock.{_n}", f"shin.{_n}", (hx, -0.547, 0.264), (hx, -0.53, 0.06)),
        (f"hindpaw.{_n}", f"hock.{_n}", (hx, -0.53, 0.06), (hx, -0.43, 0.02)),
    ]
BONE_NAMES = [b[0] for b in BONES]
PARENT = {b[0]: b[1] for b in BONES}
HEAD = {b[0]: b[2] for b in BONES}
TAIL = {b[0]: b[3] for b in BONES}
LOC_BONE = "pelvis"  # the only bone with animated location (in place: code owns root motion)
# Planar leg solve: chain (upper, lower, distal) and knee side (+1 forward, -1 back).
LEGS = {f"{k}.{n}": (*bones, side) for n in ("R", "L") for k, bones, side in (
    ("fore", (f"upperarm.{n}", f"forearm.{n}", f"wrist.{n}"), -1),
    ("hind", (f"thigh.{n}", f"shin.{n}", f"hock.{n}"), 1))}

CLIPS = {
    "idle": {"duration": 2.0, "loop": "repeat", "events": {}},
    "attack": {"duration": 1.1, "loop": "once", "events": {"impact": 0.5}},
    "hit": {"duration": 0.6, "loop": "once", "events": {}},
    "death": {"duration": 2.0, "loop": "once", "events": {"down": 1.4}},
    "frozen": {"duration": 1.0, "loop": "repeat", "events": {}},
}

# Loft profile points, station subdivision, small-part profile points, helix segments per turn and
# spring wire sides.
DETAIL = {"low": {"n": 14, "sub": 2, "small": 8, "turn": 16, "wire": 6},
          "high": {"n": 36, "sub": 5, "small": 16, "turn": 44, "wire": 12}}


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
    p.add_argument("--sheet", action="store_true", help="compose the review sheet and fidelity compare (system Python)")
    p.add_argument("--record-fidelity", action="store_true", help="copy staging/fidelity.json into provenance.json (system Python)")
    return p.parse_args(argv)


def lin(c: int) -> float:
    v = c / 255.0
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


# --------------------------------------------------------------------------------------------------
# Geometry: closed lofted plates and swept springs, each vertex weighted to one bone


def frame_axes(d):
    """Local X and Y for a unit local Z `d`: X stays as close to world X as possible."""
    from mathutils import Vector

    x = Vector((1, 0, 0)) if abs(d.x) < 0.9 else Vector((0, 1, 0))
    x = (x - d * x.dot(d)).normalized()
    return x, d.cross(x)


def axis_frame(a, b):
    """4x4 with origin a and local Z along a->b; local X stays as close to world X as possible."""
    from mathutils import Matrix, Vector

    a, b = Vector(a), Vector(b)
    d = (b - a).normalized()
    x, y = frame_axes(d)
    m = Matrix((x, y, d)).transposed().to_4x4()
    m.translation = a
    return m, (b - a).length


def _cr(p0: float, p1: float, p2: float, p3: float, u: float) -> float:
    """Catmull-Rom between p1 and p2."""
    return 0.5 * (2 * p1 + (p2 - p0) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (3 * p1 - p0 - 3 * p2 + p3) * u ** 3)


def refine(stations: list[tuple], sub: int) -> list[tuple]:
    """Catmull-Rom resampling of loft stations (every field interpolated), `sub` per span."""
    if sub <= 1 or len(stations) < 3:
        return [tuple(s) for s in stations]
    flat = [[*s[0], *s[1:]] for s in stations]
    out = []
    n = len(flat)
    for i in range(n - 1):
        p0, p1, p2, p3 = flat[max(i - 1, 0)], flat[i], flat[i + 1], flat[min(i + 2, n - 1)]
        for k in range(sub):
            u = k / sub
            v = [_cr(a, b, c, d, u) for a, b, c, d in zip(p0, p1, p2, p3)]
            out.append(((v[0], v[1], v[2]), *[max(x, 1e-4) for x in v[3:-1]], v[-1]))
    last = flat[-1]
    out.append(((last[0], last[1], last[2]), *last[3:]))
    return out


def superellipse(n: int, a: float, bt: float, bb: float, e: float) -> list[tuple[float, float]]:
    """Closed profile: half-width a along the frame's u, bt toward +v and bb toward -v; e = 2 is an
    ellipse, larger e squares it off into a rounded plate."""
    out = []
    for i in range(n):
        th = 2 * math.pi * i / n
        c, s = math.cos(th), math.sin(th)
        x = a * math.copysign(abs(c) ** (2 / e), c)
        y = (bt if s >= 0 else bb) * math.copysign(abs(s) ** (2 / e), s)
        out.append((x, y))
    return out


def frame_uv(t, ref):
    """Profile axes for tangent t: u is `ref` made perpendicular to t, v = u x t (up for a forward
    tangent with ref +X)."""
    from mathutils import Vector

    t = Vector(t).normalized()
    for r in (Vector(ref), Vector((0, 1, 0)), Vector((0, 0, 1))):
        u = r - t * r.dot(t)
        if u.length > 1e-4:
            u.normalize()
            return u, u.cross(t)
    raise ValueError("degenerate loft frame")


class Parts:
    def __init__(self, bmesh, detail: str):
        self.bmesh = bmesh
        self.bm = bmesh.new()
        self.deform = self.bm.verts.layers.deform.verify()
        self.d = DETAIL[detail]

    def _n(self, n) -> int:
        return self.d[n] if isinstance(n, str) else (n or self.d["n"])

    def _tag(self, verts, bone: str) -> None:
        gi = BONE_NAMES.index(bone)
        for v in verts:
            v[self.deform][gi] = 1.0

    def surface(self, rings: list[list], bones: list[str], mat: int, smooth: bool = True, caps=(True, True), cap_depth=(0.0, 0.0)) -> None:
        """Bridges point rings (all the same length) into a closed surface: quads between rings and
        a bevelled cap at each end (an inset ring, then a fan), every ring's vertices on its bone."""
        from mathutils import Vector

        bm = self.bm
        vr = [[bm.verts.new(p) for p in ring] for ring in rings]
        for ring, bone in zip(vr, bones):
            self._tag(ring, bone)
        n = len(rings[0])
        faces = [bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i])) for a, b in zip(vr, vr[1:]) for i in range(n)]
        for end, (ring, pts, bone) in enumerate(((vr[0], rings[0], bones[0]), (vr[-1], rings[-1], bones[-1]))):
            if not caps[end]:
                continue
            c = sum((Vector(p) for p in pts), Vector()) / n
            nxt = rings[1] if end == 0 else rings[-2]
            cn = sum((Vector(p) for p in nxt), Vector()) / n
            out = c - cn
            out = out.normalized() if out.length > 1e-9 else Vector((0, 0, 0))
            depth = cap_depth[end]
            inner = [bm.verts.new(c + (Vector(p) - c) * 0.62 + out * depth * 0.7) for p in pts]
            tip = bm.verts.new(c + out * depth)
            self._tag([*inner, tip], bone)
            for i in range(n):
                j = (i + 1) % n
                faces.append(bm.faces.new((ring[i], ring[j], inner[j], inner[i])))
                faces.append(bm.faces.new((inner[i], inner[j], tip)))
        for f in faces:
            f.material_index = mat
            f.smooth = smooth

    def loft(self, stations: list[tuple], mat: int, bone, ref=(1, 0, 0), n=None, sub=None, smooth=True, caps=(True, True), bevel=0.35) -> None:
        """Lofted plate through stations (centre, a, bt, bb, e): superellipse sections across the
        path, Catmull-Rom smoothed. `bone` is one name or a function of the station centre."""
        from mathutils import Vector

        st = refine(stations, self.d["sub"] if sub is None else sub)
        n = self._n(n)
        rings, bones = [], []
        for i, (c, a, bt, bb, e) in enumerate(st):
            c = Vector(c)
            t = Vector(st[min(i + 1, len(st) - 1)][0]) - Vector(st[max(i - 1, 0)][0])
            u, v = frame_uv(t, ref)
            rings.append([c + u * x + v * y for x, y in superellipse(n, a, bt, bb, e)])
            bones.append(bone(c) if callable(bone) else bone)
        d0 = bevel * min(st[0][1], (st[0][2] + st[0][3]) / 2)
        d1 = bevel * min(st[-1][1], (st[-1][2] + st[-1][3]) / 2)
        self.surface(rings, bones, mat, smooth, caps, (d0, d1))

    def disc(self, c, axis, r: float, w: float, mat: int, bone: str, n=None, bev: float = 0.25) -> None:
        """Bevelled hub or axle: a short lofted cylinder along `axis`."""
        from mathutils import Vector

        n = n or 12
        c, d = Vector(c), Vector(axis).normalized()
        h, b = w / 2, min(w / 2, r) * bev
        st = [(c - d * h, r * (1 - bev * 0.6), r * (1 - bev * 0.6), r * (1 - bev * 0.6), 2.0),
              (c - d * (h - b), r, r, r, 2.0), (c + d * (h - b), r, r, r, 2.0),
              (c + d * h, r * (1 - bev * 0.6), r * (1 - bev * 0.6), r * (1 - bev * 0.6), 2.0)]
        self.loft([(tuple(p), a, bt, bb, e) for p, a, bt, bb, e in st], mat, bone, ref=(0, 0, 1) if abs(d.z) < 0.9 else (0, 1, 0),
                  n=n, sub=1, bevel=0.15)

    def ring(self, c, normal, a: float, b: float, tr: float, ta: float, mat: int, bone: str, n=None, k: int = 6, e: float = 3.0) -> None:
        """Closed band: an ellipse (semi-axes a across world X, b across the other axis) swept by a
        rounded-rectangle section (tr radial, ta along the normal)."""
        from mathutils import Vector

        n = self._n(n)
        m, _ = axis_frame(c, Vector(c) + Vector(normal))
        bm = self.bm
        sec = superellipse(k, tr, ta, ta, e)
        grid = []
        for i in range(n):
            u = 2 * math.pi * i / n
            cu, su = math.cos(u), math.sin(u)
            rad = Vector((b * cu, a * su, 0)).normalized()  # outward normal of the ellipse
            base = Vector((a * cu, b * su, 0))
            grid.append([bm.verts.new(m @ (base + rad * x + Vector((0, 0, y)))) for x, y in sec])
        faces = [bm.faces.new((grid[i][j], grid[(i + 1) % n][j], grid[(i + 1) % n][(j + 1) % k], grid[i][(j + 1) % k]))
                 for i in range(n) for j in range(k)]
        self._tag([v for row in grid for v in row], bone)
        for f in faces:
            f.material_index = mat
            f.smooth = True

    def helix(self, axis: list[tuple], turns: float, wire: float, mat: int, bone, tilt: float = 0.0, phase: float = 0.0) -> None:
        """Coil spring: a wire of radius `wire` swept along a helix wound `turns` times around an
        axis given as stations (centre, a lateral, b vertical semi-axes); `tilt` leans each coil
        (its top toward -tangent). `bone` maps the axis point of each wire ring to a bone."""
        from mathutils import Vector

        seg = max(8, round(turns * self.d["turn"]))
        sides = self.d["wire"]
        flat = [[*s[0], s[1], s[2]] for s in axis]
        na = len(flat)

        def at(s: float):
            x = s * (na - 1)
            i = min(int(x), na - 2)
            u = x - i
            p0, p1, p2, p3 = flat[max(i - 1, 0)], flat[i], flat[i + 1], flat[min(i + 2, na - 1)]
            return [_cr(a, b, c, d, u) for a, b, c, d in zip(p0, p1, p2, p3)]

        cs, ps = [], []
        for j in range(seg + 1):
            s = j / seg
            v = at(s)
            c = Vector(v[:3])
            t = Vector(at(min(s + 1e-3, 1.0))[:3]) - Vector(at(max(s - 1e-3, 0.0))[:3])
            u, w = frame_uv(t, (1, 0, 0))
            phi = 2 * math.pi * turns * s + phase
            p = c + u * v[3] * math.cos(phi) + w * v[4] * math.sin(phi) - t.normalized() * tilt * v[4] * math.sin(phi)
            cs.append(c)
            ps.append(p)
        rings, bones = [], []
        for j, (c, p) in enumerate(zip(cs, ps)):
            t = ps[min(j + 1, seg)] - ps[max(j - 1, 0)]
            t.normalize()
            nrm = p - c
            nrm = (nrm - t * nrm.dot(t)).normalized()
            bnm = t.cross(nrm)
            rings.append([p + (nrm * math.cos(2 * math.pi * q / sides) + bnm * math.sin(2 * math.pi * q / sides)) * wire for q in range(sides)])
            bones.append(bone(c) if callable(bone) else bone)
        self.surface(rings, bones, mat, True, (True, True), (wire * 0.6, wire * 0.6))


def _at(stations: list[tuple], y: float) -> tuple[float, float, float, float]:
    """(centre z, a, bt, bb) of a +Y-running loft at y, linear between stations."""
    for (c0, *r0), (c1, *r1) in zip(stations, stations[1:]):
        if c0[1] <= y <= c1[1]:
            f = (y - c0[1]) / (c1[1] - c0[1])
            return (c0[2] + (c1[2] - c0[2]) * f, *(p + (q - p) * f for p, q in zip(r0[:3], r1[:3])))
    raise ValueError(y)


def _bvh(faces: list):
    """BVH over a set of bmesh faces (their current vertex positions)."""
    from mathutils.bvhtree import BVHTree

    idx: dict = {}
    pts, polys = [], []
    for f in faces:
        poly = []
        for v in f.verts:
            if v not in idx:
                idx[v] = len(pts)
                pts.append(v.co.copy())
            poly.append(idx[v])
        polys.append(poly)
    return BVHTree.FromPolygons(pts, polys)


def skull_x(st: list[tuple], y: float, z: float, e: float = 2.4) -> float:
    """Half-width of a +Y-running loft (linear between stations) at height z of the section at y."""
    cz, a, bt, bb = _at(st, y)
    f = min(abs(z - cz) / (bt if z >= cz else bb), 0.999)
    return a * (1 - f ** e) ** (1 / e)


def build_parts(P: Parts) -> None:
    from mathutils import Vector

    L, D = P.loft, P.disc

    def line(pts: list, bone: str, ref=(1, 0, 0)) -> None:
        """Engraved panel line: a thin gunmetal strip through `pts`, 7 mm along `ref` and 5 mm across."""
        L([(tuple(p), 0.0035, 0.0025, 0.0025, 2.0) for p in pts], GM, bone, n=4, sub=1, caps=(False, False), ref=ref)

    def rivets(c, normal, a: float, b: float, off: float, count: int, bone: str) -> None:
        """Domed rivets round the front face (`off` along the normal) of a `P.ring` band."""
        d = Vector(normal).normalized()
        x, y = frame_axes(d)
        for i in range(count):
            u = 2 * math.pi * (i + 0.5) / count
            p = Vector(c) + x * (a * math.cos(u)) + y * (b * math.sin(u)) + d * off
            L([(tuple(p), 0.005, 0.005, 0.005, 2.0), (tuple(p + d * 0.003), 0.003, 0.003, 0.003, 2.0)], BA, bone, n=6, sub=1,
              caps=(False, True))

    # ---- Head: greyhound skull with a stop and a separate hinged jaw, on the body's polished brass, rose ears,
    # amber eye slits under a brow ledge, gunmetal nose, cheek guards and hinge bolts.
    skull = [((0, 0.495, 1.090), 0.040, 0.050, 0.050, 2.2), ((0, 0.525, 1.092), 0.060, 0.092, 0.085, 2.4),
             ((0, 0.570, 1.090), 0.076, 0.110, 0.090, 2.5), ((0, 0.625, 1.096), 0.078, 0.112, 0.080, 2.5),
             ((0, 0.680, 1.100), 0.070, 0.095, 0.068, 2.4), ((0, 0.735, 1.093), 0.052, 0.073, 0.058, 2.3),
             # Stop: the brow drops 34 mm between y 0.752 and 0.772 (concept 1.156 -> 1.119), then a deep
             # muzzle whose underside closes onto the jaw (concept mouth line 1.016 at y 0.79, 1.006 at 0.84).
             ((0, 0.752, 1.090), 0.048, 0.062, 0.059, 2.3), ((0, 0.772, 1.072), 0.043, 0.046, 0.050, 2.3),
             ((0, 0.800, 1.058), 0.038, 0.042, 0.044, 2.2), ((0, 0.845, 1.042), 0.029, 0.033, 0.036, 2.1),
             ((0, 0.875, 1.038), 0.021, 0.020, 0.022, 2.0)]
    L(skull, BP, "head")
    L([((0, 0.866, 1.040), 0.020, 0.018, 0.020, 2.0), ((0, 0.887, 1.037), 0.016, 0.014, 0.016, 2.0),
       ((0, 0.897, 1.034), 0.008, 0.007, 0.008, 2.0)], GM, "head", n="small", sub=1)  # nose
    jaw = [((0, 0.600, 1.018), 0.044, 0.022, 0.034, 2.4), ((0, 0.660, 1.008), 0.040, 0.021, 0.032, 2.4),
           ((0, 0.720, 0.998), 0.033, 0.018, 0.027, 2.3), ((0, 0.780, 0.989), 0.026, 0.015, 0.021, 2.2),
           ((0, 0.830, 0.982), 0.019, 0.011, 0.015, 2.1), ((0, 0.852, 0.979), 0.010, 0.007, 0.008, 2.0)]
    L(jaw, BP, "jaw")
    for s in (1, -1):
        # Teeth: a few large ones at the front only (concept), three upper and two lower, and a fang.
        for y in (0.790, 0.810, 0.830):
            cz, a, _bt, bb = _at(skull, y)
            L([((s * 0.55 * a, y, cz - bb + 0.006), 0.0065, 0.005, 0.005, 2.0),
               ((s * 0.55 * a, y, cz - bb - 0.013), 0.0012, 0.0012, 0.0012, 2.0)], BP, "head", n=4, sub=1, ref=(0, 1, 0),
              caps=(False, False))
        for y in (0.800, 0.820):
            cz, a, bt, _bb = _at(jaw, y)
            L([((s * 0.55 * a, y, cz + bt - 0.004), 0.006, 0.0045, 0.0045, 2.0),
               ((s * 0.55 * a, y, cz + bt + 0.012), 0.0012, 0.0012, 0.0012, 2.0)], BP, "jaw", n=4, sub=1, ref=(0, 1, 0),
              caps=(False, False))
        cz, a, _bt, bb = _at(skull, 0.848)
        L([((s * 0.5 * a, 0.848, cz - bb + 0.006), 0.007, 0.007, 0.007, 2.0), ((s * 0.5 * a, 0.850, cz - bb - 0.020), 0.0014, 0.0014, 0.0014, 2.0)],
          BP, "head", n=5, sub=1, ref=(0, 1, 0), caps=(False, False))  # upper fang
        # Amber eye at the stop: a long almond (54 mm by 32 mm) standing 17 mm proud of the skull,
        # so head-on it shows past the muzzle. The dark socket sits lower than the glow (4 mm proud)
        # and only frames it from the side; the brow ledge covers the back two thirds only.
        eye = [(0.696, 1.134, 0.010, 0.008), (0.714, 1.127, 0.019, 0.016), (0.734, 1.118, 0.019, 0.014),
               (0.750, 1.108, 0.010, 0.006)]  # y, z, a (proud), half-height
        L([((s * (skull_x(skull, y, z) - 0.002), y, z), a, h, h, 2.4) for y, z, a, h in eye], GL, "head", n="small", sub=1)
        L([((s * (skull_x(skull, y, z) - 0.010), y, z), 0.014, h + 0.006, h + 0.006, 2.6) for y, z, _a, h in eye],
          GM, "head", n="small", sub=1)
        L([((s * (skull_x(skull, y, z + 0.019) + 0.002), y, z + 0.019), a, b, b, 2.2)
           for (y, z, _a, _h), (a, b) in zip(eye[:3], ((0.006, 0.004), (0.009, 0.006), (0.003, 0.003)))], BP, "head", n="small", sub=1)
        # Cheek guard over the jaw hinge, and the hinge bolt.
        L([((s * 0.072, 0.560, 1.050), 0.005, 0.020, 0.020, 3.0), ((s * 0.074, 0.600, 1.046), 0.006, 0.030, 0.030, 3.4),
           ((s * 0.071, 0.650, 1.040), 0.005, 0.022, 0.020, 3.0), ((s * 0.065, 0.680, 1.036), 0.004, 0.010, 0.010, 2.4)],
          BA, "head", n="small", sub=1)
        D((s * 0.078, 0.632, 1.044), (1, 0, 0), 0.014, 0.012, GM, "head", n="small")
        D((s * 0.085, 0.632, 1.044), (1, 0, 0), 0.008, 0.006, BP, "head", n="small")
        # Rose ear: a thin leaf folded back over the occiput like a roof tile, tip drooping.
        ear = f"ear.{'R' if s > 0 else 'L'}"
        L([((s * 0.050, 0.592, 1.152), 0.024, 0.006, 0.006, 2.2), ((s * 0.066, 0.566, 1.182), 0.030, 0.006, 0.006, 2.4),
           ((s * 0.084, 0.538, 1.188), 0.028, 0.005, 0.005, 2.4), ((s * 0.102, 0.512, 1.170), 0.018, 0.004, 0.004, 2.2),
           ((s * 0.110, 0.498, 1.140), 0.007, 0.003, 0.003, 2.0)], BP, ear, ref=(s * 0.55, 0.0, 0.83), n="small")

    # ---- Neck: gunmetal column wound with a six-turn coil spring, collar flange at the chest.
    L([((0, 0.400, 0.825), 0.046, 0.046, 0.046, 2.0), ((0, 0.480, 0.955), 0.042, 0.042, 0.042, 2.0)], GM, "neck.1", n="small", sub=1)
    L([((0, 0.475, 0.947), 0.041, 0.041, 0.041, 2.0), ((0, 0.560, 1.085), 0.036, 0.036, 0.036, 2.0)], GM, "neck.2", n="small", sub=1)
    P.helix([((0, 0.405, 0.830), 0.090, 0.092), ((0, 0.455, 0.912), 0.082, 0.084), ((0, 0.505, 0.995), 0.073, 0.075),
             ((0, 0.548, 1.068), 0.064, 0.066)], 6.0, 0.0155, BA, lambda c: "neck.1" if c.y < 0.48 else "neck.2")
    P.ring((0, 0.418, 0.852), (0, 0.45, 0.89), 0.098, 0.100, 0.014, 0.012, BA, "chest")
    rivets((0, 0.418, 0.852), (0, 0.45, 0.89), 0.112, 0.114, 0.004, 8, "chest")  # outer edge, clear of the neck coil

    # ---- Chest: an egg-shaped cuirass (deep keel, the widest part of the body) in three polished
    # plates over a gunmetal core, a grille with an amber core on the prow, and a keel blade.
    chest = [((0, 0.175, 0.800), 0.100, 0.140, 0.120, 2.1), ((0, 0.215, 0.790), 0.128, 0.180, 0.190, 2.1),
             ((0, 0.270, 0.775), 0.126, 0.200, 0.215, 2.1), ((0, 0.340, 0.765), 0.128, 0.205, 0.220, 2.1),
             ((0, 0.410, 0.745), 0.127, 0.170, 0.205, 2.1), ((0, 0.470, 0.720), 0.128, 0.120, 0.170, 2.1),
             ((0, 0.515, 0.700), 0.100, 0.085, 0.120, 2.1), ((0, 0.540, 0.690), 0.070, 0.060, 0.080, 2.1)]
    L([(c, a * 0.97, bt * 0.97, bb * 0.97, e) for c, a, bt, bb, e in chest], GM, "chest")
    L(chest[:3] + [((0, 0.298, 0.770), 0.127, 0.203, 0.218, 2.1)], BP, "chest")
    L([((0, 0.312, 0.768), 0.128, 0.204, 0.219, 2.1), chest[3], ((0, 0.405, 0.747), 0.127, 0.173, 0.206, 2.1)], BP, "chest")
    f0 = len(P.bm.faces)
    L([((0, 0.419, 0.742), 0.126, 0.164, 0.200, 2.1)] + chest[5:], BP, "chest")
    prow_bvh = _bvh(list(P.bm.faces)[f0:])  # the front plate as built (its rings tilt with the path)
    for s in (1, -1):  # side vents: tall slatted ovals facing sideways, so head-on the grille core dominates
        vc, vn = Vector((s * 0.108, 0.484, 0.657)), Vector((s * 0.88, 0.45, -0.10)).normalized()
        P.ring(tuple(vc), tuple(vn), 0.032, 0.062, 0.007, 0.009, BA, "chest", k=4)
        # Glow inside the ring's opening (25 mm by 55 mm half-sizes) and behind the louvre tops; bevel
        # 0.2 keeps the cap's tip behind them.
        L([(tuple(vc - vn * 0.018), 0.052, 0.022, 0.022, 2.0), (tuple(vc + vn * 0.000), 0.051, 0.021, 0.021, 2.0),
           (tuple(vc + vn * 0.004), 0.038, 0.015, 0.015, 2.0)], GL, "chest", sub=1, ref=(0, 0, 1), bevel=0.2)
        hv = Vector((0, 0, 1)).cross(vn).normalized()  # the lens's in-plane horizontal axis
        # Louvre blades 18 mm deep along the lens normal: head-on they overlap and hide the glow, from
        # the side the glow shows between them.
        for off in (-0.0165, -0.0055, 0.0055, 0.0165):
            p = vc + vn * 0.004 + hv * off
            L([(tuple(p + Vector((0, 0, 0.052))), 0.009, 0.0025, 0.0025, 2.4), (tuple(p - Vector((0, 0, 0.052))), 0.009, 0.0025, 0.0025, 2.4)],
              BA, "chest", n=4, sub=1, caps=(False, False), ref=tuple(vn))
    gc, gn = (0, 0.536, 0.664), (0, 1.0, -0.18)
    P.ring(gc, gn, 0.064, 0.056, 0.011, 0.016, BA, "chest", k=8)
    rivets(gc, gn, 0.064, 0.056, 0.014, 8, "chest")
    gv = Vector(gn).normalized()
    g0 = Vector(gc)
    # Flat glow face just behind the bars (bevel 0.2 keeps the cap's tip behind the bars' front).
    L([(tuple(g0 - gv * 0.030), 0.058, 0.058, 0.058, 2.0), (tuple(g0 + gv * 0.004), 0.058, 0.058, 0.058, 2.0),
       (tuple(g0 + gv * 0.012), 0.054, 0.054, 0.054, 2.0), (tuple(g0 + gv * 0.016), 0.046, 0.046, 0.046, 2.0)], GL, "chest", sub=1,
      bevel=0.2)
    for x in (-0.050, -0.025, 0.0, 0.025, 0.050):
        h = math.sqrt(0.056 ** 2 - x * x)
        base = g0 + gv * 0.021 + Vector((x, 0, 0))
        L([(tuple(base - Vector((0, h * 0.18, h))), 0.003, 0.005, 0.005, 3.0),
           (tuple(base + Vector((0, h * 0.18, h))), 0.003, 0.005, 0.005, 3.0)], BA, "chest", n=6, sub=1)
    # Engraved front seams (concept front view, model x and z): thin gunmetal strips 1.5 mm proud of
    # the prow, which also break up its single convex highlight. Each point is the front plate's
    # surface seen head-on (a ray along -Y), lifted along the surface normal.

    def prow(x: float, z: float, lift: float = 0.0015) -> tuple[float, float, float]:
        loc, nrm, _i, _d = prow_bvh.ray_cast(Vector((x, 2.0, z)), Vector((0, -1, 0)))
        if loc is None:
            raise ValueError((x, z))
        nrm = nrm.normalized() * (1 if nrm.y >= 0 else -1)
        return tuple(loc + nrm * lift)

    def seam(p0: tuple[float, float], p1: tuple[float, float], k: int) -> None:
        line([prow(p0[0] + (p1[0] - p0[0]) * i / (k - 1), p0[1] + (p1[1] - p0[1]) * i / (k - 1)) for i in range(k)], "chest")

    seam((0.0, 0.802), (0.0, 0.722), 5)  # collar to grille top
    for s in (1, -1):
        seam((s * 0.073, 0.702), (s * 0.112, 0.771), 5)  # grille ring up-outward to the shoulder (chest now 0.128 wide)
        # Grille ring down-outward. The concept runs on to (0.111, 0.553), but this cuirass turns under
        # below z 0.61, so the seam starts higher and stops where the plate turns under.
        seam((s * 0.062, 0.632), (s * 0.084, 0.612), 5)
    L([((0, 0.320, 0.585), 0.014, 0.034, 0.030, 2.4), ((0, 0.230, 0.575), 0.012, 0.030, 0.030, 2.4),
       ((0, 0.130, 0.590), 0.010, 0.024, 0.030, 2.2), ((0, 0.010, 0.632), 0.002, 0.004, 0.003, 2.0)], BA, "chest", n="small")

    # ---- Spring spine: one helix swept around the body profile (deep at the chest, tucked at the
    # loin), ten turns, each coil leaning forward; a gunmetal rod through it.
    spine_bone = lambda c: ("pelvis" if c.y < -0.19 else "spine.1" if c.y < -0.06 else "spine.2" if c.y < 0.07  # noqa: E731
                            else "spine.3" if c.y < 0.185 else "chest")
    P.helix([((0, -0.215, 0.862), 0.082, 0.082), ((0, -0.100, 0.874), 0.094, 0.074), ((0, 0.000, 0.861), 0.104, 0.092),
             ((0, 0.100, 0.810), 0.112, 0.139), ((0, 0.210, 0.782), 0.118, 0.150)], 10.0, 0.019, BA, spine_bone, tilt=-0.34)
    rod = [(-0.24, 0.862), (-0.06, 0.870), (0.07, 0.850), (0.20, 0.787)]  # (y, z): stays inside the tucked coil
    for (y0, z0), (y1, z1), bone in zip(rod, rod[1:], ("spine.1", "spine.2", "spine.3")):
        L([((0, y0, z0), 0.028, 0.028, 0.028, 2.0), ((0, y1, z1), 0.028, 0.028, 0.028, 2.0)], GM, bone, n="small", sub=1)

    # ---- Pelvis: a swept rump cowl arcing from the coil top down over the haunch to the tail
    # root (lofted along that arc, so its outer skin is the silhouette), spike guards, tail hub.
    L([((0, -0.440, 0.660), 0.070, 0.012, 0.030, 2.2), ((0, -0.435, 0.726), 0.100, 0.020, 0.090, 2.2),
       ((0, -0.400, 0.812), 0.118, 0.025, 0.125, 2.2), ((0, -0.340, 0.888), 0.120, 0.025, 0.125, 2.2),
       ((0, -0.275, 0.926), 0.112, 0.025, 0.100, 2.2), ((0, -0.215, 0.938), 0.100, 0.022, 0.065, 2.2),
       ((0, -0.188, 0.935), 0.080, 0.015, 0.045, 2.2)], BP, "pelvis")
    D((0, -0.478, 0.812), (0, -1, 0.2), 0.030, 0.030, GM, "pelvis", n="small")
    for s in (1, -1):
        L([((s * 0.112, -0.250, 0.770), 0.012, 0.022, 0.022, 2.2), ((s * 0.112, -0.205, 0.750), 0.008, 0.012, 0.012, 2.2),
           ((s * 0.110, -0.165, 0.728), 0.001, 0.001, 0.001, 2.0)], GM, "pelvis", n="small", sub=1)

    # ---- Tail: twelve aged-brass segments on a gunmetal core, ending in the winding key.
    tail_pts = [(-0.468, 0.815), (-0.475, 0.750), (-0.480, 0.690), (-0.488, 0.625), (-0.500, 0.570),
                (-0.515, 0.525), (-0.540, 0.490), (-0.570, 0.468), (-0.600, 0.455)]

    def tail_bone(c) -> str:
        z = c.z
        return "tail.1" if z > 0.69 else "tail.2" if z > 0.57 else "tail.3" if z > 0.49 else "tail.4"

    cum = [0.0]
    for p, q in zip(tail_pts, tail_pts[1:]):
        cum.append(cum[-1] + math.dist(p, q))

    def tail_at(d: float) -> tuple[float, float, float]:
        i = max(k for k in range(len(cum) - 1) if cum[k] <= d + 1e-12) if d < cum[-1] else len(cum) - 2
        f = (d - cum[i]) / (cum[i + 1] - cum[i])
        (y0, z0), (y1, z1) = tail_pts[i], tail_pts[i + 1]
        return (0.0, y0 + (y1 - y0) * f, z0 + (z1 - z0) * f)

    L([((0, y, z), 0.009, 0.009, 0.009, 2.0) for y, z in tail_pts], GM, tail_bone, n="small", sub=1)
    nseg, total = 10, cum[-1]  # concept: chunky cylinders about 31 mm across, longer than wide
    pitch = total / nseg
    for k in range(nseg):
        d0, d1 = k * pitch + 0.002, (k + 1) * pitch - 0.003
        r = 0.019 - 0.003 * k / (nseg - 1)
        L([(tail_at(d0), r * 0.9, r * 0.9, r * 0.9, 2.0), (tail_at(d0 + 0.003), r, r, r, 2.0),
           (tail_at(d1 - 0.003), r, r, r, 2.0), (tail_at(d1), r * 0.9, r * 0.9, r * 0.9, 2.0)],
          BA, tail_bone(Vector(tail_at((d0 + d1) / 2))), n="small", sub=1)
    # Winding key: collar, a thick shaft, hub and one flat butterfly bow in the sagittal plane, centred
    # on the key bone's axis (z 0.449 at y -0.716) so the wind-up spin does not wobble: two round
    # lobes (56 mm across, 24 mm holes, 105 mm apart as in the concept) joined by a flat waist.
    D((0, -0.606, 0.455), (0, -1, 0.04), 0.016, 0.014, BP, "key", n="small")
    L([((0, -0.610, 0.454), 0.010, 0.010, 0.010, 2.0), ((0, -0.704, 0.450), 0.010, 0.010, 0.010, 2.0)], BP, "key", n="small", sub=1)
    D((0, -0.680, 0.451), (0, -1, 0.0), 0.014, 0.018, BP, "key", n="small")
    for dz in (0.0525, -0.0525):
        P.ring((0, -0.716, 0.449 + dz), (1, 0, 0), 0.020, 0.020, 0.0085, 0.006, BP, "key", n=12, k=6)
    L([((0, -0.716, 0.449 - 0.034), 0.021, 0.006, 0.006, 3.0), ((0, -0.716, 0.449), 0.015, 0.006, 0.006, 3.0),
       ((0, -0.716, 0.449 + 0.034), 0.021, 0.006, 0.006, 3.0)], BP, "key", n="small", sub=1, ref=(0, 1, 0))

    # ---- Legs.
    for s, n in ((1, "R"), (-1, "L")):
        fx, hx = s * FORE_X, s * HIND_X
        # Foreleg: big oval shoulder plate with a jewel boss, elbow axle, two-plate forearm over a
        # gunmetal core, pastern joint, pastern and a four-toed paw.
        shoulder = [((s * 0.150, 0.325, 0.815), 0.028, 0.040, 0.040, 2.3), ((s * 0.152, 0.325, 0.790), 0.040, 0.075, 0.070, 2.4),
                    ((s * 0.152, 0.322, 0.720), 0.046, 0.095, 0.085, 2.4), ((s * 0.150, 0.312, 0.640), 0.045, 0.085, 0.075, 2.4),
                    ((s * 0.145, 0.300, 0.570), 0.040, 0.060, 0.055, 2.4), ((s * 0.138, 0.290, 0.515), 0.032, 0.040, 0.038, 2.3)]
        L(shoulder, BP, f"upperarm.{n}")
        # Gunmetal backing plate, a thin lip larger than the shoulder plate: the dark outline around it.
        L([(c, a * 0.5, bt * 1.05, bb * 1.06, e) for c, a, bt, bb, e in shoulder], GM, f"upperarm.{n}")
        D((s * 0.195, 0.320, 0.700), (1, 0, 0), 0.030, 0.012, GM, f"upperarm.{n}")
        ruby(P, s, s * 0.200, 0.320, 0.700, f"upperarm.{n}")
        # Shoulder line from under the ruby down to the elbow, on the plate's outer face.
        line([(s * 0.199, 0.326, 0.668)] + [(c[0] + s * (a * (1 - 0.4 ** e) ** (1 / e) + 0.0015), c[1] + 0.4 * bt, c[2])
                                            for c, a, bt, _bb, e in shoulder[3:6]], f"upperarm.{n}", ref=(0, 1, 0))
        D((fx, 0.270, 0.490), (1, 0, 0), 0.036, 0.085, GM, f"forearm.{n}")
        D((fx + s * 0.044, 0.270, 0.490), (1, 0, 0), 0.020, 0.008, BA, f"forearm.{n}", n="small")
        fore = [((fx, 0.276, 0.475), 0.038, 0.066, 0.054, 3.0), ((fx, 0.280, 0.420), 0.040, 0.066, 0.052, 3.0),
                ((fx, 0.280, 0.330), 0.036, 0.046, 0.042, 2.5), ((fx, 0.278, 0.240), 0.029, 0.030, 0.030, 2.4),
                ((fx, 0.276, 0.172), 0.022, 0.020, 0.021, 2.3)]
        L([(c, a * 0.9, bt * 0.9, bb * 0.9, e) for c, a, bt, bb, e in fore], GM, f"forearm.{n}", ref=(1, 0, 0))
        L(fore[:2] + [((fx, 0.280, 0.352), 0.037, 0.051, 0.044, 2.6)], BP, f"forearm.{n}")
        L([((fx, 0.280, 0.338), 0.036, 0.048, 0.043, 2.5)] + fore[3:], BP, f"forearm.{n}")
        line([(c[0], c[1] + bt + 0.0015, c[2]) for c, _a, bt, _bb, _e in fore], f"forearm.{n}")  # front line
        D((fx, 0.275, 0.142), (1, 0, 0), 0.026, 0.050, GM, f"wrist.{n}", n="small")
        L([((fx, 0.280, 0.124), 0.020, 0.024, 0.020, 2.6), ((fx, 0.292, 0.088), 0.021, 0.024, 0.020, 2.6),
           ((fx, 0.302, 0.056), 0.019, 0.020, 0.017, 2.6)], BA, f"wrist.{n}", n="small", sub=1)
        paw(P, fx, 0.262, 0.425, f"forepaw.{n}")
        # Hind leg: haunch plate in two panels over a gunmetal core with a jewel boss, stifle axle,
        # gaskin plate with a gunmetal tendon, hock joint, metatarsus and a four-toed paw.
        # Haunch rear edge trimmed to the concept (back edge y -0.41 at z 0.70 to 0.74, was -0.45).
        thigh = [((hx - s * 0.015, -0.335, 0.850), 0.040, 0.050, 0.050, 2.1), ((hx - s * 0.015, -0.338, 0.830), 0.052, 0.085, 0.072, 2.1),
                 ((hx - s * 0.015, -0.340, 0.795), 0.058, 0.110, 0.082, 2.1), ((hx - s * 0.015, -0.342, 0.740), 0.056, 0.110, 0.080, 2.1),
                 ((hx - s * 0.012, -0.345, 0.650), 0.051, 0.090, 0.070, 2.1), ((hx - s * 0.008, -0.350, 0.575), 0.044, 0.066, 0.068, 2.1),
                 ((hx, -0.355, 0.530), 0.034, 0.045, 0.045, 2.1)]
        L([(c, a * 0.85, bt * 1.06, bb * 1.06, e) for c, a, bt, bb, e in thigh], GM, f"thigh.{n}")
        L(thigh[:4] + [((hx - s * 0.014, -0.343, 0.705), 0.054, 0.099, 0.076, 2.1)], BP, f"thigh.{n}")
        L([((hx - s * 0.013, -0.344, 0.688), 0.054, 0.096, 0.074, 2.1)] + thigh[4:], BP, f"thigh.{n}")
        # Haunch line from under the ruby down the back of the thigh, on the plate's outer face.
        line([(s * 0.150, -0.340, 0.745)] + [(c[0] + s * (a * (1 - 0.3 ** e) ** (1 / e) + 0.0015), c[1] - 0.3 * bb, c[2])
                                             for c, a, _bt, bb, e in thigh[4:7]], f"thigh.{n}", ref=(0, 1, 0))
        D((s * 0.146, -0.335, 0.775), (1, 0, 0.0), 0.032, 0.012, GM, f"thigh.{n}")
        ruby(P, s, s * 0.151, -0.335, 0.775, f"thigh.{n}")
        D((hx, -0.360, 0.490), (1, 0, 0), 0.046, 0.088, GM, f"shin.{n}")
        D((hx + s * 0.047, -0.360, 0.490), (1, 0, 0), 0.024, 0.008, BA, f"shin.{n}", n="small")
        # Gaskin bulges forward (concept front edge y -0.31 at z 0.42, was about -0.38), so the stifle
        # to hock line reads as a sloped muscle with a clear angle at the hock.
        L([((hx, -0.352, 0.505), 0.042, 0.068, 0.080, 2.4), ((hx, -0.372, 0.455), 0.040, 0.072, 0.066, 2.4),
           ((hx, -0.416, 0.395), 0.036, 0.058, 0.050, 2.4), ((hx, -0.492, 0.335), 0.030, 0.032, 0.035, 2.4),
           ((hx, -0.530, 0.288), 0.026, 0.025, 0.026, 2.2)], BP, f"shin.{n}")
        L([((hx, -0.420, 0.470), 0.011, 0.011, 0.011, 2.0), ((hx, -0.500, 0.380), 0.011, 0.011, 0.011, 2.0),
           ((hx, -0.570, 0.290), 0.010, 0.010, 0.010, 2.0)], GM, f"shin.{n}", n="small", sub=1)
        D((hx, -0.547, 0.264), (1, 0, 0), 0.029, 0.054, GM, f"hock.{n}", n="small")
        L([((hx, -0.546, 0.252), 0.025, 0.026, 0.022, 2.6), ((hx, -0.538, 0.160), 0.024, 0.024, 0.021, 2.6),
           ((hx, -0.532, 0.075), 0.020, 0.018, 0.017, 2.5)], BA, f"hock.{n}", n="small", sub=1)
        L([((hx, -0.560, 0.300), 0.016, 0.016, 0.016, 2.2), ((hx, -0.585, 0.262), 0.012, 0.012, 0.012, 2.2),
           ((hx, -0.592, 0.240), 0.004, 0.004, 0.004, 2.0)], BA, f"hock.{n}", n=6, sub=1)  # point of hock
        L([((hx, -0.565, 0.240), 0.008, 0.008, 0.008, 2.0), ((hx, -0.556, 0.090), 0.008, 0.008, 0.008, 2.0)], GM, f"hock.{n}", n=6, sub=1)
        paw(P, hx, -0.565, -0.470, f"hindpaw.{n}")


def ruby(P: Parts, s: int, x: float, y: float, z: float, bone: str) -> None:
    """Ruby boss on a gunmetal socket disc whose outer face is at x + s * 0.001: a polished bezel and
    a domed ruby (COLOR_0 on the gunmetal slot) stepping out along +-X."""
    P.ring((x + s * 0.004, y, z), (s, 0, 0), 0.027, 0.027, 0.006, 0.005, BP, bone, n="small", k=4)
    P.loft([((x, y, z), 0.023, 0.023, 0.023, 2.0), ((x + s * 0.006, y, z), 0.020, 0.020, 0.020, 2.0),
            ((x + s * 0.012, y, z), 0.011, 0.011, 0.011, 2.0)], RB, bone, n=10, sub=1, caps=(False, True), ref=(0, 1, 0))


def paw(P: Parts, x: float, heel: float, toe: float, bone: str) -> None:
    """Aged-brass sole flat on the floor (z = 0) under the toes, an arched polished pad rising to the
    heel, four knuckled polished toes with gunmetal claws."""
    L = P.loft
    L([((x, heel + 0.03, 0.012), 0.026, 0.014, 0.012, 2.6), ((x, heel + 0.06, 0.012), 0.036, 0.016, 0.012, 2.8),
       ((x, toe, 0.012), 0.040, 0.012, 0.012, 2.8), ((x, toe + 0.02, 0.010), 0.034, 0.008, 0.010, 2.6)], BA, bone, n="small", sub=1)
    L([((x, heel - 0.004, 0.052), 0.022, 0.024, 0.020, 2.4), ((x, heel + 0.03, 0.044), 0.030, 0.026, 0.022, 2.6),
       ((x, toe - 0.035, 0.032), 0.032, 0.018, 0.012, 2.6)], BP, bone, n="small", sub=1)
    for k, dx in enumerate((-0.030, -0.010, 0.010, 0.030)):
        y0 = toe - 0.036 + (0.008 if k in (1, 2) else 0.0)
        L([((x + dx, y0, 0.040), 0.012, 0.020, 0.014, 2.4), ((x + dx, y0 + 0.026, 0.050), 0.014, 0.026, 0.024, 2.6),
           ((x + dx, y0 + 0.052, 0.034), 0.012, 0.016, 0.018, 2.4)], BP, bone, n="small", sub=1)
        L([((x + dx, y0 + 0.058, 0.018), 0.004, 0.005, 0.004, 2.0), ((x + dx, y0 + 0.070, 0.006), 0.001, 0.001, 0.001, 2.0)],
          GM, bone, n=5, sub=1, caps=(False, False))


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
    zmin = min(v.co.z for v in P.bm.verts)
    if abs(zmin) > 5e-4:
        raise RuntimeError(f"{detail} mesh lowest vertex at z = {zmin:.5f}, want the paw soles on z = 0")
    for v in P.bm.verts:  # soles land on exactly z = 0 (the rest-pose floor contract)
        if abs(v.co.z) < 5e-4:
            v.co.z = 0.0
    col = P.bm.loops.layers.float_color.new("tint")
    shade = {GM: (*(lin(c) for c in GM_SRGB), 1.0), RB: (*(lin(c) for c in RUBY_SRGB), 1.0)}
    for f in P.bm.faces:
        rgba = shade.get(f.material_index, (1.0, 1.0, 1.0, 1.0))
        for loop in f.loops:
            loop[col] = rgba
        if f.material_index == RB:
            f.material_index = GM
    bmesh.ops.recalc_face_normals(P.bm, faces=P.bm.faces[:])
    # Fixed triangulation here: the exporter's own quad split follows float noise between runs.
    bmesh.ops.triangulate(P.bm, faces=P.bm.faces[:], quad_method="FIXED", ngon_method="EAR_CLIP")
    P.bm.normal_update()
    tile_uvs(P.bm)
    me = bpy.data.meshes.new(f"{BODY}-{detail}")
    P.bm.to_mesh(me)
    P.bm.free()
    me.color_attributes.active_color_name = "tint"
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
    """PLANT with some legs moved: leg=(dy, dz[, distal pitch]) offsets from the rest target."""
    out = dict(PLANT)
    for k, v in moved.items():
        leg = k.replace("_", ".")
        out[leg] = (REST_TARGET[leg][0] + v[0], REST_TARGET[leg][1] + v[1], *v[2:])
    return out


def idle_pose(t: float) -> dict:
    w = 2 * math.pi * t / CLIPS["idle"]["duration"]
    b = math.sin(w)
    return {
        "pelvis_loc": (0, 0, 0.008 * b),
        "spine.1": (1.2 * b, 0, 0), "spine.2": (-0.6 * b, 0, 0), "spine.3": (-0.6 * b, 0, 0),
        "neck.1": (3.0 * math.sin(w + 0.6), 0, 0),
        "head": (2.0 * math.sin(2 * w), 0, 9.0 * math.sin(w)),
        "jaw": (-3.0 - 2.0 * (1 + math.sin(2 * w)), 0, 0),
        "ear.R": (3.0 * (1 + math.sin(2 * w)), 0, 0), "ear.L": (3.0 * (1 + math.sin(2 * w + 1.0)), 0, 0),
        "tail.1": (0, 0, 14.0 * math.sin(w)), "tail.2": (0, 0, 14.0 * math.sin(w - 0.7)), "tail.3": (0, 0, 14.0 * math.sin(w - 1.4)),
        "tail.4": (0, 0, 10.0 * math.sin(w - 2.1)),
        "spin": {"key": 360.0 * t / CLIPS["idle"]["duration"]},
        "ik": PLANT,
    }


START = {"jaw": (-3, 0, 0), "ear.R": (3, 0, 0), "ear.L": (3 + 3 * math.sin(1.0), 0, 0), "ik": PLANT}
EARS_BACK = {"ear.R": (28, 0, 0), "ear.L": (28, 0, 0)}
ATTACK_KEYS = [
    (0.0, START),
    (0.3, {"pelvis_loc": (0, -0.07, -0.13), "spine.1": (-3, 0, 0), "spine.2": (-2, 0, 0), "neck.1": (-16, 0, 0), "neck.2": (-6, 0, 0),
           "head": (-4, 0, 0), "jaw": (-14, 0, 0), **EARS_BACK, "tail.1": (-22, 0, 0), "tail.2": (-8, 0, 0), "ik": PLANT}),
    (0.42, {"pelvis_loc": (0, 0.06, -0.06), "spine.1": (-4, 0, 0), "spine.2": (-3, 0, 0), "neck.1": (-20, 0, 0), "neck.2": (-4, 0, 0),
            "head": (6, 0, 0), "jaw": (-38, 0, 0), **EARS_BACK, "tail.1": (-26, 0, 0), "tail.2": (-10, 0, 0),
            "ik": planted(fore_R=(0.20, 0.09, -30), fore_L=(0.14, 0.05, -25))}),
    (0.5, {"pelvis_loc": (0, 0.15, -0.03), "spine.1": (-5, 0, 0), "spine.2": (-4, 0, 0), "spine.3": (-2, 0, 0), "neck.1": (-22, 0, 0),
           "head": (-6, 0, 0), "jaw": (0, 0, 0), **EARS_BACK, "tail.1": (-24, 0, 0), "tail.2": (-8, 0, 0),
           "ik": planted(fore_R=(0.30, 0.07, -20), fore_L=(0.26, 0.03, -15))}),
    (0.72, {"pelvis_loc": (0, 0.12, -0.04), "spine.1": (-3, 0, 0), "spine.2": (-2, 0, 0), "neck.1": (-14, 0, 6), "head": (-6, 0, -8),
            "jaw": (-8, 0, 0), "ear.R": (12, 0, 0), "ear.L": (12, 0, 0), "tail.1": (-14, 0, 0),
            "ik": planted(fore_R=(0.24, 0.0), fore_L=(0.20, 0.0))}),
    (1.1, START),
]
HIT_KEYS = [
    (0.0, START),
    (0.1, {"pelvis_loc": (0, -0.07, 0.015), "spine.2": (5, 0, 0), "spine.3": (4, 0, 0), "neck.1": (20, 0, 10), "head": (10, 0, 18),
           "jaw": (-18, 0, 0), "ear.R": (-10, 0, 0), "ear.L": (-14, 0, 0), "tail.1": (24, 0, 0), "tail.2": (12, 0, 0), "ik": PLANT}),
    (0.28, {"pelvis_loc": (0, -0.025, 0.005), "spine.2": (2, 0, 0), "neck.1": (7, 0, 4), "head": (3, 0, 6), "jaw": (-8, 0, 0),
            "tail.1": (10, 0, 0), "ik": PLANT}),
    (0.6, START),
]
DEATH_LIE = {"pelvis_loc": (0, -0.02, -0.66), "pelvis": (0, 86, 0), "spine.1": (-3, 0, 4), "spine.2": (-2, 0, 3),
             "neck.1": (-20, 0, -10), "neck.2": (-8, 0, -6), "head": (-6, 0, -10), "jaw": (-22, 0, 0), "ear.R": (20, 0, 0), "ear.L": (20, 0, 0),
             "upperarm.R": (18, 0, 0), "forearm.R": (-28, 0, 0), "wrist.R": (20, 0, 0),
             "upperarm.L": (32, 0, 0), "forearm.L": (-46, 0, 0), "wrist.L": (24, 0, 0),
             "thigh.R": (-10, 0, 0), "shin.R": (22, 0, 0), "hock.R": (-12, 0, 0),
             "thigh.L": (6, 0, 0), "shin.L": (30, 0, 0), "hock.L": (-20, 0, 0),
             "tail.1": (10, 0, 12), "tail.2": (8, 0, 8), "tail.3": (6, 0, 6), "tail.4": (4, 0, 4)}
DEATH_KEYS = [
    (0.0, START),
    (0.2, {"pelvis_loc": (0, -0.05, 0.01), "spine.2": (4, 0, 0), "neck.1": (18, 0, 6), "head": (10, 0, 12), "jaw": (-24, 0, 0),
           "tail.1": (20, 0, 0), "ik": PLANT}),
    (0.75, {"pelvis_loc": (0, -0.03, -0.30), "spine.1": (9, 0, 0), "spine.2": (4, 0, 0), "neck.1": (-12, 0, 0), "head": (-12, 0, 0),
            "jaw": (-16, 0, 0), "tail.1": (30, 0, 0), "ik": PLANT}),
    (1.4, DEATH_LIE),
    (1.55, {**DEATH_LIE, "pelvis_loc": (0, -0.02, -0.63), "neck.1": (-14, 0, -8)}),
    (2.0, DEATH_LIE),
]
FROZEN_POSE = {"pelvis_loc": (0, -0.02, -0.05), "spine.1": (-2, 0, 0), "neck.1": (-12, 0, 6), "neck.2": (-4, 0, 0), "head": (-4, 0, 10),
               "jaw": (-24, 0, 0), **EARS_BACK, "tail.1": (-16, 0, 8), "tail.2": (-6, 0, 4),
               "ik": planted(fore_R=(0.11, 0.13, -45))}


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
    from mathutils import Euler, Quaternion, Vector

    res = resolve(pose)
    spin = pose.get("spin", {})
    for pb in arm_obj.pose.bones:
        if pb.name == "root":
            continue
        r = pb.bone.matrix_local.to_quaternion()
        rx, ry, rz = res.get(pb.name, (0, 0, 0))
        q = Euler((math.radians(rx), math.radians(ry), math.radians(rz)), "XYZ").to_quaternion()
        if pb.name in spin:
            axis = (Vector(TAIL[pb.name]) - Vector(HEAD[pb.name])).normalized()
            q = q @ Quaternion(axis, math.radians(spin[pb.name]))
        pb.rotation_quaternion = r.inverted() @ q @ r
        if frame is not None:
            pb.keyframe_insert("rotation_quaternion", frame=frame)
        if pb.name == LOC_BONE:
            pb.location = r.inverted() @ Vector(pose.get("pelvis_loc", (0, 0, 0)))
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
    if name == "gunmetal":  # gunmetal and ruby from the corner colours (exported as COLOR_0)
        attr = mat.node_tree.nodes.new("ShaderNodeVertexColor")
        attr.layer_name = "tint"
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
    "socket-hit": ("chest", (0, 0.585, 0.655)),  # in front of the grille's amber core: hit sparks and aim point
    "socket-eye": ("head", (0, 0.715, 1.150)),  # on the brow between the eyes
    "socket-weapon": ("jaw", (0, 0.850, 0.985)),  # the snapping jaw tip
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
        # ACTIVE, not MATERIAL: Blender 5.2 MATERIAL mode writes a white COLOR_0 placeholder and moves the
        # layer to COLOR_1, which three.js ignores.
        export_vertex_color="ACTIVE",  # COLOR_0 for the gunmetal slot (white on every other corner)
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
    if any("COLOR_1" in p["attributes"] for p in prims):
        errors.append("COLOR_1 exported (three.js reads only COLOR_0)")
    if not any("COLOR_0" in p["attributes"] for p in prims if mats[p["material"]] == "gunmetal"):
        errors.append("gunmetal primitive without COLOR_0 (its gunmetal and ruby hues)")
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
        "frame": {"units": "m", "up": "+Y", "forward": "-Z", "origin": "body centre on the floor (y = 0)",
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
        "materialSlots": {name: ({"set": name, "tileMeters": TILE_METERS, "normalScale": SETS[name],
                                  **({"tint": TINTS[name]} if name in TINTS else {})} if name in SETS
                                 else {"set": None, "factorOnly": True, **({"emissive": True} if name == GLOW else {})}) for name in MATS},
        "budget": {"tris": gate["triangles"], "materials": len(gate["materials"]), "bones": gate["bone_count"], "influences": LIMITS["influences"]},
        "cull": {"center": cull["center"], "radius": cull["radius"]},
    }


# --------------------------------------------------------------------------------------------------
# Review renders (EEVEE)

VIEWS = {"front": ((0, 3.6, 0.8), (0, 0, 0.6)), "side": ((3.8, 0, 0.8), (0, 0, 0.6)),
         "back": ((0, -3.6, 0.8), (0, 0, 0.6)), "three-quarter": ((2.4, 2.7, 1.2), (0, 0, 0.6))}
ANIM_CAMERA = ((2.6, 2.4, 1.3), (0, 0.05, 0.55), 45.0)
ROM = {"rig-rom-stretch": {"pelvis_loc": (0, 0.06, -0.04), "neck.1": (-30, 0, 20), "head": (10, 0, 25), "jaw": (-40, 0, 0),
                           "spine.1": (-6, 0, 0), "tail.1": (-35, 0, -20), "tail.2": (-15, 0, -20), "ear.R": (30, 0, 0),
                           "ik": planted(fore_R=(0.26, 0.17, -60), hind_L=(-0.12, 0.08, 40))},
       "rig-rom-crouch": {"pelvis_loc": (0, -0.04, -0.24), "spine.1": (8, 0, 0), "spine.2": (6, 0, 0), "neck.1": (-20, 0, 0),
                          "tail.1": (30, 0, 0), "ik": PLANT}}
FRAMES = {"anim-idle": ("idle", 0.5), "anim-attack-crouch": ("attack", 0.3), "anim-attack-snap": ("attack", 0.42),
          "anim-attack-impact": ("attack", 0.5), "anim-hit": ("hit", 0.1), "anim-frozen": ("frozen", 0.0),
          "anim-death-slump": ("death", 0.75), "anim-death-end": ("death", 2.0)}
# Concept-angle comparison: orthographic, framed like the concept crops of hound-sheet-1.png (sheet
# pixels). Side: the camera on the hound's right (+X), as drawn (head to the right); the side crop
# is the `CX` frame, so 1.2 m spans 855 px. Front and back: 1.21 m (ear tips) spans 875 px there.
CONCEPT_CROPS = {"side": (80, 30, 1400, 980), "front": (1500, 30, 1900, 980), "back": (2080, 30, 2480, 980)}
FB_PX = 1.21 / 875.0
COMPARE = {  # camera direction from the hound, target (y, z), metres per crop pixel
    "side": ((1, 0, 0), (CX(660, 475)[0], CX(660, 475)[1]), CX_PX),
    "front": ((0, 1, 0), (0.0, (910 - 475) * FB_PX), FB_PX),
    "back": ((0, -1, 0), (0.0, (910 - 475) * FB_PX), FB_PX),
}
COMPARE_RES = 0.75  # render pixels per crop pixel


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




def compare_renders(bpy, scene, out: Path) -> list[str]:
    """Orthographic renders at the concept's side, front and back angles, framed like the concept
    crops (CONCEPT_CROPS, same metres per pixel), on a grey close to the sheet's, for the
    side-by-side fidelity check."""
    from mathutils import Vector

    rdir = out / "renders"
    rdir.mkdir(parents=True, exist_ok=True)
    cs = bpy.data.scenes.new(f"{PIECE}-compare")
    for o in scene.objects:
        if o.type in {"MESH", "ARMATURE"} and not o.name.startswith("review-"):
            cs.collection.objects.link(o)
    setup_render(cs)
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
    for o, e in ((key, 520.0), (fill, 160.0)):
        o.data.energy, o.data.size, o.data.color = e, 2.5, (1.0, 0.86, 0.66)
        cs.collection.objects.link(o)
    done = []
    with bpy.context.temp_override(scene=cs, view_layer=cs.view_layers[0]):
        if bpy.context.window is not None:
            bpy.context.window.scene = cs
        for view, (d, (ty, tz), mpp) in COMPARE.items():
            x0, y0, x1, y1 = CONCEPT_CROPS[view]
            w, h = x1 - x0, y1 - y0
            cs.render.resolution_x, cs.render.resolution_y = round(w * COMPARE_RES), round(h * COMPARE_RES)
            cam.data.ortho_scale = max(w, h) * mpp
            d = Vector(d)
            side = d.cross(Vector((0, 0, 1)))
            target = Vector((0, ty, tz))
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


# --------------------------------------------------------------------------------------------------
# Review sheet, fidelity compare and the author self-score (system Python + Pillow)

ENGINE_SHOTS = ["idle", "attack", "hit", "frozen", "death", "glow-close"]  # glow-close: idle through a 30 degree lens on the upper body
APPROVAL_NOTE = ('Concept approval PENDING (Paul). Modeled under Paul\'s standing approval of 2026-11-15: "you have standing approval '
                 'for all spending / modeling / deployments needed for this project". Model, rig, animation approvals pending.')
TITLE = f"P5-T3 Spring Hound ({PIECE}) - owner review sheet"
COMPARE_SHEET = f"{PIECE}.fidelity-compare.jpg"


def fidelity_note(out: Path) -> str:
    f = out / "fidelity.json"
    if not f.exists():
        return "Fidelity self-assessment: not yet scored."
    j = json.loads(f.read_text())
    gaps = "".join(f"\n  - {g}" for g in j.get("gaps", []))
    return f"Fidelity self-assessment (author, not an independent score): {j['score']}/100. Remaining gaps: {gaps}"


def _sheet(rows: list[tuple[str, list[tuple[str, object, int, int]]]], title: str, note: str, width: int):
    """Rows of (label, image or path, tile width, tile height) under a title and note lines."""
    from PIL import Image, ImageDraw

    pad, cap, head = 10, 24, 34
    lines = note.split("\n")
    top = 50 + 18 * len(lines)
    height = top + sum(head + max(t[3] for t in tiles) + cap + pad for _, tiles in rows) + pad
    sheet = Image.new("RGB", (width, height), (28, 24, 22))
    d = ImageDraw.Draw(sheet)
    d.text((pad, 12), title, fill=(243, 190, 101))
    for i, line in enumerate(lines):
        d.text((pad, 34 + 18 * i), line, fill=(222, 193, 106))
    y = top
    for rtitle, tiles in rows:
        d.text((pad, y + 10), rtitle, fill=(243, 190, 101))
        y += head
        x = pad
        for label, src, tw, th in tiles:
            img = src if isinstance(src, Image.Image) else (Image.open(src).convert("RGB") if Path(src).exists() else None)
            if img is not None:
                img = img.copy()
                img.thumbnail((tw, th))
                sheet.paste(img, (x + (tw - img.width) // 2, y + cap + (th - img.height) // 2))
            else:
                d.text((x + 8, y + cap + 8), f"missing: {Path(src).name}", fill=(200, 80, 80))
            d.text((x, y + 4), label, fill=(222, 193, 106))
            x += tw + pad
        y += max(t[3] for t in tiles) + cap + pad
    return sheet


def compose_compare(out: Path) -> Path:
    """Each concept view crop beside the textured model at the same angle and framing."""
    from PIL import Image

    concept = Image.open(CONCEPT).convert("RGB")
    r = out / "renders"
    sw, sh, fw, fh = 900, 648, 300, 712
    rows = [
        ("FIDELITY - concept side view beside the model (orthographic, same angle and metres per pixel)", [
            ("concept side", concept.crop(CONCEPT_CROPS["side"]), sw, sh), ("model side", r / "compare-side.png", sw, sh)]),
        ("FIDELITY - concept front and back beside the model (orthographic, same framing)", [
            ("concept front", concept.crop(CONCEPT_CROPS["front"]), fw, fh), ("model front", r / "compare-front.png", fw, fh),
            ("concept back", concept.crop(CONCEPT_CROPS["back"]), fw, fh), ("model back", r / "compare-back.png", fw, fh)]),
    ]
    sheet = _sheet(rows, TITLE.replace("owner review sheet", "fidelity comparison"), fidelity_note(out), 2 * sw + 3 * 10)
    path = out.parent / COMPARE_SHEET
    sheet.save(path, quality=88)
    return path


def compose_sheet(out: Path) -> Path:
    compare = compose_compare(out)
    r = out / "renders"
    eng = out / "engine"
    t = 360
    te = (5 * (t + 10)) // len(ENGINE_SHOTS) - 10  # the engine row fits the sheet width
    rows = [
        ("REFERENCE - hound-sheet-1.png (concept; owner approval PENDING)", [("concept sheet", CONCEPT, 5 * t + 40, 2 * t)]),
        ("FIDELITY - concept views beside the model at the same angle and framing", [(COMPARE_SHEET, compare, 5 * t + 40, 2 * t)]),
        ("MODEL - textured Blender renders (shared brass sets), approval PENDING", [
            ("low front", r / "model-low-front.png", t, t), ("low side", r / "model-low-side.png", t, t),
            ("low back", r / "model-low-back.png", t, t), ("low 3/4", r / "model-low-three-quarter.png", t, t),
            ("high source 3/4", r / "model-high-three-quarter.png", t, t)]),
        (f"RIG - approval PENDING: {len(BONES)} bones, rigid 1-bone skinning, planar leg solve", [
            ("range of motion: stretch", r / "rig-rom-stretch.png", t, t), ("range of motion: crouch", r / "rig-rom-crouch.png", t, t),
            ("attack crouch 0.3 s", r / "anim-attack-crouch.png", t, t), ("attack jaw open 0.42 s", r / "anim-attack-snap.png", t, t),
            ("death slump 0.75 s", r / "anim-death-slump.png", t, t)]),
        ("ANIMATION - Blender frames, approval PENDING", [
            ("idle 0.5 s", r / "anim-idle.png", t, t), ("attack impact 0.5 s", r / "anim-attack-impact.png", t, t),
            ("hit 0.1 s", r / "anim-hit.png", t, t), ("frozen (held)", r / "anim-frozen.png", t, t),
            ("death end 2.0 s", r / "anim-death-end.png", t, t)]),
        ("IN ENGINE - three.js 0.186.1, headless Chromium on the GPU, seated player 2.6 m away, runtime D11 glow", [
            (name, eng / f"{name}.jpg", te, te) for name in ENGINE_SHOTS]),
    ]
    sheet = _sheet(rows, TITLE, APPROVAL_NOTE + "\n" + fidelity_note(out), 5 * (t + 10) + 10)
    path = out.parent / f"{PIECE}.review-sheet.jpg"
    sheet.save(path, quality=86)
    return path


def record_fidelity(out: Path) -> Path:
    """Adds the author's self-score (staging/fidelity.json) to provenance.json as `authorSelfScore`,
    bound to the compare image's bytes. Run after `asset-check.py --assemble-enemy`, which rebuilds
    provenance from scratch. The independent score stays a separate, pending approval entry."""
    prov_path = out.parent / "provenance.json"
    prov = json.loads(prov_path.read_text())
    fid = json.loads((out / "fidelity.json").read_text())
    compare = out.parent / COMPARE_SHEET
    prov["authorSelfScore"] = {
        "score": fid["score"], "scale": "0-100 visual fidelity to the concept",
        "scorer": "author self-score (the authoring agent; not the independent score create-rigged-character-assets requires)",
        "date": fid.get("date"), "gaps": fid.get("gaps", []), "method": fid.get("method"),
        "evidence": {"path": str(compare.relative_to(REPO)), "sha256": sha256(compare)},
        "independentScore": "pending",
    }
    prov_path.write_text(json.dumps(prov, indent=2) + "\n")
    return prov_path


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
    rest = resolve({"ik": PLANT})
    if any(abs(a) > 1e-6 for v in rest.values() for a in v):
        raise RuntimeError(f"leg solve does not reproduce the rest pose: {rest}")
    if args.compare_only:
        set_slots(body, source_materials(bpy))
        print(f"[{PIECE}] tris low={sum(len(p.vertices) - 2 for p in body.data.polygons)}")
        compare_renders(bpy, low_scene, out)
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
    elif ARGS.record_fidelity:
        print(record_fidelity(ARGS.out.resolve()))
    else:
        main_blender(ARGS)
