"""Table decorations (Paul's 2026-11-17 headset playtest: "some random decorations placed on them
would help break up the stamped look, maybe vase or candle or book or something"). Three small
props for the hall benches and the gear-shaft crate, placed at runtime by `src/floor/table-decor.ts`:

- candle: an aged-brass chamberstick (dish, socket, thumb ring) holding a wax candle with drips, a
  wick and a solid emissive flame (no light: PRD caps dynamic lights per room).
- books: a stack of three leather-bound books with paper page blocks and gilt spine bands.
- vase: a glazed oxblood ceramic vase with an unglazed clay foot and a brass neck ring.

Each prop has a high build (procedural painterly shaders: the shared P4-T3 brass-aged set
box-projected on brass, noise value variation, leather grain and page bumps) and a low build
(under 600 triangles). The three lows share one 1024 px UV0 atlas; Cycles bakes the highs onto it
selected-to-active: base colour, roughness, metallic and emission through emission passes (a
metallic surface has no diffuse colour pass), tangent normal and AO. The maps are written as PNGs
in staging and as UASTC KTX2 beside an image-free GLB with one material and one node per prop.

Blender run (build, bake, export, encode, reimport, .blend sources, renders):
    "$BLENDER" -b --factory-startup --python-exit-code 1 -P scripts/assets/build-table-decor.py -- \
        [--skip-bake] [--skip-renders] [--device GPU|CPU]
Review sheet (system Python with Pillow, after the Blender run and the engine stills):
    python3 -I scripts/assets/build-table-decor.py --sheet

Frame: Blender is Z-up; runtime (x, y, z) = Blender (x, z, -y). Each prop stands at its origin on
z = 0, so its runtime origin is the base centre on the table top.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import struct
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PIECE = "table-decor"
SRC = ROOT / "assets-source/props/table-decor"
STAGING = SRC / "staging"
BLEND_DIR = SRC / "blend"
RUNTIME = ROOT / "public/assets/props/table-decor"
MATERIAL_DIR = ROOT / "public/assets/materials"
STYLE_BOARD = ROOT / "assets-source/style/locked/L-board-1.png"
KTX = Path.home() / ".local/opt/ktx-software-4.4.2/bin/ktx"

KINDS = ("candle", "books", "vase")
ATLAS = 1024
LIMIT_TRIS = 600
MARGIN_PX = 8
BRASS_TILE_M = 0.5  # brass-aged tiles at 0.5 m (public/assets/materials/materials.json)
# Runtime look (bound by src/world/table-decor.ts from the manifest).
EMISSIVE_INTENSITY = 1.6
ENV_INTENSITY = 0.3
# Footprint radii the placement module reserves (src/floor/table-decor.ts DECOR_RADIUS).
RESERVED_RADIUS = {"candle": 0.072, "books": 0.11, "vase": 0.07}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexl(h: str) -> tuple:
    h = h.lstrip("#")
    return tuple(srgb_to_linear(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4))


# Slot: (colour a, colour b, noise scale, roughness, metallic, bump strength, emission colours or None)
SLOTS = {
    "brass": (None, None, 0.0, None, 1.0, 0.0, None),  # the shared brass-aged set
    "wax": ("#E9D9B6", "#D2B884", 90.0, 0.55, 0.0, 0.08, None),
    "flame": ("#FFE2A0", "#F08C2C", 0.0, 0.6, 0.0, 0.0, ("#FFD98A", "#F08C2C")),
    "leather-red": ("#6E2622", "#4A1714", 140.0, 0.62, 0.0, 0.25, None),
    "leather-green": ("#26452E", "#162B1C", 140.0, 0.62, 0.0, 0.25, None),
    "leather-brown": ("#664126", "#3F2716", 140.0, 0.64, 0.0, 0.25, None),
    "paper": ("#DCCBA2", "#B9A479", 60.0, 0.85, 0.0, 0.0, None),
    "gilt": ("#D3AC52", "#9C7A34", 120.0, 0.32, 1.0, 0.05, None),
    "glaze": ("#6E1E1C", "#3E0F10", 30.0, 0.2, 0.0, 0.03, None),
    "clay": ("#8C5D3E", "#6A432B", 160.0, 0.9, 0.0, 0.2, None),
}
SLOT_NAMES = list(SLOTS)


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    p = argparse.ArgumentParser()
    p.add_argument("--skip-bake", action="store_true")
    p.add_argument("--skip-renders", action="store_true")
    p.add_argument("--device", default="GPU", choices=["GPU", "CPU"])
    p.add_argument("--sheet", action="store_true")
    return p.parse_args(argv)


# ---------------------------------------------------------------------------------------------
# Geometry (bmesh). Every builder appends faces to `bm` with a slot index.
# ---------------------------------------------------------------------------------------------


def lathe(bm, profile: list, seg: int, slot, z_shift: float = 0.0, x_off: float = 0.0, smooth: bool = True) -> None:
    """Surface of revolution about z through (x_off, 0) from a (r, z) profile. A point with r == 0
    is a pole; faces wind outward when the profile runs from the bottom up the outside. `slot` is a
    slot name or a function of the face's mean z."""
    rings = []
    for r, z in profile:
        if r < 1e-7:
            rings.append([bm.verts.new((x_off, 0.0, z + z_shift))])
        else:
            rings.append([bm.verts.new((x_off + r * math.cos(2 * math.pi * k / seg), r * math.sin(2 * math.pi * k / seg), z + z_shift))
                          for k in range(seg)])
    for a, b in zip(rings, rings[1:]):
        for k in range(seg):
            if len(a) == 1 and len(b) == 1:
                continue
            if len(a) == 1:
                vs = [a[0], b[k], b[(k + 1) % seg]]
            elif len(b) == 1:
                vs = [a[k], a[(k + 1) % seg], b[0]]
            else:
                vs = [a[k], a[(k + 1) % seg], b[(k + 1) % seg], b[k]]
            f = bm.faces.new(vs)
            zc = sum(v.co.z for v in vs) / len(vs)
            name = slot(zc - z_shift) if callable(slot) else slot
            f.material_index = SLOT_NAMES.index(name)
            f.smooth = smooth


