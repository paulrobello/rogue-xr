"""Build the unrigged Lantern Bailiff base-model review candidate in Blender."""
import bpy, math, os, json
from mathutils import Vector
from math import pi, sin, cos
OUT=os.environ['BAILIFF_OUT']
os.makedirs(OUT,exist_ok=True)
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
def mat(name,c,metal=.0,rough=.5,emission=0):
 m=bpy.data.materials.new(name); m.diffuse_color=(*c,1); m.use_nodes=True; p=m.node_tree.nodes.get('Principled BSDF'); p.inputs['Base Color'].default_value=(*c,1); p.inputs['Metallic'].default_value=metal; p.inputs['Roughness'].default_value=rough
 if emission: p.inputs['Emission Color'].default_value=(*c,1); p.inputs['Emission Strength'].default_value=emission
 return m
iron=mat('dark-iron',(.08,.065,.055),.75,.48); steel=mat('armor-steel',(.22,.18,.15),.8,.45); brass=mat('aged-brass',(.49,.27,.08),.75,.36); amber=mat('amber-core',(1,.23,.015),.1,.26,1.4)
def finish(o,n,m):
 o.name=n; o.data.materials.append(m)
 for p in o.data.polygons: p.use_smooth=True
 return o
def sphere(n,loc,scale,m,seg=20,rings=12):
 bpy.ops.mesh.primitive_uv_sphere_add(segments=seg,ring_count=rings,location=loc); o=bpy.context.object; o.scale=scale; bpy.ops.object.transform_apply(location=False,rotation=False,scale=True); return finish(o,n,m)
def bar(n,a,b,r1,r2,m,verts=12):
 a,b=Vector(a),Vector(b); d=b-a; bpy.ops.mesh.primitive_cone_add(vertices=verts,radius1=r1,radius2=r2,depth=d.length,location=(a+b)/2); o=bpy.context.object; o.rotation_euler=d.to_track_quat('Z','Y').to_euler(); finish(o,n,m); bevel=o.modifiers.new('edge rounding','BEVEL'); bevel.width=.005; bevel.segments=2; o.modifiers.new('weighted normals','WEIGHTED_NORMAL'); return o
def ring(n,loc,major,minor,m,rot=(0,0,0)):
 bpy.ops.mesh.primitive_torus_add(major_segments=24,minor_segments=8,location=loc,major_radius=major,minor_radius=minor,rotation=rot); return finish(bpy.context.object,n,m)
def box(n,loc,scale,m,bevel=.025):
 bpy.ops.mesh.primitive_cube_add(size=1,location=loc); o=bpy.context.object; o.dimensions=scale; bpy.ops.object.transform_apply(location=False,rotation=False,scale=True); finish(o,n,m); mod=o.modifiers.new('rounded armor edges','BEVEL'); mod.width=bevel; mod.segments=2; o.modifiers.new('weighted normals','WEIGHTED_NORMAL'); return o
def plate(n,outline,y,depth,m,parent):
 # A crowned plate with an angular edge and raised center.
 cx=sum(x for x,z in outline)/len(outline); cz=sum(z for x,z in outline)/len(outline)
 vs=[(x,y,z) for x,z in outline]+[(cx,y+.012,cz)]+[(x,y-depth,z) for x,z in outline]
 count=len(outline); fs=[(i,(i+1)%count,count) for i in range(count)]
 fs += [(i,i+count+1,(i+1)%count+count+1,(i+1)%count) for i in range(count)]
 fs.append(tuple(range(count+1,count*2+1)))
 mesh=bpy.data.meshes.new(n+'-mesh'); mesh.from_pydata(vs,[],fs); mesh.update(); o=bpy.data.objects.new(n,mesh); bpy.context.collection.objects.link(o); finish(o,n,m)
 mod=o.modifiers.new('plate edge','BEVEL'); mod.width=.004; mod.segments=2; o.modifiers.new('weighted normals','WEIGHTED_NORMAL'); return attach(o,parent)
