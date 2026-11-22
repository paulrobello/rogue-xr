"""Clockwork Spire stone dungeon kit. Run with Blender --python-exit-code 1.

All dimensions are metres. Blender -Y faces into the room; glTF converts it to +Z.
The exported file stays staged until the application's checks and visual review pass.
"""
import hashlib
import json
import math
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'assets-source/props/stone-dungeon-kit'
STAGING = SOURCE / 'staging'
STAGING.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)


def material(name, color, roughness, metallic=0.0, emission=0.0):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    shader = m.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Roughness'].default_value = roughness
    shader.inputs['Metallic'].default_value = metallic
    if emission:
        shader.inputs['Emission Color'].default_value = (*color, 1)
        shader.inputs['Emission Strength'].default_value = emission
    return m


limestone = material('Stone limestone', (.46, .42, .35), .88)
stone_shade = material('Stone shaded limestone', (.40, .385, .33), .92)
stone_pale = material('Stone pale limestone', (.51, .48, .41), .9)
stone_moss = material('Stone moss stain', (.355, .35, .30), .96)
stone_moss.surface_render_method = 'DITHERED'
stain_shader = stone_moss.node_tree.nodes.get('Principled BSDF')
stain_color = stone_moss.node_tree.nodes.new('ShaderNodeVertexColor')
stain_color.layer_name = 'Stain'
stone_moss.node_tree.links.new(stain_color.outputs['Color'], stain_shader.inputs['Base Color'])
stone_moss.node_tree.links.new(stain_color.outputs['Alpha'], stain_shader.inputs['Alpha'])
mortar = material('Stone warm mortar', (.25, .225, .18), .97)
edge = material('Stone worn edges', (.52, .49, .41), .88)
wood = material('Stone walnut', (.20, .09, .04), .72)
iron = material('Stone iron', (.12, .095, .068), .58, .6)
brass = material('Stone brass', (.53, .33, .12), .4, .65)
leaf = material('Stone leaves', (.15, .29, .12), .88)
leaf_light = material('Stone young leaves', (.29, .37, .15), .85)
soil = material('Stone soil', (.12, .075, .035), .98)
ceramic = material('Stone ceramic', (.69, .57, .40), .52)
flame = material('Stone flame', (1.0, .42, .075), .45, emission=1.8)
materials = [limestone, stone_shade, stone_pale, stone_moss, mortar, edge, wood, iron, brass, leaf, leaf_light, soil, ceramic, flame]
roots = {}
sockets = []


def empty(name, parent=None, position=(0, 0, 0)):
    obj = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent
    obj.location = position
    return obj


def root(name):
    obj = empty(name)
    roots[name] = obj
    return obj


def socket(parent, name, position):
    sockets.append(name)
    return empty(name, parent, position)


def assign(obj, parent, mat):
    obj.parent = parent
    obj.data.materials.append(mat)
    return obj


def box(parent, position, size, mat, bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=position)
    obj = bpy.context.object
    obj.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod = obj.modifiers.new('soft worn arris', 'BEVEL')
        mod.width = bevel
        mod.segments = 1
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return assign(obj, parent, mat)


def cylinder(parent, position, radius, depth, mat, vertices=12, radius_top=None):
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=radius,
        radius2=radius if radius_top is None else radius_top, depth=depth, location=position)
    return assign(bpy.context.object, parent, mat)


def bar(parent, a, b, radius, mat, vertices=8):
    a, b = Vector(a), Vector(b)
    obj = cylinder(parent, (a + b) / 2, radius, (b - a).length, mat, vertices)
    obj.rotation_euler = (b - a).to_track_quat('Z', 'Y').to_euler()
    return obj


