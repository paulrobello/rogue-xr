"""Build the four portable Conservatory alchemy props with Blender 5.2.2."""

from __future__ import annotations

import hashlib
import json
import math
import struct
import tempfile
import zlib
from pathlib import Path

import bpy
import numpy as np
from mathutils import Euler, Vector

PIECE = "conservatory-specimens"
SOURCE = Path(__file__).resolve().parents[2] / "assets-source" / "props" / PIECE
STAGING = SOURCE / "staging"
ROOTS = ("IngredientBellcap", "IngredientSilverleaf", "RecipeTileBellcap", "RecipeTileSilverleaf")
PALETTE = {
    "ochre": ("C28739", .57, .03), "copper": ("B57633", .62, .03),
    "rim": ("F1B85C", .58, .03), "gills": ("B7854B", .81, .00),
    "ivory": ("EBCE96", .76, .00), "olive": ("847A40", .74, .00),
    "sage": ("95B39D", .65, .02), "back": ("577A64", .76, .00),
    "slate": ("3F3D43", .80, .03), "brass": ("BD9050", .50, .47),
    "edge": ("514B4B", .78, .02), "vein": ("D9D6A7", .62, .01),
}
Side = tuple[float, float]
Point = tuple[float, float, float]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def png(path: Path, rgb: np.ndarray) -> None:
    def chunk(tag: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", zlib.crc32(tag + payload))
    h, w, _ = rgb.shape
    scan = b"".join(b"\0" + row.tobytes() for row in rgb[::-1])
    header = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
                     + chunk(b"IDAT", zlib.compress(scan, 9)) + chunk(b"IEND", b""))


