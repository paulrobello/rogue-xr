"""Build the paired Clockwork Spire stairwell alcoves. Run with Blender --background."""

import sys
import os
from pathlib import Path

import bpy
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
root = Path(args[0]) if args else Path(__file__).resolve().parents[2]
out = root / "assets-source/props/stairwell/staging"
out.mkdir(parents=True, exist_ok=True)
matroot = root / "public/assets/materials"
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
for m in list(bpy.data.materials):
    bpy.data.materials.remove(m)


# World-to-Blender frame: runtime (x,y,z) -> Blender (x,-z,y).
def p(x, y, z):
    return (x, -z, y)


def material(name, texture=None, color=(0.25, 0.25, 0.25, 1), metal=0, rough=0.7):
    m = bpy.data.materials.new(name)
    m.diffuse_color = color
    m.use_nodes = True
    n = m.node_tree.nodes
    l = m.node_tree.links
    bs = n.get("Principled BSDF")
    bs.inputs["Base Color"].default_value = color
    bs.inputs["Metallic"].default_value = metal
    bs.inputs["Roughness"].default_value = rough
    if texture:

        def image(role, noncolor=False):
            img = bpy.data.images.load(
                str(matroot / texture / (texture + "." + role + ".png")),
                check_existing=True,
            )
            if noncolor:
                img.colorspace_settings.name = "Non-Color"
            if max(img.size) > 512:
                scale = 512 / max(img.size)
                img.scale(round(img.size[0] * scale), round(img.size[1] * scale))
                temp = out / ("_" + texture + "_" + role + ".png")
                img.filepath_raw = str(temp)
                img.file_format = "PNG"
                img.save()
                img.pack()
                temp.unlink()
            else:
                img.pack()
            node = n.new("ShaderNodeTexImage")
            node.image = img
            return node

        c = image("basecolor")
        l.new(c.outputs["Color"], bs.inputs["Base Color"])
        normal = image("normal", True)
        nm = n.new("ShaderNodeNormalMap")
        nm.inputs["Strength"].default_value = 0.55
        l.new(normal.outputs["Color"], nm.inputs["Color"])
        l.new(nm.outputs["Normal"], bs.inputs["Normal"])
        orm = image("orm", True)
        sep = n.new("ShaderNodeSeparateColor")
        l.new(orm.outputs["Color"], sep.inputs["Color"])
        l.new(sep.outputs["Green"], bs.inputs["Roughness"])
        l.new(sep.outputs["Blue"], bs.inputs["Metallic"])
    return m


stone = material("Stairwell stone", "stone-floor")
walnut = material("Stairwell walnut", "walnut")
brass = material("Stairwell aged brass", "brass-aged")
iron = material(
    "Stairwell dark iron", color=(0.047, 0.055, 0.058, 1), metal=0.72, rough=0.51
)
edge_brass = material(
    "Stairwell bright brass", color=(0.78, 0.52, 0.19, 1), metal=0.65, rough=0.32
)
recess = material("Stairwell dark recess", color=(0.012, 0.012, 0.014, 1), rough=1)
glow = material("Stairwell warm opal", color=(0.9, 0.57, 0.22, 1), rough=0.4)
bs = glow.node_tree.nodes.get("Principled BSDF")
bs.inputs["Emission Color"].default_value = (1, 0.38, 0.07, 1)
bs.inputs["Emission Strength"].default_value = 0.7

roots = []


