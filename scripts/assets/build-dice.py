"""P5-T7 dice models: the brass d6 and the glass d8 (docs/art-bible.md: brass bodies with walnut or
enamel faces and amber pips or numerals). Both are built procedurally, with no provider generation.

- brass-d6: a 40 mm cube with rounded brass edges (radius 2.5 mm) and a walnut panel inlaid 0.6 mm
  into each face. The panel samples the shared P5-T6 UI atlas page `dice-d6` (walnut field and amber
  pips); the painted brass frame of the atlas cell is left out, because the modelled brass rim is
  the frame.
- glass-d8: an octahedron of circumradius 26 mm whose eight facets sample the atlas page `dice-d8`
  (painted glass, brass edge and amber numeral) through a cheap faked glass: alpha-blended, no
  transmission, emissive numerals. A brass cog and axle sit inside as the core.

The GLBs are image-free: face UVs point into the shared atlas cells (`public/assets/ui/ui-atlas.json`),
and `src/dice/dice-asset.ts` binds the atlas page that the UI already keeps resident. Brass slots are
named after the approved P4-T3 set `brass-polished` (UV0 in tile units, metres / 0.5) so the runtime
may bind it by name; otherwise the GLB factors are the look.

The die-local frame is `src/dice/faces.ts`: runtime +Y up, origin at the die centre, collider sizes
D6_HALF_EXTENT = 0.02 and D8_CIRCUMRADIUS = 0.026. Face `i` (value i + 1) has the outward normal
`faces.ts` lists for index `i`; the GLB root node's extras and the manifest record that table.

Blender run (build, gate, manifest, .blend sources, renders):
    "$BLENDER" -b --factory-startup --python-exit-code 1 -P scripts/assets/build-dice.py -- \
        [--out-root assets-source/dice] [--runtime-root public/assets/dice] [--skip-renders]
Review sheet (system Python with Pillow, after the Blender run and the engine stills):
    python3 -I scripts/assets/build-dice.py --sheet

Frame: Blender is Z-up; runtime (x, y, z) = Blender (x, z, -y). Geometry is authored in runtime
coordinates and converted once, in `to_blender`.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import struct
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ATLAS_JSON = REPO / "public/assets/ui/ui-atlas.json"
ATLAS_DIR = REPO / "public/assets/ui"
STYLE_BOARD = REPO / "assets-source/style/locked/L-board-1.png"
SENTRY_GENERATOR = REPO / "scripts/assets/build-cog-sentry.py"
DEFAULT_OUT_ROOT = REPO / "assets-source/dice"
DEFAULT_RUNTIME_ROOT = REPO / "public/assets/dice"

LIMITS = {"tris": 1500, "materials": 2, "texture_px": 512}
TILE_METERS = 0.5  # brass-polished tiles at 0.5 m (public/assets/materials/materials.json)
INV_SQRT3 = 1.0 / math.sqrt(3.0)

# faces.ts, verbatim: D6 normals by face index, D8 sign bits (i & 4 -> x, i & 2 -> y, i & 1 -> z).
D6_HALF = 0.02
D8_R = 0.026
D6_NORMALS = [(0, 1, 0), (1, 0, 0), (0, 0, 1), (0, 0, -1), (-1, 0, 0), (0, -1, 0)]
D8_NORMALS = [((-1 if i & 4 else 1) * INV_SQRT3, (-1 if i & 2 else 1) * INV_SQRT3, (-1 if i & 1 else 1) * INV_SQRT3) for i in range(8)]

D6_BEVEL = 0.0025  # edge radius (m)
D6_RECESS = 0.0006  # walnut panel depth below the face plane (m)
D6_PANEL_HALF = 0.0128  # panel half-width (m): leaves a 4.7 mm brass rim inside the bevel
# Walnut field of every 256 px d6 atlas cell, in cell pixels (origin top-left): a square centred on
# the painted pips (cell centre 128, 128) and inside the painted frame's inner edge (x 24..206).
D6_ART_PX = (53.0, 203.0)

D8_CORE = {"teeth": 10, "r_root": 0.0062, "r_tip": 0.0085, "half_thick": 0.0014, "axle_r": 0.0012, "axle_half": 0.011}

DIE = {
    "brass-d6": {"kind": "d6", "page": "dice-d6", "values": [1, 2, 3, 4, 5, 6], "normals": D6_NORMALS,
                 "mats": ["brass-polished", "brass-d6-face"]},
    "glass-d8": {"kind": "d8", "page": "dice-d8", "values": [1, 2, 3, 4, 5, 6, 7, 8], "normals": D8_NORMALS,
                 "mats": ["brass-polished", "glass-d8-face"]},
}
BRASS, FACE = 0, 1
DETAIL = {"low": {"bevel_steps": 3, "axle_sides": 8}, "high": {"bevel_steps": 8, "axle_sides": 24}}

# Runtime face-material parameters, shipped in the manifest (dice-asset.ts applies them).
FACE_SLOTS = {
    "brass-d6-face": {"roughness": 0.55, "metalness": 0.0, "emissiveIntensity": 0.35, "transparent": False, "opacity": 1.0},
    "glass-d8-face": {"roughness": 0.12, "metalness": 0.0, "emissiveIntensity": 0.7, "transparent": True, "opacity": 0.86},
}
BRASS_FACTORS = ((0xDE, 0xC1, 0x6A), 0.3, 1.0)  # polished brass mid tone (art bible), roughness, metallic


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_args() -> argparse.Namespace:
    in_blender = "-P" in sys.argv or "--python" in sys.argv
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else ([] if in_blender else sys.argv[1:])
    p = argparse.ArgumentParser()
    p.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    p.add_argument("--runtime-root", type=Path, default=DEFAULT_RUNTIME_ROOT)
    p.add_argument("--skip-renders", action="store_true")
    p.add_argument("--only", choices=sorted(DIE), action="append")
    p.add_argument("--sheet", action="store_true", help="compose the review sheet (system Python)")
    return p.parse_args(argv)


def sentry_helpers():
    """read_glb and canonicalize_indices from the cog-sentry generator (hashed as a dependency)."""
    spec = importlib.util.spec_from_file_location("build_cog_sentry", SENTRY_GENERATOR)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


# --------------------------------------------------------------------------------------------------
# Small vector helpers (runtime frame)


def add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def mul(a, s: float):
    return (a[0] * s, a[1] * s, a[2] * s)


def dot(a, b) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def norm(a):
    length = math.sqrt(dot(a, a))
    return (a[0] / length, a[1] / length, a[2] / length)


def to_blender(v):
    return (v[0], -v[2], v[1])


def to_runtime(v):
    return (v[0], v[2], -v[1])


def d6_up(n) -> tuple:
    """Art 'up' on d6 face `n`: +Y on the sides, -Z on the top, +Z on the bottom (runtime)."""
    if n[1] > 0.5:
        return (0, 0, -1)
    if n[1] < -0.5:
        return (0, 0, 1)
    return (0, 1, 0)


# --------------------------------------------------------------------------------------------------
# Geometry: lists of polygons in runtime coordinates. Each polygon is (verts, material, tag, smooth),
# tag = ("panel", face) | ("brass", None) | ("facet", face).


def build_d6(detail: str) -> list:
    steps = DETAIL[detail]["bevel_steps"]
    h, r = D6_HALF, D6_BEVEL
    c = h - r
    # Grid coordinates along one face axis: bevel samples at equal angles up to 45 degrees (the
    # neighbouring face's grid covers 45..90), then the flat span.
    tans = [r * math.tan(math.radians(45.0 * k / steps)) for k in range(1, steps + 1)]
    coords = [-(c + t) for t in reversed(tans)] + [-c, c] + [c + t for t in tans]
    polys = []
    for face, n in enumerate(D6_NORMALS):
        up = d6_up(n)
        right = cross(up, n)

        def point(u: float, v: float, depth: float = 0.0, n=n, up=up, right=right):
            p = add(add(mul(right, u), mul(up, v)), mul(n, h))
            if depth:
                return sub(p, mul(n, depth))  # recessed panel: flat, inside the rim
            # Round onto the bevel: clamp to the core box, then sit at radius r along the offset.
            q = tuple(max(-c, min(c, x)) for x in p)
            off = sub(p, q)
            return add(q, mul(off, r / math.sqrt(dot(off, off))))

        last = len(coords) - 1
        mid = coords.index(-c)
        for i in range(last):
            for j in range(last):
                if i == mid and j == mid:
                    continue  # flat centre, built below as rim + walls + panel
                quad = [point(coords[i], coords[j]), point(coords[i + 1], coords[j]),
                        point(coords[i + 1], coords[j + 1]), point(coords[i], coords[j + 1])]
                polys.append((quad, BRASS, ("brass", None), True))
        o = [point(-c, -c), point(c, -c), point(c, c), point(-c, c)]
        p = D6_PANEL_HALF
        top = [point(-p, -p), point(p, -p), point(p, p), point(-p, p)]
        low = [point(-p, -p, D6_RECESS), point(p, -p, D6_RECESS), point(p, p, D6_RECESS), point(-p, p, D6_RECESS)]
        for k in range(4):
            polys.append(([o[k], o[(k + 1) % 4], top[(k + 1) % 4], top[k]], BRASS, ("brass", None), False))
            polys.append(([top[k], top[(k + 1) % 4], low[(k + 1) % 4], low[k]], BRASS, ("brass", None), False))
        polys.append((low, FACE, ("panel", face), False))
    return polys


def d8_face_corners(face: int):
    """Corners of d8 face `face`, counter-clockwise from outside, starting at the pole (the ±Y
    vertex), which carries the apex of the atlas triangle."""
    n = D8_NORMALS[face]
    sx, sy, sz = (1 if n[0] > 0 else -1, 1 if n[1] > 0 else -1, 1 if n[2] > 0 else -1)
    apex, a, b = (0.0, sy * D8_R, 0.0), (sx * D8_R, 0.0, 0.0), (0.0, 0.0, sz * D8_R)
    if dot(cross(sub(a, apex), sub(b, apex)), n) < 0:
        a, b = b, a
    return [apex, a, b]


def build_d8(detail: str) -> list:
    polys = [(d8_face_corners(face), FACE, ("facet", face), False) for face in range(8)]
    g = D8_CORE
    # Cog in the runtime XZ plane (axis +Y), flat-shaded; caps are explicit fans, so triangulation is fixed.
    ring = []
    teeth = g["teeth"]
    for t in range(teeth):
        a0 = 2 * math.pi * t / teeth
        step = 2 * math.pi / teeth
        for frac, rad in ((0.0, g["r_root"]), (0.18, g["r_tip"]), (0.5, g["r_tip"]), (0.68, g["r_root"])):
            ang = a0 + frac * step
            ring.append((rad * math.cos(ang), rad * math.sin(ang)))
    polys += prism(ring, g["half_thick"])
    sides = DETAIL[detail]["axle_sides"]
    axle = [(g["axle_r"] * math.cos(2 * math.pi * k / sides), g["axle_r"] * math.sin(2 * math.pi * k / sides)) for k in range(sides)]
    polys += prism(axle, g["axle_half"])
    return polys


def prism(ring: list, half: float) -> list:
    """A Y-axis prism over a star-shaped ring of runtime (x, z) points in increasing angle from +X
    toward +Z, with fan caps (fixed triangulation). Windings face outward."""
    out = []
    top = [(x, half, z) for x, z in ring]
    bot = [(x, -half, z) for x, z in ring]
    ct, cb = (0.0, half, 0.0), (0.0, -half, 0.0)
    m = len(ring)
    for k in range(m):
        k1 = (k + 1) % m
        out.append(([ct, top[k1], top[k]], BRASS, ("brass", None), False))
        out.append(([cb, bot[k], bot[k1]], BRASS, ("brass", None), False))
        out.append(([top[k], top[k1], bot[k1], bot[k]], BRASS, ("brass", None), False))
    return out


# --------------------------------------------------------------------------------------------------
# UVs


def load_atlas() -> dict:
    return json.loads(ATLAS_JSON.read_text())


def cell(atlas: dict, die: str, face: int) -> dict:
    return next(f for f in atlas["dice"][die]["faces"] if f["index"] == face)


def page_size(atlas: dict, die: str) -> tuple:
    page = atlas["pages"][DIE[die]["page"]]
    return page["width"], page["height"]


def panel_uv(atlas: dict, die: str, face: int, pos) -> tuple:
    n = D6_NORMALS[face]
    up = d6_up(n)
    right = cross(up, n)
    p = D6_PANEL_HALF
    fx = (dot(pos, right) + p) / (2 * p)
    fy = (p - dot(pos, up)) / (2 * p)  # 0 at the top edge, image rows go down
    x0, x1 = D6_ART_PX
    entry = cell(atlas, die, face)
    w, hgt = page_size(atlas, die)
    px = entry["px"]["x"] + (x0 + fx * (x1 - x0)) * entry["px"]["w"] / 256.0
    py = entry["px"]["y"] + (x0 + fy * (x1 - x0)) * entry["px"]["h"] / 256.0
    return (px / w, 1.0 - py / hgt)


def facet_uvs(atlas: dict, die: str, face: int) -> list:
    """Atlas triangle for d8 face `face`, in the corner order of `d8_face_corners` (apex, then the
    bottom-left and bottom-right corners as seen from outside)."""
    tri = atlas["dice"][die]["triangle"]  # [apex, bottom-right, bottom-left] in slot 0..1, y down
    uv = cell(atlas, die, face)["uv"]
    order = [tri[0], tri[2], tri[1]]
    return [(uv["u0"] + tx * (uv["u1"] - uv["u0"]), uv["v1"] - ty * (uv["v1"] - uv["v0"])) for tx, ty in order]


def brass_uv(pos, normal) -> tuple:
    ax = max(range(3), key=lambda k: abs(normal[k]))
    a, b = [k for k in range(3) if k != ax]
    return (pos[a] / TILE_METERS, pos[b] / TILE_METERS)


# --------------------------------------------------------------------------------------------------
# Blender mesh


def make_mesh(bpy, bmesh, name: str, polys: list, atlas: dict, die: str, mats: list):
    bm = bmesh.new()
    smooth_layer = bm.faces.layers.int.new("smooth")
    tag_layer = bm.faces.layers.int.new("tag")  # -1 brass, else face index
    cache: dict = {}

    def vert(p):
        key = tuple(round(x, 9) for x in p)
        v = cache.get(key)
        if v is None:
            v = bm.verts.new(to_blender(p))
            cache[key] = v
        return v

    for verts, mat, tag, smooth in polys:
        f = bm.faces.new([vert(p) for p in verts])
        f.material_index = mat
        f[smooth_layer] = 1 if smooth else 0
        f[tag_layer] = -1 if tag[1] is None else tag[1]
    bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method="FIXED", ngon_method="EAR_CLIP")
    bm.normal_update()
    uv_layer = bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        f.smooth = bool(f[smooth_layer])
        tag = f[tag_layer]
        fn = to_runtime(tuple(f.normal))
        if DIE[die]["kind"] == "d8" and f.material_index == FACE:
            corners = d8_face_corners(tag)
            uvs = facet_uvs(atlas, die, tag)
            for loop in f.loops:
                p = to_runtime(tuple(loop.vert.co))
                k = min(range(3), key=lambda i: sum((p[j] - corners[i][j]) ** 2 for j in range(3)))
                loop[uv_layer].uv = uvs[k]
        else:
            for loop in f.loops:
                p = to_runtime(tuple(loop.vert.co))
                loop[uv_layer].uv = panel_uv(atlas, die, tag, p) if f.material_index == FACE else brass_uv(p, fn)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for a in ("smooth", "tag"):
        if a in me.attributes:
            me.attributes.remove(me.attributes[a])
    for m in mats:
        me.materials.append(m)
    obj = bpy.data.objects.new(name, me)
    return obj


def export_materials(bpy, die: str) -> list:
    out = []
    for name in DIE[die]["mats"]:
        m = bpy.data.materials.new(f"{name}")
        m.use_backface_culling = True  # exported as single-sided: a double-sided glass shell shows mirrored numerals
        p = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        if name == "brass-polished":
            (rgb, rough, metal) = BRASS_FACTORS
            p.inputs["Base Color"].default_value = (*[srgb_to_linear(c / 255) for c in rgb], 1.0)
            p.inputs["Roughness"].default_value = rough
            p.inputs["Metallic"].default_value = metal
        else:
            s = FACE_SLOTS[name]
            p.inputs["Base Color"].default_value = (1.0, 1.0, 1.0, 1.0)
            p.inputs["Roughness"].default_value = s["roughness"]
            p.inputs["Metallic"].default_value = s["metalness"]
            if s["transparent"]:
                p.inputs["Alpha"].default_value = s["opacity"]
                set_blended(m)
        out.append(m)
    return out


def set_blended(m) -> None:
    for attr, value in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
        try:
            setattr(m, attr, value)
        except (AttributeError, TypeError):
            pass


def source_materials(bpy, die: str) -> list:
    """The .blend and review-render materials: export factors plus the atlas page on the face slot."""
    out = []
    img = bpy.data.images.load(str(ATLAS_DIR / f"{DIE[die]['page']}.png"), check_existing=True)
    for name in DIE[die]["mats"]:
        m = bpy.data.materials.new(f"{name}.source")
        m.use_backface_culling = True
        nt = m.node_tree
        p = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
        if name == "brass-polished":
            (rgb, rough, metal) = BRASS_FACTORS
            p.inputs["Base Color"].default_value = (*[srgb_to_linear(c / 255) for c in rgb], 1.0)
            p.inputs["Roughness"].default_value = rough
            p.inputs["Metallic"].default_value = metal
        else:
            s = FACE_SLOTS[name]
            tex = nt.nodes.new("ShaderNodeTexImage")
            tex.image = img
            tex.interpolation = "Linear"
            nt.links.new(tex.outputs["Color"], p.inputs["Base Color"])
            nt.links.new(tex.outputs["Color"], p.inputs["Emission Color"])
            p.inputs["Emission Strength"].default_value = s["emissiveIntensity"]
            p.inputs["Roughness"].default_value = s["roughness"]
            p.inputs["Metallic"].default_value = s["metalness"]
            if s["transparent"]:
                p.inputs["Alpha"].default_value = s["opacity"]
                set_blended(m)
        out.append(m)
    return out


def set_slots(obj, mats: list) -> None:
    for i, m in enumerate(mats):
        obj.data.materials[i] = m


def export_glb(bpy, obj, path: Path) -> None:
    # The low scene holds only the die when this runs (review lights and cameras come later), so
    # the active scene is the selection. select_set() did not stick after read_factory_settings.
    names = [o.name for o in bpy.context.scene.objects]
    assert names == [obj.name], names
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=False,
        use_active_scene=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="NONE",
        export_cameras=False,
        export_lights=False,
        export_skins=False,
        export_animations=False,
        export_extras=False,
        export_apply=False,
        export_yup=True,
    )


# --------------------------------------------------------------------------------------------------
# GLB post-processing (exact analytic bevel normals, canonical indices, face table in node extras)


def glb_parts(path: Path):
    data = path.read_bytes()
    jlen = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20 : 20 + jlen])
    blen = struct.unpack_from("<I", data, 20 + jlen)[0]
    return gltf, bytearray(data[28 + jlen : 28 + jlen + blen])


def glb_write(path: Path, gltf: dict, binary: bytes) -> None:
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    binary = bytes(binary) + b"\0" * (-len(binary) % 4)
    total = 12 + 8 + len(js) + 8 + len(binary)
    out = struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(js), 0x4E4F534A) + js
    out += struct.pack("<II", len(binary), 0x004E4942) + binary
    path.write_bytes(out)


def accessor_view(gltf: dict, binary: bytearray, index: int):
    import numpy as np

    acc = gltf["accessors"][index]
    view = gltf["bufferViews"][acc["bufferView"]]
    ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[acc["type"]]
    dtype = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}[acc["componentType"]]
    assert view.get("byteStride") in (None, ncomp * np.dtype(dtype).itemsize), "interleaved buffer"
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    return start, np.frombuffer(bytes(binary[start : start + acc["count"] * ncomp * np.dtype(dtype).itemsize]), dtype=dtype).reshape(acc["count"], ncomp) if ncomp > 1 else None


def exact_bevel_normals(path: Path, die: str) -> int:
    """Replaces the exporter's averaged normals on the d6 brass bevel with the analytic rounded-box
    normal, so the bytes do not depend on Blender's smoothing. Hard-edged vertices (the panel walls,
    whose normal is nowhere near the analytic one) keep the exporter's flat normals. Returns the
    number of vertices rewritten."""
    import numpy as np

    if DIE[die]["kind"] != "d6":
        return 0
    gltf, binary = glb_parts(path)
    c = D6_HALF - D6_BEVEL
    changed = 0
    for mesh in gltf["meshes"]:
        for prim in mesh["primitives"]:
            if gltf["materials"][prim["material"]]["name"] != "brass-polished":
                continue
            _, pos = accessor_view(gltf, binary, prim["attributes"]["POSITION"])
            nstart, nrm = accessor_view(gltf, binary, prim["attributes"]["NORMAL"])
            pos = pos.astype(np.float64)
            off = pos - np.clip(pos, -c, c)
            length = np.linalg.norm(off, axis=1)
            analytic = off / np.where(length > 0, length, 1.0)[:, None]
            take = (length > 1e-6) & (np.sum(analytic * nrm, axis=1) > 0.5)
            new = nrm.astype(np.float32).copy()
            new[take] = analytic[take].astype(np.float32)
            changed += int(np.count_nonzero(np.any(new != nrm, axis=1)))
            binary[nstart : nstart + new.nbytes] = new.tobytes()
    glb_write(path, gltf, binary)
    return changed


def face_table(die: str) -> list:
    return [{"index": i, "value": v, "normal": [float(x) for x in DIE[die]["normals"][i]]} for i, v in enumerate(DIE[die]["values"])]


def add_extras(path: Path, die: str) -> None:
    gltf, binary = glb_parts(path)
    node = next(n for n in gltf["nodes"] if n.get("name") == die)
    node["extras"] = {"die": {"id": die, "kind": DIE[die]["kind"], "frame": "faces.ts die-local: +Y up, origin at the die centre, metres",
                              "faces": face_table(die)}}
    glb_write(path, gltf, binary)


# --------------------------------------------------------------------------------------------------
# Gate on the shipped bytes (mirrors tests/dice-asset.test.ts)


def gate_glb(path: Path, die: str, atlas: dict, helpers) -> dict:
    import numpy as np

    g, acc = helpers.read_glb(path)
    errors: list[str] = []
    spec = DIE[die]
    mats = [m["name"] for m in g.get("materials", [])]
    if mats != spec["mats"]:
        errors.append(f"materials {mats} != {spec['mats']}")
    if any(m.get("doubleSided") for m in g.get("materials", [])):
        errors.append("materials must be single-sided")
    if g.get("images") or g.get("textures"):
        errors.append("GLB must be image-free")
    nodes = [n for n in g["nodes"] if "mesh" in n]
    if len(nodes) != 1 or nodes[0].get("name") != die:
        errors.append(f"expected one mesh node named {die}")
    node = nodes[0]
    for key, ident in (("translation", [0, 0, 0]), ("rotation", [0, 0, 0, 1]), ("scale", [1, 1, 1])):
        if key in node and any(abs(a - b) > 1e-9 for a, b in zip(node[key], ident)):
            errors.append(f"node {key} {node[key]} is not identity")
    tris = 0
    lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
    per_face: dict = {}
    mirrored = 0
    for prim in g["meshes"][node["mesh"]]["primitives"]:
        if set(prim["attributes"]) != {"POSITION", "NORMAL", "TEXCOORD_0"}:
            errors.append(f"primitive attributes {sorted(prim['attributes'])}")
        pos = acc(prim["attributes"]["POSITION"]).astype(np.float64)
        uv = acc(prim["attributes"]["TEXCOORD_0"]).astype(np.float64).copy()
        uv[:, 1] = 1.0 - uv[:, 1]  # glTF v runs down; atlas rects are bottom-left
        idx = acc(prim["indices"]).astype(np.int64).reshape(-1, 3)
        tris += len(idx)
        lo, hi = np.minimum(lo, pos.min(0)), np.maximum(hi, pos.max(0))
        if mats[prim["material"]] == "brass-polished":
            continue
        a, b, c = pos[idx[:, 0]], pos[idx[:, 1]], pos[idx[:, 2]]
        n = np.cross(b - a, c - a)
        n /= np.linalg.norm(n, axis=1)[:, None]
        ua, ub, uc = uv[idx[:, 0]], uv[idx[:, 1]], uv[idx[:, 2]]
        uv_area = (ub[:, 0] - ua[:, 0]) * (uc[:, 1] - ua[:, 1]) - (ub[:, 1] - ua[:, 1]) * (uc[:, 0] - ua[:, 0])
        mirrored += int(np.count_nonzero(uv_area <= 0))
        cen = (ua + ub + uc) / 3
        for face, normal in enumerate(spec["normals"]):
            hit = n @ np.array(normal) > 0.999
            per_face.setdefault(face, []).extend(cen[hit].tolist())
    if tris > LIMITS["tris"]:
        errors.append(f"{tris} triangles over {LIMITS['tris']}")
    expect = D6_HALF if spec["kind"] == "d6" else D8_R
    if np.max(np.abs(np.abs(lo) - expect)) > 1e-6 or np.max(np.abs(np.abs(hi) - expect)) > 1e-6:
        errors.append(f"bounds {lo.tolist()} .. {hi.tolist()} do not match the collider half extent {expect}")
    if mirrored:
        errors.append(f"{mirrored} face triangles have mirrored UVs")
    faces_ok = {}
    for face in range(len(spec["normals"])):
        uv = cell(atlas, die, face)["uv"]
        cens = per_face.get(face, [])
        inside = [uv["u0"] < u < uv["u1"] and uv["v0"] < v < uv["v1"] for u, v in cens]
        faces_ok[face] = {"triangles": len(cens), "inside_cell": all(inside) and bool(cens)}
        if not faces_ok[face]["inside_cell"]:
            errors.append(f"face {face}: {len(cens)} up-facing triangles, UVs inside atlas cell {face}: {inside}")
    extras = node.get("extras", {}).get("die", {})
    if extras.get("faces") != face_table(die):
        errors.append("node extras face table differs from faces.ts")
    return {
        "glb_sha256": sha256(path),
        "glb_bytes": path.stat().st_size,
        "triangles": tris,
        "materials": mats,
        "bounds": {"min": [round(x, 6) for x in lo.tolist()], "max": [round(x, 6) for x in hi.tolist()]},
        "faces": faces_ok,
        "mirrored_uv_triangles": mirrored,
        "errors": errors,
        "pass": not errors,
    }


def blender_reimport(bpy, path: Path) -> dict:
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(path))
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    out = {"objects": len(new), "meshes": len(meshes), "triangles": sum(len(p.vertices) - 2 for o in meshes for p in o.data.polygons),
           "materials": sorted({m.name.split(".")[0] for o in meshes for m in o.data.materials if m})}
    for o in new:
        bpy.data.objects.remove(o)
    return out


def build_manifest(die: str, gate: dict, atlas: dict) -> dict:
    spec = DIE[die]
    collider = ({"shape": "cuboid", "halfExtent": D6_HALF, "source": "src/dice/faces.ts D6_HALF_EXTENT"} if spec["kind"] == "d6"
                else {"shape": "convexHull", "circumradius": D8_R, "source": "src/dice/faces.ts D8_CIRCUMRADIUS"})
    slots = {"brass-polished": {"role": "body", "set": "brass-polished", "tileMeters": TILE_METERS, "factorOnly": True}}
    face_name = spec["mats"][FACE]
    slots[face_name] = {"role": "face", "atlasPage": spec["page"], **FACE_SLOTS[face_name]}
    faces = []
    for f in face_table(die):
        faces.append({**f, "atlas": {"page": spec["page"], "uv": cell(atlas, die, f["index"])["uv"]}})
    return {
        "id": die,
        "version": 1,
        "kind": spec["kind"],
        "glb": f"{die}.glb",
        "node": die,
        "frame": {"units": "m", "up": "+Y", "origin": "die centre", "convention": "src/dice/faces.ts die-local frame; identity orientation = DicePresenter's",
                  "uv": "TEXCOORD_0 is glTF (v down); loadDice flips v once so face UVs are in the UI atlas's bottom-left texture space"},
        "collider": collider,
        "bounds": gate["bounds"],
        "faces": faces,
        "materialSlots": slots,
        "budget": {"tris": gate["triangles"], "materials": len(gate["materials"]), "texturesProduced": 0,
                   "texturesSampled": [f"ui/{spec['page']} (shared UI atlas page, resident for the UI)"]},
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
    scene.render.resolution_x, scene.render.resolution_y = w, h
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"
    try:
        scene.eevee.taa_render_samples = 32
    except AttributeError:
        pass


def review_stage(bpy, scene, die: str, floor_z: float) -> None:
    from mathutils import Vector

    world = bpy.data.worlds.new(f"{die}-review-world")
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (0.16, 0.11, 0.07, 1.0)
    bg.inputs["Strength"].default_value = 0.6
    scene.world = world
    for name, loc, energy, color in (("key", (-0.2, -0.12, 0.3), 4.0, (1.0, 0.8, 0.55)),
                                     ("fill", (0.24, -0.06, 0.14), 1.2, (1.0, 0.88, 0.72)),
                                     ("rim", (0.06, 0.26, 0.2), 2.6, (1.0, 0.72, 0.42))):
        data = bpy.data.lights.new(f"{die}-{name}", "AREA")
        data.energy, data.color, data.size = energy, color, 0.15
        o = bpy.data.objects.new(data.name, data)
        o.location = loc
        o.rotation_euler = (Vector((0, 0, 0)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(o)
    me = bpy.data.meshes.new(f"{die}-review-floor")
    s = 0.6
    me.from_pydata([(-s, -s, floor_z), (s, -s, floor_z), (s, s, floor_z), (-s, s, floor_z)], [], [(0, 1, 2, 3)])
    mat = bpy.data.materials.new(f"{die}-review-floor")
    next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = (0.09, 0.05, 0.03, 1)
    me.materials.append(mat)
    floor = bpy.data.objects.new(f"{die}-review-floor", me)
    scene.collection.objects.link(floor)


def camera(bpy, scene, loc, target, lens: float = 85.0) -> None:
    from mathutils import Vector

    name = f"{scene.name}-cam"
    cam = bpy.data.objects.get(name)
    if cam is None:
        cam = bpy.data.objects.new(name, bpy.data.cameras.new(name))
        scene.collection.objects.link(cam)
    cam.data.lens = lens
    cam.data.clip_start = 0.005
    cam.location = loc
    cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam


def face_up_quat(die: str, face: int):
    """Blender rotation that puts face `face` up (the presenter's shortest-arc correction)."""
    from mathutils import Vector

    return Vector(to_blender(DIE[die]["normals"][face])).rotation_difference(Vector((0, 0, 1)))


def rest_height(die: str) -> float:
    return D6_HALF if DIE[die]["kind"] == "d6" else D8_R * INV_SQRT3


def render(bpy, scene, path: Path) -> None:
    bpy.context.view_layer.update()
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True, scene=scene.name)


