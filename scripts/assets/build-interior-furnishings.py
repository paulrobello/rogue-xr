"""Build a reusable low-poly manor furnishing kit. Run with Blender in background."""
import bpy, math, json, os, sys, hashlib
from mathutils import Vector
from pathlib import Path

OUT = Path(os.environ.get('KIT_OUT', '.')).resolve()
SRC = OUT / 'assets-source/props/interior-furnishings'
PUB = OUT / 'public/assets/props/interior-furnishings'
SRC.mkdir(parents=True, exist_ok=True); PUB.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
for data in bpy.data.materials: bpy.data.materials.remove(data)

def material(name, color, metal=0, rough=.6):
    m=bpy.data.materials.new(name); m.diffuse_color=(*color,1); m.use_nodes=True
    p=m.node_tree.nodes.get('Principled BSDF'); p.inputs['Base Color'].default_value=(*color,1); p.inputs['Metallic'].default_value=metal; p.inputs['Roughness'].default_value=rough
    return m
wood=material('Walnut',(.16,.065,.03),0,.52); wood2=material('WalnutHighlight',(.29,.13,.055),0,.49)
brass=material('AntiqueBrass',(.55,.31,.075),.75,.33); iron=material('BlackIron',(.055,.064,.071),.8,.4)
velvet=material('DeepBurgundyVelvet',(.21,.018,.035),0,.93); cloth=material('AgedCanvas',(.65,.53,.36),0,.95)
paper=material('AgedPaper',(.68,.56,.36),0,.92); leather=material('OxbloodLeather',(.22,.035,.022),0,.7)
enamel=material('MidnightEnamel',(.035,.075,.085),.38,.35); ivory=material('ClockIvory',(.72,.64,.48),0,.7)
bindings=material('LibraryBindingAtlas',(1,1,1),0,.72)
MATS=[wood,wood2,brass,iron,velvet,cloth,paper,leather,enamel,ivory,bindings]

def empty(name, parent=None, loc=(0,0,0)):
    o=bpy.data.objects.new(name,None); bpy.context.collection.objects.link(o); o.parent=parent; o.location=loc; return o

def cube(parent,name,loc,scale,mat,bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1,location=(0,0,0)); o=bpy.context.object; o.name=name; o.parent=parent; o.location=loc; o.dimensions=scale
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    if bevel:
        m=o.modifiers.new('Edge highlights','BEVEL'); m.width=bevel; m.segments=1
        bpy.context.view_layer.objects.active=o; bpy.ops.object.modifier_apply(modifier=m.name)
    o.data.materials.append(mat); return o

def book_uv(ob, col, row, horizontal, vertical):
    # Blender V is bottom-up; glTF export flips it to the atlas's top-origin rows.
    uv=ob.data.uv_layers.active or ob.data.uv_layers.new(name='UVMap')
    coords=[v.co for v in ob.data.vertices]
    lo=[min(v[i] for v in coords) for i in range(3)]
    hi=[max(v[i] for v in coords) for i in range(3)]
    for loop in ob.data.loops:
        p=coords[loop.vertex_index]
        u=(p[horizontal]-lo[horizontal])/(hi[horizontal]-lo[horizontal])
        v=(hi[vertical]-p[vertical])/(hi[vertical]-lo[vertical])
        uv.data[loop.index].uv=((col+.025+.95*u)/8,1-(row+.025+.95*v)/4)
    return ob

def cyl(parent,name,loc,r,depth,mat,axis='Z',verts=12,r2=None):
    bpy.ops.mesh.primitive_cone_add(vertices=verts,radius1=r,radius2=r if r2 is None else r2,depth=depth,location=(0,0,0))
    o=bpy.context.object; o.name=name; o.parent=parent; o.location=loc
    if axis=='Y': o.rotation_euler[0]=math.pi/2
    if axis=='X': o.rotation_euler[1]=math.pi/2
    o.data.materials.append(mat); return o

def bar(parent,name,a,b,r,mat,verts=8):
    a,b=Vector(a),Vector(b); d=b-a; o=cyl(parent,name,(a+b)/2,r,d.length,mat,verts=verts); o.rotation_euler=d.to_track_quat('Z','Y').to_euler(); return o

