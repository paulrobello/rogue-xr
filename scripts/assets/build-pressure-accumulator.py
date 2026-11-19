"""Original Pressure Works accumulator bank, Blender Z-up to glTF Y-up."""

from __future__ import annotations
import hashlib
import json
import math
from pathlib import Path
import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "assets-source/props/pressure-works"
OUT = ROOT / "public/assets/props/pressure-works"
SRC.mkdir(parents=True, exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)


def mat(name, color, metal, rough):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    p = m.node_tree.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = (*color, 1)
    p.inputs["Metallic"].default_value = metal
    p.inputs["Roughness"].default_value = rough
    return m


MATS = {
    "iron": mat("cast iron", (0.075, 0.064, 0.055), 0.65, 0.56),
    "brass": mat("aged brass", (0.48, 0.29, 0.095), 0.8, 0.34),
    "copper": mat("copper", (0.38, 0.16, 0.085), 0.68, 0.4),
    "patina": mat("oxidized copper", (0.09, 0.23, 0.17), 0.45, 0.72),
    "ivory": mat("porcelain", (0.82, 0.74, 0.57), 0.05, 0.46),
}


def loc(p):
    return (p[0], -p[2], p[1])


def finish(o, m):
    o.data.materials.append(MATS[m])
    return o


def box(pos, size, m):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc(pos))
    o = bpy.context.object
    o.dimensions = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(o, m)


def cylinder(a, b, r, m, sides=16):
    a, b = Vector(loc(a)), Vector(loc(b))
    d = b - a
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=sides, radius=r, depth=d.length, location=(a + b) / 2
    )
    o = bpy.context.object
    o.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    return finish(o, m)