def renders(bpy, die: str, low_scene, high_scene, low, high, rdir: Path) -> list[str]:
    rdir.mkdir(parents=True, exist_ok=True)
    done = []
    z0 = rest_height(die)
    three_q = ((0.11, -0.13, 0.12), (0, 0, 0.0))
    for sc, obj, tag in ((low_scene, low, "low"), (high_scene, high, "high")):
        setup_render(sc)
        review_stage(bpy, sc, f"{die}-{tag}", -z0)
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = face_up_quat(die, 0)
    camera(bpy, low_scene, *three_q)
    render(bpy, low_scene, rdir / "model-low-three-quarter.png")
    done.append("model-low-three-quarter")
    camera(bpy, low_scene, (0.0, -0.035, 0.2), (0, 0, 0))
    render(bpy, low_scene, rdir / "model-low-top.png")
    done.append("model-low-top")
    with bpy.context.temp_override(scene=high_scene, view_layer=high_scene.view_layers[0]):
        camera(bpy, high_scene, *three_q)
        render(bpy, high_scene, rdir / "model-high-three-quarter.png")
    done.append("model-high-three-quarter")
    # Every face up once, in face-index order, left to right: the face-orientation check.
    n = len(DIE[die]["values"])
    gap = 0.06
    dupes = []
    for face in range(n):
        o = low.copy()
        o.name = f"{die}-lineup-{face}"
        o.rotation_mode = "QUATERNION"
        o.rotation_quaternion = face_up_quat(die, face)
        o.location = ((face - (n - 1) / 2) * gap, 0.0, 0.0)
        low_scene.collection.objects.link(o)
        dupes.append(o)
    low.hide_render = True
    camera(bpy, low_scene, (0.0, -0.40, 0.40), (0, 0.0, -0.01), 40.0)
    low_scene.render.resolution_x, low_scene.render.resolution_y = 1280, 480
    render(bpy, low_scene, rdir / "faces-lineup.png")
    done.append("faces-lineup")
    for o in dupes:
        bpy.data.objects.remove(o)
    low.hide_render = False
    return done


