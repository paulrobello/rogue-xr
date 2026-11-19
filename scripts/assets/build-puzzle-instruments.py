"""Generate a modular puzzle instrument study in metres; run with Blender 5.x.

blender -b --factory-startup --python-exit-code 1 -P build-puzzle-instruments.py -- --out /tmp/puzzle-instruments
Outputs are staged; copy them to the repository after inspection.
"""
import argparse
import hashlib
import json
import math
import os
import sys

import bpy
from mathutils import Vector

parser = argparse.ArgumentParser()
parser.add_argument('--out', required=True)
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
os.makedirs(args.out, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)


def material(name, color, metallic=0.0, roughness=0.5):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    bs = m.node_tree.nodes.get('Principled BSDF')
    bs.inputs['Base Color'].default_value = (*color, 1)
    bs.inputs['Metallic'].default_value = metallic
    bs.inputs['Roughness'].default_value = roughness
    return m

BRASS = material('palette_brass', (0.59, 0.32, 0.085), .78, .35)
DARK = material('palette_iron', (0.07, 0.085, 0.10), .7, .4)
COPPER = material('palette_copper', (0.5, 0.16, 0.07), .65, .4)
IVORY = material('palette_ivory', (0.72, 0.65, 0.48), 0, .65)
BLUE = material('palette_blue_glass', (0.12, 0.39, 0.46), .35, .22)
RED = material('palette_oxide', (0.40, 0.065, 0.045), .1, .55)
WOOD = material('palette_wood', (0.16, 0.07, 0.035), 0, .7)
roots = []
root = None


def part(name, description, pivot='center on base plane'):
    global root
    root = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(root)
    roots.append((root, description, pivot))
    return root


def finish(obj, name, mat):
    obj.name = name
    obj.data.materials.append(mat)
    obj.parent = root
    return obj


def box(name, pos, size, mat=BRASS, angle=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=pos)
    obj = bpy.context.object
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.rotation_euler.z = angle
    return finish(obj, name, mat)


def cyl(name, pos, radius, depth, mat=BRASS, verts=24):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=depth, location=pos)
    return finish(bpy.context.object, name, mat)


def ring(name, pos, radius, tube, mat=BRASS):
    bpy.ops.mesh.primitive_torus_add(major_segments=24, minor_segments=8, location=pos, major_radius=radius, minor_radius=tube)
    return finish(bpy.context.object, name, mat)


def bar(name, a, b, width, mat=BRASS):
    a, b = Vector(a), Vector(b)
    obj = box(name, (a + b) / 2, (width, width, (b-a).length), mat)
    obj.rotation_euler = (b-a).to_track_quat('Z', 'Y').to_euler()
    return obj


def pivot_group(name, position, objects):
    pivot = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(pivot)
    pivot.parent = root
    pivot.location = position
    for obj in objects:
        obj.parent = pivot
        obj.location -= Vector(position)
    return pivot


def keyed_socket(sides, outer=.14, inner=.078):
    # Open polygonal well: inner circumradius exceeds its corresponding key.
    vertices = []
    for z, radius in ((0, outer), (.075, outer), (.075, inner), (.012, inner)):
        vertices += [(radius*math.cos(2*math.pi*i/sides), radius*math.sin(2*math.pi*i/sides), z) for i in range(sides)]
    faces = []
    for layer in range(3):
        for i in range(sides):
            j = (i+1)%sides
            faces.append((layer*sides+i, layer*sides+j, (layer+1)*sides+j, (layer+1)*sides+i))
    faces.append(tuple(reversed(range(3*sides,4*sides))))
    mesh = bpy.data.meshes.new('socket_well_mesh')
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new('open_socket_well',mesh)
    bpy.context.collection.objects.link(obj)
    finish(obj, 'open_socket_well', BRASS)
    return obj