def sphere(pos, scale, m):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, location=loc(pos))
    o = bpy.context.object
    o.scale = (scale[0], scale[2], scale[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(o, m)


def gauge(x, y, z, r):
    cylinder((x, y, z - 0.014), (x, y, z + 0.008), r, "brass", 24)
    cylinder((x, y, z + 0.009), (x, y, z + 0.011), r * 0.8, "ivory", 24)
    for i in range(7):
        t = math.pi * 0.15 + i * math.pi * 0.7 / 6
        cylinder(
            (x + r * 0.6 * math.cos(t), y + r * 0.6 * math.sin(t), z + 0.012),
            (x + r * 0.73 * math.cos(t), y + r * 0.73 * math.sin(t), z + 0.012),
            0.004,
            "iron",
            6,
        )
    cylinder(
        (x, y, z + 0.012), (x + r * 0.36, y + r * 0.26, z + 0.012), 0.006, "iron", 6
    )


# Continuous opaque back and stepped cast frame.
box((0, 1.425, 0.035), (2.62, 2.85, 0.07), "patina")
for x in (-1.27, 1.27):
    box((x, 1.425, 0.083), (0.08, 2.85, 0.10), "iron")
for y in (0.08, 2.77):
    box((0, y, 0.083), (2.62, 0.16, 0.10), "iron")
for x in (-0.64, 0.64):
    # Flattened elliptical vessel reads as a heavy tank from the side while staying shallow.
    sphere((x, 1.38, 0.20), (0.37, 0.98, 0.13), "iron")
    vessel = cylinder((x, 0.655, 0.197), (x, 2.105, 0.197), 0.34, "iron", 20)
    vessel.scale.y = 0.367
    for y in (0.78, 1.38, 1.98):
        box((x, y, 0.255), (0.73, 0.09, 0.19), "brass")
        for dx in (-0.29, 0.29):
            cylinder((x + dx, y, 0.349), (x + dx, y, 0.365), 0.022, "copper", 8)
    # Riveted vertical seam and subtle corrosion patches.
    for y in (0.91, 1.04, 1.17, 1.30, 1.47, 1.60, 1.73, 1.86):
        cylinder((x, y, 0.322), (x, y, 0.339), 0.012, "brass", 8)
    for dx, y in ((-0.21, 0.99), (0.18, 1.69)):
        box((x + dx, y, 0.326), (0.065, 0.14, 0.004), "patina")
    # Relief bonnet and neck.
    cylinder((x, 2.10, 0.19), (x, 2.39, 0.19), 0.105, "copper")
    cylinder((x, 2.33, 0.19), (x, 2.40, 0.19), 0.13, "brass")
    sphere((x, 2.42, 0.19), (0.14, 0.10, 0.12), "iron")
    cylinder((x, 2.47, 0.19), (x, 2.57, 0.19), 0.035, "brass")
    # Delivery line turns toward the frame and down, all within the shallow envelope.
    side = -1 if x < 0 else 1
    pts = [
        (x, 2.51, 0.18),
        (x + side * 0.28, 2.51, 0.18),
        (x + side * 0.43, 2.36, 0.18),
        (x + side * 0.43, 0.48, 0.18),
        (x + side * 0.28, 0.33, 0.18),
        (x, 0.33, 0.18),
    ]
    for a, b in zip(pts, pts[1:]):
        cylinder(a, b, 0.027, "copper", 10)
    for y in (0.65, 1.20, 1.78, 2.20):
        cylinder(
            (x + side * 0.43, y - 0.035, 0.18),
            (x + side * 0.43, y + 0.035, 0.18),
            0.041,
            "brass",
            10,
        )
    gauge(x, 2.16, 0.335, 0.105)
# Central sight glass, legible against an iron panel.
box((0, 1.43, 0.12), (0.18, 0.86, 0.10), "iron")
box((0, 1.43, 0.177), (0.09, 0.68, 0.016), "ivory")
box((0, 1.28, 0.188), (0.05, 0.34, 0.006), "patina")
for y in (1.06, 1.80):
    box((0, y, 0.19), (0.16, 0.07, 0.04), "brass")
for x in (-1.23, 1.23):
    for y in (0.23, 0.62, 1.01, 1.40, 1.79, 2.18, 2.58):
        cylinder((x, y, 0.13), (x, y, 0.146), 0.018, "brass", 8)

# Merge by material for five draws.
for m in MATS.values():
    objs = [
        o
        for o in bpy.context.scene.objects
        if o.type == "MESH" and o.data.materials[0] == m
    ]
    if not objs:
        continue
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    bpy.context.object.name = "accumulator-" + m.name
bpy.ops.wm.save_as_mainfile(filepath=str(SRC / "accumulator-bank.blend"))
staged = SRC / "accumulator-bank.staged.glb"
bpy.ops.export_scene.gltf(filepath=str(staged), export_format="GLB")
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(staged))
objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
points = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
lo = [min(p[i] for p in points) for i in range(3)]
hi = [max(p[i] for p in points) for i in range(3)]
tris = sum(sum(len(f.vertices) - 2 for f in o.data.polygons) for o in objs)
materials = len({m.name for o in objs for m in o.data.materials})
rlo = [lo[0], lo[2], -hi[1]]
rhi = [hi[0], hi[2], -lo[1]]
assert tris <= 4500 and materials <= 5, (tris, materials)
assert (
    rlo[0] >= -1.31001
    and rhi[0] <= 1.31001
    and abs(rlo[1]) < 1e-4
    and rhi[1] <= 2.85001
    and rlo[2] >= -1e-4
    and rhi[2] <= 0.38001
), (rlo, rhi)
assert all(
    not n.image or n.image.packed_file
    for m in bpy.data.materials
    if m.use_nodes
    for n in m.node_tree.nodes
    if n.type == "TEX_IMAGE"
)
scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.eevee.taa_render_samples = 16
scene.render.resolution_x = 900
scene.render.resolution_y = 900
scene.world.color = (0.16, 0.16, 0.16)
bpy.ops.object.light_add(type="AREA", location=(1.5, -4, 5))
l = bpy.context.object
l.data.energy = 650
l.data.shape = "DISK"
l.data.size = 5
l.rotation_euler = (
    (Vector((0, 0, 1.4)) - l.location).to_track_quat("-Z", "Y").to_euler()
)
bpy.ops.object.camera_add(location=(3.2, -5.4, 2.7))
c = bpy.context.object
c.rotation_euler = (
    (Vector((0, 0, 1.4)) - c.location).to_track_quat("-Z", "Y").to_euler()
)
c.data.type = "ORTHO"
c.data.ortho_scale = 4.2
scene.camera = c
scene.render.filepath = str(SRC / "accumulator-bank-front-three-quarter.png")
bpy.ops.render.render(write_still=True)
target = OUT / "accumulator-bank.glb"
target.write_bytes(staged.read_bytes())
staged.unlink()
report = {
    "vertices": sum(len(o.data.vertices) for o in objs),
    "triangles": tris,
    "materials": materials,
    "runtime_bounds_min": rlo,
    "runtime_bounds_max": rhi,
    "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
    "blender": bpy.app.version_string,
    "provenance": "Original procedural geometry by Codex, no external inputs or textures.",
}
(SRC / "accumulator-bank.report.json").write_text(json.dumps(report, indent=2) + "\n")
print("ACCUMULATOR_REPORT", json.dumps(report))
