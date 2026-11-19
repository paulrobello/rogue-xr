"""Compare furnishing triangles outside one intentionally edited subtree.

Usage: uv run --with numpy python scripts/assets/compare-interior-roots.py OLD.glb NEW.glb [candelabrum]
"""
import json
import struct
import sys
from collections import Counter

import numpy as np

ROOTS = {'DoorSingle', 'DoorDouble', 'DoorArched', 'Curtain', 'DiningChair',
         'DiningTable', 'Bookcase', 'Candelabrum', 'WallClock', 'ClockworkArmor', 'FramedPainting'}


def load(path):
    data = open(path, 'rb').read()
    length = struct.unpack_from('<I', data, 12)[0]
    return json.loads(data[20:20 + length]), data[28 + length:]


def accessor(doc, binary, index):
    a = doc['accessors'][index]
    view = doc['bufferViews'][a['bufferView']]
    dtype = np.dtype({5126: '<f4', 5125: '<u4', 5123: '<u2', 5121: 'u1'}[a['componentType']])
    width = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
    offset = view.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = view.get('byteStride', dtype.itemsize * width)
    return np.ndarray((a['count'], width), dtype=dtype, buffer=binary,
                      offset=offset, strides=(stride, dtype.itemsize)).copy()


def triangles(doc, binary, primitive, skip_uv=False):
    attrs = {k: accessor(doc, binary, v) for k, v in primitive['attributes'].items()
             if not (skip_uv and k.startswith('TEXCOORD_'))}
    indices = accessor(doc, binary, primitive['indices']).reshape(-1, 3)
    def vertex(i):
        return tuple((k, tuple(np.round(v[i].astype(float), 6))) for k, v in sorted(attrs.items()))
    result = Counter()
    for tri in indices:
        vertices = tuple(vertex(i) for i in tri)
        result[min(vertices, vertices[1:] + vertices[:1], vertices[2:] + vertices[:2])] += 1
    return result


def scene(path, candle_revision=False):
    doc, binary = load(path)
    out = {}
    def visit(i):
        node = doc['nodes'][i]
        name = node.get('name', '')
        if not candle_revision and name == 'ClockworkArmor_Visor':
            return
        children = node.get('children', [])
        if candle_revision and name == 'Candelabrum':
            children = [j for j in children if doc['nodes'][j].get('name', '').startswith('Candelabrum_FlameSocket_')]
        entry = {'transform': {k: node[k] for k in ('translation', 'rotation', 'scale', 'matrix') if k in node},
                 'children': sorted(doc['nodes'][j].get('name') for j in children),
                 'primitives': []}
        if 'mesh' in node:
            for primitive in doc['meshes'][node['mesh']]['primitives']:
                material = doc['materials'][primitive['material']]
                entry['primitives'].append((material, primitive))
        out[node['name']] = entry
        for child in children:
            visit(child)
    for i, node in enumerate(doc['nodes']):
        if node.get('name') in ROOTS:
            visit(i)
    return doc, binary, out


if len(sys.argv) not in (3, 4) or (len(sys.argv) == 4 and sys.argv[3] != 'candelabrum'):
    raise SystemExit('Expected OLD.glb NEW.glb [candelabrum]')
candle_revision = len(sys.argv) == 4
a, ab, left = scene(sys.argv[1], candle_revision)
b, bb, right = scene(sys.argv[2], candle_revision)
assert left.keys() == right.keys(), 'node names differ'
for name, x in left.items():
    y = right[name]
    assert x['transform'] == y['transform'] and x['children'] == y['children'], name
    assert len(x['primitives']) == len(y['primitives']), name
    for (xm, xp), (ym, yp) in zip(x['primitives'], y['primitives']):
        assert xm == ym, (name, 'material changed')
        assert triangles(a, ab, xp) == triangles(b, bb, yp), (name, xm['name'], 'triangle attributes differ')
print('PASS', len(left), 'nodes: transforms, material definitions and oriented triangles with attributes match outside edited geometry')