def gear(name, n, module=.027):
    # Equal module family. The simplified
    # trapezoid teeth have pitch radii n*module/2 and intentionally visible gaps.
    pitch = n * module / 2
    inner, outer = pitch - 1.25*module, pitch + module
    points = []
    for i in range(n):
        for fraction, radius in ((0, inner), (.248, inner), (.36, outer), (.64, outer), (.752, inner)):
            a = 2*math.pi*(i+fraction)/n
            points.append((radius*math.cos(a), radius*math.sin(a)))
    count = len(points)
    verts = [(x,y,z) for z in (0, .055) for x,y in points]
    verts += [(0,0,0), (0,0,.055)]
    faces = [(count*2,(i+1)%count,i) for i in range(count)]
    faces += [(count*2+1,i+count,(i+1)%count+count) for i in range(count)]
    faces += [(i, (i+1)%count, (i+1)%count+count, i+count) for i in range(count)]
    mesh = bpy.data.meshes.new(name+'_mesh')
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    finish(obj, name, BRASS)
    cyl('hub', (0,0,.065), .055,.035,DARK)
    ring('hub_ring', (0,0,.086), .03,.008,IVORY)
    root['tooth_count'] = n
    root['module_m'] = module
    root['pitch_radius_m'] = pitch

# Every root is separately instantiable. Base-centred pivots unless specified.
part('winding_key', 'Double bow winding key with square shaft', 'shaft tip at origin')
cyl('shaft', (0,0,.17), .035,.34,DARK,4)
ring('left_bow',(-.085,0,.36),.075,.014,BRASS)
ring('right_bow',(.085,0,.36),.075,.014,BRASS)
bar('bow_bridge',(-.085,0,.36),(.085,0,.36),.03)
part('winding_arbor', 'Matching square arbor with brass collar', 'shaft axis at base')
cyl('base',(0,0,.0125),.12,.025,DARK)
well = keyed_socket(4, .075, .038)
well.location.z = .025
pivot_group('arbor_turn_pivot', (0, 0, .025), [well])
for n, label in ((12,'small'),(18,'medium'),(24,'large')):
    part('gear_'+label, 'Toothed gear, '+str(n)+' teeth', 'rotation axis at origin')
    gear('teeth', n)
part('pegboard_spindle','Pegboard spindle with stepped bearing', 'rotation axis at base')
cyl('mount',(0,0,.025),.11,.05,DARK)
cyl('pin',(0,0,.14),.034,.23,BRASS)
cyl('stop',(0,0,.22),.06,.04,IVORY)

for i,(label,verts,mat) in enumerate((('triangle',3,RED),('square',4,BLUE),('hex',6,IVORY))):
    part('relic_'+label,'Keyed '+label+' relic','insertion tip at origin')
    cyl('keyed_body',(0,0,.10),.074,.2,mat,verts)
    cyl('collar',(0,0,.22),.095,.04,BRASS)
    cyl('crown',(0,0,.25),.052,.025,mat,verts)
    part('socket_'+label,'Matching '+label+' receptacle, visible inset profile','well base at origin')
    keyed_socket(verts)

part('shutter_lantern','Caged lantern with sliding slotted shutter')
cyl('foot',(0,0,.025),.13,.05,DARK)
cyl('glow_core',(0,0,.18),.085,.26,IVORY,12)
for x,y in ((-.1,-.1),(-.1,.1),(.1,-.1),(.1,.1)):
    bar('frame',(x,y,.05),(x,y,.30),.018,BRASS)
cyl('cap',(0,0,.32),.145,.04,DARK)
ring('handle',(0,0,.36),.07,.012,BRASS)
box('shutter',(.115,0,.18),(.018,.15,.19),COPPER)
box('stencil_slot',(.127,0,.18),(.006,.08,.025),DARK)
part('mirror_gimbal','Nested rings with angled reflective mirror','gimbal center')
ring('outer',(0,0,.19),.16,.015,BRASS)
ring('inner',(0,0,.19),.12,.012,DARK)
cyl('mirror',(0,0,.19),.10,.018,BLUE)
cyl('pivot',(0,0,.21),.025,.02,IVORY)
part('polarizing_lens','Rotating marked polarizer lens','rotation axis at origin')
ring('bezel',(0,0,.025),.13,.02,BRASS)
cyl('glass',(0,0,.025),.11,.018,BLUE)
bar('mark',(-.08,0,.04),(.08,0,.04),.009,IVORY)
part('prism','Triangular dispersive prism')
cyl('prism_body',(0,0,.12),.12,.24,BLUE,3)
part('pipe_selector','Cross manifold with indexed rotating selector','selector axis at base')
cyl('valve_body',(0,0,.055),.12,.11,DARK)
for a in (0,math.pi/2,math.pi,3*math.pi/2):
    bar('port',(0,0,.055),(.23*math.cos(a),.23*math.sin(a),.055),.075,COPPER)