def torus_x(bm, cx: float, cz: float, major: float, minor: float, seg: int, sides: int, slot: str) -> None:
    """Ring standing in the xz plane (axis along y), centred at (cx, 0, cz)."""
    grid = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        row = []
        for j in range(sides):
            b = 2 * math.pi * j / sides
            rr = major + minor * math.cos(b)
            row.append(bm.verts.new((cx + rr * math.cos(a), minor * math.sin(b), cz + rr * math.sin(a))))
        grid.append(row)
    for i in range(seg):
        for j in range(sides):
            vs = [grid[i][j], grid[(i + 1) % seg][j], grid[(i + 1) % seg][(j + 1) % sides], grid[i][(j + 1) % sides]]
            f = bm.faces.new(vs)
            f.material_index = SLOT_NAMES.index(slot)
            f.smooth = True


def box(bm, x0, x1, y0, y1, z0, z1, slot: str, xf=None) -> None:
    from mathutils import Matrix, Vector
    xf = xf or Matrix.Identity(4)
    c = [xf @ Vector(p) for p in ((x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
                                  (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))]
    v = [bm.verts.new(p) for p in c]
    for idx in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        f = bm.faces.new([v[i] for i in idx])
        f.material_index = SLOT_NAMES.index(slot)
        f.smooth = False


def candle(bm, high: bool) -> None:
    seg = 48 if high else 12
    if high:
        dish = [(0, 0), (0.046, 0), (0.051, 0.002), (0.053, 0.006), (0.0525, 0.010), (0.050, 0.0125), (0.047, 0.0125),
                (0.044, 0.0105), (0.036, 0.0085), (0.025, 0.0085), (0.0225, 0.010), (0.0215, 0.014), (0.021, 0.036),
                (0.0235, 0.039), (0.0245, 0.044), (0.0225, 0.0465), (0.0185, 0.0465), (0, 0.0465)]
    else:
        dish = [(0, 0), (0.052, 0), (0.053, 0.010), (0.046, 0.0125), (0.024, 0.009), (0.022, 0.040), (0.0245, 0.0455), (0, 0.0465)]
    lathe(bm, dish, seg, "brass")
    wax_seg = 32 if high else 10
    if high:
        wax = [(0, 0.044), (0.018, 0.044), (0.018, 0.148), (0.0172, 0.153), (0.0145, 0.1545), (0.008, 0.151), (0.0015, 0.150), (0, 0.150)]
    else:
        wax = [(0, 0.044), (0.018, 0.044), (0.018, 0.153), (0, 0.150)]
    lathe(bm, wax, wax_seg, "wax")
    if high:
        # Wax runs down the side and a wick.
        for ang, length in ((0.4, 0.034), (2.3, 0.022), (4.4, 0.045)):
            cx, cy = 0.0172 * math.cos(ang), 0.0172 * math.sin(ang)
            run = [(0, 0.152 - length), (0.0035, 0.152 - length + 0.004), (0.0042, 0.152 - length * 0.5), (0.004, 0.150), (0.0032, 0.1535), (0, 0.1545)]
            start = len(bm.verts)
            lathe(bm, run, 10, "wax")
            bm.verts.ensure_lookup_table()
            for v in bm.verts[start:]:
                v.co.x += cx
                v.co.y += cy
        lathe(bm, [(0, 0.1500), (0.0013, 0.1500), (0.0012, 0.1595), (0, 0.1605)], 8, "wax")
    flame = [(0, 0.157), (0.0055, 0.162), (0.0082, 0.170), (0.0072, 0.180), (0.0042, 0.191), (0, 0.203)]
    if not high:
        flame = [(0, 0.157), (0.0078, 0.166), (0.0062, 0.182), (0, 0.203)]
    lathe(bm, flame, 16 if high else 6, "flame")
    torus_x(bm, 0.059, 0.0115, 0.0085, 0.0026, 24 if high else 8, 8 if high else 4, "brass")


BOOKS = [  # (width x, depth y, thickness, cover slot, yaw, dx, dy)
    (0.168, 0.118, 0.032, "leather-red", 0.0, 0.0, 0.0),
    (0.152, 0.108, 0.028, "leather-green", 0.13, 0.006, -0.003),
    (0.134, 0.094, 0.024, "leather-brown", -0.21, -0.006, 0.004),
]


def books(bm, high: bool, only: int | None = None) -> None:
    """The stack, or only book `only` of it (each book bakes on its own, so a cage ray from one
    book's cover never lands on the book resting on it)."""
    from mathutils import Matrix, Vector
    z = 0.0
    for i, (w, d, t, cover, yaw, dx, dy) in enumerate(BOOKS):
        if only is not None and i != only:
            z += t
            continue
        xf = Matrix.Translation((dx, dy, z)) @ Matrix.Rotation(yaw, 4, "Z")
        hw, hd = w / 2, d / 2
        seg = 16 if high else 4

        def spine(y0: float, y1: float, rad: float, slot: str) -> None:
            """Half round along y on the -x side, closed by semicircular end caps."""
            ring = [[bm.verts.new(xf @ Vector((-hw + t / 2 - rad * math.sin(math.pi * k / seg), yy, t / 2 - rad * math.cos(math.pi * k / seg))))
                     for k in range(seg + 1)] for yy in (y0, y1)]
            for k in range(seg):
                f = bm.faces.new([ring[0][k], ring[0][k + 1], ring[1][k + 1], ring[1][k]])
                f.material_index = SLOT_NAMES.index(slot)
                f.smooth = True
            for end in ring:
                f = bm.faces.new(end)
                f.material_index = SLOT_NAMES.index(slot)

        # Boards and a page block set 4 mm in (the page edges read in silhouette), on a round spine.
        board = 0.0028 if high else 0.0035
        box(bm, -hw + t / 2, hw, -hd, hd, 0.0, board, cover, xf)
        box(bm, -hw + t / 2, hw, -hd, hd, t - board, t, cover, xf)
        box(bm, -hw + t / 2 - (0.001 if high else 0.0), hw - 0.004, -hd + 0.004, hd - 0.004, board, t - board, "paper", xf)
        spine(-hd, hd, t / 2, cover)
        if high:
            for yb in (-hd * 0.55, hd * 0.55):
                spine(yb - 0.003, yb + 0.003, t / 2 + 0.0012, "gilt")
        z += t


def vase_slot(z: float) -> str:
    return "clay" if z < 0.0095 else "glaze"


def vase(bm, high: bool) -> None:
    if high:
        prof = [(0, 0), (0.034, 0), (0.0375, 0.003), (0.037, 0.009), (0.034, 0.012), (0.039, 0.022), (0.050, 0.045),
                (0.059, 0.072), (0.0635, 0.098), (0.0615, 0.118), (0.054, 0.138), (0.042, 0.157), (0.031, 0.172),
                (0.0255, 0.186), (0.0255, 0.199), (0.029, 0.209), (0.0345, 0.2175), (0.0355, 0.2215), (0.033, 0.2235),
                (0.0285, 0.2195), (0.0225, 0.208), (0.020, 0.195), (0.019, 0.172), (0, 0.168)]
        seg = 64
    else:
        prof = [(0, 0), (0.0375, 0.002), (0.034, 0.012), (0.050, 0.045), (0.059, 0.072), (0.0635, 0.098), (0.0615, 0.118),
                (0.054, 0.138), (0.031, 0.172), (0.0255, 0.192), (0.0355, 0.2215), (0.030, 0.222), (0.020, 0.195), (0, 0.185)]
        seg = 24
    lathe(bm, prof, seg, vase_slot)
    if high:
        lathe(bm, [(0.0254, 0.1825), (0.0272, 0.1835), (0.0275, 0.1885), (0.0254, 0.1895)], 64, "brass")


BUILDERS = {"candle": candle, "books": books, "vase": vase}


# ---------------------------------------------------------------------------------------------
# Blender side
# ---------------------------------------------------------------------------------------------


def blender_main(args: argparse.Namespace) -> None:
    import bmesh
    import bpy
    import numpy as np
    from mathutils import Vector

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import lightmap_helpers as lm

    t0 = time.monotonic()
    for d in (STAGING, STAGING / "renders", BLEND_DIR, RUNTIME):
        d.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version = 0
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    report: dict = {"piece": PIECE, "blender": bpy.app.version_string, "generator": "scripts/assets/build-table-decor.py",
                    "generator_sha256": sha256(Path(__file__)),
                    "helper_sha256": {"lightmap_helpers.py": sha256(Path(lm.__file__))},
                    "load1_at_start": os.getloadavg()[0]}

    # -- materials -------------------------------------------------------------------------
    def bsdf_of(mat):
        return next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")

    def out_of(mat):
        return next(n for n in mat.node_tree.nodes if n.type == "OUTPUT_MATERIAL")

    def mix_color(nt, a, b, fac):
        m = nt.nodes.new("ShaderNodeMix")
        m.data_type = "RGBA"
        ins = [s for s in m.inputs if s.type == "RGBA"]
        outs = [s for s in m.outputs if s.type == "RGBA"]
        ins[0].default_value = (*a, 1.0)
        ins[1].default_value = (*b, 1.0)
        nt.links.new(fac, m.inputs["Factor"])
        return outs[0]

    channels: dict[str, dict] = {}

    def high_material(slot: str):
        ca, cb, nscale, rough, metal, bump, emit = SLOTS[slot]
        mat = bpy.data.materials.new(f"{PIECE}_{slot}")
        nt = mat.node_tree
        bsdf = bsdf_of(mat)
        tc = nt.nodes.new("ShaderNodeTexCoord")
        ch: dict = {}
        if slot == "brass":
            mapping = nt.nodes.new("ShaderNodeMapping")
            mapping.inputs["Scale"].default_value = (1 / BRASS_TILE_M,) * 3
            nt.links.new(tc.outputs["Object"], mapping.inputs["Vector"])
            base = nt.nodes.new("ShaderNodeTexImage")
            base.image = bpy.data.images.load(str(MATERIAL_DIR / "brass-aged/brass-aged.basecolor.png"), check_existing=True)
            orm = nt.nodes.new("ShaderNodeTexImage")
            orm.image = bpy.data.images.load(str(MATERIAL_DIR / "brass-aged/brass-aged.orm.png"), check_existing=True)
            orm.image.colorspace_settings.name = "Non-Color"
            for tex in (base, orm):
                tex.projection = "BOX"
                tex.projection_blend = 0.3
                nt.links.new(mapping.outputs["Vector"], tex.inputs["Vector"])
            sep = nt.nodes.new("ShaderNodeSeparateColor")
            nt.links.new(orm.outputs["Color"], sep.inputs["Color"])
            ch["base"] = base.outputs["Color"]
            ch["rough"] = sep.outputs["Green"]
            ch["metal"] = None
        else:
            noise = nt.nodes.new("ShaderNodeTexNoise")
            noise.inputs["Scale"].default_value = max(nscale, 1.0)
            noise.inputs["Detail"].default_value = 6.0
            nt.links.new(tc.outputs["Object"], noise.inputs["Vector"])
            ch["base"] = mix_color(nt, hexl(ca), hexl(cb), noise.outputs["Fac"]) if nscale > 0 else None
            if ch["base"] is None:
                sep_z = nt.nodes.new("ShaderNodeSeparateXYZ")
                nt.links.new(tc.outputs["Object"], sep_z.inputs["Vector"])
                ramp = nt.nodes.new("ShaderNodeMapRange")
                ramp.inputs["From Min"].default_value = 0.16
                ramp.inputs["From Max"].default_value = 0.20
                nt.links.new(sep_z.outputs["Z"], ramp.inputs["Value"])
                ch["base"] = mix_color(nt, hexl(ca), hexl(cb), ramp.outputs["Result"])
                ch["zfac"] = ramp.outputs["Result"]
            rv = nt.nodes.new("ShaderNodeMapRange")
            rv.inputs["To Min"].default_value = rough - 0.08
            rv.inputs["To Max"].default_value = rough + 0.08
            nt.links.new(noise.outputs["Fac"], rv.inputs["Value"])
            ch["rough"] = rv.outputs["Result"]
            ch["metal"] = None
            if bump > 0:
                grain = nt.nodes.new("ShaderNodeTexNoise")
                grain.inputs["Scale"].default_value = 900.0 if slot.startswith("leather") else 400.0
                grain.inputs["Detail"].default_value = 2.0
                nt.links.new(tc.outputs["Object"], grain.inputs["Vector"])
                bn = nt.nodes.new("ShaderNodeBump")
                bn.inputs["Strength"].default_value = bump
                bn.inputs["Distance"].default_value = 0.0004
                nt.links.new(grain.outputs["Fac"], bn.inputs["Height"])
                nt.links.new(bn.outputs["Normal"], bsdf.inputs["Normal"])
            if slot == "paper":
                wave = nt.nodes.new("ShaderNodeTexWave")
                wave.wave_type = "BANDS"
                wave.bands_direction = "Z"
                wave.inputs["Scale"].default_value = 260.0
                nt.links.new(tc.outputs["Object"], wave.inputs["Vector"])
                bn = nt.nodes.new("ShaderNodeBump")
                bn.inputs["Strength"].default_value = 0.35
                bn.inputs["Distance"].default_value = 0.0003
                nt.links.new(wave.outputs["Fac"], bn.inputs["Height"])
                nt.links.new(bn.outputs["Normal"], bsdf.inputs["Normal"])
        nt.links.new(ch["base"], bsdf.inputs["Base Color"])
        nt.links.new(ch["rough"], bsdf.inputs["Roughness"])
        bsdf.inputs["Metallic"].default_value = metal
        ch["metal_value"] = metal
        if emit:
            ch["emit"] = mix_color(nt, hexl(emit[0]), hexl(emit[1]), ch["zfac"])
            nt.links.new(ch["emit"], bsdf.inputs["Emission Color"])
            bsdf.inputs["Emission Strength"].default_value = 1.0
        else:
            ch["emit"] = None
        ch["bsdf"] = bsdf
        ch["out"] = out_of(mat)
        emission = nt.nodes.new("ShaderNodeEmission")
        emission.inputs["Strength"].default_value = 1.0
        ch["emission"] = emission
        channels[mat.name] = ch
        mat.use_backface_culling = True
        return mat

    high_mats = [high_material(s) for s in SLOT_NAMES]

    def surface(channel: str) -> None:
        """Routes every high material's output to the BSDF, or to an emission of one channel."""
        for mat in high_mats:
            ch = channels[mat.name]
            nt = mat.node_tree
            em = ch["emission"]
            for link in [lk for lk in nt.links if lk.to_socket == em.inputs["Color"]]:
                nt.links.remove(link)
            if channel == "bsdf":
                nt.links.new(ch["bsdf"].outputs["BSDF"], ch["out"].inputs["Surface"])
                continue
            if channel == "metal":
                v = ch["metal_value"]
                em.inputs["Color"].default_value = (v, v, v, 1.0)
            elif channel == "emit":
                if ch["emit"] is not None:
                    nt.links.new(ch["emit"], em.inputs["Color"])
                else:
                    em.inputs["Color"].default_value = (0, 0, 0, 1)
            else:
                nt.links.new(ch[channel], em.inputs["Color"])
            nt.links.new(em.outputs["Emission"], ch["out"].inputs["Surface"])

    # -- build ------------------------------------------------------------------------------
    def build(kind: str, high: bool, part: int | None = None):
        bm = bmesh.new()
        if part is None:
            BUILDERS[kind](bm, high)
        else:
            BUILDERS[kind](bm, high, only=part)
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method="FIXED", ngon_method="BEAUTY")
        name = f"{PIECE}_{kind}" + ("" if part is None else f"_{part}") + ("_high" if high else "")
        mesh = bpy.data.meshes.new(name)
        bm.to_mesh(mesh)
        bm.free()
        obj = bpy.data.objects.new(name, mesh)
        scene.collection.objects.link(obj)
        if high:
            for m in high_mats:
                mesh.materials.append(m)
        else:
            # One atlas material: a single primitive per prop.
            for poly in mesh.polygons:
                poly.material_index = 0
        return obj

    # Bake pairs (high, low): one per prop, and one per book of the stack; the book lows join into
    # `table-decor_books` after the bake.
    pairs = []
    for k in KINDS:
        if k == "books":
            pairs += [(k, build(k, True, i), build(k, False, i)) for i in range(len(BOOKS))]
        else:
            pairs.append((k, build(k, True), build(k, False)))
    bake_lows = [lo for _, _, lo in pairs]

    def join(kind: str, high: bool):
        objs = [h if high else lo for k, h, lo in pairs if k == kind]
        if len(objs) == 1:
            return objs[0]
        bpy.ops.object.select_all(action="DESELECT")
        for o in objs:
            o.hide_set(False)
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.join()
        obj = bpy.context.view_layer.objects.active
        obj.name = obj.data.name = f"{PIECE}_{kind}" + ("_high" if high else "")
        return obj

    def check_geometry(highs: dict, lows: dict) -> tuple[dict, dict]:
        """Low triangle budget, footprint radius about the origin and base on z = 0."""
        tris = {k: {"low": len(lows[k].data.polygons), "high": len(highs[k].data.polygons)} for k in KINDS}
        print("triangles", json.dumps(tris))
        for k in KINDS:
            if tris[k]["low"] > LIMIT_TRIS:
                raise RuntimeError(f"{k}: {tris[k]['low']} low triangles over {LIMIT_TRIS}")
        geo = {}
        for k in KINDS:
            def radius(o):
                return max(math.hypot(v.co.x, v.co.y) for v in o.data.vertices)

            def zmax(o):
                return max(v.co.z for v in o.data.vertices)
            geo[k] = {"radius_low": round(radius(lows[k]), 4), "radius_high": round(radius(highs[k]), 4),
                      "height_low": round(zmax(lows[k]), 4), "height_high": round(zmax(highs[k]), 4),
                      "min_z_low": round(min(v.co.z for v in lows[k].data.vertices), 5)}
            if max(geo[k]["radius_low"], geo[k]["radius_high"]) > RESERVED_RADIUS[k] + 1e-4:
                raise RuntimeError(f"{k}: footprint radius {geo[k]} exceeds the reserved {RESERVED_RADIUS[k]}")
            if abs(geo[k]["min_z_low"]) > 1e-5:
                raise RuntimeError(f"{k}: low base is not on z = 0")
        print("geometry", json.dumps(geo))
        return tris, geo

    # -- atlas material and shared UV0 -----------------------------------------------------
    atlas = bpy.data.materials.new(PIECE)
    atlas.use_backface_culling = True
    for o in bake_lows:
        o.data.materials.append(atlas)
        o.data.uv_layers.new(name="UVMap")
    bpy.ops.object.select_all(action="DESELECT")
    for o in bake_lows:
        o.select_set(True)
    bpy.context.view_layer.objects.active = bake_lows[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.0, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(rotate=True, margin_method="FRACTION", margin=2 * MARGIN_PX / ATLAS)
    bpy.ops.object.mode_set(mode="OBJECT")
    # Texel density per prop (px per metre, sqrt of UV area over surface area).
    dens = {}
    for k in KINDS:
        a3 = a2 = 0.0
        for kind, _, o in pairs:
            if kind != k:
                continue
            uv = o.data.uv_layers["UVMap"].data
            for poly in o.data.polygons:
                a3 += poly.area
                u = [uv[li].uv for li in poly.loop_indices]
                a2 += abs((u[1].x - u[0].x) * (u[2].y - u[0].y) - (u[2].x - u[0].x) * (u[1].y - u[0].y)) / 2
        dens[k] = round(math.sqrt(a2 / a3) * ATLAS, 1)
    report["texel_density_px_per_m"] = dens
    print("texel density", dens)

    # -- bake ------------------------------------------------------------------------------
    maps = {}
    if not args.skip_bake:
        report["device"] = lm.select_device(args.device)
        scene.cycles.use_denoising = False
        scene.render.bake.margin = 0
        world = bpy.data.worlds.new(f"{PIECE}_bake_world")
        scene.world = world
        world.color = (0, 0, 0)
        scene.world.light_settings.distance = 0.03
        nt = atlas.node_tree
        plan = [("albedo", "EMIT", "base", 4), ("rough", "EMIT", "rough", 4), ("metal", "EMIT", "metal", 1),
                ("emit", "EMIT", "emit", 4), ("normal", "NORMAL", "bsdf", 8), ("ao", "AO", "bsdf", 128)]
        per: dict = {c: [] for c, *_ in plan}
        timings = {}
        load_before = os.getloadavg()[0]
        for n, (kind, hi, lo) in enumerate(pairs):
            for o in scene.objects:
                o.hide_render = o not in (hi, lo)
                o.hide_set(o not in (hi, lo))
                o.select_set(o in (hi, lo))
            bpy.context.view_layer.objects.active = lo
            for chan, btype, route, samples in plan:
                surface(route)
                img = bpy.data.images.new(f"{PIECE}_{n}_{chan}", ATLAS, ATLAS, alpha=True, float_buffer=True)
                img.colorspace_settings.name = "Non-Color"
                img.generated_color = (0.0, 0.0, 0.0, 0.0)
                tex = nt.nodes.new("ShaderNodeTexImage")
                tex.image = img
                nt.nodes.active = tex
                scene.cycles.samples = samples
                kwargs = {"normal_space": "TANGENT"} if btype == "NORMAL" else {}
                started = time.monotonic()
                bpy.ops.object.bake(type=btype, use_selected_to_active=True, cage_extrusion=0.004, max_ray_distance=0.012,
                                    margin=0, use_clear=True, target="IMAGE_TEXTURES", **kwargs)
                timings[f"{lo.name}.{chan}"] = round(time.monotonic() - started, 2)
                nt.nodes.remove(tex)
                per[chan].append(lm.image_rgba(img))
        for o in scene.objects:
            o.hide_render = False
            o.hide_set(False)
        surface("bsdf")
        # Composite the three props, each only inside its own rasterized UV islands (the bake's alpha
        # is not a coverage mask), and dilate into the gutters.
        masks = [uv_mask(o, np) for o in bake_lows]
        overlap = int(sum((masks[i] & masks[j]).sum() for i in range(len(masks)) for j in range(i + 1, len(masks))))
        if overlap:
            raise RuntimeError(f"UV islands of different bake targets overlap on {overlap} texels")
        cover = np.logical_or.reduce(masks)
        comp = {}
        for chan, images in per.items():
            acc = np.zeros((ATLAS, ATLAS, 3), dtype=np.float32)
            for im, m in zip(images, masks):
                acc[m] = im[..., :3][m]
            comp[chan] = acc
        per_kind_ao = {k: round(float(comp["ao"][..., 0][np.logical_or.reduce([m for (kk, _, _), m in zip(pairs, masks) if kk == k])].mean()), 4)
                       for k in KINDS}
        filled = cover.copy()
        for _ in range(MARGIN_PX):
            grow = np.zeros_like(filled)
            sums = {c: np.zeros_like(a) for c, a in comp.items()}
            counts = np.zeros((ATLAS, ATLAS), dtype=np.float32)
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    sf = np.roll(np.roll(filled, dy, 0), dx, 1)
                    counts += sf
                    for c, a in comp.items():
                        sums[c] += np.roll(np.roll(a, dy, 0), dx, 1) * sf[..., None]
            grow = (~filled) & (counts > 0)
            for c in comp:
                comp[c][grow] = sums[c][grow] / counts[grow][:, None]
            filled |= grow
        normal = np.clip(comp["normal"], 0, 1)
        normal[~filled] = (0.5, 0.5, 1.0)
        ao = np.clip(comp["ao"][..., 0], 0, 1)
        ao[~filled] = 1.0
        rough = np.clip(comp["rough"][..., 0], 0.04, 1)
        rough[~filled] = 0.8
        metal = np.clip(comp["metal"][..., 0], 0, 1)
        albedo = np.clip(comp["albedo"], 0, 1)
        emit = np.clip(comp["emit"], 0, 1)
        out = {
            "basecolor": np.round(lm.srgb_encode(albedo) * 255).astype(np.uint8),
            "normal": np.round(normal * 255).astype(np.uint8),
            "orm": np.round(np.stack([ao, rough, metal], axis=-1) * 255).astype(np.uint8),
            "emissive": np.round(lm.srgb_encode(emit) * 255).astype(np.uint8),
        }
        for chan, arr in out.items():
            path = STAGING / f"{PIECE}.{chan}.png"
            lm.write_png_rgb(path, arr)
            maps[chan] = path
        report["bake"] = {
            "size": ATLAS, "device": report["device"], "cage_extrusion_m": 0.004, "max_ray_distance_m": 0.012,
            "ao_distance_m": 0.03, "margin_px": MARGIN_PX, "samples": {c: s for c, _, _, s in plan},
            "passes": "base colour, roughness, metallic and emission as EMIT passes of each channel; NORMAL tangent; AO",
            "seconds": timings, "seconds_total": round(sum(timings.values()), 1),
            "load1_before": round(load_before, 2), "load1_after": round(os.getloadavg()[0], 2),
            "coverage": round(float(cover.mean()), 4),
            "ao_mean": round(float(ao[cover].mean()), 4), "ao_mean_per_kind": per_kind_ao,
            "uv_overlap_texels": overlap, "ao_p05": round(float(np.percentile(ao[cover], 5)), 4),
            "rough_mean": round(float(rough[cover].mean()), 4),
            "metal_fraction": round(float((metal[cover] > 0.5).mean()), 4),
            "emissive_fraction": round(float((emit[cover].max(axis=1) > 0.1).mean()), 4),
            "albedo_mean_srgb8": [round(float(v), 1) for v in out["basecolor"][cover].mean(axis=0)],
            "normal_mean": [round(float(v), 4) for v in normal[cover].mean(axis=0)],
        }
        print("bake", json.dumps(report["bake"]))
        # Low atlas material for the .blend, renders and the reimport.
        nt = atlas.node_tree
        bsdf = bsdf_of(atlas)
        img = {c: bpy.data.images.load(str(p), check_existing=True) for c, p in maps.items()}
        for c in ("normal", "orm"):
            img[c].colorspace_settings.name = "Non-Color"
        tex = {}
        for c, im in img.items():
            t = nt.nodes.new("ShaderNodeTexImage")
            t.image = im
            tex[c] = t
        nt.links.new(tex["basecolor"].outputs["Color"], bsdf.inputs["Base Color"])
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(tex["orm"].outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(tex["normal"].outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
        nt.links.new(tex["emissive"].outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = EMISSIVE_INTENSITY

    highs = {k: join(k, True) for k in KINDS}
    lows = {k: join(k, False) for k in KINDS}
    tris, geo = check_geometry(highs, lows)
    report["triangles"] = tris
    report["geometry"] = geo

    # -- export ----------------------------------------------------------------------------
    glb = RUNTIME / f"{PIECE}.glb"
    bpy.ops.object.select_all(action="DESELECT")
    for o in lows.values():
        o.select_set(True)
    bpy.context.view_layer.objects.active = lows["candle"]
    bpy.ops.export_scene.gltf(filepath=str(glb), export_format="GLB", use_selection=True, use_active_scene=True,
                              export_texcoords=True, export_normals=True, export_tangents=False, export_materials="EXPORT",
                              export_image_format="NONE", export_cameras=False, export_lights=False, export_apply=True,
                              export_extras=False)
    report["glb_sha256"] = sha256(glb)

    encodes = {}
    if maps:
        tool = subprocess.run([str(KTX), "--version"], capture_output=True, text=True, check=True).stdout.strip()
        for chan, png in maps.items():
            out = RUNTIME / f"{PIECE}.{chan}.ktx2"
            color = chan in ("basecolor", "emissive")
            cmd = [str(KTX), "create", "--format", "R8G8B8_SRGB" if color else "R8G8B8_UNORM", "--assign-tf", "srgb" if color else "linear",
                   "--encode", "uastc", "--uastc-quality", "2", "--zstd", "18", "--generate-mipmap"]
            if chan == "normal":
                cmd.append("--normalize")
            subprocess.run([*cmd, str(png), str(out)], check=True)
            encodes[out.name] = " ".join(cmd[1:])
        report["ktx2"] = {"tool": tool, "encodes": encodes}

    manifest = {
        "id": PIECE,
        "glb": glb.name,
        "material": PIECE,
        "maps": {c: f"{PIECE}.{c}.ktx2" for c in ("basecolor", "normal", "orm", "emissive")},
        "texturePx": ATLAS,
        "emissiveIntensity": EMISSIVE_INTENSITY,
        "envMapIntensity": ENV_INTENSITY,
        "kinds": {k: {"node": f"{PIECE}_{k}", "tris": tris[k]["low"], "radius": geo[k]["radius_low"],
                      "reservedRadius": RESERVED_RADIUS[k], "height": geo[k]["height_low"]} for k in KINDS},
        "budget": {"trisPerKindMax": LIMIT_TRIS, "materials": 1, "textures": 4},
        "frame": "runtime +Y up; each node's origin is the prop's base centre, standing on the table top",
    }
    (RUNTIME / f"{PIECE}.manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    # -- .blend sources --------------------------------------------------------------------
    def save_only(objs: list, path: Path) -> None:
        others = [o for o in scene.objects if o not in objs]
        for o in others:
            scene.collection.objects.unlink(o)
        bpy.ops.wm.save_as_mainfile(filepath=str(path), copy=True, compress=True)
        for o in others:
            scene.collection.objects.link(o)

    save_only(list(highs.values()), BLEND_DIR / f"{PIECE}.high.blend")
    save_only(list(lows.values()), BLEND_DIR / f"{PIECE}.low.blend")

    # -- renders ---------------------------------------------------------------------------
    renders = []
    if not args.skip_renders:
        renders = render_all(bpy, scene, highs, lows, STAGING / "renders")
    report["renders"] = renders

    # -- reimport (fresh scene) -------------------------------------------------------------
    report["reimport"] = reimport(bpy, glb, manifest)
    report["seconds"] = round(time.monotonic() - t0, 1)
    report["load1_at_end"] = os.getloadavg()[0]
    report["files"] = {p.name: sha256(p) for p in sorted(RUNTIME.iterdir())}
    (STAGING / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print("done", report["seconds"], "s")


def uv_mask(obj, np):
    """Texels whose centres fall inside the object's UV triangles (row 0 at the top), grown by one
    texel so edge texels the bake wrote are kept."""
    uv = obj.data.uv_layers["UVMap"].data
    mask = np.zeros((ATLAS, ATLAS), dtype=bool)
    for poly in obj.data.polygons:
        pts = [(uv[li].uv.x * ATLAS, (1.0 - uv[li].uv.y) * ATLAS) for li in poly.loop_indices]
        for k in range(1, len(pts) - 1):
            (ax, ay), (bx, by), (cx, cy) = pts[0], pts[k], pts[k + 1]
            x0, x1 = int(max(0, math.floor(min(ax, bx, cx)))), int(min(ATLAS - 1, math.ceil(max(ax, bx, cx))))
            y0, y1 = int(max(0, math.floor(min(ay, by, cy)))), int(min(ATLAS - 1, math.ceil(max(ay, by, cy))))
            if x1 < x0 or y1 < y0:
                continue
            xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
            d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
            if abs(d) < 1e-12:
                continue
            w1 = ((xs - ax) * (cy - ay) - (cx - ax) * (ys - ay)) / d
            w2 = ((bx - ax) * (ys - ay) - (xs - ax) * (by - ay)) / d
            inside = (w1 >= -1e-6) & (w2 >= -1e-6) & (w1 + w2 <= 1 + 1e-6)
            mask[y0:y1 + 1, x0:x1 + 1] |= inside
    grown = mask.copy()
    grown[1:, :] |= mask[:-1, :]
    grown[:-1, :] |= mask[1:, :]
    grown[:, 1:] |= mask[:, :-1]
    grown[:, :-1] |= mask[:, 1:]
    return grown


def render_all(bpy, scene, highs: dict, lows: dict, rdir: Path) -> list[str]:
    from mathutils import Vector
    for cand in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            scene.render.engine = cand
            break
        except TypeError:
            continue
    scene.render.resolution_x = scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "AgX"
    scene.render.image_settings.file_format = "PNG"
    scene.eevee.taa_render_samples = 64
    world = bpy.data.worlds.new(f"{PIECE}_review_world")
    world.color = (0.035, 0.024, 0.016)
    bg = next((n for n in world.node_tree.nodes if n.type == "BACKGROUND"), None) if world.node_tree else None
    if bg is not None:
        bg.inputs["Color"].default_value = (0.035, 0.024, 0.016, 1.0)
        bg.inputs["Strength"].default_value = 1.0
    scene.world = world
    # A walnut-dark board under the props and a warm key, a dim fill and a rim.
    bpy.ops.mesh.primitive_plane_add(size=1.2, location=(0, 0, 0))
    board = bpy.context.active_object
    board.name = f"{PIECE}_review_board"
    bm = bpy.data.materials.new(f"{PIECE}_review_walnut")
    b = next(n for n in bm.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = (*hexl("#583C26"), 1.0)
    b.inputs["Roughness"].default_value = 0.6
    board.data.materials.append(bm)
    for name, loc, energy, color in (("key", (0.5, -0.6, 0.7), 18.0, (1.0, 0.78, 0.55)), ("fill", (-0.7, -0.3, 0.4), 4.0, (1.0, 0.85, 0.7)),
                                     ("rim", (-0.2, 0.7, 0.6), 8.0, (1.0, 0.7, 0.45))):
        ld = bpy.data.lights.new(f"{PIECE}_{name}", "AREA")
        ld.energy = energy
        ld.color = color
        ld.size = 0.3
        lo = bpy.data.objects.new(ld.name, ld)
        lo.location = loc
        lo.rotation_euler = (Vector((0, 0, 0.1)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(lo)
    cd = bpy.data.cameras.new(f"{PIECE}_cam")
    cam = bpy.data.objects.new(cd.name, cd)
    scene.collection.objects.link(cam)
    scene.camera = cam
    out = []

    def shoot(path: Path, visible: list, target, dist: float, height: float, lens: float = 85.0) -> None:
        for o in list(highs.values()) + list(lows.values()):
            o.hide_render = o not in visible
        cd.lens = lens
        cam.location = Vector((target[0] + dist * 0.62, target[1] - dist * 0.78, height))
        cam.rotation_euler = (Vector(target) - cam.location).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        out.append(str(path.relative_to(ROOT)))

    centre = {"candle": (0, 0, 0.1), "books": (0, 0, 0.045), "vase": (0, 0, 0.11)}
    for k in KINDS:
        for o in list(highs.values()) + list(lows.values()):
            o.location = (0, 0, 0)
        shoot(rdir / f"{k}-high.png", [highs[k]], centre[k], 0.55, centre[k][2] + 0.18)
        shoot(rdir / f"{k}-low.png", [lows[k]], centre[k], 0.55, centre[k][2] + 0.18)
    # The set together, as on a bench top.
    spots = {"candle": (-0.17, 0.02), "books": (0.0, 0.03), "vase": (0.17, 0.0)}
    for k, (x, y) in spots.items():
        lows[k].location = (x, y, 0)
        highs[k].location = (x, y, 0)
    shoot(rdir / "set-low.png", list(lows.values()), (0, 0, 0.08), 0.95, 0.42, 60.0)
    shoot(rdir / "set-high.png", list(highs.values()), (0, 0, 0.08), 0.95, 0.42, 60.0)
    for o in list(highs.values()) + list(lows.values()):
        o.location = (0, 0, 0)
        o.hide_render = False
    return out


def reimport(bpy, glb: Path, manifest: dict) -> dict:
    """Checks the shipped GLB from its bytes, then imports it into an empty scene."""
    data = glb.read_bytes()
    jl = struct.unpack_from("<I", data, 12)[0]
    g = json.loads(data[20:20 + jl])
    nodes = {n["name"]: n for n in g.get("nodes", [])}
    per = {}
    for k, entry in manifest["kinds"].items():
        n = nodes.get(entry["node"])
        if n is None or "mesh" not in n:
            per[k] = None
            continue
        prims = g["meshes"][n["mesh"]]["primitives"]
        per[k] = {"tris": sum(g["accessors"][p["indices"]]["count"] // 3 for p in prims),
                  "attributes": sorted(prims[0]["attributes"]),
                  "identity": not any(key in n for key in ("translation", "rotation", "scale", "matrix"))}
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    bpy.ops.import_scene.gltf(filepath=str(glb))
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    checks = {
        "three_prop_nodes": all(per.get(k) for k in KINDS),
        "tris_le_600_each": all(per[k] and per[k]["tris"] <= LIMIT_TRIS for k in KINDS),
        "tris_match_manifest": all(per[k] and per[k]["tris"] == manifest["kinds"][k]["tris"] for k in KINDS),
        "one_material": len(g.get("materials", [])) == 1,
        "image_free": not g.get("images") and not g.get("textures"),
        "single_sided": not any(m.get("doubleSided") for m in g.get("materials", [])),
        "uv0_normals_only": all(per[k] and per[k]["attributes"] == ["NORMAL", "POSITION", "TEXCOORD_0"] for k in KINDS),
        "identity_nodes": all(per[k] and per[k]["identity"] for k in KINDS),
        "blender_reimport": len(meshes) == 3,
    }
    result = {"glb": glb.name, "glb_sha256": sha256(glb), "glb_bytes": len(data), "blender": bpy.app.version_string,
              "per_kind": per, "materials": [m.get("name") for m in g.get("materials", [])], "checks": checks,
              "pass": all(checks.values())}
    (STAGING / "reimport.json").write_text(json.dumps(result, indent=2) + "\n")
    print("reimport", json.dumps(checks))
    if not result["pass"]:
        raise RuntimeError(f"reimport gate failed: {checks}")
    return result


# ---------------------------------------------------------------------------------------------
# Review sheet (system Python + Pillow)
# ---------------------------------------------------------------------------------------------


def compose_sheet() -> Path:
    from PIL import Image, ImageDraw, ImageFont

    rdir = STAGING / "renders"
    engine = sorted((SRC / "engine").glob("*.jpg")) if (SRC / "engine").exists() else []
    rows: list[list[tuple[Path, str]]] = [
        [(STYLE_BOARD, "Reference: L-board-1 style board (Gilded Lamplight)"), (rdir / "set-high.png", "High, EEVEE, the set"),
         (rdir / "set-low.png", "Low + baked 1024 px atlas, same camera")],
    ]
    for k in KINDS:
        rows.append([(rdir / f"{k}-high.png", f"{k}: high, EEVEE"), (rdir / f"{k}-low.png", f"{k}: low + atlas, same camera"),
                     (STAGING / f"{PIECE}.basecolor.png", "Shared atlas: base colour") if k == "candle" else
                     (STAGING / f"{PIECE}.normal.png", "Shared atlas: tangent normal") if k == "books" else
                     (STAGING / f"{PIECE}.orm.png", "Shared atlas: ORM")])
    for i in range(0, len(engine), 3):
        rows.append([(p, f"In engine: {p.stem}") for p in engine[i:i + 3]])
    cell_w, cell_h, pad, cap = 520, 390, 12, 28
    w = 3 * cell_w + 4 * pad
    h = 60 + len(rows) * (cell_h + cap + pad)
    sheet = Image.new("RGB", (w, h), (24, 20, 18))
    d = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 18)
        big = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 24)
    except OSError:
        font = big = ImageFont.load_default()
    d.text((pad, 16), "table-decor: candle, book stack, vase (creative, owner and independent gates pending)", fill=(240, 220, 180), font=big)
    y = 60
    for row in rows:
        for i, (path, label) in enumerate(row):
            x = pad + i * (cell_w + pad)
            if path.exists():
                im = Image.open(path).convert("RGB")
                im.thumbnail((cell_w, cell_h))
                sheet.paste(im, (x + (cell_w - im.width) // 2, y + (cell_h - im.height) // 2))
            else:
                d.text((x + 10, y + 10), f"missing {path.name}", fill=(255, 80, 80), font=font)
            d.text((x, y + cell_h + 4), label, fill=(230, 210, 170), font=font)
        y += cell_h + cap + pad
    out = SRC / f"{PIECE}.review-sheet.jpg"
    sheet.save(out, quality=88)
    print(f"wrote {out}")
    return out


if __name__ == "__main__":
    a = parse_args()
    if a.sheet:
        compose_sheet()
    else:
        blender_main(a)