def leaves(parent, center, height=.42, spread=.25):
    x, y, z = center
    for i in range(9):
        angle = i * math.tau / 9 + .22
        direction = Vector((math.cos(angle), math.sin(angle), 0))
        sideways = Vector((-math.sin(angle), math.cos(angle), 0))
        reach = spread * (.70 + .16 * (i % 4))
        length = height * (.65 + .10 * (i % 4))
        base = Vector((x, y, z))
        centers = [base, base + direction * reach * .22 + Vector((0, 0, length * .46)),
                   base + direction * reach * .62 + Vector((0, 0, length * .83)),
                   base + direction * reach + Vector((0, 0, length * .78))]
        width = .047 + .009 * (i % 3)
        verts = []
        for j, c in enumerate(centers):
            w = width * (0.08, .85, 1.0, .02)[j]
            verts.extend([c - sideways * w, c + Vector((0, 0, .012)), c + sideways * w])
        faces = []
        for j in range(3):
            k = 3 * j
            faces.extend([(k, k + 1, k + 4, k + 3), (k + 1, k + 2, k + 5, k + 4)])
        mesh = bpy.data.meshes.new('curved frond')
        mesh.from_pydata(verts, [], faces)
        mesh.update()
        obj = bpy.data.objects.new('curved frond', mesh)
        bpy.context.scene.collection.objects.link(obj)
        assign(obj, parent, leaf_light if i % 3 == 0 else leaf)


def stain(parent, x, z, width, height):
    verts = [(x + width * .42, -.057, z + height * .35)]
    for i in range(12):
        a = math.tau * i / 12
        verts.append((x + width * (.45 + .45 * math.cos(a)), -.057,
                      z + height * (.40 + .40 * math.sin(a))))
    faces = [(0, 1 + i, 1 + (i + 1) % 12) for i in range(12)]
    mesh = bpy.data.meshes.new('soft mortar stain')
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    colors = mesh.color_attributes.new(name='Stain', type='FLOAT_COLOR', domain='CORNER')
    for polygon in mesh.polygons:
        for loop_index in polygon.loop_indices:
            vertex = mesh.loops[loop_index].vertex_index
            colors.data[loop_index].color = (.30, .31, .25, .36 if vertex == 0 else 0)
    obj = bpy.data.objects.new('soft mortar stain', mesh)
    bpy.context.scene.collection.objects.link(obj)
    assign(obj, parent, stone_moss)


def masonry(parent, left=-1, right=1, bottom=0, top=4, back=.09):
    # Recessed continuous mortar prevents open cracks; stones remain within bay edges.
    box(parent, ((left + right) / 2, back, (bottom + top) / 2),
        (right - left, .12, top - bottom), mortar)
    rows = math.ceil((top - bottom) / .49)
    for row in range(rows):
        z0 = bottom + row * (top - bottom) / rows
        z1 = bottom + (row + 1) * (top - bottom) / rows
        x = left
        first = .35 if row % 2 else .60
        while x < right - 1e-6:
            nx = min(right, x + (first if x == left else .60))
            if nx - x > .04:
                stone = box(parent, ((x + nx) / 2, -.005, (z0 + z1) / 2),
                    (nx - x - .018, .10, z1 - z0 - .018),
                    [limestone, limestone, limestone, stone_shade, stone_pale, limestone][(row * 7 + round(x * 10)) % 6],
                    .008 + .004 * ((row + round(x * 10)) % 3))
                if (row * 11 + round(x * 10)) % 5 == 0:
                    for vertex in stone.data.vertices:
                        if vertex.co.x < -(nx - x) * .40 and vertex.co.z > (z1 - z0) * .40:
                            vertex.co.x += .014
                            vertex.co.z -= .012
                if (row * 3 + round(x * 10)) % 7 == 0 and nx - x > .16:
                    stain(parent, x + .01, z0 + .01, min(.12, (nx - x) * .35), .045)
            x = nx


bay = root('StoneBay')
masonry(bay)
# Lower plinth and upper cornice are restrained and stay inside the 2 m envelope.
for z, h in ((.12, .20), (3.87, .18)):
    box(bay, (0, -.078, z), (1.99, .085, h), edge, .012)

door = root('StoneDoor')
for side in (-1, 1):
    masonry(door, -1 if side < 0 else .8, -.8 if side < 0 else 1, 0, 2.4)
    box(door, (side * .90, -.065, 1.20), (.19, .10, 2.38), edge, .012)