ring('dial_rim',(0,0,.12),.09,.013,BRASS)
bar('pointer',(0,0,.135),(.075,0,.135),.018,IVORY)
part('carrier_capsule','Pneumatic message capsule with banded shell')
cyl('shell',(0,0,.14),.065,.25,COPPER)
cyl('end_a',(0,0,.015),.072,.03,DARK)
cyl('end_b',(0,0,.265),.072,.03,DARK)
ring('label_band',(0,0,.15),.067,.009,IVORY)
part('whistle_chime','Pipe whistle with striker and bell')
cyl('whistle_tube',(0,0,.15),.055,.3,BRASS)
box('mouth',(0,-.057,.22),(.045,.012,.045),DARK)
cyl('bell',(0,0,.33),.09,.06,COPPER)
cyl('bell_top',(0,0,.37),.04,.025,DARK)
part('float_chamber','Framed transparent float chamber with lift rod')
cyl('base',(0,0,.025),.13,.05,DARK)
ring('glass_lower_rim',(0,0,.075),.085,.009,BLUE)
ring('glass_upper_rim',(0,0,.345),.085,.009,BLUE)
for a in (0,math.pi/2,math.pi,3*math.pi/2):
    bar('chamber_frame',(.085*math.cos(a),.085*math.sin(a),.08),(.085*math.cos(a),.085*math.sin(a),.34),.009,BLUE)
cyl('float',(0,0,.16),.073,.055,IVORY)
cyl('rod',(0,0,.33),.012,.24,BRASS)
cyl('cap',(0,0,.38),.12,.035,DARK)
part('repair_patch','Riveted gasket repair patch')
box('patch',(0,0,.02),(.24,.18,.035),RED)
for x in (-.085,.085):
    for y in (-.055,.055): cyl('rivet',(x,y,.042),.015,.012,BRASS,12)
part('balance_scale','Beam scale with two suspended pans')
cyl('base',(0,0,.025),.12,.05,DARK)
bar('post',(0,0,.05),(0,0,.31),.035,BRASS)
beam = bar('beam',(-.23,0,.31),(.23,0,.31),.025,BRASS)
scale_parts = [beam]
for x in (-.22,.22):
    scale_parts.append(bar('hanger',(x,0,.3),(x,0,.13),.01,DARK))
    scale_parts.append(cyl('pan',(x,0,.12),.09,.018,COPPER))
pivot_group('balance_beam_pivot', (0,0,.31), scale_parts)
part('scale_weights','Three graduated calibrated weights')
for x, r, h in ((-.10,.045,.08),(0,.055,.11),(.12,.065,.14)):
    cyl('weight',(x,0,h/2),r,h,DARK)
    cyl('knob',(x,0,h+.012),.018,.024,BRASS)
part('dual_pendulum','Two pendulums with separate swing pivots','origin at ground plane')
bar('rail',(-.16,0,.31),(.16,0,.31),.03,DARK)
for x, length in ((-.10,.22),(.10,.15)):
    rod = bar('rod',(x,0,.30),(x,0,.30-length),.014,BRASS)
    bob = cyl('bob',(x,0,.30-length),.045,.035,COPPER)
    pivot_group('pendulum_left_pivot' if x < 0 else 'pendulum_right_pivot', (x,0,.30), [rod,bob])
