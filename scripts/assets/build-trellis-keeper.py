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

ID = "trellis-keeper"
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
MOVES = ("trellis-brace", "double-cut", "hook-jab")
BEATS = {"trellis-brace": (30, 10), "double-cut": (44, 12), "hook-jab": (30, 10)}
DURATIONS = {"idle": 60, "attack": 44, "hit": 15, "death": 42, "frozen": 30}
DURATIONS.update({"intent-" + m: 20 for m in MOVES})
DURATIONS.update({"action-" + m: BEATS[m][0] for m in MOVES})
MATERIALS = ("armor-steel", "aged-brass", "emerald-inlay", "amber-core")


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
points = {}
originals = list(scene.objects)
sides = {"left": -1, "right": 1}


def joint(name: str, parent: str | None, point, end) -> None:
    points[name] = Vector(point)
    bones.append((name, parent, Vector(point), Vector(end)))


def base_joint(name: str, parent: str, offset=(0,0,.055)) -> None:
    p = bpy.data.objects[name].matrix_world.translation.copy()
    joint(name, parent, p, p+Vector(offset))


joint("root", None, (0,0,0), (0,0,.1))
for name, parent in [("hips","root"),("torso-frame","hips"),("head","torso-frame"),("seed-pod","torso-frame")]:
    base_joint(name,parent)
for side,s in sides.items():
    joint("trellis-"+side,"torso-frame",(s*.124,.073,.988),(s*.126,.073,1.409))
    for name,parent in [
        ("shoulder-"+side,"torso-frame"),("elbow-"+side,"shoulder-"+side),("forearm-tool-"+side,"elbow-"+side),
        (side+"-hook-hinge","forearm-tool-"+side),(side+"-blade-hinge","forearm-tool-"+side),
        ("hip-"+side,"hips"),("knee-"+side,"hip-"+side),("foot-"+side,"knee-"+side)]:
        base_joint(name,parent)
sockets = {name:(bpy.data.objects[name].parent.name,tuple(bpy.data.objects[name].matrix_world.translation))
           for name in ("socket-hit","socket-eye","socket-weapon")}

approved,base_accessor,_ = helpers.parse_glb(BASE.read_bytes())
colors = {}
for model in approved["meshes"]:
    attributes = model["primitives"][0]["attributes"]
    if "COLOR_0" in attributes:
        colors[model["name"]] = {tuple(round(float(v),6) for v in (p[0],-p[2],p[1])): tuple(rgb[:3])+(1.,)
                                for p,rgb in zip(base_accessor(attributes["POSITION"]), base_accessor(attributes["COLOR_0"]))}
amber = bpy.data.materials["amber-core"]
tint = amber.node_tree.nodes.new("ShaderNodeVertexColor")
tint.layer_name = "Color"
shader = amber.node_tree.nodes.get("Principled BSDF")
shader.inputs["Base Color"].default_value = (1,1,1,1)
amber.diffuse_color = (1,1,1,1)
amber.node_tree.links.new(tint.outputs["Color"],shader.inputs["Base Color"])
pieces = []
for obj in originals:
    if obj.type != "MESH": continue
    group = obj.parent.name
    if obj.name.startswith(("facade-ogive","facade-sill")):
        group = "trellis-"+("left" if obj.name.endswith("-1") else "right")
    assert group in points, (obj.name, group)
    mesh = obj.data.copy()
    # The importer quantizes FLOAT_COLOR to bytes. Recover the approved linear
    # pod and visor samples by position before applying the rigid bind transform.
    while mesh.color_attributes: mesh.color_attributes.remove(mesh.color_attributes[0])
    layer = mesh.color_attributes.new(name="Color",type="FLOAT_COLOR",domain="POINT")
    lookup = colors.get(obj.data.name)
    for vertex in mesh.vertices:
        key = tuple(round(float(v),6) for v in vertex.co)
        layer.data[vertex.index].color = lookup[key] if lookup is not None else (1,1,1,1)
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
body.modifiers.new("Rigid castings and pruning tools","ARMATURE").object = arm
socket_nodes = []
for name,(parent,point) in sockets.items():
    node = bpy.data.objects.new(name,None)
    scene.collection.objects.link(node)
    node.parent,node.parent_type,node.parent_bone = arm,"BONE",parent
    bpy.context.view_layer.update()
    node.matrix_world = Matrix.Translation(point)
    socket_nodes.append(node)