# The solid lintel starts at the top of the clear rectangular opening.
box(door, (0, -.075, 2.46), (1.99, .15, .12), edge, .008)
# Finish the tympanum behind the voussoirs instead of leaving a dark flat void. The clear
# rectangular opening remains below the lintel at 2.4 m.
masonry(door, -1, 1, 2.52, 4)
# Fan of stone voussoirs sits wholly above the 2.4 m clear walk envelope.
for i in range(11):
    a0 = math.pi * i / 11 + .009
    a1 = math.pi * (i + 1) / 11 - .009
    vertices = []
    # Keep the concealed rear face just inside the masonry course, avoiding a coplanar seam.
    for y in (-.13, -.045):
        for radius, a in ((.80, a0), (.98, a0), (.98, a1), (.80, a1)):
            vertices.append((radius * math.cos(a), y, 2.52 + radius * .67 * math.sin(a)))
    mesh = bpy.data.meshes.new('arch voussoir')
    mesh.from_pydata(vertices, [], [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
                                     (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)])
    mesh.update()
    obj = bpy.data.objects.new('arch voussoir', mesh)
    bpy.context.scene.collection.objects.link(obj)
    assign(obj, door, [edge, limestone, stone_pale][i % 3])

niche = root('StoneNicheBay')
# The recessed inset is a real shallow niche, not a coplanar dark decal.
for bounds in [(-1, -.58, 0, 4), (.58, 1, 0, 4), (-.58, .58, 0, .85), (-.58, .58, 2.78, 4)]:
    masonry(niche, *bounds)
box(niche, (0, .145, 1.815), (1.16, .04, 1.93), mortar)
box(niche, (0, .10, 1.81), (1.08, .04, 1.83), limestone)
for x in (-.59, .59):
    box(niche, (x, -.055, 1.82), (.10, .10, 1.95), edge, .01)
for z in (.84, 2.80):
    box(niche, (0, -.055, z), (1.27, .10, .11), edge, .01)

floor = root('StoneFloor')
box(floor, (0, 0, -.082), (2, 2, .116), mortar)
for row in range(4):
    for col in range(4):
        box(floor, (-.75 + col * .5, -.75 + row * .5, -.012), (.483, .483, .024), limestone, .009)
ceiling = root('StoneCeiling')
box(ceiling, (0, 0, .096), (2, 2, .128), mortar)
for row in range(4):
    for col in range(4):
        box(ceiling, (-.75 + col * .5, -.75 + row * .5, .016), (.483, .483, .032), limestone, .009)
skylight = root('StoneSkylight')
# A physical open central aperture permits the application to add overhead light.
for x in (-.78, .78):
    box(skylight, (x, 0, .09), (.44, 2, .18), limestone, .012)
for y in (-.78, .78):
    box(skylight, (0, y, .09), (1.12, .44, .18), limestone, .012)
lattice_x, lattice_y = [], []
for v in (-.35, 0, .35):
    lattice_x.append(box(skylight, (v, 0, .04), (.025, 1.12, .04), brass))
    lattice_y.append(box(skylight, (0, v, .081), (1.12, .025, .04), brass))
for a in lattice_x:
    for b in lattice_y:
        if a.location.z + a.dimensions.z / 2 >= b.location.z - b.dimensions.z / 2:
            raise RuntimeError('Skylight lattice crossings overlap')

shelf = root('StoneShelf')
for z in (.04, .45, .86):
    box(shelf, (0, 0, z), (1.0, .32, .065), wood, .012)
for x in (-.44, .44):
    box(shelf, (x, .12, .45), (.07, .07, .90), wood, .01)
    box(shelf, (x, -.12, .45), (.07, .07, .90), wood, .01)
socket(shelf, 'SocketShelfDish', (-.16, 0, .485))
socket(shelf, 'SocketShelfPlant', (.22, 0, .895))

torch = root('StoneTorch')
box(torch, (0, .015, .15), (.13, .055, .30), iron, .012)
bar(torch, (0, -.025, .13), (0, -.17, .32), .018, iron)
cylinder(torch, (0, -.17, .37), .075, .14, brass, 12, .10)
for i in range(5):
    a = i * math.tau / 5
    bar(torch, (.09 * math.cos(a), -.17 + .09 * math.sin(a), .43),
        (.035 * math.cos(a), -.17 + .035 * math.sin(a), .52), .008, iron, 6)
