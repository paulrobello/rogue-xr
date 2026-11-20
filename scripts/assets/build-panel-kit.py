"""Original Upper Works service-panel kit; Blender Z-up maps to glTF Y-up, front +Z.
Blender -b --factory-startup --python-exit-code 1 -P scripts/assets/build-panel-kit.py
"""
import bpy,math,json,hashlib,shutil
from pathlib import Path
from mathutils import Vector
import numpy as np
ROOT=Path(__file__).resolve().parents[2];SRC=ROOT/'assets-source/props/panel-kit';OUT=SRC/'staging';DEST=ROOT/'public/assets/props/panel-kit'
OUT.mkdir(parents=True,exist_ok=True);DEST.mkdir(parents=True,exist_ok=True)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)

def mat(name,c,metal=0,rough=.5):
 m=bpy.data.materials.new(name);m.use_nodes=True;m.diffuse_color=(*c,1);p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(*c,1);p.inputs['Metallic'].default_value=metal;p.inputs['Roughness'].default_value=rough;return m
# The values track BoilerBay's gray steel, dark edge, brass and copper swatches.
steel=mat('Boiler painted steel',(.148,.148,.134),.42,.54);dark=mat('Boiler dark iron',(.060,.055,.050),.48,.55)
brass=mat('Boiler aged brass',(.42,.215,.085),.66,.43);copper=mat('Boiler weathered copper',(.29,.095,.036),.66,.43)
black=mat('Recess shadow',(.022,.021,.019),.32,.72)
roots={}
def root(name,parent=None,loc=(0,0,0)):
 o=bpy.data.objects.new(name,None);bpy.context.scene.collection.objects.link(o);o.parent=parent;o.location=loc;roots[name]=o;return o

def attach(o,r,m,smooth=True):
 o.parent=r;o.data.materials.append(m)
 if o.type=='MESH':
  for f in o.data.polygons:f.use_smooth=smooth
 return o

def box(r,p,s,m,bevel=0):
 bpy.ops.mesh.primitive_cube_add(size=1,location=p);o=bpy.context.object;o.scale=s;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
 if bevel:
  mod=o.modifiers.new('Rounded steel edge','BEVEL');mod.width=bevel;mod.segments=2;bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=mod.name)
 return attach(o,r,m,False)

def line(r,a,b,radius,m):
 a,b=Vector(a),Vector(b);d=b-a;bpy.ops.mesh.primitive_cylinder_add(vertices=12,radius=radius,depth=d.length,location=(a+b)*.5);o=bpy.context.object;o.rotation_euler=d.to_track_quat('Z','Y').to_euler();return attach(o,r,m)

def disk(r,p,radius,depth,m):
 bpy.ops.mesh.primitive_cylinder_add(vertices=20,radius=radius,depth=depth,location=p,rotation=(math.pi/2,0,0));return attach(bpy.context.object,r,m)

def tube(r,pts,rad,m):
 sides=8;verts=[];faces=[]
 for i,p in enumerate(pts):
  p=Vector(p);t=(Vector(pts[min(i+1,len(pts)-1)])-Vector(pts[max(0,i-1)])).normalized();guide=Vector((0,0,1)) if abs(t.z)<.9 else Vector((0,1,0));s=t.cross(guide).normalized();n=t.cross(s).normalized()
  for j in range(sides):
   a=math.tau*j/sides;verts.append(tuple(p+rad*(s*math.cos(a)+n*math.sin(a))))
 for i in range(len(pts)-1):
  for j in range(sides):faces.append((i*sides+j,i*sides+(j+1)%sides,(i+1)*sides+(j+1)%sides,(i+1)*sides+j))
 mesh=bpy.data.meshes.new('continuous tube');mesh.from_pydata(verts,[],faces);mesh.update();o=bpy.data.objects.new('continuous tube',mesh);bpy.context.scene.collection.objects.link(o);return attach(o,r,m)

def ring(r,c,rx,rz,rad,m,start=0,end=math.tau,segments=36):
 x,y,z=c;pts=[(x+rx*math.cos(start+(end-start)*i/segments),y,z+rz*math.sin(start+(end-start)*i/segments)) for i in range(segments+1)];tube(r,pts,rad,m)

# Non-obstructing frame around, not across, the entire 1.6 x 2.4 m passage.
r=root('PanelFrame')
for x in (-.84,.84):
 box(r,(x,.01,1.21),(.08,.16,2.42),dark,.006)
 box(r,(x,-.079,1.21),(.055,.025,2.40),steel,.004)
 for z in (.18,.76,1.34,1.92,2.32):disk(r,(x,-.095,z),.010,.005,brass)
