"""Reimport staged stairwell and report semantic roots, bounds and triangles."""

import json
import math
import struct
import sys
from pathlib import Path

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import intersect_ray_tri

p = Path(sys.argv[sys.argv.index("--") + 1])
data = p.read_bytes()
assert data[:4] == b"glTF"
length, chunk_type = struct.unpack_from("<II", data, 12)
assert chunk_type == 0x4E4F534A
gltf = json.loads(data[20 : 20 + length])
recess = next(m for m in gltf["materials"] if m["name"] == "Stairwell dark recess")
assert "KHR_materials_unlit" in recess.get("extensions", {})
assert recess.get("pbrMetallicRoughness", {}).get("baseColorFactor") == [0, 0, 0, 1]
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(p))


def material_tree(meshes: list, material_name: str) -> BVHTree:
    vertices, faces = [], []
    for obj in meshes:
        mesh = obj.data
        offset = len(vertices)
        vertices.extend(obj.matrix_world @ v.co for v in mesh.vertices)
        faces.extend(
            tuple(offset + i for i in poly.vertices)
            for poly in mesh.polygons
            if mesh.materials[poly.material_index].name == material_name
        )
    return BVHTree.FromPolygons(vertices, faces)


def check_rail_clearance(root, sign: int) -> dict:
    fixed = [o for o in root.children if o.type == "MESH"]
    wood = material_tree(fixed, "Stairwell walnut")
    stone = material_tree(fixed, "Stairwell stone")
    iron = [obj.matrix_world @ vertex.co for obj in fixed if obj.data.materials[0].name == "Stairwell dark iron"
            for vertex in obj.data.vertices]
    stations = [(1.08 + j * 0.34, sign * (j + 1) * 0.18) for j in range(9)]
    stations.extend((z, sign * 1.62) for z in (4.0, 4.65))
    gaps, cap_samples, exposed = [], 0, []
    for side in (-1, 1):
        center = side * 1.04
        for z, floor in stations:
            cap = {tuple(round(c, 6) for c in v) for v in iron if abs(v.x - center) < 0.04
                   and abs(v.y + z) < 0.04 and abs(v.z - floor - 0.84) < 1e-4}
            assert len(cap) == 8, (root.name, side, z, "iron post cap", cap)
            hit, _, _, _ = stone.ray_cast(Vector((side * 0.99, -z, -0.1)), Vector((side, 0, 0)))
            assert hit is not None, (root.name, z, "missing side masonry")
            gaps.append(side * hit.x - max(side * v[0] for v in cap))
            for vertex in cap:
                for dx in (-1, 1):
                    direction = Vector((dx, 0, 0))
                    hit, normal, _, _ = wood.ray_cast(Vector(vertex), direction, 0.09)
                    if hit is None or direction.dot(normal) <= 0:
                        exposed.append((vertex, dx))
                    cap_samples += 1
    assert min(gaps) >= 0.077 and not exposed, (root.name, "post to masonry gap", min(gaps), "exposed post cap", exposed)
    return {"rail_post_masonry_clearance_m_min": min(gaps), "rail_post_cap_wood_rays": cap_samples}


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
    report[name].update(check_rail_clearance(root, 1 if name == "StairUp" else -1))
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
    # Inspect actual exported triangles, including the liner behind the frame.
    # A ray can hit the frame bevel before its flat front, so compare ray depths.
    fixed_meshes = [o for o in root.children if o.type == "MESH"]
    frame_samples = [(-0.615, 0.7), (0.615, 0.7), (-0.615, 1.7), (0.615, 1.7), (0.2, 2.157)]
    frame_checks = 0
    for x, y in frame_samples:
        target = Vector((x, -4.75, landing_height + y))
        for dx, dz in ((0, 0), (0.12, 0.04), (-0.12, -0.04)):
            direction = Vector((dx, -1, dz)).normalized()
            origin = target - direction * 0.5
            depths = {"Stairwell walnut": [], "Stairwell dark recess": []}
            for mesh in fixed_meshes:
                mesh.data.calc_loop_triangles()
                for tri in mesh.data.loop_triangles:
                    mat = mesh.data.materials[mesh.data.polygons[tri.polygon_index].material_index]
                    if mat.name not in depths:
                        continue
                    points = [mesh.matrix_world @ mesh.data.vertices[j].co for j in tri.vertices]
                    hit = intersect_ray_tri(*points, direction, origin, True)
                    if hit is not None:
                        depth = (hit - origin).dot(direction)
                        if depth >= 0:
                            depths[mat.name].append(depth)
            wood, black = depths["Stairwell walnut"], depths["Stairwell dark recess"]
            assert wood, (name, x, y, dx, dz, "missing frame")
            if dx == 0:
                assert black, (name, x, y, "missing liner")
            if black:
                assert min(black) - min(wood) > 0.04, (name, x, y, dx, dz, depths)
            frame_checks += 1
    report[name]["frame_liner_ray_samples"] = frame_checks
    # With the leaf open, the aperture remains black beyond the wooden sill.
    def first_material(origin, direction):
        hits = []
        for mesh in fixed_meshes:
            for tri in mesh.data.loop_triangles:
                points = [mesh.matrix_world @ mesh.data.vertices[j].co for j in tri.vertices]
                hit = intersect_ray_tri(*points, direction, origin, True)
                if hit is not None:
                    depth = (hit - origin).dot(direction)
                    if depth >= 0:
                        mat = mesh.data.materials[mesh.data.polygons[tri.polygon_index].material_index]
                        hits.append((depth, mat.name))
        assert hits, (name, origin, direction)
        return min(hits)[1]
    for x in (-0.3, 0.3):
        for height in (0.01, 0.08, 0.25):
            assert first_material(Vector((x, -4.74, landing_height + height)), Vector((0, -1, 0))) == "Stairwell dark recess"
        for z in (4.76, 4.80, 4.82, 4.90, 4.92, 4.93):
            assert first_material(Vector((x, -z, landing_height + 0.10)), Vector((0, 0, -1))) == "Stairwell walnut", (name, x, z, "landing")
        for z in (4.94, 5.0, 5.5):
            assert first_material(Vector((x, -z, landing_height + 0.10)), Vector((0, 0, -1))) == "Stairwell dark recess"
    report[name]["open_aperture_and_sill_samples"] = 24
    coverage = 0
    for x in (-0.55, 0, 0.55):
        for height in (0.01, 0.10, 1.0, 2.10, 2.115, 2.12, 2.13, 2.14, 2.15):
            origin = Vector((x, -4.74, landing_height + height))
            expected_material = "Stairwell walnut" if height >= 2.125 else "Stairwell dark recess"
            assert first_material(origin, Vector((0, -1, 0))) == expected_material, (name, x, height)
            if height >= 2.125:
                behind_frame = Vector((x, -4.86, landing_height + height))
                assert first_material(behind_frame, Vector((0, -1, 0))) == "Stairwell dark recess", (name, x, height)
            coverage += 1
        for dx, dz in ((0, 0.25), (0.12 if x >= 0 else -0.12, 0.08)):
            origin = Vector((x, -4.74, landing_height + 2.115))
            direction = Vector((dx, -1, dz)).normalized()
            assert first_material(origin, direction) in {"Stairwell dark recess", "Stairwell walnut"}, (name, x, dx, dz)
            behind_frame = Vector((x, -4.86, landing_height + 2.115))
            assert first_material(behind_frame, direction) == "Stairwell dark recess", (name, x, dx, dz)
            coverage += 1
    report[name]["aperture_edge_coverage_samples"] = coverage
    wall_samples = 0
    for x in (-0.64, -0.63, 0.63, 0.64):
        for height in (-0.21, 2.24, 2.30):
            origin = Vector((x, -4.74, landing_height + height))
            assert first_material(origin, Vector((0, -1, 0))) == "Stairwell stone", (name, x, height)
            wall_samples += 1
    report[name]["wall_infill_samples"] = wall_samples
    report[name]["vertical_face_samples"] = vertical_checks
    report[name]["riser_overlap_surface_samples"] = 9
    report[name]["landing_surface_samples"] = 6
    report[name]["door_pivot"] = list(pivot.matrix_world.translation)
    report[name]["handle_socket"] = list(socket.matrix_world.translation)
print("REIMPORT_REPORT " + json.dumps(report, sort_keys=True))
