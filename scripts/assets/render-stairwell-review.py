"""Render opened stair doors from central and oblique approach positions."""
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

root = Path(sys.argv[sys.argv.index("--") + 1])
out = root / "assets-source/props/stairwell/staging"
bpy.ops.wm.open_mainfile(filepath=str(out / "stairwell.blend"))
scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.world.color = (0.16, 0.16, 0.16)
scene.render.resolution_x, scene.render.resolution_y = 1000, 700
scene.render.resolution_percentage = 100
for location, power in [((0, -3.4, 3.6), 400), ((0, -4.0, 2.0), 450)]:
    bpy.ops.object.light_add(type="AREA", location=location)
    lamp = bpy.context.object
    lamp.data.energy, lamp.data.size = power, 2
    lamp.rotation_euler = (Vector((0, -4.8, 1.0)) - lamp.location).to_track_quat("-Z", "Y").to_euler()
bpy.ops.object.camera_add()
cam = bpy.context.object
cam.data.lens = 18
scene.camera = cam
for name, height in (("StairUp", 1.62), ("StairDown", -1.62)):
    other = bpy.data.objects["StairDown" if name == "StairUp" else "StairUp"]
    obj = bpy.data.objects[name]
    for child in other.children_recursive:
        child.hide_render = True
    bpy.data.objects[name + "_DoorPivot"].rotation_euler.z = -math.radians(55)
    for label, x in (("", 0), ("-oblique", 0.8)):
        cam.location = (x, -2.5, height + 1.35)
        cam.rotation_euler = (Vector((0, -5.0, height + 1.05)) - cam.location).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = str(out / (name + label + ".png"))
        bpy.ops.render.render(write_still=True)
    for child in other.children_recursive:
        child.hide_render = False
