"""Build the Clockwork Spire coffer key and rack. Blender Z-up, front -Y.

Run: blender -b --factory-startup --threads 2 --python-exit-code 1 -P
scripts/assets/build-brass-key-kit.py. Images and GLB are generated in staging.
"""
import bpy
import hashlib
import json
import math
import shutil
from pathlib import Path

import numpy as np
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'assets-source/props/brass-key-kit'
STAGE = SOURCE / 'staging'
DEST = ROOT / 'public/assets/props/brass-key-kit'
STAGE.mkdir(parents=True, exist_ok=True)
DEST.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)


def material(name, color, metallic, roughness, seed, wood=False):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    shader = m.node_tree.nodes.get('Principled BSDF')
    size = 256
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    u, v = x / size, y / size
    rng = np.random.default_rng(seed)
    noise = rng.random((size, size), dtype=np.float32) - .5
    cloud = (np.sin(u*19 + np.sin(v*13)*2) + np.cos(v*21-u*9))*.5
    grain = np.sin(v*105 + 2*np.sin(u*9) + .6*np.sin(u*34)) if wood else np.sin(u*83+v*36)*np.sin(v*67-u*20)
    height = .18*cloud + (.28 if wood else .08)*grain + .035*noise
    c = np.asarray(color, dtype=np.float32)
    albedo = np.clip(c[None,None,:]*(.91+.085*cloud[:,:,None]+.035*grain[:,:,None]+.045*noise[:,:,None]), 0, 1)
    if name == 'Aged brass':
        tarnish = np.maximum(cloud-.55, 0)[:,:,None]*.22
        albedo = albedo*(1-tarnish)+np.array([.045,.20,.15])*tarnish
    dy, dx = np.gradient(height)
    normal = np.stack((-dx*1.7,-dy*1.7,np.ones_like(dx)),axis=2)
    normal /= np.linalg.norm(normal,axis=2,keepdims=True)
    orm = np.stack((np.ones_like(dx),np.clip(roughness+.045*cloud+.025*noise,0,1),np.full_like(dx,metallic)),axis=2)
    for kind, arr, space in [('base',albedo,'sRGB'),('orm',orm,'Non-Color'),('normal',normal*.5+.5,'Non-Color')]:
        px = np.ones((size,size,4),np.float32)
        px[:,:,:3] = arr
        image = bpy.data.images.new(name+' '+kind,width=size,height=size,alpha=True)
        image.colorspace_settings.name = space
        image.pixels.foreach_set(px.ravel())
        image.file_format = 'PNG'
        image.filepath_raw = str(STAGE / (name.replace(' ','-')+'-'+kind+'.png'))
        image.save()
        image.pack()
        tex = m.node_tree.nodes.new('ShaderNodeTexImage')
        tex.image = image
        if kind == 'base':
            m.node_tree.links.new(tex.outputs['Color'],shader.inputs['Base Color'])
        elif kind == 'normal':
            normal_node = m.node_tree.nodes.new('ShaderNodeNormalMap')
            m.node_tree.links.new(tex.outputs['Color'],normal_node.inputs['Color'])
            m.node_tree.links.new(normal_node.outputs['Normal'],shader.inputs['Normal'])
        else:
            sep = m.node_tree.nodes.new('ShaderNodeSeparateColor')
            m.node_tree.links.new(tex.outputs['Color'],sep.inputs['Color'])
            m.node_tree.links.new(sep.outputs['Green'],shader.inputs['Roughness'])
            m.node_tree.links.new(sep.outputs['Blue'],shader.inputs['Metallic'])
    return m

brass = material('Aged brass',(.55,.32,.075),.87,.32,11)
walnut = material('Oiled walnut',(.17,.065,.025),.03,.48,12,True)
enamel = material('Midnight iron enamel',(.048,.082,.083),.25,.43,13)
dark = material('Cut dark steel',(.055,.045,.028),.55,.57,14)


def root(name, parent=None, loc=(0,0,0)):
    o = bpy.data.objects.new(name,None)
    bpy.context.scene.collection.objects.link(o)
    o.parent = parent
    o.location = loc
    return o


def attach(o, parent, mat, smooth=True):
    o.parent = parent
    o.data.materials.append(mat)
    if o.type == 'MESH':
        for face in o.data.polygons:
            face.use_smooth = smooth
    return o


def cube(parent, p, s, mat, bevel=.001):
    bpy.ops.mesh.primitive_cube_add(size=1, location=p)
    o = bpy.context.object
    o.scale = s
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    if bevel:
        mod = o.modifiers.new('Soft forged edges','BEVEL')
        mod.width = bevel
        mod.segments = 3
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return attach(o,parent,mat,False)


