"""Clockwork Spire calibration kit. Blender Z-up maps to glTF Y-up; front +Z.
Run Blender -b --factory-startup --python-exit-code 1 -P scripts/assets/build-calibration-kit.py
"""
import bpy,math,json,hashlib,shutil
from pathlib import Path
from mathutils import Vector
import numpy as np
ROOT=Path(__file__).resolve().parents[2];SRC=ROOT/'assets-source/props/calibration-kit';OUT=SRC/'staging';DEST=ROOT/'public/assets/props/calibration-kit'
OUT.mkdir(parents=True,exist_ok=True);DEST.mkdir(parents=True,exist_ok=True)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)

def mat(name,c,metal=0,rough=.5,emit=0):
 m=bpy.data.materials.new(name);m.use_nodes=True;m.diffuse_color=(*c,1);p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(*c,1);p.inputs['Metallic'].default_value=metal;p.inputs['Roughness'].default_value=rough
 if emit:p.inputs['Emission Color'].default_value=(*c,1);p.inputs['Emission Strength'].default_value=emit
 return m
walnut=mat('Figured walnut',(.20,.075,.03),.08,.5); darkwood=mat('Dark molding',(.09,.035,.018),.04,.48)
brass=mat('Engraved brass',(.57,.35,.10),.79,.32);patina=mat('Copper patina',(.08,.27,.21),.54,.56)
enamel=mat('Neutral slate enamel',(.12,.16,.18),.17,.69);paper=mat('Ivory chart enamel',(.65,.58,.43),.05,.68)
moon=mat('Ivory moon',(.76,.79,.65),.22,.35,.12);ember=mat('Ember sun',(.9,.23,.035),.25,.35,.45);cyan=mat('Celestial cyan',(.06,.58,.67),.32,.25,.35)
roots={};sockets=[]
def root(name,parent=None,loc=(0,0,0)):
 o=bpy.data.objects.new(name,None);bpy.context.scene.collection.objects.link(o);o.parent=parent;o.location=loc;roots[name]=o;return o

def attach(o,r,m,smooth=True):
 o.parent=r;o.data.materials.append(m)
 if o.type=='MESH':
  for f in o.data.polygons:f.use_smooth=smooth
 return o

def cube(r,p,s,m,bevel=0):
 bpy.ops.mesh.primitive_cube_add(size=1,location=p);o=bpy.context.object;o.scale=s;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
 if bevel:
  mod=o.modifiers.new('Rounded edge','BEVEL');mod.width=bevel;mod.segments=2;bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=mod.name)
 return attach(o,r,m,False)

def sphere(r,p,s,m,segments=20):
 bpy.ops.mesh.primitive_uv_sphere_add(segments=segments,ring_count=10,location=p);o=bpy.context.object;o.scale=s;return attach(o,r,m)

def line(r,a,b,rad,m):
 a,b=Vector(a),Vector(b);d=b-a;bpy.ops.mesh.primitive_cylinder_add(vertices=10,radius=rad,depth=d.length,location=(a+b)*.5);o=bpy.context.object;o.rotation_euler=d.to_track_quat('Z','Y').to_euler();return attach(o,r,m)

def tube(r,pts,rad,m):
 sides=8;verts=[];faces=[]
 for i,p in enumerate(pts):
  p=Vector(p);t=(Vector(pts[min(i+1,len(pts)-1)])-Vector(pts[max(0,i-1)])).normalized();guide=Vector((0,0,1)) if abs(t.z)<.90 else Vector((0,1,0));side=t.cross(guide).normalized();normal=t.cross(side).normalized()
  for j in range(sides):
   a=math.tau*j/sides;verts.append(tuple(p+rad*(side*math.cos(a)+normal*math.sin(a))))
 for i in range(len(pts)-1):
  for j in range(sides):faces.append((i*sides+j,i*sides+(j+1)%sides,(i+1)*sides+(j+1)%sides,(i+1)*sides+j))
 mesh=bpy.data.meshes.new('continuous detail');mesh.from_pydata(verts,[],faces);mesh.update();o=bpy.data.objects.new('continuous detail',mesh);bpy.context.scene.collection.objects.link(o);return attach(o,r,m)

