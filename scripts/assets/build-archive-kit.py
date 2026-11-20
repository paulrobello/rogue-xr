"""Original Clockwork Spire archive obstacle kit. Blender Z up, runtime glTF Y up.
Run: Blender -b --factory-startup --python-exit-code 1 -P scripts/assets/build-archive-kit.py
"""
import bpy, math, hashlib, json, shutil
from pathlib import Path
from mathutils import Vector
import numpy as np
ROOT=Path(__file__).resolve().parents[2]
SRC=ROOT/'assets-source/props/archive-kit'; OUT=SRC/'staging'; DEST=ROOT/'public/assets/props/archive-kit'
OUT.mkdir(parents=True,exist_ok=True); DEST.mkdir(parents=True,exist_ok=True)
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)

def mat(name,color,metal=0,rough=.5,emission=0):
    m=bpy.data.materials.new(name); m.use_nodes=True; m.diffuse_color=(*color,1)
    p=m.node_tree.nodes.get('Principled BSDF'); p.inputs['Base Color'].default_value=(*color,1); p.inputs['Metallic'].default_value=metal; p.inputs['Roughness'].default_value=rough
    if emission: p.inputs['Emission Color'].default_value=(*color,1); p.inputs['Emission Strength'].default_value=emission
    return m
stone=mat('Blue archive stone',(.24,.32,.35),.10,.8)
slate=mat('Deep slate',(.055,.10,.13),.28,.65)
gold=mat('Antique brass',(.53,.30,.09),.78,.35)
silver=mat('Tarnished silver',(.42,.52,.54),.83,.27)
ink=mat('Luminous star ink',(.85,.62,.22),.22,.38,1.15)
wood=mat('Dark figured walnut',(.20,.075,.029),.05,.53)
paper=mat('Aged parchment',(.61,.49,.32),0,.8)
verdigris=mat('Verdigris foliage',(.09,.27,.20),.53,.5)
jewel=mat('Sapphire latch',(.04,.32,.53),.38,.20,.35)
blade=mat('Polished fan brass',(.85,.56,.18),.62,.25)
roots={}; sockets=[]
def root(name,loc=(0,0,0)):
    o=bpy.data.objects.new(name,None); bpy.context.scene.collection.objects.link(o); o.location=loc; roots[name]=o; return o
def socket(parent,name,loc):
    o=bpy.data.objects.new(name,None); bpy.context.scene.collection.objects.link(o); o.parent=parent; o.location=loc; sockets.append(name)
def assign(o,r,m,smooth=True):
    o.parent=r; o.data.materials.append(m)
    if o.type=='MESH':
        for f in o.data.polygons: f.use_smooth=smooth
    return o
def cube(r,p,s,m):
    bpy.ops.mesh.primitive_cube_add(size=1,location=p); o=bpy.context.object; o.scale=s; return assign(o,r,m,False)
def sphere(r,p,s,m):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16,ring_count=8,location=p); o=bpy.context.object; o.scale=s; return assign(o,r,m)
def line(r,a,b,rad,m,vertices=8,tip=None):
    a,b=Vector(a),Vector(b); v=b-a
    bpy.ops.mesh.primitive_cone_add(vertices=vertices,radius1=rad,radius2=rad if tip is None else tip,depth=v.length,location=(a+b)*.5)
    o=bpy.context.object; o.rotation_euler=v.to_track_quat('Z','Y').to_euler(); return assign(o,r,m)
def ring(r,center,rx,rz,thickness,m,start=0,end=math.tau,segments=48):
    x,y,z=center; prev=None
    for i in range(segments+1):
        t=start+(end-start)*i/segments; p=(x+rx*math.cos(t),y,z+rz*math.sin(t))
        if prev is not None: line(r,prev,p,thickness,m,6)
        prev=p

def smooth_ring(r,center,rx,rz,thickness,m,start=0,end=math.tau,segments=64):
    # Continuous elliptical tube avoids visible joints between small straight segments.
    cx,cy,cz=center; sides=8; verts=[]; faces=[]
    for i in range(segments+1):
        t=start+(end-start)*i/segments
        outward=Vector((math.cos(t)/rx,0,math.sin(t)/rz)).normalized()
        for j in range(sides):
            a=math.tau*j/sides; offset=outward*(thickness*math.cos(a))+Vector((0,thickness*math.sin(a),0))
            verts.append((cx+rx*math.cos(t)+offset.x,cy+offset.y,cz+rz*math.sin(t)+offset.z))
    for i in range(segments):
        for j in range(sides): faces.append((i*sides+j,i*sides+(j+1)%sides,(i+1)*sides+(j+1)%sides,(i+1)*sides+j))
    mesh=bpy.data.meshes.new('continuous rim');mesh.from_pydata(verts,[],faces);mesh.update()
    o=bpy.data.objects.new('continuous rim',mesh);bpy.context.scene.collection.objects.link(o);assign(o,r,m)

