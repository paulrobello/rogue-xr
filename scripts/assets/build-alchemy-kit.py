"""Original Clockwork Spire alchemy kit. Run in isolated Blender background.
Blender (x,y,z) maps to glTF (x,z,-y), metres. Each named empty is a reusable root.
"""
import bpy, math, json, hashlib, sys
from pathlib import Path
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'assets-source/props/alchemy-kit'
OUT = SRC / 'staging'
RUNTIME = ROOT / 'public/assets/props/alchemy-kit'
OUT.mkdir(parents=True, exist_ok=True)
RUNTIME.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

def mat(name, color, metal=0, rough=.5, emission=0):
    m = bpy.data.materials.new(name); m.diffuse_color = (*color, 1); m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF'); p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Metallic'].default_value = metal; p.inputs['Roughness'].default_value = rough
    if emission:
        p.inputs['Emission Color'].default_value = (*color, 1); p.inputs['Emission Strength'].default_value = emission
    return m
black = mat('Soot black iron',(.033,.038,.041),.68,.65)
copper = mat('Aged copper',(.34,.14,.055),.8,.34)
verdigris = mat('Copper patina',(.06,.26,.20),.45,.62)
gold = mat('Alchemical brass',(.57,.35,.09),.75,.31)
liquid = mat('Luminous elixir',(.06,.55,.32),.12,.24, .7)
glimmer = mat('Magical glimmer',(.63,1,.56),0,.27,2)
cream = mat('Mooncap ivory',(.83,.74,.53),0,.6)
blue = mat('Mooncap blue',(.12,.29,.52),.06,.45)
purple = mat('Star thistle violet',(.38,.12,.59),0,.4)
green = mat('Thistle stem',(.13,.32,.13),0,.67)
ember = mat('Ember salt',(.94,.19,.035),.14,.3,.5)
stone = mat('Recipe slate',(.095,.12,.14),.18,.65)
vial = mat('Potion glass',(.16,.55,.48),.12,.22,.24)
wood = mat('Vial stopper',(.27,.12,.045),0,.85)
silver = mat('Ward silver enamel',(.48,.58,.58),.68,.28)
walnut = mat('Carved dark walnut',(.17,.055,.022),0,.48)
enamel = mat('Clock face enamel',(.74,.63,.40),.12,.5)
roots = {}
def root(name):
    o=bpy.data.objects.new(name,None); bpy.context.scene.collection.objects.link(o); roots[name]=o; return o

def attach(o, parent, material):
    o.parent=parent; o.data.materials.append(material)
    if o.type=='MESH':
        for p in o.data.polygons: p.use_smooth=True
    return o

def uvball(parent, loc, scale, material, segments=20, rings=10):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=loc)
    o=bpy.context.object; o.scale=scale; return attach(o,parent,material)

def cyl(parent, loc, radius, depth, material, vertices=24):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc)
    return attach(bpy.context.object,parent,material)

def box(parent, loc, scale, material):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc); o=bpy.context.object; o.scale=scale; return attach(o,parent,material)

def torus(parent, loc, major, minor, material, rotation=(0,0,0)):
    bpy.ops.mesh.primitive_torus_add(major_segments=32,minor_segments=8,major_radius=major,minor_radius=minor,location=loc,rotation=rotation)
    return attach(bpy.context.object,parent,material)

def line(parent, a, b, r, material, vertices=8):
    a,b=Vector(a),Vector(b); d=b-a
    o=cyl(parent,(a+b)/2,r,d.length,material,vertices); o.rotation_euler=d.to_track_quat('Z','Y').to_euler(); return o

def cone(parent, a, b, radius, material):
    a,b=Vector(a),Vector(b); d=b-a
    bpy.ops.mesh.primitive_cone_add(vertices=8,radius1=radius,radius2=.002,depth=d.length,location=(a+b)/2)
    o=bpy.context.object; o.rotation_euler=d.to_track_quat('Z','Y').to_euler(); return attach(o,parent,material)

def taper(parent, a, b, base, tip, material):
    a,b=Vector(a),Vector(b); d=b-a
    bpy.ops.mesh.primitive_cone_add(vertices=8,radius1=base,radius2=tip,depth=d.length,location=(a+b)/2)
    o=bpy.context.object; o.rotation_euler=d.to_track_quat('Z','Y').to_euler(); return attach(o,parent,material)

def lathe(parent, profile, material, seg=32):
    vertices=[(r*math.cos(i*2*math.pi/seg),r*math.sin(i*2*math.pi/seg),z) for r,z in profile for i in range(seg)]
    faces=[]
    for j in range(len(profile)-1):
        for i in range(seg): faces.append((j*seg+i,j*seg+(i+1)%seg,(j+1)*seg+(i+1)%seg,(j+1)*seg+i))
    mesh=bpy.data.meshes.new('turned form'); mesh.from_pydata(vertices,[],faces); mesh.update()
    o=bpy.data.objects.new('turned form',mesh); bpy.context.scene.collection.objects.link(o); return attach(o,parent,material)

