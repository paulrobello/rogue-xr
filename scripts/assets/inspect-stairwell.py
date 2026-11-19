"""Reimport staged stairwell and report semantic roots, bounds and triangles."""

import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector
from mathutils.geometry import intersect_ray_tri

p = Path(sys.argv[sys.argv.index("--") + 1])
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(p))
report = {}
for name in ("StairUp", "StairDown"):
    root = bpy.data.objects.get(name)
    assert root, name
    meshes = [o for o in root.children_recursive if o.type == "MESH"]
    assert meshes
    verts = [o.matrix_world @ v.co for o in meshes for v in o.data.vertices]
    assert all(math.isfinite(c) for v in verts for c in v)
    report[name] = {
        "meshes": len(meshes),
        "triangles": sum(len(o.data.polygons) for o in meshes),
        "blender_bounds": [
            [min(v[i] for v in verts), max(v[i] for v in verts)] for i in range(3)
        ],
        "materials": sorted({m.name for o in meshes for m in o.data.materials if m}),
    }
    assert (
        len(meshes) >= 7
        and 0 < report[name]["triangles"] < 15000
    )
    expected = ((-1.5, 1.5), (-6.14, 0.0), (-1.88, 4.12))
    assert all(
        abs(actual - target) < 0.001
        for pair, want in zip(report[name]["blender_bounds"], expected)
        for actual, target in zip(pair, want)
    )
    assert len(report[name]["materials"]) == (6 if name == "StairUp" else 7)
    pivot = bpy.data.objects[name + "_DoorPivot"]
    socket = bpy.data.objects[name + "_HandleSocket"]
    assert socket.parent == pivot
    assert abs(pivot.matrix_world.translation.x + 0.59) < 1e-5
    assert abs(pivot.matrix_world.translation.y + 4.915) < 1e-5
    assert abs(socket.matrix_world.translation.x - 0.44) < 1e-5
    assert abs(socket.matrix_world.translation.y + 4.775) < 1e-5
    # Count actual exported upward-facing surfaces at the former tread/landing overlap.
    landing_height = 1.62 if name == "StairUp" else -1.62
    triangles = []
    for mesh in meshes:
        mesh.data.calc_loop_triangles()
        for tri in mesh.data.loop_triangles:
            points = [mesh.matrix_world @ mesh.data.vertices[i].co for i in tri.vertices]
            if all(abs(v.z - landing_height) < 1e-5 for v in points):
                triangles.append(points)
    for z in (3.721, 3.779, 3.841, 3.919, 3.989, 4.073):
        origin = Vector((0.317, -z, landing_height + 0.5))
        hits = [intersect_ray_tri(*tri, Vector((0, 0, -1)), origin, True) for tri in triangles]
        assert sum(hit is not None for hit in hits) == 1, (name, z, hits)
    for i in range(9):
        boundary = 0.91 + i * 0.34
        previous_height = (1 if name == "StairUp" else -1) * 0.18 * i
        triangles = []
        for mesh in meshes:
            for tri in mesh.data.loop_triangles:
                points = [mesh.matrix_world @ mesh.data.vertices[j].co for j in tri.vertices]
                if all(abs(v.z - previous_height) < 1e-5 for v in points):
                    triangles.append(points)
        origin = Vector((0.317, -(boundary - 0.025), previous_height + 0.5))
        hits = [intersect_ray_tri(*tri, Vector((0, 0, -1)), origin, True) for tri in triangles]
        assert sum(hit is not None for hit in hits) == 1, (name, i, hits)
    vertical_checks = 0
    for i in range(9):
        boundary = 0.91 + i * 0.34
        h = (1 if name == "StairUp" else -1) * 0.18 * (i + 1)
        for offset in (0.025, 0.065, 0.115, 0.155):
            y = h - offset if name == "StairUp" else h + offset
            origin = Vector((0.317, -boundary + 0.04, y))
            depths = []
            for mesh in meshes:
                for tri in mesh.data.loop_triangles:
                    points = [mesh.matrix_world @ mesh.data.vertices[j].co for j in tri.vertices]
                    if not all(abs(v.y + boundary) < 0.012 for v in points):
                        continue
                    hit = intersect_ray_tri(*points, Vector((0, -1, 0)), origin, True)
                    if hit is not None:
                        depths.append(-hit.y)
            depths.sort()
            assert depths, (name, i, y)
            assert all(b - a > 0.0005 for a, b in zip(depths, depths[1:])), (name, i, y, depths)
            vertical_checks += 1
    report[name]["vertical_face_samples"] = vertical_checks
    report[name]["riser_overlap_surface_samples"] = 9
    report[name]["landing_surface_samples"] = 6
    report[name]["door_pivot"] = list(pivot.matrix_world.translation)
    report[name]["handle_socket"] = list(socket.matrix_world.translation)
print("REIMPORT_REPORT " + json.dumps(report, sort_keys=True))
