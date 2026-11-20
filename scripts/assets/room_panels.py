"""Swappable wall panels for the baked room templates (PRD D2, Paul 2026-11-17).

A panel slot is a fixed wall span inside a baked template that the shell leaves open. Each slot
takes one of several panels, and every panel is its own baked glTF node with lightmap UV1 islands in
the room's atlas, so the runtime picks a panel by showing one node and hiding the others; the shell
is never re-lit. A door slot has two panels:

    door-frame-<id>   brass architrave, its reveal faces and (kit rooms) the threshold plate
    door-plug-<id>    the wall closing the opening flush with the wall plane: wainscot with its
                      stiles below the chair rail, wallpaper above, chair rail and skirting run
                      across, so the run of wall reads unbroken (src/world/floor-world.ts dressRoom)

New panel kinds (windows, decoration) register a builder in PANELS and a slot kind in SLOT_PANELS.

Imported by room_kit.py (hall, corridor, gear-shaft, guardian-vault) and build-room-study.py
(study). It reads no generator globals: callers pass their own Builder instances and wall frames,
so each generator keeps its own material slots and cache.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Callable

from mathutils import Matrix

LIGHTMAP_UV = "lightmap"


@dataclass(frozen=True)
class WallSpec:
    """The shell's wall dressing a plug must continue. Values are the generator's own."""

    wainscot: float
    chair_rail: bool = True
    skirting: bool = False
    stile_step: float | None = None
    threshold: bool = False


@dataclass(frozen=True)
class PanelSlot:
    """A wall span (wall-local a0..a1, z0..z1, in the generator's wall frame) that takes a panel."""

    id: str
    kind: str
    wall: str
    a0: float
    a1: float
    z0: float
    z1: float


def door_slots(doors: dict, door_w: float, door_h: float) -> list[PanelSlot]:
    """One door slot per template door. `doors` maps a template door id to {wall, c}, c in Blender
    coordinates along the wall's axis (the study and kit DOORS form); S and E walls run backwards."""
    out = []
    for did in sorted(doors):
        d = doors[did]
        a = -d["c"] if d["wall"] in ("S", "E") else d["c"]
        out.append(PanelSlot(did, "door", d["wall"], a - door_w / 2, a + door_w / 2, 0.0, door_h))
    return out


def door_frame(b, s: PanelSlot, spec: WallSpec) -> None:
    """The architrave the shell used to carry: jambs and head 0.12 m wide, 0.05 m proud, the reveal
    faces of the zero-thickness opening, and the kit's brass threshold plate across the doorway."""
    o0, o1, top, f = s.a0, s.a1, s.z1, 0.12
    b.box(o0 - f, o0, 0, 0.05, 0, top + f, "brass-aged", drop="yb")
    b.box(o1, o1 + f, 0, 0.05, 0, top + f, "brass-aged", drop="yb")
    b.box(o0, o1, 0, 0.05, top, top + f, "brass-aged", drop="yxX")
    if spec.threshold:
        # Inside the footprint: a neighbour room's plate meets it on the shared edge.
        b.box(o0, o1, 0, 0.06, 0, 0.012, "brass-aged", drop="by")


def door_plug(b, s: PanelSlot, spec: WallSpec) -> None:
    """Wall over the opening in the wall plane (d = 0), the shell's dressing run across it. The chair
    rail and skirting boxes drop their end faces, as the shell's spans do, so they join the shell's
    runs at the opening edges with no step. Stiles continue the shell's rhythm: the spans either side
    end with a stile 0.2 m from the opening, and the plug spaces stiles evenly between those two."""
    o0, o1, top, W = s.a0, s.a1, s.z1, spec.wainscot
    b.face([(o0, 0, 0), (o1, 0, 0), (o1, 0, W), (o0, 0, W)], (0, 1, 0), "walnut")
    b.face([(o0, 0, W), (o1, 0, W), (o1, 0, top), (o0, 0, top)], (0, 1, 0), "wallpaper")
    if spec.chair_rail:
        b.box(o0, o1, 0, 0.04, W - 0.03, W + 0.05, "walnut", drop="xXy")
    if spec.skirting:
        b.box(o0, o1, 0, 0.025, 0, 0.14, "walnut", drop="xXyb")
    if spec.stile_step:
        lo, hi = o0 - 0.2, o1 + 0.2
        n = max(1, round((hi - lo) / spec.stile_step))
        for k in range(1, n):
            a = lo + (hi - lo) * k / n
            b.box(a - 0.03, a + 0.03, 0, 0.018, 0.14, W - 0.03, "walnut", drop="ybt")


PANELS: dict[str, Callable] = {"door-frame": door_frame, "door-plug": door_plug}
SLOT_PANELS: dict[str, tuple[str, ...]] = {"door": ("door-frame", "door-plug")}


def node_name(panel: str, slot: PanelSlot) -> str:
    """The glTF node name the runtime looks up (`door-plug-<id>`, `door-frame-<id>`)."""
    return f"{panel}-{slot.id}"


def build_panels(builder: Callable, wall_frame: Callable, slots: list[PanelSlot], spec: WallSpec, high: bool) -> dict:
    """Builds every panel of every slot as its own object. `builder(name)` returns the generator's
    Builder; `wall_frame(wall)` its wall-local frame. High objects carry `_high`, so the low build
    owns the exact node names. Returns {panel kind: [objects in slot order]}."""
    out: dict[str, list] = {}
    for s in slots:
        for panel in SLOT_PANELS[s.kind]:
            name = node_name(panel, s)
            b = builder(f"{name}_high" if high else name)
            b.xf = wall_frame(s.wall)
            PANELS[panel](b, s, spec)
            b.xf = Matrix.Identity(4)
            out.setdefault(panel, []).append(b.finish())
    return out


# ---------------------------------------------------------------------------------------------
# Several objects in one lightmap atlas (room shell, rigid nodes, panels)
# ---------------------------------------------------------------------------------------------


def unwrap_lightmap_uv_multi(objs: list, size: int, gap_px: int = 10) -> None:
    """lightmap_helpers.unwrap_lightmap_uv for several objects packed into ONE UV1 atlas (multi-object
    edit mode packs every island together), so panels and rigid nodes share the room's lightmap."""
    import bpy

    for obj in objs:
        mesh = obj.data
        if LIGHTMAP_UV not in mesh.uv_layers:
            mesh.uv_layers.new(name=LIGHTMAP_UV)
        mesh.uv_layers.active = mesh.uv_layers[LIGHTMAP_UV]
    if bpy.context.object is not None and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    for other in bpy.context.view_layer.objects:
        other.select_set(other in objs)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.0, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(rotate=True, margin_method="FRACTION", margin=gap_px / size)
    bpy.ops.object.mode_set(mode="OBJECT")


RAY_FLAGS = ("visible_shadow", "visible_diffuse", "visible_glossy", "visible_transmission", "visible_volume_scatter")


def set_ray_visible(objs: list, visible: bool) -> None:
    """Cycles ray visibility other than camera: an invisible object neither shadows nor bounces light
    onto the rest of the scene, and is still baked itself when selected."""
    for obj in objs:
        for flag in RAY_FLAGS:
            setattr(obj, flag, visible)


def bake_irradiance_multi(objs: list, size: int, samples: int, no_shadow: list, margin_px: int = 8, image=None,
                          ray_hidden: list = ()):
    """lightmap_helpers.bake_irradiance for several objects into one image in one bake call. Objects
    in `no_shadow` (rigid animated nodes) are invisible to shadow rays, so static surfaces carry no
    baked shadow of a part that moves at runtime. Objects in `ray_hidden` (panels) are invisible to
    every ray but the camera's. With `image` given the bake adds to it (use_clear off); margins of
    a later pass stay inside the island gaps (2 x gap_px > 2 x margin_px)."""
    import bpy

    scene = bpy.context.scene
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    clear = image is None
    if image is None:
        image = bpy.data.images.new(f"{objs[0].name}_lightmap", size, size, alpha=True, float_buffer=True)
        image.generated_color = (0.0, 0.0, 0.0, 0.0)
        image.colorspace_settings.name = "Non-Color"
    mats = []
    for obj in objs:
        for slot in obj.material_slots:
            if slot.material not in mats:
                mats.append(slot.material)
    restore = []
    for mat in mats:
        nodes = mat.node_tree.nodes
        metallic = next(n for n in nodes if n.type == "BSDF_PRINCIPLED").inputs["Metallic"]
        restore.append((mat, metallic.default_value))
        metallic.default_value = 0.0
        tex = nodes.new("ShaderNodeTexImage")
        tex.name = "lightmap_bake_target"
        tex.image = image
        nodes.active = tex
    for obj in objs:
        obj.data.uv_layers.active = obj.data.uv_layers[LIGHTMAP_UV]
    for obj in no_shadow:
        obj.visible_shadow = False
    set_ray_visible(list(ray_hidden), False)
    for other in bpy.context.view_layer.objects:
        other.select_set(other in objs)
    bpy.context.view_layer.objects.active = objs[0]
    started = time.monotonic()
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, margin=margin_px, margin_type="EXTEND",
                        use_clear=clear, target="IMAGE_TEXTURES")
    elapsed = time.monotonic() - started
    set_ray_visible(list(ray_hidden), True)
    for obj in no_shadow:
        obj.visible_shadow = True
    for mat, value in restore:
        nodes = mat.node_tree.nodes
        next(n for n in nodes if n.type == "BSDF_PRINCIPLED").inputs["Metallic"].default_value = value
        nodes.remove(nodes["lightmap_bake_target"])
    for obj in objs:
        obj.data.uv_layers.active = obj.data.uv_layers[0]
    return image, elapsed


