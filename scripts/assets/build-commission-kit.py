"""Original field commission assets. Blender Z-up maps to glTF Y-up, front +Z.
Run: Blender -b --factory-startup --python-exit-code 1 -P scripts/assets/build-commission-kit.py
"""
import bpy, math, json, hashlib, shutil
from pathlib import Path
from mathutils import Vector
import numpy as np
ROOT=Path(__file__).resolve().parents[2];SRC=ROOT/'assets-source/props/commission-kit';OUT=SRC/'staging';DEST=ROOT/'public/assets/props/commission-kit'
OUT.mkdir(parents=True,exist_ok=True);DEST.mkdir(parents=True,exist_ok=True)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)

def mat(name,c,metal=0,rough=.5,emit=0):
    m=bpy.data.materials.new(name);m.use_nodes=True;m.diffuse_color=(*c,1); p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(*c,1);p.inputs['Metallic'].default_value=metal;p.inputs['Roughness'].default_value=rough
    if emit:p.inputs['Emission Color'].default_value=(*c,1);p.inputs['Emission Strength'].default_value=emit
    return m
wood=mat('Figured walnut',(.20,.070,.028),.05,.52); woodlight=mat('Walnut raised edge',(.31,.12,.045),.05,.42)
brass=mat('Aged brass',(.58,.35,.10),.78,.36);patina=mat('Oxidized brass',(.09,.27,.21),.58,.57)
paper=mat('Aged letter paper',(.74,.61,.41),0,.79);dark=mat('Ink and dark steel',(.045,.06,.065),.37,.65)
steel=mat('Spring steel',(.46,.58,.61),.82,.29);wax=mat('Burgundy sealing wax',(.43,.035,.025),.12,.38)
leather=mat('Oxblood purse leather',(.27,.055,.035),.05,.6)
roots={}
def root(name,parent=None,loc=(0,0,0)):
    o=bpy.data.objects.new(name,None);bpy.context.scene.collection.objects.link(o);o.parent=parent;o.location=loc;roots[name]=o;return o

def attach(o,r,m,smooth=True):
    o.parent=r;o.data.materials.append(m)
    if o.type=='MESH':
        for f in o.data.polygons:f.use_smooth=smooth
    return o

def box(r,p,s,m,bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1,location=p);o=bpy.context.object;o.scale=s
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    if bevel:
        b=o.modifiers.new('Soft worn edges','BEVEL');b.width=bevel;b.segments=2
        bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=b.name)
    return attach(o,r,m,False)

def sphere(r,p,s,m):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=20,ring_count=10,location=p);o=bpy.context.object;o.scale=s;return attach(o,r,m)

def line(r,a,b,rad,m,tip=None):
    a,b=Vector(a),Vector(b);d=b-a
    bpy.ops.mesh.primitive_cone_add(vertices=8,radius1=rad,radius2=rad if tip is None else tip,depth=d.length,location=(a+b)*.5)
    o=bpy.context.object;o.rotation_euler=d.to_track_quat('Z','Y').to_euler();return attach(o,r,m)

def tube(r,pts,rad,m):
    sides=8;vertices=[];faces=[]
    for i,p in enumerate(pts):
        p=Vector(p); tangent=(Vector(pts[min(i+1,len(pts)-1)])-Vector(pts[max(0,i-1)])).normalized()
        guide=Vector((0,0,1)) if abs(tangent.z)<.90 else Vector((0,1,0))
        side=tangent.cross(guide).normalized();normal=tangent.cross(side).normalized()
        for j in range(sides):
            a=math.tau*j/sides;vertices.append(tuple(p+rad*(side*math.cos(a)+normal*math.sin(a))))
    for i in range(len(pts)-1):
        for j in range(sides):faces.append((i*sides+j,i*sides+(j+1)%sides,(i+1)*sides+(j+1)%sides,(i+1)*sides+j))
    mesh=bpy.data.meshes.new('continuous wire');mesh.from_pydata(vertices,[],faces);mesh.update();o=bpy.data.objects.new('continuous wire',mesh);bpy.context.scene.collection.objects.link(o);return attach(o,r,m)

