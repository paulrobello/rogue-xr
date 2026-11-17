"""P5-T3 Bellows Golem: a squat, broad brass-and-walnut automaton (concept assets-source/concepts/
golem-sheet-1.png, notes assets-source/concepts/p5-automatons-design.md, style docs/art-bible.md),
built procedurally as rigid plated parts, each weighted 1.0 to one bone of a 22-bone armature, with
the five automaton clips of the Cog Sentry contract (P4-T6): idle (loop, the bellows pumping),
attack (the two-fist crush), hit, death (one-shot, ends lying prone) and frozen (the held mid-step
pose of the time freeze). The silhouette follows the sheet: domed, overhanging shoulder pauldrons, long gorilla
arms with big brass forearm cylinders and huge clenched mitt fists hanging to the shins, a walnut
stave barrel over a tapering pleated bellows, two chimneys and a capsule head rising out of a collar
bezel. The vent intent is modeled as glowing chimney mouths (an ember dome in each) only, with no
flame or smoke geometry (design notes, art bible).

Exported as an image-free skinned GLB. The brass-polished slot carries the name of the shared
P4-T3 tileable set (`public/assets/materials/`), so the runtime binds it by name; UV0 is in tile
units (metres / tileMeters). The other three slots are factor-only: golem-case (white base, its hue
from the COLOR_0 vertex colours: walnut staves, walnut pleats, the barrel interior),
golem-metal (white base, COLOR_0: gunmetal joints and the emerald inlays) and golem-glow (the chest
and back grilles, the eyes and the chimney mouths). The walnut is factor-only because the shared
walnut set renders about 1.6x too light against the art bible's #583C26. After export the GLB's
triangle order and NORMALs are canonicalized (sort_triangles, canonicalize_normals) because the
exporter's are run-dependent, so rebuilds are byte-identical. The manifest uses the sentry's schema
plus an optional `cull` sphere measured over every clip frame.

Blender run (build, pose checks, export, reimport gate, manifest, renders, .blend sources):
    "$BLENDER" -b --factory-startup --python-exit-code 1 -P scripts/assets/build-bellows-golem.py -- \
        [--out assets-source/enemies/bellows-golem/staging] [--runtime public/assets/enemies/bellows-golem] \
        [--blend-dir assets-source/enemies/bellows-golem/blend] [--skip-renders] [--compare-only]
Review sheet and fidelity compare, then the author fidelity record (system Python with Pillow,
after the Blender run, the engine shots and the hand-written staging/fidelity.json):
    python3 -I scripts/assets/build-bellows-golem.py --sheet [--out ...]
    python3 -I scripts/assets/asset-check.py --assemble-enemy bellows-golem
    python3 -I scripts/assets/build-bellows-golem.py --record-fidelity [--out ...]

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
import subprocess
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
# Concept panels in sheet pixels (2752x1536): front, side, back (top row), centred on each figure.
CONCEPT_CROPS = {"front": (99, 40, 1099, 924), "side": (1105, 40, 1695, 924), "back": (1700, 40, 2700, 924)}
FPS = 30
HEIGHT_RANGE = (2.0, 2.2)  # metres to the chimney mouths, rest pose (design notes: about 2.1 m)
DEATH_MAX_Z = 1.5  # lying on its back: the barrel is 1.1 m deep and the pauldrons and forward fists stand proud

LIMITS = {"tris": 25_000, "materials": 4, "bones": 40, "influences": 4}
GLOW = "golem-glow"
CASE = "golem-case"  # factor-only, hue from COLOR_0: walnut staves, pleats, barrel interior
METAL = "golem-metal"  # factor-only, hue from COLOR_0: gunmetal joints, emerald inlays
MATS = ["brass-polished", CASE, METAL, GLOW]
BP, CS, MT, GL = range(4)
# Pseudo slots: build_body maps 10-19 to CS and 20-29 to MT and writes the shade into COLOR_0.
WN1, WN2, WN3, WD, WN4, WN5 = 10, 11, 12, 14, 16, 17
WALNUT = (WN1, WN2, WN3, WN4, WN5)  # plank shades, picked per plank by an integer hash (no hash(): it is salted per process)
WP1, WP2 = 13, 15  # bellows pleats: about half the staves' value (sheet pleats V 0.17 under the lit barrel, V 0.30 to 0.36)
GM, EM, LN = 20, 21, 22  # LN: the dark glass lens on each shoulder plate's outer face
# Walnut about 0.75x the pass-3 sRGB (engine V 0.30 against the sheet's 0.22; the env specular floor limits how far albedo
# alone moves it). Pleats redder (engine hue 29, S 0.40 against the sheet's hue 15, S 0.47).
SHADES = {WN1: (0x1F, 0x0F, 0x04), WN2: (0x1B, 0x0D, 0x03), WN3: (0x23, 0x12, 0x05), WN4: (0x18, 0x0B, 0x03),
          WN5: (0x26, 0x13, 0x06), WD: (0x0E, 0x07, 0x04),
          WP1: (0x12, 0x05, 0x03), WP2: (0x0E, 0x04, 0x02),  # engine V 0.24 at (0x1E, 0x0F, 0x05), 0.20 at (0x10, 0x07, 0x03)
          GM: (0x3A, 0x38, 0x3A), EM: (0x0C, 0x8A, 0x3E), LN: (0x14, 0x16, 0x18)}
SETS = {"brass-polished": 0.06}  # shared set -> normal scale (0.35, then 0.15, still read as swirl noise at play distance)
TILE_METERS = 0.5  # the brass set tiles at 0.5 m (public/assets/materials/materials.json)
# The set's basecolor, roughness and metalness are flat (std under 2 of 255); its only strong variance is
# the ORM red channel, which the runtime binds as aoMap (src/world/materials.ts) and which scales nearly all
# of a metal's light. Tiled at 0.5 m it put one AO blotch on each small face: wood grain, olive knuckles,
# pale cream ends and the head swirl. Every brass face therefore samples one texel (a constant UV, so the
# normal map also drops out: zero UV derivatives). The texel is the centre of an 11 px AO-255 window at
# runtime row 198 (three flips the PNG/KTX2 rows, so runtime row = v * 1024); EEVEE reads row 825, where AO
# is unused. False restores the 0.5 m tiling.
FLAT_BRASS = True
FLAT_BRASS_UV = (566.5 / 1024, 198.5 / 1024)
# Linear multiplier on the bound set's colour (manifest slot `tint`, enemy-asset.ts bind()). 0.87 stands in
# for the tiled AO's mean (0.865) that the flat texel no longer applies; the green and blue cuts pull the idle
# forearm from hue 35, S 0.51 toward the sheet's hue 30, S 0.62.
TINTS = {"brass-polished": [0.87, 0.78, 0.62]}
FACTORS = {  # sRGB base, roughness, metallic: the GLB look, and the fallback when the set fails
    "brass-polished": ((0xDE, 0xC1, 0x6A), 0.3, 1.0),
    CASE: ((0xFF, 0xFF, 0xFF), 0.92, 0.0),  # hue from COLOR_0: oiled walnut, rough enough to keep env specular off
    METAL: ((0xFF, 0xFF, 0xFF), 0.38, 0.7),  # hue from COLOR_0: gunmetal and emerald
    # A dark, fairly rough base keeps the lit surface from adding white and washing the orange to peach.
    GLOW: ((0x3A, 0x14, 0x04), 0.5, 0.0),
}
GLOW_SRGB = (0xF0, 0x8C, 0x2C)
# Above the project's usual 0.7: the chest core is the golem's focal light (the sheet paints it
# yellow-hot). three.js AgX desaturates bright emission toward peach, so 1.0 is the compromise
# between reading lit and staying orange (about sRGB 204, 148, 94 on screen).
GLOW_STRENGTH = 1.0

# Armature: name, parent, head, tail (Blender metres). R is Blender +X.
SHOULDER = (0.66, 0.0, 1.50)  # on the pauldron drum's axle, so the drum turns in place as the arm pitches
ELBOW = (0.86, 0.02, 1.06)
WRIST = (0.92, 0.29, 0.53)
FIST_Y = 0.09  # the fists hang forward of the body, as on the side panel
HIP = (0.27, 0.0, 0.64)
KNEE = (0.32, 0.06, 0.36)
ANKLE = (0.33, 0.0, 0.12)
BONES: list[tuple[str, str | None, tuple, tuple]] = [
    ("root", None, (0, 0, 0), (0, 0, 0.2)),
    ("pelvis", "root", (0, 0, 0.66), (0, 0, 0.80)),
    ("spine", "pelvis", (0, 0, 0.80), (0, 0, 1.20)),
    ("bellows", "spine", (0, 0, 0.98), (0, 0, 1.18)),
    ("chest", "spine", (0, 0, 1.20), (0, 0, 1.80)),
    ("head", "chest", (0, 0.42, 1.83), (0, 0.42, 2.05)),  # pivots at the collar band centre, so the head turns inside it
]
for _s, _n in ((1, "R"), (-1, "L")):
    BONES += [
        (f"chimney.{_n}", "chest", (_s * 0.40, -0.12, 1.76), (_s * 0.44, -0.15, 2.10)),
        (f"clavicle.{_n}", "chest", (_s * 0.12, 0, SHOULDER[2]), (_s * 0.56, 0, SHOULDER[2])),
        (f"upperarm.{_n}", f"clavicle.{_n}", (_s * SHOULDER[0], SHOULDER[1], SHOULDER[2]), (_s * ELBOW[0], ELBOW[1], ELBOW[2])),
        (f"forearm.{_n}", f"upperarm.{_n}", (_s * ELBOW[0], ELBOW[1], ELBOW[2]), (_s * WRIST[0], WRIST[1], WRIST[2])),
        (f"hand.{_n}", f"forearm.{_n}", (_s * WRIST[0], WRIST[1], WRIST[2]), (_s * 0.93, 0.22 + FIST_Y, 0.20)),
        (f"thigh.{_n}", "pelvis", (_s * HIP[0], HIP[1], HIP[2]), (_s * KNEE[0], KNEE[1], KNEE[2])),
        (f"shin.{_n}", f"thigh.{_n}", (_s * KNEE[0], KNEE[1], KNEE[2]), (_s * ANKLE[0], ANKLE[1], ANKLE[2])),
        (f"foot.{_n}", f"shin.{_n}", (_s * ANKLE[0], ANKLE[1], ANKLE[2]), (_s * 0.33, 0.2, 0.04)),
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

DETAIL = {"low": 0.7, "high": 1.6}  # segment multiplier


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
    p.add_argument("--record-fidelity", action="store_true", help="copy staging/fidelity.json into provenance.json (system Python)")
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
        self.colored: list = []  # (faces, linear rgb) written into COLOR_0
        self.tally: list = []  # (section, cumulative triangles)

    def n(self, base: int) -> int:
        return max(3, int(round(base * self.k)))

    def _tag(self, verts, faces, mat: int, bone: str, color=None) -> None:
        # A case-slot shade stays a pseudo material index here (bevels copy the index onto the faces
        # they create); build_body turns it into the COLOR_0 hue on the CS slot.
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

    def loft(self, p0, p1, secs: list, mat: int, bone: str, color=None, n: int | None = None) -> None:
        """Sections [(f, rx, ry, p, cx, cy)] at fraction f along p0->p1 (local X ~ world X)."""
        m, length = axis_frame(p0, p1)
        n = n or self.n(20)
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

        u, v = segs or (self.n(14), self.n(8))
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

        n = n or self.n(32)
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

    def seam(self, p0, p1, radius, a: float, v0: float, v1: float, mat: int, bone: str, w: float = 0.016, n: int = 6) -> None:
        """Piping along a wrapped plate's edge: same axis, angle and radius conventions as wrap(),
        sunk so it covers the plate's edge face and stands just proud of its outer surface."""
        from mathutils import Vector

        m, length = axis_frame(p0, p1)
        aa = math.pi - a if (m.to_3x3() @ Vector((0, 1, 0))).y < -1e-6 else a
        f = lambda g, x: g(x) if callable(g) else g  # noqa: E731
        pts = [m @ Vector(((f(radius, v) - 0.003) * math.sin(aa), (f(radius, v) - 0.003) * math.cos(aa), v * length))
               for v in [v0 + (v1 - v0) * k / n for k in range(n + 1)]]
        self.sweep(pts, chamfer_rect(w, w), mat, bone, hint=tuple(m.to_3x3() @ Vector((math.sin(aa), math.cos(aa), 0.0))))

    def wrap(self, p0, p1, radius, a0, a1, t: float, mat: int, bone: str, v0=0.0, v1=1.0, nu: int | None = None,
             nv: int = 4, sx=1.0, sy=1.0, bevel=0.004, p: float = 2.0, color=None, crown: float = 0.0) -> None:
        """Bevelled plate of thickness t wrapped round the axis p0->p1: angle (radians from local +Y
        toward local +X) from a0 to a1 and axial fraction from v0 to v1. radius(v), a0(v), a1(v),
        v0(u), v1(u) may be callables, which shapes tapered, pointed and cut-out plates. `crown`
        bulges the plate's middle outward, so each plate carries its own highlight."""
        from mathutils import Vector

        m, length = axis_frame(p0, p1)
        f = lambda g, x: g(x) if callable(g) else g  # noqa: E731
        nu = nu or self.n(10)

        flip = (m.to_3x3() @ Vector((0, 1, 0))).y < -1e-6  # keep angle 0 on the world front for downward axes

        def pt(u: float, v: float, off: float):
            vv = f(v0, u) + (f(v1, u) - f(v0, u)) * v
            a = f(a0, vv) + (f(a1, vv) - f(a0, vv)) * u
            a = math.pi - a if flip else a
            r = f(radius, vv) + off + crown * math.sin(math.pi * u)
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

    def sweep(self, path: list, section: list, mat: int, bone: str, hint=(0, 0, 1), scales=None, color=None, hints=None) -> None:
        """Section [(u, v)] swept along a polyline; u runs along the path normal from `hint` (or per point from `hints`)."""
        from mathutils import Vector

        P = [Vector(p) for p in path]
        bm = self.bm
        rows = []
        for i, p in enumerate(P):
            t = (P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]).normalized()
            up = Vector(hints[i] if hints else hint)
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