flame_root = empty('StoneTorchFlame', torch, (0, -.17, .43))
for dx, dy, height, lean, radius in [(-.027, 0, .16, -.045, .027),
                                       (.018, .012, .21, .025, .031),
                                       (.005, -.02, .13, .048, .024)]:
    verts = []
    for level, fraction, radius_scale in [(0, 0, .65), (.28, .08, 1), (.60, .42, .68),
                                           (.85, .75, .32), (1, 1, .025)]:
        cx = dx + lean * fraction
        cy = dy + .012 * math.sin(level * math.pi)
        for j in range(7):
            a = math.tau * j / 7
            verts.append((cx + radius * radius_scale * math.cos(a),
                          cy + radius * radius_scale * math.sin(a), height * level))
    faces = [tuple(range(6, -1, -1))]
    for level in range(4):
        for j in range(7):
            k = level * 7 + j
            n = level * 7 + (j + 1) % 7
            faces.append((k, n, n + 7, k + 7))
    faces.append(tuple(range(28, 35)))
    mesh = bpy.data.meshes.new('curved flame')
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new('curved flame', mesh)
    bpy.context.scene.collection.objects.link(obj)
    assign(obj, flame_root, flame)
socket(torch, 'SocketTorchLight', (0, -.17, .58))

planter = root('StonePlanter')
cylinder(planter, (0, 0, .15), .15, .30, ceramic, 12, .20)
cylinder(planter, (0, 0, .30), .195, .035, edge, 12)
cylinder(planter, (0, 0, .322), .17, .012, soil, 12)
leaves(planter, (0, 0, .33))

dishes = root('StoneDishes')
for x, y, scale in [(-.12, 0, 1), (.11, .03, .78)]:
    segments = 24
    rings = [(.070, .004), (.110, .012), (.130, .046), (.112, .046),
             (.082, .020), (.035, .014)]
    verts = []
    for radius, z in rings:
        for i in range(segments):
            angle = math.tau * i / segments
            verts.append((x + radius * scale * math.cos(angle),
                          y + radius * scale * math.sin(angle), z * scale))
    faces = []
    for ring in range(len(rings) - 1):
        for i in range(segments):
            j = ring * segments + i
            n = ring * segments + (i + 1) % segments
            faces.append((j, n, n + segments, j + segments))
    faces.append(tuple(range(segments - 1, -1, -1)))
    faces.append(tuple(range((len(rings) - 1) * segments, len(rings) * segments)))
    mesh = bpy.data.meshes.new('recessed dish')
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    for polygon in mesh.polygons:
        polygon.use_smooth = len(polygon.vertices) == 4
    obj = bpy.data.objects.new('recessed dish', mesh)
    bpy.context.scene.collection.objects.link(obj)
    assign(obj, dishes, ceramic)

# Each control root is batched, while the flame retains its separately controlled node.
for parent in list(roots.values()) + [flame_root]:
    meshes = [o for o in parent.children if o.type == 'MESH']
    if not meshes:
        continue
    bpy.ops.object.select_all(action='DESELECT')
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    obj = meshes[0]
    obj.name = parent.name + '_Visual'
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(island_margin=.015)
    bpy.ops.object.mode_set(mode='OBJECT')

