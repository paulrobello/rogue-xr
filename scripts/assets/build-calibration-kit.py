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

def turning(parent, pos, profile, material, sides=20, flutes=0):
 """Turn a closed section about its vertical axis; profile pairs are height and radius."""
 verts=[];faces=[]
 for height,rad in profile:
  for i in range(sides):
   a=math.tau*i/sides; rr=rad*(1+.034*math.cos(flutes*a)) if flutes else rad
   verts.append((pos[0]+rr*math.cos(a),pos[1]+rr*math.sin(a),pos[2]+height))
 for row in range(len(profile)-1):
  for i in range(sides):
   j=(i+1)%sides;k=row*sides
   faces.append((k+i,k+j,k+sides+j,k+sides+i))
 faces.extend([tuple(reversed(range(sides))),tuple(range(len(verts)-sides,len(verts)))])
 mesh=bpy.data.meshes.new('turned profile');mesh.from_pydata(verts,[],faces);mesh.update()
 o=bpy.data.objects.new('turned profile',mesh);bpy.context.collection.objects.link(o);attach(o,parent,material)

# A fixed stepped bed actually carries the three rotating rings. Their common +Z shaft
# runs from the slate cheek to the centre hubs, with polished bearing shoes at the tracks.
bed=root('OrreryBed')
disk(bed,(0,-.066,0),.315,.028,brass)
disk(bed,(0,-.081,0),.300,.010,enamel)
ring(bed,(0,-.088,0),.308,.308,.004,patina)
for i in range(48):
 a=math.tau*i/48;rr=.287 if i%4==0 else .296
 line(bed,(rr*math.cos(a),-.088,rr*math.sin(a)),(.302*math.cos(a),-.088,.302*math.sin(a)),.0018,brass)
for radius,front in ((.108,.0945),(.189,.117),(.270,.1395)):
 for a in (math.pi/6,5*math.pi/6,3*math.pi/2):
  px,pz=radius*math.cos(a),radius*math.sin(a)
  disk(bed,(px,-(.086+front)/2,pz),.012,front-.086,patina)
  disk(bed,(px,-front+.003,pz),.010,.004,brass)
for front,rad in ((.098,.031),(.119,.024),(.142,.016)):
 disk(bed,(0,-(.072+front)/2,0),rad,front-.072,brass)

console=root('OrreryConsole')
cube(console,(.485,-.078,0),(.355,.053,.625),darkwood,.012)
cube(console,(.485,-.108,0),(.332,.013,.600),patina,.007)
cube(console,(.485,-.118,0),(.308,.011,.573),enamel,.005)
for z in (-.096,.096): line(console,(.345,-.126,z),(.622,-.126,z),.0028,brass)
for x in (.338,.630):
 for z in (-.277,.277): disk(console,(x,-.126,z),.006,.005,brass)
for z in (-.19,0,.19):
 disk(console,(.382,-.131,z),.049,.020,brass)
 disk(console,(.382,-.145,z),.038,.013,patina)
knob=root('OrreryKnob')
disk(knob,(0,-.015,0),.031,.030,brass);disk(knob,(0,-.035,0),.027,.018,darkwood)
disk(knob,(0,-.046,0),.022,.006,brass)
line(knob,(0,-.051,.005),(0,-.051,.019),.003,enamel)
for i in range(12):
 a=math.tau*i/12;line(knob,(.030*math.cos(a),-.003,.030*math.sin(a)),(.030*math.cos(a),-.026,.030*math.sin(a)),.002,patina)

drive=root('OrreryDrive')
cube(drive,(-.525,-.082,0),(.199,.055,.52),patina,.012)
for z in (-.16,.106):
 disk(drive,(-.525,-.125,z),.070,.052,brass)
 disk(drive,(-.525,-.159,z),.052,.032,enamel)
for z in (-.12,-.045,.03,.085):
 line(drive,(-.504,-.114,z),(-.504,-.114,z+.036),.008,brass)
for x in (-.605,-.445):
 for z in (-.237,.237): disk(drive,(x,-.117,z),.008,.008,brass)
broken=root('OrrerySplitCollar')
for start,end in ((.26,1.73),(2.83,5.60)):
 ring(broken,(0,0,0),.039,.039,.009,patina,start,end,16)
for a in (.26,1.73,2.83,5.60):
 sphere(broken,(.039*math.cos(a),-.005,.039*math.sin(a)),(.007,.006,.006),brass,12)