def box(P: Parts, lo, hi, mat: int, bone: str, bevel=0.006) -> None:
    """Bevelled box from its min and max corners."""
    P.bbox(tuple((a + b) / 2 for a, b in zip(lo, hi)), tuple(b - a for a, b in zip(lo, hi)), mat, bone, bevel=bevel)


def xz_frame(y: float, flip: bool = False):
    """4x4 mapping an outline's local (x, y) to world (x, z) on the plane at depth y (normal +-Y)."""
    from mathutils import Matrix

    m = Matrix(((1, 0, 0, 0), (0, 0, -1 if flip else 1, y), (0, 1, 0, 0), (0, 0, 0, 1)))
    return m


def _sub(a, b) -> tuple:
    return tuple(x - y for x, y in zip(a, b))


def _m(p, s: int) -> tuple:
    """Mirror a right-side (+X) point to side s (+1 right, -1 left)."""
    return (s * p[0], p[1], p[2])


SY = 0.9  # barrel and bellows depth / width (the side panel's barrel is nearly round)
BARREL = (1.20, 1.94)  # stave span
PLEAT_Z = (0.77, 1.215)  # the top pleat stays under the barrel's bottom band through the 3.2 cm pump
PLEAT_RIDGE = (0.43, 0.52)  # bottom and top pleat ridge radius: the egg tapers through the ribs to the waist (sheet: +-0.44 at z 0.75)
PLEAT_DEPTH = 0.03  # ridge to valley
PLEATS = 6