# Authored portable color and normal maps are generated from a fixed seed.
size = 128
yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
u, v = xx / size, yy / size
for idx, mat in enumerate(materials):
    shader = mat.node_tree.nodes.get('Principled BSDF')
    base = np.array(shader.inputs['Base Color'].default_value[:3], dtype=np.float32)
    rng = np.random.default_rng(8300 + idx)
    grain = rng.random((size, size), dtype=np.float32) - .5
    cloud = .5 * (np.sin(u * 9 + v * 4) + np.cos(v * 11 - u * 6))
    height = .14 * cloud + .025 * grain
    color = np.clip(base[None, None, :] * (1 + .075 * cloud[:, :, None] + .025 * grain[:, :, None]), 0, 1)
    dy, dx = np.gradient(height)
    normals = np.stack((-dx, -dy, np.ones_like(dx)), axis=2)
    normals /= np.linalg.norm(normals, axis=2, keepdims=True)
    for kind, data, space in [('base', color, 'sRGB'), ('normal', normals * .5 + .5, 'Non-Color')]:
        pixels = np.ones((size, size, 4), dtype=np.float32)
        pixels[:, :, :3] = data
        image = bpy.data.images.new(mat.name + ' ' + kind, width=size, height=size, alpha=True)
        image.colorspace_settings.name = space
        image.pixels.foreach_set(pixels.ravel())
        image.file_format = 'PNG'
        image.filepath_raw = str(STAGING / (mat.name.replace(' ', '-') + '-' + kind + '.png'))
        image.save()
        image.pack()
        texture = mat.node_tree.nodes.new('ShaderNodeTexImage')
        texture.image = image
        if kind == 'base' and mat != stone_moss:
            mat.node_tree.links.new(texture.outputs['Color'], shader.inputs['Base Color'])
        elif kind == 'normal':
            normal = mat.node_tree.nodes.new('ShaderNodeNormalMap')
            mat.node_tree.links.new(texture.outputs['Color'], normal.inputs['Color'])
            mat.node_tree.links.new(normal.outputs['Normal'], shader.inputs['Normal'])

bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE / 'stone-dungeon-kit.blend'))
bpy.ops.object.select_all(action='SELECT')
glb = STAGING / 'stone-dungeon-kit.glb'
bpy.ops.export_scene.gltf(filepath=str(glb), export_format='GLB', export_yup=True, export_apply=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(glb))
missing = set(roots) | set(sockets) | {'StoneTorchFlame'}
missing -= set(bpy.data.objects.keys())
if missing:
    raise RuntimeError('Missing GLB semantics: ' + ', '.join(sorted(missing)))
# Rays cross the rear tympanum at the previously observed upper seam.
door_mesh = next(o for o in bpy.data.objects['StoneDoor'].children if o.type == 'MESH')
for x in (.35, .50, .60):
    for z in (3.163, 3.170, 3.177):
        inverse = door_mesh.matrix_world.inverted()
        origin = inverse @ Vector((x, -1, z))
        direction = inverse.to_3x3() @ Vector((0, 1, 0))
        hit, _, _, _ = door_mesh.ray_cast(origin, direction)
        if not hit:
            raise RuntimeError(f'Door backing seam remains open at x={x}, z={z}')
print('Door backing seam: all nine reimported rays blocked')
triangles = sum(sum(len(p.vertices) - 2 for p in obj.data.polygons)
                for obj in bpy.context.scene.objects if obj.type == 'MESH')
if triangles > 28000:
    raise RuntimeError('Kit exceeds 28,000 triangles: ' + str(triangles))

# Arrange the exported representation for fixed review views.
positions = {'StoneBay': (-3.3, 0, 0), 'StoneDoor': (-1.1, 0, 0),
             'StoneNicheBay': (1.1, 0, 0), 'StoneShelf': (3.2, 0, 0),
             'StoneTorch': (3.1, -.25, 1.25), 'StonePlanter': (3.4, -.3, .9),
             'StoneDishes': (3.0, -.3, .5), 'StoneFloor': (-2.2, -2.3, 0),
             'StoneCeiling': (0, -2.3, 0), 'StoneSkylight': (2.2, -2.3, 0)}
for name, position in positions.items():
    bpy.data.objects[name].location = position
world = bpy.context.scene.world
world.color = (.12, .10, .075)
for loc, energy, color, radius in [((-4, -6, 7), 1100, (1, .74, .47), 5),
                                   ((4, -2, 7), 900, (1, .89, .69), 4)]:
    bpy.ops.object.light_add(type='AREA', location=loc)
    light = bpy.context.object
    light.data.energy = energy
    light.data.color = color
    light.data.shape = 'DISK'
    light.data.size = radius
