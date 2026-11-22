"""Build, reimport and photograph the static Trellis Keeper candidate in Blender."""
import hashlib
import json
import math
from pathlib import Path

import bpy
from mathutils import Vector

OUT = Path(__file__).resolve().parents[2] / "assets-source/enemies/trellis-keeper/staging/base"
OUT.mkdir(parents=True, exist_ok=True)
STEM = "trellis-keeper-base"
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.name = "Trellis Keeper • neutral assembly"
scene.unit_settings.system = "METRIC"
bpy.context.preferences.filepaths.save_version = 0


def material(name, rgb, metal, rough, emission=0):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1)
    m.use_nodes = True
    shader = m.node_tree.nodes.get("Principled BSDF")
    for key, val in [("Base Color", (*rgb, 1)), ("Metallic", metal), ("Roughness", rough),
                     ("Emission Color", (*rgb, 1)), ("Emission Strength", emission)]:
        shader.inputs[key].default_value = val
    return m


brass = material("aged-brass", (.39, .200, .054), .79, .34)
steel = material("armor-steel", (.058, .052, .048), .83, .35)
green = material("emerald-inlay", (.012, .18, .068), .38, .19)
amber = material("amber-core", (.92, .173, .006), .18, .33, .44)


def pivot(name, pos, parent=None):
    obj = bpy.data.objects.new(name, None)
    scene.collection.objects.link(obj)
    obj.parent = parent
    obj["rest_origin"] = list(pos)
    obj.location = Vector(pos) - (Vector(parent["rest_origin"]) if parent else Vector((0, 0, 0)))
    obj.empty_display_size = .024
    return obj


def solid(name, rings, mat, parent, smooth=True):
    """Skin a series of equal-sized counterclockwise sections with closed ends."""
    n = len(rings[0])
    origin = Vector(parent["rest_origin"])
    vertices = [Vector(v) - origin for ring in rings for v in ring]
    faces = [tuple(reversed(range(n)))]
    for i in range(len(rings) - 1):
        faces.extend((i*n+j, i*n+(j+1)%n, (i+1)*n+(j+1)%n, (i+1)*n+j) for j in range(n))
    faces.append(tuple(range(len(vertices)-n, len(vertices))))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    obj.parent = parent
    mesh.materials.append(mat)
    for face in list(mesh.polygons)[1:-1]:
        face.use_smooth = smooth
    return obj


def lathe(name, a, b, profile, mat, parent, n=24, flutes=0):
    start, end = Vector(a), Vector(b)
    axis = (end-start).normalized()
    guide = Vector((1,0,0)) if abs(axis.x)<.9 else Vector((0,1,0))
    v = axis.cross(guide).normalized()
    u = v.cross(axis)
    rings = []
    for t, x, y in profile:
        center = start.lerp(end, t)
        ring = []
        for j in range(n):
            angle = math.tau*j/n
            groove = 1 + flutes*math.cos(6*angle+.8*t)
            ring.append(center + groove*(u*x*math.cos(angle)+v*y*math.sin(angle)))
        rings.append(ring)
    return solid(name, rings, mat, parent)


def ribbon(name, path, thickness, mat, parent):
    """Crowned, chamfered metal strip of changing width following the XZ design."""
    sections = []
    for i, (x,y,z,w) in enumerate(path):
        a, b = path[max(i-1,0)], path[min(i+1,len(path)-1)]
        across = Vector((b[2]-a[2],0,a[0]-b[0])).normalized()
        center = Vector((x,y,z))
        sections.append([center + across*(w*f) + Vector((0, thickness*d, 0))
                         for f,d in [(-.8,-1),(.8,-1),(1,-.45),(1,.4),(.74,.85),(0,1.1),(-.74,.85),(-1,.4),(-1,-.45)]])
    return solid(name, sections, mat, parent, False)


