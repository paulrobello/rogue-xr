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
# The sets' basecolor, roughness and metalness are near flat; their strong variance is the ORM red
# channel, which the runtime binds as aoMap (src/world/materials.ts). Tiled at 0.5 m it put one AO blotch
# on each face: the wood grain and cream patches of the first build. Every brass face therefore samples
# one AO-255 texel (a constant UV: zero derivatives, so mip 0 and no normal map), as on the bellows golem.
# Runtime row = v * 1024 (three flips the PNG/KTX2 rows). polished: an 11 px AO >= 253 window, the
# golem's texel; aged: the centre of its 16 px window (basecolor there (204, 164, 89), set mean (191, 150, 85)).
# False restores the 0.5 m tiling (then drop TINTS too).
FLAT_BRASS = True
FLAT_BRASS_UV = {"brass-polished": (566.5 / 1024, 198.5 / 1024), "brass-aged": (930.5 / 1024, 477.5 / 1024)}
# Linear multiplier on the bound set's colour (manifest slot `tint`, enemy-asset.ts bind(), each channel
# 0..1). The first factor stands in for the tiled AO mean (0.865) the flat texel no longer applies (aged also
# for its brighter texel, 0.85). Pass 2 moves the engine median (96, 64, 33) (hue 30, HSL S 0.49) toward the
# concept's dusty bronze (91, 64, 46) (hue 24, S 0.33) at the same value. No per-channel multiply reaches
# both that median and the lit p90, which already matches ((214, 173, 119) against (203, 163, 102)): S 0.33
# needs blue x1.94, which puts p90 blue near 160 (cream), and a green cut to median hue 24 drags the p90 hue
# from 34 to 25 (concept 36). Compromise: green x0.93, blue x1.12: predicted median (96, 62, 35), hue 26,
# S 0.46; p90 (214, 167, 125), hue 28.5. Aged takes the same per-channel ratios.
TINTS = {"brass-polished": [0.87, 0.66, 0.829], "brass-aged": [0.74, 0.558, 0.706]}
# The exporter's NORMAL carries float noise from Blender's corner-normal sums (pass 1: one hidden vertex
# flipped a 4-digit rounding step in about 40% of builds). canonicalize_normals snaps every NORMAL to this
# grid and renormalizes, so that noise cannot reach the bytes. None disables it (for A/B builds).
NORMAL_QUANTUM = 1.0 / 128.0
GM_SRGB = (0x2E, 0x2A, 0x2A)  # gunmetal, carried by COLOR_0 on the white gunmetal slot
# Faceted jewel inlays (sheet-1: outer thighs, upper arms): pseudo slots mapped to the gunmetal slot, their
# hues in COLOR_0, one per facet sector (stained-glass read: cyan, violet, magenta, emerald, sapphire, ruby).
# Pass 2: each hue scaled to a 0xF0 peak at the same hue and saturation; the jewels sit on the metal 0.85
# gunmetal slot, which darkened the pass-1 stones below the reviewer's saturated-pixel floor (V > 0.25).
JEWEL_SRGB = [(0x25, 0xCB, 0xF0), (0x7F, 0x3A, 0xF0), (0xF0, 0x1E, 0x96), (0x18, 0xF0, 0x78), (0x25, 0x4A, 0xF0), (0xF0, 0x14, 0x3C)]
JW = 20  # pseudo material indices JW .. JW + 5
# Factor-only GLB materials (sRGB, roughness, metallic): the fallback look when the sets fail to load.
EXPORT_FACTORS = {
    "brass-polished": ((0xDE, 0xC1, 0x6A), 0.3, 1.0),
    "brass-aged": ((0xA8, 0x86, 0x48), 0.45, 1.0),
    "gunmetal": ((0xFF, 0xFF, 0xFF), 0.42, 0.85),  # hue from COLOR_0: gunmetal and the jewels
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

DETAIL = {"low": {"sides": 10, "sphere": (12, 6), "gear": 1, "k": 1.0}, "high": {"sides": 24, "sphere": (24, 14), "gear": 3, "k": 2.2}}


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
        """UV sphere built vertex by vertex in a fixed order (the topology of create_uvsphere, which welds its
        seam and poles with an internal remove_doubles; its merge order is the suspected source of the
        run-dependent loop order on the pass-1 shoulder ball)."""
        u, v = self.d["sphere"]
        sx, sy, sz = (r * k for k in scale)
        bm = self.bm

        def pt(th: float, ph: float) -> tuple:
            return (c[0] + sx * math.sin(th) * math.cos(ph), c[1] + sy * math.sin(th) * math.sin(ph), c[2] + sz * math.cos(th))

        rows = [[bm.verts.new(pt(math.pi * j / v, 2 * math.pi * i / u)) for i in range(u)] for j in range(1, v)]
        top, bot = bm.verts.new((c[0], c[1], c[2] + sz)), bm.verts.new((c[0], c[1], c[2] - sz))
        faces = []
        for i in range(u):
            k = (i + 1) % u
            faces.append(bm.faces.new((top, rows[0][i], rows[0][k])))
            faces.append(bm.faces.new((bot, rows[-1][k], rows[-1][i])))
        for a, b_ in zip(rows, rows[1:]):
            for i in range(u):
                k = (i + 1) % u
                faces.append(bm.faces.new((a[i], b_[i], b_[k], a[k])))
        self._finish([x for row in rows for x in row] + [top, bot], faces, mat, bone, smooth=True)

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

    # Curved-plate primitives (pass 1). They build world points directly (no mathutils), so the parts
    # are exact in an offline probe. Winding is fixed later by recalc_face_normals in build_body.

    def n(self, base: int) -> int:
        return max(3, int(round(base * self.d["k"])))

    def rings3(self, rings: list, mat: int, bone: str, smooth=True, caps=True) -> None:
        bm = self.bm
        vr = [[bm.verts.new(p) for p in ring] for ring in rings]
        k = len(rings[0])
        faces = [bm.faces.new((a[i], a[(i + 1) % k], b_[(i + 1) % k], b_[i])) for a, b_ in zip(vr, vr[1:]) for i in range(k)]
        if caps:
            faces += [bm.faces.new(list(reversed(vr[0]))), bm.faces.new(vr[-1])]
        self._finish([v for r in vr for v in r], faces, mat, bone, smooth)

    def vloft(self, table: list, mat: int, bone: str, n: int | None = None, caps=True) -> None:
        """Vertical loft of stations (z, cx, cy, rx, front, back, p): superellipse sections whose
        front (+Y) and back half-depths differ, so calves swell and chests carry depth."""
        n = n or self.n(16)
        self.rings3([[vsec(st, 2 * math.pi * i / n) for i in range(n)] for st in table], mat, bone, caps=caps)

    def vplate(self, table: list, z0: float, z1: float, a0, a1, off: float, t: float, mat: int, bone: str, s: int = 1,
               nu: int | None = None, nv: int = 3, crown: float = 0.0, smooth: bool = True) -> None:
        """Curved plate of thickness t whose outer face lies `off` outside a vloft table's surface, from z0
        to z1 and from angle a0 to a1 (degrees from the front toward the s side; callables of z for tapered
        or pointed plates). `crown` bulges its middle so each plate carries its own highlight; smooth=False
        keeps every quad a flat facet (angular plates)."""
        nu = nu or self.n(8)
        f = lambda g, z: g(z) if callable(g) else g  # noqa: E731

        def pt(u: float, v: float, o: float) -> tuple:
            z = z0 + (z1 - z0) * v
            a = f(a0, z) + (f(a1, z) - f(a0, z)) * u
            return vsurf(table, z, a, off + o + crown * math.sin(math.pi * u), s)

        bm = self.bm
        front = [[bm.verts.new(pt(i / nu, j / nv, 0.0)) for j in range(nv + 1)] for i in range(nu + 1)]
        back = [[bm.verts.new(pt(i / nu, j / nv, -t)) for j in range(nv + 1)] for i in range(nu + 1)]
        faces = []
        for i in range(nu):
            for j in range(nv):
                faces.append(bm.faces.new((front[i][j], front[i + 1][j], front[i + 1][j + 1], front[i][j + 1])))
                faces.append(bm.faces.new((back[i][j + 1], back[i + 1][j + 1], back[i + 1][j], back[i][j])))
        border = [(i, 0) for i in range(nu)] + [(nu, j) for j in range(nv)] + [(i, nv) for i in range(nu, 0, -1)] + [(0, j) for j in range(nv, 0, -1)]
        for (i0, j0), (i1, j1) in zip(border, border[1:] + border[:1]):
            faces.append(bm.faces.new((front[i1][j1], front[i0][j0], back[i0][j0], back[i1][j1])))
        self._finish([v for g in (front, back) for row in g for v in row], faces, mat, bone, smooth)

    def dome(self, c, radii, s: int, az: tuple, el: tuple, t: float, mat: int, bone: str, nu: int | None = None, nv: int | None = None,
             smooth: bool = True) -> None:
        """Ellipsoid shell of thickness t: azimuth from the outward (s * X) axis toward +Y, elevation up.
        Full azimuth wraps; elevation 90 closes on a pole. Pauldron caps and lames."""
        full = abs(az[1] - az[0]) >= 359.999
        nu = nu or self.n(16)
        nv = nv or self.n(5)
        pole = el[1] >= 89.999
        cols = nu if full else nu + 1
        rows = nv if pole else nv + 1

        def p(i: int, j: int, o: float) -> tuple:
            a = math.radians(az[0] + (az[1] - az[0]) * i / nu)
            e = math.radians(el[0] + (el[1] - el[0]) * j / nv)
            rx, ry, rz = (r + o for r in radii)
            return (c[0] + s * rx * math.cos(e) * math.cos(a), c[1] + ry * math.cos(e) * math.sin(a), c[2] + rz * math.sin(e))

        bm = self.bm
        out = [[bm.verts.new(p(i, j, 0.0)) for j in range(rows)] for i in range(cols)]
        inn = [[bm.verts.new(p(i, j, -t)) for j in range(rows)] for i in range(cols)]
        tops = [bm.verts.new((c[0], c[1], c[2] + radii[2] + o)) for o in (0.0, -t)] if pole else []
        faces = []
        span = cols if full else cols - 1
        for i in range(span):
            i1 = (i + 1) % cols
            for j in range(rows - 1):
                faces.append(bm.faces.new((out[i][j], out[i1][j], out[i1][j + 1], out[i][j + 1])))
                faces.append(bm.faces.new((inn[i][j + 1], inn[i1][j + 1], inn[i1][j], inn[i][j])))
            if pole:
                faces.append(bm.faces.new((out[i][rows - 1], out[i1][rows - 1], tops[0])))
                faces.append(bm.faces.new((tops[1], inn[i1][rows - 1], inn[i][rows - 1])))
            else:
                faces.append(bm.faces.new((out[i1][rows - 1], out[i][rows - 1], inn[i][rows - 1], inn[i1][rows - 1])))
            faces.append(bm.faces.new((out[i][0], inn[i][0], inn[i1][0], out[i1][0])))
        if not full:
            for i in (0, cols - 1):
                for j in range(rows - 1):
                    faces.append(bm.faces.new((out[i][j], out[i][j + 1], inn[i][j + 1], inn[i][j])))
                if pole:
                    faces.append(bm.faces.new((out[i][rows - 1], tops[0], tops[1], inn[i][rows - 1])))
        self._finish([v for g in (out, inn) for col in g for v in col] + tops, faces, mat, bone, smooth)

    def xcyl(self, c, r: float, x0: float, x1: float, mat: int, bone: str, n: int | None = None) -> None:
        """Cylinder along X (knee and elbow hinges, ear discs)."""
        n = n or self.n(12)
        self.rings3([[(x, c[1] + r * math.cos(2 * math.pi * i / n), c[2] + r * math.sin(2 * math.pi * i / n)) for i in range(n)] for x in (x0, x1)],
                    mat, bone)

    def yloft(self, table: list, mat: int, bone: str, n: int | None = None) -> None:
        """Loft along +Y of stations (y, cx, rx, h, p) whose sections stand on z = 0 (sabatons)."""
        n = 2 * ((n or self.n(12)) // 2)  # even: one corner lands exactly on the sole

        def ring(st) -> list:
            y, cx, rx, h, p = st
            out = []
            for i in range(n):
                a = 2 * math.pi * i / n
                sn, cs = math.sin(a), math.cos(a)
                out.append((cx + rx * math.copysign(abs(sn) ** (2 / p), sn), y, h / 2 + h / 2 * math.copysign(abs(cs) ** (2 / p), cs)))
            return out

        self.rings3([ring(st) for st in table], mat, bone)

    def frame_loft(self, origin, w, tv, table: list, mat: int, bone: str, n: int | None = None) -> None:
        """Loft of stations (z, half-width along w, half-thickness along tv, p) about origin(z): hands."""
        n = n or self.n(12)
        rings = []
        for z, aw, at, p in table:
            o = origin(z)
            ring = []
            for i in range(n):
                a = 2 * math.pi * i / n
                sn, cs = math.sin(a), math.cos(a)
                u, v = aw * math.copysign(abs(sn) ** (2 / p), sn), at * math.copysign(abs(cs) ** (2 / p), cs)
                ring.append((o[0] + w[0] * u + tv[0] * v, o[1] + w[1] * u + tv[1] * v, z))
            rings.append(ring)
        self.rings3(rings, mat, bone)

    def jewel(self, c, nrm, up, ru: float, rv: float, h: float, bone: str, sectors: int = 6, sink: float = 0.010) -> None:
        """Faceted oval cabochon on a brass-aged bezel: each facet sector one jewel hue (COLOR_0). The bezel
        starts `sink` below the centre's tangent plane, so a wide stone on a curved plate shows no gap."""
        nrm = _unit(nrm)
        u = _unit(_sub(up, _mul(nrm, _dot(up, nrm))))
        v = _cross(nrm, u)
        bm = self.bm
        k = sectors

        def ring(f: float, lift: float) -> list:
            return [bm.verts.new(_add(c, _add(_mul(nrm, lift), _add(_mul(u, ru * f * math.cos(2 * math.pi * i / k)),
                                                                  _mul(v, rv * f * math.sin(2 * math.pi * i / k)))))) for i in range(k)]

        base, mid = ring(1.0, 0.0), ring(0.62, 0.62 * h)
        apex = bm.verts.new(_add(c, _mul(nrm, h)))
        verts = base + mid + [apex]
        gi = BONE_NAMES.index(bone)
        for vv in verts:
            vv[self.deform][gi] = 1.0
        for i in range(k):
            j = (i + 1) % k
            for f in (bm.faces.new((base[i], base[j], mid[j], mid[i])), bm.faces.new((mid[i], mid[j], apex))):
                f.material_index = JW + i % len(JEWEL_SRGB)
                f.smooth = False  # flat facets: each sector catches its own glint
        f = bm.faces.new(list(reversed(base)))
        f.material_index, f.smooth = GM, False
        # Bezel: a brass-aged collar 22 % wider, from inside the plate to just above the jewel's base.
        n = self.n(12)
        bez = lambda f_, lift: [_add(c, _add(_mul(nrm, lift), _add(_mul(u, ru * f_ * math.cos(2 * math.pi * i / n)),  # noqa: E731
                                                                    _mul(v, rv * f_ * math.sin(2 * math.pi * i / n))))) for i in range(n)]
        self.rings3([bez(1.22, -sink), bez(1.22, 0.003), bez(1.04, 0.005)], BA, bone)


def _add(a, b) -> tuple:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def _sub(a, b) -> tuple:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _mul(a, k: float) -> tuple:
    return (a[0] * k, a[1] * k, a[2] * k)


def _dot(a, b) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a, b) -> tuple:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _unit(a) -> tuple:
    n = math.sqrt(_dot(a, a))
    return _mul(a, 1.0 / n)


def interp(table: list, z: float) -> tuple:
    """Station (z, cx, cy, rx, front, back, p) at height z, linear between stations, clamped at the ends."""
    if z <= table[0][0]:
        return (z, *table[0][1:])
    for a, b in zip(table, table[1:]):
        if z <= b[0]:
            f = (z - a[0]) / (b[0] - a[0])
            return (z, *(x + (y - x) * f for x, y in zip(a[1:], b[1:])))
    return (z, *table[-1][1:])


def vsec(st: tuple, a: float, off: float = 0.0, s: int = 1) -> tuple:
    """Point of a station's superellipse at angle a (radians from +Y toward s * X), pushed out by off."""
    z, cx, cy, rx, front, back, p = st
    sn, cs = math.sin(a), math.cos(a)
    return (cx + s * (rx + off) * math.copysign(abs(sn) ** (2 / p), sn),
            cy + ((front if cs >= 0 else back) + off) * math.copysign(abs(cs) ** (2 / p), cs), z)


def vsurf(table: list, z: float, a_deg: float, off: float = 0.0, s: int = 1) -> tuple:
    return vsec(interp(table, z), math.radians(a_deg), off, s)


def vnormal(table: list, z: float, a_deg: float) -> tuple:
    """Outward horizontal normal of a vloft surface (finite difference along the section)."""
    tng = _sub(vsurf(table, z, a_deg + 2), vsurf(table, z, a_deg - 2))
    return _unit((-tng[1], tng[0], 0.0))


# Measured on sentry-sheet-1 (Pillow grid, 1.96 m over 902 px, 2.17 mm/px; see the pass-1 notes).
# Stations: (z, cx, cy, rx, front, back, p).
CUIRASS = [(1.335, 0, 0, 0.120, 0.105, 0.090, 2.4), (1.38, 0, 0, 0.150, 0.130, 0.100, 2.4), (1.45, 0, 0, 0.166, 0.142, 0.110, 2.4),
           (1.52, 0, 0, 0.170, 0.140, 0.115, 2.4), (1.58, 0, 0, 0.168, 0.128, 0.114, 2.6), (1.635, 0, 0, 0.150, 0.105, 0.104, 2.8),
           (1.67, 0, 0, 0.105, 0.070, 0.085, 2.6)]  # pass 2: a broad yoke under the pauldrons, not an egg top
WAIST = [(1.10, 0, 0, 0.115, 0.095, 0.095, 2.2), (1.18, 0, 0, 0.100, 0.090, 0.090, 2.2), (1.27, 0, 0, 0.098, 0.090, 0.090, 2.2),
         (1.345, 0, 0, 0.110, 0.095, 0.095, 2.2)]
PELVIS = [(0.93, 0, 0, 0.095, 0.070, 0.075, 2.3), (1.00, 0, 0, 0.135, 0.090, 0.090, 2.3), (1.08, 0, 0, 0.140, 0.095, 0.095, 2.3),
          (1.14, 0, 0, 0.120, 0.092, 0.092, 2.3)]
# Head (pass 2): one narrow faceless mask, taller (0.27 m) than wide (0.19 m at z 1.84), tapering to a
# pointed chin pushed forward at z 1.69 (sheet-1 front and side views). No dome, visor bar or chin block.
HEAD = [(1.690, 0, 0.050, 0.010, 0.012, 0.010, 2.0), (1.715, 0, 0.038, 0.032, 0.040, 0.036, 2.0), (1.75, 0, 0.022, 0.060, 0.074, 0.068, 2.2),
        (1.79, 0, 0.008, 0.080, 0.094, 0.090, 2.2), (1.84, 0, 0, 0.095, 0.104, 0.102, 2.2), (1.89, 0, -0.004, 0.092, 0.100, 0.102, 2.2),
        (1.925, 0, -0.006, 0.076, 0.084, 0.088, 2.1), (1.95, 0, -0.006, 0.048, 0.054, 0.058, 2.0), (1.9612, 0, -0.006, 0.010, 0.012, 0.012, 2.0)]
ARM_FLARE = 0.028  # forearm and gauntlet offset outward from their bones (m)


# Knee (pass 2): the hinge, the knee cop and the facing ends of cuisse and greave are centred on the shin
# bone's head, the knee pivot. A cylinder about the pivot's X axis looks the same at every bend, and both
# shells end inside it (every end-ring point closer to the axis than KNEE_R), so no bend opens a gap.
KNEE_Z, KNEE_R = 0.56, 0.066


def leg_tables(s: int) -> tuple[list, list]:
    # Cuisse: tapered from a wide hip (0.20 m at z 1.02) to the knee, ending at z 0.575 inside the hinge.
    cuisse = [(0.575, s * 0.120, 0, 0.058, 0.060, 0.056, 2.2), (0.66, s * 0.120, 0, 0.066, 0.070, 0.064, 2.2),
              (0.80, s * 0.118, 0, 0.078, 0.086, 0.078, 2.2), (0.92, s * 0.115, 0, 0.090, 0.098, 0.090, 2.2),
              (1.02, s * 0.115, 0, 0.098, 0.100, 0.095, 2.2)]
    # Greave with the calf swell behind (side view: back half-depth 0.105 at z 0.42 against 0.05 at the ankle),
    # its top ring at z 0.585 inside the hinge.
    greave = [(0.13, s * 0.12, 0, 0.044, 0.035, 0.050, 2.2), (0.22, s * 0.12, 0, 0.047, 0.038, 0.064, 2.2),
              (0.32, s * 0.12, 0, 0.058, 0.050, 0.088, 2.2), (0.42, s * 0.12, 0, 0.068, 0.066, 0.105, 2.2),
              (0.50, s * 0.12, 0, 0.064, 0.072, 0.086, 2.2), (0.585, s * 0.12, 0, 0.054, 0.056, 0.054, 2.2)]
    return cuisse, greave


def arm_tables(s: int) -> tuple[list, list]:
    ux = lambda z: s * (0.25 + 0.02 * (1.51 - z) / 0.31)  # noqa: E731  upperarm bone axis
    upper = [(1.22, ux(1.22), 0, 0.036, 0.036, 0.036, 2.0), (1.50, ux(1.50), 0, 0.038, 0.038, 0.038, 2.0)]
    # Vambrace: one shell wrapped round the forearm, tapering from the elbow flare to the wrist.
    fore = [(0.92, s * 0.289, 0.019, 0.044, 0.046, 0.042, 2.3), (1.02, s * 0.282, 0.012, 0.052, 0.053, 0.048, 2.3),
            (1.12, s * 0.276, 0.006, 0.060, 0.059, 0.054, 2.3), (1.175, s * 0.273, 0.003, 0.064, 0.062, 0.057, 2.3)]
    return upper, fore


def build_parts(b: Builder) -> None:
    S = b.segment
    # Head: one narrow brass mask (HEAD) with a brow ridge over the eyes, flat cheek planes from the eyes to
    # the pointed chin and a forehead seam. The eye slits sit in dark gunmetal sockets flush on the mask, so
    # they read as cut into it; the amber slits stay two glow islands.
    b.vloft(HEAD, BP, "head", n=b.n(18))
    b.vplate(HEAD, 1.842, 1.864, -62.0, 62.0, 0.006, 0.010, BP, "head", nu=b.n(10), nv=1, crown=0.004)  # brow ridge
    b.vplate(HEAD, 1.868, 1.945, -2.5, 2.5, 0.003, 0.006, BA, "head", nu=1, nv=3, crown=0.003)  # forehead seam
    for s in (1, -1):
        b.vplate(HEAD, 1.705, 1.805, lambda z, s=s: s * (4.0 + (z - 1.705) * 60.0), lambda z, s=s: s * (34.0 + (z - 1.705) * 300.0),
                 0.004, 0.008, BP, "head", nu=2, nv=2, smooth=False)  # cheek plane
        b.vplate(HEAD, 1.809, 1.838, s * 7.0, s * 38.0, 0.0015, 0.006, GM, "head", nu=b.n(4), nv=1)  # eye socket
        b.vplate(HEAD, 1.815, 1.832, s * 10.0, s * 34.0, 0.004, 0.006, GL, "head", nu=b.n(4), nv=1)  # eye slit
    # Neck: gunmetal column, brass collar and four exposed pistons under the jaw.
    S((0, 0, 1.56), (0, 0, 1.745), 0.028, 0.026, GM, "neck")
    S((0, 0, 1.62), (0, 0, 1.635), 0.040, 0.040, BA, "neck")
    for x, y0, y1 in ((0.035, -0.03, -0.045), (-0.035, -0.03, -0.045), (0.045, 0.005, -0.008), (-0.045, 0.005, -0.008)):
        S((x, y0, 1.60), (x * 0.9, y1, 1.75), 0.009, 0.009, GM, "neck", sides=6)
    # Chest: a deep cuirass (0.34 m wide, 0.25 to 0.26 deep) under faceted pectoral plates (two flat-shaded
    # overlapping rows a side), brass-aged ridges framing the core and a sternum ridge above it, and a belly
    # plate; the hexagonal amber core in a brass-aged bezel; back plate and cog.
    b.vloft(CUIRASS, BP, "chest", n=b.n(20))
    for s in (1, -1):
        b.vplate(CUIRASS, 1.43, 1.545, 24.0 * s, 80.0 * s, 0.012, 0.010, BP, "chest", nu=4, nv=2, crown=0.006, smooth=False)  # lower pectoral
        b.vplate(CUIRASS, 1.53, 1.645, 24.0 * s, 84.0 * s, 0.022, 0.010, BP, "chest", nu=4, nv=2, crown=0.008, smooth=False)  # upper pectoral
        b.vplate(CUIRASS, 1.40, 1.635, 19.0 * s, 25.0 * s, 0.026, 0.012, BA, "chest", nu=2, nv=4, crown=0.004, smooth=False)  # core frame
    b.vplate(CUIRASS, 1.53, 1.665, -4.0, 4.0, 0.024, 0.012, BA, "chest", nu=2, nv=3, crown=0.006, smooth=False)  # sternum ridge
    b.vplate(CUIRASS, 1.335, 1.41, -78.0, 78.0, 0.014, 0.012, BP, "chest", nu=b.n(10), nv=2, crown=0.004)  # belly plate
    front = vsurf(CUIRASS, 1.46, 0.0)[1]
    b.hexplate((0, front - 0.012, 1.46), "+Y", 0.064, 0.030, BA, "chest")
    b.hexplate((0, front + 0.008, 1.46), "+Y", 0.040, 0.022, GL, "chest")
    belly = vsurf(CUIRASS, 1.385, 0.0, 0.014)[1]  # the lower lamp under the core (sheet-1 front view)
    b.hexplate((0, belly - 0.008, 1.385), "+Y", 0.024, 0.014, BA, "chest")
    b.hexplate((0, belly - 0.002, 1.385), "+Y", 0.016, 0.016, GL, "chest")
    # Back plate behind the cog: curved on the cuirass (a flat box read as one pale tile in the back view).
    b.vplate(CUIRASS, 1.35, 1.55, 148.0, 212.0, 0.012, 0.016, BA, "chest", nu=b.n(8), nv=3, crown=0.004)
    b.gear((0, -0.122, 1.44), "-Y", 0.075, 0.092, 12, 0.025, BA, "cog")
    S((0, -0.122, 1.44), (0, -0.157, 1.44), 0.03, 0.022, GM, "cog", sides=6)  # hub
    # Spine: the pinched gunmetal waist (0.196 m at z 1.27: waist / shoulder 0.30) with four ribs and the lit
    # amber channel down its front as four cells (one glow island each, so each gets its own hot centre).
    b.vloft(WAIST, GM, "spine")
    for z in (1.148, 1.188, 1.228, 1.268):
        st = interp(WAIST, z + 0.007)
        rib = (st[0], 0, 0, st[3] + 0.012, st[4] + 0.012, st[5] + 0.012, 2.2)
        b.vloft([(z, *rib[1:]), (z + 0.014, *rib[1:])], GM, "spine")
    for z in (1.175, 1.215, 1.255, 1.295):
        b.box((0, interp(WAIST, z)[4] + 0.006, z), (0.016, 0.016, 0.024), GL, "spine")
    # Hips: gunmetal pelvis, brass-aged belt and a pointed front plate.
    b.vloft(PELVIS, GM, "hips")
    b.vloft([(1.085, 0, 0, 0.150, 0.105, 0.105, 2.6), (1.125, 0, 0, 0.142, 0.100, 0.100, 2.6)], BA, "hips")
    b.vplate(PELVIS, 0.95, 1.19, lambda z: -(10 + (z - 0.95) / 0.24 * 40), lambda z: 10 + (z - 0.95) / 0.24 * 40, 0.018, 0.012, BP, "hips",
             nu=b.n(6), nv=3, crown=0.004)
    for s, n in ((1, "R"), (-1, "L")):
        cuisse, greave = leg_tables(s)
        upper, fore = arm_tables(s)
        # Pauldron (clavicle): three layered shells, each lower one wider and further out (overlapping
        # shingles), flat-shaded into angular facets, each with a rolled brass-aged lip at its lower edge.
        # The cap is low (rz 0.072) rather than a near-sphere. Outer edge x 0.319 (the cap lip): shoulder span
        # 0.64 m (concept 0.62 to 0.65; pass 1 0.648, which the reviewer read as 0.33 of height against 0.31).
        pc = (s * 0.230, -0.010, 1.535)
        b.sphere((s * 0.245, 0, 1.51), 0.050, GM, f"upperarm.{n}")
        b.dome(pc, (0.086, 0.112, 0.072), s, (0.0, 360.0), (-12.0, 90.0), 0.012, BP, f"clavicle.{n}", nu=b.n(10), nv=b.n(4), smooth=False)
        b.dome(pc, (0.090, 0.118, 0.078), s, (-100.0, 100.0), (-20.0, -8.0), 0.016, BA, f"clavicle.{n}", nu=b.n(10), nv=1)  # lip
        b.dome(pc, (0.090, 0.120, 0.086), s, (-85.0, 85.0), (-38.0, -14.0), 0.010, BP, f"clavicle.{n}", nu=b.n(8), nv=2, smooth=False)
        b.dome(pc, (0.095, 0.125, 0.091), s, (-85.0, 85.0), (-42.0, -33.0), 0.014, BA, f"clavicle.{n}", nu=b.n(8), nv=1)  # lip
        b.dome(pc, (0.096, 0.126, 0.098), s, (-75.0, 75.0), (-58.0, -36.0), 0.010, BP, f"clavicle.{n}", nu=b.n(8), nv=2, smooth=False)
        b.dome(pc, (0.101, 0.131, 0.103), s, (-75.0, 75.0), (-62.0, -53.0), 0.014, BA, f"clavicle.{n}", nu=b.n(8), nv=1)  # lip
        # Upper arm: gunmetal tube, an outer brass plate and its jewel (sheet-1 back view).
        b.vloft(upper, GM, f"upperarm.{n}", n=b.n(10))
        b.vplate(upper, 1.28, 1.46, 25.0 * s, 160.0 * s, 0.016, 0.012, BP, f"upperarm.{n}", s=1, nu=b.n(7), nv=3, crown=0.004)
        c = vsurf(upper, 1.37, 130.0 * s, 0.016)  # outer-back: shows in the back and side views
        b.jewel(c, vnormal(upper, 1.37, 130.0 * s), (0, 0, 1), 0.048, 0.033, 0.014, f"upperarm.{n}", sink=0.022)  # 1.7x pass-1 area
        # Elbow: ribbed gunmetal hinge; forearm: one wrapped brass vambrace with brass-aged rims at the elbow
        # flare and the wrist and a panel band between them.
        # Forearm and gauntlet sit ARM_FLARE further out than their bones (the concept's arms flare past
        # the pauldrons), which clears the vambrace of the thigh plate and its jewel.
        v_arm = len(b.bm.verts)
        b.xcyl((0, 0, 1.205), 0.040, s * 0.225, s * 0.315, GM, f"forearm.{n}")
        for x in (0.238, 0.302):
            b.xcyl((0, 0, 1.205), 0.045, s * (x - 0.004), s * (x + 0.004), GM, f"forearm.{n}")
        S((s * 0.27, 0, 1.20), (s * 0.29, 0.02, 0.90), 0.024, 0.022, GM, f"forearm.{n}", sides=b.n(8))
        b.vloft(fore, BP, f"forearm.{n}", n=b.n(14))
        for z0, z1 in ((0.92, 0.938), (1.045, 1.058), (1.157, 1.175)):  # rims and the panel band
            st = interp(fore, (z0 + z1) / 2)
            band = (st[1], st[2], st[3] + 0.004, st[4] + 0.004, st[5] + 0.004, st[6])
            b.vloft([(z0, *band), (z1, *band)], BA, f"forearm.{n}", n=b.n(14))
        # Gauntlet: wrist ball, cuff, palm and four two-joint fingers plus a thumb, the hand plane turned
        # 40 deg (thumb inward) so the front view reads about 0.10 m wide (concept 0.05 of height).
        b.sphere((s * 0.29, 0.02, 0.90), 0.027, GM, f"hand.{n}")
        th = math.radians(40.0)
        w, tv = (-s * math.sin(th), math.cos(th), 0.0), (s * math.cos(th), math.sin(th), 0.0)
        hx = lambda z, s=s: (s * (0.29 + 0.01 * (0.90 - z) / 0.16), 0.02 + 0.01 * (0.90 - z) / 0.16, z)  # noqa: E731  hand bone axis
        b.frame_loft(hx, w, tv, [(0.875, 0.050, 0.036, 2.4), (0.925, 0.052, 0.038, 2.4)], BA, f"hand.{n}")
        b.frame_loft(hx, w, tv, [(0.795, 0.040, 0.020, 2.6), (0.835, 0.047, 0.025, 2.6), (0.878, 0.044, 0.023, 2.6)], BP, f"hand.{n}")
        hp = lambda z, u, v, hx=hx, w=w, tv=tv: _add(hx(z), _add(_mul(w, u), _mul(tv, v)))  # noqa: E731
        for u, tip in ((-0.031, 0.712), (-0.011, 0.700), (0.010, 0.697), (0.030, 0.706)):
            k0, k1, k2 = hp(0.805, u, 0.002), hp(0.752, u * 1.1, -0.006), hp(tip, u * 1.15, -0.020)
            S(k0, k1, 0.0105, 0.0095, BP, f"hand.{n}", sides=b.n(6))
            S(k1, k2, 0.0092, 0.0070, BP, f"hand.{n}", sides=b.n(6))
        t0, t1, t2 = hp(0.855, 0.044, -0.004), hp(0.812, 0.064, -0.018), hp(0.775, 0.068, -0.030)
        S(t0, t1, 0.012, 0.010, BP, f"hand.{n}", sides=b.n(6))
        S(t1, t2, 0.010, 0.008, BP, f"hand.{n}", sides=b.n(6))
        b.bm.verts.ensure_lookup_table()
        for v in b.bm.verts[v_arm:]:
            v.co.x += s * ARM_FLARE
        # Leg: hip ball; cuisse tapered from a 0.20 m hip to the knee, faced with two overlapping front lames
        # (the upper one's lower edge laps the lower one) each with a bevelled centre ridge, an outer plate
        # wrapping the hip and the faceted thigh jewel (sheet-1 side view, z 1.0); the ribbed gunmetal knee
        # hinge on the pivot axis under a brass-aged knee cop; greave with the calf swell, a front plate and
        # its ridge; long pointed sabaton (0.32 m) with a brass-aged toe cap.
        kc = (s * 0.12, 0, KNEE_Z)
        b.sphere((s * 0.11, 0, 1.0), 0.058, GM, f"thigh.{n}")
        b.vloft(cuisse, BP, f"thigh.{n}", n=b.n(16))
        b.vplate(cuisse, 0.655, 0.82, -50.0, 50.0, 0.012, 0.010, BP, f"thigh.{n}", nu=b.n(6), nv=3, crown=0.004)  # lower lame
        b.vplate(cuisse, 0.80, 0.99, -42.0, 42.0, 0.022, 0.010, BP, f"thigh.{n}", nu=b.n(6), nv=3, crown=0.004)  # upper lame
        b.vplate(cuisse, 0.665, 0.81, -8.0, 8.0, 0.016, 0.006, BP, f"thigh.{n}", nu=2, nv=3, crown=0.006, smooth=False)  # ridge
        b.vplate(cuisse, 0.815, 0.98, -8.0, 8.0, 0.026, 0.006, BP, f"thigh.{n}", nu=2, nv=3, crown=0.006, smooth=False)  # ridge
        b.vplate(cuisse, 0.90, 1.13, 45.0 * s, 150.0 * s, 0.018, 0.010, BP, f"thigh.{n}", nu=b.n(8), nv=3, crown=0.0)
        # Outer-back (120 deg): behind the hanging forearm in the side view and visible from the back. Sized to
        # the concept's outer-thigh jewel (0.14 x 0.09 m): 0.15 x 0.10, 1.5x the pass-1 stone.
        c = vsurf(cuisse, 0.98, 120.0 * s, 0.018)
        b.jewel(c, vnormal(cuisse, 0.98, 120.0 * s), (0, 0, 1), 0.075, 0.050, 0.022, f"thigh.{n}", sink=0.035)
        # Knee cop on the thigh: a shell in front of the hinge whose inner face stays outside the greave's
        # swept radius, so bending never pushes the shin through it.
        b.dome((s * 0.12, 0, 0.585), (0.110, 0.098, 0.100), s, (45.0, 135.0), (-25.0, 62.0), 0.012, BA, f"thigh.{n}", nu=b.n(8), nv=b.n(4))
        b.xcyl(kc, KNEE_R, s * 0.055, s * 0.185, GM, f"shin.{n}")
        for x in (0.082, 0.12, 0.158):
            b.xcyl(kc, KNEE_R + 0.005, s * (x - 0.006), s * (x + 0.006), GM, f"shin.{n}")
        b.vloft(greave, BP, f"shin.{n}", n=b.n(16))
        b.vplate(greave, 0.17, 0.50, -60.0, 60.0, 0.010, 0.010, BP, f"shin.{n}", nu=b.n(6), nv=3, crown=0.004)  # front plate
        b.vplate(greave, 0.19, 0.49, -8.0, 8.0, 0.014, 0.006, BP, f"shin.{n}", nu=2, nv=3, crown=0.006, smooth=False)  # ridge
        b.sphere((s * 0.12, 0, 0.11), 0.034, GM, f"foot.{n}")
        b.yloft([(-0.075, s * 0.12, 0.040, 0.075, 2.6), (-0.03, s * 0.12, 0.050, 0.105, 2.6), (0.03, s * 0.12, 0.052, 0.095, 2.6),
                 (0.10, s * 0.12, 0.048, 0.065, 2.6), (0.17, s * 0.12, 0.036, 0.040, 2.6), (0.215, s * 0.12, 0.018, 0.020, 2.6),
                 (0.24, s * 0.12, 0.004, 0.006, 2.6)], BP, f"foot.{n}")
        b.yloft([(0.06, s * 0.12, 0.056, 0.088, 2.6), (0.10, s * 0.12, 0.052, 0.073, 2.6), (0.17, s * 0.12, 0.040, 0.048, 2.6),
                 (0.215, s * 0.12, 0.022, 0.028, 2.6), (0.245, s * 0.12, 0.006, 0.010, 2.6)], BA, f"foot.{n}")


def tile_uvs(bm) -> None:
    """UV0 in tile units: each face projected onto the plane of its dominant normal axis (brass: FLAT_BRASS_UV)."""
    uv = bm.loops.layers.uv.new("tile")
    for f in bm.faces:
        if FLAT_BRASS and f.material_index in (BP, BA):
            for loop in f.loops:
                loop[uv].uv = FLAT_BRASS_UV[MATS[f.material_index]]
            continue
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        u_i, v_i = [(1, 2), (0, 2), (0, 1)][ax]
        for loop in f.loops:
            co = loop.vert.co
            loop[uv].uv = (co[u_i] / TILE_METERS, co[v_i] / TILE_METERS)


def build_body(bpy, bmesh, scene, detail: str, arm_obj) -> object:
    b = Builder(bmesh, detail)
    build_parts(b)
    # COLOR_0: gunmetal and the jewel hues on the white gunmetal slot, white on every other corner.
    col = b.bm.loops.layers.float_color.new("tint")
    shade = {GM: (*(srgb_to_linear(c) for c in GM_SRGB), 1.0)}
    shade.update({JW + i: (*(srgb_to_linear(c) for c in rgb), 1.0) for i, rgb in enumerate(JEWEL_SRGB)})
    for f in b.bm.faces:
        rgba = shade.get(f.material_index, (1.0, 1.0, 1.0, 1.0))
        for loop in f.loops:
            loop[col] = rgba
        if f.material_index >= JW:
            f.material_index = GM
    # Mirrored and plate parts are built without regard to winding; make every closed part face out.
    bmesh.ops.recalc_face_normals(b.bm, faces=b.bm.faces[:])
    # Triangulate here with fixed rules: the exporter's own quad split follows the shorter
    # diagonal of the evaluated mesh, which flips between runs on float noise (GLB not byte-stable).
    bmesh.ops.triangulate(b.bm, faces=b.bm.faces[:], quad_method="FIXED", ngon_method="EAR_CLIP")
    b.bm.normal_update()
    tile_uvs(b.bm)
    me = bpy.data.meshes.new(f"sentry-body-{detail}")
    b.bm.to_mesh(me)
    b.bm.free()
    # Smooth curved plates, hard plate edges and caps (flat-flagged faces, the jewel facets, stay flat).
    me.set_sharp_from_angle(angle=math.radians(38))
    me.color_attributes.active_color_name = "tint"
    me.color_attributes.render_color_index = me.color_attributes.active_color_index
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
        if name == "gunmetal":
            vertex_color_base(mat, bsdf)
        mat.use_backface_culling = True  # closed parts: export single-sided, half the fragment work
        out.append(mat)
    return out


def vertex_color_base(mat, bsdf) -> None:
    """Gunmetal and jewel hues from the corner colours (exported as COLOR_0), as on the spring hound."""
    attr = mat.node_tree.nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "tint"
    mat.node_tree.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])


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
        if name == "gunmetal":
            vertex_color_base(mat, bsdf)
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
            base = texs["basecolor"].outputs["Color"]
            if name in TINTS:  # the runtime slot tint, so review renders show the shipped colour
                mul = nt.nodes.new("ShaderNodeVectorMath")
                mul.operation = "MULTIPLY"
                mul.inputs[1].default_value = TINTS[name]
                nt.links.new(base, mul.inputs[0])
                base = mul.outputs["Vector"]
            nt.links.new(base, bsdf.inputs["Base Color"])
            sep = nt.nodes.new("ShaderNodeSeparateColor")
            nt.links.new(texs["orm"].outputs["Color"], sep.inputs["Color"])
            nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
            nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
            nm = nt.nodes.new("ShaderNodeNormalMap")
            nm.uv_map = "tile"
            nm.inputs["Strength"].default_value = NORMAL_SCALE[name]
            nt.links.new(texs["normal"].outputs["Color"], nm.inputs["Color"])
            if not FLAT_BRASS:  # one texel has no tangent frame; the runtime shows no brass normal map either
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
    "socket-hit": ("chest", (0, 0.19, 1.46)),  # in front of the amber core: hit sparks and aim point
    "socket-eye": ("head", (0, 0.118, 1.824)),  # between the eye slits, in front of the mask
    "socket-weapon": ("hand.R", (0.30 + ARM_FLARE, 0.03, 0.78)),  # the striking claw
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
        # ACTIVE, not MATERIAL: Blender 5.2 MATERIAL mode writes a white COLOR_0 placeholder and moves the
        # layer to COLOR_1, which three.js ignores (the spring hound's finding).
        export_vertex_color="ACTIVE",  # COLOR_0 for the gunmetal slot (white on every other corner)
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


