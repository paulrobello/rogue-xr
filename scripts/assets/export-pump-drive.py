"""Export the two reviewed gear roots from puzzle-instruments.blend.

blender -b --factory-startup --python-exit-code 1 -P export-pump-drive.py -- --source SOURCE.blend --out pump-drive.glb --report report.json
"""
import argparse
import hashlib
import json
import sys

import bpy
from mathutils import Vector

parser = argparse.ArgumentParser()
parser.add_argument('--source', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--report', required=True)
a = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
names = ('gear_small', 'gear_medium')
bpy.ops.wm.open_mainfile(filepath=a.source)
bpy.ops.object.select_all(action='DESELECT')
for name in names:
    root = bpy.data.objects[name]
    root.select_set(True)
    for obj in root.children_recursive:
        obj.select_set(True)
bpy.context.view_layer.objects.active = bpy.data.objects[names[0]]
bpy.ops.export_scene.gltf(filepath=a.out, export_format='GLB', use_selection=True,
                          use_active_scene=True, export_yup=True, export_lights=False,
                          export_cameras=False)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=a.out)
bpy.context.view_layer.update()
roots = {obj.name: obj for obj in bpy.context.scene.objects if obj.parent is None}
assert set(roots) == set(names), list(roots)
assert not [o for o in bpy.context.scene.objects if o.type in {'LIGHT', 'CAMERA'}]
items = []
for name in names:
    root = roots[name]
    assert root.type == 'EMPTY' and root.location.length < 1e-7
    meshes = [o for o in root.children_recursive if o.type == 'MESH']
    assert meshes
    points = [root.matrix_world.inverted() @ (o.matrix_world @ Vector(c)) for o in meshes for c in o.bound_box]
    # Blender importer restores Z-up. Convert to Three.js/glTF Y-up: (x,z,-y).
    converted = [(p.x, p.z, -p.y) for p in points]
    lo = [min(p[i] for p in converted) for i in range(3)]
    hi = [max(p[i] for p in converted) for i in range(3)]
    items.append({'id': name, 'bounds_min_m_y_up': lo, 'bounds_max_m_y_up': hi,
                  'dimensions_m_y_up': [hi[i]-lo[i] for i in range(3)],
                  'shaft_axis_y_up': [0, 1, 0],
                  'triangles': sum(len(o.data.polygons) for o in meshes)})
with open(a.out, 'rb') as f:
    output_hash = hashlib.sha256(f.read()).hexdigest()
with open(a.source, 'rb') as f:
    source_hash = hashlib.sha256(f.read()).hexdigest()
report = {'schema': 1, 'source_sha256': source_hash, 'glb_sha256': output_hash,
          'blender': bpy.app.version_string, 'frame': 'glTF/Three.js Y-up metres',
          'mount': 'Rotate +Y shaft axis to machine +Z about +X by +90 degrees.',
          'reimport': 'passed', 'pieces': items}
with open(a.report, 'w') as f:
    json.dump(report, f, indent=2)
print('PUMP_DRIVE_REIMPORT_OK', json.dumps(report))
