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
# Dining has its own PBR slots; other furnishing roots keep their historical materials.
def dining_pbr(name, prefix, metallic=0.0):
    mat=material(name,(1,1,1),metallic,1)
    nodes=mat.node_tree.nodes; links=mat.node_tree.links; shader=nodes.get('Principled BSDF')
    texdir=Path(__file__).resolve().parents[2]/'assets-source/props/interior-furnishings/textures'
    def image(channel, color_space):
        node=nodes.new('ShaderNodeTexImage'); node.image=bpy.data.images.load(str(texdir/f'{prefix}.{channel}.png'),check_existing=True)
        node.image.colorspace_settings.name=color_space; return node
    base=image('basecolor','sRGB'); links.new(base.outputs['Color'],shader.inputs['Base Color'])
    normal=image('normal','Non-Color'); normalmap=nodes.new('ShaderNodeNormalMap'); normalmap.inputs['Strength'].default_value=.32
    links.new(normal.outputs['Color'],normalmap.inputs['Color']); links.new(normalmap.outputs['Normal'],shader.inputs['Normal'])
    orm=image('orm','Non-Color'); separate=nodes.new('ShaderNodeSeparateColor'); links.new(orm.outputs['Color'],separate.inputs['Color'])
    links.new(separate.outputs['Green'],shader.inputs['Roughness']); links.new(separate.outputs['Blue'],shader.inputs['Metallic'])
    return mat

dining_wood=dining_pbr('DiningWalnut','dining-walnut')
dining_cloth=dining_pbr('DiningUpholstery','dining-claret')
dining_brass=material('DiningPolishedBrass',(.68,.43,.13),.9,.24)
MATS.extend([dining_wood,dining_cloth,dining_brass])

def dining_uv(obj):
    """Project grain along each component's longest tangent axis in local space."""
    mesh=obj.data; uv=mesh.uv_layers.active or mesh.uv_layers.new(name='UVMap')
    dims=[max(v.co[i] for v in mesh.vertices)-min(v.co[i] for v in mesh.vertices) for i in range(3)]
    for poly in mesh.polygons:
        normal=max(range(3),key=lambda i:abs(poly.normal[i])); tangent=[i for i in range(3) if i != normal]
        along=max(tangent,key=lambda i:dims[i]); across=next(i for i in tangent if i != along)
        for li in poly.loop_indices:
            pt=mesh.vertices[mesh.loops[li].vertex_index].co
            uv.data[li].uv=(pt[across]*2,pt[along]*2)


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

def oval(parent,name,loc,size,mat,segments=16,rings=8,smooth=False):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments,ring_count=rings,location=(0,0,0))
    o=bpy.context.object; o.name=name; o.parent=parent; o.location=loc; o.scale=size
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    o.data.materials.append(mat)
    if smooth:
        for poly in o.data.polygons: poly.use_smooth=True
    return o

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