def star(parent, center, radius, inner, depth, material, n=5):
    # horizontal star, visible from above
    x,y,z=center; verts=[]
    for zz in (z-depth/2,z+depth/2):
        for i in range(n*2):
            a=math.pi/2+i*math.pi/n; r=radius if i%2==0 else inner
            verts.append((x+r*math.cos(a),y+r*math.sin(a),zz))
    k=n*2; faces=[tuple(range(k-1,-1,-1)),tuple(range(k,k*2))]
    faces += [(i,(i+1)%k,(i+1)%k+k,i+k) for i in range(k)]
    me=bpy.data.meshes.new('star'); me.from_pydata(verts,[],faces); me.update()
    o=bpy.data.objects.new('star',me); bpy.context.scene.collection.objects.link(o); return attach(o,parent,material)

r=root('AlchemyCauldron')
lathe(r,[(.15,.13),(.30,.16),(.43,.24),(.48,.39),(.46,.55),(.39,.68),(.36,.72),(.33,.72),(.37,.65),(.41,.53),(.42,.40),(.37,.27),(.24,.21),(.02,.20)],black)
torus(r,(0,0,.69),.374,.036,copper); torus(r,(0,0,.686),.376,.009,verdigris)
cyl(r,(0,0,.647),.354,.015,liquid,32)
swirl=root('CauldronSwirl'); swirl.parent=r; swirl.location.z=.657
def swirl_ribbon(angle, sweep, start, end, width, height, material):
    vertices=[]; faces=[]
    for i in range(49):
        t=i/48; a=angle+sweep*t
        radius=start+(end-start)*t
        half_width=width*(.04+.96*math.sin(math.pi*t)**.72)
        for offset in (-half_width,half_width):
            vertices.append(((radius+offset)*math.cos(a),(radius+offset)*math.sin(a),height))
        if i: faces.append((2*i-2,2*i-1,2*i+1,2*i))
    mesh=bpy.data.meshes.new('ribbon of current'); mesh.from_pydata(vertices,[],faces); mesh.update()
    o=bpy.data.objects.new('ribbon of current',mesh); bpy.context.scene.collection.objects.link(o)
    attach(o,swirl,material)
swirl_ribbon(.45,math.tau*1.03,.026,.294,.012,0,verdigris)
swirl_ribbon(2.80,4.3,.14,.327,.008,0,verdigris)
swirl_ribbon(4.50,1.70,.205,.270,.004,.0008,glimmer)
swirl_ribbon(2.00,1.25,.094,.145,.003,.0008,glimmer)
for i,(x,y,z,size) in enumerate([(-.19,.08,.666,.029),(.14,.13,.692,.024),
                                  (.08,-.18,.657,.035),(-.06,-.07,.731,.017)]):
    bubble=root('CauldronBubble'+str(i+1)); bubble.parent=r; bubble.location=(x,y,z)
    uvball(bubble,(0,0,0),(size,size,size*.93),vial,16,8)
    uvball(bubble,(-size*.32,-size*.57,size*.56),(size*.25,size*.13,size*.15),glimmer,10,6)
torus(r,(0,0,.30),.458,.007,copper); torus(r,(0,0,.53),.465,.005,verdigris)
for i in range(3):
    a=i*2*math.pi/3+.3; x,y=.28*math.cos(a),.28*math.sin(a)
    line(r,(x,y,.19),(x*1.22,y*1.22,.045),.043,black,12); uvball(r,(x*1.22,y*1.22,.045),(.095,.071,.045),copper)
for side in (-1,1):
    torus(r,(side*.465,0,.53),.075,.012,copper,(math.pi/2,0,0))

r=root('IngredientMooncap')
for i in range(9):
    a=math.radians(28+i*15.5); x=.082*math.cos(a); z=.10+.082*math.sin(a)
    uvball(r,(x,0,z),(.026,.032,.025),blue,12,6)
lathe(r,[(.014,.017),(.016,.035),(.014,.078),(.0135,.123),(.016,.145),
         (.023,.157),(.027,.164),(.021,.171),(0,.177)],cream,16)
uvball(r,(0,0,.02),(.028,.024,.018),cream,12,6)
for a in (50,95,140):
    t=math.radians(a); uvball(r,(.082*math.cos(t),-.028,.10+.082*math.sin(t)),(.007,.006,.007),glimmer,8,4)

r=root('IngredientStarThistle')
line(r,(0,0,.015),(0,0,.16),.012,green,10)
for angle in range(0,360,60):
    a=math.radians(angle); cone(r,(0,0,.12),(.085*math.cos(a),.085*math.sin(a),.11),.017,green)
    cone(r,(0,0,.18),(.102*math.cos(a),.102*math.sin(a),.205),.03,purple)