def torus(parent,name,loc,major,minor,mat,axis='Z'):
    bpy.ops.mesh.primitive_torus_add(major_segments=20,minor_segments=6,location=(0,0,0),major_radius=major,minor_radius=minor)
    o=bpy.context.object; o.name=name; o.parent=parent; o.location=loc
    if axis=='Y': o.rotation_euler[0]=math.pi/2
    o.data.materials.append(mat); return o

def oval(parent,name,loc,size,mat):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16,ring_count=8,location=(0,0,0))
    o=bpy.context.object; o.name=name; o.parent=parent; o.location=loc; o.scale=size
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    o.data.materials.append(mat); return o

def panel(parent,x,z,w,h):
    cube(parent,'Inset panel',(x,-.077,z),(w,.028,h),wood2,.018)
    cube(parent,'Recess',(x,-.096,z),(w-.075,.015,h-.075),wood,.012)

def door_leaf(parent,name,hinge,w,h=2.15):
    leaf=empty(name,parent,hinge); sign=1 if hinge[0]<0 else -1
    cube(leaf,'Door leaf',(sign*w/2,0,h/2),(w,.115,h),wood,.025)
    for z,hh in [(.57,.78),(1.59,.78)]: panel(leaf,sign*w/2,z,w-.16,hh)
    cyl(leaf,'Knob',(sign*(w-.12),-.115,1.02),.045,.055,brass,'Y'); cyl(leaf,'Escutcheon',(sign*(w-.12),-.089,1.02),.065,.016,brass,'Y')
    return leaf

def door_frame(root,w=1.6,h=2.4):
    for x in (-w/2+.06,w/2-.06):
        cube(root,'Jamb',(x,0,h/2),(.12,.24,h),wood2,.014)
        cube(root,'Jamb trim',(x,-.14,h/2),(.16,.045,h),wood,.01)
    cube(root,'Lintel',(0,0,h-.07),(w,.24,.14),wood2,.012)
    cube(root,'Crown',(0,-.135,h-.04),(w+.10,.07,.10),brass,.012)

single=empty('DoorSingle'); door_frame(single); door_leaf(single,'DoorSingle_Leaf',(-.68,0,0),1.36,2.22)
double=empty('DoorDouble'); door_frame(double); door_leaf(double,'DoorDouble_LeftLeaf',(-.68,0,0),.675,2.22); door_leaf(double,'DoorDouble_RightLeaf',(.68,0,0),.675,2.22)
arch=empty('DoorArched');
for x in (-.75,.75): cube(arch,'Stone jamb',(x,0,.84),(.1,.23,1.68),wood2,.012)
# segmented semicircle surrounds a fitted arched leaf silhouette
for i in range(14):
    t1=math.pi*i/14; t2=math.pi*(i+1)/14
    bar(arch,'Arch trim',(.73*math.cos(t1),0,1.65+.70*math.sin(t1)),(.73*math.cos(t2),0,1.65+.70*math.sin(t2)),.05,wood2)
leaf=empty('DoorArched_Leaf',arch,(-.69,0,0)); cube(leaf,'Arched lower leaf',(.69,0,.82),(1.38,.11,1.64),wood,.012)
# fan shaped upper arch mesh
verts=[(.69,-.055,1.62),(.69,.055,1.62)]
for y in (-.055,.055):
    for i in range(15):
        t=math.pi*i/14; verts.append((.69+.69*math.cos(t),y,1.62+.65*math.sin(t)))
faces=[]
for i in range(14): faces.extend([(0,2+i,3+i),(1,17+i+1,17+i),(2+i,17+i,18+i,3+i)])
mesh=bpy.data.meshes.new('Arch fan'); mesh.from_pydata(verts,[],faces); mesh.update(); o=bpy.data.objects.new('Arched upper leaf',mesh); bpy.context.collection.objects.link(o); o.parent=leaf; o.data.materials.append(wood)
for z in (.5,1.2): panel(leaf,.69,z,1.1,.52)
cyl(leaf,'Knob',(1.25,-.11,1.02),.045,.05,brass,'Y')