def box(name, pos, size, mat, parent, bevel=0.015):
    bpy.ops.mesh.primitive_cube_add(size=1, location=p(*pos))
    ob = bpy.context.object
    ob.name = name
    ob.dimensions = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    ob.data.materials.append(mat)
    ob.parent = parent
    # Cubic projection in metre units provides stable texture scale on every face.
    uv = ob.data.uv_layers.active or ob.data.uv_layers.new(name="UVMap")
    for poly in ob.data.polygons:
        axis = max(range(3), key=lambda i: abs(poly.normal[i]))
        for li in poly.loop_indices:
            v = ob.data.vertices[ob.data.loops[li].vertex_index].co
            uv.data[li].uv = (
                (v.y, v.z) if axis == 0 else (v.x, v.z) if axis == 1 else (v.x, v.y)
            )
    if bevel:
        mod = ob.modifiers.new("softened edges", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        mod = ob.modifiers.new("weighted normals", "WEIGHTED_NORMAL")
        mod.keep_sharp = True
    return ob


def riser(name, z, low, high, parent):
    mesh = bpy.data.meshes.new(name)
    verts = [p(-0.96, low, z), p(-0.96, high, z), p(0.96, high, z), p(0.96, low, z)]
    mesh.from_pydata(verts, [], [(0, 1, 2, 3)])
    mesh.update()
    ob = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(ob)
    ob.parent = parent
    mesh.materials.append(walnut)
    uv = mesh.uv_layers.new(name="UVMap")
    for poly in mesh.polygons:
        for li in poly.loop_indices:
            v = mesh.vertices[mesh.loops[li].vertex_index].co
            uv.data[li].uv = (v.x, v.z)
    return ob


def rod(name, a, b, r, mat, parent, vertices=8):
    va = Vector(p(*a))
    vb = Vector(p(*b))
    d = vb - va
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices, radius=r, depth=d.length, location=(va + vb) / 2
    )
    ob = bpy.context.object
    ob.name = name
    ob.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    ob.data.materials.append(mat)
    ob.parent = parent
    return ob