cube(drive,(-.525,-.180,.106),(.029,.026,.029),brass,.002)
spare=root('OrreryCoupling')
ring(spare,(0,0,0),.036,.036,.011,brass,segments=36)
ring(spare,(0,-.012,0),.033,.033,.006,patina,segments=32)
for i in range(3):
 a=i*math.tau/3+math.pi/2
 cube(spare,(.041*math.cos(a),.002,.041*math.sin(a)),(.018,.029,.018),brass,.003)
 disk(spare,(.036*math.cos(a),-.013,.036*math.sin(a)),.004,.008,enamel)
cradle=root('OrreryCouplingCradle')
cube(cradle,(.025,.018,0),(.181,.07,.21),walnut,.012)
cube(cradle,(0,-.020,0),(.112,.013,.126),patina,.006)
for x in (-.034,.034):
 line(cradle,(x,-.031,-.029),(x,-.057,-.023),.005,brass)
 cube(cradle,(x,-.054,-.019),(.013,.015,.016),brass,.002)

# Suspended-pan assay balance. The pan yokes pivot independently of the moving beam.
case=root('AssayCase')
cube(case,(0,.012,-.017),(1.26,.065,.78),darkwood,.018)
cube(case,(0,-.032,-.018),(1.205,.029,.73),walnut,.012)
cube(case,(0,-.052,-.015),(1.12,.016,.65),enamel,.008)
for x in (-.583,.583):
 cube(case,(x,-.060,-.020),(.056,.042,.728),walnut,.008)
 line(case,(x,-.085,-.362),(x,-.085,.322),.004,brass)
cube(case,(0,-.205,-.402),(1.32,.49,.076),walnut,.014)
cube(case,(0,-.215,-.365),(1.30,.48,.013),brass,.004)
for x in (-.492,.492):
 line(case,(x,-.057,-.54),(x,-.356,-.425),.023,patina)
 cube(case,(x,-.056,-.479),(.094,.056,.198),walnut,.009)
assay_docks=(-.550,.360)
for x in assay_docks:
 turning(case,(x,-.352,-.359),[(0,.088),(.005,.093),(.012,.088),(.016,.074)],patina)
turning(case,(-.105,-.246,-.359),[(0,.106),(.008,.118),(.021,.117),(.028,.099),(.045,.087),(.05,.075)],brass)
turning(case,(-.105,-.246,-.309),[(0,.067),(.03,.058),(.044,.044),(.071,.041),(.10,.027),(.236,.021),(.252,.038),(.264,.038),(.27,.025),(.315,.024)],patina)
for z in (-.222,-.104,-.038): turning(case,(-.105,-.246,z),[(0,.034),(.005,.036),(.011,.032)],brass)
for s in (-1,1):
 tube(case,[(-.105+s*.055,-.246,-.288),(-.105+s*.082,-.246,-.248),(-.105+s*.055,-.246,-.193),(-.105+s*.026,-.246,-.154)],.0075,brass)
disk(case,(-.105,-.264,.012),.065,.040,brass)
ring(case,(-.105,-.284,.012),.055,.055,.004,patina)
for i in range(-3,4):
 a=math.pi/2+i*.14
 line(case,(-.105+.048*math.cos(a),-.288,.012+.048*math.sin(a)),(-.105+.056*math.cos(a),-.288,.012+.056*math.sin(a)),.0019,enamel)
for z in (-.30,.263): disk(case,(.485,-.055,z),.014,.011,brass)
cube(case,(.485,-.125,.293),(.080,.157,.048),walnut,.007)
line(case,(.485,-.058,.222),(.485,-.203,.285),.010,patina)
hanger=root('AssayHanger')
for i in range(6):
 x=.485;z=.267-i*.036
 if i%2: tube(hanger,[(x+.006*math.cos(j*math.tau/16),-.199+.016*math.cos(j*math.tau/16),z+.025*math.sin(j*math.tau/16)) for j in range(17)],.0045,brass)
 else: ring(hanger,(x,-.199,z),.016,.025,.0045,patina,segments=16)
tube(hanger,[(.485,-.199,.071),(.485,-.199,.044),(.464,-.200,.022),(.468,-.205,.000),(.485,-.212,-.010),(.505,-.214,.000),(.510,-.214,.015)],.0075,brass)
beam=root('AssayBeam')
for s in (-1,1):
 tube(beam,[(0,0,.004),(s*.054,0,.022),(s*.18,0,.034),(s*.258,0,.017),(s*.266,0,0)],.011,brass)
 tube(beam,[(s*.019,0,-.016),(s*.150,0,-.003),(s*.238,0,.01)],.0055,patina)
 disk(beam,(s*.265,-.005,0),.018,.027,brass)