def cylinder(parent, a, b, radius, mat, vertices=24):
    a,b=Vector(a),Vector(b)
    d=b-a
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices,radius=radius,depth=d.length,location=(a+b)*.5)
    o=bpy.context.object
    o.rotation_euler=d.to_track_quat('Z','Y').to_euler()
    mod=o.modifiers.new('Turned edge','BEVEL');mod.width=min(.0008,radius*.15);mod.segments=2
    bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=mod.name)
    return attach(o,parent,mat)


def tube(parent, points, radius, mat, sides=10):
    verts=[];faces=[]
    for i, p in enumerate(points):
        p=Vector(p)
        tangent=(Vector(points[min(i+1,len(points)-1)])-Vector(points[max(0,i-1)])).normalized()
        guide=Vector((0,1,0)) if abs(tangent.y)<.9 else Vector((0,0,1))
        side=tangent.cross(guide).normalized();up=tangent.cross(side).normalized()
        for j in range(sides):
            a=math.tau*j/sides
            verts.append(tuple(p+radius*(side*math.cos(a)+up*math.sin(a))))
    for i in range(len(points)-1):
        for j in range(sides):faces.append((i*sides+j,i*sides+(j+1)%sides,(i+1)*sides+(j+1)%sides,(i+1)*sides+j))
    mesh=bpy.data.meshes.new('forged curved rod');mesh.from_pydata(verts,[],faces);mesh.update()
    o=bpy.data.objects.new('forged curved rod',mesh);bpy.context.scene.collection.objects.link(o)
    return attach(o,parent,mat)


def ring(parent,c,rx,rz,thick,mat,segments=64,start=0,end=math.tau):
    x,y,z=c
    tube(parent,[(x+rx*math.cos(start+(end-start)*i/segments),y,z+rz*math.sin(start+(end-start)*i/segments)) for i in range(segments+1)],thick,mat)


def disk(parent,x,y,z,r,depth,mat):
    return cylinder(parent,(x,y-depth/2,z),(x,y+depth/2,z),r,mat,32)

# Origin is at the centre of the hanging key, with the bow at the top.
key=root('BrassCacheKey')
# Three rounded lobes are a continuous open bow, with a separate crescent inside.
pts=[]
for i in range(97):
    a=math.tau*i/96
    radius=.030 + .0055*math.cos(3*(a-math.pi/2))
    pts.append((radius*math.cos(a)*1.34,0,.073+radius*math.sin(a)))
tube(key,pts,.0038,brass,12)
ring(key,(0,-.0004,.073),.024,.023,.0015,brass,segments=64,start=math.radians(45),end=math.radians(315))
# Engraved fine filigree traces and bead terminals keep the bow open.
for x in (-.025,.025):
    disk(key,x,-.0015,.071,.0027,.002,brass)
    cylinder(key,(x,0,.071),(x*1.65,0,.071),.0015,brass,12)
cylinder(key,(0,0,.052),(0,0,-.096),.0048,brass)
for z,r,h in [(.040,.008,.006),(.032,.0065,.004),(-.087,.006,.003),(-.098,.006,.004)]:
    cylinder(key,(0,0,z-h/2),(0,0,z+h/2),r,brass)
# Single sided ward: three distinct teeth separated by open gaps.
cube(key,(.014,0,-.090),(.030,.006,.010),brass,.0012)
for x,z,w,h in [(.028,-.080,.010,.012),(.020,-.098,.008,.010),(.007,-.103,.006,.012)]:
    cube(key,(x,0,z),(w,.006,h),brass,.001)

# Plaque back is at y=0. The key hangs in front of the face on the upturned hook.
rack=root('BrassKeyRack')
cube(rack,(0,-.010,0),(.158,.020,.270),walnut,.009)
cube(rack,(0,-.021,0),(.140,.009,.250),brass,.006)
cube(rack,(0,-.027,0),(.132,.009,.242),enamel,.005)
for x in (-.054,.054):
    for z in (-.108,.108):
        disk(rack,x,-.033,z,.004,.003,brass)
        cube(rack,(x,-.035,z),(.004,.001,.0007),dark,.0002)
for x in (-.058,.058):cylinder(rack,(x,-.033,-.088),(x,-.033,.088),.0013,brass,12)
# Hook projects forward and curves up through the bow's opening.
disk(rack,0,-.035,.053,.012,.005,brass)
tube(rack,[(0,-.038,.053),(0,-.049,.053),(0,-.060,.050),(0,-.071,.050),(0,-.077,.056),(0,-.077,.068),(0,-.074,.073)],.0035,brass,12)
socket=root('BrassKeySocket',rack,(0,-.063,-.052))
# Reusable distinct matching three-prong ward emblem and plaque engraving.
badge=root('BrassWardsBadge')
disk(badge,0,0,0,.022,.003,brass)
disk(badge,0,-.002,0,.018,.0015,enamel)
for x,z,w,h in [(-.010,.002,.005,.014),(0,-.002,.005,.020),(.010,.003,.005,.012)]:
    cube(badge,(x,-.003,z),(w,.0015,h),brass,.0005)