def ring(r,c,rx,rz,rad,m,start=0,end=math.tau,segments=48):
 x,y,z=c;pts=[(x+rx*math.cos(start+(end-start)*i/segments),y,z+rz*math.sin(start+(end-start)*i/segments)) for i in range(segments+1)];tube(r,pts,rad,m)

def disk(r,p,radius,depth,m):
 bpy.ops.mesh.primitive_cylinder_add(vertices=32,radius=radius,depth=depth,location=p,rotation=(math.pi/2,0,0));return attach(bpy.context.object,r,m)

# Frame pivots at its central plane; the front is Blender -Y.
r=root('CalibrationFrame')
cube(r,(0,.01,0),(1.55,.10,.88),darkwood,.015)
# Neutral inset remains clear for runtime controls: opening 1.36 by .67 m.
cube(r,(0,-.047,0),(1.36,.025,.67),enamel,.005)
for x in (-.725,.725):
 cube(r,(x,-.066,0),(.10,.045,.83),walnut,.012)
 for off in (-.03,.03):line(r,(x+off,-.091,-.39),(x+off,-.091,.39),.0028,brass)
for z in (-.405,.405):
 cube(r,(0,-.066,z),(1.47,.045,.07),walnut,.012)
 for off in (-.02,.02):line(r,(-.70,-.091,z+off),(.70,-.091,z+off),.0028,brass)
# Lower shelf projects toward the visitor but leaves the center uncluttered.
cube(r,(0,-.135,-.43),(1.48,.19,.045),walnut,.008)
line(r,(-.72,-.235,-.414),(.72,-.235,-.414),.004,brass)
for x in (-.69,.69):
 for z in (-.37,.37):disk(r,(x,-.094,z),.012,.006,brass)

# Coaxial orrery controls, independently cloneable roots. Initial bodies are at twelve.
for name,radius,depth,kind in [('OrreryInner',.12,-.105,'moon'),('OrreryMiddle',.21,-.130,'sun'),('OrreryOuter',.30,-.155,'planet')]:
 r=root(name)
 ring(r,(0,depth,0),radius,radius,.0035,brass,segments=56)
 line(r,(0,depth,0),(0,depth,radius),.005,brass)
 disk(r,(0,depth-.008,0),.014,.01,brass)
 if kind=='moon':
  # Crescent silhouette built as a curved tapered chain and smaller bright cusp tips.
  pts=[]
  for i in range(25):
   t=math.radians(48+264*i/24);pts.append((.022*math.cos(t),depth-.015,radius+.029*math.sin(t)))
  tube(r,pts,.006,moon)
 elif kind=='sun':
  sphere(r,(0,depth-.016,radius),(.027,.016,.027),ember)
  for i in range(8):
   a=i*math.tau/8;line(r,(.031*math.cos(a),depth-.017,radius+.031*math.sin(a)),(.044*math.cos(a),depth-.017,radius+.044*math.sin(a)),.003,brass)
 else:
  sphere(r,(0,depth-.016,radius),(.027,.018,.027),cyan)
  ring(r,(0,depth-.022,radius),.047,.016,.003,brass,segments=40)

# Chart cabinet is centered, with a deliberately unprinted face for seeded drawings.
r=root('ChartCabinet')
cube(r,(0,.02,0),(.80,.12,.68),darkwood,.015)
cube(r,(0,-.048,.055),(.62,.020,.40),paper,.003)
for x in (-.35,.35):cube(r,(x,-.067,0),(.065,.04,.64),walnut,.008)
for z in (-.305,.305):cube(r,(0,-.067,z),(.76,.04,.06),walnut,.008)
for x in (-.318,.318):line(r,(x,-.093,-.12),(x,-.093,.27),.003,brass)
for z in (-.14,.26):line(r,(-.32,-.093,z),(.32,-.093,z),.003,brass)
# Static upper lip masks a card until the independent tray slides forward.
cube(r,(0,-.115,-.175),(.48,.18,.032),walnut,.004)
for x in (-.22,.22):sphere(r,(x,-.10,-.235),(.009,.006,.009),brass)
# Empty winding-key cradle: open clips plus a visible mounting pin, no duplicate key.
for z in (-.045,.06):
 ring(r,(.355,-.105,z),.024,.024,.004,brass,start=math.pi*.15,end=math.pi*1.85,segments=24)