curtain=empty('Curtain'); cyl(curtain,'Curtain rod',(0,0,2.35),.03,1.9,brass,'X')
for s in (-1,1):
    cyl(curtain,'Finial',(s*.99,0,2.35),.065,.11,brass,'X')
    bar(curtain,'Rod wall bracket',(s*.91,0,2.35),(s*.91,.14,2.35),.018,brass)
    cyl(curtain,'Wall mounting plate',(s*.91,.15,2.35),.055,.025,brass,'Y')
    for x in (.18,.34,.50,.66,.82):
        loop=torus(curtain,'Curtain ring',(s*x,0,2.35),.043,.008,brass)
        loop.rotation_euler[1]=math.pi/2
        bar(curtain,'Curtain tab',(s*x,-.025,2.32),(s*x,-.035,2.275),.009,velvet)
    # One continuous folded surface narrows at the tie and opens at the hem.
    rows=[(.18,.17,.88),(.40,.19,.88),(.62,.25,.88),(.82,.40,.88),(.99,.52,.88),(1.16,.40,.88),(1.40,.28,.88),(1.72,.19,.88),(2.00,.15,.88),(2.28,.13,.88)]
    verts=[]
    for z,inner,outer in rows:
        for i in range(17):
            t=i/16
            verts.append((s*(inner+(outer-inner)*t),-.035-.035*math.cos(t*math.tau*4),z))
    faces=[]
    for row in range(len(rows)-1):
        for i in range(16):
            a=row*17+i; faces.append((a,a+1,a+18,a+17) if s>0 else (a+17,a+18,a+1,a))
    mesh=bpy.data.meshes.new('Curtain folds'); mesh.from_pydata(verts,[],faces); mesh.update()
    o=bpy.data.objects.new('Pleated velvet',mesh); bpy.context.collection.objects.link(o); o.parent=curtain; o.data.materials.append(velvet)
    solid=o.modifiers.new('Cloth thickness','SOLIDIFY'); solid.thickness=.008
    bar(curtain,'Tie braid',(s*.50,-.09,.99),(s*.89,-.09,1.02),.016,brass)
    cyl(curtain,'Tie clasp',(s*.70,-.10,1.005),.035,.02,brass,'Y')

chair=empty('DiningChair')
for x in (-.23,.23):
    for y in (-.20,.20):
        bar(chair,'Tapered leg',(x,y,.002),(x*.9,y*.9,.49),.035,wood)
    bar(chair,'Back upright',(x,.19,.42),(x,.21,1.05),.035,wood2)
cube(chair,'Carved seat', (0,0,.48),(.56,.50,.10),wood2,.035); cube(chair,'Velvet cushion',(0,-.015,.55),(.46,.40,.075),velvet,.045)
cube(chair,'Crest rail',(0,.21,1.04),(.55,.07,.10),wood2,.025)
cube(chair,'Back velvet',(0,.20,.81),(.40,.055,.37),velvet,.035)
for x in (-.12,0,.12): cyl(chair,'Back button',(x,.16,.81),.014,.012,brass,'Y',8)
for x in (-.23,.23):
    for y in (-.20,.20):
        cyl(chair,'Leg collar',(x*.94,y*.94,.16),.039,.035,wood2,verts=10)
        cyl(chair,'Brass foot',(x,y,.023),.038,.045,brass,verts=10)
for x in (-.17,.17): bar(chair,'Back carving',(x,.155,.65),(x,.155,.97),.009,brass)
for x in (-.19,0,.19): cyl(chair,'Seat tack',(x,-.235,.53),.009,.008,brass,'Y',8)
bar(chair,'Seat front moulding',(-.24,-.241,.48),(.24,-.241,.48),.009,brass)

table=empty('DiningTable'); cube(table,'Tabletop',(0,0,.79),(1.75,.88,.10),wood2,.04)
cube(table,'Apron',(0,0,.68),(1.57,.70,.18),wood,.022)
for x in (-.70,.70):
    for y in (-.30,.30):
        cyl(table,'Turned foot',(x,y,.09),.055,.18,wood,verts=10,r2=.04)
        cyl(table,'Turned leg',(x,y,.43),.045,.55,wood2,verts=10,r2=.07)
        torus(table,'Leg collar',(x,y,.64),.055,.009,brass)
for x in (-.75,.75): cube(table,'Top end trim',(x,0,.848),(.018,.78,.007),brass)
for y in (-.35,.35):
    cube(table,'Apron moulding',(0,y,.67),(1.42,.018,.025),wood2,.007)
    for x in (-.50,0,.50): cyl(table,'Apron pin',(x,y*1.035,.67),.013,.012,brass,'Y',8)
for x in (-.70,.70):
    for y in (-.30,.30):
        torus(table,'Foot band',(x,y,.10),.05,.008,brass)
        cyl(table,'Leg turning',(x,y,.46),.066,.09,wood,verts=10,r2=.05)

