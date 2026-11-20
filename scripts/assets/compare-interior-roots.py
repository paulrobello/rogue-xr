"""Compare furnishing triangles outside one intentionally edited subtree.

Usage: uv run --with numpy python scripts/assets/compare-interior-roots.py OLD.glb NEW.glb [candelabrum|armor]
"""
import hashlib
import json
import struct
import sys

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


def triangles(doc, binary, primitive):
    attrs = primitive['attributes']
    order = ['POSITION', *sorted(k for k in attrs if k != 'POSITION')]
    corners = np.concatenate([accessor(doc, binary, attrs[k]) for k in order], axis=1)
    indices = accessor(doc, binary, primitive['indices']).reshape(-1, 3)
    return corners[indices]


def matching_triangles(left, right, tolerance=1e-6):
    """Compare cyclic vertex order with an absolute metric tolerance, including bin edges."""
    if left.shape != right.shape:
        return False
    from collections import defaultdict
    from itertools import product
    bins = defaultdict(set)
    cell_size = .001
    def cell(triangle):
        return tuple(np.floor(triangle[:, :3].mean(axis=0) / cell_size).astype(int))
    for i, triangle in enumerate(right):
        bins[cell(triangle)].add(i)
    offsets = [(0,0,0), *[v for v in product((-1,0,1), repeat=3) if any(v)]]
    for triangle in left:
        x,y,z = cell(triangle)
        matched = False
        for dx,dy,dz in offsets:
            group = bins.get((x+dx,y+dy,z+dz))
            if not group:
                continue
            for i in tuple(group):
                if any(np.allclose(triangle, np.roll(right[i],j,axis=0), rtol=0, atol=tolerance) for j in range(3)):
                    group.remove(i)
                    matched = True
                    break
            if matched:
                break
        if not matched:
            return False
    return True


def material_content(document, binary, material):
    """Texture indices may shift when a new material precedes an unchanged one in the GLB."""
    result = json.loads(json.dumps(material))
    slots = [result.get(k) for k in ('normalTexture', 'occlusionTexture', 'emissiveTexture')]
    pbr = result.get('pbrMetallicRoughness', {})
    slots.extend(pbr.get(k) for k in ('baseColorTexture', 'metallicRoughnessTexture'))
    for slot in filter(None, slots):
        texture = document['textures'][slot.pop('index')]
        image = document['images'][texture['source']]
        view = document['bufferViews'][image['bufferView']]
        start = view.get('byteOffset', 0)
        slot['imageHash'] = hashlib.sha256(binary[start:start+view['byteLength']]).hexdigest()
        slot['sampler'] = document['samplers'][texture['sampler']] if 'sampler' in texture else None
    return result


def scene(path, revision='visor'):
    doc, binary = load(path)
    out = {}
    def visit(i):
        node = doc['nodes'][i]
        name = node.get('name', '')
        if (revision == 'visor' and name == 'ClockworkArmor_Visor') or (revision == 'armor' and name == 'ClockworkArmor'):
            return
        children = node.get('children', [])
        if revision == 'candelabrum' and name == 'Candelabrum':
            children = [j for j in children if doc['nodes'][j].get('name', '').startswith('Candelabrum_FlameSocket_')]
        entry = {'transform': {k: node[k] for k in ('translation', 'rotation', 'scale', 'matrix') if k in node},
                 'children': sorted(doc['nodes'][j].get('name') for j in children),
                 'primitives': []}
        if 'mesh' in node:
            for primitive in doc['meshes'][node['mesh']]['primitives']:
                material = doc['materials'][primitive['material']]
                entry['primitives'].append((material_content(doc, binary, material), primitive))
        out[node['name']] = entry
        for child in children:
            visit(child)
    for i, node in enumerate(doc['nodes']):
        if node.get('name') in ROOTS:
            visit(i)
    return doc, binary, out


if len(sys.argv) not in (3, 4) or (len(sys.argv) == 4 and sys.argv[3] not in ('candelabrum', 'armor')):
    raise SystemExit('Expected OLD.glb NEW.glb [candelabrum|armor]')
revision = sys.argv[3] if len(sys.argv) == 4 else 'visor'
a, ab, left = scene(sys.argv[1], revision)
b, bb, right = scene(sys.argv[2], revision)
assert left.keys() == right.keys(), 'node names differ'
for name, x in left.items():
    y = right[name]
    assert x['transform'] == y['transform'] and x['children'] == y['children'], name
    assert len(x['primitives']) == len(y['primitives']), name
    for (xm, xp), (ym, yp) in zip(x['primitives'], y['primitives']):
        assert xm == ym, (name, 'material changed')
        assert matching_triangles(triangles(a, ab, xp), triangles(b, bb, yp)), (name, xm['name'], 'triangle attributes differ')
print('PASS', len(left), 'nodes: transforms, material definitions and oriented triangles with attributes match outside edited geometry')