def flat_arc(r,cx,cy,z,rx,ry,start,end,m,width=.0025):
    points=[(cx+rx*math.cos(start+(end-start)*i/20),cy+ry*math.sin(start+(end-start)*i/20),z) for i in range(21)]
    for a,b in zip(points,points[1:]): line(r,a,b,width,m,6)

def leaf(r,a,b,w,m):
    # Thin, pointed lozenge in the XZ plane.
    a,b=Vector(a),Vector(b); mid=(a+b)/2; d=b-a; perp=Vector((-d.z,0,d.x)).normalized()*w
    verts=[tuple(a),tuple(mid+perp),tuple(b),tuple(mid-perp),tuple(mid+Vector((0,-.012,0)))]
    mesh=bpy.data.meshes.new('leaf'); mesh.from_pydata(verts,[],[(0,1,4),(1,2,4),(2,3,4),(3,0,4),(3,2,1,0)]);mesh.update()
    o=bpy.data.objects.new('leaf',mesh);bpy.context.scene.collection.objects.link(o);assign(o,r,m,False)

def star(r,x,y,z,size,m):
    line(r,(x-size,y,z),(x+size,y,z),.0035,m,6);line(r,(x,y,z-size),(x,y,z+size),.0035,m,6);sphere(r,(x,y,z),(.009,.006,.009),m)

# Ink door panels: no marks in the opaque leaves. All revealing art is on separate root.
for sign in (-1,1):
    r=root('ArchiveInkLeft' if sign<0 else 'ArchiveInkRight'); d=-sign
    cube(r,(d*.4,0,1.2),(.80,.16,2.40),stone)
    for h in (.08,.72,1.36,2.00,2.32): line(r,(0,-.083,h),(d*.8,-.083,h),.006,slate)
    for z in (.28,1.00,1.72,2.20):
        x=d*(.18 if int(z*100)%2 else .55); line(r,(x,-.085,z-.21),(x,-.085,z+.21),.004,slate)
    for z in (.22,1.2,2.18): ring(r,(0,-.04,z),.04,.04,.007,gold,segments=12)
r=root('ArchiveInkTrace')
# A glowing arch surrounds the reveal; its entire node can be faded together.
for x in (-.68,.68): line(r,(x,-.108,.10),(x,-.108,1.60),.008,ink)
smooth_ring(r,(0,-.108,1.60),.68,.57,.008,ink,0,math.pi,48)
# Two constellations, luminous only when this entire node becomes visible.
for pts in [[(-.58,1.86),(-.33,1.98),(-.10,1.69),(.17,1.81),(.47,2.03)], [(-.50,.61),(-.30,.88),(-.03,.74),(.22,1.02),(.52,.82)]]:
    for (x,z),(xx,zz) in zip(pts,pts[1:]): line(r,(x,-.102,z),(xx,-.102,zz),.004,ink,6)
    for i,(x,z) in enumerate(pts): star(r,x,-.108,z,.027 if i%2 else .036,ink)
ring(r,(0,-.10,1.28),.22,.22,.005,gold,segments=32)
for i in range(8):
    a=math.tau*i/8; star(r,.22*math.cos(a),-.11,1.28+.22*math.sin(a),.015,ink)
r=root('ArchiveInkLatch'); sphere(r,(0,-.135,1.20),(.065,.035,.065),gold); sphere(r,(0,-.172,1.20),(.038,.025,.038),jewel)

# Stillwind gates: airy bars, integrated fan cage, independently rotating rotor.
for sign in (-1,1):
    r=root('ArchiveWindLeft' if sign<0 else 'ArchiveWindRight'); d=-sign
    for x in (0,.78): line(r,(d*x,0,.04),(d*x,0,2.36),.028,gold,10)
    for z in (.06,.22,1.95,2.34): line(r,(0,0,z),(d*.78,0,z),.025,gold,10)
    for x in (.13,.26,.39,.52,.65):
        line(r,(d*x,0,.20),(d*x,0,2.20),.012,silver)
        for z in (.43,1.91): sphere(r,(d*x,-.01,z),(.022,.014,.022),gold)
    for z in (.42,1.18,2.10): ring(r,(0,0,z),.04,.04,.007,gold,segments=12)
    # Half fan guard fixed to each leaf.
    start=math.pi/2 if d==1 else -math.pi/2
    ring(r,(d*.8,-.075,1.20),.37,.37,.014,gold,start,start+math.pi,24)
    ring(r,(d*.8,-.078,1.20),.28,.28,.007,silver,start,start+math.pi,24)
