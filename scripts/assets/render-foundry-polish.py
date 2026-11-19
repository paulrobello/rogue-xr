import bpy, sys
from pathlib import Path
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1 :]
asset = Path(args[0])
out = Path(args[1])
out.mkdir(exist_ok=True, parents=True)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(asset))
arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 16
scene.render.resolution_x = 640
scene.render.resolution_y = 640
scene.render.resolution_percentage = 100
scene.world.color = (0.10, 0.10, 0.10)
scene.render.image_settings.file_format = "PNG"


def point(obj, target):
    obj.rotation_euler = (
        (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()
    )


def light(name, loc, power, size):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = power
    data.shape = "DISK"
    data.size = size
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj.location = loc
    point(obj, (0, 0, 0.75))


light("key", (2, 3, 4), 450, 4)
light("fill", (-3, 2, 2), 300, 3)
light("rim", (0, -3, 3), 350, 3)
data = bpy.data.cameras.new("camera")
cam = bpy.data.objects.new("camera", data)
scene.collection.objects.link(cam)
scene.camera = cam
cam.location = (0, 4.7, 2.25)
point(cam, (0, 0, 0.85))
data.type = "ORTHO"
data.ortho_scale = 2.9
id = asset.stem
if id == "furnace-mite" and len(args) > 2 and args[2] == "single":
    next(
        o for o in scene.objects if o.name.startswith("furnace-mark-extra")
    ).hide_render = True
    for mat in (m for m in bpy.data.materials if m.name.startswith("foundry-mark")):
        base = mat.node_tree.nodes.get("Principled BSDF").inputs["Base Color"]
        for link in list(base.links):
            mat.node_tree.links.remove(link)
        base.default_value = (0.376, 0.019, 0.034, 1)
poses = {
    "glasswing-scrivener": [
        ("idle", 30),
        ("intent-proof", 18),
        ("intent-cross-out", 18),
    ],
    "furnace-mite": [
        ("idle", 30),
        ("intent-double-spark", 18),
        ("intent-stoke", 18),
        ("intent-clink", 18),
        ("attack", 18),
    ],
    "null-crown-auditor": [
        ("idle", 30),
        ("intent-levy", 18),
        ("intent-reconcile", 18),
        ("action-levy", 18),
    ],
}[id]
if len(args) > 2 and args[2] == "single":
    poses = [("idle", 30)]
if len(args) > 2 and args[2] == "impact":
    poses = [("attack" if id == "furnace-mite" else "action-levy", 14.4)]
for action, frame in poses:
    matches = [a for a in bpy.data.actions if a.name.split(".")[0] == action]
    assert matches, (action, [a.name for a in bpy.data.actions])
    arm.animation_data.action = matches[0]
    scene.frame_set(int(frame), subframe=frame - int(frame))
    bpy.context.view_layer.update()
    scene.render.filepath = str(
        out / (action + ("-impact" if frame == 14.4 else "") + ".png")
    )
    bpy.ops.render.render(write_still=True)