box(r,(0,.01,2.44),(1.76,.16,.08),dark,.006)
box(r,(0,-.079,2.44),(1.76,.025,.055),steel,.004)
for x in (-.65,.65):disk(r,(x,-.095,2.44),.010,.005,brass)
# Hinge origin is x=0 at leaf's left edge; a full-thickness leaf extends +X.
r=root('PanelLeaf')
# Recess is a true opening in the front/solid skin, backed by a shadow well.
# Pocket extents x=1.19..1.31, height=.975..1.125; cover the rest with four steel sections.
for p,s in [((.80,0,.4875),(1.60,.12,.975)),((.80,0,1.7625),(1.60,.12,1.275)),((.595,0,1.05),(1.19,.12,.15)),((1.455,0,1.05),(.29,.12,.15))]:box(r,p,s,steel)
# A recessed back plane closes the well on the interior side without blocking the catch.
box(r,(1.25,.045,1.05),(.12,.025,.15),black)
# Steel edge skins and seam courses match the larger boiler bay silhouette.
for x in (.018,1.582):box(r,(x,-.064,1.20),(.032,.018,2.37),dark,.003)
for z in (.035,.73,1.43,2.365):box(r,(.80,-.064,z),(1.56,.018,.024),dark,.003)
# Shallow centered stiffeners and subtle cog-stamped upper ornament.
for x in (.25,1.33):
 box(r,(x,-.069,1.82),(.04,.018,.73),steel,.012)
for x in (.075,1.525):
 for z in (.12,.67,.80,1.36,1.50,2.28):disk(r,(x,-.078,z),.010,.006,brass)
# Discreet embossed wheel mark, less contrast than hardware.
ring(r,(.80,-.071,1.80),.070,.070,.003,dark)
for i in range(8):
 a=math.tau*i/8;line(r,(.80+.062*math.cos(a),-.071,1.80+.062*math.sin(a)),(.80+.078*math.cos(a),-.071,1.80+.078*math.sin(a)),.003,dark)
# Three actual rotating hinge barrels sit at the hinge line.
for z in (.22,1.20,2.18):
 line(r,(0,0,z-.075),(0,0,z+.075),.025,brass)
 box(r,(.055,-.03,z),(.10,.055,.09),dark,.004)
# Physical inset escutcheon and pull tab, completely behind the leaf's front plane when closed.
c=root('PanelCatch',r,(1.25,-.018,1.05))
box(c,(0,0,0),(.105,.014,.135),dark,.008)
box(c,(0,-.009,0),(.075,.008,.105),black,.006)
ring(c,(0,-.017,0),.026,.039,.004,brass,segments=36)
line(c,(0,-.020,-.018),(0,-.020,.018),.004,dark)
for z in (-.05,.05):disk(c,(0,-.014,z),.004,.003,steel)

# Join per runtime control, retain pivot and UV unwrap for portable PBR maps.
for r in roots.values():
 children=[o for o in r.children if o.type=='MESH']
 if not children:continue
 bpy.ops.object.select_all(action='DESELECT')
 for o in children:o.select_set(True)
 bpy.context.view_layer.objects.active=children[0];bpy.ops.object.join();o=children[0];o.name=r.name+'_Visual';bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
 bpy.ops.object.mode_set(mode='EDIT');bpy.ops.mesh.select_all(action='SELECT');bpy.ops.uv.smart_project(island_margin=.012);bpy.ops.object.mode_set(mode='OBJECT')
 if r.name=='PanelLeaf':
  # Match all coplanar steel plates in physical coordinates, including around the pocket.
  uv=o.data.uv_layers.active.data
  for poly in o.data.polygons:
   if o.data.materials[poly.material_index] != steel or abs(poly.normal.y)<.5:continue
   for loop in poly.loop_indices:
    point=o.matrix_local @ o.data.vertices[o.data.loops[loop].vertex_index].co
    uv[loop].uv=(point.x/1.6,point.z/2.4)

# Original UV textures: brushed and cast steel with micro-peening, embedded colors/roughness/normals.
size=256;yy,xx=np.mgrid[0:size,0:size].astype(np.float32);u=xx/size;v=yy/size
for idx,m in enumerate([steel,dark,brass,copper,black]):
 p=m.node_tree.nodes.get('Principled BSDF');base=np.array(p.inputs['Base Color'].default_value[:3],np.float32);rng=np.random.default_rng(5340+idx);grain=rng.random((size,size),dtype=np.float32)-.5
 cloud=(np.sin(u*17+v*9)+np.cos(v*19-u*11))*.5;brushed=np.sin(u*90+np.sin(v*6)*1.2);cast=np.sin(u*48+np.sin(v*17))*np.sin(v*48+np.sin(u*13));height=.16*cloud+.08*brushed+.18*cast
 if m==steel:height+=.12*np.maximum(0,np.sin(u*85)*np.sin(v*80))**5
 color=np.clip(base[None,None,:]*(.91+.10*cloud[:,:,None]+.035*brushed[:,:,None]+.04*cast[:,:,None]+.04*grain[:,:,None]),0,1)
 if m in (brass,copper):
  pat=np.maximum(cloud-.55,0)[:,:,None]*.15;color=color*(1-pat)+np.array([.05,.18,.14])*pat
 dy,dx=np.gradient(height);norm=np.stack((-dx*2,-dy*2,np.ones_like(dx)),axis=2);norm/=np.linalg.norm(norm,axis=2,keepdims=True);rough=float(p.inputs['Roughness'].default_value)
 for kind,arr,space in [('base',color,'sRGB'),('roughness',np.repeat(np.clip(rough+.055*cloud[:,:,None]+.05*grain[:,:,None],.05,1),3,2),'Non-Color'),('normal',norm*.5+.5,'Non-Color')]:
  px=np.ones((size,size,4),np.float32);px[:,:,:3]=arr;im=bpy.data.images.new(m.name+' '+kind,width=size,height=size,alpha=True);im.colorspace_settings.name=space;im.pixels.foreach_set(px.ravel());im.file_format='PNG';im.filepath_raw=str(OUT/(m.name.replace(' ','-')+'-'+kind+'.png'));im.save();im.pack();tex=m.node_tree.nodes.new('ShaderNodeTexImage');tex.image=im
  if kind=='base':m.node_tree.links.new(tex.outputs['Color'],p.inputs['Base Color'])
  elif kind=='roughness':m.node_tree.links.new(tex.outputs['Color'],p.inputs['Roughness'])
  else:
   nm=m.node_tree.nodes.new('ShaderNodeNormalMap');m.node_tree.links.new(tex.outputs['Color'],nm.inputs['Color']);m.node_tree.links.new(nm.outputs['Normal'],p.inputs['Normal'])