uvball(r,(0,0,.182),(.045,.045,.04),gold,12,6)
star(r,(0,0,.215),.055,.021,.012,glimmer)

r=root('IngredientEmberSalt')
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1,radius=1,location=(0,0,.095)); o=bpy.context.object; o.scale=(.082,.072,.095); attach(o,r,ember)
for dx,dy in ((-.05,-.02),(.055,.025)):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1,radius=1,location=(dx,dy,.03)); o=bpy.context.object; o.scale=(.03,.025,.035); attach(o,r,gold)

r=root('PotionVial')
lathe(r,[(.00,.015),(.06,.015),(.077,.04),(.078,.15),(.065,.20),(.035,.23),(.035,.275),(.044,.28)],vial,24)
cyl(r,(0,0,.281),.04,.03,gold); cyl(r,(0,0,.307),.032,.037,wood)
torus(r,(0,0,.14),.079,.004,gold); star(r,(0,0,.18),.033,.014,.007,glimmer)

for name, symbol in [('RecipeTileMooncap',blue),('RecipeTileStarThistle',purple),('RecipeTileEmberSalt',ember)]:
    r=root(name); box(r,(0,0,.0125),(.18,.18,.025),stone)
    for x in (-.074,.074): box(r,(x,0,.026),(.006,.15,.003),gold)
    for y in (-.074,.074): box(r,(0,y,.026),(.15,.006,.003),gold)
    if name.endswith('Mooncap'):
        # The relief is the ingredient's front silhouette, half sunk into the slate.
        relief = (Matrix.Translation((0,-.055,.0255))
                  @ Matrix.Diagonal((.54,.54,.16,1))
                  @ Matrix.Rotation(-math.pi/2,4,'X'))
        for part in roots['IngredientMooncap'].children:
            glyph=part.copy(); glyph.data=part.data.copy(); glyph.parent=r
            bpy.context.scene.collection.objects.link(glyph)
            glyph.matrix_basis=relief @ part.matrix_basis
    elif name.endswith('StarThistle'): star(r,(0,0,.031),.055,.021,.007,symbol)
    else:
        o=box(r,(0,0,.032),(.055,.055,.009),symbol); o.rotation_euler.z=math.pi/4

for side in (-1,1):
    r=root('ThornWardLeft' if side==-1 else 'ThornWardRight'); direction=-side
    # The pivot sits at the outer hinge and the lattice extends toward the centre.
    for j in range(3):
        x=direction*(.10+j*.28)
        pts=[]
        for i in range(13):
            z=.07+i*2.26/12; pts.append((x+direction*.07*math.sin(i*.85+j),.018*math.sin(i*.7+j),z))
        for i,(a,b) in enumerate(zip(pts,pts[1:])): taper(r,a,b,.028-i*.0012,.026-i*.0012,green)
        for i in range(1,12,2):
            x0,y,z=pts[i]; cone(r,(x0,y,z),(x0+direction*(.10 if j<2 else -.09),y-.02,z+.075),.035,green)
            for sign in (-1,1):
                end=(x0+sign*.10,y-.02,z+.11)
                taper(r,(x0,y,z),end,.015,.002,green)
                leaf=uvball(r,(x0+sign*.055,y-.025,z+.065),(.045,.010,.018),verdigris,12,6)
                leaf.rotation_euler.y=-sign*.65
    for i in range(5):
        z=.23+i*.46; line(r,(direction*.05,0,z),(direction*.76,0,z+.11),.014,silver)
    for z in (.18,1.20,2.22): torus(r,(0,0,z),.042,.01,silver,(math.pi/2,0,0))

r=root('AstralLiftMedallion')
cyl(r,(0,0,.025),.45,.05,black,48); torus(r,(0,0,.052),.40,.012,gold)
torus(r,(0,0,.055),.29,.007,verdigris); star(r,(0,0,.060),.20,.074,.012,glimmer,8)
for i in range(12):
    a=2*math.pi*i/12; uvball(r,(.35*math.cos(a),.35*math.sin(a),.060),(.012,.012,.006),gold,8,4)

# Owl: armored body, expressive clockwork face, feather plates, independent head and wings.
r=root('ClockworkOwl')
uvball(r,(0,0,.39),(.22,.16,.28),copper,24,12)
uvball(r,(0,-.12,.38),(.16,.055,.20),black,20,10)
for row in range(3):
    for i in range(5):
        x=(i-2)*.057; z=.28+row*.085
        uvball(r,(x,-.167,z),(.029,.013,.06),gold if row==2 else silver,12,6)