def root(n,loc):
 o=bpy.data.objects.new(n,None); bpy.context.collection.objects.link(o); o.location=loc; bpy.context.view_layer.update(); return o
def attach(o,parent):
 bpy.context.view_layer.update(); matrix=o.matrix_world.copy(); o.parent=parent; o.matrix_world=matrix; bpy.context.view_layer.update(); return o
# Structural masses, a narrow waist, and brass belt.
hip=root('hip-root',(0,0,.81)); attach(sphere('hip-pelvis',(0,0,.79),(.19,.115,.12),iron),hip)
attach(ring('hip-belt',(0,0,.84),.16,.025,brass),hip)
attach(sphere('hip-front-buckle',(0,.119,.84),(.065,.025,.065),brass),hip)
attach(box('hip-front-apron',(0,.125,.70),(.15,.035,.20),steel,.018),hip)
for side in (-1,1):
 s='left' if side<0 else 'right'; leg=root('leg-'+s+'-root',(side*.12,0,.75)); attach(leg,hip)
 attach(sphere('leg-'+s+'-hip',(side*.125,0,.74),(.075,.075,.075),iron),leg)
 attach(bar('leg-'+s+'-thigh',(side*.13,0,.72),(side*.16,0,.49),.078,.062,steel),leg)
 plate('leg-'+s+'-thigh-front',[(side*.15-.058,.69),(side*.15+.058,.69),(side*.15+.052,.56),(side*.15,.52),(side*.15-.052,.56)],.085,.035,brass,leg)
 plate('leg-'+s+'-thigh-inset',[(side*.15-.047,.68),(side*.15+.047,.68),(side*.15+.042,.57),(side*.15,.54),(side*.15-.042,.57)],.097,.008,steel,leg)
 attach(sphere('leg-'+s+'-knee',(side*.16,0,.46),(.07,.07,.07),iron),leg)
 attach(bar('leg-'+s+'-knee-pin',(side*.216,0,.46),(side*.222,0,.46),.038,.038,brass,20),leg)
 attach(bar('leg-'+s+'-shin',(side*.16,0,.42),(side*.17,0,.12),.065,.045,steel),leg)
 plate('leg-'+s+'-shin-guard',[(side*.17-.057,.39),(side*.17+.057,.39),(side*.17+.044,.18),(side*.17,.14),(side*.17-.044,.18)],.083,.038,brass,leg)
 plate('leg-'+s+'-shin-inset',[(side*.17-.044,.38),(side*.17+.044,.38),(side*.17+.034,.19),(side*.17,.16),(side*.17-.034,.19)],.095,.008,steel,leg)
 attach(sphere('leg-'+s+'-ankle',(side*.17,0,.105),(.053,.06,.05),iron),leg)
 attach(box('leg-'+s+'-foot',(side*.17,.045,.045),(.13,.24,.09),steel,.015),leg)
 attach(box('leg-'+s+'-toe',(side*.17,.13,.094),(.121,.073,.026),brass,.012),leg)
 for z in (.31,.22):
  attach(sphere('leg-'+s+'-shin-rivet-'+str(z),(side*.17,.111,z),(.009,.006,.009),iron,10,6),leg)
# Mechanical trunk with contained core behind a curved cage.
trunk=root('torso-root',(0,0,1.10)); sphere('torso-frame',(0,0,1.13),(.23,.125,.24),iron)
sphere('torso-lantern-core',(0,.115,1.15),(.15,.085,.17),amber)
for z,r in [(1.00,.155),(1.08,.17),(1.23,.17),(1.31,.155)]: ring('torso-cage-band-%s'%z,(0,.075,z),r,.014,brass)
for i in range(9):
 t=2*pi*i/9; x=.17*cos(t); y=.075+.14*sin(t)
 bar('torso-cage-rib-%02d'%i,(x*.88,y,1.00),(x,y,1.30),.009,.009,brass,8)
