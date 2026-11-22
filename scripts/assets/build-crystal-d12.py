"""Build the image-free crystal d12 from its shared runtime hull."""
import hashlib
import json
import math
import struct
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'assets-source/dice/crystal-d12'
STAGE = SOURCE / 'staging'
RUNTIME = ROOT / 'public/assets/dice/crystal-d12'
for directory in (SOURCE / 'blend', STAGE, RUNTIME):
    directory.mkdir(parents=True, exist_ok=True)
DATA = json.loads((ROOT / 'src/dice/crystal-d12.json').read_text())
FACES = [{'index': i, 'value': i + 1, 'normal': f['normal']} for i, f in enumerate(DATA['faces'])]

def blender_vec(p):
    return Vector((p[0], -p[2], p[1]))

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')

def material(name, color, roughness, metallic):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.use_backface_culling = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    return mat

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
body = material('crystal-body', (0.006, 0.075, 0.105), 0.22, 0.28)
marks = material('crystal-marks', (0.95, 0.75, 0.40), 0.35, 0.12)
marks_bsdf = marks.node_tree.nodes.get('Principled BSDF')
marks_bsdf.inputs['Emission Color'].default_value = (0.68, 0.39, 0.12, 1)
marks_bsdf.inputs['Emission Strength'].default_value = 0.5
vertices, polygons, assignments = [], [], []
def polygon(points, slot):
    start = len(vertices)
    vertices.extend(tuple(p) for p in points)
    polygons.append(tuple(range(start, len(vertices))))
    assignments.append(slot)

# A seven-segment engraved style, sized to remain entirely inside the pentagon.
segments = {'a': ((-0.5, 1), (0.5, 1)), 'b': ((0.5, 1), (0.5, 0)),
            'c': ((0.5, 0), (0.5, -1)), 'd': ((-0.5, -1), (0.5, -1)),
            'e': ((-0.5, 0), (-0.5, -1)), 'f': ((-0.5, 1), (-0.5, 0)),
            'g': ((-0.5, 0), (0.5, 0)), 'h': ((0, 1), (0, -1))}
digits = {'0':'abcdef', '1':'h', '2':'abged', '3':'abgcd', '4':'fgbc',
          '5':'afgcd', '6':'afgecd', '7':'abc', '8':'abcdefg', '9':'abfgcd'}

def stroke(a, b, width, centre, xaxis, yaxis, face_inner, normal):
    ax, ay = a
    bx, by = b
    length = math.hypot(bx-ax, by-ay)
    dx, dy = (bx-ax)/length, (by-ay)/length
    px, py = -dy*width/2, dx*width/2
    coords = [(ax+px,ay+py), (ax-px,ay-py), (bx-px,by-py), (bx+px,by+py)]
    points = [centre + xaxis*x + yaxis*y for x,y in coords]
    for point in points:
        for i, edge_start in enumerate(face_inner):
            edge_end = face_inner[(i+1)%5]
            edge = edge_end - edge_start
            inside = edge.cross(centre-edge_start).dot(normal)
            assert edge.cross(point-edge_start).dot(normal) * inside >= -1e-14
    polygon(points, 1)

for index, face in enumerate(DATA['faces']):
    outer = [blender_vec(DATA['vertices'][i]) for i in face['vertices']]
    normal = blender_vec(face['normal']).normalized()
    centre = sum(outer, Vector()) / 5
    # A beveled edge ring gives the solid crystal its cut silhouette. All points are within the hull.
    inner = [centre + (v-centre)*0.87 - normal*0.00032 for v in outer]
    for i in range(5):
        j = (i+1)%5
        polygon([outer[i], outer[j], inner[j], inner[i]], 0)
    polygon(inner, 0)
    # Orient each label to a pentagon vertex consistently, and keep lettering below the hull plane.
    yaxis = (outer[0]-centre).normalized()
    xaxis = yaxis.cross(normal).normalized()
    label_centre = centre - normal*0.00010
    text = str(index+1)
    scale = 0.0061 if len(text) == 1 else 0.0055
    advance = scale*1.4
    for n, digit in enumerate(text):
        shift = (n-(len(text)-1)/2)*advance
        for key in digits[digit]:
            a,b = segments[key]
            stroke((shift+a[0]*scale,a[1]*scale), (shift+b[0]*scale,b[1]*scale),
                   scale*0.34, label_centre, xaxis, yaxis, inner, normal)
    if text in ('6','9'):
        stroke((-scale*0.5,-scale*1.35), (scale*0.5,-scale*1.35),
               scale*0.22, label_centre, xaxis, yaxis, inner, normal)

mesh = bpy.data.meshes.new('crystal-d12-mesh')
mesh.from_pydata(vertices, [], polygons)
mesh.update()
obj = bpy.data.objects.new('crystal-d12', mesh)
bpy.context.collection.objects.link(obj)
mesh.materials.append(body)
mesh.materials.append(marks)
for poly, slot in zip(mesh.polygons, assignments):
    poly.material_index = slot
uv = mesh.uv_layers.new(name='UVMap')
for item in uv.data:
    item.uv = (0.5, 0.5)
bpy.context.view_layer.objects.active = obj
obj.select_set(True)
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE / 'blend/crystal-d12.low.blend'))
# No map bake or separate high detail is necessary for this factor-only asset.
bpy.ops.export_scene.gltf(filepath=str(STAGE / 'crystal-d12.glb'), export_format='GLB',
    use_active_scene=True, export_texcoords=True, export_normals=True, export_image_format='NONE',
    export_cameras=False, export_lights=False, export_skins=False, export_animations=False,
    export_extras=False, export_yup=True)