line(r,(.355,-.101,-.045),(.355,-.101,.06),.003,patina)
d=root('ChartDrawer',r,(0,-.09,-.25))
# Local bottom, front foil panel and side rails form a card-sized sliding tray.
cube(d,(0,-.015,-.035),(.44,.16,.018),walnut,.004)
for x in (-.208,.208):cube(d,(x,-.015,-.006),(.018,.16,.055),walnut,.003)
cube(d,(0,-.098,0),(.46,.028,.11),walnut,.005)
cube(d,(0,-.115,0),(.38,.008,.078),brass,.003)
ring(d,(0,-.122,0),.025,.025,.004,darkwood,segments=24)
socket=bpy.data.objects.new('CardRest',None);bpy.context.scene.collection.objects.link(socket);socket.parent=d;socket.location=(0,-.015,-.020);sockets.append('CardRest')

# Merge mesh children per semantic pivot; leave hierarchy intact and UV unwrap.
for r in roots.values():
 children=[o for o in r.children if o.type=='MESH']
 if not children:continue
 bpy.ops.object.select_all(action='DESELECT')
 for o in children:o.select_set(True)
 bpy.context.view_layer.objects.active=children[0];bpy.ops.object.join();o=children[0];o.name=r.name+'_Visual';bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
 bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT');bpy.ops.uv.smart_project(island_margin=.012);bpy.ops.object.mode_set(mode='OBJECT')

# Small authored UV texture maps; roughness and real tangent-space normals embedded.
size=256;yy,xx=np.mgrid[0:size,0:size].astype(np.float32);u=xx/size;v=yy/size
for idx,m in enumerate([walnut,darkwood,brass,patina,enamel,paper,moon,ember,cyan]):
 p=m.node_tree.nodes.get('Principled BSDF');base=np.array(p.inputs['Base Color'].default_value[:3],dtype=np.float32);rng=np.random.default_rng(11050+idx);grain=rng.random((size,size),dtype=np.float32)-.5
 cloud=(np.sin(u*16+v*10)+np.cos(v*19-u*11))*.5;detail=np.sin(u*52+np.sin(v*16))*np.sin(v*50+np.sin(u*12));height=.22*cloud+.10*detail
 if m in (walnut,darkwood):height+=.28*np.sin(v*102+2*np.sin(u*14))*np.sin(v*29)
 if m==brass:height+=.18*np.maximum(0,np.sin(u*86)*np.sin(v*80))**5
 color=np.clip(base[None,None,:]*(.88+.10*cloud[:,:,None]+.05*detail[:,:,None]+.05*grain[:,:,None]),0,1)
 if m==brass:
  pat=np.maximum(cloud-.48,0)[:,:,None]*.24;color=color*(1-pat)+np.array([.06,.22,.16])*pat
 dy,dx=np.gradient(height);norm=np.stack((-dx*2,-dy*2,np.ones_like(dx)),axis=2);norm/=np.linalg.norm(norm,axis=2,keepdims=True);rough=float(p.inputs['Roughness'].default_value)
 for kind,arr,space in [('base',color,'sRGB'),('roughness',np.repeat(np.clip(rough+.06*cloud[:,:,None]+.05*grain[:,:,None],.05,1),3,2),'Non-Color'),('normal',norm*.5+.5,'Non-Color')]:
  px=np.ones((size,size,4),np.float32);px[:,:,:3]=arr;im=bpy.data.images.new(m.name+' '+kind,width=size,height=size,alpha=True);im.colorspace_settings.name=space;im.pixels.foreach_set(px.ravel());im.file_format='PNG';im.filepath_raw=str(OUT/(m.name.replace(' ','-')+'-'+kind+'.png'));im.save();im.pack();tex=m.node_tree.nodes.new('ShaderNodeTexImage');tex.image=im
  if kind=='base':m.node_tree.links.new(tex.outputs['Color'],p.inputs['Base Color'])
  elif kind=='roughness':m.node_tree.links.new(tex.outputs['Color'],p.inputs['Roughness'])
  else:
   nm=m.node_tree.nodes.new('ShaderNodeNormalMap');m.node_tree.links.new(tex.outputs['Color'],nm.inputs['Color']);m.node_tree.links.new(nm.outputs['Normal'],p.inputs['Normal'])