for x in (-.12,.12):
    line(r,(x,0,.17),(x,-.015,.07),.025,copper,10)
    for dx in (-.035,0,.035):
        line(r,(x,-.02,.07),(x+dx,-.095,.035),.014,gold,8)
        cone(r,(x+dx,-.095,.035),(x+dx,-.13,.02),.013,gold)
h=root('OwlHead'); h.parent=r; h.location=(0,0,.62)
uvball(h,(0,0,0),(.205,.15,.155),copper,24,12)
for side in (-1,1):
    x=side*.095
    uvball(h,(x,-.125,.022),(.082,.032,.088),gold,20,10)
    uvball(h,(x,-.153,.022),(.062,.021,.066),black,20,10)
    uvball(h,(x,-.173,.022),(.044,.014,.046),glimmer,20,10)
    uvball(h,(x,-.187,.022),(.018,.009,.021),black,16,8)
    cone(h,(side*.13,0,.105),(side*.18,0,.23),.042,copper)
cone(h,(0,-.17,-.005),(0,-.26,-.055),.055,gold)
for side in (-1,1):
    w=root('OwlWingL' if side==-1 else 'OwlWingR'); w.parent=r; w.location=(side*.19,0,.49)
    uvball(w,(side*.035,0,-.045),(.085,.12,.18),black,20,10)
    for i in range(5):
        x=side*(.018+i*.021); z=-.025-i*.017
        uvball(w,(x,-.104,z),(.028,.014,.046),copper if i%2 else gold,12,6)
        cone(w,(x,-.108,z-.012),(x+side*.035,-.108,z-.15-(i%2)*.025),.031,copper if i%2 else silver)

# Sweeper: head is independently pivoted around the ferrule for the sweeping stroke.
r=root('MechanicalBroom')
line(r,(0,0,.18),(0,0,.87),.025,wood,12)
for z in (.37,.68,.84): torus(r,(0,0,z),.028,.006,gold)
cyl(r,(0,0,.18),.052,.10,gold,20)
torus(r,(0,0,.70),.07,.01,copper,(math.pi/2,0,0))
for a in range(0,360,60):
    t=math.radians(a); line(r,(0,-.003,.70),(.06*math.cos(t),0,.70+.06*math.sin(t)),.005,gold,6)
head=root('BroomHead'); head.parent=r; head.location=(0,0,.15)
uvball(head,(0,0,-.035),(.13,.05,.06),copper,16,8)
for i in range(13):
    x=(i-6)*.019; offset=.012*math.sin(i*2.1)
    taper(head,(x*.58,0,-.03),(x+offset,-.008,-.13-.012*(i%3)),.009,.002,cream)
    taper(head,(x*.58,.018,-.03),(x-offset,.025,-.125-.013*((i+1)%3)),.007,.0015,gold)

# Grandfather clock. Blender -Y faces the room, which exports to glTF +Z.
r=root('GrandfatherClock')
box(r,(0,.08,1.09),(.62,.24,2.08),walnut)
# A dark inset keeps the moving pendulum silhouetted, framed by carved uprights.
box(r,(0,-.065,1.03),(.44,.05,.94),stone)
for x in (-.26,.26):
    box(r,(x,-.095,1.05),(.085,.15,1.35),walnut)
    for dx in (-.021,0,.021): line(r,(x+dx,-.173,.47),(x+dx,-.173,1.58),.005,gold,8)
    uvball(r,(x,-.17,1.48),(.035,.018,.035),gold,12,6)
for z,w,d,h in [(.07,.72,.43,.14),(.17,.65,.37,.07),(1.57,.68,.40,.09),(2.13,.70,.41,.11)]:
    box(r,(0,.02,z),(w,d,h),walnut)
    box(r,(0,-d/2+.015,z+h*.35),(w*.97,.01,.012),gold)
# Crown, carved cap and marquetry crescent around an astrolabe.
uvball(r,(0,.02,2.17),(.28,.18,.10),walnut,24,10)
torus(r,(0,-.193,2.175),.075,.009,gold,(math.pi/2,0,0))
for a in (0,60,120):
    t=math.radians(a); line(r,(-.067*math.cos(t),-.205,2.175-.067*math.sin(t)),(.067*math.cos(t),-.205,2.175+.067*math.sin(t)),.004,gold,6)
# Clock face is set ahead of its case, with raised chapter ring and indices.
cylface=torus(r,(0,-.187,1.84),.247,.023,gold,(math.pi/2,0,0))
bpy.ops.mesh.primitive_cylinder_add(vertices=48,radius=.232,depth=.018,location=(0,-.184,1.84),rotation=(math.pi/2,0,0)); attach(bpy.context.object,r,enamel)
torus(r,(0,-.202,1.84),.196,.005,copper,(math.pi/2,0,0))
for i in range(12):
    a=i*math.tau/12; x=.215*math.sin(a); z=1.84+.215*math.cos(a)
    line(r,(x*.94,-.204,1.84+(z-1.84)*.94),(x*1.04,-.204,1.84+(z-1.84)*1.04),.004,black,6)