r=root('ArchiveWindRotor',(0,-.13,1.20))
bpy.ops.mesh.primitive_cylinder_add(vertices=32,radius=.265,depth=.02,location=(0,.018,0),rotation=(math.pi/2,0,0));assign(bpy.context.object,r,slate)
ring(r,(0,0,0),.25,.25,.009,gold,segments=36)
for i in range(6):
    a=i*math.tau/6; tip=(.23*math.cos(a+.28),-.012,.23*math.sin(a+.28)); base=(.035*math.cos(a),-.01,.035*math.sin(a))
    leaf(r,base,tip,.065,blade)
sphere(r,(0,-.02,0),(.055,.035,.055),silver)

# Hinged botanical mirror surround; the reflective insert is a separate controlled root.
for sign in (-1,1):
    r=root('ArchiveMirrorLeft' if sign<0 else 'ArchiveMirrorRight'); d=-sign
    for x in (0,.8): line(r,(d*x,0,.05),(d*x,0,2.35),.026,wood,10)
    for z in (.05,2.35): line(r,(0,0,z),(d*.8,0,z),.026,wood,10)
    start=math.pi/2 if d==1 else -math.pi/2
    smooth_ring(r,(d*.8,-.085,1.20),.58,.99,.028,wood,start,start+math.pi,64)
    smooth_ring(r,(d*.8,-.126,1.20),.52,.93,.009,gold,start,start+math.pi,64)
    line(r,(d*.10,-.10,.22),(d*.10,-.10,2.18),.012,verdigris)
    for i in range(7):
        z=.33+i*.28; x=d*(.10+.035*math.sin(i*1.3))
        line(r,(d*.10,-.10,z-.02),(x,-.10,z),.009,verdigris)
        line(r,(d*.10,-.10,z),(0,-.10,z+.04),.008,verdigris)
        line(r,(x,-.10,z),(x+d*.07,-.105,z+.10),.009,verdigris)
        leaf(r,(x+d*.04,-.115,z+.06),(x+d*.13,-.115,z+.15),.024,verdigris)
        leaf(r,(x+d*.03,-.116,z+.04),(x-d*.04,-.116,z+.13),.021,gold)
r=root('ArchiveMirrorSilver')
# Flattened ellipsoid retains a solid PBR appearance without screen-space reflections.
sphere(r,(0,-.07,1.20),(.51,.028,.92),silver)
smooth_ring(r,(0,-.115,1.20),.49,.90,.008,gold,segments=72)

# Desk-size diegetic objects. Their sockets sit in local X/Y plane above each item.
r=root('InkRubbing')
cube(r,(0,0,.012),(.30,.22,.024),slate); cube(r,(0,0,.027),(.26,.18,.009),silver)
# Symbolic rubbing: eight-point star reflected in rippling pool, plus crescent moon.
for i in range(8):
    a=math.tau*i/8; radius=.025 if i%2==0 else .017
    line(r,(-.075, .030,.037),(-.075+radius*math.cos(a),.030+radius*math.sin(a),.037),.0025,slate,6)
for off in (0,.009): flat_arc(r,-.075,.000-off,.039,.035,.008,math.pi*.08,math.pi*.92,slate,.002)
flat_arc(r,.065,.020,.039,.029,.029,math.pi*.23,math.pi*1.72,slate,.003)
flat_arc(r,.076,.020,.039,.022,.024,math.pi*.35,math.pi*1.65,slate,.003)
# Emblem mounts occupy the empty front margin, clear of the etched symbols.
for i,x in enumerate((-.075,.075),1): socket(r,f'InkRubbingSocket{i}',(x,-.075,.045))
r=root('WindChart')
# Ragged parchment mesh lies flat on a desk.
verts=[(-.16,-.10,.005),(.14,-.10,.005),(.16,-.055,.005),(.145,.015,.005),(.16,.10,.005),(-.12,.10,.005),(-.16,.075,.005)]
mesh=bpy.data.meshes.new('torn parchment');mesh.from_pydata(verts,[],[tuple(range(len(verts)))]);mesh.update();o=bpy.data.objects.new('torn parchment',mesh);bpy.context.scene.collection.objects.link(o);assign(o,r,paper,False)
for j in range(3):
    points=[(-.12,-.065+j*.055,.008),(-.055,-.05+j*.055,.008),(.015,-.065+j*.055,.008),(.085,-.048+j*.055,.008),(.125,-.058+j*.055,.008)]
    for a,b in zip(points,points[1:]): line(r,a,b,.0025,slate,6)
