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


def vessel(x):
    # One closed elliptical pressure shell avoids intersections at the domed ends.
    profile = ((.50, .02), (.53, .20), (.59, .58), (.68, .88),
               (.76, 1), (1.96, 1), (2.04, .88), (2.13, .58),
               (2.19, .20), (2.22, .02))
    sides = 20
    vertices = [loc((x + .34 * r * math.cos(math.tau*i/sides), y,
                     .20 + .12 * r * math.sin(math.tau*i/sides)))
                for y, r in profile for i in range(sides)]
    faces = [(j*sides+i, j*sides+(i+1)%sides,
              (j+1)*sides+(i+1)%sides, (j+1)*sides+i)
             for j in range(len(profile)-1) for i in range(sides)]
    faces += [tuple(reversed(range(sides))), tuple((len(profile)-1)*sides+i for i in range(sides))]
    mesh = bpy.data.meshes.new('domed pressure shell')
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new('domed pressure shell', mesh)
    bpy.context.collection.objects.link(obj)
    for face in mesh.polygons:
        face.use_smooth = len(face.vertices) == 4
    finish(obj, 'iron')


def band(x, y):
    sides = 20
    vertices = [loc((x + .348 * math.cos(math.tau*i/sides), y+dy,
                     .20 + .126 * math.sin(math.tau*i/sides)))
                for dy in (-.027, .027) for i in range(sides)]
    faces = [(i, (i+1)%sides, (i+1)%sides+sides, i+sides) for i in range(sides)]
    mesh = bpy.data.meshes.new('machined vessel band')
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new('machined vessel band', mesh)
    bpy.context.collection.objects.link(obj)
    for face in mesh.polygons:
        face.use_smooth = True
    finish(obj, 'brass')


def bent_pipe(points, radius):
    points = [Vector(p) for p in points]
    path = [points[0]]
    for a, b, c in zip(points, points[1:], points[2:]):
        incoming, outgoing = (b-a).normalized(), (c-b).normalized()
        cut = min(.10, (b-a).length*.35, (c-b).length*.35)
        start, end = b-incoming*cut, b+outgoing*cut
        path.append(start)
        for i in range(1, 5):
            t = i/4
            path.append((1-t)**2*start + 2*(1-t)*t*b + t*t*end)
    path.append(points[-1])
    sides = 10
    vertices = []
    for i, p in enumerate(path):
        tangent = (path[min(i+1, len(path)-1)]-path[max(i-1, 0)]).normalized()
        side = Vector((-tangent.y, tangent.x, 0)).normalized()
        for j in range(sides):
            t = math.tau*j/sides
            vertices.append(loc(p + radius*(math.cos(t)*side + math.sin(t)*Vector((0,0,1)))))
    faces = [(i*sides+j, i*sides+(j+1)%sides, (i+1)*sides+(j+1)%sides, (i+1)*sides+j)
             for i in range(len(path)-1) for j in range(sides)]
    mesh = bpy.data.meshes.new('continuous delivery pipe')
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new('continuous delivery pipe', mesh)
    bpy.context.collection.objects.link(obj)
    for face in mesh.polygons:
        face.use_smooth = True
    finish(obj, 'copper')


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
box((0, 1.425, 0.035), (2.60, 2.83, 0.07), "patina")
for x in (-1.27, 1.27):
    box((x, 1.425, 0.083), (0.08, 2.85, 0.10), "iron")
for y in (0.08, 2.77):
    box((0, y, 0.083), (2.44, 0.16, 0.10), "iron")
for x in (-0.64, 0.64):
    vessel(x)
    for y in (.80, 1.38, 1.94):
        band(x, y)
        for dx in (-.27, .27):
            cylinder((x + dx, y, .275), (x + dx, y, .292), .014, 'copper', 8)
    # Cast plinth and flanged connections support the vessel and its delivery line.
    box((x, .37, .18), (.62, .13, .25), 'iron')
    for dx in (-.23, .23):
        box((x+dx, .20, .17), (.10, .22, .22), 'iron')
    cylinder((x, .43, .20), (x, .55, .20), .13, 'brass', 16)
    cylinder((x, 2.20, .19), (x, 2.39, .19), .09, 'copper')
    cylinder((x, 2.23, .19), (x, 2.28, .19), .12, 'brass')
    cylinder((x, 2.34, .19), (x, 2.40, .19), .12, 'brass')
    sphere((x, 2.42, .19), (.12, .08, .11), 'iron')
    cylinder((x, 2.45, .19), (x, 2.53, .19), .035, 'brass')
    side = -1 if x < 0 else 1
    bent_pipe([(x, 2.51, .18), (x+side*.43, 2.51, .18),
               (x+side*.43, .33, .18), (x, .33, .18)], .027)
    for y in (.65, 1.20, 1.78, 2.20):
        cylinder((x+side*.43, y-.025, .18), (x+side*.43, y+.025, .18), .039, 'brass', 10)
    gauge(x, 2.16, 0.335, 0.105)
# Central sight glass, legible against an iron panel.
box((0, 1.43, 0.121), (0.18, 0.86, 0.10), "iron")
box((0, 1.43, 0.177), (0.09, 0.68, 0.016), "ivory")
box((0, 1.28, 0.189), (0.05, 0.34, 0.006), "patina")
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