disk(beam,(0,0,0),.026,.038,patina);disk(beam,(0,-.027,0),.013,.018,brass)
line(beam,(0,-.018,.01),(0,-.018,.052),.003,brass)
pan=root('AssayPan')
for i in range(3):
 a=math.tau*i/3+.17
 line(pan,(0,0,-.011),(.092*math.cos(a),.092*math.sin(a),-.171),.0034,brass)
turning(pan,(0,0,0),[(-.201,.040),(-.199,.057),(-.190,.082),(-.178,.101),(-.172,.104),(-.168,.100),(-.173,.094),(-.184,.078),(-.192,.049)],patina)
tube(pan,[(.102*math.cos(i*math.tau/48),.102*math.sin(i*math.tau/48),-.172) for i in range(49)],.0028,brass)
for name,metal,flutes in [('AssayWeightA',brass,8),('AssayWeightB',patina,10),('AssayReference',enamel,8)]:
 r=root(name)
 turning(r,(0,0,0),[(0,.044),(.004,.053),(.012,.055),(.018,.050),(.023,.047),(.07,.050),(.083,.048),(.093,.036),(.100,.023)],metal,3*flutes,flutes)
 for z,rad in ((.012,.053),(.073,.050),(.096,.027)):
  turning(r,(0,0,z),[(0,rad),(.002,rad+.002),(.006,rad+.002),(.008,rad)],brass)
 turning(r,(0,0,.103),[(0,.020),(.011,.015),(.017,.015)],patina)
 ring(r,(0,0,.140),.018,.024,.0055,brass,segments=24)

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
source_maps={}
def surface_map(name,role):
 source=ROOT/'public'/'assets'/'materials'/name/(name+'.'+role+'.png')
 source_maps[str(source.relative_to(ROOT))]=hashlib.sha256(source.read_bytes()).hexdigest()
 im=bpy.data.images.load(str(source));im.colorspace_settings.name='sRGB' if role=='basecolor' else 'Non-Color'
 im.scale(512,512);array=np.empty(512*512*4,np.float32);im.pixels.foreach_get(array);bpy.data.images.remove(im)
 return array.reshape(512,512,4)[:,:,:3].copy()
for idx,m in enumerate([walnut,darkwood,brass,patina,enamel,paper,moon,ember,cyan]):
 p=m.node_tree.nodes.get('Principled BSDF');base=np.array(p.inputs['Base Color'].default_value[:3],dtype=np.float32);rng=np.random.default_rng(11050+idx);grain=rng.random((size,size),dtype=np.float32)-.5
 cloud=(np.sin(u*16+v*10)+np.cos(v*19-u*11))*.5;detail=np.sin(u*52+np.sin(v*16))*np.sin(v*50+np.sin(u*12));height=.22*cloud+.10*detail
 if m in (walnut,darkwood):height+=.28*np.sin(v*102+2*np.sin(u*14))*np.sin(v*29)
 if m==brass:height+=.18*np.maximum(0,np.sin(u*86)*np.sin(v*80))**5
 color=np.clip(base[None,None,:]*(.88+.10*cloud[:,:,None]+.05*detail[:,:,None]+.05*grain[:,:,None]),0,1)
 if m==brass:
  pat=np.maximum(cloud-.48,0)[:,:,None]*.24;color=color*(1-pat)+np.array([.06,.22,.16])*pat
 dy,dx=np.gradient(height);norm=np.stack((-dx*2,-dy*2,np.ones_like(dx)),axis=2);norm/=np.linalg.norm(norm,axis=2,keepdims=True);rough=float(p.inputs['Roughness'].default_value)
 normal_image=norm*.5+.5;rough_image=np.repeat(np.clip(rough+.06*cloud[:,:,None]+.05*grain[:,:,None],.05,1),3,2)
 stock={walnut:'walnut',darkwood:'walnut',brass:'brass-polished',patina:'brass-aged'}.get(m)
 if stock:
  color=surface_map(stock,'basecolor')
  if m==darkwood:color*=np.array([.46,.40,.37])
  if m==patina:color*=np.array([.26,.61,.48])
  normal_image=surface_map(stock,'normal')
  rough_image=np.repeat(surface_map(stock,'orm')[:,:,1:2],3,axis=2)
 for kind,arr,space in [('base',color,'sRGB'),('roughness',rough_image,'Non-Color'),('normal',normal_image,'Non-Color')]:
  width=arr.shape[1];px=np.ones((width,width,4),np.float32);px[:,:,:3]=arr;im=bpy.data.images.new(m.name+' '+kind,width=width,height=width,alpha=True);im.colorspace_settings.name=space;im.pixels.foreach_set(px.ravel());im.file_format='PNG';im.filepath_raw=str(OUT/(m.name.replace(' ','-')+'-'+kind+'.png'));im.save();im.pack();tex=m.node_tree.nodes.new('ShaderNodeTexImage');tex.image=im
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
shutil.copy2(OUT/'calibration-kit.glb',DEST/'calibration-kit.glb')
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
manifest={'glb_sha256':sha(DEST/'calibration-kit.glb'),'generator_sha256':sha(Path(__file__)),'source_blend_sha256':sha(SRC/'calibration-kit.blend'),'axes':'glTF +Y up, +Z front; metres','root_nodes':list(roots),'socket_nodes':sockets,'triangles':tris,'blender':bpy.app.version_string,'visual_approval':'pending independent and owner review','limitations':['No authored LOD or collider','Runtime play-distance and interaction review pending']}
manifest['shared_material_sources']=source_maps
(SRC/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');(OUT/'report.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest,indent=2))