book=empty('Bookcase')
cube(book,'Cabinet plinth',(0,0,.055),(1.50,.42,.11),wood,.015)
for x in (-.70,.70): cube(book,'Cabinet side',(x,0,1.10),(.10,.36,2.2),wood,.015)
for z in (.06,.57,1.08,1.59,2.14): cube(book,'Shelf',(0,0,z),(1.45,.38,.09),wood2,.015)
cube(book,'Back',(0,.17,1.10),(1.34,.035,2.05),wood)
cube(book,'Crown',(0,0,2.24),(1.56,.46,.12),wood2,.025)
cube(book,'Lower compartment',(0,.14,.32),(1.28,.025,.40),iron)
for shelf in range(1,4):
    for j in range(10):
        if shelf==2 and j==4: continue
        x=-.60+j*.13; h=.27+.025*((j*7+shelf)%5); z=.12+shelf*.51+h/2
        col=(j+3*shelf)%8; row=(j+shelf)%2
        book_uv(cube(book,'Book pages',(x,-.035,z),(.082,.17,h-.025),bindings,.003),col,3,0,1)
        for dx in (-.047,.047): book_uv(cube(book,'Book cover',(x+dx,-.035,z),(.009,.20,h),bindings,.002),col,2,1,2)
        book_uv(cube(book,'Book spine',(x,-.135,z),(.103,.02,h),bindings,.004),col,row,0,2)
        for dz in (-.25,.25): cube(book,'Gilt spine',(x,-.147,z+h*dz),(.091,.006,.009),brass)
        for dy in (-.09,-.04,.01): cube(book,'Page edge',(x,dy,z+h/2-.009),(.074,.003,.003),ivory)
slider=empty('Bookcase_Slider',book,(0,-.23,0)); cube(slider,'Sliding panel',(0,0,.30),(1.28,.045,.36),wood2,.02); cube(slider,'Slider inset',(0,-.03,.30),(1.1,.02,.22),wood,.015)
pull=empty('Bookcase_PullBook',book,(-.08,-.05,1.31)); book_uv(cube(pull,'Book pages',(0,.015,0),(.082,.17,.275),bindings,.003),0,3,0,1)
for dx in (-.047,.047): book_uv(cube(pull,'Red cover',(dx,.015,0),(.009,.20,.30),bindings,.002),0,2,1,2)
book_uv(cube(pull,'Red spine',(0,-.085,0),(.103,.02,.30),bindings,.004),0,0,0,2)
for z in (-.10,.1): cube(pull,'Gilt line',(0,-.097,z),(.09,.006,.01),brass)
for x in (-.018,.018): torus(pull,'Winding key bow',(x,-.102,.018),.016,.004,brass,'Y')
bar(pull,'Winding key stem',(0,-.102,.012),(0,-.102,-.043),.005,brass)
bar(pull,'Winding key tooth',(0,-.102,-.039),(.018,-.102,-.039),.004,brass)
bar(pull,'Winding key tooth',(0,-.102,-.028),(.012,-.102,-.028),.004,brass)
for y in (-.04,.01,.06): cube(pull,'Page edge',(0,y,.14),(.074,.003,.003),ivory)

candle=empty('Candelabrum'); cyl(candle,'Weighted base',(0,0,.035),.24,.07,iron,verts=16,r2=.19); torus(candle,'Base rim',(0,0,.075),.17,.014,brass)
cyl(candle,'Stem',(0,0,.43),.035,.70,brass,verts=12); cyl(candle,'Stem collar',(0,0,.47),.065,.08,iron)
for i in range(5):
    ang=i*2*math.pi/5; x=.31*math.cos(ang); y=.31*math.sin(ang)
    bar(candle,'Swept arm',(.0,.0,.56),(x*.6,y*.6,.57),.022,iron); bar(candle,'Upturned arm',(x*.6,y*.6,.57),(x,y,.76),.022,iron)
    cyl(candle,'Candle cup',(x,y,.79),.055,.065,brass,verts=12,r2=.043); cyl(candle,'Wax candle',(x,y,.89),.026,.17,ivory,verts=10)
    empty('Candelabrum_FlameSocket_%02d'%(i+1),candle,(x,y,.985))
cyl(candle,'Center candle cup',(0,0,.81),.055,.07,brass); cyl(candle,'Center candle',(0,0,.91),.026,.16,ivory); empty('Candelabrum_FlameSocket_00',candle,(0,0,1.0))