# Same ward recess on the mount, with inlaid brass lines.
disk(rack,0,-.034,-.065,.024,.002,brass)
disk(rack,0,-.036,-.065,.020,.002,enamel)
for x,z,w,h in [(-.010,-.063,.005,.014),(0,-.067,.005,.020),(.010,-.062,.005,.012)]:
    cube(rack,(x,-.038,z),(w,.0015,h),brass,.0005)

# Join each root's meshes to reduce draw calls; preserve roots and socket.
for r in (key,rack,badge):
    children=[o for o in r.children if o.type=='MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in children:o.select_set(True)
    bpy.context.view_layer.objects.active=children[0]
    bpy.ops.object.join()
    o=children[0];o.name=r.name+'_Visual'
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(island_margin=.012)
    bpy.ops.object.mode_set(mode='OBJECT')

bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE/'brass-key-kit.blend'))
bpy.ops.object.select_all(action='SELECT')
glb=STAGE/'brass-key-kit.glb'
bpy.ops.export_scene.gltf(filepath=str(glb),export_format='GLB',export_yup=True,export_apply=True,use_selection=True,use_active_scene=True)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(glb))
for name in ('BrassCacheKey','BrassKeyRack','BrassKeySocket','BrassWardsBadge'):
    if name not in bpy.data.objects:raise RuntimeError('Missing '+name)
if bpy.data.objects['BrassKeySocket'].parent != bpy.data.objects['BrassKeyRack']:
    raise RuntimeError('Socket is not on rack')
tris=sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in bpy.context.scene.objects if o.type=='MESH')
if tris > 35000:raise RuntimeError('Triangle budget exceeded: '+str(tris))
report={'glb_sha256':hashlib.sha256(glb.read_bytes()).hexdigest(),'generator_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'source_blend_sha256':hashlib.sha256((SOURCE/'brass-key-kit.blend').read_bytes()).hexdigest(),'axes':'glTF +Y up, +Z front; metres','root_nodes':['BrassCacheKey','BrassKeyRack','BrassWardsBadge'],'socket_nodes':['BrassKeySocket'],'socket':{'name':'BrassKeySocket','parent':'BrassKeyRack','translation_gltf':[0,-.052,.063]},'triangles':tris,'blender':bpy.app.version_string,'visual_approval':'See review.md for the review of this GLB hash','limitations':['No authored LOD or collider','Runtime play-distance and interaction review pending']}
(SOURCE/'manifest.json').write_text(json.dumps(report,indent=2)+'\n')
shutil.copy2(glb,DEST/'brass-key-kit.glb')
# Rendering the reimported assets uses neutral studio lighting.
scene=bpy.context.scene
bpy.data.objects['BrassWardsBadge_Visual'].hide_render=True
bpy.data.objects['BrassCacheKey'].location=bpy.data.objects['BrassKeySocket'].matrix_world.translation
scene.world.color=(.16,.16,.16)
for pos,energy,color,size in [((-.7,-1.1,1.2),45,(1,.79,.58),.8),((.9,-.5,.5),35,(.55,.72,1),.65),((0,.4,.7),25,(1,.65,.35),.5)]:
    bpy.ops.object.light_add(type='AREA',location=pos);light=bpy.context.object;light.data.energy=energy;light.data.color=color;light.data.size=size
bpy.ops.object.camera_add(location=(.28,-1,.35));cam=bpy.context.object;cam.rotation_euler=(Vector((0,0,0))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=.40;scene.camera=cam
scene.render.engine='BLENDER_EEVEE';scene.eevee.taa_render_samples=24
scene.render.resolution_x=1000;scene.render.resolution_y=1000;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG';scene.render.film_transparent=False
for name,visible in [('rack-hung',True),('rack-empty',False)]:
    bpy.data.objects['BrassCacheKey_Visual'].hide_render=not visible
    scene.render.filepath=str(STAGE/(name+'.png'));bpy.ops.render.render(write_still=True)
bpy.data.objects['BrassCacheKey_Visual'].hide_render=False
cam.location=(.38,-.40,.12);cam.rotation_euler=(Vector((0,0,0))-cam.location).to_track_quat('-Z','Y').to_euler()
scene.render.filepath=str(STAGE/'rack-oblique.png');bpy.ops.render.render(write_still=True)
bpy.data.objects['BrassKeyRack'].hide_render=True
# Hide rack descendants as well: hide_render does not cascade.
for o in bpy.data.objects:
    if o.parent and o.parent.name=='BrassKeyRack':o.hide_render=True
bpy.data.objects['BrassCacheKey'].location=(0,0,0)
cam.location=(.05,-.65,.08);cam.rotation_euler=(Vector((0,0,0))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=.27
scene.render.filepath=str(STAGE/'key-close.png');bpy.ops.render.render(write_still=True)
print(json.dumps(report,indent=2))