# Roman numerals use raised geometry and stay legible on the face.
for i,label in enumerate(('XII','I','II','III','IV','V','VI','VII','VIII','IX','X','XI')):
    a=i*math.tau/12
    bpy.ops.object.text_add(location=(.168*math.sin(a),-.206,1.84+.168*math.cos(a)),rotation=(math.pi/2,0,0))
    o=bpy.context.object; o.data.body=label; o.data.size=.035; o.data.align_x='CENTER'; o.data.align_y='CENTER'; o.data.extrude=.0008
    bpy.ops.object.convert(target='MESH'); attach(bpy.context.object,r,black)
# Diamond marquetry at the foot and face spandrels.
for z in (.27,1.58):
    torus(r,(0,-.205,z),.04,.005,gold,(math.pi/2,0,0))
# Both hands turn on one spindle. The fixed brass cap covers their stacked bases.
def clock_pointer(name, depth, profile):
    hand=root(name); hand.parent=r; hand.location=(0,depth,1.84)
    outline=[(w,z) for z,w in profile]+[(-w,z) for z,w in reversed(profile) if w]
    n=len(outline)
    verts=[(x,y,z) for y in (-.0015,.0015) for x,z in outline]
    faces=[tuple(range(n)),tuple(reversed(range(n,2*n)))]
    faces.extend((i,i+n,(i+1)%n+n,(i+1)%n) for i in range(n))
    mesh=bpy.data.meshes.new(name+' blade'); mesh.from_pydata(verts,[],faces); mesh.update()
    blade=bpy.data.objects.new(name+' blade',mesh); bpy.context.scene.collection.objects.link(blade)
    attach(blade,hand,black)
    for face in mesh.polygons: face.use_smooth=False
clock_pointer('ClockHourHand',-.208,[(-.007,.006),(.030,.005),(.064,.012),(.110,0)])
clock_pointer('ClockMinuteHand',-.213,[(-.007,.004),(.110,.0038),(.135,.0055),(.166,0)])
hub=root('ClockHandHub'); hub.parent=r; hub.location=(0,-.219,1.84)
uvball(hub,(0,0,0),(.014,.007,.014),gold,24,10)
pend=root('ClockPendulum'); pend.parent=r; pend.location=(0,-.16,1.47)
line(pend,(0,-.008,0),(0,-.008,-.68),.013,gold,10)
line(pend,(0,-.020,0),(0,-.020,-.68),.003,glimmer,8)
uvball(pend,(0,0,-.68),(.105,.025,.105),gold,24,12)
torus(pend,(0,-.026,-.68),.072,.005,copper,(math.pi/2,0,0))
uvball(pend,(0,-.029,-.68),(.018,.008,.018),glimmer,12,6)
# A shallow drawer slides along glTF +Z; its socket rides with the drawer.
drawer=root('ClockCompartment'); drawer.parent=r; drawer.location=(0,-.145,1.40)
box(drawer,(0,0,0),(.35,.16,.15),walnut)
box(drawer,(0,-.085,0),(.32,.016,.12),copper)
torus(drawer,(0,-.099,0),.028,.006,gold,(math.pi/2,0,0))
socket=bpy.data.objects.new('ClockIngredientSocket',None); bpy.context.scene.collection.objects.link(socket); socket.parent=drawer; socket.location=(0,-.01,.09)
# Framed wall clue has its own independently rotatable hand and hangs centered on its root.
r=root('ClockClueDial')
box(r,(0,.025,0),(.42,.09,.42),walnut)
bpy.ops.mesh.primitive_cylinder_add(vertices=40,radius=.175,depth=.012,location=(0,-.027,0),rotation=(math.pi/2,0,0)); attach(bpy.context.object,r,enamel)
torus(r,(0,-.035,0),.178,.012,gold,(math.pi/2,0,0))
for i in range(12):
    a=i*math.tau/12; x=.15*math.sin(a); z=.15*math.cos(a)
    line(r,(x*.92,-.04,z*.92),(x*1.04,-.04,z*1.04),.004,black,6)
clue=root('ClockClueHand'); clue.parent=r; clue.location=(0,-.052,0)
line(clue,(0,0,-.02),(0,0,.12),.009,black,8); cone(clue,(0,0,.105),(0,0,.14),.013,black)

# Consolidate meshes per root while retaining material slots and the root pivot.
for name,r in roots.items():
    children=[o for o in r.children if o.type=='MESH']
    if not children: continue
    bpy.ops.object.select_all(action='DESELECT')
    for o in children: o.select_set(True)
    bpy.context.view_layer.objects.active=children[0]; bpy.ops.object.join()
    children[0].name=name+'_Visual'

