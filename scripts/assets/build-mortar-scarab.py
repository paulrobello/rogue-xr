"""Build from the approved static GLB with Blender 5.2.2 in background mode."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import subprocess
import tempfile
from pathlib import Path

import bpy
import numpy as np
from mathutils import Euler, Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree

ID = "mortar-scarab"
ROOT = Path(__file__).resolve().parents[2]
STAGE = ROOT / "assets-source/enemies" / ID / "staging"
BASE = STAGE / "base" / f"{ID}-base.glb"
OUT = STAGE / "runtime"
OUT.mkdir(exist_ok=True)
GLB, BLEND = (OUT / (ID + suffix) for suffix in (".glb", ".blend"))
helper_path = Path(__file__).with_name("build-spring-hound.py")
spec = importlib.util.spec_from_file_location("enemy_tools", helper_path)
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
FPS = 30
MOVES = ("shell-seal", "mortar-rake", "grind")
BEATS = {"shell-seal": (27, 9), "mortar-rake": (36, 9), "grind": (33, 13)}
DURATIONS = {"idle": 60, "attack": 36, "hit": 15, "death": 42, "frozen": 30}
DURATIONS.update({"intent-" + m: 20 for m in MOVES})
DURATIONS.update({"action-" + m: BEATS[m][0] for m in MOVES})
MATERIALS = ("limestone", "aged-brass", "dark-iron", "amber-core")


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(name: str, data: dict) -> None:
    (OUT / name).write_text(json.dumps(data, indent=2) + "\n")


def xyz(point) -> list[float]:
    return [float(point[0]), float(point[2]), -float(point[1])]


def turn(x=0., y=0., z=0.) -> Quaternion:
    return Euler(tuple(math.radians(v) for v in (x,y,z))).to_quaternion()


def smooth(frame: int, keys) -> float:
    for (t, a), (u, b) in zip(keys, keys[1:]):
        if frame <= u:
            v = max(0., (frame-t)/(u-t))
            return a+(b-a)*v*v*(3-2*v)
    return keys[-1][1]


def rigid(pivot, rotation, delta=(0.,0.,0.)) -> Matrix:
    return Matrix.Translation(Vector(pivot)+Vector(delta)) @ rotation.to_matrix().to_4x4() @ Matrix.Translation(-Vector(pivot))


assert sha(BASE) == json.loads((BASE.parent / "visual-review.json").read_text())["glbSha256"]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(BASE))
scene = bpy.context.scene
scene.render.fps, scene.frame_start, scene.frame_end = FPS, 0, 60
bpy.context.preferences.filepaths.save_version = 0
bones = []
legs = {}
plates = {}
owners = {}
originals = list(scene.objects)


def joint(name, parent, head, tail):
    bones.append((name,parent,Vector(head),Vector(tail)))


joint("root", None, (0,0,0), (0,0,.09))
joint("chassis","root",(0,0,.28),(0,.18,.28))
joint("head","chassis",(0,.30,.31),(0,.46,.32))
for side, sign in [("left",-1), ("right",1)]:
    for row in range(3):
        prefix = f"leg-{side}-{row}-"
        hip, knee, foot = [bpy.data.objects[prefix+n].matrix_world.translation.copy() for n in ("hip","knee","foot")]
        ankle = 2*bpy.data.objects[prefix+"shin"].matrix_world.translation-knee
        label = f"{side}.{row}"
        legs[label] = (sign, row, hip, knee, ankle, foot)
        joint("upper."+label, "chassis", hip, knee)
        joint("shin."+label, "upper."+label, knee, ankle)
        joint("foot."+label, "shin."+label, ankle, ankle+Vector((0,.055,0)))
        for obj in originals:
            if obj.type=="MESH" and obj.name.startswith(prefix):
                part = obj.name.removeprefix(prefix)
                group = "foot" if part=="foot" else "shin" if part.startswith(("shin","knee")) else "upper"
                owners[obj.name] = group+"."+label
        prefix = f"shell-lamella-{row:02}-{side}"
        pivot = Vector((sign*.012, -.24+.215*row,.515+.042*row))
        name = "plate."+label
        plates[name] = (sign,row,pivot)
        joint(name,"chassis",pivot,pivot+Vector((sign*.12,0,-.04)))
        for obj in originals:
            if obj.type=="MESH" and obj.name.startswith(prefix): owners[obj.name] = name
pieces = []
for obj in originals:
    if obj.type!="MESH": continue
    group = owners[obj.name] if obj.name in owners else "head" if obj.name.startswith("head-") else "chassis"
    assert group!="chassis" or obj.name=="body-armored-chassis"
    mesh = obj.data.copy()
    mesh.transform(obj.matrix_world)
    piece = bpy.data.objects.new("skin-"+obj.name,mesh)
    scene.collection.objects.link(piece)
    piece.vertex_groups.new(name=group).add(list(range(len(mesh.vertices))),1.,"REPLACE")
    pieces.append(piece)
for obj in originals: bpy.data.objects.remove(obj,do_unlink=True)
bpy.ops.object.select_all(action="DESELECT")
for piece in pieces: piece.select_set(True)
body = pieces[0]
bpy.context.view_layer.objects.active = body
bpy.ops.object.join()
body.name = ID+"-body"
helpers.BONES = bones
arm = helpers.build_armature(bpy,scene,ID)
body.parent = arm
body.modifiers.new("Articulated shell and limbs","ARMATURE").object = arm
sockets = {"socket-hit":("plate.right.2",(.11,.19,.59)), "socket-eye":("head",(0,.47,.32)),
           "socket-weapon":("foot.right.0",tuple(legs["right.0"][-1]+Vector((0,.031,0))))}
socket_nodes = []
for name,(parent,point) in sockets.items():
    node = bpy.data.objects.new(name,None)
    scene.collection.objects.link(node)
    node.parent,node.parent_type,node.parent_bone = arm,"BONE",parent
    bpy.context.view_layer.update()
    node.matrix_world = Matrix.Translation(point)
    socket_nodes.append(node)


def poses(name: str, t: int) -> dict:
    seal = rake = grind = hit = fall = breath = 0.
    seal_height = grind_push = 0.
    swings = {"left": (0.,0.), "right": (0.,0.)}
    if name.startswith("intent-"):
        amount = smooth(t,[(0,0),(12,1)])
        seal, rake, grind = [amount if name.endswith(m) else 0. for m in MOVES]
    elif name=="action-shell-seal":
        seal = smooth(t,[(0,1),(4,.92),(9,1.30),(18,1.23),(27,0)])
        seal_height = smooth(t,[(0,.050),(4,.056),(9,0),(15,0),(20,.035),(27,0)])
    elif name in ("attack","action-mortar-rake"):
        rake = smooth(t,[(0,1),(5,1.05),(9,.87),(18,.84),(29,.36),(36,0)])
        for side,lag in [("right",0),("left",7)]:
            # Each brass pad strikes the floor at full extension, sweeps
            # through, then lifts clear before replacing at the neutral sole.
            dt = t-lag
            swing = smooth(dt,[(0,0),(3,-.12),(9,1),(12,1.12),(19,.25),(26,0)])
            height = smooth(dt,[(0,1),(3,1.15),(9,0),(12,0),(18,.40),(26,0)])
            swings[side] = (swing,height)
    elif name=="action-grind":
        grind = smooth(t,[(0,1),(6,1.04),(13,.90),(20,.8),(33,0)])
        grind_push = smooth(t,[(0,0),(5,-.08),(13,1),(19,1.10),(27,.25),(33,0)])
        swings["right"] = (grind_push,smooth(t,[(0,1),(5,1.08),(13,0),(19,0),(25,.32),(33,0)]))
    elif name=="hit": hit = smooth(t,[(0,0),(3,1),(8,-.20),(15,0)])
    elif name=="death": fall = smooth(t,[(0,0),(5,-.04),(20,.85),(26,1),(30,.97),(35,1)])
    elif name=="idle": breath = math.sin(2*math.pi*t/60)
    rake_shift = (swings["right"][0]-swings["left"][0]) if name in ("attack","action-mortar-rake") else 0.
    chassis = rigid((0,0,.28),turn(1.1*breath-2.8*seal-2.2*grind+5*hit-1.8*fall,
                                    2*grind+2*hit+3*fall+4.5*rake_shift, 3*rake_shift),
                    (0,-.012*hit,.0025*breath-.020*seal-.009*grind-.099*fall))
    result = {"root":Matrix.Identity(4),"chassis":chassis}
    result["head"] = chassis @ rigid((0,.30,.31),turn(-11*seal+12*rake-21*grind-7*fall,6*grind,-25*grind),
                                  (.033*grind,-.075*seal+.039*rake+.026*grind_push,-.015*seal))
    for name_plate,(s,row,pivot) in plates.items():
        result[name_plate] = chassis @ rigid(pivot,turn(-4*seal+2.2*rake-6*grind*(row==2),s*(7*seal-(3+2*row)*rake-4*hit),
                                              -8*grind if row==2 else 0),
                                   (s*(.006*seal+.010*rake),(.020+.006*row)*seal-(.070-.015*row)*rake+(.044*grind+.018*grind_push)*(row==2),
                                    -.008*seal-.018*rake+.012*grind*(row==2)+.0016*breath))
    for label,(s,row,hip,knee,ankle,foot) in legs.items():
        side = label.split(".")[0]
        target = ankle.copy()
        if row==0:
            target += Vector((-s*.082*seal,-.069*seal,seal_height if name=="action-shell-seal" else .050*seal))
            if name.startswith("intent-"):
                target += Vector((s*.015*rake,-.105*rake,.17*rake))
                if side=="right": target += Vector((-s*.028*grind,-.060*grind,.105*grind))
            elif name in ("attack","action-mortar-rake","action-grind"):
                forward,raised = swings[side]
                if name!="action-grind":
                    target += Vector((s*(.015*raised-.115*forward),.113*forward-.105*raised,.17*raised))
                elif side=="right":
                    target += Vector((-s*(.028*raised+.075*forward),.093*forward-.060*raised,.105*raised))
        # Solve against the planted ankle. The rest knee supplies the pole
        # vector, keeping each hinge on its own side through compression.
        h = chassis @ hip
        direction = target-h
        d = direction.length
        axis = direction.normalized()
        a,b = (knee-hip).length,(ankle-knee).length
        d = min(d,a+b-.00001)
        target = h+axis*d
        along = (a*a-b*b+d*d)/(2*d)
        pole = (knee-hip)-axis*(knee-hip).dot(axis)
        k = h+along*axis+pole.normalized()*math.sqrt(max(0.,a*a-along*along))
        result["upper."+label] = rigid(hip,(knee-hip).rotation_difference(k-h),h-hip)
        result["shin."+label] = rigid(knee,(ankle-knee).rotation_difference(target-k),k-knee)
        result["foot."+label] = Matrix.Translation(target-ankle)
    return result


arm.animation_data_create()
for name,frames in DURATIONS.items():
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data.action = act
    for frame in range(frames+1):
        transforms = poses(name,frame)
        for bone,parent,head,tail in bones[1:]:
            rest = arm.data.bones[bone].matrix_local
            basis = rest.inverted() @ transforms[parent].inverted() @ transforms[bone] @ rest
            pb = arm.pose.bones[bone]
            pb.location, pb.rotation_quaternion, _ = basis.decompose()
            for channel in ("location","rotation_quaternion"):
                pb.keyframe_insert(data_path=channel,frame=frame)
arm.animation_data.action = None
for pb in arm.pose.bones: pb.matrix_basis = Matrix.Identity(4)
bpy.context.view_layer.update()
helpers.export_glb(bpy,[arm,body,*socket_nodes],arm,GLB)
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND),compress=True)
print("STAGED",GLB,flush=True)

g,acc,_ = helpers.parse_glb(GLB.read_bytes())
joint_names = [g["nodes"][i]["name"] for i in g["skins"][0]["joints"]]
assert len(g["skins"])==1 and set(joint_names)=={b[0] for b in bones} and len(joint_names)<=40
primitives = [p for mesh in g["meshes"] for p in mesh["primitives"]]
triangles = sum(len(acc(p["indices"]))//3 for p in primitives)
assert triangles == json.loads((BASE.parent/"reimport-report.json").read_text())["triangle_count"] <= 25000
assert {m["name"] for m in g["materials"]}==set(MATERIALS) and not g.get("images") and not g.get("textures")
positions = np.concatenate([acc(p["attributes"]["POSITION"]) for p in primitives])
weight = np.concatenate([acc(p["attributes"]["WEIGHTS_0"]) for p in primitives])
max_infl = int(np.count_nonzero(weight>0.,axis=1).max())
err = float(np.max(np.abs(weight.sum(axis=1)-1)))
unweighted = int(np.count_nonzero(weight.sum(axis=1)==0))
assert max_infl==1 and not unweighted and err < 1e-6
assert np.isfinite(acc(g["skins"][0]["inverseBindMatrices"])).all()
assert {a["name"] for a in g["animations"]}==set(DURATIONS)
for animation in g["animations"]:
    assert abs(max(float(acc(s["input"]).max()) for s in animation["samplers"])-DURATIONS[animation["name"]]/FPS)<1e-5
    for channel in animation["channels"]:
        if g["nodes"][channel["target"]["node"]]["name"]=="root":
            values = acc(animation["samplers"][channel["sampler"]]["output"])
            assert np.allclose(values,values[0],atol=1e-6)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = FPS
bpy.ops.import_scene.gltf(filepath=str(GLB),disable_bone_shape=True)
arm, = [o for o in scene.objects if o.type=="ARMATURE"]
body, = [o for o in scene.objects if o.type=="MESH"]
actions = {a.name:a for a in bpy.data.actions}
for tr in arm.animation_data.nla_tracks: tr.mute = True
geometry = np.empty((len(body.data.vertices),3),dtype=np.float32)
idx_group = np.array([v.groups[0].group for v in body.data.vertices])
groups = {n:np.flatnonzero(idx_group==body.vertex_groups[n].index) for n in joint_names if n!="root"}
rest = np.array([v.co[:] for v in body.data.vertices])
plate_tris = {}
for p in plates:
    rows = [tuple(face.vertices) for face in body.data.polygons
            if face.material_index==body.data.materials.find("limestone") and face.vertices[0] in set(groups[p])]
    indices = np.unique(np.ravel(rows))
    plate_tris[p] = (indices,np.searchsorted(indices,rows).tolist())
knee_heads = {key: val[3] for key,val in legs.items()}
inverse_bind = {n:arm.data.bones[n].matrix_local.inverted() for n in joint_names}
global_min,global_max = np.full(3,np.inf),np.full(3,-np.inf)
summary,hold,peaks = {},{},{}
marker_paths = {}
min_clear = np.inf
max_socket = 0.
for name,length in DURATIONS.items():
    arm.animation_data.action = actions[name]
    floors, soles, travel, gaps, seams = [],[],[],[],[]
    plate_crossings = 0
    centers = []
    weapon_positions = []
    for frame in range(length+1):
        scene.frame_set(frame)
        evaluated = body.evaluated_get(bpy.context.evaluated_depsgraph_get())
        evaluated.data.vertices.foreach_get("co",geometry.ravel())
        assert np.allclose(evaluated.matrix_world, np.eye(4),atol=1e-5)
        global_min = np.minimum(global_min,geometry.min(axis=0))
        global_max = np.maximum(global_max,geometry.max(axis=0))
        if frame==0: start_pose = geometry.copy()
        if name.startswith("intent-") and frame==12: hold[name[7:]] = geometry.copy()
        if name.startswith("intent-") and frame>=12:
            seams.append(float(np.max(np.linalg.norm(geometry-hold[name[7:]],axis=1))))
        if name.startswith("action-") and frame==length:
            seams.append(float(np.max(np.linalg.norm(geometry-rest,axis=1))))
        if name.startswith("action-") and frame==0:
            seams.append(float(np.max(np.linalg.norm(geometry-hold[name[7:]],axis=1))))
        if name=="frozen" or (name=="idle" and frame==length):
            seams.append(float(np.max(np.linalg.norm(geometry-start_pose,axis=1))))
        feet = [groups["foot."+leg] for leg in legs]
        floors.append(float(geometry[:,2].min()))
        soles.append([float(geometry[ids,2].min()) for ids in feet])
        travel.append([float(np.linalg.norm(geometry[ids].mean(axis=0)-rest[ids].mean(axis=0))) for ids in feet])
        centers.append([geometry[ids].mean(axis=0).tolist() for ids in feet])
        poses_now = {n:arm.matrix_world @ arm.pose.bones[n].matrix @ inverse_bind[n] for n in joint_names}
        for socket,(bone,p) in sockets.items():
            actual = bpy.data.objects[socket].matrix_world.translation
            max_socket = max(max_socket,(actual-poses_now[bone] @ Vector(p)).length)
        weapon_positions.append(list(bpy.data.objects["socket-weapon"].matrix_world.translation))
        trees = {p:BVHTree.FromPolygons(geometry[ids].tolist(),tris,all_triangles=True)
                 for p,(ids,tris) in plate_tris.items()}
        pairs = [(p,q) for i,p in enumerate(trees) for q in list(trees)[i+1:]]
        crossing = [(p,q) for p,q in pairs if trees[p].overlap(trees[q])]
        if crossing and frame in (12,13): print("Plate contact",name,frame,crossing,flush=True)
        plate_crossings += len(crossing)
        for leg,knee in knee_heads.items():
            center = poses_now["shin."+leg] @ knee
            gaps.append(min(tree.find_nearest(center)[3] for tree in trees.values())-.054)
    soles,travel = np.asarray(soles),np.asarray(travel)
    support_indices = [i for i,leg in enumerate(legs) if legs[leg][1]!=0]
    row = {"framesChecked":length+1, "duration":length/FPS, "minFloorM":min(floors),
           "maxPlantedFootDisplacementM":float(travel[:,support_indices].max()),
           "maxPlantedSoleHeightM":float(np.abs(soles[:,support_indices]).max()),
           "minKneeCapSphereToPlateM":float(min(gaps)),"platePairIntersections":plate_crossings,
           "soleLiftByLegM":dict(zip(legs,soles.max(axis=0).tolist())),
           "seamErrorM":max(seams,default=0.)}
    if name.startswith("action-"):
        move = name[7:]
        f = BEATS[move][1]
        row["impactFrame"] = f
        row["impactSolesM"] = dict(zip(legs,soles[f].tolist()))
        row["weaponAtImpactBlenderM"] = weapon_positions[f]
        if move=="mortar-rake":
            for leg in ("right.0","left.0"):
                track = soles[:,list(legs).index(leg)]
                peaks[leg] = next(i for i,value in enumerate(track) if i>0 and value < .001 and track[i-1]>.001)
            marker_paths[move] = [{"frame":i,"weapon":p,"farForefoot":centers[i][0]} for i,p in enumerate(weapon_positions)]
    if name=="death":
        row["finalChassisMinM"] = float(geometry[groups["chassis"],2].min())
        row["finalFloorM"] = floors[-1]
    summary[name] = row
    min_clear = min(min_clear,min(gaps))
    print("MEASURE", name, row,flush=True)
assert min(r["minFloorM"] for r in summary.values())>-.001
assert max(r["maxPlantedFootDisplacementM"] for r in summary.values()) < .001
assert max(r["seamErrorM"] for r in summary.values())<.0001, summary
assert max_socket < .0001 and peaks=={"right.0":9,"left.0":16}, (max_socket,peaks)
assert abs(summary["death"]["finalFloorM"])<.001 and summary["death"]["finalChassisMinM"]<.025
assert min_clear>0 and all(r["platePairIntersections"]==0 for r in summary.values())
center = (global_min+global_max)*.5
manifest = {"id":ID,"version":1,"glb":GLB.name,"frame":{"units":"m","up":"+Y","forward":"-Z","origin":"floor"},
            "root":ID,"mesh":ID+"-body","bounds":{"min":positions.min(axis=0).tolist(),"max":positions.max(axis=0).tolist()},
            "skeleton":{"root":"root","bones":len(joint_names),"joints":joint_names,"maxInfluences":max_infl},
            "rootMotion":"code-owned; root joint fixed",
            "clips":{n:{"duration":DURATIONS[n]/FPS,"loop":"repeat" if n in ("idle","frozen") else "once",
                        "events":{"impact":BEATS["mortar-rake"][1]/FPS} if n=="attack" else {"down":35/FPS} if n=="death" else {},
                        **({"held":True} if n=="frozen" else {"endsOnFloor":True} if n=="death" else {})}
                     for n in ("idle","attack","hit","death","frozen")},
            "intentClips":{m:"intent-"+m for m in MOVES},"actionClips":{m:"action-"+m for m in MOVES},
            "actionTimings":{m:{"duration":d/FPS,"impact":i/FPS} for m,(d,i) in BEATS.items()},
            "sockets":{n:{"bone":b,"parent":b,"position":xyz(p)} for n,(b,p) in sockets.items()},
            "emissive":{"material":"amber-core","color":"#FF9126","intensity":1.4,"nodes":["socket-eye"]},
            "materialSlots":{m:{"set":None,"factorOnly":True,**({"emissive":True} if m=="amber-core" else {})} for m in MATERIALS},
            "cull":{"center":xyz(center),"radius":float(np.linalg.norm(global_max-center))+.01},
            "budget":{"tris":triangles,"materials":4,"bones":len(joint_names),"influences":max_infl}}
manifest["actionTimings"]["mortar-rake"]["secondImpact"] = peaks["left.0"]/FPS
write(ID+".manifest.json",manifest)
report = {"pass":True,"blender":bpy.app.version_string,"glb_sha256":sha(GLB),"blend_sha256":sha(BLEND),
          "generator_sha256":sha(Path(__file__)),"helper_sha256":sha(helper_path),"base_glb_sha256":sha(BASE),
          "base_blend_sha256":sha(BASE.with_suffix(".blend")),"base_generator_sha256":sha(Path(__file__).with_name("build-mortar-scarab-base.py")),
          "max_influences":max_infl,"unweighted_vertices":unweighted,"max_weight_sum_error":err,
          "triangleCount":triangles,"jointCount":len(joint_names),"materials":list(MATERIALS),"neutralBounds":manifest["bounds"],
          "measuredClips":summary,"rakeContactFrames":peaks,"measuredMotionBlenderM":marker_paths,
          "maxSocketTrackingErrorM":max_socket,"minKneeCapSphereToStoneM":min_clear,
          "holdRangeFrames":[12,20],"ownerRigClipReview":"pending"}
write("reimport-report.json",report)

scene.render.engine = "BLENDER_EEVEE"
scene.eevee.taa_render_samples = 12
scene.render.resolution_x,scene.render.resolution_y,scene.render.resolution_percentage = 448,352,100
scene.render.image_settings.file_format = "PNG"
scene.world = bpy.data.worlds.new("Quarry studio")
scene.world.color = (.09,.098,.11)
scene.view_settings.view_transform = "AgX"

def aim(obj, target) -> None:
    obj.rotation_euler = (Vector(target)-obj.location).to_track_quat("-Z","Y").to_euler()

for label,loc,power,size in [("Warm key",(-1.5,2.4,3.1),112,2.4),
                             ("Vent fill",(2.2,1.8,1.5),65,1.8),("Shell rim",(0,-1.8,2.4),104,1.3)]:
    data = bpy.data.lights.new(label,"AREA")
    data.energy, data.shape, data.size = power,"DISK",size
    obj = bpy.data.objects.new(label,data)
    scene.collection.objects.link(obj)
    obj.location = loc
    aim(obj,(0,0,.24))
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.002))
floor = bpy.context.object
material = bpy.data.materials.new("Studio floor")
material.use_nodes = True
material.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (.065,.075,.085,1)
floor.data.materials.append(material)
cam_data = bpy.data.cameras.new("Review camera")
cam = bpy.data.objects.new("Review camera",cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
cam_data.type = "ORTHO"
front,high,low = (1.15,2.8,1.85),(.75,1.75,2.8),(.8,2.7,1.0)
cam_data.ortho_scale = 1.55
target = (-.045,.015,.26)
shots = [
    ("Neutral", "frozen",0,front),("Shell seal / tuck","intent-shell-seal",20,front),
    ("Shell seal / locked","action-shell-seal",9,front),
    ("Rake / raised forelegs","intent-mortar-rake",20,front),("Rake / first contact","action-mortar-rake",9,front),
    ("Rake / second contact","action-mortar-rake",16,high),
    ("Grind / head and lead leg","intent-grind",20,front),("Grind / contact","action-grind",13,front),
    ("Rake / follow-through","action-mortar-rake",22,high),
    ("Idle / inhale","idle",15,high),("Hit / recoil","hit",3,front),("Death / settled","death",42,low)]
font = next(p for p in (Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
                        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")) if p.is_file())

# Keep one fixed camera for each angle. Project every gallery pose to fit
# the complete silhouette, including both extended forefeet.
framing = {}
for camera in (front,high,low):
    cam.location = camera
    aim(cam,target)
    q = cam.rotation_euler.to_quaternion()
    proj = np.asarray([q @ Vector((1,0,0)),q @ Vector((0,1,0))])
    low_xy, high_xy = np.full(2,np.inf),np.full(2,-np.inf)
    for _,name,frame,_ in shots:
        arm.animation_data.action = actions[name]
        scene.frame_set(frame)
        obj = body.evaluated_get(bpy.context.evaluated_depsgraph_get())
        obj.data.vertices.foreach_get("co",geometry.ravel())
        uv = (geometry - target) @ proj.T
        low_xy,high_xy = np.minimum(low_xy,uv.min(axis=0)),np.maximum(high_xy,uv.max(axis=0))
    center_uv = (low_xy+high_xy)/2
    displacement = Vector(center_uv @ proj)
    span = high_xy-low_xy
    framing[camera] = (Vector(camera)+displacement,Vector(target)+displacement,1.18*max(span[0],span[1]*448/352))

def render(action,frame,camera,path):
    arm.animation_data.action = actions[action]
    scene.frame_set(frame)
    cam.location,center_point,cam_data.ortho_scale = framing[camera]
    aim(cam,center_point)
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)

with tempfile.TemporaryDirectory() as directory:
    tmp = Path(directory)
    frames = []
    for i,(label,name,frame,camera) in enumerate(shots):
        raw,caption = tmp/f"still-{i}.png",tmp/f"label-{i}.png"
        render(name,frame,camera,raw)
        subprocess.run(["magick",str(raw),"-gravity","south","-background","#24282c","-splice","0x35",
                        "-fill","#f2eee6","-font",str(font),"-pointsize","17","-annotate","+0+8",label,str(caption)],check=True)
        frames.append(str(caption))
    subprocess.run(["magick","montage",*frames,"-tile","3x4","-geometry","+2+2","-background","#24282c",
                    str(OUT/"review-contact-sheet.png")],check=True)
    # The moving review uses the exact exported frames at half sampling rate.
    # Each three-beat sequence holds the tell, strikes, and settles to neutral.
    frame_number = 0
    scene.eevee.taa_render_samples = 8
    for move in MOVES:
        for action in ("intent-"+move,"action-"+move):
            for frame in range(0,DURATIONS[action]+1,2):
                render(action,frame,front,tmp/f"motion-{frame_number:03d}.png")
                frame_number += 1
        render("frozen",0,front,tmp/f"motion-{frame_number:03d}.png")
        for j in range(1,8):
            (tmp/f"motion-{frame_number+j:03d}.png").hardlink_to(tmp/f"motion-{frame_number:03d}.png")
        frame_number += 8
    subprocess.run(["ffmpeg","-v","error","-y","-framerate","15","-i",str(tmp/"motion-%03d.png"),
                    "-c:v","libx264","-crf","16","-pix_fmt","yuv420p","-movflags","+faststart",
                    str(OUT/"review-moves.mp4")],check=True)
report["reviewEvidence"] = {n:sha(OUT/n) for n in ("review-contact-sheet.png","review-moves.mp4")}
write("reimport-report.json",report)