bpy.ops.object.camera_add()
cam = bpy.context.object
cam.data.type = 'ORTHO'
scene = bpy.context.scene
scene.camera = cam
scene.render.engine = 'BLENDER_EEVEE'
scene.render.resolution_x = 1600
scene.render.resolution_y = 1000
scene.render.resolution_percentage = 100
for name, position, target, scale in [
    ('review-kit', (0, -12, 7), (0, -.5, 1.4), 9),
    ('review-walls', (-1.1, -8, 3), (-1.1, 0, 2), 7),
    ('review-props', (3.3, -4, 2.4), (3.25, 0, 1.0), 3.1),
    ('review-tiles', (0, -4.5, 7), (0, -2.3, 0), 6.8),
]:
    cam.location = position
    cam.rotation_euler = (Vector(target) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam.data.ortho_scale = scale
    scene.render.filepath = str(STAGING / (name + '.png'))
    bpy.ops.render.render(write_still=True)


# A compact assembled corner makes the actual scale and overhead opening legible.
def show_branch(obj, visible):
    obj.hide_render = not visible
    for child in obj.children:
        show_branch(child, visible)

for name in roots:
    show_branch(bpy.data.objects[name], False)
for name, pos in [('StoneBay', (0, 1, 0)), ('StoneNicheBay', (1, 0, 0)),
                  ('StoneFloor', (0, 0, 0)), ('StoneSkylight', (0, 0, 4)),
                  ('StoneTorch', (.58, .82, 1.45)), ('StoneShelf', (-.55, .70, 0)),
                  ('StonePlanter', (-.55, .58, .9)), ('StoneDishes', (-.55, .58, .485))]:
    obj = bpy.data.objects[name]
    show_branch(obj, True)
    obj.location = pos
bpy.data.objects['StoneNicheBay'].rotation_euler.z = -math.pi / 2
cam.location = (-3.5, -5, 4.0)
cam.rotation_euler = (Vector((0, .3, 1.75)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
cam.data.ortho_scale = 7.2
scene.render.filepath = str(STAGING / 'review-room.png')
bpy.ops.render.render(write_still=True)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


report = {'completed': False, 'authoringAgent': 'gpt-6.1-terra',
          'workflow': 'Original scripted Blender geometry and generated procedural PBR maps',
          'reference': 'docs/art-bible.md, approved 2026-11-15',
          'license': 'Original project-authored asset', 'blender': bpy.app.version_string,
          'axes': 'metres; glTF +Y up, +Z into room', 'roots': list(roots),
          'sockets': sockets, 'triangles': triangles,
          'sha256': {'generator': digest(Path(__file__)), 'blend': digest(SOURCE / 'stone-dungeon-kit.blend'),
                     'staged_glb': digest(glb)},
          'iterations': [{'attempt': 1, 'result': 'reimport passed; floor and ceiling z-fighting identified'},
                         {'attempt': 2, 'result': 'z-fighting fixed; visual direction requested refinement'},
                         {'attempt': 3, 'staged_glb_sha256': 'a73243a0ec0fd459fbbf691c56a2a2606d3a25ab6ecb3bf9746d6451b1a02443',
                          'result': 'independent review 72/100; coplanar lattice, arch relief, staining, dish and silhouettes require correction'},
                         {'attempt': 4, 'staged_glb_sha256': '372eebbbefe5a18d378ba2282922d205cf34fbffc5948df059680788225715c4',
                          'checks': ['GLB reimport', 'named nodes', 'triangle budget'],
                          'result': 'independent review 78/100; nine rays passed through an upper rear-backing seam'},
                         {'attempt': 5, 'checks': ['GLB reimport', 'named nodes', 'triangle budget', 'nine seam rays'],
                          'result': 'extended rear tympanum backing to overlap the masonry above; independent review pending'}],
          'remaining_issues': ['Independent visual scoring and owner approval pending',
                               'Runtime integration, collision, room lighting and Quest acceptance pending',
                               'LOD and high/low bake not authored; procedural embedded maps used'],
          'visual_approval': 'pending independent and owner review'}
(STAGING / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