clock=empty('WallClock'); cyl(clock,'Turned round clock case',(0,-.035,.46),.275,.07,wood,'Y',32)
torus(clock,'Turned clock rim',(0,-.075,.46),.255,.012,wood2,'Y')
torus(clock,'Clock brass bead',(0,-.086,.46),.238,.006,brass,'Y')
cyl(clock,'Dial rim',(0,-.09,.46),.225,.055,brass,'Y',32); cyl(clock,'Dial',(0,-.125,.46),.19,.02,ivory,'Y',32)
for i in range(12):
    a=i*math.tau/12; cyl(clock,'Hour marker',(.165*math.sin(a),-.14,.46+.165*math.cos(a)),.009,.008,iron,'Y',8)
for name,length,width,ang in [('WallClock_HourHand',.10,.018,-.7),('WallClock_MinuteHand',.15,.012,.5)]:
    pivot=empty(name,clock,(0,-.155,.46)); pivot.rotation_euler[1]=ang; cube(pivot,'Clock hand',(0,0,length/2),(width,.012,length),iron,.004)
sh=empty('WallClock_Shutter',clock,(-.26,-.14,.42))

armor=empty('ClockworkArmor'); cyl(armor,'Stand foot',(0,0,.035),.30,.07,iron,verts=16,r2=.24); cyl(armor,'Stand post',(0,.055,.8),.035,1.5,iron)
for s in (-1,1):
    # Greaves and sabatons taper toward articulated knee and ankle joints.
    oval(armor,'Greave',(s*.15,-.012,.40),(.095,.105,.31),iron)
    oval(armor,'Sabatons',(s*.15,-.065,.12),(.105,.17,.065),iron)
    bar(armor,'Greave ridge',(s*.15,-.118,.17),(s*.15,-.102,.65),.012,brass)
    cyl(armor,'Knee joint',(s*.15,-.012,.73),.085,.15,iron,'Y',12)
    oval(armor,'Knee cap',(s*.15,-.10,.73),(.105,.052,.095),brass)
    oval(armor,'Thigh plate',(s*.15,0,.91),(.115,.115,.20),iron)
    for z in (.27,.53): bar(armor,'Greave edge',(s*.08,-.073,z),(s*.22,-.073,z),.009,brass)
    arm=empty('ClockworkArmor_%sArm'%('Left' if s<0 else 'Right'),armor,(s*.31,0,1.46))
    oval(arm,'Rounded pauldron',(s*.015,0,-.005),(.145,.15,.12),brass)
    oval(arm,'Pauldron inset',(s*.015,-.012,.016),(.132,.14,.10),iron)
    oval(arm,'Upper arm',(s*.045,0,-.19),(.07,.08,.19),iron)
    cyl(arm,'Elbow pivot',(s*.09,0,-.34),.072,.14,brass,'Y',12)
    oval(arm,'Forearm vambrace',(s*.115,-.015,-.48),(.073,.082,.15),iron)
    bar(arm,'Vambrace ridge',(s*.10,-.097,-.36),(s*.13,-.097,-.58),.01,brass)
    oval(arm,'Gauntlet',(s*.13,-.03,-.635),(.063,.075,.09),iron)
    for z in (-.60,-.65,-.69): bar(arm,'Finger guard',(s*.07,-.097,z),(s*.18,-.097,z),.008,brass)
# Layered silhouette and raised central ridge read as shaped steel rather than a box.
oval(armor,'Breastplate',(0,0,1.27),(.265,.17,.30),iron)
bar(armor,'Breastplate central ridge',(0,-.18,1.05),(0,-.155,1.52),.018,brass)
for s in (-1,1):
    bar(armor,'Breastplate upper edging',(0,-.15,1.50),(s*.215,-.105,1.43),.012,brass)
    bar(armor,'Breastplate side edging',(s*.215,-.105,1.43),(s*.19,-.12,1.13),.012,brass)
    for z in (1.15,1.23,1.31): cyl(armor,'Breastplate rivet',(s*.175,-.124,z),.011,.015,brass,'Y',8)
for z,w in [(1.06,.46),(1.00,.43),(.94,.40)]:
    cube(armor,'Overlapping fauld',(0,-.075,z),(w,.16,.065),iron,.02)
    bar(armor,'Fauld edge',(-w*.46,-.16,z-.027),(w*.46,-.16,z-.027),.008,brass)