def poses(name: str, t: int) -> dict[str, Matrix]:
    brace = double = jab = hit = fall = breath = lock = 0.
    strike = dict.fromkeys(sides,0.)
    if name.startswith("intent-"):
        amount = smooth(t, [(0,0),(14,1)])
        brace,double,jab = [amount if name.endswith(m) else 0. for m in MOVES]
    elif name == "action-trellis-brace":
        brace = smooth(t,[(0,1),(5,.88),(10,1.18),(19,1.18),(30,0)])
        lock = smooth(t,[(0,0),(5,0),(10,1),(19,1),(30,0)])
    elif name in ("attack","action-double-cut"):
        double = smooth(t,[(0,1),(31,1),(44,0)])
        for side,impact in [("left",12),("right",26)]:
            strike[side] = smooth(t,[(0,0),(impact-6,0),(impact,1),(impact+3,.85),(impact+12,0)])
    elif name == "action-hook-jab":
        jab = smooth(t,[(0,1),(13,1),(30,0)])
        strike["right"] = smooth(t,[(0,0),(4,0),(10,1),(13,.80),(25,0)])
    elif name=="hit": hit=smooth(t,[(0,0),(4,1),(10,-.20),(15,0)])
    elif name=="death": fall=smooth(t,[(0,0),(4,.02),(19,.74),(27,1),(32,.96),(38,1)])
    elif name=="idle": breath=math.sin(math.tau*t/60)
    result = {"root":Matrix.Identity(4)}

    def move(bone, parent, rx=0., ry=0., rz=0., delta=(0.,0.,0.)):
        result[bone] = result[parent] @ rigid(points[bone], turn(rx,ry,rz),delta)

    move("hips","root",delta=(0,-.14*fall,-.005*(1-math.cos(math.tau*t/60)) if name=="idle"
                                       else -.04*brace-.018*double-.032*jab-.01*abs(hit)-.54*fall))
    twist = strike["right"]-strike["left"]
    move("torso-frame","hips",-5*brace+4*double-7*jab+14*hit-67*fall+1.3*breath,
         -3*jab+6*fall,4*jab-8*twist)
    move("seed-pod","torso-frame",4*double+9*hit+13*fall)
    move("head","torso-frame",-9*brace-5*double+8*jab+12*hit-28*fall,0,-9*jab+8*twist+2*breath)
    for side,s in sides.items():
        swing = strike[side]
        lead = jab if s>0 else 0.
        guard = jab if s<0 else 0.
        move("trellis-"+side,"torso-frame",-2*brace-3*lock,0,-s*(19*double+8*jab-5*brace-4*lock))
        move("shoulder-"+side,"torso-frame",
             18*brace+8*double+3*lead+7*guard+58*swing+15*hit+85*fall,
             s*(-5*brace-36*double+16*guard-7*lead+20*swing-6*fall),
             s*(5*brace+5*guard+16*swing))
        move("elbow-"+side,"shoulder-"+side,
             110*brace+110*double+87*lead+16*guard-(106 if name in ("attack","action-double-cut") else 65)*swing+16*hit+9*fall,
             s*(13*brace+10*double-5*lead+12*guard),s*(46*brace+2*double+8*guard))
        move("forearm-tool-"+side,"elbow-"+side, 21*brace+16*double-(51 if name in ("attack","action-double-cut") else 25)*swing+6*fall,
             s*(-10*brace+10*double-12*swing),s*(12*brace+4*lead))
        gape = 11*brace+21*double+17*lead+6*guard-(26 if name in ("attack","action-double-cut") else 22)*swing+5*fall
        move(side+"-hook-hinge","forearm-tool-"+side,0,-s*gape)
        move(side+"-blade-hinge","forearm-tool-"+side,0,s*gape)
        hip,knee,ankle = (points[p+"-"+side] for p in ("hip","knee","foot"))
        h = result["hips"] @ hip
        axis = (ankle-h).normalized()
        d = (ankle-h).length
        a,b = (knee-hip).length,(ankle-knee).length
        along = (a*a-b*b+d*d)/(2*d)
        pole = (knee-hip)-axis*(knee-hip).dot(axis)
        k = h+along*axis+pole.normalized()*math.sqrt(max(0.,a*a-along*along))
        result["hip-"+side] = rigid(hip,(knee-hip).rotation_difference(k-h),h-hip)
        result["knee-"+side] = rigid(knee,(ankle-knee).rotation_difference(ankle-k),k-knee)
        result["foot-"+side] = Matrix.Identity(4)
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
core_primitive = next(p for p in primitives if g["materials"][p["material"]]["name"] == "amber-core")
core_colors = acc(core_primitive["attributes"]["COLOR_0"])[:,:3]
source_rgb = np.unique(np.array([rgb[:3] for lookup in colors.values() for rgb in lookup.values()]),axis=0)
color_err = float(max(np.min(np.max(np.abs(core_colors-rgb),axis=1)) for rgb in source_rgb))
assert color_err < .0001, color_err
inverse_bind = {n:arm.data.bones[n].matrix_local.inverted() for n in joint_names}
global_min,global_max = np.full(3,np.inf),np.full(3,-np.inf)
summary,holds,contacts = {},{},{}
max_socket = 0.
jaw_groups = {side:np.concatenate([groups[side+"-"+part+"-hinge"] for part in ("hook","blade")]) for side in sides}
forearm_groups = {side:np.concatenate([jaw_groups[side],groups["elbow-"+side],groups["forearm-tool-"+side]]) for side in sides}
frame_groups = np.concatenate([groups[n] for n in ("torso-frame","trellis-left","trellis-right","seed-pod")])
def collision_mesh(indices):
    mask = np.zeros(len(rest),dtype=bool)
    mask[indices] = True
    faces = [tuple(face.vertices) for face in body.data.polygons if mask[face.vertices[0]]]
    return (indices,np.searchsorted(indices,faces).tolist())