part('tension_gauge','Circular gauge with a needle and tension spring')
cyl('housing',(0,0,.035),.14,.07,DARK)
cyl('face',(0,0,.075),.11,.012,IVORY)
bar('needle',(0,0,.086),(.07,.045,.086),.012,RED)
for y in (-.09,-.045,0,.045,.09): box('spring_coil',(.20,y,.05),(.12,.014,.03),BRASS)
part('ratchet_pair','Two complementary ratchet wheels','gear rotation axis at origin')
gear('ratchet', 12, .018)
bar('pawl',(.12,.03,.04),(.22,.11,.04),.025,DARK)
part('stamp_press','Hand press with raised stamp and platen')
box('base',(0,0,.025),(.26,.20,.05),WOOD)
bar('column',(0,.07,.05),(0,.07,.34),.035,DARK)
bar('head',(0,.07,.31),(0,-.04,.31),.045,BRASS)
cyl('ram',(0,-.04,.20),.025,.20,DARK)
box('stamp',(0,-.04,.105),(.1,.08,.04),COPPER)
box('platen',(0,-.04,.06),(.14,.12,.02),IVORY)
part('pinned_drum','Indexed player drum with raised pins','rotation axis at base')
cyl('drum',(0,0,.12),.095,.24,WOOD)
for j in range(3):
    for i in range(5):
        a=2*math.pi*(i/5+j*.08)
        bar('pin',(.09*math.cos(a),.09*math.sin(a),.055+j*.07),(.115*math.cos(a),.115*math.sin(a),.055+j*.07),.014,BRASS)
ring('top_ring',(0,0,.245),.09,.012,BRASS)
pivot_group('drum_rotation_pivot', (0,0,0), list(root.children))
part('embossing_plate','Raised-symbol rubbing or embossing plate')
box('plate',(0,0,.015),(.25,.19,.03),COPPER)
ring('symbol',(0,0,.035),.058,.012,BRASS)
bar('symbol_bar',(-.07,0,.04),(.07,0,.04),.012,BRASS)
part('magnet_key_grille','Slotted magnetic key grille with hidden key')
box('back',(0,0,.018),(.26,.20,.035),DARK)
for x in (-.09,-.045,0,.045,.09): box('grille',(x,0,.05),(.014,.18,.025),BRASS)
ring('magnet',(.07,0,.075),.04,.009,RED)
part('conductor_bridge','Two terminal conductive bridge')
for x in (-.10,.10): cyl('terminal',(x,0,.035),.045,.07,DARK)
bar('conductor',(-.10,0,.075),(.10,0,.075),.035,COPPER)
part('miniature_spire','Miniature spire and removable floor disks')
cyl('plinth',(0,0,.025),.15,.05,DARK,12)
for z,r in ((.08,.12),(.14,.10),(.20,.08),(.26,.06)):
    cyl('floor',(0,0,z),r,.05,BRASS,8)
cyl('spire',(0,0,.34),.04,.13,COPPER,6)
part('lift_basket','Railed dumbwaiter basket')
box('floor',(0,0,.025),(.22,.20,.05),WOOD)
for x in (-.09,.09):
    for y in (-.08,.08): bar('post',(x,y,.05),(x,y,.24),.015,DARK)
for y in (-.08,.08): bar('rail',(-.09,y,.23),(.09,y,.23),.012,BRASS)
for x in (-.09,.09): bar('rail',(x,-.08,.23),(x,.08,.23),.012,BRASS)
part('fog_mirror','Framed mirror with stylized steam curls')
box('frame',(0,0,.025),(.23,.19,.05),BRASS)
box('mirror',(0,0,.055),(.19,.15,.012),BLUE)
for x in (-.06,0,.06): bar('fog_stroke',(x,-.05,.065),(x+.02,.05,.065),.009,IVORY)

# Capture the local bounds and geometry before making the optional preview scene.
bpy.context.view_layer.update()
items = []
for obj, desc, pivot in roots:
    children = [c for c in obj.children_recursive if c.type == 'MESH']
    corners = [obj.matrix_world.inverted() @ (c.matrix_world @ Vector(corner)) for c in children for corner in c.bound_box]
    lo = [min(v[i] for v in corners) for i in range(3)]
    hi = [max(v[i] for v in corners) for i in range(3)]
    triangles = sum(sum(len(p.vertices)-2 for p in c.data.polygons) for c in children)
    items.append({'id': obj.name, 'description':desc, 'pivot':pivot, 'bounds_min_m':lo,'bounds_max_m':hi,'dimensions_m':[hi[i]-lo[i] for i in range(3)], 'moving_pivots': [{'name':c.name,'position_m':list(c.location)} for c in obj.children if c.type == 'EMPTY'], 'triangles':triangles})
