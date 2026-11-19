"""Build the Pressure Works props. Blender Z-up maps to runtime (x, z, -y).

blender -b --factory-startup --python-exit-code 1 -P scripts/assets/build-pressure-works.py
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "assets-source/props/pressure-works"
OUT = ROOT / "public/assets/props/pressure-works"
SOURCE.mkdir(parents=True, exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)


def material(name, color, metal, rough):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    p = m.node_tree.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Metallic"].default_value = metal
    p.inputs["Roughness"].default_value = rough
    return m


def setup():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    return {
        "iron": material("cast iron", (0.075, 0.064, 0.055), 0.65, 0.56),
        "brass": material("aged brass", (0.48, 0.29, 0.095), 0.8, 0.34),
        "copper": material("copper", (0.38, 0.16, 0.085), 0.68, 0.4),
        "patina": material("oxidized copper", (0.09, 0.23, 0.17), 0.45, 0.72),
        "ivory": material("porcelain", (0.82, 0.74, 0.57), 0.05, 0.46),
        "dark": material("dark inset", (0.025, 0.027, 0.023), 0.2, 0.65),
    }


def loc(p):
    return (p[0], -p[2], p[1])


def finish(obj, mat, group):
    obj.data.materials.clear()
    obj.data.materials.append(MATS[mat])
    obj["group"] = group
    return obj


def box(pos, size, mat, group="body"):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc(pos))
    o = bpy.context.object
    o.dimensions = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(o, mat, group)


def cylinder(a, b, radius, mat, group="body", sides=12):
    a, b = Vector(loc(a)), Vector(loc(b))
    d = b - a
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=sides, radius=radius, depth=d.length, location=(a + b) / 2
    )
    o = bpy.context.object
    o.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    return finish(o, mat, group)


def ring(center, radius, tube, mat, group="body", major_segments=24):
    bpy.ops.mesh.primitive_torus_add(
        major_segments=major_segments,
        minor_segments=6,
        location=loc(center),
        major_radius=radius,
        minor_radius=tube,
    )
    o = bpy.context.object
    o.rotation_euler[0] = math.pi / 2
    return finish(o, mat, group)


def gauge(x, y, z, radius):
    cylinder((x, y, z - 0.018), (x, y, z + 0.025), radius, "brass", sides=24)
    cylinder((x, y, z + 0.026), (x, y, z + 0.029), radius * 0.82, "ivory", sides=24)
    ring((x, y, z + 0.032), radius * 0.84, 0.009, "iron")
    cylinder((x, y, z + 0.03), (x, y, z + 0.038), radius * 0.055, "dark", sides=8)
    cylinder(
        (x, y, z + 0.038),
        (x + radius * 0.43, y + radius * 0.34, z + 0.038),
        0.006,
        "dark",
        sides=6,
    )
    for i in range(9):
        t = math.pi * 0.15 + i * math.pi * 0.7 / 8
        cylinder(
            (
                x + radius * 0.66 * math.cos(t),
                y + radius * 0.66 * math.sin(t),
                z + 0.035,
            ),
            (
                x + radius * 0.74 * math.cos(t),
                y + radius * 0.74 * math.sin(t),
                z + 0.035,
            ),
            0.004,
            "dark",
            sides=6,
        )


def rivet(x, y, z):
    cylinder((x, y, z - 0.006), (x, y, z + 0.008), 0.018, "brass", sides=8)


def wheel(x, idx):
    group = f"valve-{idx}"
    z = 0.39
    ring((x, 1.05, z), 0.228, 0.022, "brass", group, 32)
    cylinder((x, 1.05, z - 0.055), (x, 1.05, z + 0.018), 0.058, "brass", group)
    for i in range(6):
        a = i * math.tau / 6
        cylinder(
            (x, 1.05, z),
            (x + 0.228 * math.cos(a), 1.05 + 0.228 * math.sin(a), z),
            0.012,
            "brass",
            group,
            8,
        )
    cylinder((x, 1.05, z + 0.019), (x, 1.05, z + 0.035), 0.032, "brass", group)
    cylinder(
        (x + 0.17, 1.05 + 0.14, z - 0.006),
        (x + 0.17, 1.05 + 0.14, z + 0.034),
        0.023,
        "brass",
        group,
        10,
    )


def manifold():
    box((0, 0.11, 0), (2.64, 0.22, 0.66), "iron")
    box((0, 0.88, -0.035), (2.48, 1.45, 0.57), "iron")
    box((0, 1.69, -0.035), (2.57, 0.18, 0.59), "iron")
    box((0, 1.84, -0.035), (2.35, 0.12, 0.53), "iron")
    box((0, 1.94, -0.035), (2.48, 0.08, 0.56), "brass")
    for x in (-1.17, 1.17):
        box((x, 0.91, 0.275), (0.11, 1.48, 0.06), "iron")
        for y in (0.30, 0.55, 0.80, 1.05, 1.30, 1.55):
            rivet(x, y, 0.315)
    for station, x in enumerate((-0.82, 0, 0.82)):
        box((x, 0.98, 0.27), (0.64, 1.16, 0.07), "dark")
        box(
            (x, 0.98, 0.312), (0.59, 1.11, 0.018), ("copper", "patina", "iron")[station]
        )
        for dx in (-0.29, 0.29):
            box((x + dx, 0.98, 0.326), (0.025, 1.08, 0.02), "iron")
        for y in (0.43, 1.53):
            box((x, y, 0.326), (0.58, 0.025, 0.02), "iron")
        for dx in (-0.25, 0.25):
            for y in (0.48, 1.48):
                rivet(x + dx, y, 0.329)
        cylinder((x, 1.39, 0.35), (x, 1.70, 0.35), 0.052, "copper")
        for y in (1.48, 1.62):
            cylinder((x, y - 0.025, 0.35), (x, y + 0.025, 0.35), 0.069, "brass")
    for i, x in enumerate((-0.82, 0, 0.82)):
        wheel(x, i)
    for x in (-1.06, 1.06):
        cylinder((x, 0.19, 0.20), (x, 0.19, 0.35), 0.085, "brass")
    gauge(0, 1.74, 0.31, 0.09)


def gallery():
    # A shallow open framework leaves the central placard region unobstructed.
    for x in (-1.55, 1.55):
        box((x, 0.045, -0.075), (0.14, 0.09, 0.05), "iron")
    for x in (-1.55, 1.55):
        box((x, 1.12, -0.075), (0.08, 2.18, 0.05), "iron")
    for y in (0.12, 2.16):
        box((0, y, -0.075), (3.18, 0.07, 0.05), "iron")
        cylinder((-1.55, y, -0.005), (1.55, y, -0.005), 0.043, "copper")
        for x in (-1.38, -1.28, -1.15, -0.91, 0, 0.91, 1.15, 1.28, 1.38):
            cylinder((x, y - 0.025, -0.005), (x, y + 0.025, -0.005), 0.046, "brass")
        for x in (-1.55, 1.55):
            cylinder((x, y, -0.075), (x, y, -0.005), 0.046, "brass")
    for i, x in enumerate((-1.38, -1.15, -0.91, 0.91, 1.15, 1.38)):
        radius = (0.028, 0.016, 0.024, 0.024, 0.016, 0.028)[i]
        z = (-0.015, 0.005, -0.01, -0.01, 0.005, -0.015)[i]
        shift = 0.08 if x < 0 else -0.08
        points = [
            (x, 0.12, z),
            (x, 0.85, z),
            (x + shift, 1.01, z),
            (x + shift, 1.77, z),
            (x, 1.93, z),
            (x, 2.16, z),
        ]
        for a, b in zip(points, points[1:]):
            cylinder(a, b, radius, "copper" if i % 3 else "patina")
        for px, py, pz in points[1:-1]:
            cylinder((px, py - 0.025, pz), (px, py + 0.025, pz), radius + 0.006, "brass")
        for y in (0.38, 0.69):
            cylinder((x, y - 0.035, z), (x, y + 0.035, z), radius + 0.012, "brass")
        for y in (1.17, 1.57):
            cylinder(
                (x + shift, y - 0.035, z),
                (x + shift, y + 0.035, z),
                radius + 0.012,
                "brass",
            )
        cylinder((x, 2.04, z), (x, 2.09, z), radius + 0.012, "brass")
    for x in (-1.28, 0, 1.28):
        cylinder((x, 0.12, -0.005), (x, 0.70, -0.005), 0.026, "copper")
        gauge(x, 0.70, 0.005, 0.12 if x else 0.10)
        end = (-1.30 if x < 0 else 1.30 if x > 0 else 0.83)
        cylinder((x, 0.70, -0.005), (x, 1.08, -0.005), 0.023, "copper")
        cylinder((x, 1.08, -0.005), (end, 1.08, -0.005), 0.023, "copper")
    # Porcelain sight glass, recessed between two brass caps under the placard.
    box((0, 0.35, 0.006), (0.12, 0.30, 0.055), "iron")
    box((0, 0.35, 0.037), (0.07, 0.25, 0.012), "ivory")
    for y in (0.19, 0.51):
        box((0, y, 0.012), (0.13, 0.05, 0.065), "brass")
    box((0, 0.30, 0.046), (0.046, 0.11, 0.006), "patina")
    cylinder((0, 0.25, 0.05), (0, 0.46, 0.05), 0.003, "brass", sides=8)
    for x in (-1.55, 1.55):
        for y in (0.25, 0.65, 1.05, 1.45, 1.85, 2.08):
            rivet(x, y, -0.04)


def merge_groups():
    objects = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    groups = {}
    for o in objects:
        key = (o["group"], o.data.materials[0].name)
        groups.setdefault(key, []).append(o)
    for (group, mat), objs in groups.items():
        bpy.ops.object.select_all(action="DESELECT")
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.convert(target="MESH")
        bpy.ops.object.join()
        o = bpy.context.object
        o.name = group if group.startswith("valve-") else "body-" + mat
        if group.startswith("valve-"):
            index = int(group[-1])
            pivot = Vector(loc(((-0.82, 0, 0.82)[index], 1.05, 0.39)))
            for v in o.data.vertices:
                v.co = o.matrix_world @ v.co - pivot
            o.matrix_world = Matrix.Identity(4)
            o.location = pivot


def stats(objects):
    verts = sum(len(o.data.vertices) for o in objects)
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objects)
    points = [o.matrix_world @ Vector(c) for o in objects for c in o.bound_box]
    lo = [min(p[i] for p in points) for i in range(3)]
    hi = [max(p[i] for p in points) for i in range(3)]
    return {
        "vertices": verts,
        "triangles": tris,
        "materials": len({m.name for o in objects for m in o.data.materials}),
        "runtime_bounds_min": [lo[0], lo[2], -hi[1]],
        "runtime_bounds_max": [hi[0], hi[2], -lo[1]],
    }


def render_preview(name):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = 16
    scene.render.resolution_x = 900
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.world.color = (0.16, 0.16, 0.16)
    bpy.ops.object.light_add(type="AREA", location=(1.5, -4, 5))
    light = bpy.context.object
    light.data.energy = 500
    light.data.shape = "DISK"
    light.data.size = 5
    light.rotation_euler = (
        (Vector((0, 0, 1)) - light.location).to_track_quat("-Z", "Y").to_euler()
    )
    bpy.ops.object.camera_add(location=(3.3, -5.5, 2.7))
    camera = bpy.context.object
    camera.rotation_euler = (
        (Vector((0, 0, 1.05)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    )
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 3.9
    scene.camera = camera
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(SOURCE / f"{name}-front-three-quarter.png")
    bpy.ops.render.render(write_still=True)


def build(name, fn):
    global MATS
    MATS = setup()
    fn()
    merge_groups()
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE / f"{name}.blend"))
    bpy.ops.export_scene.gltf(
        filepath=str(SOURCE / f"{name}.staged.glb"), export_format="GLB"
    )
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(SOURCE / f"{name}.staged.glb"))
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    report = stats(objs)
    assert report["triangles"] < 12000 and report["materials"] <= 6, report
    lo, hi = report["runtime_bounds_min"], report["runtime_bounds_max"]
    assert hi[0] - lo[0] <= (2.8 if name == "manifold" else 3.3) + 1e-5, report
    assert hi[2] - lo[2] <= (0.76 if name == "manifold" else 0.20) + 1e-5, report
    assert abs(lo[1]) < 1e-4, report
    if name == "manifold":
        for i, x in enumerate((-0.82, 0, 0.82)):
            o = bpy.data.objects.get(f"valve-{i}")
            assert o is not None, f"missing valve-{i}"
            assert (
                o.matrix_world.translation - Vector(loc((x, 1.05, 0.39)))
            ).length < 1e-4, o.matrix_world.translation[:]
    assert all(
        not n.image or n.image.packed_file
        for m in bpy.data.materials
        if m.use_nodes
        for n in m.node_tree.nodes
        if n.type == "TEX_IMAGE"
    ), "external image"
    render_preview(name)
    staged = SOURCE / f"{name}.staged.glb"
    target = OUT / f"{name}.glb"
    target.write_bytes(staged.read_bytes())
    staged.unlink()
    report["sha256"] = hashlib.sha256(target.read_bytes()).hexdigest()
    report["blender"] = bpy.app.version_string
    report["provenance"] = (
        "Original procedural geometry by Codex, no external inputs or textures."
    )
    (SOURCE / f"{name}.report.json").write_text(json.dumps(report, indent=2) + "\n")
    print("ASSET_REPORT", name, json.dumps(report))


build("manifold", manifold)
build("gallery-pipes", gallery)