def fitting(name, pos, end, radius, mat, parent):
    return lathe(name,pos,end,[(0,radius*.78,radius*.78),(.14,radius,radius),
                              (.83,radius,radius),(1,radius*.78,radius*.78)],mat,parent)


def hinge(name, pos, side, radius, parent):
    x,y,z=pos
    a=(x-side*radius*.74,y,z)
    b=(x+side*radius*.74,y,z)
    fitting(name+"-axle",a,b,radius,steel,parent)
    tip=(x+side*radius*.99,y,z)
    fitting(name+"-collar",b,tip,radius*.87,brass,parent)
    fitting(name+"-inlay",tip,(tip[0]+side*.006,y,z),radius*.45,green,parent)


actor=pivot("trellis-keeper",(0,0,0))
hips=pivot("hips",(0,0,.88),actor)
lathe("pelvis-casting",(0,0,.845),(0,0,1.01),[(0,.052,.051),(.13,.085,.059),(.68,.126,.09),(.9,.139,.095),(1,.135,.09)],brass,hips)
torso=pivot("torso-frame",(0,0,.97),hips)
head=pivot("head",(0,0,1.565),torso)
core=pivot("seed-pod",(0,0,1.16),torso)
lathe("pod-six-lobed-glass",(0,0,1.055),(0,0,1.292),[(0,.01,.01),(.1,.033,.03),(.27,.055,.051),(.49,.064,.059),(.67,.06,.054),(.84,.044,.039),(1,.009,.009)],amber,core,48,.07)
glass = bpy.data.objects["pod-six-lobed-glass"].data
husk = glass.color_attributes.new(name="Husk",type="FLOAT_COLOR",domain="POINT")
for i, value in enumerate(husk.data):
    t=(i//48)/6
    angle=math.tau*(i%48)/48
    ribs=.5+.5*math.cos(12*angle+1.4*math.sin(t*math.pi))
    warmth=.48*math.sin(math.pi*t)**.7 + .40*ribs**5
    value.color=(.48+.46*warmth,.055+.47*warmth,.006+.035*warmth,1)
tint=amber.node_tree.nodes.new("ShaderNodeVertexColor")
tint.layer_name="Husk"
shader=amber.node_tree.nodes.get("Principled BSDF")
amber.node_tree.links.new(tint.outputs["Color"],shader.inputs["Base Color"])
for tag,z1,z2,r in [("calyx",1.016,1.077,.043),("pedicel",1.277,1.33,.037)]:
    lathe("pod-"+tag,(0,0,z1),(0,0,z2),[(0,r*.44,r*.44),(.23,r,r),(.44,r,r),(.55,r*.62,r*.62),(1,r*.45,r*.45)],brass,core)
for i in range(6):
    angle=math.tau*i/6
    path=[]
    for t,r in [(0,.012),(.18,.049),(.45,.066),(.70,.061),(.88,.039),(1,.013)]:
        th=angle+.27*t
        path.append((r*math.cos(th),r*.91*math.sin(th),1.06+.228*t,.0028))
    ribbon("pod-vein-"+str(i),path,.0028,brass,core)
for face,y in [("facade",.073),("back",-.073)]:
    for side in (-1,1):
        def rib(name, points, depth=.012):
            ribbon(face+"-"+name+str(side),[(side*x,y,z,w) for x,z,w in points],depth,brass,torso)
        rib("upright",[(.123,.967,.018),(.13,1.03,.013),(.13,1.40,.012),(.122,1.48,.017),(.08,1.52,.020),(0,1.549,.012)])
        rib("ogive",[(.122,1.073,.008),(.125,1.226,.01),(.115,1.30,.013),(.089,1.354,.013),(.048,1.401,.012),(0,1.433,.011)])
        rib("sill",[(.128,1.055,.008),(.101,1.027,.01),(.056,1.008,.01),(0,1.005,.01)])
        rib("crown",[(.123,1.405,.012),(.09,1.447,.017),(.044,1.477,.019),(0,1.51,.014)])
for s in (-1,1):
    fitting("frame-anchor-"+str(s),(s*.126,-.079,1.409),(s*.126,.079,1.409),.032,steel,torso)
    fitting("lower-anchor-"+str(s),(s*.124,-.075,.988),(s*.124,.075,.988),.020,steel,torso)
    ribbon("back-diagonal-"+str(s),[(s*.118,-.079,1.037,.008),(s*.071,-.09,1.158,.008),(0,-.08,1.235,.006)],.008,brass,torso)
fitting("yoke-saddle",(0,-.081,1.535),(0,.081,1.535),.029,brass,torso)
for side in (-1,1):
    ribbon("pelvis-fan-"+str(side),[(side*.109,.052,.981,.012),(side*.076,.080,.956,.015),(side*.042,.085,.927,.014),(side*.016,.069,.885,.006)],.005,steel,hips)
    ribbon("pelvis-keel-"+str(side),[(side*.007,.092,.98,.007),(side*.010,.09,.95,.008),(side*.009,.080,.918,.005),(side*.003,.062,.872,.003)],.005,brass,hips)
lathe("neck-gaiter",(0,0,1.51),(0,0,1.61),[(0,.053,.045),(.2,.044,.040),(.33,.05,.045),(.45,.04,.038),(.65,.048,.043),(.83,.037,.036),(1,.039,.038)],steel,head)
lathe("helmet-crown",(0,0,1.672),(0,0,1.75),[(0,.077,.072),(.09,.080,.075),(.19,.078,.074),(.52,.068,.068),(.80,.052,.053),(.95,.029,.032),(1,.016,.020)],brass,head,32)
lathe("visor-dark-housing",(0,0,1.635),(0,0,1.681),[(0,.061,.060),(.30,.070,.071),(.65,.076,.075),(1,.074,.069)],steel,head,32)
lathe("chin-casting",(0,0,1.565),(0,0,1.653),[(0,.029,.032),(.16,.040,.048),(.55,.058,.061),(.92,.068,.072),(1,.069,.073)],brass,head,32)
for s in (-1,1):
    ribbon("visor-lens-"+str(s),[(s*.003,.077,1.663,.0057),(s*.025,.076,1.664,.0063),(s*.05,.062,1.663,.0048),(s*.064,.046,1.661,.002)],.0034,amber,head)
    ribbon("jaw-vent-"+str(s),[(s*.009,.063,1.626,.002),(s*.007,.061,1.610,.0025),(s*.005,.054,1.596,.001)],.0028,steel,head)
    ribbon("cuirass-leaf-"+str(s),[(0,.082,1.532,.009),(s*.031,.085,1.510,.020),(s*.064,.085,1.474,.019),(s*.095,.084,1.430,.012),(s*.117,.083,1.399,.003)],.011,brass,torso)
    ribbon("cuirass-engraving-"+str(s),[(s*.010,.094,1.523,.0015),(s*.027,.097,1.508,.003),(s*.061,.097,1.467,.002),(s*.077,.095,1.448,.001)],.002,steel,torso)
    ribbon("spine-crown-"+str(s),[(s*.12,-.075,1.434,.013),(s*.080,-.080,1.48,.018),(s*.016,-.077,1.532,.012)],.009,steel,torso)
lathe("pedicel-suspension",(0,0,1.31),(0,0,1.45),[(0,.019,.020),(.07,.024,.024),(.14,.017,.017),(.83,.012,.012),(1,.024,.020)],steel,core)
fitting("arch-crossmember",(0,-.077,1.436),(0,.075,1.436),.019,brass,torso)
lathe("calyx-pedestal",(0,0,.975),(0,0,1.045),[(0,.048,.047),(.20,.052,.049),(.30,.033,.033),(.75,.024,.024),(1,.029,.03)],steel,torso)
for s in (-1,1):
    ribbon("visor-cheek-"+str(s),[(s*.068,.034,1.666,.011),(s*.059,.053,1.633,.013),(s*.030,.056,1.601,.010),(s*.018,.055,1.58,.005)],.012,brass,head)
    hinge("temple-"+str(s),(s*.063,0,1.658),s,.031,head)

for s,side in [(-1,"left"),(1,"right")]:
    def p(x,y,z):
        return (s*x,y,z)
    shoulder=p(.177,0,1.427)
    elbow=p(.277,.022,1.187)
    wrist=p(.377,.064,.946)
    shoulder_joint=pivot("shoulder-"+side,shoulder,torso)
    elbow_joint=pivot("elbow-"+side,elbow,shoulder_joint)
    tool=pivot("forearm-tool-"+side,wrist,elbow_joint)
    hinge(side+"-shoulder",shoulder,s,.054,shoulder_joint)
    lathe(side+"-humerus",shoulder,elbow,[(0,.027,.029),(.11,.045,.046),(.24,.042,.04),(.3,.026,.028),(.82,.025,.025),(.91,.034,.034),(1,.03,.03)],steel,shoulder_joint)
    lathe(side+"-pauldron",shoulder,elbow,[(0,.031,.041),(.055,.052,.053),(.16,.058,.054),(.25,.041,.043),(.31,.032,.033)],brass,shoulder_joint)
    hinge(side+"-elbow",elbow,s,.043,elbow_joint)
    lathe(side+"-vambrace",elbow,wrist,[(0,.022,.025),(.13,.033,.033),(.24,.044,.039),(.39,.041,.038),(.70,.028,.029),(.89,.021,.022),(.94,.030,.03),(1,.024,.025)],steel,elbow_joint)
    ribbon(side+"-forearm-spline",[(s*.304,.048,1.134,.014),(s*.312,.064,1.101,.019),(s*.333,.072,1.053,.013),(s*.36,.076,.982,.005)],.007,brass,elbow_joint)
    hinge(side+"-tool",wrist,s,.031,tool)
    for jaw,offset,points,mat in [
            ("hook",.016,[(.378,.946,.019),(.40,.91,.027),(.435,.862,.023),(.450,.816,.014),(.448,.782,.007),(.438,.763,.0015)],brass),
            ("blade",-.016,[(.378,.946,.016),(.374,.904,.021),(.383,.854,.016),(.399,.813,.010),(.424,.777,.0015)],steel)]:
        jawroot=pivot(side+"-"+jaw+"-hinge",wrist,tool)
        ribbon(side+"-pruning-"+jaw,[(s*x,.074+offset+(.946-z)*.19,z,w) for x,z,w in points],.010,mat,jawroot)
    fitting(side+"-shear-boss",p(.395,.089,.909),p(.395,.111,.909),.018,brass,tool)
    fitting(side+"-shear-jewel",p(.395,.110,.909),p(.395,.116,.909),.012,green,tool)
    hip=p(.110,0,.89)
    knee=p(.118,.026,.555)
    ankle=p(.132,-.014,.135)
    leg=pivot("hip-"+side,hip,hips)
    shin=pivot("knee-"+side,knee,leg)
    foot=pivot("foot-"+side,ankle,shin)
    hinge(side+"-hip",hip,s,.055,leg)
    lathe(side+"-thigh",hip,knee,[(0,.033,.035),(.11,.046,.049),(.25,.047,.048),(.40,.038,.044),(.81,.025,.033),(.90,.031,.035),(1,.027,.03)],steel,leg)
    ribbon(side+"-thigh-flange",[(s*.111,.045,.847,.022),(s*.113,.05,.795,.017),(s*.116,.055,.684,.007)],.008,brass,leg)
    hinge(side+"-knee",knee,s,.046,shin)
    lathe(side+"-greave",knee,ankle,[(0,.031,.032),(.13,.047,.05),(.27,.05,.054),(.44,.042,.044),(.8,.027,.03),(.92,.033,.034),(1,.028,.031)],steel,shin)
    ribbon(side+"-greave-rim",[(s*.118,.056,.531,.02),(s*.121,.071,.467,.028),(s*.124,.065,.42,.021),(s*.13,.022,.199,.006)],.009,brass,shin)
    ribbon(side+"-greave-enamel",[(s*.120,.080,.478,.011),(s*.123,.077,.447,.014),(s*.125,.070,.409,.009),(s*.13,.028,.23,.002)],.003,green,shin)
    hinge(side+"-ankle",ankle,s,.037,foot)
    boot_sections = []
    for z, cy, rx, ry in [(.012,.047,.052,.108),(.027,.048,.058,.115),(.049,.041,.057,.111),(.071,.024,.050,.093),(.106,.001,.041,.058),(.143,-.014,.032,.035)]:
        boot_sections.append([(s*.132+rx*math.cos(math.tau*j/24),cy+ry*math.sin(math.tau*j/24),z) for j in range(24)])
    solid(side+"-boot", boot_sections, brass, foot)
    lathe(side+"-boot-sole",p(.132,.047,0),p(.132,.047,.022),[(0,.051,.107),(.25,.055,.111),(1,.055,.111)],steel,foot)
    ribbon(side+"-toe-split",[(s*.132,.155,.034,.0024),(s*.132,.148,.047,.0031),(s*.132,.121,.065,.0028),(s*.132,.093,.077,.0022)],.0028,steel,foot)
    fitting(side+"-cuff-ring",p(.362,.059,.981),p(.366,.060,.971),.032,brass,elbow_joint)
    fitting(side+"-knee-front",p(.118,.054,.555),p(.118,.075,.555),.033,brass,shin)
    fitting(side+"-knee-button",p(.118,.075,.555),p(.118,.079,.555),.021,steel,shin)
    boot_band = [(s*.132+dx,.100-abs(dx)*.15,z,.0035) for dx,z in [(-.049,.038),(-.042,.055),(-.025,.064),(0,.068),(.025,.064),(.042,.055),(.049,.038)]]
    ribbon(side+"-toe-cap-seam",boot_band,.003,steel,foot)
    if side=="right":
        pivot("socket-weapon",p(.438,.124,.763),bpy.data.objects[side+"-hook-hinge"])
pivot("socket-eye",(0,.080,1.664),head)
pivot("socket-hit",(0,.084,1.429),torso)

def measure():
    bpy.context.view_layer.update()
    objects = list(bpy.context.scene.objects)
    meshes = [o for o in objects if o.type=="MESH"]
    points = [o.matrix_world @ v.co for o in meshes for v in o.data.vertices]
    for o in meshes:
        o.data.calc_loop_triangles()
    return {
        "bounds_blender_m":{"min":[round(min(p[i] for p in points),6) for i in range(3)],
                            "max":[round(max(p[i] for p in points),6) for i in range(3)]},
        "triangle_count":sum(len(o.data.loop_triangles) for o in meshes),
        "mesh_count":len(meshes),
        "materials":sorted({m.name for o in meshes for m in o.data.materials}),
        "sole_z_m":{o.name:round(min((o.matrix_world @ v.co).z for v in o.data.vertices),6)
                    for o in meshes if o.name.endswith("boot-sole")},
        "sockets_blender_m":{o.name:[round(el,6) for el in o.matrix_world.translation]
                            for o in objects if o.name.startswith("socket-")},
        "parents":{o.name:o.parent.name if o.parent else None for o in objects},
    }


candidate = OUT / (STEM+".glb")
source = OUT / (STEM+".blend")
for obj in scene.objects:
    if obj.type=="MESH" and amber in obj.data.materials[:] and not obj.data.color_attributes:
        lens=obj.data.color_attributes.new(name="Husk",type="FLOAT_COLOR",domain="POINT")
        for value in lens.data:
            value.color=(.93,.41,.025,1)
before = measure()
bpy.ops.wm.save_as_mainfile(filepath=str(source),compress=True)
bpy.ops.export_scene.gltf(filepath=str(candidate),export_format="GLB",export_animations=False,
                          export_yup=True,export_extras=False)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(candidate))