# Unwrap the complete runtime meshes so all materials use explicit UV coordinates.
for r in roots.values():
    o=next(o for o in r.children if o.type=='MESH')
    bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active=o
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(island_margin=.012); bpy.ops.object.mode_set(mode='OBJECT')

# Original procedural painted PBR maps, stored in the blend and embedded in the GLB.
# Small tiling grain, mottling and material-specific patterning provide wear at play distance.
import random
import numpy as np
size=256
y,x=np.mgrid[0:size,0:size].astype(np.float32); u=x/size; v=y/size
for idx,m in enumerate(bpy.data.materials):
    if not m.use_nodes: continue
    shader=m.node_tree.nodes.get('Principled BSDF')
    if shader is None: continue
    base=np.array(shader.inputs['Base Color'].default_value[:3],dtype=np.float32)
    rng=np.random.default_rng(8400+idx)
    grain=rng.random((size,size),dtype=np.float32)-.5
    ripple=(np.sin(u*51+np.sin(v*17)*2)+np.sin(v*37+np.sin(u*13)*3))*.5
    clouds=(np.sin(u*19+v*12)+np.cos(v*23-u*9))*.5
    factor=np.clip(.88+.11*clouds+.055*ripple+.10*grain,.55,1.2)
    rgb=np.clip(base[None,None,:]*factor[:,:,None],0,1)
    if m.name=='Aged copper':
        pat=np.clip((clouds+.12)*.30,0,.32)[:,:,None]; rgb=rgb*(1-pat)+np.array([.035,.22,.16])*pat
    if m.name=='Soot black iron':
        # Distinct small irregular hammer scars and carbon streaks.
        dents=np.clip((np.sin(u*170)*np.sin(v*160)-.82)*1.8,0,.25)
        rgb*=1-dents[:,:,None]
    if m.name in ('Star thistle violet','Thistle stem','Mooncap blue'):
        veins=np.maximum(0,np.cos(u*60+np.sin(v*9)*1.2))**18
        rgb=np.clip(rgb*(.88+.20*v[:,:,None])+veins[:,:,None]*base*.16,0,1)
    if m.name=='Carved dark walnut':
        woodgrain=np.sin(v*105+2.5*np.sin(u*15)+np.sin(v*19))*np.sin(v*32+u*9)
        rgb=np.clip(rgb*(.85+.22*woodgrain[:,:,None]),0,1)
    if m.name=='Potion glass':
        bands=np.maximum(0,np.sin(v*34+u*3))**14
        rgb=np.clip(rgb+bands[:,:,None]*np.array([.05,.10,.08]),0,1)
    rgba=np.ones((size,size,4),dtype=np.float32); rgba[:,:,:3]=rgb
    image=bpy.data.images.new(m.name+' painted base',width=size,height=size,alpha=True)
    image.pixels.foreach_set(rgba.ravel()); image.file_format='PNG'; image.filepath_raw=str(OUT/(m.name.replace(' ','-')+'.png')); image.save(); image.pack()
    node=m.node_tree.nodes.new('ShaderNodeTexImage'); node.image=image; node.label='Original painted color'
    m.node_tree.links.new(node.outputs['Color'],shader.inputs['Base Color'])
    # Roughness texture preserves the authored factor with independent fine wear.
    rough=float(shader.inputs['Roughness'].default_value)
    roughpix=np.ones((size,size,4),dtype=np.float32)
    roughpix[:,:,:3]=np.clip(rough+.11*grain[:,:,None]+.08*clouds[:,:,None],.05,1)
    rim=bpy.data.images.new(m.name+' roughness',width=size,height=size,alpha=True)
    rim.colorspace_settings.name='Non-Color'; rim.pixels.foreach_set(roughpix.ravel()); rim.file_format='PNG'; rim.filepath_raw=str(OUT/(m.name.replace(' ','-')+'-roughness.png')); rim.save(); rim.pack()
    rn=m.node_tree.nodes.new('ShaderNodeTexImage'); rn.image=rim; rn.label='Original surface roughness'
    m.node_tree.links.new(rn.outputs['Color'],shader.inputs['Roughness'])
    # Real tangent-space normal texture derived from the material's height pattern.
    height=.38*clouds+.16*ripple
    if m.name=='Soot black iron': height-=dents*1.3
    if m.name=='Carved dark walnut': height+=woodgrain*.42
    if m.name in ('Star thistle violet','Thistle stem','Mooncap blue'): height+=veins*.25
    dy,dx=np.gradient(height); strength=2.4
    norm=np.stack((-dx*strength,-dy*strength,np.ones_like(dx)),axis=2)
    norm/=np.maximum(np.linalg.norm(norm,axis=2,keepdims=True),1e-6)
    normals=np.ones((size,size,4),dtype=np.float32); normals[:,:,:3]=norm*.5+.5
    nim=bpy.data.images.new(m.name+' tangent normal',width=size,height=size,alpha=True)
    nim.colorspace_settings.name='Non-Color'; nim.pixels.foreach_set(normals.ravel()); nim.file_format='PNG'; nim.filepath_raw=str(OUT/(m.name.replace(' ','-')+'-normal.png')); nim.save(); nim.pack()
    nn=m.node_tree.nodes.new('ShaderNodeTexImage'); nn.image=nim; nn.label='Original tangent-space relief'
    normal=m.node_tree.nodes.new('ShaderNodeNormalMap'); normal.inputs['Strength'].default_value=.8
    m.node_tree.links.new(nn.outputs['Color'],normal.inputs['Color']); m.node_tree.links.new(normal.outputs['Normal'],shader.inputs['Normal'])