assert sum(i['triangles'] for i in items) < 30000

# Sample actual authored tooth polygons as a counterrotating pair at pitch distance.
def outline(n):
    obj = bpy.data.objects['gear_' + {12:'small',18:'medium',24:'large'}[n]]
    teeth = next(c for c in obj.children if c.type == 'MESH' and c.name.startswith('teeth'))
    return [(v.co.x,v.co.y) for v in list(teeth.data.vertices)[:(len(teeth.data.vertices)-2)//2]]


def rotate2(points, angle, offset):
    c, s = math.cos(angle), math.sin(angle)
    return [(offset+x*c-y*s, x*s+y*c) for x,y in points]


def edges_cross(a,b):
    def cross(p,q,r):
        return (q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0])
    for i,p in enumerate(a):
        q=a[(i+1)%len(a)]
        for j,r in enumerate(b):
            t=b[(j+1)%len(b)]
            if max(p[0],q[0])<min(r[0],t[0]) or max(r[0],t[0])<min(p[0],q[0]) or max(p[1],q[1])<min(r[1],t[1]) or max(r[1],t[1])<min(p[1],q[1]):
                continue
            if cross(p,q,r)*cross(p,q,t)<0 and cross(r,t,p)*cross(r,t,q)<0:
                return True
    return False

gear_checks=[]
for n,m in ((12,18),(18,24),(12,24)):
    a,b=outline(n),outline(m)
    distance=(n+m)*.027/2
    phase_found=None
    for phase in range(24):
        phase_angle=math.pi+2*math.pi*phase/(24*m)
        if all(not edges_cross(rotate2(a,2*math.pi*k/(96*n),0),rotate2(b,phase_angle-(2*math.pi*k/(96*n))*n/m,distance)) for k in range(96)):
            phase_found=phase_angle
            break
    assert phase_found is not None, 'No collision-free sampled gear phase: '+str((n,m))
    gear_checks.append({'teeth':[n,m], 'center_distance_m':distance, 'phase_b_radians':phase_found, 'b_rotation_per_a':-n/m, 'samples_per_tooth':96, 'edge_intersections':0})
blend_path = os.path.join(args.out,'puzzle-instruments.blend')
bpy.ops.wm.save_as_mainfile(filepath=blend_path)
glb_path = os.path.join(args.out,'puzzle-instruments.glb')
bpy.ops.export_scene.gltf(filepath=glb_path, export_format='GLB', export_lights=False, export_cameras=False, export_yup=True)
# Fit each part in its own camera-facing cell. Labels occupy a protected lower strip.
cols, rows = 6, math.ceil(len(roots)/6)
scene = bpy.context.scene
bpy.ops.object.camera_add(location=(8,-14,10))
cam=bpy.context.object
cam.rotation_euler=(-cam.location).to_track_quat('-Z','Y').to_euler()
cam.data.type='ORTHO'
cam.data.ortho_scale=max(cols,rows)*1.05
scene.camera=cam
q=cam.rotation_euler.to_quaternion()
right=q @ Vector((1,0,0))
up=q @ Vector((0,1,0))
for i,(obj,_,_) in enumerate(roots):
    item=items[i]
    center=Vector([(item['bounds_min_m'][k]+item['bounds_max_m'][k])/2 for k in range(3)])
    corners=[Vector((x,y,z)) for x in (item['bounds_min_m'][0],item['bounds_max_m'][0]) for y in (item['bounds_min_m'][1],item['bounds_max_m'][1]) for z in (item['bounds_min_m'][2],item['bounds_max_m'][2])]
    w=max(v.dot(right) for v in corners)-min(v.dot(right) for v in corners)
    h=max(v.dot(up) for v in corners)-min(v.dot(up) for v in corners)
    scale=min(.75/max(w,.001),.60/max(h,.001))
    obj.scale=(scale,scale,scale)
    cell=right*((i%cols)-(cols-1)/2)+up*((rows-1)/2-(i//cols)+.10)
    obj.location=cell-center*scale
    bpy.ops.object.text_add(location=cell-up*.43)
    label=bpy.context.object
    label.name='preview_label'
    label.rotation_euler=cam.rotation_euler
    label.data.body=obj.name
    label.data.align_x='CENTER'
    label.data.size=.065
    label.data.materials.append(IVORY)
bpy.ops.object.light_add(type='AREA', location=(2,-5,8))
light=bpy.context.object
light.data.energy=2200
light.data.shape='DISK'
light.data.size=8
scene.render.engine='BLENDER_EEVEE'
scene.world.color=(.12,.12,.12)
scene.render.resolution_x=2200
scene.render.resolution_y=2200
scene.render.resolution_percentage=100
scene.render.filepath=os.path.join(args.out,'puzzle-instruments-contact.png')
if not os.environ.get('PUZZLE_SIDE_ONLY'):
    bpy.ops.render.render(write_still=True)
# Alternate front/side angles of mechanisms whose vertical forms matter most.
selected = {'winding_key','winding_arbor','carrier_capsule','whistle_chime','float_chamber','balance_scale','dual_pendulum','pinned_drum'}
for obj in scene.objects:
    if obj.name.startswith('preview_label'):
        obj.hide_render=True
for obj,_,_ in roots:
    hidden=obj.name not in selected
    obj.hide_render=hidden
    for child in obj.children_recursive:
        child.hide_render=hidden
chosen=[(i,obj) for i,(obj,_,_) in enumerate(roots) if obj.name in selected]
cam.location=(12,-7,5)
cam.rotation_euler=(-cam.location).to_track_quat('-Z','Y').to_euler()
cam.data.ortho_scale=4.2
q=cam.rotation_euler.to_quaternion()
right=q @ Vector((1,0,0))
up=q @ Vector((0,1,0))
for cell_i,(i,obj) in enumerate(chosen):
    item=items[i]
    center=Vector([(item['bounds_min_m'][k]+item['bounds_max_m'][k])/2 for k in range(3)])
    corners=[Vector((x,y,z)) for x in (item['bounds_min_m'][0],item['bounds_max_m'][0]) for y in (item['bounds_min_m'][1],item['bounds_max_m'][1]) for z in (item['bounds_min_m'][2],item['bounds_max_m'][2])]
    w=max(v.dot(right) for v in corners)-min(v.dot(right) for v in corners)
    h=max(v.dot(up) for v in corners)-min(v.dot(up) for v in corners)
    scale=min(.75/max(w,.001),.60/max(h,.001))
    obj.scale=(scale,scale,scale)
    cell=right*((cell_i%4)-1.5)+up*(.5-(cell_i//4)+.10)
    obj.location=cell-center*scale
    bpy.ops.object.text_add(location=cell-up*.43)
    label=bpy.context.object
    label.name='detail_label'
    label.rotation_euler=cam.rotation_euler
    label.data.body=obj.name
    label.data.align_x='CENTER'
    label.data.size=.065
    label.data.materials.append(IVORY)
scene.render.resolution_x=2200
scene.render.resolution_y=1200
scene.render.filepath=os.path.join(args.out,'puzzle-instruments-side.png')
bpy.ops.render.render(write_still=True)

def digest(path):
    with open(path,'rb') as f: return hashlib.sha256(f.read()).hexdigest()
manifest={'schema':1,'description':'Original procedural clockwork puzzle component study; visual and runtime acceptance pending.', 'frame':'Blender Z-up, metres; GLB Y-up', 'generator':'scripts/assets/build-puzzle-instruments.py', 'blender':bpy.app.version_string, 'material_palette':['palette_brass','palette_iron','palette_copper','palette_ivory','palette_blue_glass','palette_oxide','palette_wood'], 'pieces':items,'gear_kinematics':gear_checks,'total_triangles':sum(i['triangles'] for i in items), 'hashes':{os.path.basename(p):digest(p) for p in (__file__,blend_path,glb_path,os.path.join(args.out,'puzzle-instruments-contact.png'),scene.render.filepath)}, 'notes':['Gear profiles use a common module and sampled edge intersection checks, but are simplified trapezoids rather than involute profiles; contact forces and continuous clearance are unverified.', 'Components are concept studies; owner review and in-engine validation remain open.']}
with open(os.path.join(args.out,'manifest.json'),'w') as f: json.dump(manifest,f,indent=2)