def ring(r,center,rx,ry,rad,m,plane='xy',segments=40,start=0,end=math.tau):
    x,y,z=center;pts=[]
    for i in range(segments+1):
        t=start+(end-start)*i/segments
        pts.append((x+rx*math.cos(t),y+ry*math.sin(t),z) if plane=='xy' else (x+rx*math.cos(t),y,z+ry*math.sin(t)))
    tube(r,pts,rad,m)

def emblem(r,center,scale,plane='xz'):
    x,y,z=center
    ring(r,center,scale,scale,.0025,brass,plane,20)
    for i in range(8):
        a=math.tau*i/8
        if plane=='xz': p=(x+scale*.83*math.cos(a),y,z+scale*.83*math.sin(a));q=(x+scale*1.16*math.cos(a),y,z+scale*1.16*math.sin(a))
        else:p=(x+scale*.83*math.cos(a),y+scale*.83*math.sin(a),z);q=(x+scale*1.16*math.cos(a),y+scale*1.16*math.sin(a),z)
        line(r,p,q,.0027,brass)
    sphere(r,center,(.006,.006,.006),brass)

def disk(r,p,radius,depth,m,rotation=(0,0,0)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=32,radius=radius,depth=depth,location=p,rotation=rotation);return attach(bpy.context.object,r,m)

# Wall-board origin is its center; local front is Blender -Y / glTF +Z.
r=root('CommissionLedger')
box(r,(0,0,0),(.90,.12,.65),wood,.024)
# Layered molded walnut rim and gilt inlaid inner line.
for x in (-.422,.422):
    box(r,(x,-.066,0),(.038,.034,.60),woodlight,.008)
    line(r,(x+(.022 if x<0 else -.022),-.087,-.29),(x+(.022 if x<0 else -.022),-.087,.29),.003,brass)
for z in (-.298,.298):
    box(r,(0,-.066,z),(.87,.034,.036),woodlight,.008)
    line(r,(-.40,-.087,z+(.022 if z<0 else -.022)),(.40,-.087,z+(.022 if z<0 else -.022)),.003,brass)
# Carved corner rosettes and an unmistakable clockmaker cog emblem.
for x in (-.39,.39):
    for z in (-.265,.265):
        ring(r,(x,-.087,z),.023,.023,.003,woodlight,'xz',20);sphere(r,(x,-.09,z),(.005,.004,.005),brass)
emblem(r,(.30,-.092,.18),.045,'xz')
# Brass letter clips and nailheads.
for x in (-.15,.14):
    box(r,(x,-.095,.232),(.062,.026,.035),brass,.006);sphere(r,(x,-.111,.234),(.007,.004,.007),dark)
# A letter back sheet stays on the board; movable cover sits above it.
box(r,(-.002,-.079,-.005),(.46,.008,.43),paper,.004)
# The hinge is on the letter's left edge: +X cover, rotation about glTF local Y.
p=root('CommissionPaperPivot',r,(-.23,-.086,0))
box(p,(.23,0,0),(.46,.009,.43),paper,.003)
# Folded upper-right corner in raised contrasting paper.
mesh=bpy.data.meshes.new('folded corner');mesh.from_pydata([(.385,-.008,.215),(.46,-.008,.215),(.46,-.008,.14)],[],[(0,1,2)]);mesh.update();o=bpy.data.objects.new('folded corner',mesh);bpy.context.scene.collection.objects.link(o);attach(o,p,woodlight,False)
line(p,(.025,-.010,.144),(.17,-.010,.144),.002,dark)
for i in range(8):
    z=.105-i*.034;length=.26+.055*math.sin(i*2.2)
    line(p,(.025,-.01,z),(.025+length,-.01,z),.0016,dark)
# Wax seal mounted on right side, independently controllable.
s=root('CommissionStamp',r,(.30,-.098,-.13))
disk(s,(0,0,0),.050,.012,wax,(math.pi/2,0,0));ring(s,(0,-.008,0),.037,.037,.003,brass,'xz',24);emblem(s,(0,-.014,0),.022,'xz')
for a in (0,2,4):
    t=a*math.pi/3; sphere(s,(.050*math.cos(t),0,.050*math.sin(t)),(.009,.006,.009),wax)