# Upper breast collar, shoulder shells and rivets.
bar('neck-column',(0,0,1.34),(0,0,1.48),.055,.052,iron)
for z in (1.36,1.40,1.44): ring('neck-collar-'+str(z),(0,0,z),.057,.008,brass)
sphere('head-helmet',(0,0,1.56),(.105,.09,.13),steel)
# Tapered faceted visor: upper brow, cheek and pointed chin.
verts=[(-.074,.076,1.615),(.074,.076,1.615),(.082,.09,1.56),(.055,.09,1.49),(0,.093,1.465),(-.055,.09,1.49),(-.065,.045,1.615),(.065,.045,1.615),(.070,.045,1.56),(.045,.045,1.49),(0,.045,1.465),(-.045,.045,1.49)]
faces=[(0,1,2,3,4,5),(6,11,10,9,8,7)]+[(i,(i+1)%6,(i+1)%6+6,i+6) for i in range(6)]
verts=[(x,y+.025,z) for x,y,z in verts]
mesh=bpy.data.meshes.new('visor-mesh'); mesh.from_pydata(verts,[],faces); mesh.update(); visor=bpy.data.objects.new('head-angular-visor',mesh); bpy.context.collection.objects.link(visor); finish(visor,'head-angular-visor',brass); mod=visor.modifiers.new('visor edge','BEVEL'); mod.width=.006; mod.segments=2; visor.modifiers.new('weighted normals','WEIGHTED_NORMAL')
for side in (-1,1):
 sphere('eye-'+str(side),(side*.039,.122,1.575),(.017,.014,.017),amber,16,8)
 bar('head-ear-'+str(side),(side*.09,0,1.56),(side*.118,0,1.56),.04,.04,brass,20)
# Large independently articulated shoulder, off arm and chain arm.
for side in (-1,1):
 s='left' if side<0 else 'right'; shoulder=(side*.245,0,1.29); elbow=(side*.32,.025,1.04)
 arm=root('arm-'+s+'-root',shoulder)
 attach(sphere('arm-'+s+'-shoulder-joint',shoulder,(.09,.09,.09),iron),arm)
 attach(sphere('arm-'+s+'-pauldron',(side*.265,0,1.32),(.15,.115,.105),steel),arm)
 plate('arm-'+s+'-pauldron-rim',[(side*.265-.11,1.33),(side*.265-.09,1.39),(side*.265,1.415),(side*.265+.09,1.39),(side*.265+.11,1.33),(side*.265+.075,1.30),(side*.265-.075,1.30)],.11,.018,brass,arm)
 plate('arm-'+s+'-pauldron-overlay',[(side*.265-.095,1.34),(side*.265-.075,1.38),(side*.265,1.40),(side*.265+.075,1.38),(side*.265+.095,1.34),(side*.265+.065,1.315),(side*.265-.065,1.315)],.122,.008,steel,arm)
 attach(ring('arm-'+s+'-shoulder-trim',(side*.265,0,1.32),.115,.013,brass,(pi/2,0,0)),arm)
 attach(bar('arm-'+s+'-upper',shoulder,elbow,.068,.054,iron),arm)
 attach(sphere('arm-'+s+'-elbow',elbow,(.058,.058,.058),iron),arm)
 attach(bar('arm-'+s+'-elbow-pin',(side*.373,.025,1.04),(side*.38,.025,1.04),.035,.035,brass,20),arm)
 wrist=(side*.34,.04,.82) if side>0 else (-.46,.16,1.02)
 attach(bar('arm-'+s+'-forearm',elbow,wrist,.058,.045,brass),arm)
 if side>0:
  attach(sphere('arm-'+s+'-hand',wrist,(.052,.046,.05),iron),arm)
  for k in range(3):
   a=(wrist[0]+(k-1)*.023,wrist[1]+.026,wrist[2]-.01); b=(a[0],a[1]+.012,a[2]-.06); attach(bar('arm-'+s+'-finger-'+str(k),a,b,.010,.008,brass,8),arm)
 else:
  # Palm, transverse handle, curled finger segments and opposing thumb.
  attach(sphere('arm-left-palm',wrist,(.052,.045,.042),iron),arm)
  attach(bar('grip-handle',(-.46,.115,.975),(-.46,.205,.975),.013,.013,brass),arm)
  for k in range(4):
   y=.13+k*.02
   attach(bar('arm-left-finger-top-'+str(k),(-.495,y,1.015),(-.504,y,.985),.010,.010,steel,8),arm)
   attach(bar('arm-left-finger-curl-'+str(k),(-.504,y,.985),(-.476,y,.966),.010,.009,steel,8),arm)
  attach(bar('arm-left-thumb',(-.42,.13,1.02),(-.448,.13,.973),.014,.010,steel,8),arm)
 for i in range(5):
  t=pi*(.15+.7*i/4); attach(sphere('arm-'+s+'-rivet-'+str(i),(side*.265+.075*cos(t),.14,1.32+.052*sin(t)),(.012,.008,.012),brass,12,6),arm)