def build(kind, direction):
    rootob = bpy.data.objects.new(kind, None)
    bpy.context.collection.objects.link(rootob)
    roots.append(rootob)
    # Side and rear masonry: opening remains unobstructed.
    for x in (-1.42, 1.42):
        box(kind + " side stone", (x, 1.12, 2.55), (0.16, 6.0, 4.9), stone, rootob)
        box(
            kind + " side wainscot",
            (x + (0.09 if x < 0 else -0.09), 0.48, 2.55),
            (0.035, 0.96, 4.85),
            walnut,
            rootob,
            0.008,
        )
        for h in (1.0, 1.16, 3.7):
            box(
                kind + " horizontal moulding",
                (x + (0.12 if x < 0 else -0.12), h, 2.55),
                (0.065, 0.075, 4.85),
                brass if h == 1.16 else walnut,
                rootob,
                0.008,
            )
    # The doorway is a true aperture, with a dark recess deep enough for the leaf.
    landing = direction * 1.62
    for x in (-1.025, 1.025):
        box(kind + " back wall side", (x, 1.12, 4.92), (0.80, 6, 0.16), stone, rootob)
    bottom, top = -1.88, 4.12
    for lo, hi in ((bottom, landing - 0.02), (landing + 2.14, top)):
        if hi > lo:
            box(kind + " back wall infill", (0, (lo + hi) / 2, 4.92), (1.25, hi - lo, 0.16), stone, rootob, 0)
    box(kind + " recess back", (0, landing + 1.06, 6.12), (1.25, 2.12, 0.04), recess, rootob, 0)
    for x in (-0.625, 0.625):
        box(kind + " recess side", (x, landing + 1.06, 5.55), (0.04, 2.12, 1.14), recess, rootob, 0)
    for y in (landing - 0.04, landing + 2.16):
        box(kind + " recess cap", (0, y, 5.55), (1.25, 0.04, 1.14), recess, rootob, 0)
    box(kind + " ceiling", (0, 4.04, 2.55), (2.86, 0.12, 4.85), walnut, rootob)
    for z in (1.2, 2.2, 3.2, 4.2):
        box(kind + " ceiling beam", (0, 3.94, z), (2.72, 0.15, 0.14), walnut, rootob)
    # Floor strips frame an actual open stairwell on descent.
    box(kind + " threshold", (0, -0.10, 0.455), (2.84, 0.20, 0.91), stone, rootob)
    for x in (-1.22, 1.22):
        box(kind + " side floor", (x, -0.10, 2.96), (0.42, 0.20, 3.98), stone, rootob)
    # Nine broad treads, each linked to a riser and brass nosing.
    for i in range(9):
        z = 1.08 + i * 0.34
        h = direction * (i + 1) * 0.18
        if direction == 1:
            box(
                f"{kind} step support {i:02d}",
                (0, (h - 0.09) / 2 - 0.05, z + 0.003),
                (1.90, h + 0.01, 0.334),
                stone,
                rootob,
                0.003,
            )
        tread = box(
            f"{kind} tread {i:02d}",
            (0, h - 0.045, z),
            (1.96, 0.09, 0.34),
            walnut,
            rootob,
            0.018,
        )
        for uv in tread.data.uv_layers.active.data:
            uv.uv.x += i * 0.083
            uv.uv.y += i * 0.037
        box(
            f"{kind} nosing {i:02d}",
            (0, h + 0.005, z - (0.1375 if direction < 0 else 0.145)),
            (1.94, 0.022, 0.065 if direction < 0 else 0.04),
            edge_brass if direction < 0 else brass,
            rootob,
            0.006,
        )
        previous = h - direction * 0.18
        riser(f"{kind} riser {i:02d}", z - 0.167, min(h, previous), max(h, previous), rootob)
    landing = direction * 1.62
    box(
        kind + " landing", (0, landing - 0.10, 4.46), (2.00, 0.20, 0.98), walnut, rootob
    )
    for x in (-1.04, 1.04):
        # Continuous raked rails and balusters start after threshold, keeping the aperture clear.
        rod(
            kind + " stringer",
            (x, -0.12, 1.0),
            (x, landing - 0.12, 3.9),
            0.055,
            iron,
            rootob,
        )
        rod(
            kind + " handrail",
            (x, 0.84 + direction * 0.18, 1.08),
            (x, 0.84 + landing, 3.8),
            0.046,
            walnut,
            rootob,
            12,
        )
        for i in range(9):
            z = 1.08 + i * 0.34
            h = direction * (i + 1) * 0.18
            stringer_y = -0.12 + landing * (z - 1.0) / 2.9
            post_bottom = min(h, stringer_y) - 0.04
            assert post_bottom <= stringer_y - 0.04 + 1e-8
            assert h + 0.84 > stringer_y
            rod(
                kind + " baluster",
                (x, post_bottom, z),
                (x, h + 0.84, z),
                0.024,
                iron,
                rootob,
            )
            box(
                kind + " baluster collar",
                (x, h + 0.12, z),
                (0.075, 0.055, 0.075),
                brass,
                rootob,
                0.006,
            )
        rod(
            kind + " landing rail",
            (x, landing + 0.84, 3.8),
            (x, landing + 0.84, 4.76),
            0.046,
            walnut,
            rootob,
            12,
        )
        box(
            kind + " stringer landing anchor",
            (x, landing - 0.11, 3.88),
            (0.18, 0.22, 0.22),
            iron,
            rootob,
            0.006,
        )
        for z in (4.0, 4.65):
            box(
                kind + " landing post foot",
                (x, landing - 0.015, z),
                (0.18, 0.06, 0.16),
                iron,
                rootob,
                0.006,
            )
            rod(
                kind + " landing post",
                (x, landing, z),
                (x, landing + 0.84, z),
                0.032,
                iron,
                rootob,
            )
    # Pivot is the physical left edge. Reparent the leaf components below while
    # retaining their authored world transforms.
    pivot = bpy.data.objects.new(kind + "_DoorPivot", None)
    bpy.context.collection.objects.link(pivot)
    pivot.parent = rootob
    pivot.location = p(-0.59, landing, 4.915)
    bpy.context.view_layer.update()
    before_leaf = set(rootob.children)

    box(
        kind + " access door",
        (0, landing + 1.06, 4.87),
        (1.18, 2.12, 0.09),
        walnut,
        rootob,
        0.012,
    )
    for x in (-0.64, 0.64):
        box(
            kind + " door jamb",
            (x, landing + 1.12, 4.80),
            (0.10, 2.24, 0.10),
            walnut,
            rootob,
            0.01,
        )
    box(
        kind + " door lintel",
        (0, landing + 2.20, 4.80),
        (1.38, 0.10, 0.10),
        walnut,
        rootob,
        0.01,
    )
    for y in (landing + 0.32, landing + 1.82):
        rod(
            kind + " door hinge",
            (-0.59, y - 0.10, 4.915),
            (-0.59, y + 0.10, 4.915),
            0.027,
            brass,
            rootob,
        )
    box(
        kind + " door pull plate",
        (0.44, landing + 0.88, 4.81),
        (0.085, 0.24, 0.03),
        brass,
        rootob,
        0.008,
    )
    rod(
        kind + " door pull",
        (0.44, landing + 0.81, 4.775),
        (0.44, landing + 0.95, 4.775),
        0.019,
        iron,
        rootob,
    )
    # Blank mounting plate: runtime provides the dynamic lettering at this location.
    signheight = landing + 1.25
    box(
        kind + " sign backplate",
        (0, signheight, 4.815),
        (0.88, 0.38, 0.035),
        walnut,
        rootob,
        0.018,
    )
    for x in (-0.47, 0.47):
        box(
            kind + " sign frame",
            (x, signheight, 4.785),
            (0.035, 0.44, 0.03),
            brass,
            rootob,
            0.004,
        )
    for y in (signheight - 0.205, signheight + 0.205):
        box(
            kind + " sign frame",
            (0, y, 4.785),
            (0.96, 0.035, 0.03),
            brass,
            rootob,
            0.004,
        )
    bpy.context.view_layer.update()
    for ob in set(rootob.children) - before_leaf:
        if any(token in ob.name for token in ("access door", "door pull", "sign ")):
            world = ob.matrix_world.copy()
            ob.parent = pivot
            ob.matrix_world = world
    socket = bpy.data.objects.new(kind + "_HandleSocket", None)
    bpy.context.collection.objects.link(socket)
    socket.parent = pivot
    socket.location = p(1.03, 0.88, -0.14)
    # Small warm lamp housings; illumination is owned by the runtime.
    for x in (-1.27, 1.27):
        for z in (1.5, 3.5):
            h = 1.95 + direction * (z - 1) * 0.28
            box(
                kind + " sconce mount",
                (x, h, z),
                (0.06, 0.32, 0.19),
                iron,
                rootob,
                0.02,
            )
            box(
                kind + " sconce glass",
                (x + (0.06 if x < 0 else -0.06), h, z),
                (0.075, 0.20, 0.12),
                glow,
                rootob,
                0.016,
            )
    return rootob