head=empty('ClockworkArmor_Head',armor,(0,0,1.61)); oval(head,'Helmet dome',(0,0,.09),(.15,.13,.155),iron)
torus(head,'Helmet crown band',(0,0,.19),.113,.01,brass)
visor=empty('ClockworkArmor_Visor',head,(-.14,-.08,.17)); oval(visor,'Face guard',(.14,-.055,-.035),(.14,.075,.105),iron)
for z in (-.055,-.015): cube(visor,'Eye slit',(.14,-.132,z),(.17,.012,.012),enamel,.003)
for x in (.06,.10,.14,.18,.22): cyl(visor,'Visor rivet',(x,-.128,-.09),.007,.01,brass,'Y',8)
bar(visor,'Visor brow',(.025,-.12,.025),(.255,-.12,.025),.01,brass)

painting=empty('FramedPainting'); cube(painting,'Canvas',(0,0,.50),(.78,.035,.80),cloth,.005)
for x in (-.44,.44): cube(painting,'Frame side',(x,-.055,.50),(.09,.04,1.0),wood2,.01)
for z in (.045,.955): cube(painting,'Frame rail',(0,-.055,z),(.95,.04,.09),wood2,.01)
for x in (-.395,.395): cube(painting,'Gilt inner side',(x,-.08,.50),(.015,.02,.84),brass)
for z in (.085,.915): cube(painting,'Gilt inner rail',(0,-.08,z),(.80,.02,.015),brass)
latch=empty('FramedPainting_RearLatch',painting,(.24,.01,.50))

roots=[single,double,arch,curtain,chair,table,book,candle,clock,armor,painting]
# Join only static meshes that share parent and material, preserving moving pivots.
def combine():
    groups={}
    for ob in list(bpy.context.scene.objects):
        if ob.type=='MESH': groups.setdefault((ob.parent,ob.data.materials[0].name),[]).append(ob)
    for (parent,mat),obs in groups.items():
        if len(obs)<2: continue
        bpy.ops.object.select_all(action='DESELECT')
        for ob in obs: ob.select_set(True)
        bpy.context.view_layer.objects.active=obs[0]; bpy.ops.object.join(); obs[0].name=parent.name+'_'+mat