# Links alternate vertical planes, interlock along the vertical chain and meet a solid eyelet.
chain=root('chain-root',(-.46,.17,.96))
for i in range(5):
 z=.95-i*.039
 attach(ring('chain-link-%02d'%i,(-.46,.17,z),.025,.007,brass,(pi/2,0,0) if i%2==0 else (pi/2,0,pi/2)),chain)
lan=root('outer-lantern-root',(-.46,.17,.65)); attach(lan,chain)
attach(ring('outer-lantern-eyelet',(-.46,.17,.755),.023,.009,brass,(pi/2,0,pi/2)),lan)
attach(bar('outer-lantern-eyelet-seat',(-.46,.17,.728),(-.46,.17,.742),.018,.018,brass),lan)
attach(sphere('outer-lantern-core',(-.46,.17,.63),(.072,.072,.09),amber),lan)
for z,r in [(.54,.052),(.56,.073),(.69,.073),(.72,.045)]: attach(ring('outer-lantern-band-'+str(z),(-.46,.17,z),r,.011,brass),lan)
for i in range(8):
 t=2*pi*i/8; x=-.46+.068*cos(t); y=.17+.068*sin(t); attach(bar('outer-lantern-cage-%02d'%i,(x,y,.56),(x,y,.69),.007,.007,brass,8),lan)
attach(sphere('outer-lantern-finial',(-.46,.17,.52),(.025,.025,.03),brass),lan)
for name,loc,parent in [('socket-hit',(0,.17,1.24),trunk),('socket-eye',(0,.10,1.57),trunk),('socket-weapon',(-.46,.17,.63),lan)]:
 o=root(name,loc)
 if parent: attach(o,parent)
# Keep armor group pivots neutral and positioned at their owning joints.
for side in ('left','right'):
 sign=-1 if side=='left' else 1
 arm=bpy.data.objects['arm-'+side+'-root']; leg=bpy.data.objects['leg-'+side+'-root']
 shoulder_plates=root('plate-'+side+'-shoulder-root',(sign*.265,0,1.32)); attach(shoulder_plates,arm)
 leg_plates=root('plate-'+side+'-leg-root',(sign*.16,0,.46)); attach(leg_plates,leg)
 for obj in list(bpy.context.scene.objects):
  if obj.name.startswith(('arm-'+side+'-pauldron','arm-'+side+'-rivet')): attach(obj,shoulder_plates)
  if obj.name.startswith(('leg-'+side+'-thigh-front','leg-'+side+'-thigh-inset','leg-'+side+'-shin-guard','leg-'+side+'-shin-inset','leg-'+side+'-shin-rivet')): attach(obj,leg_plates)