up = build("StairUp", 1)
down = build("StairDown", -1)
# Preserve independently editable components before merging runtime meshes.
bpy.ops.wm.save_as_mainfile(filepath=str(out / "stairwell.blend"))
# Collapse by root and material to keep runtime draw calls bounded.
for parent in [*roots, *(bpy.data.objects[r.name + "_DoorPivot"] for r in roots)]:
    groups = {}
    for ob in list(parent.children):
        if ob.type == "MESH":
            groups.setdefault(ob.data.materials[0].name, []).append(ob)
    for name, objects in groups.items():
        for ob in objects:
            bpy.context.view_layer.objects.active = ob
            for mod in list(ob.modifiers):
                bpy.ops.object.modifier_apply(modifier=mod.name)
        bpy.ops.object.select_all(action="DESELECT")
        for ob in objects:
            ob.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        bpy.ops.object.join()
        objects[0].name = parent.name + " " + name
# Runtime geometry only; each semantic root starts at the same pivot.
bpy.ops.object.select_all(action="DESELECT")
for ob in bpy.context.scene.objects:
    if ob.type in {"MESH", "EMPTY"}:
        ob.select_set(True)
bpy.ops.export_scene.gltf(
    filepath=str(out / "stairwell.glb"),
    export_format="GLB",
    use_selection=True,
    export_apply=True,
)
# Review renders from standing height in the approach. Render-only lights and camera.
scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.world.color = (0.16, 0.16, 0.16)
for loc, power, size in [
    ((0, 3.4, 1.4), 400, 2),
    ((0, 3.4, 3.6), 450, 2),
    ((0, 2.0, -1.5), 230, 2),
]:
    bpy.ops.object.light_add(type="AREA", location=p(*loc))
    lamp = bpy.context.object
    lamp.data.energy = power
    lamp.data.shape = "DISK"
    lamp.data.size = size
    lamp.rotation_euler = (
        (Vector(p(0, 0, 2.7)) - lamp.location).to_track_quat("-Z", "Y").to_euler()
    )

scene.render.resolution_x = 1000
scene.render.resolution_y = 700
scene.render.resolution_percentage = 100
bpy.ops.object.camera_add(location=p(0, 1.62, -1.8))
cam = bpy.context.object
cam.name = "Review camera"
cam.rotation_euler = (
    (Vector(p(0, 1.3, 3.6)) - cam.location).to_track_quat("-Z", "Y").to_euler()
)
cam.data.lens = 22
scene.camera = cam
for obj, other in ((up, down), (down, up)):
    for child in other.children_recursive:
        child.hide_render = True
    for child in obj.children_recursive:
        child.hide_render = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(out / (obj.name + ".png"))
    if not os.environ.get("STAIRWELL_SKIP_RENDER"):
        bpy.ops.render.render(write_still=True)
    for child in other.children_recursive:
        child.hide_render = False
print("STAGED", out)
