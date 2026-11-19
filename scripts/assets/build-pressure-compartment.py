"""Build the manifold's independently animated lower reward compartment.

Run with Blender: blender -b --factory-startup --python-exit-code 1 -P this_file -- --out DIR
Runtime coordinates (x, y, z) map to Blender (x, -z, y).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

parser = argparse.ArgumentParser()
parser.add_argument('--out', required=True, type=Path)
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
args.out.mkdir(parents=True, exist_ok=True)

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)


def point(p):
    return (p[0], -p[2], p[1])


def material(name, color, metal, rough):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    shader = m.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Metallic'].default_value = metal
    shader.inputs['Roughness'].default_value = rough
    return m


MATS = {
    'iron': material('compartment cast iron', (0.055, 0.048, 0.041), .65, .56),
    'brass': material('compartment aged brass', (.52, .31, .085), .8, .34),
    'wood': material('compartment walnut', (.19, .073, .028), .05, .58),
    'dark': material('compartment dark lining', (.024, .022, .018), .15, .68),
    'gold': material('compartment bright gold', (.78, .49, .105), .78, .28),
}


def empty(name, p=(0, 0, 0), parent=None):
    o = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(o)
    o.location = point(p)
    if parent:
        o.parent = parent
        o.matrix_parent_inverse = parent.matrix_world.inverted()
    return o


def parent_preserve(o, parent):
    bpy.context.view_layer.update()
    world = o.matrix_world.copy()
    o.parent = parent
    o.matrix_world = world
    return o


def box(name, p, size, mat, parent):
    bpy.ops.mesh.primitive_cube_add(size=1, location=point(p))
    o = bpy.context.object
    o.name = name
    o.dimensions = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(MATS[mat])
    return parent_preserve(o, parent)


def cylinder(name, a, b, radius, mat, parent, sides=12):
    a, b = Vector(point(a)), Vector(point(b))
    d = b - a
    bpy.ops.mesh.primitive_cylinder_add(vertices=sides, radius=radius, depth=d.length, location=(a+b)/2)
    o = bpy.context.object
    o.name = name
    o.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    o.data.materials.append(MATS[mat])
    return parent_preserve(o, parent)


def gear(name, center, radius, depth, teeth, mat, parent, horizontal=False):
    # A single closed toothed profile gives the cogs and seal a true silhouette.
    cx, cy, cz = center
    vertices = []
    count = teeth * 4
    for side in (-1, 1):
        for i in range(count):
            angle = 2 * math.pi * i / count
            r = radius * (1 if i % 4 in (1, 2) else .82)
            if horizontal:
                p = (cx + r * math.cos(angle), cy + side * depth/2, cz + r * math.sin(angle))
            else:
                p = (cx + r * math.cos(angle), cy + r * math.sin(angle), cz + side * depth/2)
            vertices.append(point(p))
    faces = [tuple(reversed(range(count))), tuple(range(count, count*2))]
    faces += [(i, (i+1)%count, (i+1)%count+count, i+count) for i in range(count)]
    mesh = bpy.data.meshes.new(name + '-mesh')
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    o = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(o)
    o.data.materials.append(MATS[mat])
    return parent_preserve(o, parent)


root = empty('service-compartment')
# Frame is an open-front sleeve; separate solids leave the reward pocket hollow.
box('sleeve-back', (0, .44, .27), (1.24, .48, .035), 'dark', root)
for x in (-.61, .61):
    box('sleeve-side', (x, .44, .39), (.045, .48, .27), 'iron', root)
for y in (.20, .68):
    box('sleeve-rail', (0, y, .39), (1.25, .04, .27), 'iron', root)
    box('brass-keeper', (0, y, .525), (1.19, .018, .024), 'brass', root)
for x in (-.56, .56):
    for y in (.23, .65):
        cylinder('keeper-rivet', (x,y,.532), (x,y,.547), .014, 'gold', root, 8)

drawer = empty('reward-drawer', (0, .23, .34), root)
box('drawer-base', (0, .265, .40), (1.13, .038, .26), 'wood', drawer)
for x in (-.49, .49):
    for z in (.31, .49):
        box('display-support', (x, .385, z), (.035, .20, .035), 'wood', drawer)
box('drawer-dark-backing', (0, .49, .40), (1.08, .012, .23), 'dark', drawer)
for x in (-.55,.55):
    box('drawer-side', (x,.375,.4), (.035,.21,.26), 'wood', drawer)
    box('drawer-side-rim', (x,.483,.40), (.042,.014,.26), 'brass', drawer)
box('drawer-back', (0,.375,.275), (1.12,.21,.025), 'wood', drawer)
box('drawer-front', (0,.385,.535), (1.16,.22,.045), 'wood', drawer)
for y in (.285,.48):
    box('drawer-front-trim', (0,y,.563), (1.10,.018,.014), 'brass', drawer)
for x in (-.535,.535):
    box('drawer-front-trim', (x,.385,.563), (.018,.195,.014), 'brass', drawer)
# Handle stands proud of the face with enough clearance to grip.
for x in (-.19,.19):
    cylinder('handle-post', (x,.37,.56), (x,.37,.615), .018, 'brass', drawer)
cylinder('drawer-handle', (-.19,.37,.615), (.19,.37,.615), .021, 'gold', drawer, 12)
gear('maker-mark', (0,.44,.575), .059, .016, 10, 'gold', drawer)
cylinder('seal-center', (0,.44,.583), (0,.44,.591), .027, 'iron', drawer, 12)

cogs = empty('reward-cogs', (0,0,0), drawer)
for i, (x, z, r) in enumerate(((-.34,.39,.066),(-.18,.405,.055),(.03,.39,.075),(.23,.405,.057),(.39,.385,.062))):
    gear('reward-cog-%d' % i, (x,.505,z), r, .015, 9+i%3, 'gold', cogs, True)
    cylinder('reward-cog-hub-%d' % i, (x,.514,z), (x,.521,z), r*.27, 'brass', cogs, 10)

# The pivot coincides with the axle, so a runtime X rotation rocks the handle.
cylinder('primer-mount', (1.10,.67,.355), (1.10,.67,.43), .061, 'iron', root)
cylinder('primer-collar', (1.10,.67,.43), (1.10,.67,.45), .045, 'brass', root)
lever = empty('primer-lever', (1.10,.67,.45), root)
cylinder('primer-stem', (1.10,.67,.45), (1.10,.80,.52), .015, 'brass', lever, 10)
cylinder('primer-grip', (1.10,.79,.515), (1.10,.83,.537), .028, 'wood', lever, 10)
# Small forward-facing outlets near the outer bottom corners.
for x in (-.67,.67):
    cylinder('steam-outlet', (x,.25,.32), (x,.25,.46), .029, 'brass', root)
    cylinder('steam-mouth', (x,.25,.46), (x,.25,.466), .018, 'dark', root)

bpy.context.view_layer.update()
bpy.ops.wm.save_as_mainfile(filepath=str(args.out / 'service-compartment.blend'))
bpy.ops.export_scene.gltf(filepath=str(args.out / 'service-compartment.glb'), export_format='GLB', export_yup=True, export_lights=False, export_cameras=False)

# Validate the actual exported file, not the authored Blender scene.
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(args.out / 'service-compartment.glb'))
bpy.context.view_layer.update()
objects = list(bpy.context.scene.objects)
for name in ('service-compartment', 'reward-drawer', 'reward-cogs', 'maker-mark', 'primer-lever'):
    assert bpy.data.objects.get(name), name
assert bpy.data.objects['reward-cogs'].parent.name == 'reward-drawer'
assert bpy.data.objects['maker-mark'].parent.name == 'reward-drawer'
assert bpy.data.objects['primer-lever'].parent.name == 'service-compartment'
meshes = [o for o in objects if o.type == 'MESH']
tris = sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in meshes)
assert tris < 3600, tris
assert len({slot.material.name for o in meshes for slot in o.material_slots if slot.material}) <= 5
assert not [o.name for o in objects if o.type in {'LIGHT', 'CAMERA'}]
world_pts = [o.matrix_world @ Vector(corner) for o in meshes for corner in o.bound_box]
bounds = [[min(p[i] for p in world_pts), max(p[i] for p in world_pts)] for i in range(3)]
report = {
    'blender': bpy.app.version_string,
    'runtime_axes': 'Blender (x, z, -y)',
    'blender_bounds': bounds,
    'triangles': tris,
    'mesh_count': len(meshes),
    'materials': sorted({slot.material.name for o in meshes for slot in o.material_slots if slot.material}),
    'drawer_pivot_runtime': [0, .23, .34],
    'drawer_open_runtime_z': .42,
    'primer_pivot_runtime': [1.10, .67, .45],
    'steam_outlets_runtime': [[-.67, .25, .466], [.67, .25, .466]],
    'glb_sha256': hashlib.sha256((args.out / 'service-compartment.glb').read_bytes()).hexdigest(),
}
(args.out / 'service-compartment.report.json').write_text(json.dumps(report, indent=2) + '\n')
scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE'
scene.eevee.taa_render_samples = 16
scene.render.resolution_x = 1000
scene.render.resolution_y = 750
scene.render.resolution_percentage = 100
scene.world.color = (.17, .17, .17)
for pos, energy, size in (((-2,-3,4), 800, 4), ((3,-1,2), 550, 3)):
    bpy.ops.object.light_add(type='AREA', location=pos)
    light = bpy.context.object
    light.data.energy = energy
    light.data.shape = 'DISK'
    light.data.size = size
    light.rotation_euler = (Vector((0,-.4,.4)) - light.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.object.camera_add(location=(1.45,-2.5,1.55))
camera = bpy.context.object
camera.rotation_euler = (Vector((0,-.48,.42))-camera.location).to_track_quat('-Z','Y').to_euler()
camera.data.type = 'ORTHO'
camera.data.ortho_scale = 2.5
scene.camera = camera
scene.render.image_settings.file_format = 'PNG'
for label, distance in (('closed', 0), ('open', .42)):
    bpy.data.objects['reward-drawer'].location.y -= distance
    scene.render.filepath = str(args.out / ('service-compartment-' + label + '.png'))
    bpy.ops.render.render(write_still=True)
print(json.dumps(report, indent=2))
