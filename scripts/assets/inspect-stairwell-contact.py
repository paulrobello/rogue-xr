import json
import sys

import bpy
from mathutils import Vector

p = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.open_mainfile(filepath=p)
bpy.context.view_layer.update()


def axis(o):
    low = min(v.co.z for v in o.data.vertices)
    high = max(v.co.z for v in o.data.vertices)
    return [o.matrix_world @ Vector((0, 0, low)), o.matrix_world @ Vector((0, 0, high))]


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
    assert abs(sign.location.y + 4.815) < 1e-5
    r[n] = {
        "posts": len(posts),
        "post_axis_penetration_m_min": min(penetrations),
        "landing_anchors": len(feet) + len(anchors),
        "landing_overlap_m_min": min(min(x) for x in overlaps),
    }
print("CONTACT_REPORT " + json.dumps(r, sort_keys=True))
