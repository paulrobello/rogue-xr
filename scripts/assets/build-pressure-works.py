"""Build the Pressure Works props. Blender Z-up maps to runtime (x, z, -y).

blender -b --factory-startup --python-exit-code 1 -P scripts/assets/build-pressure-works.py
"""

from __future__ import annotations

import hashlib
import json
import math
import os
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
    bevel = o.modifiers.new('cast edge', 'BEVEL')
    bevel.width = min(0.012, min(size) * 0.22)
    bevel.segments = 1
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_apply(modifier=bevel.name)
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


def swept_pipe(points, radius, mat, bend=0.10, sides=12):
    """Sweep a tube through tangent quadratic bends in the runtime XY plane."""
    points = [Vector(p) for p in points]
    path = [points[0]]
    for a, b, c in zip(points, points[1:], points[2:]):
        incoming, outgoing = (b-a).normalized(), (c-b).normalized()
        cut = min(bend, (b-a).length * 0.35, (c-b).length * 0.35)
        start, end = b-incoming*cut, b+outgoing*cut
        path.append(start)
        for i in range(1, 5):
            t = i / 4
            path.append((1-t)**2*start + 2*(1-t)*t*b + t*t*end)
    path.append(points[-1])
    verts = []
    for i, point in enumerate(path):
        tangent = (path[min(i+1, len(path)-1)] - path[max(i-1, 0)]).normalized()
        side = Vector((-tangent.y, tangent.x, 0)).normalized()
        for j in range(sides):
            theta = math.tau*j/sides
            verts.append(loc(point + radius*(math.cos(theta)*side + math.sin(theta)*Vector((0,0,1)))))
    faces = []
    for i in range(len(path)-1):
        for j in range(sides):
            a = i*sides+j
            b = i*sides+(j+1)%sides
            faces.append((a,b,b+sides,a+sides))
    faces.extend([tuple(reversed(range(sides))), tuple((len(path)-1)*sides+j for j in range(sides))])
    mesh = bpy.data.meshes.new('Swept pipe')
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    ob = bpy.data.objects.new('Swept pipe', mesh)
    bpy.context.collection.objects.link(ob)
    for poly in mesh.polygons:
        poly.use_smooth = len(poly.vertices) == 4
    return finish(ob, mat, 'body')


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