def canonicalize_normals(path: Path, quantum: float | None = NORMAL_QUANTUM) -> int:
    """Snaps every primitive's NORMAL to a `quantum` grid and renormalizes it, in place (same layout and
    length). A run-dependent 1e-4 step in an exported normal (pass 1) lands on the same grid point except
    near a cell boundary (offline: about 0.85 % of noisy vertices at 1/128). Not idempotent (renormalized
    values sit off the grid): run it exactly once per export. Returns accessors touched."""
    import numpy as np

    if not quantum:
        return 0
    data = bytearray(path.read_bytes())
    jlen = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20 : 20 + jlen])
    bin_start = 28 + jlen
    done: set[int] = set()
    for mesh in gltf["meshes"]:
        for prim in mesh["primitives"]:
            i = prim["attributes"].get("NORMAL")
            if i is None or i in done:
                continue
            done.add(i)
            acc = gltf["accessors"][i]
            view = gltf["bufferViews"][acc["bufferView"]]
            assert acc["componentType"] == 5126 and acc["type"] == "VEC3", "NORMAL must be float VEC3"
            stride = view.get("byteStride", 12)
            start = bin_start + view.get("byteOffset", 0) + acc.get("byteOffset", 0)
            for k in range(acc["count"]):
                o = start + k * stride
                n = np.round(np.frombuffer(bytes(data[o : o + 12]), dtype="<f4").astype(np.float64) / quantum) * quantum
                n /= max(float(np.linalg.norm(n)), 1e-12)
                data[o : o + 12] = n.astype("<f4").tobytes()
    path.write_bytes(bytes(data))
    return len(done)


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
    if any("COLOR_1" in p["attributes"] for p in prims):
        errors.append("COLOR_1 exported (three.js reads only COLOR_0)")
    if not any("COLOR_0" in p["attributes"] for p in prims if mats[p["material"]] == "gunmetal"):
        errors.append("gunmetal primitive without COLOR_0 (its gunmetal and jewel hues)")
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
            "brass-polished": {"set": "brass-polished", "tileMeters": TILE_METERS, "normalScale": NORMAL_SCALE["brass-polished"],
                               **({"tint": TINTS["brass-polished"]} if "brass-polished" in TINTS else {})},
            "brass-aged": {"set": "brass-aged", "tileMeters": TILE_METERS, "normalScale": NORMAL_SCALE["brass-aged"],
                           **({"tint": TINTS["brass-aged"]} if "brass-aged" in TINTS else {})},
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
    report["canonicalized_normals"] = {"accessors": canonicalize_normals(glb), "quantum": NORMAL_QUANTUM}
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