def bake_with_panels(shell: list, frames: list, plugs: list, size: int, samples: int, no_shadow: list) -> tuple:
    """The two-pass panel bake. Pass 1 bakes the shell, rigid nodes and frames with every frame and
    plug invisible to shadow and indirect rays, so the shell's texels hold for an open or a plugged
    door. Pass 2 bakes the plugs' own texels into the same image with the plugs in place (fully
    visible, so they shadow themselves) and the frames out of the scene (a plugged door drops its
    frame). Returns (image, seconds per pass)."""
    image, t1 = bake_irradiance_multi([*shell, *frames], size, samples, no_shadow, ray_hidden=[*frames, *plugs])
    t2 = 0.0
    if plugs:
        for f in frames:
            f.hide_render = True
        image, t2 = bake_irradiance_multi(plugs, size, samples, no_shadow, image=image)
        for f in frames:
            f.hide_render = False
    return image, [round(t1, 2), round(t2, 2)]


def export_glb_multi(objs: list, path) -> None:
    """The study's export_glb with several selected objects (room, rigid nodes, panels)."""
    import bpy

    for other in bpy.context.view_layer.objects:
        other.select_set(other in objs)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", use_selection=True, use_active_scene=True, export_texcoords=True,
                              export_normals=True, export_tangents=False, export_materials="EXPORT", export_image_format="NONE",
                              export_cameras=False, export_lights=False, export_apply=True, export_extras=False)


def reimport_checks(objects: dict, slots: list[PanelSlot]) -> tuple[dict, dict]:
    """Reimport facts and checks: every slot's panels exist as unparented nodes at the identity
    transform. `objects` maps names to imported objects."""
    facts, checks = {}, {}
    for s in slots:
        for panel in SLOT_PANELS[s.kind]:
            name = node_name(panel, s)
            obj = objects.get(name)
            ok = obj is not None and obj.type == "MESH" and obj.parent is None
            if ok:
                m = obj.matrix_world
                ok = all(abs(m[i][j] - (1.0 if i == j else 0.0)) < 1e-6 for i in range(4) for j in range(4))
            facts[name] = {"found": obj is not None, "triangles": sum(len(p.vertices) - 2 for p in obj.data.polygons) if obj is not None else 0}
            checks[f"panel_{name}"] = ok
    return facts, checks