def pleat_k(k: float) -> float:
    """Ridge radius of pleat k (0 bottom): a quarter ellipse, so the stack rounds in under the barrel like the
    bottom of the sheet's egg (0.43, 0.484, 0.502, 0.513, 0.518, 0.52) instead of a straight taper."""
    t = min(max(k, 0.0), PLEATS - 1) / (PLEATS - 1)
    return PLEAT_RIDGE[0] + (PLEAT_RIDGE[1] - PLEAT_RIDGE[0]) * math.sqrt(max(0.0, 1.0 - (1.0 - t) ** 2))


def pleat_ridge(z: float) -> float:
    """Ridge radius of the pleat at height z (pleat_k at the fractional pleat index, clamped to the stack)."""
    return pleat_k((z - PLEAT_Z[0]) / ((PLEAT_Z[1] - PLEAT_Z[0]) / PLEATS) - 0.5)


HEAD_C, HEAD_AX = (0, 0.385, 1.72), (0, 0.25, 1)  # head shell base and axis (tilted forward), Blender metres
# Head sections (h along HEAD_AX, half-width, half-depth, forward offset). Below h 0.16 it is the old
# capsule; above, the sections shift forward so the back keeps the old outline (the band clearance at the
# hit and death head pitch was +0.7 mm), while the front and sides grow into the taller capsule.
HEAD_SECS = [(0.0, 0.12, 0.12, 0.0), (0.08, 0.13, 0.13, 0.0), (0.16, 0.13, 0.13, 0.0), (0.22, 0.13, 0.124, 0.011),
             (0.27, 0.135, 0.113, 0.027), (0.31, 0.122, 0.095, 0.045), (0.348, 0.098, 0.077, 0.055), (0.375, 0.064, 0.054, 0.056),
             (0.395, 0.022, 0.02, 0.056)]


def head_r(h: float) -> float:
    """Head front distance from HEAD_AX at axial distance h (offset plus half-depth, linear between sections)."""
    pts = [(hh, cy + ry) for hh, _, ry, cy in HEAD_SECS]
    for (h0, r0), (h1, r1) in zip(pts, pts[1:]):
        if h0 <= h <= h1:
            return r0 + (r1 - r0) * (h - h0) / (h1 - h0)
    return pts[0][1] if h < 0 else pts[-1][1]


BARREL_WIDE = (1.47, 1.52)  # the egg's widest band; above it the pass-3 curl into the collar is unchanged


def barrel_r(z: float) -> float:
    """Stave radius across X at height z: widest (0.60) from 1.47 to 1.52 m, curling in to the head collar above
    and, below, a long egg taper that stays wide into the pleats (0.556 at the bottom band; was 0.518)."""
    if BARREL_WIDE[0] <= z <= BARREL_WIDE[1]:
        return 0.60
    d, k = ((z - BARREL_WIDE[0]) / 0.62, 0.75) if z < BARREL_WIDE[0] else ((z - BARREL_WIDE[1]) / 0.48, 0.85)
    return 0.60 * math.sqrt(max(0.0, 1.0 - k * d * d))


def strap_path(x: float, z0: float, z1: float, rfun, sign: int, off: float, n: int = 14) -> list:
    """Points on the (elliptical) barrel or bellows surface at fixed x, front (sign 1) or back (-1)."""
    out = []
    for i in range(n + 1):
        z = z0 + (z1 - z0) * i / n
        r = rfun(z)
        out.append((x, sign * (SY * math.sqrt(max(r * r - x * x, 0.0)) + off), z))
    return out


def grille(P: Parts, z: float, sign: int, ax: float, az: float, bars: list, bar: float = 0.045) -> None:
    """Round chest grille on the barrel front (sign 1) or back (-1): a dark iron housing set into the
    staves, a glowing core, brass bars and a brass bezel with riveted side tabs."""
    y = sign * SY * barrel_r(z)
    axis = (0, sign, 0)
    P.lathe((0, y - sign * 0.07, z), axis, [(1.0, 0.0), (1.0, 0.08)], GM, "chest", sx=ax * 0.96, sy=az * 0.96)
    P.lathe((0, y + sign * 0.006, z), axis, [(1.0, 0.0), (1.0, 0.012)], GL, "chest", sx=ax * 0.9, sy=az * 0.9)
    for x in bars:
        h = 2 * az * 0.9 * math.sqrt(max(0.0, 1 - (x / (ax * 0.9)) ** 2))
        P.bbox((x, y + sign * 0.024, z), (bar, 0.022, h), BP, "chest", bevel=0.007)
    P.band((0, y + sign * 0.022, z), axis, ax, 0.042, 0.052, BP, "chest", n=P.n(36), rb=az)
    for s in (1, -1):
        tx = s * (ax + 0.045)
        ty = sign * SY * math.sqrt(max(barrel_r(z) ** 2 - tx * tx, 0.0))
        P.bbox((tx, ty + sign * 0.006, z), (0.07, 0.03, 0.08), BP, "chest", bevel=0.01)
        P.ball((tx, ty + sign * 0.022, z), 0.013, BP, "chest", segs=(8, 5))


def mark(P: Parts, label: str) -> None:
    P.tally.append((label, sum(len(f.verts) - 2 for f in P.bm.faces)))