combine()
bpy.ops.wm.save_as_mainfile(filepath=str(SRC/'interior-furnishings.blend'))
staged=SRC/'interior-furnishings.staged.glb'
bpy.ops.export_scene.gltf(filepath=str(staged),export_format='GLB',export_yup=True,export_apply=True)
# Preview uses presentation-only positions and camera/lights after source/export.
atlas_preview=Path(__file__).resolve().parents[2]/'.local/review/book-bindings-atlas.png'
if atlas_preview.is_file():
    texture=bindings.node_tree.nodes.new('ShaderNodeTexImage'); texture.image=bpy.data.images.load(str(atlas_preview),check_existing=True)
    bindings.node_tree.links.new(texture.outputs['Color'],bindings.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
for i,r in enumerate(roots): r.location=((i%6)*2.5,0,(1-i//6)*3.0)
bpy.ops.object.camera_add(location=(10,-24,6.6)); camera=bpy.context.object; camera.rotation_euler=(Vector((6.25,0,2.9))-camera.location).to_track_quat('-Z','Y').to_euler(); camera.data.type='ORTHO'; camera.data.ortho_scale=16.8; bpy.context.scene.camera=camera
for loc,power,size in [((1,-7,11),2200,8),((10,2,10),1600,7)]:
    bpy.ops.object.light_add(type='AREA',location=loc); ob=bpy.context.object; ob.data.energy=power; ob.data.shape='DISK'; ob.data.size=size; ob.rotation_euler=(Vector((6,1,1))-ob.location).to_track_quat('-Z','Y').to_euler()
scene=bpy.context.scene; scene.render.engine='BLENDER_EEVEE'; scene.eevee.taa_render_samples=16; scene.render.resolution_x=1800; scene.render.resolution_y=1000; scene.render.resolution_percentage=100
scene.world.color=(.16,.16,.16); scene.render.image_settings.file_format='PNG'; scene.render.filepath=str(SRC/'interior-furnishings-preview.png'); bpy.ops.render.render(write_still=True)
# Fresh import is the authority for nodes, bounds and triangle budget.
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(staged)); bpy.context.view_layer.update()
required=['DoorSingle','DoorDouble','DoorArched','Curtain','DiningChair','DiningTable','Bookcase','Candelabrum','WallClock','ClockworkArmor','FramedPainting']
pivots=['DoorSingle_Leaf','DoorDouble_LeftLeaf','DoorDouble_RightLeaf','DoorArched_Leaf','Bookcase_Slider','Bookcase_PullBook','WallClock_HourHand','WallClock_MinuteHand','WallClock_Shutter','ClockworkArmor_Head','ClockworkArmor_Visor','ClockworkArmor_LeftArm','ClockworkArmor_RightArm','FramedPainting_RearLatch']+['Candelabrum_FlameSocket_%02d'%i for i in range(6)]
missing=[n for n in required+pivots+['Canvas'] if not bpy.data.objects.get(n)]
if missing: raise RuntimeError('Missing nodes: '+str(missing))
book_nodes=[bpy.data.objects[n] for n in ('Bookcase','Bookcase_PullBook','Bookcase_Slider')]
for node in book_nodes:
    meshes=[o for o in node.children if o.type=='MESH']
    if any(len(o.data.materials)!=1 for o in meshes): raise RuntimeError('Multiple material slots under '+node.name)
    materials=[o.data.materials[0].name for o in meshes]
    if len(materials)!=len(set(materials)): raise RuntimeError('Unbatched material under '+node.name)
book_meshes=[o for o in book_nodes[0].children_recursive if o.type=='MESH']
if len(book_meshes)>20: raise RuntimeError('Bookcase mesh budget exceeded: '+str(len(book_meshes)))
report={'generator':'scripts/assets/build-interior-furnishings.py','blender':bpy.app.version_string,'coordinate_system':'glTF Y-up; front +Z; dimensions metres','materials':[m.name for m in MATS],'roots':{},'movable_nodes':pivots,'warnings':['Visual approval and in-engine device acceptance pending.','LibraryBindingAtlas requires the shared runtime book texture; canvas UVs are texture-ready.','No authored colliders or LODs.']}
triangles=0
for n in required:
    root=bpy.data.objects[n]; descendants=[root]+list(root.children_recursive); meshes=[o for o in descendants if o.type=='MESH']; points=[]
    for ob in meshes:
        triangles+=sum(len(p.vertices)-2 for p in ob.data.polygons)
        points += [root.matrix_world.inverted() @ ob.matrix_world @ v.co for v in ob.data.vertices]
    if not points: raise RuntimeError('Empty root '+n)
    lo=[min(p[i] for p in points) for i in (0,2,1)]; hi=[max(p[i] for p in points) for i in (0,2,1)]
    lo[2],hi[2]=-hi[2],-lo[2]
    report['roots'][n]={'dimensions_m':[round(hi[i]-lo[i],3) for i in range(3)],'bounds_min':[round(v,3) for v in lo],'bounds_max':[round(v,3) for v in hi],'mesh_count':len(meshes)}
report['triangles']=triangles; report['size_bytes']=staged.stat().st_size
if triangles>60000 or staged.stat().st_size>8_000_000: raise RuntimeError('Kit budget exceeded')
assert not any(o.type in {'CAMERA','LIGHT'} for o in bpy.context.scene.objects)
os.replace(staged,PUB/'interior-furnishings.glb')
report['sha256']=hashlib.sha256((PUB/'interior-furnishings.glb').read_bytes()).hexdigest()
(SRC/'interior-furnishings.report.json').write_text(json.dumps(report,indent=2)+'\n')
provenance_path=SRC/'provenance.json'
previous=json.loads(provenance_path.read_text()) if provenance_path.exists() else {}
provenance={'author':'Original procedural Blender modeling','license':'MIT','source':'interior-furnishings.blend','generator':'scripts/assets/build-interior-furnishings.py','output':'public/assets/props/interior-furnishings/interior-furnishings.glb','blender':bpy.app.version_string,'glb_sha256':report['sha256'],'blend_sha256':hashlib.sha256((SRC/'interior-furnishings.blend').read_bytes()).hexdigest(),'generator_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'approval':'Revised geometry reimported and checked. Final independent review and owner visual acceptance pending.'}
if previous.get('historicalReview'): provenance['historicalReview']=previous['historicalReview']
provenance_path.write_text(json.dumps(provenance,indent=2)+'\n')
print('KIT_REPORT',json.dumps(report))
