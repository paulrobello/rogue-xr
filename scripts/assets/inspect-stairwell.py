"""Reimport staged stairwell and report semantic roots, bounds and triangles."""

import json
import math
import sys
from pathlib import Path

import bpy

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
        len(meshes) == (5 if name == "StairUp" else 6)
        and 0 < report[name]["triangles"] < 12000
    )
    expected = ((-1.5, 1.5), (-5.0, 0.0), (-1.88, 4.12))
    assert all(
        abs(actual - target) < 0.001
        for pair, want in zip(report[name]["blender_bounds"], expected)
        for actual, target in zip(pair, want)
    )
    assert len(report[name]["materials"]) == (5 if name == "StairUp" else 6)
print("REIMPORT_REPORT " + json.dumps(report, sort_keys=True))