def make_material() -> bpy.types.Material:
    size = 48
    albedo = np.zeros((size * 3, size * 4, 3), np.uint8)
    normal = np.zeros_like(albedo)
    packed = np.zeros_like(albedo)
    v, u = (np.mgrid[0:size, 0:size] + .5) / size
    for i, (surface, (hex_color, rough, metal)) in enumerate(PALETTE.items()):
        color = np.array(list(bytes.fromhex(hex_color)), dtype=float)
        wash = np.sin(u * 10 + v * 15 + i) * np.cos(v * 16 - u * 7)
        brush = np.sin(u * 77 + 3 * np.cos(v * 8 + i) + v * 18)
        value = 1 + .055 * wash + .022 * brush
        height = .18 * wash + .05 * brush
        if surface in ("ochre", "copper", "gills", "ivory"):
            fibers = (.5 + .5 * np.cos(2 * math.pi * (u * 8 + .12 * np.cos(v * 5)))) ** 4
            value += .13 * (fibers - .5) + .09 * (v - .5)
            height += .23 * fibers
        rgb = color * value[:, :, None]
        if surface == "ochre":
            warmth = np.sin(math.pi * np.clip((v - .18) / .82, 0, 1)) ** 2
            rgb -= warmth[:, :, None] * np.array([8, 22, 16])
            flecks = np.zeros_like(v)
            for row, count in ((.66, 11), (.83, 15), (.92, 9)):
                for k in range(count):
                    x = (k + .28 * math.sin(k * 91 + row * 13)) / count
                    y = row + .043 * math.sin(k * 72.5 + row)
                    dist = np.minimum(abs(u-x), 1-abs(u-x)) / (.009 + .005 * math.cos(k))
                    flecks = np.maximum(flecks, np.exp(-(dist**2 + ((v-y)/.021)**2)))
            rgb += flecks[:, :, None] * [52, 49, 30]
            height += .13 * flecks
        if surface in ("sage", "back"):
            dist = abs(u - .5)
            veins = np.exp(-((np.sin((v - dist * .78) * math.pi * 6)) / .17) ** 2) * (1 - dist)
            midrib = np.exp(-((dist / .044) ** 2)) * (.9 - .35 * v)
            veins *= np.clip((.53 - dist) * 8, 0, 1)
            rgb += (midrib + .46 * veins)[:, :, None] * np.array([58, 44, 25])
            rgb += (u - .5)[:, :, None] * [17, 18, 13]
            height += .64 * midrib + .25 * veins
        dy, dx = np.gradient(height)
        n = np.stack((-dx * .9, -dy * .9, np.ones_like(dx)), axis=-1)
        n /= np.linalg.norm(n, axis=-1)[:, :, None]
        region = np.s_[i // 4 * size:(i // 4 + 1) * size, i % 4 * size:(i % 4 + 1) * size]
        albedo[region] = np.clip(rgb, 0, 255).astype(np.uint8)
        normal[region] = np.round((n * .5 + .5) * 255).astype(np.uint8)
        packed[region] = np.stack([np.ones_like(u), rough + .04 * wash, np.full_like(u, metal)], axis=-1) * 255
    mat = bpy.data.materials.new("Conservatory painted atlas")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    link = mat.node_tree.links.new
    shader = nodes.get("Principled BSDF")
    with tempfile.TemporaryDirectory() as directory:
        images = {}
        for channel, pixels in (("albedo", albedo), ("normal", normal), ("orm", packed)):
            path = Path(directory) / f"{PIECE}.{channel}.png"
            png(path, pixels)
            image = bpy.data.images.load(str(path))
            image.colorspace_settings.name = "sRGB" if channel == "albedo" else "Non-Color"
            image.pack()
            image.filepath = f"//{path.name}"
            node = nodes.new("ShaderNodeTexImage")
            node.image = image
            images[channel] = node.outputs["Color"]
        link(images["albedo"], shader.inputs["Base Color"])
        split = nodes.new("ShaderNodeSeparateColor")
        link(images["orm"], split.inputs["Color"])
        link(split.outputs["Green"], shader.inputs["Roughness"])
        link(split.outputs["Blue"], shader.inputs["Metallic"])
        norm = nodes.new("ShaderNodeNormalMap")
        link(images["normal"], norm.inputs["Color"])
        link(norm.outputs["Normal"], shader.inputs["Normal"])
    return mat


def atlas(surface: str, uv: Side) -> Side:
    panel = list(PALETTE).index(surface)
    return ((panel % 4 + .045 + .91 * uv[0]) / 4, (panel // 4 + .045 + .91 * uv[1]) / 3)


class Mesh:
    def __init__(self) -> None:
        self.vertices: list[Point] = []
        self.faces: list[tuple[int, ...]] = []
        self.uvs: list[list[Side]] = []
        self.smooth: list[bool] = []

    def vert(self, p: Point | Vector) -> int:
        self.vertices.append(tuple(p))
        return len(self.vertices) - 1

    def face(self, indices: list[int], surface: str, uv: list[Side] | None = None, smooth: bool = False) -> None:
        if uv is None:
            points = np.array([self.vertices[i] for i in indices])
            axes = np.argsort(np.ptp(points, axis=0))[-2:]
            plane = points[:, sorted(axes)]
            uv = (plane - plane.min(axis=0)) / np.maximum(np.ptp(plane, axis=0), .000001)
        self.faces.append(tuple(indices))
        self.smooth.append(smooth)
        self.uvs.append([atlas(surface, point) for point in uv])

    def object(self, name: str, mat: bpy.types.Material) -> bpy.types.Object:
        data = bpy.data.meshes.new(name)
        data.from_pydata(self.vertices, [], self.faces)
        data.update()
        mapping = data.uv_layers.new(name="Paint")
        for polygon, coords, smooth in zip(data.polygons, self.uvs, self.smooth, strict=True):
            polygon.use_smooth = smooth
            for loop, coord in zip(polygon.loop_indices, coords, strict=True):
                mapping.data[loop].uv = coord
        data.materials.append(mat)
        obj = bpy.data.objects.new(name, data)
        bpy.context.collection.objects.link(obj)
        return obj


def revolve(mesh: Mesh, rings: list[list[Vector]], bands: list[str], smooth: bool = False) -> None:
    n = len(rings[0])
    rows = [[mesh.vert(p) for p in ring] for ring in rings]
    mesh.face(rows[0][::-1], bands[0])
    for j, surface in enumerate(bands):
        for i in range(n):
            k = (i + 1) % n
            mesh.face([rows[j][i], rows[j][k], rows[j + 1][k], rows[j + 1][i]], surface,
                      [(i / n, j / len(bands)), ((i + 1) / n, j / len(bands)),
                       ((i + 1) / n, (j + 1) / len(bands)), (i / n, (j + 1) / len(bands))], smooth=smooth)
    mesh.face(rows[-1], bands[-1])


def stalk(mesh: Mesh, path: list[tuple[Point, float]], bands: list[str], n: int = 9) -> None:
    rings = []
    for j, (pos, radius) in enumerate(path):
        axis = Vector(path[min(j + 1, len(path) - 1)][0]) - Vector(path[max(j - 1, 0)][0])
        if j == 0 and pos[2] == 0:
            axis = Vector((0, 0, 1))
        right = Vector((0, 1, 0)).cross(axis).normalized()
        back = axis.normalized().cross(right)
        rings.append([Vector(pos) + radius * (right * math.cos(i * math.tau / n) + back * math.sin(i * math.tau / n))
                      for i in range(n)])
    revolve(mesh, rings, bands, smooth=True)


def bell(mesh: Mesh, foot: Point, crown: Point, r: float, h: float, tilt: Point, n: int) -> None:
    orient = Euler(tilt).to_matrix()
    center = Vector(crown)
    support = center + orient @ Vector((0, 0, .48 * h))
    base = Vector(foot)
    middle = base.lerp(support, .55) + Vector((-.004, .001, 0))
    stalk(mesh, [(base, .27 * r), (base.lerp(middle, .17), .31 * r), (middle, .145 * r),
                 (support, .19 * r)], ["ivory"] * 3)
    # The corrugation travels down each cap and opens into a scalloped lip and recessed gill skirt.
    rings = []
    for radius, z, flute in ((.17, .46, 0), (.67, .18, .055), (.98, .045, .10),
                              (1, .12, .10), (.72, .41, .085), (.50, .73, .055),
                              (.30, .94, .035), (.13, 1, .015)):
        ring = []
        for i in range(n):
            a = i * math.tau / n
            ridge = math.cos(i * math.pi)
            rad = r * radius * (1 + flute * ridge + .035 * math.cos(3 * a + .4))
            uneven = flute * (.68 * ridge + .43 * math.sin(3 * a - .2))
            ring.append(center + orient @ Vector((rad * math.cos(a), rad * math.sin(a), h * (z + uneven))))
        rings.append(ring)
    revolve(mesh, rings, ["gills", "gills", "rim", "ochre", "ochre", "ochre", "ochre"], smooth=True)
    if n >= 20:
        veil = base.lerp(support, .69)
        tiers = []
        for z, radius in ((0, .15), (.012, .34), (.068, .14)):
            tiers.append([veil + r * Vector((radius * math.cos(i*math.tau/8), radius * math.sin(i*math.tau/8),
                          z + (.027*math.sin(i*2.25) if radius > .2 else 0))) for i in range(8)])
        revolve(mesh, tiers, ["gills", "ivory"])


def bellcap() -> Mesh:
    m = Mesh()
    bell(m, (-.018, .003, 0), (-.028, .016, .116), .054, .066, (.02, -.14, .14), 24)
    bell(m, (.008, -.004, 0), (.041, -.018, .069), .044, .052, (.05, .25, .22), 20)
    bell(m, (-.001, .012, 0), (.039, .048, .104), .030, .043, (-.11, .23, .42), 16)
    return m


def leaf(m: Mesh, base: Point, tip: Point, width: float, facing: Point) -> None:
    base, tip = Vector(base), Vector(tip)
    delta = tip - base
    across = delta.normalized().cross(Vector(facing)).normalized()
    normal = across.cross(delta.normalized()).normalized()
    # Width and direction are independent so the leaves twist around the three-dimensional shoot.
    rows = []
    for t, halfwidth in ((.00, .06), (.21, .65), (.49, 1), (.72, .74), (.89, .32), (1, .018)):
        mid = base + delta * t + normal * (.009 * math.sin(t * math.pi)) + across * (.004 * math.sin(t * math.tau) * t)
        ridge = .004 * halfwidth
        wing = width * halfwidth * (across + normal * .13 * (2*t - 1))
        rows.append([m.vert(mid - wing), m.vert(mid + normal * ridge), m.vert(mid + wing),
                     m.vert(mid - normal * (.0024 * halfwidth))])
    for j, (lo, hi) in enumerate(zip(rows, rows[1:])):
        v0, v1 = (0, .21, .49, .72, .89)[j], (.21, .49, .72, .89, 1)[j]
        for i, (u0, u1) in enumerate(((0, .5), (.5, 1), (1, .5), (.5, 0))):
            k = (i + 1) % 4
            m.face([lo[i], lo[k], hi[k], hi[i]], "sage" if i < 2 else "back",
                   [(u0, v0), (u1, v0), (u1, v1), (u0, v1)])
    m.face(rows[0][::-1], "olive")
    m.face(rows[-1], "vein")


def silverleaf() -> Mesh:
    m = Mesh()
    path = [((-.014, -.003, 0), .008), ((-.012, -.002, .015), .009),
            ((-.003, 0, .057), .0058), ((.008, .001, .100), .0047),
            ((.009, .004, .135), .0036), ((.002, .008, .170), .0025)]
    stalk(m, path, ["olive"] * 5, 9)
    for h, end, width, facing in (
        (2, (-.083, -.023, .102), .021, (-.10, -1, .4)),
        (2, (.057, .047, .095), .017, (.65, -.35, 1)),
        (3, (.086, -.013, .152), .021, (.12, -1, .3)),
        (3, (-.065, .051, .145), .019, (-.6, -.5, .9)),
        (4, (-.054, -.029, .199), .018, (-.25, -1, .35)),
        (4, (.054, .042, .191), .015, (.4, -.80, .4)),
        (5, (.004, .008, .224), .015, (.12, -1, .15)),
    ):
        leaf(m, path[h][0], end, width, facing)
    return m


def plaque(m: Mesh, outline: list[Side], base: float, top: float, face: str, edge: str) -> None:
    if sum(p[0] * q[1] - p[1] * q[0] for p, q in zip(outline, outline[1:] + outline[:1])) < 0:
        outline = list(reversed(outline))
    low = [m.vert((x, y, base)) for x, y in outline]
    high = [m.vert((x, y, top)) for x, y in outline]
    m.face(low[::-1], edge)
    m.face(high, face)
    for i in range(len(outline)):
        k = (i + 1) % len(outline)
        m.face([low[i], low[k], high[k], high[i]], edge)


def tile(species: str) -> Mesh:
    m = Mesh()
    def frame(radius: float, cut: float) -> list[Side]:
        return [(radius, radius-cut), (radius-cut, radius), (-radius+cut, radius), (-radius, radius-cut),
                (-radius, -radius+cut), (-radius+cut, -radius), (radius-cut, -radius), (radius, -radius+cut)]
    revolve(m, [[Vector((x, y, z)) for x, y in frame(r, c)] for r, c, z in
                ((.088, .009, 0), (.090, .009, .002), (.090, .009, .009), (.086, .008, .013))],
            ["edge", "slate", "edge"])
    plaque(m, frame(.0785, .011), .0127, .0142, "brass", "brass")
    plaque(m, frame(.0758, .010), .0141, .0146, "slate", "edge")
    if species == "Bellcap":
        def emblem(x: float, y: float, scale: float) -> None:
            def poly(points: list[Side], z: float, color: str) -> None:
                plaque(m, [(x + px * scale, y + py * scale) for px, py in points],
                       .0145, z, color, color)
            poly([(-.009,-.047),(.009,-.047),(.005,-.034),(.005,.006),(-.004,.007),(-.006,-.034)], .0185, "ivory")
            poly([(-.039,-.002),(-.024,.014),(-.014,.037),(-.005,.046),(.004,.047),(.013,.041),
                  (.023,.018),(.042,-.001),(.032,-.005),(.023,-.002),(.012,-.007),
                  (.002,-.003),(-.010,-.008),(-.020,-.003),(-.029,-.006)], .0215, "ochre")
            for center in (-.016, .014):
                poly([(center*1.8,.001),(center*1.3,.012),(center*.55,.034),
                      (center*.72,.017),(center*1.4,.002)], .022, "rim")
        emblem(-.016, .009, 1.05)
        emblem(.038, -.023, .60)
    else:
        plaque(m, [(-.007,-.059),(-.002,-.060),(.012,.041),(.009,.046)], .01455, .019, "olive", "olive")
        for (x, y), (tx, ty), width in [
            ((.000,-.029),(-.048,-.009),.012), ((.003,-.012),(.051,.008),.013),
            ((.005,.006),(-.039,.039),.013), ((.008,.020),(.045,.050),.011),
            ((.009,.032),(.007,.065),.009)]:
            vec = Vector((tx-x, ty-y))
            side = Vector((vec.y, -vec.x)).normalized() * width
            mid = Vector((x, y)) + vec * .43
            a, b = mid - side, mid + side
            plaque(m, [(x,y),tuple(b),(tx,ty),tuple(a)], .01455, .020, "sage", "back")
            plaque(m, [(x,y),tuple(mid+side*.12),(tx,ty),tuple(mid-side*.12)], .0199, .021, "vein", "vein")
    return m


def centered(mesh: Mesh) -> Mesh:
    coords = np.array(mesh.vertices)
    offset = (np.max(coords[:, :2], axis=0) + np.min(coords[:, :2], axis=0)) / 2
    mesh.vertices = [(x - offset[0], y - offset[1], z) for x, y, z in mesh.vertices]
    return mesh


def import_check(glb: Path) -> dict:
    binary = glb.read_bytes()
    length = struct.unpack_from("<I", binary, 12)[0]
    doc = json.loads(binary[20:20 + length])
    root_nodes = [doc["nodes"][i] for i in doc["scenes"][doc.get("scene", 0)]["nodes"]]
    assert {node["name"] for node in root_nodes} == set(ROOTS)
    material = doc["materials"][0]
    assert len(doc["materials"]) == 1 and all("bufferView" in image for image in doc["images"])
    textures = [material["pbrMetallicRoughness"][name]["index"] for name in
                ("baseColorTexture", "metallicRoughnessTexture")]
    textures.append(material["normalTexture"]["index"])
    assert len({doc["textures"][idx]["source"] for idx in textures}) == 3
    assert len(binary) < 500_000
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(glb))
    bpy.context.view_layer.update()
    report = {}
    for node in root_nodes:
        name = node["name"]
        obj = bpy.data.objects[name]
        assert obj.parent is None and tuple(obj.location) == (0, 0, 0)
        coordinates = [obj.matrix_world @ v.co for v in obj.data.vertices]
        points = np.array([(p.x, p.z, -p.y) for p in coordinates])
        lo, hi = points.min(axis=0), points.max(axis=0)
        ext = hi - lo
        tri = sum(len(p.vertices) - 2 for p in obj.data.polygons)
        prim = doc["meshes"][node["mesh"]]["primitives"]
        assert len(prim) == 1 and {"TEXCOORD_0", "NORMAL", "TANGENT"}.issubset(prim[0]["attributes"])
        assert abs(lo[1]) <= .002 and max(abs((lo + hi)[[0, 2]] * .5)) <= .002
        if name.startswith("Ingredient"):
            assert tri <= 1250 and ext[0] <= .21 and ext[2] <= .18 and .14 <= ext[1] <= .23, (name, ext, tri)
        else:
            assert tri <= 500 and np.allclose(ext[[0, 2]], [.18, .18], atol=.00003)
            assert .0146 < hi[1] < .025
        report[name] = {
            "triangles": tri, "vertices_after_reimport": len(points), "draw_calls": len(prim),
            "bounds_gltf_m": {"min": lo.round(6).tolist(), "max": hi.round(6).tolist()},
            "material": material["name"], "materials": len(obj.data.materials),
        }
    return report


def area(name: str, at: Point, target: Point, energy: float, size: float, color: Point) -> None:
    bpy.ops.object.light_add(type="AREA", location=at)
    lamp = bpy.context.object
    lamp.name = name
    lamp.rotation_euler = (Vector(target) - lamp.location).to_track_quat("-Z", "Y").to_euler()
    lamp.data.energy, lamp.data.size, lamp.data.color = energy, size, color


def review(path: Path) -> None:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.world = bpy.data.worlds.new("Conservatory studio")
    scene.world.color = (.19, .17, .14)
    positions = [(-.136, .02, 0), (.133, .025, 0), (-.136, -.155, .0005), (.133, -.155, .0005)]
    for name, pos in zip(ROOTS, positions, strict=True):
        bpy.data.objects[name].location = pos
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -.0002))
    ground = bpy.data.materials.new("Studio warm charcoal")
    ground.diffuse_color = (.028, .024, .025, 1)
    ground.use_nodes = True
    ground.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (.028, .024, .025, 1)
    ground.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = .93
    bpy.context.object.data.materials.append(ground)
    area("Broad amber key", (-.4, -.46, .76), (0, 0, .07), 12, .45, (1, .87, .69))
    area("Parchment fill", (.4, -.29, .43), (0, 0, .06), 5, .47, (1, .95, .88))
    area("Warm rim", (.04, .43, .53), (0, 0, .11), 12, .30, (1, .82, .6))
    bpy.ops.object.camera_add(location=(.025, -.80, .60))
    cam = bpy.context.object
    cam.rotation_euler = (Vector((0, -.038, .074)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam.data.type, cam.data.ortho_scale, cam.data.clip_start = "ORTHO", .59, .01
    scene.camera = cam
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = 1160, 760, 100
    scene.view_settings.view_transform = "AgX"
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def main() -> None:
    STAGING.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = PIECE
    scene.unit_settings.system = "METRIC"
    mat = make_material()
    objects = [mesh.object(name, mat) for name, mesh in zip(ROOTS, [
        centered(bellcap()), centered(silverleaf()), tile("Bellcap"), tile("Silverleaf")], strict=True)]
    # Store an inspectable source layout; every runtime root has its own centered placement pivot.
    for obj, pos in zip(objects, [(-.14, .03, 0), (.14, .03, 0), (-.14, -.17, 0), (.14, -.17, 0)], strict=True):
        obj.location = pos
    for screen in bpy.data.screens:
        for view in screen.areas:
            if view.type == "VIEW_3D":
                space = view.spaces.active
                space.region_3d.view_distance = .66
                space.region_3d.view_location = (0, -.055, .075)
                space.region_3d.view_rotation = Vector((0, -.8, .58)).to_track_quat("Z", "Y")
                space.shading.color_type = "TEXTURE"
                space.overlay.show_floor = False
    blend = SOURCE / f"{PIECE}.blend"
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(blend), compress=True)
    for obj in objects:
        obj.location = (0, 0, 0)
        obj.select_set(True)
        triangulate = obj.modifiers.new("Export triangles", "TRIANGULATE")
        triangulate.quad_method = "FIXED"
    glb = STAGING / f"{PIECE}.glb"
    bpy.ops.export_scene.gltf(filepath=str(glb), export_format="GLB", use_selection=True, use_active_scene=True,
                              export_yup=True, export_vertex_color="NONE", export_tangents=True, export_apply=True)
    stats = import_check(glb)
    image = STAGING / "review.png"
    review(image)
    manifest = {
        "glb_sha256": digest(glb), "source_blend_sha256": digest(blend), "generator_sha256": digest(Path(__file__)),
        "roots": list(ROOTS), "root_nodes": list(ROOTS),
        "triangles": sum(row["triangles"] for row in stats.values()), "visual_approval": "pending",
    }
    report = {
        "piece": PIECE, "blender": bpy.app.version_string, "authoringAgent": "Codex Blender authoring worker",
        "license": "Original project-authored geometry and textures under the repository's MIT license.",
        "source_reference": "Approved Clockwork Spire art bible and alchemy kit staging/review-detail.png",
        "units": "metres, glTF Y up; tiles relief +Y, design top -Z",
        "reimport": "Blender glTF importer; top-level identity pivots, bounds, draw calls, UVs, maps, budgets checked",
        "textures": {"size_px": [192, 144], "embedded_png": ["sRGB albedo", "tangent normal", "roughness G / metallic B"]},
        "roots": stats, "glb_bytes": glb.stat().st_size, "hashes": manifest, "review_sha256": digest(image),
        "limitations": ["Original painted atlas with analytical tangent normals, single detailed mesh per root.",
                        "Target headset readability and owner visual approval are pending."],
    }
    (SOURCE / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (STAGING / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
