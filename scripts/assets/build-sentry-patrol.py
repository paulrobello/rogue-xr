"""Author the Cog Sentry patrol on its original Blender armature.

blender -b -t 2 --python-exit-code 1 -P scripts/assets/build-sentry-patrol.py
Use -- --renders to render six reimported poses. Add --movie for a continuous
world-motion review with the original brass materials on a measured floor.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import struct
import sys
import tempfile
from pathlib import Path

import bpy
from mathutils import Euler, Quaternion, Vector

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "public/assets/enemies/cog-sentry/cog-sentry.glb"
SOURCE = ROOT / "assets-source/enemies/cog-sentry/blend/cog-sentry.low.blend"
ART = ROOT / "assets-source/enemies/cog-sentry-patrol"
RUNTIME = ROOT / "public/assets/enemies/cog-sentry-patrol/locomotion.glb"
FPS = 60
STRIDE = 1.08
STANCE = 7 / 12
LEAD = STRIDE * STANCE / 2
FRAMES = {"patrol-start": 30, "patrol-walk": 72, "patrol-stop": 42,
          "patrol-turn-left": 72, "patrol-turn-right": 72}
TAU = 2 * math.pi
SIDES = (("R", 1), ("L", -1))
spec = importlib.util.spec_from_file_location("cog_sentry", Path(__file__).with_name("build-cog-sentry.py"))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


def smooth(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def swing(t: float) -> tuple[float, float, float]:
    """Travel, ankle clearance and shoe pitch between two planted placements."""
    u = max(0.0, min(1.0, t))
    soft = u**3 * (10 - 15 * u + 6 * u**2)
    lift = math.sin(math.pi * u) ** 2
    return soft, lift * (0.125 - 0.025 * u), lift * (-11 * math.cos(math.pi * u) + 3)


def yaw(degrees: float) -> Quaternion:
    return Quaternion((0, 0, 1), math.radians(degrees))


def angles(x: float, y: float, z: float) -> Quaternion:
    return Euler(tuple(map(math.radians, (x, y, z))), "XYZ").to_quaternion()


def travel(clip: str, u: float) -> tuple[float, float]:
    if clip == "patrol-start":
        return 0.225 * u**2, 0
    if clip == "patrol-walk":
        return STRIDE * u, 0
    if clip == "patrol-stop":
        return 0.315 * (2 * u - u**2), 0
    return 0, (90 if clip.endswith("left") else -90) * smooth(u)


def sample(clip: str, u: float) -> tuple[dict, dict]:
    """Targets are in armature space, with the gameplay transform removed."""
    distance, heading = travel(clip, u)
    feet = {}
    if clip.startswith("patrol-turn"):
        direction = 1 if clip.endswith("left") else -1
        lead = "L" if direction == 1 else "R"
        loading = 0.0
        for side, sign in SIDES:
            placements = [(0.075, 0.31, 0, 45), (0.67, 0.91, 45, 90)] if side == lead else [(0.333, 0.655, 0, 90)]
            shoe_heading = lift = pitch = 0.0
            for start, end, initial, final in placements:
                if u < start:
                    break
                progress = min(1.0, (u - start) / (end - start))
                advance, clearance, shoe_pitch = swing(progress)
                shoe_heading = initial + (final - initial) * advance
                lift, pitch = clearance * 0.78, shoe_pitch * 0.38
                loading -= sign * math.sin(math.pi * progress) ** 2
            bearing = direction * shoe_heading - heading
            rot = yaw(bearing)
            ankle = rot @ Vector((sign * 0.12, 0, 0.11 + lift))
            feet[side] = ankle, rot @ angles(pitch, 0, 0), lift < 1e-9
        envelope = math.sin(math.pi * u) ** 2
        # The mask sights the new corridor before the breastplate and hips arrive.
        sight = direction * (smooth(u / 0.55) - smooth(u)) * 78
        upper = {
            "hips_loc": (0.043 * loading, 0.007 * envelope, -0.060 * envelope - 0.018 * abs(loading)),
            "hips": (0, 1.7 * loading, 0.15 * sight),
            "spine": (-3.0 * envelope, -1.5 * loading, 0.25 * sight),
            "chest": (1.0 * envelope, 0, 0.25 * sight),
            "neck": (0, 0, 0.16 * sight), "head": (1.5 * envelope, 0, 0.38 * sight),
            "cog": (0, -16 * direction * envelope, 0),
        }
        for side, sign in SIDES:
            upper[f"upperarm.{side}"] = (sign * 0.30 * sight - 3 * envelope, -sign * (5 + 3 * envelope), 0)
            upper[f"forearm.{side}"] = (8 + (9 + sign * direction * 4) * envelope, 0, 0)
            upper[f"hand.{side}"] = (-3 * envelope, 0, 0)
        return upper, feet

    phase = (distance - 0.225) / STRIDE if clip == "patrol-start" else distance / STRIDE
    weight = smooth(u) if clip == "patrol-start" else 1 - smooth(u) if clip == "patrol-stop" else 1.0
    w = TAU * phase
    step = math.cos(w)
    transfer = math.sin(w - 0.48)
    # Two compression beats to each revolution, with a short heel-strike recoil.
    compress = -0.091 - 0.021 * math.cos(2 * w - 0.72) - 0.008 * math.cos(4 * w - 1.1)
    upper = {
        "hips_loc": (weight * 0.033 * transfer, weight * 0.010 * math.sin(2 * w), weight * compress),
        "hips": (weight * (1.0 + 0.75 * math.cos(2 * w)), -2.4 * weight * transfer, 4.4 * weight * step),
        "spine": (-weight * (5.0 + 1.7 * math.cos(2 * w - 1.1)), 1.5 * weight * transfer, -3 * weight * step),
        "chest": (1.5 * weight * math.cos(2 * w - 1.75), 1.1 * weight * transfer, -8.0 * weight * math.cos(w - 0.2)),
        "neck": (1.6 * weight, 0, 2.1 * weight * step),
        "head": (weight * (2.5 - 0.8 * math.cos(2 * w - 0.8)), 0, 4.0 * weight * math.cos(w - 0.3)),
        "cog": (0, -weight * (8 * math.sin(2 * w) + 1.5 * math.sin(4 * w)), 0),
    }
    for side, sign in SIDES:
        p = (phase + (0.0 if side == "R" else 0.5)) % 1.0
        if clip == "patrol-walk":
            advance, lift, pitch = swing((p - STANCE) / (1 - STANCE))
            y = LEAD - STRIDE * p + STRIDE * advance
        elif clip == "patrol-start":
            advance, lift, pitch = swing((u - 0.10) / 0.86) if side == "R" else (0, 0, 0)
            y = 0.54 * advance - distance
        else:
            advance, lift, pitch = swing((u - 0.13) / 0.70) if side == "L" else (1, 0, 0)
            y = -0.225 + 0.54 * advance - distance
        feet[side] = Vector((sign * 0.12, y, 0.11 + lift)), angles(pitch, 0, 0), lift < 1e-9
        arm = -sign * math.cos(w - 0.18)
        upper[f"clavicle.{side}"] = (0, sign * weight * (1.0 + 1.2 * arm), 0)
        upper[f"upperarm.{side}"] = (weight * (-3 + 22 * arm), -sign * (5 + 2.8 * weight), 0)
        upper[f"forearm.{side}"] = (8 + weight * (10 - sign * 10 * math.cos(w - 0.42)), 0, 0)
        upper[f"hand.{side}"] = (weight * (-3 + sign * 4.5 * math.cos(w - 0.63)), 0, 0)
    return upper, feet


def solve_leg(rig, side: str, ankle: Vector, shoe: Quaternion, hips_rot: Quaternion, offset: Vector) -> None:
    """Two-link IK, with a forward knee pole and a separately orientable sole."""
    thigh, shin, foot = [rig.pose.bones[f"{name}.{side}"] for name in ("thigh", "shin", "foot")]
    hips = rig.data.bones["hips"].head_local
    hip = hips + offset + hips_rot @ (thigh.bone.head_local - hips)
    upper = shin.bone.head_local - thigh.bone.head_local
    lower = foot.bone.head_local - shin.bone.head_local
    axis = ankle - hip
    dist = axis.length
    assert dist < upper.length + lower.length + 0.0001, (side, dist)
    axis.normalize()
    forward = shoe @ Vector((0, 1, 0))
    pole = (forward - axis * forward.dot(axis)).normalized()
    along = (upper.length_squared - lower.length_squared + dist**2) / (2 * dist)
    knee = hip + along * axis + math.sqrt(max(0.0, upper.length_squared - along**2)) * pole
    # The shin and thigh share a hinge axis. A shoe may yaw relative to the
    # shell during a pivot, but its segment must not twist around the knee pin.
    heading = math.atan2(-forward.x, forward.y)
    base_rot = Quaternion((0, 0, 1), heading)
    upper_rot = (base_rot @ upper).rotation_difference(knee - hip) @ base_rot
    lower_rot = (base_rot @ lower).rotation_difference(ankle - knee) @ base_rot
    for bone, parent_rot, world_rot in ((thigh, hips_rot, upper_rot), (shin, upper_rot, lower_rot), (foot, lower_rot, shoe)):
        rest = bone.bone.matrix_local.to_quaternion()
        bone.rotation_quaternion = rest.inverted() @ parent_rot.inverted() @ world_rot @ rest


def author(rig) -> dict:
    actions = {}
    bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
    for clip, frames in FRAMES.items():
        action = bpy.data.actions.new(clip)
        action.use_fake_user = True
        rig.animation_data_create().action = action
        previous = {}
        for frame in range(frames + 1):
            u = frame / frames
            pose, feet = sample(clip, u)
            neutral = (frame == 0 and clip != "patrol-stop" and clip != "patrol-walk") or (
                frame == frames and clip != "patrol-start" and clip != "patrol-walk")
            if neutral:
                base.apply_pose(rig, base.idle_pose(0), None)
            else:
                base.apply_pose(rig, pose, None)
                for side, (ankle, shoe, _) in feet.items():
                    solve_leg(rig, side, ankle, shoe, angles(*pose["hips"]), Vector(pose["hips_loc"]))
            for bone in rig.pose.bones:
                if bone.name == "root":
                    continue
                q = bone.rotation_quaternion.copy().normalized()
                if bone.name in previous:
                    q.make_compatible(previous[bone.name])
                previous[bone.name] = q
                bone.rotation_quaternion = q
                bone.keyframe_insert("rotation_quaternion", frame=frame)
                if bone.name == "hips":
                    bone.keyframe_insert("location", frame=frame)
        actions[clip] = action
    return actions


def read_glb(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    size = struct.unpack_from("<I", data, 12)[0]
    return json.loads(data[20:20 + size]), data[28 + size:]


def write_glb(path: Path, doc: dict, blob: bytes) -> None:
    doc["buffers"] = [{"byteLength": len(blob)}]
    head = json.dumps(doc, ensure_ascii=True, separators=(",", ":")).encode()
    head += b" " * (-len(head) % 4)
    blob += b"\0" * (-len(blob) % 4)
    path.write_bytes(struct.pack("<4sIII4s", b"glTF", 2, len(head) + len(blob) + 28, len(head), b"JSON") +
                     head + struct.pack("<I4s", len(blob), b"BIN\0") + blob)


def extract_clips(export: Path, target: Path) -> None:
    """Keep original joint bind transforms and only the baked rotation / hip tracks."""
    original, _ = read_glb(BASE)
    baked, data = read_glb(export)
    joints = original["skins"][0]["joints"]
    remap = {old: new for new, old in enumerate(joints)}
    nodes = []
    for old in joints:
        node = original["nodes"][old].copy()
        kids = [remap[i] for i in node.pop("children", []) if i in remap]
        if kids:
            node["children"] = kids
        nodes.append(node)
    by_name = {n["name"]: i for i, n in enumerate(nodes)}
    doc = {"asset": {"version": "2.0", "generator": "Clockwork Spire Cog Sentry patrol"},
           "scene": 0, "scenes": [{"nodes": [by_name["root"]]}], "nodes": nodes,
           "animations": [], "accessors": [], "bufferViews": []}
    binary = bytearray()
    copied = {}

    def accessor(idx: int) -> int:
        if idx in copied:
            return copied[idx]
        acc = baked["accessors"][idx].copy()
        view = baked["bufferViews"][acc["bufferView"]]
        start = view.get("byteOffset", 0)
        assert "byteStride" not in view and acc.get("byteOffset", 0) == 0
        acc["bufferView"] = len(doc["bufferViews"])
        doc["bufferViews"].append({"buffer": 0, "byteOffset": len(binary), "byteLength": view["byteLength"]})
        binary.extend(data[start:start + view["byteLength"]])
        binary.extend(bytes(-len(binary) % 4))
        copied[idx] = len(doc["accessors"])
        doc["accessors"].append(acc)
        return copied[idx]

    for clip in sorted((a for a in baked["animations"] if a["name"] in FRAMES), key=lambda a: a["name"]):
        out = {"name": clip["name"], "samplers": [], "channels": []}
        for channel in clip["channels"]:
            src = channel["target"]
            bone = baked["nodes"][src["node"]]["name"]
            prop = src["path"]
            if bone == "root" or bone not in by_name or (prop != "rotation" and (bone, prop) != ("hips", "translation")):
                continue
            sampler = clip["samplers"][channel["sampler"]].copy()
            for key in ("input", "output"):
                sampler[key] = accessor(sampler[key])
            out["channels"].append({"sampler": len(out["samplers"]), "target": {"node": by_name[bone], "path": prop}})
            out["samplers"].append(sampler)
        assert len(out["channels"]) == len(joints), clip["name"]
        doc["animations"].append(out)
    assert {a["name"] for a in doc["animations"]} == set(FRAMES)
    write_glb(target, doc, binary)


def merged_for_inspection(sidecar: Path, out: Path) -> None:
    """Bind the staged channels to the actual combat skin, then reimport that pair."""
    base_doc, data = read_glb(BASE)
    motion, extra = read_glb(sidecar)
    base_nodes = {n["name"]: i for i, n in enumerate(base_doc["nodes"])}
    view_base, acc_base = len(base_doc["bufferViews"]), len(base_doc["accessors"])
    for view in motion["bufferViews"]:
        view["byteOffset"] += len(data)
        base_doc["bufferViews"].append(view)
    for acc in motion["accessors"]:
        acc["bufferView"] += view_base
        base_doc["accessors"].append(acc)
    for clip in motion["animations"]:
        for sam in clip["samplers"]:
            sam["input"] += acc_base
            sam["output"] += acc_base
        for ch in clip["channels"]:
            target = ch["target"]
            target["node"] = base_nodes[motion["nodes"][target["node"]]["name"]]
        base_doc["animations"].append(clip)
    write_glb(out, base_doc, data + extra)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    ART.mkdir(parents=True, exist_ok=True)
    RUNTIME.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
    scene = bpy.context.scene
    rig = bpy.data.objects["cog-sentry"]
    body = bpy.data.objects["sentry-body"]
    assert set(rig.pose.bones.keys()) == set(base.BONE_NAMES)
    rig.animation_data_clear()
    for act in list(bpy.data.actions):
        bpy.data.actions.remove(act)
    for img in bpy.data.images:
        if img.filepath and img.name.endswith(".png"):
            material = img.name.split(".")[0]
            img.filepath = str(ROOT / "public/assets/materials" / material / img.name)
    scene.render.fps = FPS
    scene.frame_start, scene.frame_end = 0, 72
    actions = author(rig)
    rig.animation_data.action = actions["patrol-walk"]
    scene.frame_set(0)
    editable = ART / "locomotion.blend"
    bpy.data.libraries.write(str(editable), {scene, *actions.values()}, path_remap="RELATIVE_ALL", compress=True)
    rig.animation_data.action = None
    base.clear_pose(rig)
    with tempfile.TemporaryDirectory() as temp:
        folder = Path(temp)
        baked, staged = folder / "baked.glb", folder / "locomotion.glb"
        base.export_glb(bpy, [rig, body], rig, baked)
        extract_clips(baked, staged)
        merged = folder / "bound.glb"
        merged_for_inspection(staged, merged)
        verifier = importlib.util.spec_from_file_location("patrol_check", Path(__file__).with_name("build-sentry-patrol-check.py"))
        check = importlib.util.module_from_spec(verifier)
        verifier.loader.exec_module(check)
        report = check.inspect(merged, FRAMES, FPS, travel, sample, ART, "--renders" in sys.argv, "--movie" in sys.argv)
        RUNTIME.write_bytes(staged.read_bytes())
    report.update({"sourceRigSha256": sha(SOURCE), "combatGlbSha256": sha(BASE), "locomotionGlbSha256": sha(RUNTIME),
                   "editableSha256": sha(editable), "generatorSha256": sha(Path(__file__)),
                   "inspectorSha256": sha(Path(__file__).with_name("build-sentry-patrol-check.py")),
                   "locomotionBytes": RUNTIME.stat().st_size, "blender": bpy.app.version_string})
    (ART / "validation.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