bpy.ops.wm.save_as_mainfile(filepath=str(SRC/'panel-kit.blend'))
bpy.ops.object.select_all(action='SELECT');bpy.ops.export_scene.gltf(filepath=str(OUT/'panel-kit.glb'),export_format='GLB',export_yup=True,export_apply=True)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False);bpy.ops.import_scene.gltf(filepath=str(OUT/'panel-kit.glb'))
missing=set(roots)-set(bpy.data.objects.keys())
if missing:raise RuntimeError('missing nodes '+str(missing))
if bpy.data.objects['PanelCatch'].parent!=bpy.data.objects['PanelLeaf']:raise RuntimeError('catch parent mismatch')
tris=sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in bpy.context.scene.objects if o.type=='MESH')
if tris>20000:raise RuntimeError('triangle budget '+str(tris))
# Place hinge at the frame edge only for the staged renders.
bpy.data.objects['PanelLeaf'].location=(-.8,0,0)
world=bpy.context.scene.world;world.color=(.18,.18,.18)
for loc,energy,col,size in [((-3,-4,4),1050,(1,.72,.48),4),((3,-3,3),900,(.46,.67,1),3),((0,2,4),800,(1,.57,.30),3)]:
 bpy.ops.object.light_add(type='AREA',location=loc);o=bpy.context.object;o.data.energy=energy;o.data.color=col;o.data.size=size
bpy.ops.object.camera_add(location=(0,-5,2.2));cam=bpy.context.object;cam.data.type='ORTHO';scene=bpy.context.scene;scene.camera=cam;scene.render.engine='BLENDER_EEVEE';scene.render.resolution_x=1500;scene.render.resolution_y=1000;scene.render.resolution_percentage=85;scene.eevee.taa_render_samples=8
for name,loc,target,scale in [('review-closed',(0,-5,1.5),(0,0,1.2),4.1),('review-closed-three-quarter',(2,-4,2),(0,0,1.2),4.1)]:
 cam.location=loc;cam.rotation_euler=(Vector(target)-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=scale;scene.render.filepath=str(OUT/(name+'.png'));bpy.ops.render.render(write_still=True)
# The catch slides out, then the leaf swings around its left-side vertical hinge.
catch=bpy.data.objects['PanelCatch'];catch.location.y-=.055
cam.location=(1.2,-3,1.4);cam.rotation_euler=(Vector((.45,0,1.05))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=.6;scene.render.filepath=str(OUT/'review-catch-extended.png');bpy.ops.render.render(write_still=True)
leaf=bpy.data.objects['PanelLeaf'];leaf.rotation_mode='XYZ';leaf.rotation_euler.z=math.radians(-100)
cam.location=(0,-6,1.2);cam.rotation_euler=(Vector((0,0,1.2))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=4.2;scene.render.filepath=str(OUT/'review-open.png');bpy.ops.render.render(write_still=True)
cam.location=(3,-4,2.2);cam.rotation_euler=(Vector((0,0,1.2))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=4.5;scene.render.filepath=str(OUT/'review-open-three-quarter.png');bpy.ops.render.render(write_still=True)
shutil.copy2(OUT/'panel-kit.glb',DEST/'panel-kit.glb')
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
manifest={'glb_sha256':sha(DEST/'panel-kit.glb'),'generator_sha256':sha(Path(__file__)),'source_blend_sha256':sha(SRC/'panel-kit.blend'),'axes':'glTF +Y up, +Z front; metres','root_nodes':list(roots),'triangles':tris,'blender':bpy.app.version_string,'visual_approval':'pending independent and owner review','limitations':['No authored LOD or collision meshes','Runtime play-distance, motion and interaction review pending']}
(SRC/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');(OUT/'report.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest,indent=2))