def overlap(a,b) -> bool:
    av,bv = geometry[a[0]],geometry[b[0]]
    if np.any(av.max(axis=0)<bv.min(axis=0)) or np.any(bv.max(axis=0)<av.min(axis=0)):
        return False
    at = BVHTree.FromPolygons(av.tolist(),a[1],all_triangles=True)
    bt = BVHTree.FromPolygons(bv.tolist(),b[1],all_triangles=True)
    return bool(at.overlap(bt))


collision_parts = [collision_mesh(np.sort(ids)) for ids in (frame_groups,*forearm_groups.values())]
# The local pruner plane tips travel past one another in depth on separate
# metal layers. Signed tip spacing measures the minimum closed aperture.
tip = {part:{side:Vector((s*x,y,z)) for side,s in sides.items()}
       for part,(x,y,z) in {"hook":(.438,.125,.763),"blade":(.424,.090,.777)}.items()}
for name,length in DURATIONS.items():
    arm.animation_data.action = actions[name]
    floors,soles,seams,clearances,reach,heights,socket_gaps = [],[],[],[],[],[],[]
    gap = {side:[] for side in sides}
    brace_angles = []
    crossings = [0,0,0]
    tip_path = {side:[] for side in sides}
    for frame in range(length+1):
        scene.frame_set(frame)
        evaluated = body.evaluated_get(bpy.context.evaluated_depsgraph_get())
        evaluated.data.vertices.foreach_get("co",geometry.ravel())
        assert np.allclose(evaluated.matrix_world,np.eye(4),atol=1e-5)
        global_min = np.minimum(global_min,geometry.min(axis=0))
        global_max = np.maximum(global_max,geometry.max(axis=0))
        if frame==0: start_pose=geometry.copy()
        if name.startswith("intent-") and frame==14: holds[name[7:]]=geometry.copy()
        if name.startswith("intent-") and frame>=14: seams.append(np.max(np.linalg.norm(geometry-holds[name[7:]],axis=1)))
        if name.startswith("action-") and frame==0: seams.append(np.max(np.linalg.norm(geometry-holds[name[7:]],axis=1)))
        if name.startswith("action-") and frame==length: seams.append(np.max(np.linalg.norm(geometry-rest,axis=1)))
        if name=="frozen" or (name=="idle" and frame==length): seams.append(np.max(np.linalg.norm(geometry-start_pose,axis=1)))
        floors.append(float(geometry[:,2].min()))
        soles.append(max(float(np.linalg.norm(geometry[groups["foot-"+side]]-rest[groups["foot-"+side]],axis=1).max()) for side in sides))
        heights.append(float(geometry[:,2].max()))
        deforms = {n:arm.matrix_world @ arm.pose.bones[n].matrix @ inverse_bind[n] for n in joint_names}
        for socket,(bone,p) in sockets.items():
            max_socket=max(max_socket,(bpy.data.objects[socket].matrix_world.translation-deforms[bone] @ Vector(p)).length)
        socket_gaps.append((bpy.data.objects["socket-weapon"].matrix_world.translation-bpy.data.objects["socket-hit"].matrix_world.translation).length)
        reach.append(float(bpy.data.objects["socket-weapon"].matrix_world.translation.y))
        brace_angles.append((deforms["torso-frame"].inverted()@deforms["trellis-right"]).to_euler().z)
        for index,(a,b) in enumerate(((0,1),(0,2),(1,2))):
            crossings[index] += int(overlap(collision_parts[a],collision_parts[b]))
        clearance = []
        for side,s in sides.items():
            to_tool = deforms["forearm-tool-"+side].inverted()
            jaw_tip = {part:to_tool @ deforms[side+"-"+part+"-hinge"] @ tip[part][side] for part in tip}
            tip_path[side].append(xyz(deforms[side+"-hook-hinge"] @ tip["hook"][side]))
            gap[side].append(float(s*(jaw_tip["hook"].x-jaw_tip["blade"].x)))
            jaw = geometry[jaw_groups[side]]; cage=geometry[frame_groups]
            # Disjoint axis-aligned boxes give a conservative lower bound.
            sep=np.maximum(0,np.maximum(jaw.min(axis=0)-cage.max(axis=0),cage.min(axis=0)-jaw.max(axis=0)))
            clearance.append(float(np.linalg.norm(sep)))
        left,right = [geometry[jaw_groups[side]] for side in sides]
        clearance.append(float(right[:,0].min()-left[:,0].max()))
        clearances.append(clearance)
    row={"duration":length/FPS,"framesChecked":length+1,"forearmIntersectionFrames":{"leftVsFrame":crossings[0],"rightVsFrame":crossings[1],"leftVsRight":crossings[2]},"minFloorM":min(floors),"maxFootVertexDriftM":max(soles),
         "minToolToFrameBoundsM":np.min(clearances,axis=0).tolist()[:2],
         "minLeftToRightJawGapM":float(np.min(clearances,axis=0)[2]),"minWeaponToHitSocketM":min(socket_gaps),
         "seamErrorM":float(max(seams,default=0)),"finalHeadHeightM":heights[-1]}
    if name in ("attack","action-double-cut"):
        row["contactFrames"]={side:int(np.argmin(gap[side])) for side in sides}
        row["contactTipPositionGltfM"]={side:tip_path[side][row["contactFrames"][side]] for side in sides}
        row["jawTipSpacingAtContactM"]={side:min(gap[side]) for side in sides}
        if name.startswith("action"): contacts["double-cut"]=row["contactFrames"]
    if name=="action-hook-jab": contacts["hook-jab"]=int(np.argmin(gap["right"]))
    if name=="action-trellis-brace": contacts["trellis-brace"]=int(np.argmax(np.round(brace_angles,5)))
    if name.startswith("action-"):
        row["impactFrame"]=BEATS[name[7:]][1]
        row["weaponForwardAtImpactM"]=reach[row["impactFrame"]]
    summary[name]=row
    print("MEASURE",name,row,flush=True)