# Vertex colors retain the subtle nap variation in the exported glTF material.
drape=material('WineVelvetNap',(1,1,1),0,.95)
attribute=drape.node_tree.nodes.new('ShaderNodeVertexColor'); attribute.layer_name='VelvetNap'
drape.node_tree.links.new(attribute.outputs['Color'],drape.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
MATS.append(drape)

def rope(parent,name,points,r,mat):
    curve=bpy.data.curves.new(name,'CURVE'); curve.dimensions='3D'; curve.resolution_u=12
    curve.bevel_depth=r; curve.bevel_resolution=3; curve.resolution_u=12
    spline=curve.splines.new('BEZIER'); spline.bezier_points.add(len(points)-1)
    for point,co in zip(spline.bezier_points,points):
        point.co=co; point.handle_left_type='AUTO'; point.handle_right_type='AUTO'
    ob=bpy.data.objects.new(name,curve); bpy.context.collection.objects.link(ob); ob.parent=parent
    ob.data.materials.append(mat); bpy.context.view_layer.objects.active=ob
    bpy.ops.object.select_all(action='DESELECT'); ob.select_set(True); bpy.ops.object.convert(target='MESH')
    for poly in ob.data.polygons: poly.use_smooth=True
    return ob

curtain=empty('Curtain'); cyl(curtain,'Curtain rod',(0,0,2.35),.022,2.12,brass,'X',verts=20)
for s in (-1,1):
    oval(curtain,'Rod finial',(s*1.08,0,2.35),(.075,.043,.043),brass)
    bar(curtain,'Rod wall bracket',(s*.98,0,2.35),(s*.98,.14,2.35),.017,brass,verts=12)
    cyl(curtain,'Wall mounting plate',(s*.98,.15,2.35),.055,.025,brass,'Y',verts=20)
    for x in (.49,.59,.69,.79,.89,.97):
        loop=torus(curtain,'Curtain ring',(s*x,0,2.35),.040,.007,brass)
        loop.rotation_euler[1]=math.pi/2
        bar(curtain,'Curtain tab',(s*x,-.005,2.315),(s*x,-.012,2.275),.009,velvet)
    # Curved gathered fabric, with a smooth change in width above and below the tie.
    rows,cols=32,48
    verts=[]; tones=[]
    for j in range(rows+1):
        v=j/rows; z=.18+2.10*v
        gather=math.exp(-((v-.39)/.21)**2)
        inner=.48+.19*gather+.035*(1-v)+(.012 if s>0 else -.012)
        outer=.99-.025*gather+.012*math.sin(v*2.7+s*.4)
        for i in range(cols+1):
            u=i/cols
            phase=math.tau*(3.15*u+.035*math.sin(v*4+s))
            wave=math.cos(phase)+.21*math.cos(phase*2+.65)
            amp=.040+.014*(1-gather)+.006*math.sin(v*3+u*4)
            x=s*(inner+(outer-inner)*u+.008*math.sin(v*4+u*8)*math.sin(math.pi*u))
            y=-.025-amp*wave-.015*math.sin(v*math.pi)
            hem=(1-v)**9*(.018*math.cos(phase+.2)+.008*math.sin(u*13+s))
            verts.append((x,y,z+hem))
            nap=.79+.12*math.cos(phase+.35)+.025*math.sin(v*19+u*37+s)+.015*math.sin(v*83+u*91)
            tones.append((.27*nap,.017*nap,.041*nap,1))
    faces=[]
    for j in range(rows):
        for i in range(cols):
            a=j*(cols+1)+i
            faces.append((a,a+1,a+cols+2,a+cols+1) if s>0 else (a+cols+1,a+cols+2,a+1,a))
    mesh=bpy.data.meshes.new('Curved velvet folds'); mesh.from_pydata(verts,[],faces); mesh.update()
    colors=mesh.color_attributes.new(name='VelvetNap',type='FLOAT_COLOR',domain='CORNER')
    for loop in mesh.loops: colors.data[loop.index].color=tones[loop.vertex_index]
    o=bpy.data.objects.new('Draped velvet panel',mesh); bpy.context.collection.objects.link(o); o.parent=curtain; o.data.materials.append(drape)
    for poly in mesh.polygons: poly.use_smooth=True
    solid=o.modifiers.new('Cloth thickness','SOLIDIFY'); solid.thickness=.008
    # A loop curves around the front of the gathered cloth and ends at a wall hook.
    hookx=s*1.065; hookz=1.00
    cyl(curtain,'Tieback wall rosette',(hookx,.15,hookz),.039,.025,brass,'Y',verts=20)
    rope(curtain,'Wall hook',[(hookx,.135,hookz),(hookx,.075,hookz),(s*1.045,.03,hookz-.025)],.008,brass)
    rope(curtain,'Gathered tieback',[(s*.68,-.055,1.015),(s*.72,-.115,.985),(s*.86,-.13,.972),(s*.98,-.08,.985),(s*1.045,.03,.975)],.012,brass)
    rope(curtain,'Tassel cord',[(s*.78,-.13,.985),(s*.80,-.14,.92),(s*.79,-.14,.86)],.006,brass)
    oval(curtain,'Tassel knot',(s*.79,-.14,.855),(.018,.016,.023),brass)
    cyl(curtain,'Tassel skirt',(s*.79,-.14,.805),.028,.085,brass,verts=16,r2=.015)
    oval(curtain,'Tassel tip',(s*.79,-.14,.76),(.026,.016,.012),brass)

chair=empty('DiningChair')
for x in (-.23,.23):
    for y in (-.20,.20):
        bar(chair,'Tapered leg',(x,y,.002),(x*.9,y*.9,.49),.035,dining_wood)
    bar(chair,'Back upright',(x,.19,.42),(x,.21,1.05),.035,dining_wood)
cube(chair,'Carved seat', (0,0,.48),(.56,.50,.10),dining_wood,.035); cube(chair,'Velvet cushion',(0,-.015,.55),(.46,.40,.075),dining_cloth,.045)
cube(chair,'Crest rail',(0,.21,1.04),(.55,.07,.10),dining_wood,.025)
cube(chair,'Back velvet',(0,.20,.81),(.40,.055,.37),dining_cloth,.035)
for x in (-.12,0,.12): cyl(chair,'Back button',(x,.16,.81),.014,.012,dining_brass,'Y',8)
for x in (-.23,.23):
    for y in (-.20,.20):
        cyl(chair,'Leg collar',(x*.94,y*.94,.16),.039,.035,dining_wood,verts=10)
        cyl(chair,'Brass foot',(x,y,.023),.038,.045,dining_brass,verts=10)
for x in (-.22,.22): bar(chair,'Seat piping',(x,-.21,.574),(x,.18,.574),.006,dining_cloth)
for x in (-.19,0,.19): cyl(chair,'Seat tack',(x,-.235,.53),.009,.008,dining_brass,'Y',8)
bar(chair,'Seat front moulding',(-.24,-.241,.48),(.24,-.241,.48),.009,dining_brass)

table=empty('DiningTable')
for y in (-.294,0,.294): cube(table,'Tabletop plank',(0,y,.79),(1.75,.292,.10),dining_wood,.01)
cube(table,'Apron',(0,0,.68),(1.57,.70,.18),dining_wood,.022)
for x in (-.70,.70):
    for y in (-.30,.30):
        cyl(table,'Turned foot',(x,y,.09),.055,.18,dining_wood,verts=10,r2=.04)
        cyl(table,'Turned leg',(x,y,.43),.045,.55,dining_wood,verts=10,r2=.07)
        torus(table,'Leg collar',(x,y,.64),.055,.009,dining_brass)
for x in (-.75,.75): cube(table,'Top end trim',(x,0,.848),(.018,.78,.007),dining_brass)
for y in (-.35,.35):
    cube(table,'Apron moulding',(0,y,.67),(1.42,.018,.025),dining_wood,.007)
    for x in (-.50,0,.50): cyl(table,'Apron pin',(x,y*1.035,.67),.013,.012,dining_brass,'Y',8)
for x in (-.70,.70):
    for y in (-.30,.30):
        torus(table,'Foot band',(x,y,.10),.05,.008,dining_brass)
        cyl(table,'Leg turning',(x,y,.46),.066,.09,dining_wood,verts=10,r2=.05)

for ob in list(bpy.context.scene.objects):
    if ob.type=='MESH' and ob.parent in (chair,table): dining_uv(ob)

book=empty('Bookcase')
cube(book,'Cabinet plinth',(0,0,.055),(1.50,.42,.11),wood,.015)
for x in (-.70,.70): cube(book,'Cabinet side',(x,0,1.10),(.10,.36,2.2),wood,.015)
for z in (.06,.57,1.08,1.59,2.14): cube(book,'Shelf',(0,0,z),(1.45,.38,.09),wood2,.015)
cube(book,'Back',(0,.17,1.10),(1.34,.035,2.05),wood)
cube(book,'Crown',(0,0,2.24),(1.56,.46,.12),wood2,.025)
cube(book,'Lower compartment',(0,.14,.32),(1.28,.025,.40),iron)
for x in (-.64,.64): cube(book,'Cabinet door side rebate',(x,-.182,.315),(.04,.05,.42),wood2)
cube(book,'Cabinet door top rebate',(0,-.182,.52),(1.30,.05,.025),wood2)
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
slider=empty('Bookcase_Slider',book,(0,-.23,0))
door=cube(slider,'Cabinet door',(0,0,.315),(1.30,.045,.42),wood2,.005)
inset=cube(slider,'Cabinet door inset',(0,-.03,.315),(1.12,.02,.29),wood,.008)
lock=cube(slider,'Lock escutcheon',(0,-.043,.31),(.075,.008,.09),brass,.006)
round_cut=cyl(slider,'Keyhole round cutter',(0,-.02,.32),.012,.15,iron,'Y',verts=24)
stem_cut=cube(slider,'Keyhole stem cutter',(0,-.02,.301),(.012,.15,.027),iron)
bpy.context.view_layer.update()
for target in (door,inset,lock):
    for cutter in (round_cut,stem_cut):
        modifier=target.modifiers.new('Keyhole','BOOLEAN'); modifier.operation='DIFFERENCE'; modifier.object=cutter
        bpy.context.view_layer.objects.active=target; bpy.ops.object.modifier_apply(modifier=modifier.name)
    for face in target.data.polygons: face.material_index=0
    while len(target.data.materials)>1: target.data.materials.pop(index=1)
for cutter in (round_cut,stem_cut): bpy.data.objects.remove(cutter,do_unlink=True)
pull=empty('Bookcase_PullBook',book,(-.08,-.05,1.31)); book_uv(cube(pull,'Book pages',(0,.015,0),(.082,.17,.275),bindings,.003),0,3,0,1)
for dx in (-.047,.047): book_uv(cube(pull,'Red cover',(dx,.015,0),(.009,.20,.30),bindings,.002),0,2,1,2)
book_uv(cube(pull,'Red spine',(0,-.085,0),(.103,.02,.30),bindings,.004),0,0,0,2)
for z in (-.10,.1): cube(pull,'Gilt line',(0,-.097,z),(.09,.006,.01),brass)
cube(pull,'Red ribbon',(0,-.098,.064),(.018,.005,.16),velvet,.001)
for y in (-.04,.01,.06): cube(pull,'Page edge',(0,y,.14),(.074,.003,.003),ivory)

def turned(
    parent: bpy.types.Object,
    name: str,
    center: tuple[float, float],
    profile: list[tuple[float, float]],
    mat: bpy.types.Material,
    segments: int = 16,
    cap_top: bool = False,
) -> bpy.types.Object:
    vertices = [
        (
            center[0] + r * math.cos(math.tau * i / segments),
            center[1] + r * math.sin(math.tau * i / segments),
            z,
        )
        for z, r in profile
        for i in range(segments)
    ]
    faces = [
        (
            j * segments + i,
            j * segments + (i + 1) % segments,
            (j + 1) * segments + (i + 1) % segments,
            (j + 1) * segments + i,
        )
        for j in range(len(profile) - 1)
        for i in range(segments)
    ]
    if cap_top:
        faces.append(tuple((len(profile) - 1) * segments + i for i in range(segments)))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    ob = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(ob)
    ob.parent = parent
    mesh.materials.append(mat)
    for face in mesh.polygons:
        face.use_smooth = (
            len(face.vertices) == 4
            and profile[face.index // segments][0]
            != profile[face.index // segments + 1][0]
        )
    return ob


def curved_candle_arm(parent: bpy.types.Object, angle: float) -> None:
    direction = Vector((math.cos(angle), math.sin(angle), 0))
    side = Vector((-math.sin(angle), math.cos(angle), 0))
    path = []
    for j in range(9):
        t = j / 8
        u = 1 - t
        path.append(
            (
                3 * u * u * t * 0.19 + 3 * u * t * t * 0.31 + t * t * t * 0.31,
                u * u * u * 0.56
                + 3 * u * u * t * 0.56
                + 3 * u * t * t * 0.58
                + t * t * t * 0.76,
            )
        )
    segments = 10
    vertices = []
    for j, (radius, z) in enumerate(path):
        before = path[max(0, j - 1)]
        after = path[min(len(path) - 1, j + 1)]
        tangent = (
            direction * (after[0] - before[0]) + Vector((0, 0, after[1] - before[1]))
        ).normalized()
        up = tangent.cross(side)
        center = direction * radius + Vector((0, 0, z))
        vertices.extend(
            center
            + 0.022
            * (
                side * math.cos(math.tau * i / segments)
                + up * math.sin(math.tau * i / segments)
            )
            for i in range(segments)
        )
    faces = [
        (
            j * segments + i,
            j * segments + (i + 1) % segments,
            (j + 1) * segments + (i + 1) % segments,
            (j + 1) * segments + i,
        )
        for j in range(len(path) - 1)
        for i in range(segments)
    ]
    mesh = bpy.data.meshes.new("Curved arm")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    ob = bpy.data.objects.new("Curved arm", mesh)
    bpy.context.collection.objects.link(ob)
    ob.parent = parent
    mesh.materials.append(iron)
    for face in mesh.polygons:
        face.use_smooth = True


candle = empty("Candelabrum")
turned(
    candle, "Weighted base", (0, 0), [(0, 0.24), (0.07, 0.19)], iron, 24, cap_top=True
)
turned(
    candle,
    "Base rim",
    (0, 0),
    [(0.061, 0.17), (0.075, 0.184), (0.089, 0.17)],
    brass,
    32,
)
turned(candle, "Stem", (0, 0), [(0.069, 0.035), (0.78, 0.035)], brass)
turned(
    candle,
    "Stem collar",
    (0, 0),
    [(0.43, 0.034), (0.43, 0.065), (0.51, 0.065), (0.51, 0.034)],
    iron,
    12,
)
for i in range(5):
    ang = i * 2 * math.pi / 5
    x = 0.31 * math.cos(ang)
    y = 0.31 * math.sin(ang)
    curved_candle_arm(candle, ang)
    turned(
        candle,
        "Candle cup",
        (x, y),
        [(0.7575, 0.020), (0.7575, 0.055), (0.8225, 0.043), (0.8225, 0.025)],
        brass,
    )
    turned(
        candle,
        "Wax candle",
        (x, y),
        [(0.805, 0.026), (0.975, 0.026)],
        ivory,
        12,
        cap_top=True,
    )
    empty("Candelabrum_FlameSocket_%02d" % (i + 1), candle, (x, y, 0.985))
turned(
    candle,
    "Center candle cup",
    (0, 0),
    [(0.775, 0.034), (0.775, 0.055), (0.845, 0.055), (0.845, 0.025)],
    brass,
)
turned(
    candle,
    "Center candle",
    (0, 0),
    [(0.83, 0.026), (0.99, 0.026)],
    ivory,
    12,
    cap_top=True,
)
empty("Candelabrum_FlameSocket_00", candle, (0, 0, 1.0))

clock=empty('WallClock'); cyl(clock,'Turned round clock case',(0,-.035,.46),.275,.07,wood,'Y',32)
torus(clock,'Turned clock rim',(0,-.075,.46),.255,.012,wood2,'Y')
torus(clock,'Clock brass bead',(0,-.086,.46),.238,.006,brass,'Y')
cyl(clock,'Dial rim',(0,-.09,.46),.225,.055,brass,'Y',32); cyl(clock,'Dial',(0,-.125,.46),.19,.02,ivory,'Y',32)
for i in range(12):
    a=i*math.tau/12; cyl(clock,'Hour marker',(.165*math.sin(a),-.14,.46+.165*math.cos(a)),.009,.008,iron,'Y',8)
for name,length,width,ang in [('WallClock_HourHand',.10,.018,-.7),('WallClock_MinuteHand',.15,.012,.5)]:
    pivot=empty(name,clock,(0,-.155,.46)); pivot.rotation_euler[1]=ang; cube(pivot,'Clock hand',(0,0,length/2),(width,.012,length),iron,.004)
sh=empty('WallClock_Shutter',clock,(-.26,-.14,.42))

def armor_oval(parent,name,loc,size,mat):
    return oval(parent,name,loc,size,mat,segments=24 if 'Pauldron' in name or 'pauldron' in name else 20,rings=12 if 'Pauldron' in name or 'pauldron' in name else 10,smooth=True)

def armor_pauldron(parent,side):
    center=Vector((side*.015,0,-.005)); radii=Vector((.145,.15,.12))
    armor_oval(parent,'Rounded pauldron',center,radii,brass)
    segments, rings=32, 8
    verts=[]
    for row in range(rings+1):
        theta=.002+(1.38-.002)*row/rings
        for col in range(segments):
            phi=math.tau*col/segments
            verts.append(center+Vector((1.008*radii.x*math.sin(theta)*math.cos(phi),1.008*radii.y*math.sin(theta)*math.sin(phi),1.008*radii.z*math.cos(theta))))
    faces=[]
    for row in range(rings):
        for col in range(segments):
            a=row*segments+col; b=row*segments+(col+1)%segments
            faces.append((a,b,b+segments,a+segments))
    mesh=bpy.data.meshes.new('Pauldron inset'); mesh.from_pydata(verts,[],faces); mesh.update()
    ob=bpy.data.objects.new('Pauldron inset',mesh); bpy.context.collection.objects.link(ob); ob.parent=parent; ob.data.materials.append(iron)
    for poly in mesh.polygons: poly.use_smooth=True

def armor_joint(parent,name,loc,r,depth,mat,axis):
    ob=cyl(parent,name,loc,r,depth,mat,axis,20)
    bevel=ob.modifiers.new('Rounded plate edge','BEVEL'); bevel.width=.008; bevel.segments=3
    bpy.context.view_layer.objects.active=ob; bpy.ops.object.modifier_apply(modifier=bevel.name)
    for poly in ob.data.polygons:
        poly.use_smooth=len(poly.vertices)==4
    return ob

def armor_bar(parent,name,a,b,r,mat):
    ob=bar(parent,name,a,b,r,mat,verts=12)
    for poly in ob.data.polygons:
        poly.use_smooth=len(poly.vertices)==4
    return ob

armor=empty('ClockworkArmor'); cyl(armor,'Stand foot',(0,0,.035),.30,.07,iron,verts=16,r2=.24); cyl(armor,'Stand post',(0,.055,.8),.035,1.5,iron)
for s in (-1,1):
    # Greaves and sabatons taper toward articulated knee and ankle joints.
    armor_oval(armor,'Greave',(s*.15,-.012,.40),(.095,.105,.31),iron)
    armor_oval(armor,'Sabatons',(s*.15,-.065,.12),(.105,.17,.065),iron)
    armor_bar(armor,'Greave ridge',(s*.15,-.118,.17),(s*.15,-.102,.65),.012,brass)
    armor_joint(armor,'Knee joint',(s*.15,-.012,.73),.085,.15,iron,'Y')
    armor_oval(armor,'Knee cap',(s*.15,-.10,.73),(.105,.052,.095),brass)
    armor_oval(armor,'Thigh plate',(s*.15,0,.91),(.115,.115,.20),iron)
    for z in (.27,.53): armor_bar(armor,'Greave edge',(s*.08,-.073,z),(s*.22,-.073,z),.009,brass)
    arm=empty('ClockworkArmor_%sArm'%('Left' if s<0 else 'Right'),armor,(s*.31,0,1.46))
    armor_pauldron(arm,s)
    armor_oval(arm,'Upper arm',(s*.045,0,-.19),(.07,.08,.19),iron)
    armor_joint(arm,'Elbow pivot',(s*.09,0,-.34),.072,.14,brass,'Y')
    armor_oval(arm,'Forearm vambrace',(s*.115,-.015,-.48),(.073,.082,.15),iron)
    armor_bar(arm,'Vambrace ridge',(s*.10,-.097,-.36),(s*.13,-.097,-.58),.01,brass)
    armor_oval(arm,'Gauntlet',(s*.13,-.03,-.635),(.063,.075,.09),iron)
    for z in (-.60,-.65,-.69): armor_bar(arm,'Finger guard',(s*.07,-.097,z),(s*.18,-.097,z),.008,brass)
# Layered silhouette and raised central ridge read as shaped steel rather than a box.
armor_oval(armor,'Breastplate',(0,0,1.27),(.265,.17,.30),iron)
armor_bar(armor,'Breastplate central ridge',(0,-.18,1.05),(0,-.155,1.52),.018,brass)
for s in (-1,1):
    armor_bar(armor,'Breastplate upper edging',(0,-.15,1.50),(s*.215,-.105,1.43),.012,brass)
    armor_bar(armor,'Breastplate side edging',(s*.215,-.105,1.43),(s*.19,-.12,1.13),.012,brass)
    for z in (1.15,1.23,1.31): cyl(armor,'Breastplate rivet',(s*.175,-.124,z),.011,.015,brass,'Y',8)
for z,w in [(1.06,.46),(1.00,.43),(.94,.40)]:
    cube(armor,'Overlapping fauld',(0,-.075,z),(w,.16,.065),iron,.02)
    armor_bar(armor,'Fauld edge',(-w*.46,-.16,z-.027),(w*.46,-.16,z-.027),.008,brass)
head=empty('ClockworkArmor_Head',armor,(0,0,1.61)); armor_oval(head,'Helmet dome',(0,0,.09),(.15,.13,.155),iron)
torus(head,'Helmet crown band',(0,0,.19),.113,.01,brass)
visor=empty('ClockworkArmor_Visor',head,(-.14,-.08,.17)); guard=armor_oval(visor,'Face guard',(.14,-.055,-.035),(.14,.075,.105),iron)
def visor_strip(name,z,half_width,height,material):
    # Follow the face guard instead of spanning its curved surface in a straight line.
    steps=8; vertices=[]
    for offset in (.006,-.004):
        for dz in (-height/2,height/2):
            for i in range(steps+1):
                dx=half_width*(2*i/steps-1)
                hit, point, _, _ = guard.ray_cast(Vector((dx,-1,z+dz+.035)),Vector((0,1,0)))
                if not hit: raise RuntimeError('Visor strip missed face guard')
                vertices.append((.14+dx,guard.location.y+point.y-offset,z+dz))
    n=steps+1; faces=[]
    for i in range(steps):
        faces.extend([(i,i+1,n+i+1,n+i),
                      (i,2*n+i,2*n+i+1,i+1),(n+i,n+i+1,3*n+i+1,3*n+i)])
    faces.extend([(0,n,3*n,2*n),(steps,2*n+steps,3*n+steps,n+steps)])
    mesh=bpy.data.meshes.new(name); mesh.from_pydata(vertices,[],faces); mesh.update()
    obj=bpy.data.objects.new(name,mesh); bpy.context.collection.objects.link(obj); obj.parent=visor; obj.data.materials.append(material)
for z in (-.055,-.015): visor_strip('Eye slit',z,.085,.012,enamel)
visor_strip('Visor brow',.025,.095,.014,brass)
for x in (.06,.10,.14,.18,.22):
    hit, point, normal, _ = guard.ray_cast(Vector((x-.14,-1,-.055)),Vector((0,1,0)))
    if not hit: raise RuntimeError('Visor rivet missed face guard')
    rivet=cyl(visor,'Visor rivet',guard.location+point+normal*.002,.007,.012,brass,verts=8)
    rivet.rotation_euler=normal.to_track_quat('Z','Y').to_euler()

painting=empty('FramedPainting'); cube(painting,'Canvas',(0,-.054,.50),(.78,.035,.80),cloth,.001)
backing=material('PictureBacking',(.65,.53,.36),0,.95); MATS.append(backing)
cube(painting,'Canvas backing',(0,-.030,.50),(.98,.04,1.00),backing)
# Nested mitred contours form a deep, carved molding without crossing the image aperture.
profile=[(.470,-.075),(.480,-.085),(.489,-.084),(.495,-.067),
         (.505,-.064),(.515,-.075),(.525,-.094),(.538,-.105),
         (.550,-.103),(.558,-.089),(.567,-.065),(.578,-.055),
         (.590,-.060),(.600,-.045),(.600,.012)]
verts=[]
for r,y in profile:
    x=.38+(r-.470); z=.39+(r-.470)
    verts.extend([(-x,y,.50-z),(x,y,.50-z),(x,y,.50+z),(-x,y,.50+z)])
faces=[]
for j in range(len(profile)-1):
    for i in range(4): faces.append((j*4+i,j*4+(i+1)%4,(j+1)*4+(i+1)%4,(j+1)*4+i))
mesh=bpy.data.meshes.new('Mitred ogee molding');mesh.from_pydata(verts,[],faces);mesh.update()
o=bpy.data.objects.new('Carved walnut molding',mesh);bpy.context.collection.objects.link(o);o.parent=painting
for m in (wood,wood2,brass): mesh.materials.append(m)
for poly in mesh.polygons:
    band=poly.index//4; poly.material_index=2 if band in (0,1,2) else (1 if band in (3,4,8,9,10,11) else 0)
# Corner florets and paired diagonal leaves remain entirely outside the aperture.
for sx in (-1,1):
    for sz in (-1,1):
        x=sx*.458; z=.50+sz*.468
        cyl(painting,'Corner rosette',(x,-.111,z),.030,.012,brass,'Y',verts=20)
        for k in range(8):
            t=math.tau*k/8
            oval(painting,'Rosette petal',(x+.019*math.cos(t),-.119,z+.019*math.sin(t)),(.010,.006,.010),wood2)
        oval(painting,'Rosette center',(x,-.124,z),(.009,.006,.009),brass)
        for dx,dz in ((-.039,0),(0,-.039)):
            leaf=oval(painting,'Carved corner leaf',(x+sx*dx,-.106,z+sz*dz),(.025,.009,.012) if dz==0 else (.012,.009,.025),wood2)
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
bpy.ops.file.pack_all()
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
    root_triangles=0
    for ob in meshes:
        root_triangles+=sum(len(p.vertices)-2 for p in ob.data.polygons)
        points += [root.matrix_world.inverted() @ ob.matrix_world @ v.co for v in ob.data.vertices]
    triangles+=root_triangles
    if not points: raise RuntimeError('Empty root '+n)
    lo=[min(p[i] for p in points) for i in (0,2,1)]; hi=[max(p[i] for p in points) for i in (0,2,1)]
    lo[2],hi[2]=-hi[2],-lo[2]
    report['roots'][n]={'dimensions_m':[round(hi[i]-lo[i],3) for i in range(3)],'bounds_min':[round(v,3) for v in lo],'bounds_max':[round(v,3) for v in hi],'mesh_count':len(meshes),'triangles':root_triangles}
report['triangles']=triangles; report['size_bytes']=staged.stat().st_size
candle_extra=max(0,report['roots']['Candelabrum']['triangles']-1156)
report['candelabrum_extra_triangles']=candle_extra
if candle_extra>750 or triangles-candle_extra>60000 or triangles>60750 or staged.stat().st_size>8_000_000:
    raise RuntimeError('Kit budget exceeded: %d triangles (%d candelabrum extra), %d bytes' % (triangles,candle_extra,staged.stat().st_size))
assert not any(o.type in {'CAMERA','LIGHT'} for o in bpy.context.scene.objects)
os.replace(staged,PUB/'interior-furnishings.glb')
report['sha256']=hashlib.sha256((PUB/'interior-furnishings.glb').read_bytes()).hexdigest()
(SRC/'interior-furnishings.report.json').write_text(json.dumps(report,indent=2)+'\n')
provenance_path=SRC/'provenance.json'
previous=json.loads(provenance_path.read_text()) if provenance_path.exists() else {}
provenance={'author':'Original procedural Blender modeling','license':'MIT','source':'interior-furnishings.blend','generator':'scripts/assets/build-interior-furnishings.py','output':'public/assets/props/interior-furnishings/interior-furnishings.glb','blender':bpy.app.version_string,'glb_sha256':report['sha256'],'blend_sha256':hashlib.sha256((SRC/'interior-furnishings.blend').read_bytes()).hexdigest(),'generator_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'approval':'Revised geometry reimported and checked. Final independent review and owner visual acceptance pending.'}
for key in ('historicalReview', 'previousVerification', 'verification', 'dining_revision', 'visor_revision', 'candelabrum_revision'):
    if key in previous:
        provenance[key] = previous[key]
provenance_path.write_text(json.dumps(provenance,indent=2)+'\n')
print('KIT_REPORT',json.dumps(report))