for i,x in enumerate((-.075,.075),1): socket(r,f'WindChartSocket{i}',(x,0,.014))
r=root('HandMirror')
# Laying flat: handle extends toward the viewer along -Y, oval face above desk.
cube(r,(0,-.14,.015),(.036,.18,.028),wood); sphere(r,(0,0,.022),(.105,.14,.015),gold); sphere(r,(0,0,.038),(.09,.122,.007),silver)
for i,x in enumerate((-.045,.045),1): socket(r,f'HandMirrorSocket{i}',(x,0,.05))

# Combine per control root to minimize scene nodes, preserving material slots and pivots.
for r in roots.values():
    meshes=[o for o in r.children if o.type=='MESH']
    if not meshes: continue
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes: o.select_set(True)
    bpy.context.view_layer.objects.active=meshes[0]; bpy.ops.object.join(); o=meshes[0]; o.name=r.name+'_Visual'
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT'); bpy.ops.uv.smart_project(island_margin=.01); bpy.ops.object.mode_set(mode='OBJECT')

# UV materials: authored 256 px base color, roughness and tangent-space normal images.
size=256; yy,xx=np.mgrid[0:size,0:size].astype(np.float32); u=xx/size;v=yy/size
for idx,m in enumerate([stone,slate,gold,silver,ink,wood,paper,verdigris,jewel,blade]):
    shader=m.node_tree.nodes.get('Principled BSDF'); base=np.array(shader.inputs['Base Color'].default_value[:3],dtype=np.float32)
    rng=np.random.default_rng(2100+idx); grain=rng.random((size,size),dtype=np.float32)-.5
    cloud=(np.sin(u*15+v*9)+np.cos(v*21-u*11))*.5; fine=np.sin(u*55+np.sin(v*17))*np.sin(v*48+np.sin(u*13))
    height=.26*cloud+.15*fine
    if m==stone: height+=.22*np.maximum(0,np.sin(u*82)*np.sin(v*78))**5
    if m==wood: height+=.3*np.sin(v*108+2*np.sin(u*12))*np.sin(v*30)
    if m==paper: height+=.10*np.sin(u*110)*np.sin(v*106)
    col=np.clip(base[None,None,:]*(.83+.12*cloud[:,:,None]+.07*fine[:,:,None]+.05*grain[:,:,None]),0,1)
    rough=float(shader.inputs['Roughness'].default_value); dy,dx=np.gradient(height); normal=np.stack((-dx*2,-dy*2,np.ones_like(dx)),2);normal/=np.linalg.norm(normal,axis=2,keepdims=True)
    for kind,data,color in [('base',col,'sRGB'),('roughness',np.repeat(np.clip(rough+.07*cloud[:,:,None]+.06*grain[:,:,None],.05,1),3,2),'Non-Color'),('normal',normal*.5+.5,'Non-Color')]:
        px=np.ones((size,size,4),dtype=np.float32);px[:,:,:3]=data
        im=bpy.data.images.new(m.name+' '+kind,width=size,height=size,alpha=True);im.colorspace_settings.name=color;im.pixels.foreach_set(px.ravel());im.file_format='PNG';im.filepath_raw=str(OUT/(m.name.replace(' ','-')+'-'+kind+'.png'));im.save();im.pack()
        tex=m.node_tree.nodes.new('ShaderNodeTexImage');tex.image=im
        if kind=='base':m.node_tree.links.new(tex.outputs['Color'],shader.inputs['Base Color'])
        elif kind=='roughness':m.node_tree.links.new(tex.outputs['Color'],shader.inputs['Roughness'])
        else:
            normalnode=m.node_tree.nodes.new('ShaderNodeNormalMap');m.node_tree.links.new(tex.outputs['Color'],normalnode.inputs['Color']);m.node_tree.links.new(normalnode.outputs['Normal'],shader.inputs['Normal'])