print("CONTACT",contacts,flush=True)
assert contacts=={"double-cut":{"left":12,"right":26},"hook-jab":10,"trellis-brace":10}, contacts
assert min(r["minFloorM"] for r in summary.values())>-.001
assert max(r["maxFootVertexDriftM"] for r in summary.values())<.001
assert max(r["seamErrorM"] for r in summary.values())<.0001
assert max_socket<.0001
assert all(not any(r["forearmIntersectionFrames"].values()) for r in summary.values())
assert min(r["minLeftToRightJawGapM"] for r in summary.values())>0
assert min(min(r["minToolToFrameBoundsM"]) for r in summary.values())>0
assert summary["death"]["finalHeadHeightM"]<1.
center = (global_min+global_max)*.5
manifest = {"id":ID,"version":1,"glb":GLB.name,"frame":{"units":"m","up":"+Y","forward":"-Z","origin":"floor"},
            "root":ID,"mesh":ID+"-body","bounds":{"min":positions.min(axis=0).tolist(),"max":positions.max(axis=0).tolist()},
            "skeleton":{"root":"root","bones":len(joint_names),"joints":joint_names,"maxInfluences":max_infl},
            "rootMotion":"code-owned; root joint fixed",
            "clips":{n:{"duration":DURATIONS[n]/FPS,"loop":"repeat" if n in ("idle","frozen") else "once",
                        "events":{"impact":BEATS["double-cut"][1]/FPS} if n=="attack" else {"down":38/FPS} if n=="death" else {},
                        **({"held":True} if n=="frozen" else {"endsOnFloor":True} if n=="death" else {})}
                     for n in ("idle","attack","hit","death","frozen")},
            "intentClips":{m:"intent-"+m for m in MOVES},"actionClips":{m:"action-"+m for m in MOVES},
            "actionTimings":{m:{"duration":d/FPS,"impact":i/FPS} for m,(d,i) in BEATS.items()},
            "sockets":{n:{"bone":b,"parent":b,"position":xyz(p)} for n,(b,p) in sockets.items()},
            "emissive":{"material":"amber-core","color":"#FF9126","intensity":1.4,"nodes":["socket-eye"]},
            "materialSlots":{m:{"set":None,"factorOnly":True,**({"emissive":True} if m=="amber-core" else {})} for m in MATERIALS},
            "cull":{"center":xyz(center),"radius":float(np.linalg.norm(global_max-center))+.01},
            "budget":{"tris":triangles,"materials":4,"bones":len(joint_names),"influences":max_infl}}