def gauge(x, y, z, radius, index):
    cylinder((x, y, z - 0.018), (x, y, z + 0.025), radius, "brass", sides=24)
    cylinder((x, y, z + 0.026), (x, y, z + 0.029), radius * 0.82, "ivory", sides=24)
    ring((x, y, z + 0.032), radius * 0.84, 0.009, "iron")
    cylinder((x, y, z + 0.03), (x, y, z + 0.038), radius * 0.055, "dark", sides=8)
    cylinder(
        (x, y, z + 0.038),
        (x + radius * 0.43, y + radius * 0.34, z + 0.038),
        0.006,
        "dark",
        f"gauge-needle-{index}",
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
            (x + 0.012 * math.cos(a), 1.05 + 0.012 * math.sin(a), z),
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
    box((0, 1.692, -0.035), (2.57, 0.184, 0.59), "iron")
    box((0, 1.842, -0.035), (2.35, 0.124, 0.53), "iron")
    box((0, 1.94, -0.035), (2.48, 0.08, 0.56), "brass")
    for x in (-1.20, 1.20):
        box((x, 0.91, 0.275), (0.11, 1.48, 0.06), "iron")
        for y in (0.30, 0.55, 0.80, 1.05, 1.30, 1.55):
            rivet(x, y, 0.315)
    for station, x in enumerate((-0.82, 0, 0.82)):
        box((x, 0.98, 0.27), (0.64, 1.16, 0.07), "dark")
        box(
            (x, 0.98, 0.312), (0.59, 1.11, 0.018), ("copper", "dark", "iron")[station]
        )
        for dx in (-0.29, 0.29):
            box((x + dx, 0.98, 0.326), (0.025, 1.055, 0.02), "iron")
        for y in (0.43, 1.53):
            box((x, y, 0.326), (0.58, 0.025, 0.02), "iron")
        for dx in (-0.25, 0.25):
            for y in (0.48, 1.48):
                rivet(x + dx, y, 0.329)
        cylinder((x, 1.22, 0.35), (x, 1.78, 0.35), 0.052, "copper")
        for y in (1.48, 1.62):
            cylinder((x, y - 0.025, 0.35), (x, y + 0.025, 0.35), 0.069, "brass")
        # Cast bearing and machined gland make each wheel read as a working valve.
        cylinder((x, 1.05, .319), (x, 1.05, .344), .108, "iron", sides=20)
        cylinder((x, 1.05, .342), (x, 1.05, .368), .086, "brass", sides=20)
        for dx in (-.075, .075):
            rivet(x+dx, 1.05, .37)
    for i, x in enumerate((-0.82, 0, 0.82)):
        wheel(x, i)
    for x in (-1.06, 1.06):
        cylinder((x, 0.19, 0.20), (x, 0.19, 0.35), 0.085, "brass")
    gauge(0, 1.74, 0.31, 0.09, 0)


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
            cylinder((x - 0.035, y, -0.005), (x + 0.035, y, -0.005), 0.053, "brass", sides=20)
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
        swept_pipe(points, radius, "copper" if i % 3 else "patina")
        for y, sign in ((0.12, 1), (2.16, -1)):
            cylinder((x, y + sign*0.028, z), (x, y + sign*0.10, z), radius + 0.010, "brass", sides=20)
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
    for index, x in enumerate((-1.28, 0, 1.28)):
        cylinder((x, 0.12, -0.005), (x, 0.70, -0.005), 0.026, "copper")
        cylinder((x, 0.145, -0.005), (x, 0.21, -0.005), 0.038, "brass", sides=20)
        gauge(x, 0.70, 0.005, 0.12 if x else 0.10, index)
        end = (-1.30 if x < 0 else 1.30 if x > 0 else 0.83)
        swept_pipe([(x, 0.70, -0.005), (x, 1.08, -0.005), (end, 1.08, -0.005)], 0.023, "copper", bend=0.06)
        cylinder((end, 1.04, -0.005), (end, 1.12, -0.005), 0.037, "brass", sides=20)
    # Porcelain sight glass, recessed between two brass caps under the placard.
    box((0, 0.35, 0.006), (0.12, 0.30, 0.055), "iron")
    box((0, 0.35, 0.037), (0.07, 0.25, 0.012), "ivory")
    for y in (0.19, 0.51):
        box((0, y, 0.012), (0.13, 0.05, 0.065), "brass")
    box((0, 0.30, 0.046), (0.046, 0.11, 0.006), "patina", "sight-fluid")
    cylinder((0, 0.25, 0.05), (0, 0.46, 0.05), 0.003, "brass", sides=8)
    for x in (-1.55, 1.55):
        for y in (0.25, 0.65, 1.05, 1.45, 1.85, 2.08):
            rivet(x, y, -0.04)


def merge_groups(name):
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
        moving = group.startswith(("valve-", "gauge-needle-")) or group == "sight-fluid"
        o.name = group if moving else "body-" + mat
        if group.startswith("valve-"):
            index = int(group[-1])
            pivot = Vector(loc(((-0.82, 0, 0.82)[index], 1.05, 0.39)))
        elif group.startswith("gauge-needle-"):
            index = int(group[-1])
            pivot = Vector(loc((0, 1.74, .348) if name == "manifold" else
                               ((-1.28, 0, 1.28)[index], .70, .043)))
        elif group == "sight-fluid":
            pivot = Vector(loc((0, .245, .046)))
        if moving:
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
    merge_groups(name)
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
    if not os.environ.get("PRESSURE_SKIP_PREVIEW"):
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


def split_existing_instruments():
    from collections import defaultdict
    from mathutils import Vector, Matrix
    from pathlib import Path

    name = os.environ["PRESSURE_SPLIT_MODEL"]
    src = SOURCE
    bpy.ops.wm.open_mainfile(
        filepath=str(Path(os.environ["PRESSURE_SPLIT_SOURCE_DIR"]) / (name + ".blend"))
    )
    coords = {
        "manifold": [(0, 1.74, 0.348)],
        "gallery-pipes": [(-1.28, 0.70, 0.043), (0, 0.70, 0.043), (1.28, 0.70, 0.043)],
        "accumulator-bank": [(-0.64, 2.16, 0.347), (0.64, 2.16, 0.347)],
    }[name]
    targets = [(f"gauge-needle-{i}", p) for i, p in enumerate(coords)]
    if name != "manifold":
        targets.append(
            (
                "sight-fluid",
                (0, 0.245, 0.046) if name == "gallery-pipes" else (0, 1.11, 0.189),
            )
        )

    def loc(p):
        return Vector((p[0], -p[2], p[1]))

    for label, p in targets:
        candidates = []
        for o in list(bpy.context.scene.objects):
            if o.type != "MESH":
                continue
            adj = defaultdict(set)
            for e in o.data.edges:
                a, b = e.vertices
                adj[a].add(b)
                adj[b].add(a)
            seen = set()
            for v in o.data.vertices:
                if v.index in seen:
                    continue
                ids = []
                stack = [v.index]
                seen.add(v.index)
                while stack:
                    k = stack.pop()
                    ids.append(k)
                    for n in adj[k] - seen:
                        seen.add(n)
                        stack.append(n)
                if len(ids) != (8 if label == "sight-fluid" else 12):
                    continue
                pts = [o.matrix_world @ o.data.vertices[i].co for i in ids]
                lo = [min(q[i] for q in pts) for i in range(3)]
                hi = [max(q[i] for q in pts) for i in range(3)]
                pivot = loc(p)
                if label == "sight-fluid":
                    match = (
                        abs(lo[2] - pivot.z) < 0.0001
                        and abs((lo[0] + hi[0]) / 2 - pivot.x) < 0.0001
                        and abs((lo[1] + hi[1]) / 2 - pivot.y) < 0.0001
                    )
                else:
                    match = (
                        abs((lo[1] + hi[1]) / 2 - pivot.y) < 0.0001
                        and abs(lo[0] - (pivot.x - 0.00372)) < 0.0003
                        and abs(
                            lo[2]
                            - (
                                pivot.z - 0.00486
                                if name == "accumulator-bank"
                                else pivot.z - 0.00471
                            )
                        )
                        < 0.0003
                    )
                if match:
                    candidates.append((o, ids))
        assert len(candidates) == 1, (name, label, len(candidates))
        o, ids = candidates[0]
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="DESELECT")
        bpy.ops.object.mode_set(mode="OBJECT")
        for i in ids:
            o.data.vertices[i].select = True
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.separate(type="SELECTED")
        bpy.ops.object.mode_set(mode="OBJECT")
        new = next(x for x in bpy.context.selected_objects if x != o)
        pivot = loc(p)
        for v in new.data.vertices:
            v.co = new.matrix_world @ v.co - pivot
        new.matrix_world = Matrix.Identity(4)
        new.location = pivot
        new.name = label
        if not o.data.polygons:
            bpy.data.objects.remove(o, do_unlink=True)
        print("SPLIT", label, tuple(new.location), len(new.data.polygons))
    bpy.ops.wm.save_as_mainfile(filepath=str(src / (name + ".blend")))
    bpy.ops.export_scene.gltf(filepath=str(OUT / (name + ".glb")), export_format="GLB")

if os.environ.get("PRESSURE_SPLIT_MODEL"):
    split_existing_instruments()
else:
    build("manifold", manifold)
    if not os.environ.get("PRESSURE_MANIFOLD_ONLY"):
        build("gallery-pipes", gallery)