report = measure()
assert before == report, {key:[before[key],report[key]] for key in before if before[key]!=report[key]}
assert report["triangle_count"]<=25000 and len(report["materials"])==4
assert report["sole_z_m"]=={"left-boot-sole":0,"right-boot-sole":0}
assert report["bounds_blender_m"]["min"][2]==0 and abs(report["bounds_blender_m"]["max"][2]-1.75)<.001
assert all(p[1]>0 for p in report["sockets_blender_m"].values())
report["stage"]="static base draft, pending concept and model owner review"
report["pre_export"]={key:value for key,value in before.items() if key!="parents"}
report["reimport_matches_source"]=True
report["axes"]="Blender +Y forward, +Z up; glTF -Z forward, +Y up"
report["stage_scope"]="Static geometry only. Articulation clearances during movement require the rig stage."
scene=bpy.context.scene
world=bpy.data.worlds.new("Warm studio")
scene.world=world
world.use_nodes=True
world.node_tree.nodes["Background"].inputs[0].default_value=(.34,.28,.23,1)
world.node_tree.nodes["Background"].inputs[1].default_value=.48
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.001))
bpy.context.object.data.materials.append(material("studio-floor",(.125,.099,.074),0,.85))
target=Vector((0,0,.85))
def area(name,position,color,power,size):
    light=bpy.data.lights.new(name,"AREA")
    light.shape="DISK"
    light.size=size
    light.energy=power
    light.color=color
    obj=bpy.data.objects.new(name,light)
    scene.collection.objects.link(obj)
    obj.location=position
    obj.rotation_euler=(target-obj.location).to_track_quat("-Z","Y").to_euler()