manifest["actionTimings"]["double-cut"]["secondImpact"] = contacts["double-cut"]["right"]/FPS
write(ID+".manifest.json",manifest)
report = {"pass":True,"blender":bpy.app.version_string,"glb_sha256":sha(GLB),"blend_sha256":sha(BLEND),
          "generator_sha256":sha(Path(__file__)),"helper_sha256":sha(helper_path),"base_glb_sha256":sha(BASE),
          "base_blend_sha256":sha(BASE.with_suffix(".blend")),"base_generator_sha256":sha(Path(__file__).with_name("build-trellis-keeper-base.py")),
          "concept_sha256":sha(ROOT/"assets-source/concepts"/ID/(ID+".png")),
          "max_influences":max_infl,"unweighted_vertices":unweighted,"max_weight_sum_error":err,
          "triangleCount":triangles,"jointCount":len(joint_names),"materials":list(MATERIALS),"neutralBounds":manifest["bounds"],
          "measuredClips":summary,"measuredContactFrames":contacts,"sampleRateHz":FPS,
          "maxSocketTrackingErrorM":max_socket,"maxApprovedCoreVertexColorError":color_err,
          "holdRangeFrames":[14,20],"ownerRigClipReview":"pending"}
write("reimport-report.json",report)
scene.render.engine = "BLENDER_EEVEE"
scene.eevee.taa_render_samples = 12
scene.render.resolution_x,scene.render.resolution_y,scene.render.resolution_percentage = 440,456,100
scene.render.image_settings.file_format = "PNG"
scene.world = bpy.data.worlds.new("Conservatory studio")
scene.world.color = (.16,.18,.2)
scene.view_settings.view_transform = "AgX"