# --------------------------------------------------------------------------------------------------
# Review sheet (system Python + Pillow)


def compose_sheet(out_root: Path) -> Path:
    from PIL import Image, ImageDraw

    eng = REPO / "docs/verification"
    rows = []
    for die in DIE:
        r = out_root / die / "staging/renders"
        rows.append((f"{die}: approvals PENDING (technical gate in provenance; creative and owner gates are Paul's)", [
            ("atlas face page (P5-T6)", ATLAS_DIR / f"{DIE[die]['page']}.png"),
            ("Blender low 3/4 (face 1 up)", r / "model-low-three-quarter.png"),
            ("Blender high 3/4 (same camera)", r / "model-high-three-quarter.png"),
            ("Blender low top", r / "model-low-top.png"),
            ("in engine (three.js 0.186.1, Chromium GPU)", eng / f"p5-dice-{die}.jpg"),
        ]))
        rows.append((f"{die}: every face up, face index 0..{len(DIE[die]['values']) - 1} left to right (value = index + 1)", [
            ("Blender lineup", r / "faces-lineup.png"),
            ("engine lineup", eng / f"p5-dice-{die}-lineup.jpg"),
        ]))
    tw, th, pad, cap, head = 330, 330, 10, 24, 30
    cols = 5
    width = cols * (tw + pad) + pad
    height = 46 + len(rows) * (head + th + cap + pad) + pad
    sheet = Image.new("RGB", (width, height), (28, 24, 22))
    d = ImageDraw.Draw(sheet)
    d.text((pad, 14), "P5-T7 dice models - owner review. Reference: docs/art-bible.md (brass bodies, walnut or enamel faces, amber pips or numerals). No approval is self-recorded.", fill=(243, 190, 101))
    y = 46
    for title, tiles in rows:
        d.text((pad, y + 8), title, fill=(243, 190, 101))
        y += head
        tile_w = tw if len(tiles) > 2 else (width - 3 * pad) // 2
        for k, (label, path) in enumerate(tiles):
            x = pad + k * (tile_w + pad)
            if path.exists():
                img = Image.open(path).convert("RGB")
                img.thumbnail((tile_w, th))
                sheet.paste(img, (x + (tile_w - img.width) // 2, y + cap + (th - img.height) // 2))
            else:
                d.text((x + 8, y + cap + 8), f"missing: {path.name}", fill=(200, 80, 80))
            d.text((x, y + 4), label, fill=(222, 193, 106))
        y += th + cap + pad
    path = out_root / "dice.review-sheet.jpg"
    sheet.save(path, quality=88)
    return path


# --------------------------------------------------------------------------------------------------


def build_die(bpy, bmesh, die: str, args, atlas: dict, helpers) -> dict:
    t0 = time.monotonic()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    out = (args.out_root / die / "staging").resolve()
    runtime = (args.runtime_root / die).resolve()
    blend_dir = (args.out_root / die / "blend").resolve()
    for d in (out, runtime, blend_dir):
        d.mkdir(parents=True, exist_ok=True)
    low_scene = bpy.context.scene
    low_scene.name = f"{die}-low"
    high_scene = bpy.data.scenes.new(f"{die}-high")
    builder = build_d6 if DIE[die]["kind"] == "d6" else build_d8
    exp = export_materials(bpy, die)
    src = source_materials(bpy, die)
    low = make_mesh(bpy, bmesh, die, builder("low"), atlas, die, exp)
    low_scene.collection.objects.link(low)
    high = make_mesh(bpy, bmesh, f"{die}-high", builder("high"), atlas, die, src)
    high_scene.collection.objects.link(high)
    tris_low = sum(len(p.vertices) - 2 for p in low.data.polygons)
    tris_high = sum(len(p.vertices) - 2 for p in high.data.polygons)
    print(f"[{die}] tris low={tris_low} high={tris_high}")
    assert tris_low <= LIMITS["tris"], tris_low

    glb = runtime / f"{die}.glb"
    export_glb(bpy, low, glb)
    report = {
        "piece": die,
        "blender": bpy.app.version_string,
        "generator": "scripts/assets/build-dice.py",
        "generator_sha256": sha256(Path(__file__).resolve()),
        "generator_deps": {"scripts/assets/build-cog-sentry.py": sha256(SENTRY_GENERATOR)},
        "atlas": {"manifest": str(ATLAS_JSON.relative_to(REPO)), "sha256": sha256(ATLAS_JSON),
                  "page": str((ATLAS_DIR / f"{DIE[die]['page']}.png").relative_to(REPO)), "page_sha256": sha256(ATLAS_DIR / f"{DIE[die]['page']}.png")},
        "triangles": {"low": tris_low, "high": tris_high},
        "authoringAgent": "Claude Code subagent (claude-opus-5-5), dispatched by the rogue-xr primary session",
    }
    report["exact_bevel_normals"] = exact_bevel_normals(glb, die)
    report["canonicalized_primitives"] = helpers.canonicalize_indices(glb)
    add_extras(glb, die)
    gate = gate_glb(glb, die, atlas, helpers)
    gate["blender_reimport"] = blender_reimport(bpy, glb)
    br = gate["blender_reimport"]
    if br["meshes"] != 1 or br["triangles"] != gate["triangles"] or br["materials"] != sorted(DIE[die]["mats"]):
        gate["errors"].append(f"blender reimport mismatch: {br}")
        gate["pass"] = False
    report["reimport"] = gate
    (out / "reimport.json").write_text(json.dumps(gate, indent=2) + "\n")
    if gate["errors"]:
        (out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        raise RuntimeError(f"{die} gate failed: {gate['errors']}")
    manifest = build_manifest(die, gate, atlas)
    (runtime / f"{die}.manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    set_slots(low, src)
    bpy.data.libraries.write(str(blend_dir / f"{die}.low.blend"), {low_scene}, path_remap="RELATIVE_ALL", compress=True)
    bpy.data.libraries.write(str(blend_dir / f"{die}.high.blend"), {high_scene}, path_remap="RELATIVE_ALL", compress=True)

    if not args.skip_renders:
        t1 = time.monotonic()
        report["renders"] = renders(bpy, die, low_scene, high_scene, low, high, out / "renders")
        report["render_seconds"] = round(time.monotonic() - t1, 1)
    report["files"] = {
        (str(p.relative_to(REPO)) if p.is_relative_to(REPO) else str(p)): sha256(p)
        for p in sorted([*runtime.iterdir(), *blend_dir.iterdir(), out / "reimport.json"])
        if p.is_file() and p.suffix in {".glb", ".json", ".blend"}
    }
    report["total_seconds"] = round(time.monotonic() - t0, 1)
    (out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"[{die}] PASS {gate['triangles']} tris, materials {gate['materials']}, glb sha256 {gate['glb_sha256']}")
    return gate


def main_blender(args: argparse.Namespace) -> None:
    import bmesh
    import bpy

    atlas = load_atlas()
    helpers = sentry_helpers()
    for die in args.only or list(DIE):
        build_die(bpy, bmesh, die, args, atlas, helpers)


if __name__ == "__main__":
    ARGS = parse_args()
    if ARGS.sheet:
        print(compose_sheet(ARGS.out_root.resolve()))
    else:
        main_blender(ARGS)