# Returned cog purse: a separate display piece with gathered neck and cord.
r=root('CommissionPurse')
# Sculpted leather shell: irregular lobes converge on a narrow, gathered neck.
profile=[(.00,.050),(.015,.078),(.045,.096),(.075,.101),(.100,.090),(.120,.065),(.139,.044),(.151,.041),(.164,.052),(.171,.044)]
segments=48;verts=[];faces=[]
for z,radius in profile:
    for i in range(segments):
        a=math.tau*i/segments;fluting=1+.065*math.cos(8*a)+.025*math.cos(5*a+.6)
        verts.append((radius*fluting*math.cos(a),radius*.69*fluting*math.sin(a),z))
for j in range(len(profile)-1):
    for i in range(segments):faces.append((j*segments+i,j*segments+(i+1)%segments,(j+1)*segments+(i+1)%segments,(j+1)*segments+i))
mesh=bpy.data.meshes.new('gathered leather shell');mesh.from_pydata(verts,[],faces);mesh.update();o=bpy.data.objects.new('gathered leather shell',mesh);bpy.context.scene.collection.objects.link(o);attach(o,r,leather)
# Fold seams lead into the gathered neck, with a dark opening and a tied cord.
for i in range(8):
    a=math.tau*i/8;pts=[]
    for z,radius in profile[2:8]:
        radius*=1.067;pts.append((radius*math.cos(a),radius*.69*math.sin(a)-.001,z))
    tube(r,pts,.0018,wood)
disk(r,(0,0,.125),.020,.003,dark)
ring(r,(0,0,.145),.045,.031,.0045,brass,'xy',40)
# Knot, asymmetric loop and two differently long tails remain clearly visible.
sphere(r,(0,-.033,.144),(.009,.007,.008),brass)
tube(r,[(0,-.034,.145),(-.024,-.046,.162),(-.043,-.045,.151),(-.035,-.046,.138),(-.008,-.035,.142)],.0035,brass)
tube(r,[(0,-.035,.143),(.021,-.049,.126),(.038,-.052,.103)],.0035,brass)
tube(r,[(-.004,-.036,.141),(-.015,-.052,.119),(-.022,-.056,.091)],.0035,brass)
sphere(r,(.038,-.052,.103),(.005,.005,.005),brass);sphere(r,(-.022,-.056,.091),(.005,.005,.005),brass)
emblem(r,(0,-.068,.070),.026,'xz')

# Each recovery has its own stamped mount and strong 3D silhouette.
def base(r):
    box(r,(0,0,.012),(.22,.17,.024),wood,.008)
    box(r,(0,0,.027),(.195,.145,.008),brass,.005)
    for x in (-.08,.08):
        for y in (-.052,.052): sphere(r,(x,y,.032),(.005,.005,.003),dark)
    emblem(r,(.073,-.05,.037),.012,'xy')

r=root('ReturnSpring1');base(r)
# Flat spiral, terminated in an eye, sits on the mount.
points=[]
for i in range(161):
    a=i*math.tau*3.3/160;radius=.011+.00032*i;points.append((radius*math.cos(a)-.013,radius*math.sin(a)+.004,.045))
tube(r,points,.0032,steel)
ring(r,(points[-1][0]+.012,points[-1][1],.045),.012,.012,.0025,steel,'xy',24)
sphere(r,(-.013,.004,.045),(.007,.007,.004),dark)

r=root('ReturnSpring2');base(r)
# Barrel spring/spool: dark center, visible steel winding and brass end flanges.
disk(r,(-.015,0,.052),.060,.025,brass);disk(r,(-.015,0,.080),.050,.035,dark);disk(r,(-.015,0,.105),.060,.015,brass)
for j in range(4): ring(r,(-.015,0,.064+j*.010),.051,.051,.0028,steel,'xy',32)
disk(r,(-.015,0,.115),.014,.006,steel)
line(r,(.037,.005,.085),(.080,.028,.085),.004,steel,tip=.002)

