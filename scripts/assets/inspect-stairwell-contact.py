import json
import math
import sys

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

p = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.open_mainfile(filepath=p)
bpy.context.view_layer.update()


def axis(o):
    low = min(v.co.z for v in o.data.vertices)
    high = max(v.co.z for v in o.data.vertices)
    return [o.matrix_world @ Vector((0, 0, low)), o.matrix_world @ Vector((0, 0, high))]


def world_tree(obj, depsgraph):
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    try:
        vertices = [evaluated.matrix_world @ v.co for v in mesh.vertices]
        faces = [tuple(poly.vertices) for poly in mesh.polygons]
        return BVHTree.FromPolygons(vertices, faces)
    finally:
        evaluated.to_mesh_clear()


def bounds(o):
    points = [o.matrix_world @ v.co for v in o.data.vertices]
    return [(min(p[i] for p in points), max(p[i] for p in points)) for i in range(3)]


r = {}
for n in ["StairUp", "StairDown"]:
    root = bpy.data.objects[n]
    objs = list(root.children_recursive)
    stringers = [
        o for o in objs if o.name.startswith(n + " stringer") and "anchor" not in o.name
    ]
    posts = [
        o for o in objs if o.name.startswith(n + " baluster") and "collar" not in o.name
    ]
    feet = [o for o in objs if o.name.startswith(n + " landing post foot")]
    anchors = [o for o in objs if o.name.startswith(n + " stringer landing anchor")]
    assert (len(stringers), len(posts), len(feet), len(anchors)) == (2, 18, 4, 2)
    penetrations = []
    for post in posts:
        a, b = axis(post)
        midpoint = (a + b) / 2
        sa, sb = axis(min(stringers, key=lambda s: abs(s.location.x - post.location.x)))
        t = (midpoint.y - sa.y) / (sb.y - sa.y)
        assert 0 < t < 1
        y = sa.z + t * (sb.z - sa.z)
        low, high = sorted((a.z, b.z))
        assert low < y < high
        penetrations.append(y - low)
    threshold = bounds(bpy.data.objects[n + " threshold"])
    first_tread = bounds(bpy.data.objects[n + " tread 00"])
    first_riser = bounds(bpy.data.objects[n + " riser 00"])
    assert abs(threshold[1][0] - first_riser[1][0] - 0.003) < 1e-5
    assert abs(first_tread[1][1] - first_riser[1][0] - 0.003) < 1e-5
    for i in range(9):
        tread = bounds(bpy.data.objects[f"{n} tread {i:02d}"])
        nose = bounds(bpy.data.objects[f"{n} nosing {i:02d}"])
        riser = bpy.data.objects[f"{n} riser {i:02d}"]
        rb = bounds(riser)
        assert abs(tread[1][1] - rb[1][0] - 0.003) < 1e-5
        assert abs(tread[1][1] - rb[1][1] - 0.003) < 1e-5
        assert all(abs(poly.normal.z) < 1e-5 for poly in riser.data.polygons)
        if i:
            previous = bounds(bpy.data.objects[f"{n} tread {i - 1:02d}"])
            assert abs(previous[1][0] - rb[1][0] - 0.003) < 1e-5
        assert nose[1][1] <= tread[1][1] + 1e-5
        if n == "StairUp":
            support = bounds(bpy.data.objects[f"{n} step support {i:02d}"])
            assert rb[1][0] - support[1][1] >= 0.0029
        assert nose[2][1] > tread[2][1] + 0.01
        for floor in [o for o in objs if o.name.startswith(n + " side floor")]:
            fb = bounds(floor)
            assert min(tread[0][1], fb[0][1]) <= max(tread[0][0], fb[0][0])
    landing = bpy.data.objects[n + " landing"]
    lb = bounds(landing)
    overlaps = []
    for foot in feet + anchors:
        fb = bounds(foot)
        overlap = [min(fb[i][1], lb[i][1]) - max(fb[i][0], lb[i][0]) for i in range(3)]
        assert all(x > 0 for x in overlap), (foot.name, overlap)
        overlaps.append(overlap)
    side_floors = [o for o in objs if o.name.startswith(n + " side floor")]
    assert len(side_floors) == 2
    for stringer in stringers:
        start, end = sorted(axis(stringer), key=lambda v: -v.y)
        floor = min(side_floors, key=lambda o: abs(o.location.x - stringer.location.x))
        anchor = min(anchors, key=lambda o: abs(o.location.x - stringer.location.x))
        for point, support in ((start, floor), (end, anchor)):
            limits = bounds(support)
            assert all(limits[i][0] < point[i] < limits[i][1] for i in range(3))
    assert bpy.data.objects.get(n + " access door")
    sign = bpy.data.objects[n + " sign backplate"]
    assert abs(sign.matrix_world.translation.y + 4.815) < 1e-5
    assert sign.parent.name == n + "_DoorPivot"
    pivot = bpy.data.objects[n + "_DoorPivot"]
    leaves = [o for o in pivot.children if o.type == "MESH"]
    obstacles = [o for o in objs if any(s in o.name for s in
                 ("back wall", "recess side", "recess back", "door jamb", "door lintel"))]
    lintel = bounds(bpy.data.objects[n + " door lintel"])
    jambs = [o for o in objs if o.name.startswith(n + " door jamb")]
    liners = [o for o in objs if o.name.startswith(n + " recess side")]
    cap = bounds(bpy.data.objects[n + " recess cap"])
    assert len(jambs) == len(liners) == 2
    leaf_bounds = bounds(bpy.data.objects[n + " access door"])
    recess_floor = bounds(bpy.data.objects[n + " recess floor"])
    # Blender's negative Y points toward increasing runtime Z.
    assert recess_floor[1][1] < leaf_bounds[1][0], (n, "black floor before leaf back")
    assert recess_floor[1][1] > lb[1][0], (n, "recess floor misses landing")
    assert abs(leaf_bounds[2][0] - lb[2][1]) < 1e-5, (n, "door foot above landing")
    head_reveal = lintel[2][0] - leaf_bounds[2][1]
    assert 0.0049 <= head_reveal <= 0.0051, (n, "head reveal", head_reveal)
    for jamb in jambs:
        jb = bounds(jamb)
        assert jb[2][1] <= lintel[2][0] + 1e-6, (n, "jamb lintel overlap", jb, lintel)
        for liner in liners:
            assert bounds(liner)[1][1] < jb[1][1] - 0.04, (n, "liner frame clearance")
    assert cap[1][1] < lintel[1][1] - 0.04, (n, "liner lintel clearance")
    for angle in range(0, 76, 5):
        pivot.rotation_euler.z = -math.radians(angle)
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()
        for leaf in leaves:
            leaf_tree = world_tree(leaf, depsgraph)
            for obstacle in obstacles:
                other_tree = world_tree(obstacle, depsgraph)
                assert not leaf_tree.overlap(other_tree), (n, angle, leaf.name, obstacle.name)
    pivot.rotation_euler.z = 0
    bpy.context.view_layer.update()
    r[n] = {
        "riser_vertical_face_count": 9,
        "door_clear_travel_degrees": 75,
        "door_closed_contact_checked": True,
        "black_floor_behind_leaf_m": leaf_bounds[1][0] - recess_floor[1][1],
        "black_floor_landing_overlap_m": recess_floor[1][1] - lb[1][0],
        "frame_liner_front_clearance_m_min": 0.065,
        "posts": len(posts),
        "post_axis_penetration_m_min": min(penetrations),
        "landing_anchors": len(feet) + len(anchors),
        "landing_overlap_m_min": min(min(x) for x in overlaps),
    }
print("CONTACT_REPORT " + json.dumps(r, sort_keys=True))