# Attach the exact gameplay face table as GLB node extras.
path = STAGE / 'crystal-d12.glb'
data = path.read_bytes()
jlen = struct.unpack_from('<I', data, 12)[0]
gltf = json.loads(data[20:20+jlen])
binlen = struct.unpack_from('<I', data, 20+jlen)[0]
binary = data[28+jlen:28+jlen+binlen]
node = next(n for n in gltf['nodes'] if n.get('name') == 'crystal-d12')
node['extras'] = {'die': {'faces': FACES}}
js = json.dumps(gltf, separators=(',', ':')).encode()
js += b' ' * (-len(js)%4)
binary += b'\0' * (-len(binary)%4)
path.write_bytes(struct.pack('<III', 0x46546c67, 2, 28+len(js)+len(binary)) +
                 struct.pack('<II', len(js), 0x4e4f534a) + js +
                 struct.pack('<II', len(binary), 0x004e4942) + binary)
assert len(gltf['materials']) == 2 and len(gltf['meshes'][0]['primitives']) == 2
assert not gltf.get('images') and all('TEXCOORD_0' in p['attributes'] for p in gltf['meshes'][0]['primitives'])
assert all(not m.get('doubleSided', False) for m in gltf['materials'])
tris = sum(gltf['accessors'][p['indices']]['count']//3 for p in gltf['meshes'][0]['primitives'])
assert tris <= 1500
bounds = {'min': [min(v[i] for v in DATA['vertices']) for i in range(3)],
          'max': [max(v[i] for v in DATA['vertices']) for i in range(3)]}
manifest = {'id':'crystal-d12', 'version':1, 'kind':'d12', 'glb':'crystal-d12.glb', 'node':'crystal-d12',
    'frame':{'units':'m', 'up':'+Y', 'origin':'die centre', 'convention':'src/dice/crystal-d12.json die-local frame', 'uv':'TEXCOORD_0 reserved; marks are geometry'},
    'collider':{'shape':'convexHull', 'circumradius':DATA['circumradius'], 'source':'src/dice/crystal-d12.json'},
    'bounds':bounds, 'faces':FACES,
    'materialSlots':{'crystal-body':{'role':'body', 'factorOnly':True, 'roughness':0.22, 'metalness':0.28},
                     'crystal-marks':{'role':'face', 'factorOnly':True, 'roughness':0.35, 'metalness':0.12,
                                      'emissiveFactor':[0.34, 0.195, 0.06]}},
    'budget':{'tris':tris, 'materials':2, 'texturesProduced':0, 'texturesSampled':[]}}
write_json(STAGE / 'crystal-d12.manifest.json', manifest)
# Import the exact staged bytes, not the source mesh.
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(path))
imported = [o for o in bpy.context.scene.objects if o.type == 'MESH']
imported_tris = sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in imported)
assert len(imported) == 1 and imported_tris == tris
assert sorted(m.name.split('.')[0] for m in imported[0].data.materials) == ['crystal-body', 'crystal-marks']
report = {'glb_sha256':sha(path), 'glb_bytes':path.stat().st_size, 'triangles':tris,
          'materials':['crystal-body','crystal-marks'], 'bounds':bounds, 'errors':[], 'pass':True,
          'blender_reimport':{'objects':1,'meshes':1,'triangles':imported_tris,'materials':['crystal-body','crystal-marks']}}
write_json(STAGE / 'reimport.json', report)
write_json(STAGE / 'report.json', {'pieceId':'crystal-d12', 'blender':bpy.app.version_string, 'reimport':report,
    'modeling':'Original faceted solid with enlarged bold planar inset seven-segment numerals. 6 and 9 are underlined.',
    'bake':'none; factor-only materials', 'lods':'LOD0 only'})
for filename in ('crystal-d12.glb','crystal-d12.manifest.json'):
    (RUNTIME / filename).write_bytes((STAGE / filename).read_bytes())
files = [RUNTIME/'crystal-d12.glb', RUNTIME/'crystal-d12.manifest.json', SOURCE/'blend/crystal-d12.low.blend', STAGE/'report.json', STAGE/'reimport.json']
provenance = {'pieceId':'crystal-d12','version':1, 'route':'original scripted Blender geometry, no external assets',
    'generator':{'path':'scripts/assets/build-crystal-d12.py','sha256':sha(Path(__file__))},
    'authoringAgent':{'harness':'codex subagent','model':'gpt-6.1-terra'}, 'blender':bpy.app.version_string,
    'license':'Original work authored for the project; no third-party asset inputs.',
    'sourceContract':{'path':'src/dice/crystal-d12.json','sha256':sha(ROOT/'src/dice/crystal-d12.json')},
    'derivedFiles':[{'path':str(p.relative_to(ROOT)),'sha256':sha(p),'bytes':p.stat().st_size} for p in files],
    'budgets':manifest['budget'], 'validation':{'pass':True,'scope':'Blender reimport and structural checks; runtime and owner review remain pending'},
    'approvals':[{'gate':g,'status':'pending'} for g in ('technical','creative','rights','owner','independent visual score')]}
write_json(SOURCE/'provenance.json', provenance)
print('CRYSTAL_D12', json.dumps(report))