attach(chain,bpy.data.objects['arm-left-root'])
for obj in list(bpy.context.scene.objects):
 if obj.name.startswith(('torso-frame','torso-lantern','torso-cage','neck-','head-','eye-')) and obj.parent is None: attach(obj,trunk)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT,'lantern-bailiff-base.blend'))
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT,'lantern-bailiff-base.glb'),export_format='GLB',export_animations=False)
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=os.path.join(OUT,'lantern-bailiff-base.glb'))
meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']; points=[o.matrix_world@Vector(c) for o in meshes for c in o.bound_box]
mins=[min(p[i] for p in points) for i in range(3)]; maxs=[max(p[i] for p in points) for i in range(3)]; triangles=sum(len(o.data.loop_triangles) for o in meshes for _ in [o.data.calc_loop_triangles()])
bpy.context.view_layer.update()
sockets={n:list(bpy.data.objects[n].matrix_world.translation) for n in ('socket-hit','socket-eye','socket-weapon')}
assert abs(sockets['socket-hit'][2]-1.24)<.01 and sockets['socket-hit'][1]>.1
assert abs(sockets['socket-weapon'][0]+.46)<.01 and sockets['socket-weapon'][1]>.1 and abs(sockets['socket-weapon'][2]-.63)<.01
feet={o.name:min((o.matrix_world@v.co).z for v in o.data.vertices) for o in meshes if o.name in ('leg-left-foot','leg-right-foot')}
report={'stage':'unrigged base model draft; concept and model owner review pending; no animation or runtime approval','bounds_blender_m':{'min':mins,'max':maxs},'sole_z_m':feet,'sockets_blender_m':sockets,'triangle_count':triangles,'mesh_count':len(meshes),'materials':sorted({m.name for o in meshes for m in o.data.materials if m}),'objects':sorted(o.name for o in bpy.context.scene.objects),'prior_candidate':{'glb_sha256':'1edaeb64252e8304a29b088f7e53d75104f6214af64335f6e170743c05a6a01d','independent_grade':60,'status':'rejected; archived privately','defects':'floating crossed hand, coplanar chain links, sockets at origin, armor and toe contact'},'camera_note':'Fixed seated three-quarter and side views plus raised view; animation arc clearance remains unverified.'}
with open(os.path.join(OUT,'reimport-report.json'),'w') as f: json.dump(report,f,indent=2)
assert 1.6 <= maxs[2]-mins[2] <= 1.75 and triangles <= 25000 and len(report['materials']) <= 4 and len(feet)==2 and all(abs(z)<.001 for z in feet.values())
world=bpy.context.scene.world; world.color=(.14,.14,.14)
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.002)); bpy.context.object.data.materials.append(mat('review-floor',(.095,.083,.072),0,.9))
def light(name,loc,power,size):
 d=bpy.data.lights.new(name,'AREA'); d.energy=power; d.shape='DISK'; d.size=size; o=bpy.data.objects.new(name,d); bpy.context.collection.objects.link(o); o.location=loc; o.rotation_euler=(Vector((0,0,.9))-o.location).to_track_quat('-Z','Y').to_euler()
light('key',(2,3,3),180,2.5); light('fill',(-2,1,2),110,2); light('rim',(0,-2,2.5),130,1.5)
scene=bpy.context.scene; scene.render.engine='BLENDER_EEVEE'; scene.render.resolution_x=1000; scene.render.resolution_y=1000; scene.render.resolution_percentage=100; scene.view_settings.view_transform='AgX'
camdata=bpy.data.cameras.new('review-camera'); camera=bpy.data.objects.new('review-camera',camdata); bpy.context.collection.objects.link(camera); scene.camera=camera; camdata.type='ORTHO'; camdata.ortho_scale=2.1
for name,loc in [('three-quarter',(2,3,1.30)),('side',(3,0,1.05)),('raised',(2,3,3.2))]:
 camera.location=loc; camera.rotation_euler=(Vector((0,0,.85))-camera.location).to_track_quat('-Z','Y').to_euler(); scene.render.filepath=os.path.join(OUT,'review-'+name+'.png'); bpy.ops.render.render(write_still=True)