bpy.ops.wm.save_as_mainfile(filepath=str(SRC/'calibration-kit.blend'))
bpy.ops.object.select_all(action='SELECT');bpy.ops.export_scene.gltf(filepath=str(OUT/'calibration-kit.glb'),export_format='GLB',export_yup=True,export_apply=True)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False);bpy.ops.import_scene.gltf(filepath=str(OUT/'calibration-kit.glb'))
missing=set(roots).union(sockets)-set(bpy.data.objects.keys())
if missing:raise RuntimeError('missing names '+str(missing))
if bpy.data.objects['ChartDrawer'].parent!=bpy.data.objects['ChartCabinet'] or bpy.data.objects['CardRest'].parent!=bpy.data.objects['ChartDrawer']:raise RuntimeError('incorrect drawer hierarchy')
tris=sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in bpy.context.scene.objects if o.type=='MESH')
if tris>35000:raise RuntimeError('triangle budget '+str(tris))
# Staged placement for fixed lit renders, after export.
for n in ('CalibrationFrame','OrreryInner','OrreryMiddle','OrreryOuter'):bpy.data.objects[n].location=(0,0,1.32)
bpy.data.objects['ChartCabinet'].location=(0,0,.43)
world=bpy.context.scene.world;world.color=(.19,.19,.19)
for loc,energy,col,size in [((-3,-4,4),900,(1,.72,.48),4),((3,-3,3),700,(.45,.66,1),3),((0,2,4),650,(1,.55,.28),3)]:
 bpy.ops.object.light_add(type='AREA',location=loc);o=bpy.context.object;o.data.energy=energy;o.data.color=col;o.data.size=size
bpy.ops.object.camera_add(location=(0,-5,2.2));cam=bpy.context.object;cam.data.type='ORTHO';scene=bpy.context.scene;scene.camera=cam;scene.render.engine='BLENDER_EEVEE';scene.render.resolution_x=1500;scene.render.resolution_y=1000;scene.render.resolution_percentage=85;scene.eevee.taa_render_samples=8
for name,loc,target,scale in [('review-front',(0,-5,1.4),(0,0,1.0),2.9),('review-three-quarter',(2.5,-4,2.0),(0,0,1.0),3.0),('review-orrery',(0,-4,1.32),(0,0,1.32),1.25),('review-cabinet',(1,-3,1.0),(0,0,.43),1.35)]:
 cam.location=loc;cam.rotation_euler=(Vector(target)-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=scale;scene.render.filepath=str(OUT/(name+'.png'));bpy.ops.render.render(write_still=True)
# Opened drawer review, in Blender coordinates +Z glTF is -Y.
bpy.data.objects['ChartDrawer'].location.y-=.18
scene.render.filepath=str(OUT/'review-drawer-open.png');bpy.ops.render.render(write_still=True)
shutil.copy2(OUT/'calibration-kit.glb',DEST/'calibration-kit.glb')
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
manifest={'glb_sha256':sha(DEST/'calibration-kit.glb'),'generator_sha256':sha(Path(__file__)),'source_blend_sha256':sha(SRC/'calibration-kit.blend'),'axes':'glTF +Y up, +Z front; metres','root_nodes':list(roots),'socket_nodes':sockets,'triangles':tris,'blender':bpy.app.version_string,'visual_approval':'pending independent and owner review','limitations':['No authored LOD or collider','Runtime play-distance and interaction review pending']}
(SRC/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');(OUT/'report.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest,indent=2))
