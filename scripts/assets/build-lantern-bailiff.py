"""Build and verify the Lantern Bailiff from its approved Blender base.

Run with Blender 5.2.2: blender -b -t 1 --python-exit-code 1 -P scripts/assets/build-lantern-bailiff.py
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import math
from pathlib import Path

import bpy
import numpy as np
from mathutils import Euler, Matrix, Quaternion, Vector
from mathutils.kdtree import KDTree

ID = "lantern-bailiff"
REPO = Path(__file__).resolve().parents[2]
STAGE = REPO / "assets-source/enemies" / ID / "staging"
OUT = STAGE / "runtime"
OUT.mkdir(exist_ok=True)
BASE = STAGE / "base" / (ID + "-base.blend")
GLB = OUT / (ID + ".glb")
BLEND = OUT / (ID + ".blend")
spec = importlib.util.spec_from_file_location("hound", Path(__file__).with_name("build-spring-hound.py"))
hound = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hound)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save_json(name: str, value: dict) -> None:
    (OUT / name).write_text(json.dumps(value, indent=2) + "\n")


def joint(name, parent, head, tail):
    bones.append((name, parent, head, tail))


bones = []
joint("root", None, (0, 0, 0), (0, 0, .12))
joint("pelvis", "root", (0, 0, .81), (0, 0, .92))
joint("chest", "pelvis", (0, 0, .86), (0, 0, 1.34))
joint("core", "chest", (0, .115, 1.15), (0, .115, 1.20))
joint("cage.upper", "chest", (0,.075,1.23), (0,.075,1.27))
joint("cage.lower", "chest", (0,.075,1.08), (0,.075,1.12))
joint("head", "chest", (0, 0, 1.45), (0, 0, 1.64))
grip = (-.46, .17, .975)
for side, s in (("L", -1), ("R", 1)):
    shoulder, elbow = (s*.245, 0, 1.29), (s*.32, .025, 1.04)
    wrist = (-.46, .16, 1.02) if s < 0 else (.34, .04, .82)
    joint("upper."+side, "chest", shoulder, elbow)
    joint("fore."+side, "upper."+side, elbow, wrist)
    joint("hand."+side, "fore."+side, wrist, grip if s < 0 else (.34, .07, .76))
    knee, ankle = (s*.16, 0, .46), (s*.17, 0, .105)
    joint("thigh."+side, "pelvis", (s*.125, 0, .74), knee)
    joint("shin."+side, "thigh."+side, knee, ankle)
    joint("foot."+side, "shin."+side, ankle, (s*.17, .14, .07))

links = [f"chain.{i+1:02}" for i in range(5)]
pivots = [grip] + [(-.46, .17, .9305-i*.039) for i in range(5)]
for i, link in enumerate(links):
    joint(link, links[i-1] if i else "hand.L", pivots[i], pivots[i+1])
joint("pendant", links[-1], pivots[-1], (-.46, .17, .50))

materials = ["dark-iron", "armor-steel", "aged-brass", "amber-core"]
sockets = {"socket-eye": ("head", (0,.10,1.57)), "socket-hit": ("chest", (0,.17,1.24)),
           "socket-weapon": ("pendant", (-.46,.17,.63))}


def owner(name: str) -> str:
    if name.startswith("outer-lantern"): return "pendant"
    if name.startswith("chain-link"): return links[int(name[-2:])]
    if name.startswith("grip"): return "hand.L"
    if name.startswith("hip"): return "pelvis"
    if name.startswith(("head", "eye")): return "head"
    if name == "torso-lantern-core": return "core"
    if name == "torso-cage-band-1.23": return "cage.upper"
    if name == "torso-cage-band-1.08": return "cage.lower"
    if name.startswith(("torso", "neck")): return "chest"
    family, side, part = name.split("-", 2)
    if family == "arm":
        limb = ("fore" if part.startswith(("elbow", "forearm")) else "hand"
                if part.startswith(("hand", "finger", "thumb", "palm")) else "upper")
    elif family == "leg":
        limb = ("foot" if part.startswith(("ankle", "foot", "toe")) else "shin"
                if part.startswith(("knee", "shin")) else "thigh")
    else:
        raise ValueError(name)
    return limb + (".L" if side=="left" else ".R")


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(BASE.with_suffix(".glb")))
scene = bpy.context.scene
scene.render.fps = 30
scene.frame_start = 0
scene.frame_end = 60
bpy.context.preferences.filepaths.save_version = 0
originals = list(scene.objects)
pieces = []
deps = bpy.context.evaluated_depsgraph_get()
for obj in originals:
    if obj.type != "MESH": continue
    evaluated = obj.evaluated_get(deps)
    mesh = bpy.data.meshes.new_from_object(evaluated, depsgraph=deps)
    mesh.transform(obj.matrix_world)
    if obj.name.startswith("chain-link"):
        mesh.materials[0] = bpy.data.materials["armor-steel"]
    copy = bpy.data.objects.new("skin-" + obj.name, mesh)
    scene.collection.objects.link(copy)
    group = copy.vertex_groups.new(name=owner(obj.name))
    group.add(list(range(len(mesh.vertices))), 1, "REPLACE")
    pieces.append(copy)
for obj in originals:
    bpy.data.objects.remove(obj, do_unlink=True)
bpy.ops.object.select_all(action="DESELECT")
for obj in pieces: obj.select_set(True)
body = pieces[0]
bpy.context.view_layer.objects.active = body
bpy.ops.object.join()
body.name = ID + "-body"
hound.BONES = bones
arm = hound.build_armature(bpy, scene, ID)
body.parent = arm
body.modifiers.new("Rigid metal assemblies", "ARMATURE").object = arm
socket_objects = []
for name, (parent, pos) in sockets.items():
    obj = bpy.data.objects.new(name, None)
    scene.collection.objects.link(obj)
    obj.parent, obj.parent_type, obj.parent_bone = arm, "BONE", parent
    bpy.context.view_layer.update()
    obj.matrix_world = Matrix.Translation(pos)
    socket_objects.append(obj)

MOVES = ["draw-chain", "lantern-sweep", "cinder-glance", "lantern-parry"]
# Times are authored in frames so the impact markers land on exported samples.
durations = {"idle": 60, "attack": 36, "hit": 15, "death": 45, "frozen": 30}
timings = dict(zip(MOVES, [(30, 16), (36, 15), (24, 10), (27, 9)]))
durations.update({"intent-"+move: 18 for move in MOVES})
durations.update({"action-"+move: pair[0] for move,pair in timings.items()})


def curve(frame: float, points: list[tuple[float,float]]) -> float:
    """C1 interpolation between authored beats, clamped outside the clip."""
    for (start, a), (end, b) in zip(points, points[1:]):
        if frame <= end:
            u = max(0.0, (frame-start)/(end-start))
            return a+(b-a)*u*u*(3-2*u)
    return points[-1][1]


def rotation(x=0., y=0., z=0.):
    return Euler(tuple(math.radians(a) for a in (x,y,z)), "XYZ").to_quaternion()


def pose(name: str, t: int):
    # Arm windup, arm release and the six absolute pendulum segment pitches
    # have independent envelopes. Distal peaks arrive progressively later.
    cock = drive = guard = glance = shock = fall = blink = 0.
    chain = [0.] * 6
    breath = 0.
    if name.startswith("intent-"):
        move = name[7:]
        amount = curve(t, [(0,0),(10,1)])
        if move in MOVES[:2]:
            cock = amount*(.72 if move == "draw-chain" else 1)
            chain = [-cock*(29+2*i) for i in range(6)]
        elif move == "lantern-parry": guard = amount
        else: glance = amount
    elif name in ("attack","action-lantern-sweep"):
        # Shared attack uses the authored sweep. At t=0 the exact held tell
        # is preserved for a seamless transition from intent to action.
        cock = curve(t, [(0,1),(3,1),(12,0)])
        drive = curve(t, [(0,0),(3,0),(12,1),(16,.99),(24,.22),(30,-.04),(36,0)])
        chain = [curve(t, [(0,-29-2*i),(3+.5*i,-36-2*i),(13+.65*i,77+1.8*i),
                           (23+.5*i,-24-1.1*i),(30+.4*i,9+.6*i),(36,0)]) for i in range(6)]
    elif name == "action-draw-chain":
        cock = curve(t, [(0,.72),(4,.63),(16,1.12),(24,.98),(30,1)])
        chain = [curve(t,[(0,-.72*(29+2*i)),(5+i,-13),(15+.5*i,-42-2*i),
                          (23+.4*i,-26-2*i),(30,-29-2*i)]) for i in range(6)]
    elif name == "action-lantern-parry":
        guard = curve(t, [(0,1),(4,.82),(9,1.24),(14,1.12),(27,0)])
    elif name == "action-cinder-glance":
        glance = curve(t,[(0,1),(6,.78),(10,1.27),(14,1.08),(24,0)])
        blink = curve(t,[(0,0),(7,0),(10,1),(15,.15),(20,0)])
    elif name == "idle":
        breath = math.sin(2*math.pi*t/60)
        chain = [1.8*math.sin(2*math.pi*t/60-.085*i) for i in range(6)]
    elif name == "hit":
        shock = curve(t,[(0,0),(4,1),(9,-.16),(15,0)])
        chain = [curve(t,[(0,0),(4+.45*i,-14),(10+.3*i,6),(15,0)]) for i in range(6)]
    elif name == "death":
        fall = curve(t,[(0,0),(8,.08),(30,1),(33,.97),(38,1)])
        chain = [fall*83 for _ in chain]
    rotations = {"pelvis": rotation(86*fall), "chest": rotation(2*breath+4*cock-9*drive-8*glance-11*shock,
                   2*guard, 7*cock-11*drive-8*glance),
                 "head": rotation(-12*glance+10*shock, 7*glance, 16*glance),
                 "upper.L": rotation(-78*cock+62*drive, 15*cock+15*drive, 0),
                 "fore.L": rotation(-44*cock+20*drive, 0, -12*cock+6*drive),
                 "hand.L": rotation(10*cock-13*drive),
                 "upper.R": rotation(58*guard+12*drive, -10*guard, 8*guard),
                 "fore.R": rotation(53*guard,12*guard,59*guard),
                 "hand.R": rotation(8*guard), "thigh.L":rotation(-9*fall),
                 "thigh.R":rotation(8*fall), "shin.L":rotation(20*fall)}
    return rotations, chain, blink


arm.animation_data_create()
actions = {}
basis = {b.name: b.matrix_local.to_quaternion() for b in arm.data.bones}
for name, frames in durations.items():
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    actions[name] = action
    arm.animation_data.action = action
    for t in range(frames+1):
        rotations, pitches, blink = pose(name,t)
        world = {}
        for bone, parent, head, tail in bones:
            local = rotations.get(bone, Quaternion())
            parent_rot = world.get(parent, Quaternion())
            if bone in links or bone=="pendant":
                idx = links.index(bone) if bone in links else 5
                local = parent_rot.inverted() @ rotation(pitches[idx])
            world[bone] = parent_rot @ local
            pb = arm.pose.bones[bone]
            pb.rotation_quaternion = basis[bone].inverted() @ local @ basis[bone]
            if bone != "root":
                pb.keyframe_insert(data_path="rotation_quaternion",frame=t)
            if bone=="core":
                pb.scale = (1+.06*blink, 1+.09*blink, 1+.09*blink)
                pb.keyframe_insert(data_path="scale",frame=t)
            if bone in ("cage.upper","cage.lower"):
                slide = .045 if bone=="cage.upper" else -.045
                pb.location = basis[bone].inverted() @ Vector((0,0,slide*blink))
                pb.keyframe_insert(data_path="location",frame=t)
            if bone=="pelvis":
                pb.location = (0,0,0)
                pb.keyframe_insert(data_path="location",frame=t)
    if name=="death":
        # Preserve floor contact through the fall and the small rebound.
        for t in range(frames+1):
            scene.frame_set(t)
            evaluated = body.evaluated_get(bpy.context.evaluated_depsgraph_get())
            zmin = min(v.co.z for v in evaluated.data.vertices)
            pb = arm.pose.bones["pelvis"]
            pb.location += basis["pelvis"].inverted() @ Vector((0,0,-zmin))
            pb.keyframe_insert(data_path="location",frame=t)

arm.animation_data.action = None
for pb in arm.pose.bones:
    pb.matrix_basis = Matrix.Identity(4)
bpy.context.view_layer.update()
hound.export_glb(bpy,[arm,body,*socket_objects],arm,GLB)
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND),compress=True)
print("STAGED",GLB,flush=True)

g, acc, _ = hound.parse_glb(GLB.read_bytes())
nodes = g["nodes"]
names = [n.get("name") for n in nodes]
skin, = g["skins"]
joints = [names[i] for i in skin["joints"]]
assert set(joints)=={n[0] for n in bones} and len(joints)<=40
prims = [p for m in g["meshes"] for p in m["primitives"]]
tris = sum(len(acc(p["indices"]))//3 for p in prims)
assert tris <= 25000 and not g.get("images") and not g.get("textures")
assert {m["name"] for m in g["materials"]}==set(materials)
positions = np.concatenate([acc(p["attributes"]["POSITION"]) for p in prims])
weights = np.concatenate([acc(p["attributes"]["WEIGHTS_0"]) for p in prims])
ji = np.concatenate([acc(p["attributes"]["JOINTS_0"]) for p in prims])
max_influences = int((weights>1e-6).sum(axis=1).max())
unweighted = int((weights.sum(axis=1)<1e-6).sum())
weight_error = float(np.abs(weights.sum(axis=1)-1).max())
assert max_influences == 1 and not unweighted and weight_error < 1e-6
assert np.isfinite(acc(skin["inverseBindMatrices"])).all()
animations = {a["name"]: a for a in g["animations"]}
assert set(animations)==set(durations)
for name,anim in animations.items():
    end = max(float(acc(s["input"]).max()) for s in anim["samplers"])
    assert abs(end - durations[name]/30)<1e-5
    for c in anim["channels"]:
        if c["target"]["node"]==names.index("root"):
            vals = acc(anim["samplers"][c["sampler"]]["output"])
            assert np.allclose(vals,vals[0],atol=1e-6)

# Import into a clean Blender file. Measurements use the imported skin, evaluated
# geometry and sockets. The glTF importer may reorient bones, so samples use
# the bind-to-current deform matrix rather than the importer's displayed tails.
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 30
bpy.ops.import_scene.gltf(filepath=str(GLB),disable_bone_shape=True)
arm, = [o for o in scene.objects if o.type=="ARMATURE"]
body, = [o for o in scene.objects if o.type=="MESH"]
imported = {a.name:a for a in bpy.data.actions}
assert set(imported)==set(durations), list(imported)
for track in arm.animation_data.nla_tracks: track.mute = True
rest_inv = {n:arm.data.bones[n].matrix_local.inverted() for n in joints}
vertex_groups = np.array([v.groups[0].group for v in body.data.vertices])
mask = lambda seq: np.isin(vertex_groups, [body.vertex_groups[n].index for n in seq])
chain_mask = mask(links+["pendant"])
torso_mask = mask(["pelvis","chest","core","head","thigh.L","thigh.R","shin.L","shin.R","foot.L","foot.R"])
feet = {side:mask(["foot."+side]) for side in ("L","R")}
verts = np.empty(len(body.data.vertices)*3,dtype=np.float32)
cull_min = np.full(3,np.inf)
cull_max = -cull_min
skinned_indices = [np.flatnonzero(mask([n])) for n in ["hand.L",*links,"pendant"]]
# The final contact is at the lantern eyelet, and the bolt is in the palm.
rest = np.array([v.co[:] for v in body.data.vertices])
skinned_indices[0] = skinned_indices[0][np.linalg.norm(rest[skinned_indices[0]]-grip,axis=1)<.08]
skinned_indices[-1] = skinned_indices[-1][rest[skinned_indices[-1],2]>.731]
glow_slot = next(i for i,m in enumerate(body.data.materials) if m.name=="amber-core")
core_indices = sorted({i for f in body.data.polygons if f.material_index==glow_slot
                       for i in f.vertices if vertex_groups[i]==body.vertex_groups["pendant"].index})
max_surface_gaps = np.zeros(6)
max_core_tracking_error = 0.
max_anchor = max_joint_gap = max_length_error = max_socket_error = max_ring_gap = 0.
min_floor = min_clearance = np.inf
summary = {}
sweep = []
held_poses = {}
socket_rest = Vector(sockets["socket-weapon"][1])
source_lens = [(Vector(b)-Vector(a)).length for a,b in zip(pivots,pivots[1:])]
for name, frames in durations.items():
    arm.animation_data.action = imported[name]
    floors,clearances,soles, ys = [],[],[],[]
    for t in range(frames+1):
        scene.frame_set(t)
        deps = bpy.context.evaluated_depsgraph_get()
        P = {n:arm.matrix_world @ arm.pose.bones[n].matrix @ rest_inv[n] for n in ["hand.L",*links,"pendant"]}
        def point(n, p): return P[n] @ Vector(p)
        anchor = point("hand.L",grip)
        link_heads = [point(n,p) for n,p in zip(links,pivots)]
        end = point("pendant",pivots[-1])
        max_anchor = max(max_anchor,(anchor-link_heads[0]).length)
        centers = [point(n,(-.46,.17,.95-i*.039)) for i,n in enumerate(links)]
        centers.append(point("pendant",(-.46,.17,.755)))
        for a,b in zip(centers,centers[1:]):
            # Two projected ring outer radii (0.032 m each).
            max_ring_gap = max(max_ring_gap,(a-b).length-.064)
        for i,link in enumerate(links):
            b = point(link,pivots[i+1])
            nxt = (link_heads + [end])[i+1]
            max_joint_gap = max(max_joint_gap,(b-nxt).length)
            max_length_error = max(max_length_error,abs((link_heads[i]-b).length-source_lens[i]))
        weapon = bpy.data.objects["socket-weapon"].matrix_world.translation
        max_socket_error = max(max_socket_error,(weapon-point("pendant",socket_rest)).length)
        # The joined body has identity world transform after glTF re-import.
        obj = body.evaluated_get(deps)
        assert np.allclose(np.asarray(obj.matrix_world),np.eye(4),atol=1e-5)
        obj.data.vertices.foreach_get("co",verts)
        v = verts.reshape(-1,3)
        if name.startswith("intent-") and t==10:
            held_poses[name.removeprefix("intent-")] = v.copy()
        if name.startswith("intent-") and t>10:
            assert np.allclose(v,held_poses[name.removeprefix("intent-")],atol=1e-5)
        if name.startswith("action-") and t==0:
            assert np.allclose(v,held_poses[name.removeprefix("action-")],atol=1e-5)
        for i,(a,b) in enumerate(zip(skinned_indices,skinned_indices[1:])):
            kd = KDTree(len(a))
            for j in a: kd.insert(v[j],int(j))
            kd.balance()
            max_surface_gaps[i] = max(max_surface_gaps[i], min(kd.find(v[j])[2] for j in b))
        glow = v[core_indices]
        core_center = (glow.min(axis=0)+glow.max(axis=0))*.5
        max_core_tracking_error = max(max_core_tracking_error,float(np.linalg.norm(np.array(weapon)-core_center)))
        floors.append(float(v[chain_mask,2].min()))
        clearances.append(float(v[torso_mask,0].min()-v[chain_mask,0].max()))
        soles.append([float(v[m,2].min()) for m in feet.values()])
        ys.append(float(weapon.y))
        cull_min = np.minimum(cull_min,v.min(axis=0))
        cull_max = np.maximum(cull_max,v.max(axis=0))
        if name=="action-lantern-sweep":
            angles = []
            for i,n in enumerate(links+["pendant"]):
                direction = -(P[n].to_3x3() @ Vector((0,0,1)))
                angles.append(math.degrees(math.atan2(direction.y,-direction.z)))
            sweep.append(dict(frame=t, seconds=t/30, grip=list(anchor),weapon=list(weapon),pitch=angles))
    min_floor = min(min_floor,min(floors))
    min_clearance = min(min_clearance,min(clearances))
    summary[name] = {"framesChecked":frames+1, "duration":frames/30, "minChainFloorM":min(floors),
                     "minChainTorsoLateralClearanceM":min(clearances),"maxSoleHeightM":np.max(soles,axis=0).tolist(),
                     "weaponForwardRangeM":[min(ys),max(ys)]}
    if name=="death": summary[name]["finalMeshFloorM"] = float(v[:,2].min())
peak = max(sweep,key=lambda row:row["weapon"][1])["frame"]
crest = [max(sweep,key=lambda row:row["pitch"][i])["frame"] for i in range(6)]
assert max_anchor < .0001 and max_joint_gap < .0001 and max_length_error < .0001 and max_socket_error < .0001
assert min_floor >= -.001 and min_clearance > .005, (min_floor, min_clearance, summary)
assert max(max_surface_gaps)<.012 and max_core_tracking_error < .0001, (max_surface_gaps,max_core_tracking_error)
assert max_ring_gap < .001 and crest[-1]>crest[0] and 5<peak<30
assert abs(summary["death"]["finalMeshFloorM"])<.001
assert max(summary["action-lantern-parry"]["maxSoleHeightM"])<.001
timings["lantern-sweep"] = (durations["action-lantern-sweep"],peak)
cull_center = (cull_min+cull_max)/2
gltf_point = lambda p:[float(p[0]),float(p[2]),float(-p[1])]
manifest = {"id":ID, "version":1, "glb":GLB.name, "frame":{"units":"m","up":"+Y","forward":"-Z","origin":"floor"},
            "root":ID,"mesh":ID+"-body","bounds":{"min":positions.min(axis=0).tolist(),"max":positions.max(axis=0).tolist()},
            "skeleton":{"root":"root","bones":len(joints),"joints":joints,"maxInfluences":1},"rootMotion":"code-owned; root joint fixed",
            "clips":{n:{"duration":durations[n]/30,"loop":"repeat" if n in ("frozen","idle") else "once",
                    "events":{"impact":peak/30} if n=="attack" else {"down":38/30} if n=="death" else {},
                    **({"held":True} if n=="frozen" else {"endsOnFloor":True} if n=="death" else {})}
                    for n in ("idle","attack","hit","death","frozen")},
            "intentClips":{m:"intent-"+m for m in MOVES},"actionClips":{m:"action-"+m for m in MOVES},
            "actionTimings":{m:{"duration":frames/30,"impact":impact/30} for m,(frames,impact) in timings.items()},
            "sockets":{n:{"bone":b,"parent":b,"position":gltf_point(p)} for n,(b,p) in sockets.items()},
            "emissive":{"material":"amber-core","color":"#FF9126","intensity":1.4,"nodes":["socket-hit"]},
            "materialSlots":{n:{"set":None,"factorOnly":True,**({"emissive":True} if n=="amber-core" else {})} for n in materials},
            "cull":{"center":gltf_point(cull_center),"radius":float(np.linalg.norm(cull_max-cull_center))+.01},
            "budget":{"tris":tris,"materials":4,"bones":len(joints),"influences":1}}
save_json(ID+".manifest.json",manifest)
report = {"pass":True, "blender":bpy.app.version_string, "glb_sha256":sha(GLB),"blend_sha256":sha(BLEND),
          "generator_sha256":sha(Path(__file__)),"base_blend_sha256":sha(BASE),"base_glb_sha256":sha(BASE.with_suffix(".glb")),
          "max_influences":max_influences,"unweighted_vertices":unweighted,"max_weight_sum_error":weight_error,
          "triangles":tris,"materials":materials,"bones":joints,"measuredClips":summary,"weaponImpactFrame":peak,
          "neutralFacing":"Blender +Y; glTF -Z","jointPeakFramesProximalToDistal":crest,
          "maxNearestRingSurfaceVertexDistanceM":max_surface_gaps.tolist(),
          "ringSurfacePairOrder":["grip-link1","link1-link2","link2-link3","link3-link4","link4-link5","link5-eyelet"],
          "maxWeaponSocketToVisibleCoreCenterM":max_core_tracking_error,
          "sweepPendantPitchRangeDegrees":[min(r["pitch"][-1] for r in sweep),max(r["pitch"][-1] for r in sweep)],
          "peakPitchLagSeconds":(crest[-1]-crest[0])/30,
          "maxHandAnchorGapM":max_anchor,"maxLinkJointGapM":max_joint_gap,"maxLinkLengthErrorM":max_length_error,
          "maxSocketTrackingErrorM":max_socket_error,"maxRingEnvelopeGapM":max_ring_gap,
          "minChainFloorM":min_floor,"minChainTorsoLateralClearanceM":min_clearance,"sweepFrames":sweep,
          "intentHoldAndActionHandoff":"all evaluated vertices within 0.01 mm, frames 10-18 and corresponding action frame 0",
          "ownerRigClipReview":"pending"}
save_json("reimport-report.json",report)
print("VERIFIED", peak, crest, min_floor, min_clearance, flush=True)

# Render the actual GLB at game-facing and arc-reading angles, including the
# moving contact between interlocked links. PNGs are assembled losslessly.
import subprocess
import tempfile

scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x, scene.render.resolution_y = 448, 448
scene.render.resolution_percentage = 100
scene.eevee.taa_render_samples = 12
scene.render.image_settings.file_format = "PNG"
scene.world = bpy.data.worlds.new("Review studio")
scene.world.color = (.16,.17,.19)
scene.view_settings.view_transform = "AgX"


def aim(obj, target):
    obj.rotation_euler = (Vector(target)-obj.location).to_track_quat("-Z","Y").to_euler()


for label, xyz, power, size in [("Key",(-2.4,3.2,3.5),260,2.4),("Fill",(2,1.5,2.1),160,2),("Rim",(0,-2.2,3.2),220,1.4)]:
    data = bpy.data.lights.new(label,"AREA")
    data.energy, data.shape, data.size = power, "DISK", size
    obj = bpy.data.objects.new(label,data)
    scene.collection.objects.link(obj)
    obj.location = xyz
    aim(obj,(0,0,.9))
bpy.ops.mesh.primitive_plane_add(size=200, location=(0,0,-.004))
floor = bpy.context.object
mat = bpy.data.materials.new("studio-floor")
mat.diffuse_color = (.075,.085,.10,1)
floor.data.materials.append(mat)
cam_data = bpy.data.cameras.new("Review camera")
cam = bpy.data.objects.new("Review camera",cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
cam_data.type = "ORTHO"
cam_data.ortho_scale = 2.03
sweep_cam = (-3.3,2.25,1.50)
front_cam = (-.75,3.7,1.37)
shots = [
    ("Neutral", "frozen",0,sweep_cam), ("Sweep tell", "intent-lantern-sweep",18,sweep_cam),
    ("Acceleration", "action-lantern-sweep",8,sweep_cam), ("Forward impact", "action-lantern-sweep",peak,sweep_cam),
    ("Follow-through", "action-lantern-sweep",21,sweep_cam), ("Settling", "action-lantern-sweep",28,sweep_cam),
    ("Cinder glance","action-cinder-glance",10,front_cam), ("Lantern parry","action-lantern-parry",9,front_cam),
    ("Down","death",45,sweep_cam)]
font = next(p for p in (Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
                        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")) if p.is_file())
with tempfile.TemporaryDirectory() as tmp:
    images = []
    for i,(label,action,frame,location) in enumerate(shots):
        arm.animation_data.action = imported[action]
        scene.frame_set(frame)
        cam.location = location
        target = (-.05,0,.84)
        if action=="death":
            obj = body.evaluated_get(bpy.context.evaluated_depsgraph_get())
            bounds = np.asarray([v.co[:] for v in obj.data.vertices])
            target = ((bounds.min(axis=0)+bounds.max(axis=0))*.5).tolist()
        aim(cam,target)
        scene.render.filepath = str(Path(tmp)/f"{i}-render.png")
        bpy.ops.render.render(write_still=True)
        img = str(Path(tmp)/f"{i}-label.png")
        subprocess.run(["magick",scene.render.filepath,"-background","#20232a","-gravity","south","-splice","0x42",
                        "-fill","white","-font",str(font),"-pointsize","19","-annotate","+0+9",label,img],check=True)
        images.append(img)
    subprocess.run(["magick","montage",*images,"-tile","3x3","-geometry","+2+2",
                    "-background","#20232a",str(OUT/"review-contact-sheet.png")],check=True)

    cam.location = (-3.65,.95,1.52)
    cam_data.ortho_scale = 1.70
    aim(cam,(-.33,.03,1.03))
    scene.render.resolution_x, scene.render.resolution_y = 640,448
    motion = [("frozen",0)]*6 + [("intent-lantern-sweep",f) for f in range(19)]
    motion += [("action-lantern-sweep",f) for f in range(37)] + [("frozen",0)]*6
    cache = {}
    for index,(action,frame) in enumerate(motion):
        path = Path(tmp)/f"motion-{index:03}.png"
        if (action,frame) in cache:
            path.hardlink_to(cache[action,frame])
            continue
        arm.animation_data.action = imported[action]
        scene.frame_set(frame)
        scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        cache[action,frame] = path
    subprocess.run(["ffmpeg","-v","error","-y","-framerate","30","-i",str(Path(tmp)/"motion-%03d.png"),
                    "-c:v","libx264","-crf","17","-pix_fmt","yuv420p","-movflags","+faststart",
                    str(OUT/"review-sweep.mp4")],check=True)