r=root('ReturnSpring3');base(r)
# Raised, bowed escapement wire and fork tips viewed in profile.
pts=[]
for i in range(33):
    t=i/32;pts.append((-.075+.15*t,0,.048+.075*math.sin(math.pi*t)))
tube(r,pts,.004,steel)
for x in (-.075,.075):
    disk(r,(x,0,.043),.012,.018,brass)
    line(r,(x,0,.05),(x+(.018 if x>0 else -.018),0,.075),.003,steel)
line(r,(0,-.018,.095),(0,.018,.095),.003,brass)

# One mesh per independently animated semantic node, material slots shared per mesh.
for r in roots.values():
    children=[o for o in r.children if o.type=='MESH']
    if not children:continue
    bpy.ops.object.select_all(action='DESELECT')
    for o in children:o.select_set(True)
    bpy.context.view_layer.objects.active=children[0];bpy.ops.object.join();o=children[0];o.name=r.name+'_Visual'
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT');bpy.ops.uv.smart_project(island_margin=.01);bpy.ops.object.mode_set(mode='OBJECT')

# Original compact embedded UV PBR maps, including true tangent-space normal images.
size=256;yy,xx=np.mgrid[0:size,0:size].astype(np.float32);u=xx/size;v=yy/size
for idx,m in enumerate([wood,woodlight,brass,patina,paper,dark,steel,wax,leather]):
    p=m.node_tree.nodes.get('Principled BSDF');base=np.array(p.inputs['Base Color'].default_value[:3],dtype=np.float32)
    rng=np.random.default_rng(9200+idx);grain=rng.random((size,size),dtype=np.float32)-.5
    cloud=(np.sin(u*17+v*11)+np.cos(v*19-u*10))*.5;detail=np.sin(u*48+np.sin(v*14))*np.sin(v*46+np.sin(u*11));height=.25*cloud+.12*detail
    if m in (wood,woodlight):height+=.35*np.sin(v*105+2*np.sin(u*13))*np.sin(v*27)
    if m==paper:height+=.07*np.sin(u*95)*np.sin(v*98)
    color=np.clip(base[None,None,:]*(.85+.12*cloud[:,:,None]+.06*detail[:,:,None]+.05*grain[:,:,None]),0,1)
    if m==brass:
        pat=np.maximum(cloud-.48,0)[:,:,None]*.25;color=color*(1-pat)+np.array([.07,.23,.16])*pat
    dy,dx=np.gradient(height);norm=np.stack((-2*dx,-2*dy,np.ones_like(dx)),axis=2);norm/=np.linalg.norm(norm,axis=2,keepdims=True)
    rough=float(p.inputs['Roughness'].default_value)
    for kind,arr,space in [('base',color,'sRGB'),('roughness',np.repeat(np.clip(rough+.06*cloud[:,:,None]+.05*grain[:,:,None],.05,1),3,2),'Non-Color'),('normal',norm*.5+.5,'Non-Color')]:
        px=np.ones((size,size,4),np.float32);px[:,:,:3]=arr
        im=bpy.data.images.new(m.name+' '+kind,width=size,height=size,alpha=True);im.colorspace_settings.name=space;im.pixels.foreach_set(px.ravel());im.file_format='PNG';im.filepath_raw=str(OUT/(m.name.replace(' ','-')+'-'+kind+'.png'));im.save();im.pack()
        tex=m.node_tree.nodes.new('ShaderNodeTexImage');tex.image=im
        if kind=='base':m.node_tree.links.new(tex.outputs['Color'],p.inputs['Base Color'])
        elif kind=='roughness':m.node_tree.links.new(tex.outputs['Color'],p.inputs['Roughness'])
        else:
            n=m.node_tree.nodes.new('ShaderNodeNormalMap');m.node_tree.links.new(tex.outputs['Color'],n.inputs['Color']);m.node_tree.links.new(n.outputs['Normal'],p.inputs['Normal'])