bpy.ops.wm.save_as_mainfile(filepath=str(SRC/'alchemy-kit.blend'))
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=str(OUT/'alchemy-kit.glb'),export_format='GLB',export_yup=True,export_apply=True)
# Reimport in a new empty scene and verify root names / exported triangle count.
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(OUT/'alchemy-kit.glb'))
missing=sorted(set(roots)-set(bpy.data.objects.keys()))
if missing: raise RuntimeError('Missing roots after import: '+str(missing))
triangles=sum(sum(len(p.vertices)-2 for p in o.data.polygons) for o in bpy.context.scene.objects if o.type=='MESH')
if triangles>55000: raise RuntimeError('Triangle budget exceeded: '+str(triangles))

def mooncap_contact(name, axis, plane, extent):
    visual=next(o for o in bpy.data.objects[name].children if o.type=='MESH')
    verts=[visual.matrix_world @ v.co for v in visual.data.vertices]
    surfaces={}
    for label in ('Mooncap blue','Mooncap ivory'):
        faces=[tuple(p.vertices) for p in visual.data.polygons
               if visual.material_slots[p.material_index].material.name.split('.')[0]==label]
        surfaces[label]=BVHTree.FromPolygons(verts,faces)
    depths=[]
    for x in (-extent,extent):
        origin=Vector((x,0,0)); origin[3-axis]=plane
        above=origin.copy(); above[axis]=.25
        below=origin.copy(); below[axis]=-.25
        up=Vector((0,0,0)); up[axis]=1
        cap=surfaces['Mooncap blue'].ray_cast(below,up)[0]
        stem=surfaces['Mooncap ivory'].ray_cast(above,-up)[0]
        if cap is None or stem is None: raise RuntimeError(name+' lacks a Mooncap contact section')
        depths.append(stem[axis]-cap[axis])
    overlap=min(depths)
    if overlap < .005: raise RuntimeError(name+' has insufficient stem and cap overlap: '+str(overlap))
    return round(overlap,5)

contact={'ingredient':mooncap_contact('IngredientMooncap',2,0,.008),
         'recipe_relief':mooncap_contact('RecipeTileMooncap',1,.027,.004)}