area("softbox",(-1.8,2.4,3.35),(1,.91,.76),240,1.9)
area("fill",(1.8,2.0,1.7),(1,.94,.87),100,1.5)
area("rim",(.8,-1.8,2.6),(1,.81,.62),260,1.3)
area("left reflection",(-1.5,-.4,1.1),(1,.95,.85),45,1.0)
cam_data=bpy.data.cameras.new("studio-camera")
camera=bpy.data.objects.new("studio-camera",cam_data)
scene.collection.objects.link(camera)
scene.camera=camera
cam_data.type="ORTHO"
cam_data.ortho_scale=1.99
scene.render.engine="BLENDER_EEVEE"
scene.render.resolution_x=672
scene.render.resolution_y=752
scene.render.resolution_percentage=100
scene.render.image_settings.file_format="PNG"
scene.view_settings.view_transform="AgX"
views={"three-quarter":(1.35,3.3,1.33),"side":(3.5,0,1.08),"raised":(1.7,3,2.85),
       "front":(0,3.5,1.08),"back":(0,-3.5,1.08)}
for name,position in views.items():
    camera.location=position
    camera.rotation_euler=(target-camera.location).to_track_quat("-Z","Y").to_euler()
    scene.render.filepath=str(OUT/("review-"+name+".png"))
    bpy.ops.render.render(write_still=True)
files={"glb":candidate,"blend":source,"generator":Path(__file__),
       "concept":OUT.parents[3]/"concepts/trellis-keeper/trellis-keeper.png"}
files.update({"review-"+k:OUT/("review-"+k+".png") for k in views})
report["sha256"]={k:hashlib.sha256(v.read_bytes()).hexdigest() for k,v in files.items()}
(OUT/"reimport-report.json").write_text(json.dumps(report,indent=2)+"\n")
print("TRELLIS_VERIFIED", report["triangle_count"],report["bounds_blender_m"])