bpy.ops.wm.save_as_mainfile(filepath=str(SRC/'commission-kit.blend'))
bpy.ops.object.select_all(action='SELECT');bpy.ops.export_scene.gltf(filepath=str(OUT/'commission-kit.glb'),export_format='GLB',export_yup=True,export_apply=True)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False);bpy.ops.import_scene.gltf(filepath=str(OUT/'commission-kit.glb'))
missing=set(roots)-set(bpy.data.objects.keys())
if missing:raise RuntimeError('missing exported nodes: '+str(missing))
for child,parent in [('CommissionPaperPivot','CommissionLedger'),('CommissionStamp','CommissionLedger')]:
    if bpy.data.objects[child].parent!=bpy.data.objects[parent]:raise RuntimeError('wrong parent '+child)
tris=sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in bpy.context.scene.objects if o.type=='MESH')
if tris>40000:raise RuntimeError('triangle limit '+str(tris))
# Staged review arrangement after export, leaving all asset transforms unchanged.
bpy.data.objects['CommissionLedger'].location=(0,0,.91)
for n,p in {'CommissionPurse':(.56,-.25,0),'ReturnSpring1':(-.48,-.35,0),'ReturnSpring2':(-.18,-.35,0),'ReturnSpring3':(.12,-.35,0)}.items():bpy.data.objects[n].location=p
world=bpy.context.scene.world;world.color=(.18,.18,.18)
for loc,energy,color,size in [((-2,-4,4),750,(1,.70,.46),4),((3,-2,3),650,(.46,.66,1),3),((0,2,3),650,(1,.57,.27),3)]:
    bpy.ops.object.light_add(type='AREA',location=loc);o=bpy.context.object;o.data.energy=energy;o.data.color=color;o.data.shape='DISK';o.data.size=size
bpy.ops.object.camera_add(location=(0,-5,1.6));cam=bpy.context.object;cam.data.type='ORTHO';scene=bpy.context.scene;scene.camera=cam;scene.render.engine='BLENDER_EEVEE';scene.render.resolution_x=1500;scene.render.resolution_y=1000;scene.render.resolution_percentage=85;scene.eevee.taa_render_samples=8
for name,loc,target,scale in [('review-front',(0,-5,1.35),(0,0,.72),2.0),('review-three-quarter',(2,-4,2.1),(0,0,.72),2.1),('review-ledger',(0,-4,1.05),(0,0,.91),1.32),('review-springs',(.25,-2,1.5),(-.1,-.35,.05),1.35)]:
    cam.location=loc;cam.rotation_euler=(Vector(target)-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=scale;scene.render.filepath=str(OUT/(name+'.png'));bpy.ops.render.render(write_still=True)
# Isolated, uncropped purse inspection and opened letter backing.
for n in ('CommissionLedger','ReturnSpring1','ReturnSpring2','ReturnSpring3'):
    for o in [bpy.data.objects[n]]+list(bpy.data.objects[n].children_recursive):o.hide_render=True
cam.location=(1.05,-1.15,.55);cam.rotation_euler=(Vector((.56,-.25,.085))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=.48
scene.render.filepath=str(OUT/'review-purse-close.png');bpy.ops.render.render(write_still=True)
for o in [bpy.data.objects['CommissionLedger']]+list(bpy.data.objects['CommissionLedger'].children_recursive):o.hide_render=False
for o in [bpy.data.objects['CommissionPurse']]+list(bpy.data.objects['CommissionPurse'].children_recursive):o.hide_render=True
pivot=bpy.data.objects['CommissionPaperPivot'];pivot.rotation_mode='XYZ';pivot.rotation_euler.z=-.9
cam.location=(1.7,-3,1.5);cam.rotation_euler=(Vector((0,0,.91))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=1.45
scene.render.filepath=str(OUT/'review-letter-open.png');bpy.ops.render.render(write_still=True)
shutil.copy2(OUT/'commission-kit.glb',DEST/'commission-kit.glb')
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
manifest={'glb_sha256':sha(DEST/'commission-kit.glb'),'generator_sha256':sha(Path(__file__)),'source_blend_sha256':sha(SRC/'commission-kit.blend'),'axes':'glTF +Y up, +Z front; metres','root_nodes':list(roots),'triangles':tris,'blender':bpy.app.version_string,'visual_approval':'pending independent and owner review','limitations':['No authored LOD or collider','Runtime play-distance and interaction review pending']}
(SRC/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');(OUT/'report.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest,indent=2))
