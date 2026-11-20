"""Inspect the actual retargeted Cog Sentry skin after glTF reimport."""
from __future__ import annotations

import math
import tempfile
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def studio(scene) -> None:
    """Fixed review lights and a neutral floor with half-metre stone squares."""
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 8
    scene.cycles.use_denoising = True
    scene.render.threads_mode = "FIXED"
    scene.render.threads = 2
    scene.render.resolution_x, scene.render.resolution_y = 270, 350
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.world = bpy.data.worlds.new("Review studio")
    scene.world.use_nodes = True
    background = next(n for n in scene.world.node_tree.nodes if n.type == "BACKGROUND")
    background.inputs["Color"].default_value = (0.30, 0.33, 0.39, 1)
    background.inputs["Strength"].default_value = 0.68
    bpy.ops.mesh.primitive_plane_add(size=200)
    floor = bpy.context.object
    floor.location.z = -0.002
    floor_mat = bpy.data.materials.new("Slate floor")
    floor_mat.use_nodes = True
    nodes, links = floor_mat.node_tree.nodes, floor_mat.node_tree.links
    geometry = nodes.new("ShaderNodeNewGeometry")
    checker = nodes.new("ShaderNodeTexChecker")
    checker.inputs["Scale"].default_value = 2.0
    checker.inputs["Color1"].default_value = (0.040, 0.049, 0.066, 1)
    checker.inputs["Color2"].default_value = (0.052, 0.060, 0.078, 1)
    links.new(geometry.outputs["Position"], checker.inputs["Vector"])
    links.new(checker.outputs["Color"], nodes.get("Principled BSDF").inputs["Base Color"])
    floor.data.materials.append(floor_mat)
    for name, pos, energy, size, color in (
        ("Warm key", (1.2, 2.3, 3.7), 300, 2.8, (1, 0.85, 0.65)),
        ("Soft fill", (-2.5, 1.2, 2), 180, 2.0, (0.60, 0.75, 1)),
        ("Rim", (-0.7, -2.4, 2.9), 360, 1.6, (1, 0.73, 0.43)),
    ):
        light = bpy.data.lights.new(name, "AREA")
        light.energy, light.shape, light.size, light.color = energy, "DISK", size, color
        obj = bpy.data.objects.new(name, light)
        scene.collection.objects.link(obj)
        obj.location = pos
        obj.rotation_euler = (Vector((0, 0, 1.1)) - obj.location).to_track_quat("-Z", "Y").to_euler()
    cam = bpy.data.objects.new("Inspection camera", bpy.data.cameras.new("Inspection lens"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.type, cam.data.ortho_scale = "ORTHO", 2.18
    cam.location = (3.7, 1.9, 1.3)
    cam.rotation_euler = (Vector((0, 0.03, 0.94)) - cam.location).to_track_quat("-Z", "Y").to_euler()


def render_sheet(scene, actions: dict, rig, art: Path) -> None:
    cam = scene.camera
    poses = [("patrol-start", 16, (3.7, 1.9, 1.3)), ("patrol-walk", 0, (3.7, 1.9, 1.3)),
             ("patrol-walk", 24, (3.7, 1.9, 1.3)), ("patrol-walk", 40, (3.7, 1.9, 1.3)),
             ("patrol-turn-left", 35, (1.8, 3.7, 1.5)), ("patrol-stop", 24, (3.7, 1.9, 1.3))]
    with tempfile.TemporaryDirectory() as tmp:
        pixels = []
        for i, (clip, frame, location) in enumerate(poses):
            rig.animation_data.action = actions[clip]
            scene.frame_set(frame)
            cam.location = location
            cam.rotation_euler = (Vector((0, 0.03, 0.94)) - cam.location).to_track_quat("-Z", "Y").to_euler()
            scene.render.filepath = str(Path(tmp) / f"pose-{i}.png")
            bpy.ops.render.render(write_still=True)
            img = bpy.data.images.load(scene.render.filepath)
            pixels.append(np.array(img.pixels[:], dtype=np.float32).reshape(350, 270, 4))
            bpy.data.images.remove(img)
        grid = np.concatenate(pixels, axis=1)
        preview = bpy.data.images.new("Reimported motion strip", width=grid.shape[1], height=grid.shape[0])
        preview.pixels.foreach_set(grid.ravel())
        preview.filepath_raw, preview.file_format = str(art / "patrol-poses.jpg"), "JPEG"
        preview.save()


def bind_review_brass(body, art: Path) -> None:
    """Attach the runtime shared base color and ORM maps by their slot names."""
    root = art.parents[2]
    manifest_path = root / "public/assets/enemies/cog-sentry/cog-sentry.manifest.json"
    import json

    slots = json.loads(manifest_path.read_text())["materialSlots"]
    for mat in body.data.materials:
        slot = slots[mat.name]
        if not slot["set"]:
            continue
        name = slot["set"]
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
        textures = {}
        for role in ("basecolor", "orm"):
            path = root / "public/assets/materials" / name / f"{name}.{role}.png"
            tex = nodes.new("ShaderNodeTexImage")
            tex.image = bpy.data.images.load(str(path))
            if role == "orm":
                tex.image.colorspace_settings.name = "Non-Color"
            textures[role] = tex
        tint = nodes.new("ShaderNodeVectorMath")
        tint.operation = "MULTIPLY"
        tint.inputs[1].default_value = slot["tint"]
        links.new(textures["basecolor"].outputs["Color"], tint.inputs[0])
        links.new(tint.outputs[0], bsdf.inputs["Base Color"])
        separate = nodes.new("ShaderNodeSeparateColor")
        links.new(textures["orm"].outputs["Color"], separate.inputs[0])
        links.new(separate.outputs["Green"], bsdf.inputs["Roughness"])
        links.new(separate.outputs["Blue"], bsdf.inputs["Metallic"])


def render_motion(scene, actions: dict, rig, body, art: Path, travel) -> None:
    """Play exact gameplay travel and heading on the reimported clips."""
    output_fps = 30
    route = [("idle", 0.3), ("patrol-start", 0.5), ("patrol-walk", 1.2), ("patrol-stop", 0.7),
             ("patrol-turn-left", 1.2), ("patrol-start", 0.5), ("patrol-walk", 1.2),
             ("patrol-stop", 0.7), ("idle", 0.4)]
    wrapper = bpy.data.objects.new("Gameplay transform", None)
    scene.collection.objects.link(wrapper)
    for obj in (rig, body):
        if obj.parent is None:
            obj.parent = wrapper
    start_position, start_heading = Vector((0.75, -1.0, 0)), 0.0
    source_poses = []
    for clip, duration in route:
        rig.animation_data.action = actions[clip]
        ratio = 1 if clip != "idle" else 0
        forward = Vector((-math.sin(math.radians(start_heading)), math.cos(math.radians(start_heading)), 0))
        for f in range(round(duration * output_fps)):
            u = f / (duration * output_fps)
            time = u * duration * 60 * ratio
            scene.frame_set(int(time), subframe=time % 1)
            d, turn = (0, 0) if clip == "idle" else travel(clip, u)
            pose = [(b.name, b.location.copy(), b.rotation_quaternion.copy()) for b in rig.pose.bones]
            source_poses.append((pose, start_position + forward * d, start_heading + turn))
        if clip != "idle":
            d, turn = travel(clip, 1)
            start_position += forward * d
            start_heading += turn
    action = bpy.data.actions.new("World patrol review")
    rig.animation_data.action = action
    prior = {}
    for frame, (pose, pos, heading) in enumerate(source_poses):
        for name, loc, rot in pose:
            bone = rig.pose.bones[name]
            if name in prior:
                rot.make_compatible(prior[name])
            prior[name] = rot
            bone.location, bone.rotation_quaternion = loc, rot
            bone.keyframe_insert("rotation_quaternion", frame=frame)
            if name == "hips":
                bone.keyframe_insert("location", frame=frame)
        wrapper.location = pos
        wrapper.rotation_euler.z = math.radians(heading)
        wrapper.keyframe_insert("location", frame=frame)
        wrapper.keyframe_insert("rotation_euler", frame=frame)
    scene.frame_start, scene.frame_end = 0, len(source_poses) - 1
    scene.render.fps = output_fps
    scene.render.resolution_x, scene.render.resolution_y = 480, 320
    scene.cycles.samples = 5
    scene.render.use_persistent_data = True
    cam = scene.camera
    cam.data.ortho_scale = 3.8
    cam.location = (3.3, 3.8, 1.95)
    cam.rotation_euler = (Vector((0.05, 0, 0.96)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.image_settings.media_type = "VIDEO"
    scene.render.image_settings.file_format = "FFMPEG"
    scene.render.ffmpeg.format = "MPEG4"
    scene.render.ffmpeg.codec = "H264"
    scene.render.ffmpeg.constant_rate_factor = "HIGH"
    scene.render.filepath = str(art / "patrol-review.mp4")
    scene.frame_set(0)
    bpy.ops.render.render(animation=True)


def inspect(merged: Path, frames: dict, fps: int, travel, sample, art: Path, renders: bool, movie: bool) -> dict:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = fps
    bpy.ops.import_scene.gltf(filepath=str(merged))
    rig = next(o for o in scene.objects if o.type == "ARMATURE")
    body = next(o for o in scene.objects if o.type == "MESH")
    rig.animation_data.use_nla = False
    # The importer names actions after the clip, suffixed for multi-slot targets
    # in some Blender versions.
    actions = {n: next(a for a in bpy.data.actions if a.name == n or a.name.startswith(n + "_"))
               for n in [*frames, "idle"]}
    foot_indices = {}
    for side in ("R", "L"):
        group = body.vertex_groups["foot." + side].index
        foot_indices[side] = [v.index for v in body.data.vertices if any(g.group == group and g.weight > 0.99 for g in v.groups)]
        assert foot_indices[side]

    foot_faces = {}
    for side, indices in foot_indices.items():
        local = {vertex: i for i, vertex in enumerate(indices)}
        foot_faces[side] = [[local[i] for i in poly.vertices] for poly in body.data.polygons
                            if all(i in local for i in poly.vertices)]

    def feet_overlap(verts: np.ndarray) -> bool:
        left, right = [verts[foot_indices[side]] for side in ("L", "R")]
        if (left.max(axis=0) < right.min(axis=0)).any() or (right.max(axis=0) < left.min(axis=0)).any():
            return False
        left_tree = BVHTree.FromPolygons(left.tolist(), foot_faces["L"])
        right_tree = BVHTree.FromPolygons(right.tolist(), foot_faces["R"])
        return bool(left_tree.overlap(right_tree))

    def coords() -> np.ndarray:
        ev = body.evaluated_get(bpy.context.evaluated_depsgraph_get())
        mesh = ev.to_mesh()
        values = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
        mesh.vertices.foreach_get("co", values)
        ev.to_mesh_clear()
        mat = np.asarray(ev.matrix_world)
        return values.reshape(-1, 3) @ mat[:3, :3].T + mat[:3, 3]

    def select(name: str) -> None:
        action = actions[name]
        rig.animation_data.action = action
        rig.animation_data.action_slot = next(s for s in action.slots if s.target_id_type == "OBJECT")

    def residual(a: np.ndarray, b: np.ndarray) -> float:
        return float(np.linalg.norm(a - b, axis=1).max())

    select("idle")
    scene.frame_set(0)
    neutral = coords()
    endpoints = {}
    metrics = {}
    for clip, end in frames.items():
        select(clip)
        duration = float(actions[clip].frame_range.y / fps)
        assert abs(duration - end / fps) < 0.0001, (clip, duration)
        anchors = {}
        drift = {"R": 0.0, "L": 0.0}
        clearance = {"R": 0.0, "L": 0.0}
        ground, root_error = 1.0, 0.0
        shoe_intersections = 0
        root_matrix = np.array(rig.data.bones["root"].matrix_local)
        # Inspect subframes, including interpolation between every exported key.
        for half_frame in range(2 * end + 1):
            f = half_frame / 2
            scene.frame_set(int(f), subframe=f % 1)
            verts = coords()
            shoe_intersections += int(feet_overlap(verts))
            if f in (0, end):
                endpoints[clip, f == end] = verts
            ground = min(ground, float(verts[:, 2].min()))
            root_error = max(root_error, float(np.abs(np.array(rig.pose.bones["root"].matrix) - root_matrix).max()))
            u = f / end
            distance, heading = travel(clip, u)
            c, s = math.cos(math.radians(heading)), math.sin(math.radians(heading))
            rotation = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
            world = verts @ rotation.T + np.array([0.0, distance, 0])
            for side, (_, _, planted) in sample(clip, u)[1].items():
                points = world[foot_indices[side]]
                clearance[side] = max(clearance[side], float(points[:, 2].min()))
                if not planted:
                    anchors.pop(side, None)
                    continue
                anchor = anchors.setdefault(side, points)
                drift[side] = max(drift[side], residual(points, anchor))
        metrics[clip] = {"durationSeconds": duration, "samples": 2 * end + 1,
                         "oppositeShoeIntersectionSamples": shoe_intersections, "minimumMeshHeightM": round(ground, 6), "peakSoleClearanceM": {k: round(v, 6) for k, v in clearance.items()},
                         "maxPlantedVertexDriftM": {k: round(v, 6) for k, v in drift.items()}, "rootMatrixError": round(root_error, 8)}
        print(clip, metrics[clip], flush=True)
        assert shoe_intersections == 0 and max(drift.values()) < 0.002 and ground > -0.001 and root_error < 0.0001, (clip, metrics[clip])
    walk = endpoints["patrol-walk", False]
    seams = {"walkLoop": residual(walk, endpoints["patrol-walk", True]),
             "startToWalk": residual(walk, endpoints["patrol-start", True]),
             "walkToStop": residual(walk, endpoints["patrol-stop", False]),
             "idleToStart": residual(neutral, endpoints["patrol-start", False]),
             "stopToIdle": residual(neutral, endpoints["patrol-stop", True])}
    for clip in ("patrol-turn-left", "patrol-turn-right"):
        seams[f"{clip}Start"] = residual(neutral, endpoints[clip, False])
        seams[f"{clip}End"] = residual(neutral, endpoints[clip, True])
    assert max(seams.values()) < 0.0001, seams
    if renders or movie:
        bind_review_brass(body, art)
        studio(scene)
    if renders:
        render_sheet(scene, actions, rig, art)
    if movie:
        render_motion(scene, actions, rig, body, art, travel)
    return {"jointCount": len(rig.data.bones), "samplesHz": fps * 2,
            "clips": metrics, "maxEndpointVertexErrorM": {k: round(v, 8) for k, v in seams.items()}}