def aim(obj, target) -> None:
    obj.rotation_euler = (Vector(target)-obj.location).to_track_quat("-Z","Y").to_euler()

for label,loc,power,size in [("Warm key",(-1.8,2.4,3.3),270,2.1),
                             ("Shear fill",(2.1,2.4,1.7),130,1.8),("Trellis rim",(.6,-1.8,2.6),240,1.4)]:
    data = bpy.data.lights.new(label,"AREA")
    data.energy, data.shape, data.size = power,"DISK",size
    obj = bpy.data.objects.new(label,data)
    scene.collection.objects.link(obj)
    obj.location = loc
    aim(obj,(0,0,.85))
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.002))
floor = bpy.context.object
material = bpy.data.materials.new("Studio floor")
material.use_nodes = True
material.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (.065,.075,.085,1)
floor_shader = material.node_tree.nodes.get("Principled BSDF")
floor_shader.inputs["Emission Color"].default_value = (.030,.041,.050,1)
floor_shader.inputs["Emission Strength"].default_value = 1
floor.data.materials.append(material)
cam_data = bpy.data.cameras.new("Review camera")
cam = bpy.data.objects.new("Review camera",cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
cam_data.type = "ORTHO"
front,high,low = (.46,3.1,1.55),(2.1,3.0,1.81),(2.5,2.7,1.35)
cam_data.ortho_scale = 1.55
hook = (-2.5,2.2,1.55)
target = (0.,.15,.88)
shots = [
    ("Neutral","frozen",0,front),("Trellis Brace / draw in","intent-trellis-brace",20,front),
    ("Trellis Brace / latch","action-trellis-brace",10,high),
    ("Double Cut / tools open","intent-double-cut",20,front),("Double Cut / left, frame 12","action-double-cut",12,front),
    ("Double Cut / right, frame 26","action-double-cut",26,front),
    ("Hook Jab / lead hook","intent-hook-jab",20,hook),("Hook Jab / contact","action-hook-jab",10,hook),
    ("Hook Jab / recover","action-hook-jab",19,hook),
    ("Idle","idle",15,front),("Hit / recoil","hit",4,high),("Death / settled","death",42,low)]
font = next(p for p in (Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
                        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")) if p.is_file())

# Keep one fixed camera for each angle. Project every gallery pose to fit
# the complete silhouette, including both pruning tools.
framing = {}
for camera in (front,high,low,hook):
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
    framing[camera] = (Vector(camera)+displacement,Vector(target)+displacement,1.18*max(span[0],span[1]*440/456))

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
                render(action,frame,hook if move=="hook-jab" else front,tmp/f"motion-{frame_number:03d}.png")
                frame_number += 1
        render("frozen",0,hook if move=="hook-jab" else front,tmp/f"motion-{frame_number:03d}.png")
        for j in range(1,8):
            (tmp/f"motion-{frame_number+j:03d}.png").hardlink_to(tmp/f"motion-{frame_number:03d}.png")
        frame_number += 8
    subprocess.run(["ffmpeg","-v","error","-y","-framerate","15","-i",str(tmp/"motion-%03d.png"),
                    "-c:v","libx264","-crf","16","-pix_fmt","yuv420p","-movflags","+faststart",
                    str(OUT/"review-moves.mp4")],check=True)
report["reviewEvidence"] = {n:sha(OUT/n) for n in ("review-contact-sheet.png","review-moves.mp4")}
write("reimport-report.json",report)