print('MOONCAP_OVERLAP_METRES',json.dumps(contact))
render_review='--export-only' not in sys.argv
if render_review:
    pos={'AlchemyCauldron':(-1.5,0,0),'IngredientMooncap':(-.5,-.3,0),'IngredientStarThistle':(-.2,-.3,0),'IngredientEmberSalt':(.1,-.3,0),'PotionVial':(.4,-.3,0),'RecipeTileMooncap':(-.45,-.65,0),'RecipeTileStarThistle':(-.20,-.65,0),'RecipeTileEmberSalt':(.05,-.65,0),'ThornWardLeft':(.9,.35,0),'ThornWardRight':(2.5,.35,0),'AstralLiftMedallion':(-.15,.8,0),'ClockworkOwl':(-2.35,.30,0),'MechanicalBroom':(2.9,0,0),'GrandfatherClock':(-3.5,.25,0),'ClockClueDial':(-3.5,.3,2.65)}
    for name,p in pos.items(): bpy.data.objects[name].location=p
    world=bpy.context.scene.world; world.color=(.18,.18,.18)
    bpy.ops.object.light_add(type='AREA',location=(-3,-4,5)); bpy.context.object.data.energy=1300; bpy.context.object.data.color=(1,.73,.48); bpy.context.object.data.shape='DISK'; bpy.context.object.data.size=5
    bpy.ops.object.light_add(type='AREA',location=(4,-1,4)); bpy.context.object.data.energy=850; bpy.context.object.data.color=(.43,.65,1); bpy.context.object.data.size=5
    bpy.ops.object.light_add(type='AREA',location=(-2,3,4)); bpy.context.object.data.energy=1000; bpy.context.object.data.color=(1,.54,.24); bpy.context.object.data.size=3
    bpy.data.objects['ClockHourHand'].rotation_mode='XYZ'
    bpy.data.objects['ClockMinuteHand'].rotation_mode='XYZ'
    bpy.data.objects['ClockHourHand'].rotation_euler.y=math.radians(-55)
    bpy.data.objects['ClockMinuteHand'].rotation_euler.y=math.radians(60)
    bpy.ops.object.camera_add(location=(4,-7,5)); cam=bpy.context.object; cam.rotation_euler=(Vector((.25,0,.65))-cam.location).to_track_quat('-Z','Y').to_euler(); cam.data.type='ORTHO'; cam.data.ortho_scale=9.0
    scene=bpy.context.scene; scene.camera=cam; scene.render.engine='BLENDER_EEVEE'; scene.render.resolution_x=1500; scene.render.resolution_y=950; scene.render.resolution_percentage=100; scene.render.filepath=str(OUT/'review.png'); bpy.ops.render.render(write_still=True)
    # A second angle and close detail provide readable visual evidence for the small objects.
    cam.location=(-3,-5,3.6); cam.rotation_euler=(Vector((.15,0,.6))-cam.location).to_track_quat('-Z','Y').to_euler(); cam.data.ortho_scale=7.0
    scene.render.filepath=str(OUT/'review-reverse.png'); bpy.ops.render.render(write_still=True)
    cam.location=(-1.7,-3,2.2); cam.rotation_euler=(Vector((-.65,-.15,.3))-cam.location).to_track_quat('-Z','Y').to_euler(); cam.data.ortho_scale=2.6
    scene.render.filepath=str(OUT/'review-detail.png'); bpy.ops.render.render(write_still=True)
    cam.location=(-4,-3,2.0); cam.rotation_euler=(Vector((-2.35,.3,.5))-cam.location).to_track_quat('-Z','Y').to_euler(); cam.data.ortho_scale=1.4
    scene.render.filepath=str(OUT/'review-owl.png'); bpy.ops.render.render(write_still=True)
    cam.location=(4.3,-2.5,1.6); cam.rotation_euler=(Vector((2.9,0,.45))-cam.location).to_track_quat('-Z','Y').to_euler(); cam.data.ortho_scale=1.5
    scene.render.filepath=str(OUT/'review-broom.png'); bpy.ops.render.render(write_still=True)
    cam.location=(-5.4,-3.0,2.1); cam.rotation_euler=(Vector((-3.5,.25,1.25))-cam.location).to_track_quat('-Z','Y').to_euler(); cam.data.ortho_scale=4.1
    scene.render.filepath=str(OUT/'review-clock.png'); bpy.ops.render.render(write_still=True)
    cam.location=(-3.5,-3,1.84); cam.rotation_euler=(Vector((-3.5,.25,1.84))-cam.location).to_track_quat('-Z','Y').to_euler(); cam.data.ortho_scale=.95
    scene.render.filepath=str(OUT/'review-clock-face-1010.png'); bpy.ops.render.render(write_still=True)
    cam.location=(1.8,-4,2.1); cam.rotation_euler=(Vector((1.7,.35,1.2))-cam.location).to_track_quat('-Z','Y').to_euler(); cam.data.ortho_scale=4.1
    scene.render.filepath=str(OUT/'review-ward.png'); bpy.ops.render.render(write_still=True)
import shutil
shutil.copy2(OUT/'alchemy-kit.glb',RUNTIME/'alchemy-kit.glb')
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
report={'generator':'scripts/assets/build-alchemy-kit.py','authoring':'Original procedural Blender model, project brief; no external assets','blender':bpy.app.version_string,'license':'MIT, project-authored','axes':'glTF Y up; +Z front; metres','triangles':triangles,'roots':list(roots)+['ClockIngredientSocket'],'material_count':len({slot.material.name for o in bpy.context.scene.objects if o.type=='MESH' for slot in o.material_slots if slot.material}),'sha256':{'generator':digest(Path(__file__)),'blend':digest(SRC/'alchemy-kit.blend'),'glb':digest(RUNTIME/'alchemy-kit.glb')},'validation':'Blender GLB reimport, names, triangle budget and Mooncap stem contact checked','mooncap_overlap_metres':contact,'visual_approval':'pending owner and independent review','limitations':['Procedurally painted UV maps rather than high-to-low baked maps','No authored LODs or collision meshes','Runtime and play-distance review pending']}
if render_review: report['sha256']['review']=digest(OUT/'review.png')
(OUT/'report.json').write_text(json.dumps(report,indent=2)+'\n')
(SRC/'manifest.json').write_text(json.dumps({'glb_sha256':digest(RUNTIME/'alchemy-kit.glb'),'roots':list(roots)+['ClockIngredientSocket'],'triangles':triangles,'generator_sha256':digest(Path(__file__)),'source_blend_sha256':digest(SRC/'alchemy-kit.blend'),'visual_approval':'pending'},indent=2)+'\n')
print(json.dumps(report,indent=2))