bpy.ops.wm.save_as_mainfile(filepath=str(SRC/'archive-kit.blend'))
bpy.ops.object.select_all(action='SELECT');bpy.ops.export_scene.gltf(filepath=str(OUT/'archive-kit.glb'),export_format='GLB',export_yup=True,export_apply=True)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False);bpy.ops.import_scene.gltf(filepath=str(OUT/'archive-kit.glb'))
missing=set(roots).union(sockets)-set(bpy.data.objects.keys())
if missing: raise RuntimeError('missing named nodes: '+str(missing))
triangles=sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in bpy.context.scene.objects if o.type=='MESH')
if triangles>50000: raise RuntimeError('kit triangle limit exceeded '+str(triangles))
# Review arrangement only after export; show variants together and props enlarged in detail renders.
positions={'ArchiveInkLeft':(-3.6,0,0),'ArchiveInkRight':(-2.0,0,0),'ArchiveInkTrace':(-2.8,0,0),'ArchiveInkLatch':(-2.8,0,0),'ArchiveWindLeft':(-.8,0,0),'ArchiveWindRight':(.8,0,0),'ArchiveMirrorLeft':(2.0,0,0),'ArchiveMirrorRight':(3.6,0,0),'ArchiveMirrorSilver':(2.8,0,0),'InkRubbing':(-1,-1,0),'WindChart':(-.5,-1,0),'HandMirror':(0,-1,0)}
for n,p in positions.items():bpy.data.objects[n].location=p
bpy.data.objects['ArchiveWindRotor'].location=(0,-.13,1.2)
world=bpy.context.scene.world;world.color=(.16,.16,.16)
for loc,energy,color,size in [((-4,-5,6),1500,(1,.70,.44),5),((4,-3,5),1150,(.42,.64,1),5),((0,3,5),1100,(1,.56,.25),4)]:
    bpy.ops.object.light_add(type='AREA',location=loc);o=bpy.context.object;o.data.energy=energy;o.data.color=color;o.data.shape='DISK';o.data.size=size
bpy.ops.object.camera_add(location=(0,-10,4.4));cam=bpy.context.object;cam.rotation_euler=(Vector((0,0,1.1))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=8.7
scene=bpy.context.scene;scene.camera=cam;scene.render.engine='BLENDER_EEVEE';scene.render.resolution_x=1500;scene.render.resolution_y=950;scene.render.resolution_percentage=100
for name,loc,target,scale in [('review-all',(0,-10,4.4),(0,0,1.1),8.7),('review-ink',(-2.8,-5,2.1),(-2.8,0,1.2),4.2),('review-wind',(0,-5,2.1),(0,0,1.2),4.2),('review-mirror',(2.8,-5,2.1),(2.8,0,1.2),4.2),('review-props',(-.45,-2.4,1.7),(-.5,-1,0),1.5)]:
    cam.location=loc;cam.rotation_euler=(Vector(target)-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=scale;scene.render.filepath=str(OUT/(name+'.png'));bpy.ops.render.render(write_still=True)
# Capture actual blank and revealed states using the same camera and lighting.
cam.location=(-2.8,-5,2.1);cam.rotation_euler=(Vector((-2.8,0,1.2))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=4.2
for name in ('ArchiveInkTrace','ArchiveInkLatch'):
    for child in bpy.data.objects[name].children: child.hide_render=True
scene.render.filepath=str(OUT/'review-ink-before.png');bpy.ops.render.render(write_still=True)
for name in ('ArchiveInkTrace','ArchiveInkLatch'):
    for child in bpy.data.objects[name].children: child.hide_render=False
scene.render.filepath=str(OUT/'review-ink-after.png');bpy.ops.render.render(write_still=True)
cam.location=(-1,-1.05,1.5);cam.rotation_euler=(Vector((-1,-1,0))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=.55
scene.render.filepath=str(OUT/'review-rubbing-close.png');bpy.ops.render.render(write_still=True)
shutil.copy2(OUT/'archive-kit.glb',DEST/'archive-kit.glb')
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
manifest={'glb_sha256':sha(DEST/'archive-kit.glb'),'generator_sha256':sha(Path(__file__)),'source_blend_sha256':sha(SRC/'archive-kit.blend'),'axes':'glTF +Y up, +Z front, metres','root_nodes':list(roots),'socket_nodes':sockets,'triangles':triangles,'blender':bpy.app.version_string,'visual_approval':'pending independent and owner review','limitations':['No authored collision or LODs','Mirror is tarnished PBR metal, not a real-time reflection','Runtime integration and play-distance review pending']}
(SRC/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');(OUT/'report.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest,indent=2))
