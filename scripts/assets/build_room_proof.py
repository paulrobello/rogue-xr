"""Pipeline fixture `room-proof`: a greybox study lit through a window and by two candles, baked to a
UV1 lightmap and exported for three.js. Proves the lightmap contract before real templates exist.

"$BLENDER" -b --factory-startup --python-exit-code 1 -P scripts/assets/build_room_proof.py -- \
    --out assets-source/room-proof/staging [--size 1024] [--samples 512] [--device GPU|CPU] [--skip-bake]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lightmap_helpers as lm  # noqa: E402

PIECE = "room-proof"
HALF = 3.0  # room is 6 x 6 m
HEIGHT = 3.5
WINDOW = {"x0": -0.9, "x1": 0.9, "z0": 1.0, "z1": 2.6, "depth": 0.3}
TABLE = {"cx": -1.2, "cy": -0.6, "w": 1.4, "d": 0.8, "top": 0.78, "thick": 0.05, "leg": 0.06}
PILLAR = {"cx": 1.6, "cy": 0.8, "r": 0.25, "segments": 16}
# Runtime camera for the comparison shot: Blender (0, -2.4, 1.6) looking +Y = runtime (0, 1.6, 2.4) looking -Z.
CAMERA = {"location": (0.0, -2.4, 1.6), "vfov_deg": 70.0, "width": 800, "height": 600}

MATERIALS = {
    "walnut": (0.18, 0.10, 0.05),
    "plaster": (0.55, 0.48, 0.40),
    "plaster_dark": (0.30, 0.25, 0.20),
    "brass": (0.62, 0.42, 0.16),
}


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True)
    p.add_argument("--size", type=int, default=1024)
    p.add_argument("--samples", type=int, default=512)
    p.add_argument("--device", choices=["GPU", "CPU"], default="GPU")
    p.add_argument("--skip-bake", action="store_true")
    return p.parse_args(argv)


def quad(bm: bmesh.types.BMesh, corners: list[tuple], normal: tuple, mat: int) -> None:
    verts = [bm.verts.new(c) for c in corners]
    face = bm.faces.new(verts)
    face.normal_update()
    if face.normal.dot(Vector(normal)) < 0:
        face.normal_flip()
    face.material_index = mat


def box(bm: bmesh.types.BMesh, x0, x1, y0, y1, z0, z1, mat: int, drop_bottom: bool, drop_top: bool) -> None:
    if not drop_top:
        quad(bm, [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], (0, 0, 1), mat)
    if not drop_bottom:
        quad(bm, [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0)], (0, 0, -1), mat)
    for x, n in ((x0, -1), (x1, 1)):
        quad(bm, [(x, y0, z0), (x, y1, z0), (x, y1, z1), (x, y0, z1)], (n, 0, 0), mat)
    for y, n in ((y0, -1), (y1, 1)):
        quad(bm, [(x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1)], (0, n, 0), mat)


def build_mesh() -> bpy.types.Object:
    names = list(MATERIALS)
    m = {name: i for i, name in enumerate(names)}
    bm = bmesh.new()
    H, T, W = HALF, HEIGHT, WINDOW
    # Interior shell only: faces nobody can see would spend lightmap texels.
    quad(bm, [(-H, -H, 0), (H, -H, 0), (H, H, 0), (-H, H, 0)], (0, 0, 1), m["walnut"])
    quad(bm, [(-H, -H, T), (H, -H, T), (H, H, T), (-H, H, T)], (0, 0, -1), m["plaster_dark"])
    quad(bm, [(-H, -H, 0), (-H, H, 0), (-H, H, T), (-H, -H, T)], (1, 0, 0), m["plaster"])
    quad(bm, [(H, -H, 0), (H, H, 0), (H, H, T), (H, -H, T)], (-1, 0, 0), m["plaster"])
    quad(bm, [(-H, -H, 0), (H, -H, 0), (H, -H, T), (-H, -H, T)], (0, 1, 0), m["plaster"])
    # Back wall (+Y) around the window opening, facing into the room.
    for x0, x1, z0, z1 in (
        (-H, W["x0"], 0, T),
        (W["x1"], H, 0, T),
        (W["x0"], W["x1"], 0, W["z0"]),
        (W["x0"], W["x1"], W["z1"], T),
    ):
        quad(bm, [(x0, H, z0), (x1, H, z0), (x1, H, z1), (x0, H, z1)], (0, -1, 0), m["plaster"])
    y0, y1 = H, H + W["depth"]
    quad(bm, [(W["x0"], y0, W["z0"]), (W["x0"], y1, W["z0"]), (W["x0"], y1, W["z1"]), (W["x0"], y0, W["z1"])], (1, 0, 0), m["plaster"])
    quad(bm, [(W["x1"], y0, W["z0"]), (W["x1"], y1, W["z0"]), (W["x1"], y1, W["z1"]), (W["x1"], y0, W["z1"])], (-1, 0, 0), m["plaster"])
    quad(bm, [(W["x0"], y0, W["z0"]), (W["x1"], y0, W["z0"]), (W["x1"], y1, W["z0"]), (W["x0"], y1, W["z0"])], (0, 0, 1), m["plaster"])
    quad(bm, [(W["x0"], y0, W["z1"]), (W["x1"], y0, W["z1"]), (W["x1"], y1, W["z1"]), (W["x0"], y1, W["z1"])], (0, 0, -1), m["plaster"])

    # Pillar: side walls only; its caps would be buried in the floor and ceiling.
    P = PILLAR
    ring = [
        (P["cx"] + P["r"] * math.cos(2 * math.pi * i / P["segments"]), P["cy"] + P["r"] * math.sin(2 * math.pi * i / P["segments"]))
        for i in range(P["segments"])
    ]
    for i in range(P["segments"]):
        (ax, ay), (bx, by) = ring[i], ring[(i + 1) % P["segments"]]
        mx, my = (ax + bx) / 2 - P["cx"], (ay + by) / 2 - P["cy"]
        quad(bm, [(ax, ay, 0), (bx, by, 0), (bx, by, T), (ax, ay, T)], (mx, my, 0), m["brass"])

    t = TABLE
    tx0, tx1 = t["cx"] - t["w"] / 2, t["cx"] + t["w"] / 2
    ty0, ty1 = t["cy"] - t["d"] / 2, t["cy"] + t["d"] / 2
    box(bm, tx0, tx1, ty0, ty1, t["top"] - t["thick"], t["top"], m["walnut"], drop_bottom=False, drop_top=False)
    inset = 0.08
    for lx in (tx0 + inset, tx1 - inset - t["leg"]):
        for ly in (ty0 + inset, ty1 - inset - t["leg"]):
            # Leg bottoms sit on the floor and tops under the table: both are buried.
            box(bm, lx, lx + t["leg"], ly, ly + t["leg"], 0, t["top"] - t["thick"], m["walnut"], drop_bottom=True, drop_top=True)

    # Weld coincident corners so coplanar wall pieces share one lightmap island and the pillar can
    # shade smooth; flat faces still export split normals.
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
    for face in bm.faces:
        face.smooth = face.material_index == m["brass"]
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    mesh = bpy.data.meshes.new(PIECE)
    bm.to_mesh(mesh)
    bm.free()
    mesh.uv_layers.new(name="UVMap")
    obj = bpy.data.objects.new(PIECE, mesh)
    bpy.context.scene.collection.objects.link(obj)
    for name in names:
        mat = bpy.data.materials.new(f"{PIECE}_{name}")
        bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Base Color"].default_value = (*MATERIALS[name], 1.0)
        bsdf.inputs["Roughness"].default_value = 0.8
        mesh.materials.append(mat)
    return obj


def build_lights() -> None:
    scene = bpy.context.scene
    world = bpy.data.worlds.new(f"{PIECE}_sky")
    scene.world = world
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (0.25, 0.35, 0.55, 1.0)
    bg.inputs["Strength"].default_value = 0.6

    sun_data = bpy.data.lights.new(f"{PIECE}_sun", "SUN")
    sun_data.energy = 4.0
    sun_data.angle = math.radians(1.5)
    sun_data.color = (1.0, 0.9, 0.75)
    sun = bpy.data.objects.new(f"{PIECE}_sun", sun_data)
    sun.rotation_euler = Vector((0.3, -1.0, -0.6)).normalized().to_track_quat("-Z", "Y").to_euler()
    scene.collection.objects.link(sun)

    t = TABLE
    for i, dx in enumerate((-0.35, 0.3)):
        data = bpy.data.lights.new(f"{PIECE}_candle_{i}", "POINT")
        data.energy = 25.0
        data.shadow_soft_size = 0.03
        data.color = (1.0, 0.6, 0.3)
        candle = bpy.data.objects.new(f"{PIECE}_candle_{i}", data)
        candle.location = (t["cx"] + dx, t["cy"] + 0.1, t["top"] + 0.18)
        scene.collection.objects.link(candle)


def render_reference(path: Path, samples: int) -> None:
    scene = bpy.context.scene
    if scene.camera is not None and scene.camera.name == f"{PIECE}_camera":
        scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        return
    cam_data = bpy.data.cameras.new(f"{PIECE}_camera")
    cam_data.sensor_fit = "VERTICAL"
    cam_data.angle = math.radians(CAMERA["vfov_deg"])
    cam_data.clip_start = 0.05
    cam = bpy.data.objects.new(f"{PIECE}_camera", cam_data)
    cam.location = CAMERA["location"]
    cam.rotation_euler = (math.radians(90), 0, 0)
    scene.collection.objects.link(cam)
    scene.camera = cam
    scene.render.resolution_x = CAMERA["width"]
    scene.render.resolution_y = CAMERA["height"]
    scene.render.resolution_percentage = 100
    scene.render.use_stamp_date = False
    scene.render.use_stamp_render_time = False
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def export_glb(obj: bpy.types.Object, path: Path) -> None:
    for other in bpy.context.view_layer.objects:
        other.select_set(other == obj)
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="NONE",
        export_cameras=False,
        export_lights=False,
        export_apply=True,
    )


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    args = parse_args()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)

    obj = build_mesh()
    build_lights()
    bpy.context.view_layer.update()
    lm.unwrap_material_uv(obj)
    lm.unwrap_lightmap_uv(obj, args.size)
    density = lm.lightmap_texel_density(obj, args.size)
    tris = len(obj.data.polygons)
    print(f"[{PIECE}] tris={tris} lightmap density={density}")

    report: dict = {
        "piece": PIECE,
        "blender": bpy.app.version_string,
        "size": args.size,
        "samples": args.samples,
        "triangles": tris,
        "materials": len(obj.data.materials),
        "lightmap_density": density,
    }
    if not args.skip_bake:
        report["device"] = lm.select_device(args.device)
        raw, seconds = lm.bake_irradiance(obj, args.size, args.samples)
        report["bake_seconds"] = round(seconds, 2)
        lm.save_exr(raw, out / f"{PIECE}.lightmap.raw.exr")
        image = lm.denoise_image(raw, out)
        lm.save_exr(image, out / f"{PIECE}.lightmap.exr")
        report["denoise"] = "compositor OIDN, HDR, accurate prefilter, high quality"
        encoded, scale, stats = lm.encode_scaled_srgb(lm.image_rgba(image))
        png = out / f"{PIECE}.lightmap.png"
        lm.write_png_rgb(png, encoded)
        report["lightmap"] = stats
        # three.js: indirectDiffuse = lightMap * lightMapIntensity * albedo / PI, while Cycles'
        # colourless diffuse pass is the factor that multiplies albedo directly; hence PI * scale.
        manifest = {
            "template": PIECE,
            "glb": f"{PIECE}.glb",
            "lightmap": {
                "file": png.name,
                "uv": 1,
                "encoding": "srgb-scaled",
                "scale": scale,
                "intensity": round(math.pi * scale, 6),
            },
        }
        (out / f"{PIECE}.manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        render_reference(out / f"{PIECE}.reference.png", min(args.samples, 256))
        # A lightmap carries only diffuse light; this reference isolates what it should reproduce.
        for mat in obj.data.materials:
            bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
            bsdf.inputs["Specular IOR Level"].default_value = 0.0
        render_reference(out / f"{PIECE}.reference-diffuse.png", min(args.samples, 256))
        for mat in obj.data.materials:
            bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
            bsdf.inputs["Specular IOR Level"].default_value = 0.5

    glb = out / f"{PIECE}.glb"
    export_glb(obj, glb)
    report["files"] = {p.name: sha256(p) for p in sorted(out.iterdir()) if p.suffix in {".glb", ".png", ".json"} and p.name != "report.json"}
    (out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


main()