def build_parts(P: Parts) -> None:
    from mathutils import Matrix

    # Barrel: walnut staves in three shades over a dark interior, curling in to the head collar.
    z0, z1 = BARREL
    span = z1 - z0
    P.lathe((0, 0, z0 - 0.01), (0, 0, 1), [(barrel_r(z0 + span * f) - 0.03, 0.01 + span * f) for f in (0.0, 0.25, 0.5, 0.75, 0.97)],
            WD, "chest", sides=P.n(32), sy=SY)
    # Each stave is five planks with 8 mm horizontal joints onto the dark interior (the sheet's plank lines), and
    # each plank takes one of five shades from an integer hash, so the barrel reads as boards rather than one tone.
    staves, gap, planks, joint = 18, 0.018, 5, 0.008 / span
    for i in range(staves):
        a0 = 2 * math.pi * i / staves + gap / 2
        a1 = 2 * math.pi * (i + 1) / staves - gap / 2
        for j in range(planks):
            v0, v1 = j / planks + (joint / 2 if j else 0.0), (j + 1) / planks - (joint / 2 if j < planks - 1 else 0.0)
            P.wrap((0, 0, z0), (0, 0, z1), lambda v: barrel_r(z0 + span * v), a0, a1, 0.035, WALNUT[(i * 7 + j * 3 + i * j) % 5],
                   "chest", v0=v0, v1=v1, nu=2, nv=max(1, P.n(8) // 6), sy=SY, bevel=0.0, crown=0.007)
    # A strap rather than a ledge; its lower edge stays at today's 1.1875 so it still hides the pump slide.
    r = barrel_r(z0 + 0.012) + 0.006 + 0.015
    P.band((0, 0, z0 + 0.012), (0, 0, 1), r, 0.03, 0.05, BP, "chest", n=P.n(36), rb=SY * r)
    # The top band is a back arc only (angles from +X toward the +Y front), so it does not cross the face.
    r = barrel_r(1.905) + 0.006 + 0.014
    P.sweep_ring((0, 0, 1.905), (0, 0, 1), r, SY * r, chamfer_rect(0.028, 0.045), BP, "chest", n=P.n(36), arc=(130.0, 410.0))
    P.shell((0, 0, z1 - 0.02), (0, 0, 1), [(0.001, 0.0), (barrel_r(z1 - 0.02) - 0.01, 0.0), (0.26, 0.05), (0.001, 0.075)], WN2, "chest",
            sides=P.n(32), sy=SY)  # closed walnut crown under the collar
    # Arched back strap, bent into the sheet's arc: z 1.47 at the spine falling as cos(u)^2 to about 1.28
    # where it tucks under the pauldrons (sheet: 1.47 at the spine, about 1.32 at x +-0.5), swept along the
    # stave surface. Its radial centre is 1.0 cm out, so the 2.4 cm strap sinks 2 to 3 mm into the stave
    # edges and up to 9 mm at the stave crowns. Per-point meridian hints keep its thickness on the surface normal.
    path, hints = [], []
    for i in range(P.n(28) + 1):
        u = math.radians(190.0 + 160.0 * i / P.n(28))
        z = 1.47 - 0.20 * math.cos(u) ** 2
        r = barrel_r(z) + 0.010
        dr = (barrel_r(z + 0.01) - barrel_r(z - 0.01)) / 0.02
        path.append((r * math.cos(u), SY * r * math.sin(u), z))
        hints.append((dr * math.cos(u), SY * dr * math.sin(u), 1.0))  # the stave meridian: width along the sloping surface
    P.sweep(path, chamfer_rect(0.055, 0.024), BP, "chest", hints=hints)
    # Vertical straps, front and back, over the barrel and down the bellows to the belt.
    for sign in (1, -1):
        for x in (-0.31, 0.31):
            hint = (x, sign * 1.0, 0.0)
            P.sweep(strap_path(x, z0 - 0.01, 1.90, barrel_r, sign, 0.016, n=10), chamfer_rect(0.022, 0.06), BP, "chest", hint=hint)
            P.sweep(strap_path(x, 0.77, z0 + 0.01, pleat_ridge, sign, 0.012, n=4), chamfer_rect(0.022, 0.06), BP, "spine", hint=hint)
    # Chest core (front) and the smaller back grille: the focal light.
    # Round grilles. The front follows the sheet's six slots: five thin bars 2.4 cm wide at 0, +-0.065 and
    # +-0.13 (sheet: about 2 cm bars at 0, +-0.063, +-0.113), leaving slots of about 4 cm. The back keeps
    # five slots between 3 cm bars.
    grille(P, 1.43, 1, 0.20, 0.19, [-0.13, -0.065, 0.0, 0.065, 0.13], bar=0.024)
    grille(P, 1.70, -1, 0.15, 0.145, [-0.09, -0.03, 0.03, 0.09], bar=0.03)
    mark(P, "barrel, straps, grilles")

    # Bellows: rounded walnut rolls with narrow valleys round a dark drum, tapering up into the barrel;
    # the upper three ride the pump.
    pz0, pz1 = PLEAT_Z
    h = (pz1 - pz0) / PLEATS
    rd = PLEAT_RIDGE[0] - PLEAT_DEPTH - 0.02
    P.lathe((0, 0, pz0 - 0.02), (0, 0, 1), [(rd, 0.0), (rd, pz1 - pz0 + 0.04)], WD, "spine", sides=P.n(32), sy=SY)
    for k in range(PLEATS):
        rr = pleat_k(k)
        rv = rr - PLEAT_DEPTH
        prof = [(rv, 0.0), (rv + 0.018, h * 0.12), (rr, h * 0.38), (rr, h * 0.62), (rv + 0.018, h * 0.88), (rv, h)]
        P.lathe((0, 0, pz0 + h * k), (0, 0, 1), prof, WP1 if k % 2 else WP2, "bellows" if k >= PLEATS // 2 else "spine",
                sides=P.n(28), sy=SY)
    # Brass belt with rivets, iron hips, a brass plate front and back.
    # The belt follows the bottom pleat (1 cm into its ridge, as before); the iron hips stay 2.5 cm inside it.
    rb = PLEAT_RIDGE[0] + 0.015
    P.band((0, 0, 0.765), (0, 0, 1), rb, 0.05, 0.075, BP, "spine", n=P.n(36), rb=SY * rb)
    for k in range(10):
        a = 2 * math.pi * (k + 0.5) / 10
        P.ball(((rb + 0.027) * math.sin(a), SY * (rb + 0.027) * math.cos(a), 0.765), 0.014, BP, "spine", segs=(8, 5))
    P.lathe((0, 0, 0.53), (0, 0, 1), [(0.20, 0.0), (0.32, 0.05), (0.38, 0.16), (rb - 0.025, 0.25)], GM, "pelvis", sides=P.n(28), sy=0.85)
    for sign in (1, -1):
        plate = [(-0.11, 0.0), (0.11, 0.0), (0.08, -0.17), (0.0, -0.215), (-0.08, -0.17)]
        P.extrude(plate, xz_frame(sign * 0.33) @ Matrix.Translation((0, 0.755, 0)), 0.035, BP, "pelvis", bevel=0.009)
    mark(P, "bellows, belt, hips")

    # Head: a tall brass capsule, tilted slightly forward and standing proud of the barrel front, with a
    # centre ridge and two plain glowing eyes. It rises out of a collar bezel set into the barrel's
    # front-top: a brass sleeve emerging from the staves, a band on its rim and a dark throat inside it.
    # The head bone pivots at the band centre (0, 0.42, 1.83); the skin is rigid, so the shell may sit off the bone.
    collar = (0, 0.6, 0.8)
    P.lathe((0, 0.33, 1.71), collar, [(0.19, 0.0), (0.19, 0.15)], BP, "chest", sides=P.n(28))
    P.band((0, 0.42, 1.83), collar, 0.19, 0.05, 0.07, BP, "chest", n=P.n(36))
    # The throat's cap stands 1 cm above the sleeve's cap (coplanar caps would z-fight).
    P.lathe((0, 0.39, 1.79), collar, [(0.165, 0.0), (0.165, 0.06)], GM, "chest", sides=P.n(24))
    # Taller capsule (0.27 wide, top z 2.096, about 11 cm above the band's back rim; sheet: 0.268 wide, top
    # z 2.04, 11 cm above its ring), unchanged below h 0.16 where it passes the band. A raised face plate
    # between two seams holds the eyes, which sit on the seams as on the sheet (eyes x +-0.065, z 1.85 there;
    # 1.90 here so they clear the band's front lip from the seated camera).
    hc, hax = HEAD_C, HEAD_AX
    hl = HEAD_SECS[-1][0]
    htop = tuple(c + a * hl / math.hypot(*hax) for c, a in zip(hc, hax))
    P.loft(hc, htop, [(hh / hl, rx, ry, 2.0, 0.0, cy) for hh, rx, ry, cy in HEAD_SECS], BP, "head")
    # A proud face plate (pass 3: 0.6 cm out, 1.4 cm thick, read as an outline): 1.6 cm out, 2.4 cm thick, a
    # 0.8 cm crown and a 5 mm bevel, so its rim casts a visible step on the capsule.
    P.wrap(hc, htop, lambda v: head_r(v * hl) + 0.016, -0.62, 0.62, 0.024, BP, "head",
           v0=0.12 / hl, v1=0.35 / hl, nv=6, bevel=0.005, crown=0.008)
    for s in (1, -1):
        # y 0.574: the plate's front at x 0.062, z 1.90 moved from y 0.559 to about 0.572, so the flattened ball
        # still stands about 2 cm proud. 16 or more segments so the eyes read round. Each eye is its own glow island.
        P.ball((s * 0.062, 0.574, 1.90), 0.034, GL, "head", scale=(1.0, 0.55, 1.0), segs=(max(16, P.n(20)), max(6, P.n(8))))

    # Chimneys: brass stacks with flared mouths; the throat, a raised inner lip and a low ember dome in the
    # mouth glow. No flame or smoke geometry: p5-automatons-design.md models the vent as an emissive
    # chimney mouth only, and the art bible rules out smoke. The dome is its own glow island (no shared
    # vertex positions with the throat or the lip), so the runtime ramp keeps a hot centre on it.
    for s, n_ in ((1, "R"), (-1, "L")):
        b = f"chimney.{n_}"
        p0, p1 = HEAD[b], TAIL[b]
        ax = _sub(p1, p0)
        P.lathe(p0, ax, [(0.068, 0.0), (0.068, 0.18), (0.074, 0.205), (0.108, 0.30), (0.118, 0.33), (0.10, 0.338)], BP, b, sides=P.n(24))
        P.lathe(lerp(p0, p1, 0.98), ax, [(0.09, 0.0), (0.09, 0.012)], GL, b, sides=P.n(24))
        P.band(lerp(p0, p1, 1.0), ax, 0.096, 0.02, 0.032, GL, b, n=P.n(16))
        P.ball(lerp(p0, p1, 1.0), 0.085, GL, b, scale=(1.0, 1.0, 0.45), segs=(P.n(12), P.n(6)))
        P.band(lerp(p0, p1, 0.36), ax, 0.082, 0.026, 0.04, BP, b, n=P.n(16))
        P.band(lerp(p0, p1, 0.58), ax, 0.076, 0.018, 0.028, GM, b, n=P.n(16))
    mark(P, "head, chimneys")

    for s, n_ in ((1, "R"), (-1, "L")):
        ua, fa, hd = f"upperarm.{n_}", f"forearm.{n_}", f"hand.{n_}"
        S, E, W = _m(SHOULDER, s), _m(ELBOW, s), _m(WRIST, s)
        # Shoulder plate (sheet front: x 0.50 to 0.73, z 1.27 to 1.82; side: a ring of r 0.31 round a dark lens).
        # Still a surface of revolution about the shoulder pivot's X axis, so it turns in place through the 158-166
        # degree attack raise: rotation about X keeps every point's (x, distance from the axis), and the chimneys
        # only reach x 0.50 or more at 0.5 m or more from that axis. One tall plate replaces the drum, groove and
        # dome stack: its inner end is buried in the barrel at x 0.47 (r 0.30), its face runs straight and slightly
        # crowned (r 0.322) out to a rounded outer corner, and the flat outer face carries a rim ring, a mid ring
        # and a bezel round a dark glass lens. An emerald on the front-outer corner faces the seat camera.
        P.ball(S, 0.095, GM, ua)
        P.lathe((s * 0.47, 0.0, 1.50), (s, 0, 0), [(0.20, 0.0), (0.30, 0.005), (0.315, 0.03), (0.322, 0.08), (0.322, 0.13), (0.312, 0.18),
                                                    (0.295, 0.215), (0.272, 0.238), (0.26, 0.245), (0.001, 0.25)], BP, ua, sides=P.n(30))
        rect = lambda w, t: [(-w / 2, -t / 2), (w / 2, -t / 2), (w / 2, t / 2), (-w / 2, t / 2)]
        P.sweep_ring((s * 0.50, 0.0, 1.50), (s, 0, 0), 0.318, 0.318, rect(0.022, 0.03), BP, ua, n=P.n(30))  # rim along the barrel
        P.band((s * 0.721, 0.0, 1.50), (s, 0, 0), 0.232, 0.03, 0.02, BP, ua, n=P.n(30))
        P.sweep_ring((s * 0.722, 0.0, 1.50), (s, 0, 0), 0.172, 0.172, rect(0.02, 0.016), BP, ua, n=P.n(26))
        P.band((s * 0.727, 0.0, 1.50), (s, 0, 0), 0.122, 0.028, 0.03, BP, ua, n=P.n(26))
        P.shell((s * 0.714, 0.0, 1.50), (s, 0, 0), [(0.001, 0.0), (0.11, 0.0), (0.11, 0.008), (0.075, 0.015), (0.001, 0.018)], LN, ua,
                sides=P.n(26))
        gem = (s * 0.7071, 0.7071, 0.0)
        P.band((s * 0.7106, 0.2706, 1.50), gem, 0.048, 0.014, 0.014, BP, ua, n=P.n(18))
        P.shell((s * 0.706, 0.266, 1.50), gem, [(0.001, 0.0), (0.044, 0.0), (0.038, 0.022), (0.001, 0.03)], EM, ua, sides=P.n(18))
        # Gunmetal upper arm with a brass cuff.
        L1 = math.dist(S, E)
        P.lathe(S, _sub(E, S), [(0.105, 0.0), (0.118, 0.16), (0.112, 0.32), (0.10, L1)], GM, ua, sides=P.n(18))
        P.band(lerp(S, E, 0.66), _sub(E, S), 0.12, 0.03, 0.055, BP, ua, n=P.n(24))
        # Elbow ball, and the elbow emerald on the forearm's upper cuff (r 0.252, axial 0.09 to 0.15) at its
        # front-outer face, 40 degrees forward of outboard: the cuff hides the ball, and a gem set on it, from the
        # front. The bezel (outer r 0.042) stays on the cuff's axial span and sinks 1 to 12 mm into its curve.
        P.ball(E, 0.135, GM, fa)
        fl = math.dist(W, E)
        fax = tuple(c / fl for c in _sub(W, E))
        g0 = (s * 0.766, 0.643, 0.0)
        gd = sum(a * b for a, b in zip(g0, fax))
        eg = tuple(a - gd * b for a, b in zip(g0, fax))
        eg = tuple(c / math.hypot(*eg) for c in eg)
        ec = tuple(e + 0.12 * a for e, a in zip(E, fax))
        P.band(tuple(c + 0.248 * g for c, g in zip(ec, eg)), eg, 0.034, 0.016, 0.024, BP, fa, n=P.n(20))
        P.shell(tuple(c + 0.244 * g for c, g in zip(ec, eg)), eg, [(0.001, 0.0), (0.03, 0.0), (0.026, 0.016), (0.001, 0.022)], EM, fa,
                sides=P.n(18))
        mark(P, f"pauldron, upper arm, elbow {n_}")
        # Big brass forearm cylinder with a cuff band at each end, open to a dark mouth at the elbow.
        P.lathe(E, _sub(W, E), [(0.195, 0.052), (0.195, 0.066)], GM, fa, sides=P.n(32))
        P.lathe(E, _sub(W, E), [(0.20, 0.07), (0.236, 0.074), (0.252, 0.09), (0.252, 0.15), (0.237, 0.162), (0.233, 0.36), (0.252, 0.372),
                                 (0.258, 0.45), (0.25, 0.53), (0.215, 0.55)], BP, fa, sides=P.n(36))
        # Rounded mitt (sheet: fist about gauntlet width, z 0 to 0.50, four curled fingers ending in round tips
        # under the front, a thumb folded across them). A brass mass 0.53 m wide with rounded corners (p 3, was
        # a p 5 box) and four round curled finger sweeps, each a 10-sided tube from a knuckle bump 1 cm above
        # the mass top, down the front (5.7 cm proud of the mass) and curling back under it, so the fronts face
        # the upper room instead of reading as dark slots. Smooth sections of 10 or more sides stay under the
        # 38 degree sharp-edge angle, so the fist and thumb shade smooth. The bottom stays at z 0.075.
        fx, fy = s * 0.93, FIST_Y
        fc = 0.21 + fy  # mass centre y
        P.band(W, _sub(W, E), 0.17, 0.04, 0.05, GM, hd, n=P.n(20))
        P.loft((fx, fc, 0.075), (fx, fc, 0.52), [(0.0, 0.22, 0.13, 2.6, 0, 0), (0.12, 0.255, 0.16, 3.0, 0, 0),
                                                 (0.85, 0.265, 0.165, 3.0, 0, 0), (1.0, 0.215, 0.13, 2.6, 0, 0)], BP, hd, n=P.n(30))
        finger = [(0.05, 0.475), (0.115, 0.48), (0.158, 0.44), (0.172, 0.355), (0.168, 0.26), (0.148, 0.18), (0.105, 0.135), (0.05, 0.13)]
        # Index (inner, thumb side) to little finger (outer): the little finger is thinner and higher.
        for dx, rf, dz in ((-0.17, 0.052, 0.0), (-0.057, 0.052, 0.0), (0.057, 0.052, 0.005), (0.167, 0.046, 0.015)):
            P.sweep([(fx + s * dx, fc + y, z + dz) for y, z in finger], sect(rf, rf, max(10, P.n(14))), BP, hd, hint=(1, 0, 0))
        # Thumb: from the inner side face, round the mass corner (its back 0 to 5 mm into the mass) and across the
        # index and middle finger fronts (2 to 3 cm into them, 2 to 3 cm proud).
        thumb = [(0.285, -0.02, 0.40), (0.272, 0.07, 0.37), (0.24, 0.13, 0.34), (0.20, 0.175, 0.315), (0.13, 0.215, 0.30), (0.02, 0.225, 0.29)]
        P.sweep([(fx - s * x, fc + y, z) for x, y, z in thumb], sect(0.0475, 0.025, 14, 2.2), BP, hd, hint=(0, 0, 1))
        mark(P, f"forearm, fist {n_}")

        # Legs: iron hip and thigh under a brass plate, a domed knee with an emerald, a brass greave
        # and a broad layered sabaton.
        th, sh, ft = f"thigh.{n_}", f"shin.{n_}", f"foot.{n_}"
        H, K, A = _m(HIP, s), _m(KNEE, s), _m(ANKLE, s)
        P.ball(H, 0.125, GM, th)
        # Bulkier brass leg armour (sheet): the thigh plate 0.19 (was 0.165) over a 0.15 thigh, the greave 0.195
        # (0.20 put shin.L 1 mm under the floor on the attack slam).
        P.lathe(H, _sub(K, H), [(0.13, 0.0), (0.15, 0.12), (0.135, math.dist(H, K))], GM, th, sides=P.n(18))
        # The plate narrows to 0.172 at its top (full 0.19 from 35% down) and carries no crown, so it clears the
        # belt in frozen (planted thigh lifts its front under the belt, +4.8 mm) and on the attack slam.
        P.wrap(H, K, lambda vv: 0.19 - 0.018 * max(0.0, (0.35 - vv) / 0.27), -1.9, 1.9, 0.033, BP, th, v0=0.08, v1=0.90, nv=3,
               crown=0.0)
        P.ball(K, 0.105, GM, sh)
        P.shell((K[0], K[1] + 0.075, K[2]), (0, 1, 0), [(0.001, 0.0), (0.13, 0.0), (0.124, 0.04), (0.085, 0.078), (0.001, 0.088)], BP, sh,
                sides=P.n(20))
        # Emerald boss on the knee cap's front, seen from the front (sheet: six emeralds from the front).
        P.band((K[0], K[1] + 0.155, K[2]), (0, 1, 0), 0.045, 0.014, 0.012, BP, sh, n=P.n(16))
        P.ball((K[0], K[1] + 0.157, K[2]), 0.04, EM, sh, scale=(1.0, 0.5, 1.0), segs=(P.n(12), P.n(7)))
        P.band((K[0] - s * 0.1, K[1], K[2]), (-s, 0, 0), 0.04, 0.016, 0.022, BP, sh, n=P.n(16))
        P.ball((K[0] - s * 0.1, K[1], K[2]), 0.034, EM, sh, scale=(0.45, 1.0, 1.0))
        L2 = math.dist(K, A)
        P.lathe(K, _sub(A, K), [(0.10, 0.05), (0.13, 0.06), (0.138, 0.09), (0.18, 0.17), (0.195, 0.18), (0.195, L2 - 0.035), (0.135, L2)], BP, sh,
                sides=P.n(24))
        P.ball(A, 0.078, GM, ft)
        P.loft((A[0], -0.14, 0.061), (A[0], 0.30, 0.061), [(0.0, 0.135, 0.06, 3.0, 0, 0), (0.1, 0.16, 0.062, 3.0, 0, 0),
                                                           (0.78, 0.17, 0.062, 3.0, 0, 0), (1.0, 0.12, 0.04, 3.0, 0, 0.015)], BP, ft)
        P.loft((A[0], 0.10, 0.10), (A[0], 0.34, 0.07), [(0.0, 0.16, 0.035, 3.0, 0, 0), (0.85, 0.165, 0.035, 3.0, 0, 0),
                                                        (1.0, 0.12, 0.02, 3.0, 0, 0)], BP, ft)
        mark(P, f"leg {n_}")


def tile_uvs(bm) -> None:
    """UV0 in tile units: each face projected on the plane of its dominant normal axis (brass: FLAT_BRASS_UV)."""
    layer = bm.loops.layers.uv.new("tile")
    for f in bm.faces:
        if FLAT_BRASS and f.material_index == BP:
            for loop in f.loops:
                loop[layer].uv = FLAT_BRASS_UV
            continue
        ax = max(range(3), key=lambda i: abs(f.normal[i]))
        u_i, v_i = ((1, 2), (0, 2), (0, 1))[ax]
        for loop in f.loops:
            loop[layer].uv = (loop.vert.co[u_i] / TILE_METERS, loop.vert.co[v_i] / TILE_METERS)


def build_body(bpy, bmesh, scene, detail: str, arm_obj):
    P = Parts(bmesh, detail)
    build_parts(P)
    print(f"[{PIECE}] {detail} cumulative tris by section: {P.tally}")
    col = P.bm.loops.layers.float_color.new("tint")
    shade = {k: (*(lin(c) for c in v), 1.0) for k, v in SHADES.items()}
    chest = BONE_NAMES.index("chest")
    for f in P.bm.faces:
        rgba = shade.get(f.material_index, (1.0, 1.0, 1.0, 1.0))
        # Painted walnut on the barrel (chest-weighted walnut: staves and crown, not the pleats): a soft
        # bulge highlight at the widest line and darker stave ends, per loop from the vertex height.
        painted = f.material_index in WALNUT and f.verts[0][P.deform].get(chest, 0.0) > 0.0
        for loop in f.loops:
            k = 0.80 + 0.30 * max(0.0, 1.0 - ((loop.vert.co.z - 1.49) / 0.42) ** 2) if painted else 1.0
            loop[col] = (rgba[0] * k, rgba[1] * k, rgba[2] * k, rgba[3])
        if f.material_index in shade:
            f.material_index = CS if f.material_index < 20 else MT
    bmesh.ops.recalc_face_normals(P.bm, faces=P.bm.faces[:])
    # Fixed triangulation here: the exporter's own quad split follows float noise between runs.
    bmesh.ops.triangulate(P.bm, faces=P.bm.faces[:], quad_method="FIXED", ngon_method="EAR_CLIP")
    P.bm.normal_update()
    tile_uvs(P.bm)
    me = bpy.data.meshes.new(f"{BODY}-{detail}")
    P.bm.to_mesh(me)
    P.bm.free()
    me.set_sharp_from_angle(angle=math.radians(38))
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
    return {**PLANT, **{k.replace("_", "."): v for k, v in moved.items()}}


ARMS_REST = {"forearm.R": (12, 0, 0), "forearm.L": (12, 0, 0)}  # pass 3: 6; the fist rides further ahead of the knee


def idle_pose(t: float) -> dict:
    w = 2 * math.pi * t / CLIPS["idle"]["duration"]
    b = math.sin(w)
    return {
        "pelvis_loc": (0, 0, 0.01 * b),
        "spine": (1.5 * b, 0, 0), "chest": (-1.0 * b, 0, 1.5 * math.sin(w)),
        "head": (2.0 * math.sin(2 * w), 0, 8.0 * math.sin(w)),
        "upperarm.R": (2.5 * b, 0, 0), "upperarm.L": (-2.5 * b, 0, 0),
        "forearm.R": (12 + 2 * b, 0, 0), "forearm.L": (12 - 2 * b, 0, 0),
        "chimney.R": (2.0 * math.sin(2 * w), 0, 0), "chimney.L": (-2.0 * math.sin(2 * w), 0, 0),
        "loc": {"bellows": (0, 0, -0.016 * (1 - math.cos(2 * w)))},
        "ik": PLANT,
    }


START = {**ARMS_REST, "ik": PLANT}
RAISED = {"pelvis_loc": (0, -0.03, 0.0), "spine": (7, 0, 0), "chest": (4, 0, 0), "head": (10, 0, 0),
          "upperarm.R": (158, 0, 0), "upperarm.L": (158, 0, 0), "forearm.R": (30, 0, 0), "forearm.L": (30, 0, 0),
          "hand.R": (10, 0, 0), "hand.L": (10, 0, 0), "loc": {"bellows": (0, 0, 0.01)}, "ik": PLANT}
SLAM = {"pelvis_loc": (0, 0.04, -0.10), "spine": (-10, 0, 0), "chest": (-8, 0, 0), "head": (-4, 0, 0),
        "upperarm.R": (40, 0, 0), "upperarm.L": (40, 0, 0), "forearm.R": (6, 0, 0), "forearm.L": (6, 0, 0),
        "hand.R": (-8, 0, 0), "hand.L": (-8, 0, 0), "chimney.R": (-8, 0, 0), "chimney.L": (-8, 0, 0),
        "loc": {"bellows": (0, 0, -0.03)}, "ik": PLANT}
ATTACK_KEYS = [
    (0.0, START),
    (0.45, RAISED),
    (0.62, {**RAISED, "upperarm.R": (166, 0, 0), "upperarm.L": (166, 0, 0), "spine": (9, 0, 0)}),
    (0.85, SLAM),
    (1.05, {**SLAM, "pelvis_loc": (0, 0.035, -0.085), "chimney.R": (4, 0, 0), "chimney.L": (4, 0, 0)}),
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
            # Forearms 24/26 (were 16/18): the wider pass-3 fists otherwise reach 12 cm under the floor here.
            "upperarm.R": (22, 0, 0), "upperarm.L": (18, 0, 0), "forearm.R": (24, 0, 0), "forearm.L": (26, 0, 0),
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
    if name in (CASE, METAL):  # walnut, pleats, gunmetal and emerald from the corner colours (exported as COLOR_0)
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
    "socket-hit": ("chest", (0, 0.62, 1.43)),  # in front of the amber core: hit sparks and aim point
    "socket-eye": ("head", (0, 0.595, 1.90)),  # between the eyes, just in front of them
    "socket-weapon": ("hand.R", (0.93, 0.515, 0.25)),  # the front centre of the striking right fist's lower finger plates
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
        # ACTIVE, not MATERIAL: Blender 5.2 MATERIAL mode can write a white COLOR_0 placeholder.
        export_vertex_color="ACTIVE",  # COLOR_0 for the case and metal slots (white on every other corner)
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


def canonicalize_normals(path: Path) -> dict:
    """Recomputes every NORMAL from the (byte-stable) positions and sorted triangles. The exporter's
    corner normals carry run-dependent float noise (up to ~3e-5 measured), so they are only used to
    tell fans apart: corners at one position on one bone (each part is rigid on a single bone) whose
    exported normals agree within ~0.3 degrees form one fan (a smooth vertex split by a UV or material
    seam), and each fan gets the angle-weighted mean of its triangles' face normals, Blender's smooth
    rule. Zero-area triangles (collinear points on extruded outlines) get no weight here; the
    exporter's normals give their 180-degree corner full weight, so the few fans that hold one move
    (the stats record how many and how far)."""
    import numpy as np

    data = bytearray(path.read_bytes())
    gltf, acc, (bin_off, _blen) = parse_glb(bytes(data))
    stats = {"vertices": 0, "fans": 0, "zero_area_triangles": 0, "max_dev_deg": 0.0, "over_1deg": 0}
    for mesh in gltf["meshes"]:
        prims = mesh["primitives"]
        pos = [acc(pr["attributes"]["POSITION"]).astype(np.float32) for pr in prims]
        nrm = [acc(pr["attributes"]["NORMAL"]).astype(np.float64) for pr in prims]
        base = np.cumsum([0] + [len(x) for x in pos])
        P, N = np.concatenate(pos), np.concatenate(nrm)
        J = np.concatenate([acc(pr["attributes"]["JOINTS_0"])[:, 0].astype(np.uint32) for pr in prims])
        T = np.concatenate([acc(pr["indices"]).astype(np.int64).reshape(-1, 3) + base[i] for i, pr in enumerate(prims)])
        key = np.concatenate([np.ascontiguousarray(P).view(np.uint8).reshape(-1, 12), J.view(np.uint8).reshape(-1, 4)], axis=1)
        _u, gid = np.unique(np.ascontiguousarray(key).view(np.dtype((np.void, 16)))[:, 0], return_inverse=True)
        fan = np.empty(len(P), dtype=np.int64)
        reps: dict[int, list[tuple[int, np.ndarray]]] = {}
        nf = 0
        for v in range(len(P)):  # index order: deterministic; the noise (~3e-5) sits far inside the 0.99999 cut
            for f_, rn in reps.setdefault(int(gid[v]), []):
                if float(rn @ N[v]) > 0.99999:
                    fan[v] = f_
                    break
            else:
                reps[int(gid[v])].append((nf, N[v]))
                fan[v] = nf
                nf += 1
        Pd = P.astype(np.float64)
        p0, p1, p2 = Pd[T[:, 0]], Pd[T[:, 1]], Pd[T[:, 2]]
        fn = np.cross(p1 - p0, p2 - p0)
        ln = np.linalg.norm(fn, axis=1)
        fn = np.where(ln[:, None] > 0, fn / np.maximum(ln, 1e-300)[:, None], 0.0)
        sums = np.zeros((nf, 3))
        for k, (a_, b_, c_) in enumerate(((p0, p1, p2), (p1, p2, p0), (p2, p0, p1))):
            e1, e2 = b_ - a_, c_ - a_
            ang = np.arctan2(np.linalg.norm(np.cross(e1, e2), axis=1), np.einsum("ij,ij->i", e1, e2))
            np.add.at(sums, fan[T[:, k]], fn * ang[:, None])
        sl = np.linalg.norm(sums, axis=1)
        out = np.where((sl > 1e-12)[:, None], sums / np.maximum(sl, 1e-300)[:, None], 0.0)[fan]
        keep = ~(sl > 1e-12)[fan]
        out[keep] = N[keep]
        dev = np.degrees(np.arccos(np.clip(np.einsum("ij,ij->i", out, N), -1.0, 1.0)))
        stats["vertices"] += len(P)
        stats["fans"] += nf
        stats["zero_area_triangles"] += int((ln == 0).sum())
        stats["max_dev_deg"] = max(stats["max_dev_deg"], round(float(dev.max()), 1))
        stats["over_1deg"] += int((dev > 1.0).sum())
        for i, pr in enumerate(prims):
            a = gltf["accessors"][pr["attributes"]["NORMAL"]]
            view = gltf["bufferViews"][a["bufferView"]]
            start = bin_off + view.get("byteOffset", 0) + a.get("byteOffset", 0)
            if view.get("byteStride", 12) != 12 or a["componentType"] != 5126:
                raise ValueError("NORMAL accessor is not tightly packed float32")
            data[start : start + a["count"] * 12] = out[base[i] : base[i + 1]].astype(np.float32).tobytes()
    path.write_bytes(bytes(data))
    return stats


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
        "materialSlots": {name: ({"set": name, "tileMeters": TILE_METERS, "normalScale": SETS[name], **({"tint": TINTS[name]} if name in TINTS else {})}
                                 if name in SETS
                                 else {"set": None, "factorOnly": True, **({"emissive": True} if name == GLOW else {})}) for name in MATS},
        "budget": {"tris": gate["triangles"], "materials": len(gate["materials"]), "bones": gate["bone_count"], "influences": LIMITS["influences"]},
        "cull": {"center": cull["center"], "radius": cull["radius"]},
    }


# --------------------------------------------------------------------------------------------------
# Review renders (EEVEE)

VIEWS = {"front": ((0, 6.0, 1.2), (0, 0, 1.05)), "side": ((6.0, 0, 1.2), (0, 0, 1.05)),
         "back": ((0, -6.0, 1.2), (0, 0, 1.05)), "three-quarter": ((3.8, 4.7, 2.0), (0, 0, 1.05))}
ANIM_CAMERA = ((4.2, 4.2, 2.2), (0, 0.2, 1.05), 35.0)
ROM = {"rig-rom-reach": {"upperarm.R": (150, 0, 0), "forearm.R": (40, 0, 0), "upperarm.L": (0, -50, 0), "forearm.L": (70, 0, 0),
                         "head": (0, 0, 30), "chest": (0, 0, 15), "chimney.R": (14, 0, 0), "ik": PLANT},
       "rig-rom-crouch": {"pelvis_loc": (0, 0, -0.2), "spine": (-15, 0, 0), "upperarm.R": (30, 0, 0), "upperarm.L": (30, 0, 0),
                          "forearm.R": (40, 0, 0), "forearm.L": (40, 0, 0), "loc": {"bellows": (0, 0, -0.04)}, "ik": PLANT}}
# Concept-angle comparison: orthographic, framed like the concept panels (camera side, offset).
COMPARE = {"front": (0, 1, 0), "side": (-1, 0, 0), "back": (0, -1, 0)}  # camera direction from the figure (side: its left, as drawn)
M_PER_PX = 2.1 / 806  # concept sheet: feet (y 914 px) to chimney mouths (y 108 px) for the 2.1 m design height
COMPARE_Z = (914 - 482) * M_PER_PX  # crop centre height (crop centre at y 482 px)
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

ENGINE_SHOTS = ["idle", "attack", "hit", "frozen", "death", "glow-close"]  # glow-close: idle, the seat camera narrowed to the upper body
APPROVAL_NOTE = ('Concept approval PENDING (Paul). Modeled under Paul\'s standing approval of 2026-11-15: "you have standing approval '
                 'for all spending / modeling / deployments needed for this project". Model, rig, animation approvals pending.')


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


TITLE = f"P5-T3 Bellows Golem ({PIECE}) - owner review sheet"
VENT_NOTE = ("Design deviation from the sheet: the chimney flame plume is not modeled. p5-automatons-design.md models the vent as an "
             "emissive chimney mouth only and the art bible rules out smoke, so each mouth carries a glowing ember dome instead.")


def compose_sheet(out: Path) -> Path:
    r = out / "renders"
    eng = out / "engine"
    note = fidelity_note(out) + "\n" + VENT_NOTE
    pairs = fidelity_pairs(out)
    compare = _grid([("FIDELITY - concept view beside the model at the same angle and framing", pairs)], 6,
                    TITLE.replace("owner review sheet", "fidelity comparison"), note, tw=300, th=420)
    compare.save(out.parent / f"{PIECE}.fidelity-compare.jpg", quality=88)
    sections = [
        ("REFERENCE - golem-sheet-1.png (concept; owner approval PENDING)", [("concept sheet", CONCEPT)]),
        ("FIDELITY - concept view beside the model at the same angle (orthographic, same framing)", pairs),
        ("MODEL - textured Blender renders (shared brass-polished set; walnut, pleats, gunmetal and emerald from COLOR_0; glow factor-only), "
         "approval PENDING", [
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
    sheet = _grid(sections, 6, TITLE, APPROVAL_NOTE + "\n" + note)
    path = out.parent / f"{PIECE}.review-sheet.jpg"
    sheet.save(path, quality=86)
    return path


def record_fidelity(out: Path) -> Path:
    """Adds the author's self-score (staging/fidelity.json) to provenance.json as `authorSelfScore`,
    bound to the compare image's bytes. Run after `asset-check.py --assemble-enemy`, which rebuilds
    provenance from scratch and so drops the reviewer's `independentScore`: that block is copied back
    unchanged from the committed provenance (it scored the previous build; a re-score is pending)."""
    prov_path = out.parent / "provenance.json"
    prov = json.loads(prov_path.read_text())
    fid = json.loads((out / "fidelity.json").read_text())
    compare = out.parent / f"{PIECE}.fidelity-compare.jpg"
    rel = str(prov_path.relative_to(REPO))
    head = json.loads(subprocess.run(["git", "-C", str(REPO), "show", f"HEAD:{rel}"], check=True, capture_output=True, text=True).stdout)
    independent = head.get("independentScore", prov.get("independentScore"))
    prov["authorSelfScore"] = {
        "score": fid["score"], "scale": "0-100 visual fidelity to the concept",
        "scorer": "author self-score (the authoring agent; not the independent score create-rigged-character-assets requires)",
        "date": fid.get("date"), "gaps": fid.get("gaps", []), "method": fid.get("method"),
        "evidence": {"path": str(compare.relative_to(REPO)), "sha256": sha256(compare)},
        "independentScoreNote": "the recorded independentScore scored the previous build; an independent re-score of this build is pending",
    }
    if independent is not None:
        prov["independentScore"] = independent
    prov_path.write_text(json.dumps(prov, indent=2) + "\n")
    if independent is not None and json.loads(prov_path.read_text())["independentScore"] != head.get("independentScore", independent):
        raise SystemExit("independentScore differs from the committed provenance")
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
    if args.compare_only:
        set_slots(body, source_materials(bpy))
        print(f"[{PIECE}] tris low={sum(len(p.vertices) - 2 for p in body.data.polygons)}")
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
    report["canonicalized_normals"] = canonicalize_normals(glb)
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