# Staged fitting uses the same centres and pivots as the runtime fixtures.
scene=bpy.context.scene
bench=bpy.data.objects['CalibrationFrame']; chart=bpy.data.objects['ChartCabinet']; assay=bpy.data.objects['AssayCase']
def fit(name,parent,location,scale=1):
 o=bpy.data.objects[name];o.parent=parent;o.location=location;o.scale=(scale,)*3;return o
fit('OrreryBed',bench,(-.105,0,0));fit('OrreryConsole',bench,(0,0,0));fit('OrreryDrive',bench,(0,0,0));fit('OrrerySplitCollar',bench,(-.525,-.183,.106))
for i,name in enumerate(('OrreryInner','OrreryMiddle','OrreryOuter')):
 arm=fit(name,bench,(-.105,0,0),.90);arm.rotation_mode='XYZ';arm.rotation_euler.y=(i-1)*math.pi/2
knob=fit('OrreryKnob',bench,(.382,-.146,.19))
for z in (0,-.19):
 copy=knob.copy();scene.collection.objects.link(copy);copy.location.z=z
 for ch in knob.children:
  c=ch.copy();scene.collection.objects.link(c);c.parent=copy
fit('OrreryCouplingCradle',chart,(-.428,-.07,-.07));fit('OrreryCoupling',chart,(-.428,-.123,-.065))
fit('AssayHanger',assay,(0,0,0));beam=fit('AssayBeam',assay,(-.105,-.289,.012));pan=fit('AssayPan',beam,(-.265,0,0))
other=pan.copy();scene.collection.objects.link(other);other.location.x=.265
for ch in pan.children:
 c=ch.copy();scene.collection.objects.link(c);c.parent=other
fit('AssayReference',other,(0,0,-.192));fit('AssayWeightA',assay,(assay_docks[0],-.352,-.343));fit('AssayWeightB',assay,(assay_docks[1],-.352,-.343))
bench.location=(0,0,1.24);assay.location=(1.62,0,1.25);chart.location=(-1.52,0,1.19)
scene.world.use_nodes=True;scene.world.node_tree.nodes.get('Background').inputs[0].default_value=(.35,.38,.43,1);scene.world.node_tree.nodes.get('Background').inputs[1].default_value=.55
for loc,energy,col,size in [((-3,-4,4),430,(1,.78,.58),4),((3,-3,3),350,(.62,.75,1),3),((0,2,4),380,(1,.70,.42),3)]:
 bpy.ops.object.light_add(type='AREA',location=loc);o=bpy.context.object;o.data.energy=energy;o.data.color=col;o.data.size=size
bpy.ops.object.camera_add();cam=bpy.context.object;cam.data.type='ORTHO';scene.camera=cam;scene.render.engine='CYCLES';scene.cycles.samples=4;scene.cycles.use_denoising=True;scene.render.resolution_x=1000;scene.render.resolution_y=720;scene.render.resolution_percentage=100
for name,loc,target,scale in [('review-front',(0,-5,1.4),(0,0,1.14),4.65),('review-three-quarter',(2.5,-5,2.4),(0,0,1.1),4.7),('review-orrery',(.55,-4,1.55),(0,0,1.24),1.80),('review-balance',(2.35,-4,1.98),(1.62,-.10,1.22),1.65),('review-cabinet',(-1,-3,1.55),(-1.56,0,1.19),1.20),('review-drawer-open',(-1,-3,1.55),(-1.56,0,1.19),1.20)]:
 if name=='review-drawer-open':bpy.data.objects['ChartDrawer'].location.y-=.18
 cam.location=loc;cam.rotation_euler=(Vector(target)-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=scale;scene.render.filepath=str(OUT/(name+'.png'));bpy.ops.render.render(write_still=True)
