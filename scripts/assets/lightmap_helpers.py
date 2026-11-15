"""Lightmap helpers for room templates: UV1 unwrap, Cycles irradiance bake, sRGB-scaled encode.

Runs inside Blender (bpy, numpy). Contract: PRD.md "Lightmap contract" and
docs/blender-kit-project.md section 5.
"""

from __future__ import annotations

import math
import struct
import time
import zlib
from pathlib import Path

import bpy
import numpy as np

LIGHTMAP_UV = "lightmap"


def select_device(device: str) -> str:
    """Selects the Cycles device. GPU requests fail loudly instead of falling back to CPU."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    if device == "CPU":
        scene.cycles.device = "CPU"
        return "CPU"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.refresh_devices()
    gpus = [d for d in prefs.devices if d.type == "METAL"]
    if not gpus:
        raise RuntimeError("GPU bake requested but Cycles reports no Metal device")
    for d in prefs.devices:
        d.use = d.type == "METAL"
    scene.cycles.device = "GPU"
    return f"GPU:METAL ({', '.join(d.name for d in gpus)})"


def unwrap_lightmap_uv(obj: bpy.types.Object, size: int, gap_px: int = 16) -> None:
    """Adds UV1 (`lightmap`) with angle-based islands at uniform texel density.

    The island gap must exceed 2 x bake margin + 2 px or neighbouring islands bleed in the mips.
    """
    mesh = obj.data
    if LIGHTMAP_UV not in mesh.uv_layers:
        mesh.uv_layers.new(name=LIGHTMAP_UV)
    mesh.uv_layers.active = mesh.uv_layers[LIGHTMAP_UV]
    _edit_all(obj)
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.0, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(rotate=True, margin_method="FRACTION", margin=gap_px / size)
    bpy.ops.object.mode_set(mode="OBJECT")


def unwrap_material_uv(obj: bpy.types.Object) -> None:
    mesh = obj.data
    mesh.uv_layers.active = mesh.uv_layers[0]
    _edit_all(obj)
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.01)
    bpy.ops.object.mode_set(mode="OBJECT")


def _edit_all(obj: bpy.types.Object) -> None:
    if bpy.context.object is not None and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    for other in bpy.context.view_layer.objects:
        other.select_set(False)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")


def lightmap_texel_density(obj: bpy.types.Object, size: int) -> dict:
    """Pixels per metre on UV1, per face area-weighted, from the evaluated mesh."""
    mesh = obj.data
    uv = mesh.uv_layers[LIGHTMAP_UV].data
    densities, weights = [], []
    for poly in mesh.polygons:
        if poly.area <= 1e-9:
            continue
        pts = [uv[i].uv for i in poly.loop_indices]
        uv_area = 0.0
        for i in range(1, len(pts) - 1):
            a, b, c = pts[0], pts[i], pts[i + 1]
            uv_area += abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2
        densities.append(math.sqrt(uv_area * size * size / poly.area))
        weights.append(poly.area)
    d = np.array(densities)
    w = np.array(weights)
    return {
        "mean_px_per_m": round(float((d * w).sum() / w.sum()), 2),
        "min_px_per_m": round(float(d.min()), 2),
        "max_px_per_m": round(float(d.max()), 2),
    }


def bake_irradiance(obj: bpy.types.Object, size: int, samples: int, margin_px: int = 8) -> tuple[bpy.types.Image, float]:
    """Bakes diffuse direct + indirect light with the colour pass off into a float image on UV1.

    With COLOR excluded the result is the light arriving at the surface, independent of its albedo,
    which is what three.js multiplies by the material's diffuse colour. Metallic is forced to 0 for
    the bake because a metal has no diffuse lobe and would bake black.
    """
    scene = bpy.context.scene
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    image = bpy.data.images.new(f"{obj.name}_lightmap", size, size, alpha=True, float_buffer=True)
    image.generated_color = (0.0, 0.0, 0.0, 0.0)
    image.colorspace_settings.name = "Non-Color"

    restore: list[tuple] = []
    for slot in obj.material_slots:
        mat = slot.material
        nodes = mat.node_tree.nodes
        bsdf = next(n for n in nodes if n.type == "BSDF_PRINCIPLED")
        metallic = bsdf.inputs["Metallic"]
        restore.append((mat, metallic.default_value))
        metallic.default_value = 0.0
        tex = nodes.new("ShaderNodeTexImage")
        tex.name = "lightmap_bake_target"
        tex.image = image
        nodes.active = tex

    obj.data.uv_layers.active = obj.data.uv_layers[LIGHTMAP_UV]
    for other in bpy.context.view_layer.objects:
        other.select_set(False)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)

    started = time.monotonic()
    bpy.ops.object.bake(
        type="DIFFUSE",
        pass_filter={"DIRECT", "INDIRECT"},
        margin=margin_px,
        margin_type="EXTEND",
        use_clear=True,
        target="IMAGE_TEXTURES",
    )
    elapsed = time.monotonic() - started

    for mat, value in restore:
        nodes = mat.node_tree.nodes
        next(n for n in nodes if n.type == "BSDF_PRINCIPLED").inputs["Metallic"].default_value = value
        nodes.remove(nodes["lightmap_bake_target"])
    obj.data.uv_layers.active = obj.data.uv_layers[0]
    return image, elapsed


def image_rgba(image: bpy.types.Image) -> np.ndarray:
    """Pixels as (height, width, 4) float32 with row 0 at the TOP (PNG / glTF order)."""
    w, h = image.size
    buf = np.empty(w * h * 4, dtype=np.float32)
    image.pixels.foreach_get(buf)
    return buf.reshape(h, w, 4)[::-1].copy()


def srgb_encode(linear: np.ndarray) -> np.ndarray:
    x = np.clip(linear, 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def encode_scaled_srgb(rgba: np.ndarray, percentile: float = 99.9) -> tuple[np.ndarray, float, dict]:
    """Divides irradiance by a scale (the given percentile of covered texels' max channel) and
    stores it with the sRGB transfer function in 8 bits. The runtime multiplies back by the scale.
    """
    covered = rgba[..., 3] > 0.5
    rgb = rgba[..., :3]
    peak = rgb.max(axis=2)[covered]
    if peak.size == 0:
        raise RuntimeError("Lightmap bake produced no covered texels")
    scale = float(np.percentile(peak, percentile))
    if scale <= 0:
        raise RuntimeError("Lightmap bake is black")
    encoded = np.round(srgb_encode(rgb / scale) * 255).astype(np.uint8)
    stats = {
        "coverage": round(float(covered.mean()), 4),
        "scale": round(scale, 6),
        "clipped_fraction": round(float((peak > scale).mean()), 5),
        "mean_irradiance": round(float(rgb[covered].mean()), 6),
        "p05_irradiance": round(float(np.percentile(peak, 5)), 6),
    }
    return encoded, scale, stats


def write_png_rgb(path: Path, rgb8: np.ndarray) -> None:
    """Deterministic 8-bit RGB PNG writer (no timestamps or ancillary chunks)."""
    h, w, _ = rgb8.shape
    raw = b"".join(b"\x00" + rgb8[row].tobytes() for row in range(h))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def save_exr(image: bpy.types.Image, path: Path) -> None:
    image.filepath_raw = str(path)
    image.file_format = "OPEN_EXR"
    image.save()


def denoise_image(image: bpy.types.Image, workdir: Path) -> bpy.types.Image:
    """Runs a baked lightmap through the compositor's OpenImageDenoise node (HDR, accurate prefilter).

    Bakes are not denoised by Cycles. The scene render this triggers is reduced to 1 sample because
    the compositor tree reads only the image node; its own output is discarded.
    """
    scene = bpy.context.scene
    w, h = image.size
    tree = bpy.data.node_groups.new("lightmap_denoise", "CompositorNodeTree")
    tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    src = tree.nodes.new("CompositorNodeImage")
    src.image = image
    den = tree.nodes.new("CompositorNodeDenoise")
    den.inputs["HDR"].default_value = True
    den.inputs["Prefilter"].default_value = "Accurate"
    den.inputs["Quality"].default_value = "High"
    out = tree.nodes.new("NodeGroupOutput")
    tree.links.new(src.outputs["Image"], den.inputs["Image"])
    tree.links.new(den.outputs["Image"], out.inputs[0])

    saved = (scene.compositing_node_group, scene.render.use_compositing, scene.render.resolution_x,
             scene.render.resolution_y, scene.render.resolution_percentage, scene.cycles.samples,
             scene.render.image_settings.file_format, scene.render.filepath, scene.camera)
    if scene.camera is None:
        cam = bpy.data.objects.new("lightmap_denoise_cam", bpy.data.cameras.new("lightmap_denoise_cam"))
        scene.collection.objects.link(cam)
        scene.camera = cam
    scene.compositing_node_group = tree
    scene.render.use_compositing = True
    scene.render.resolution_x, scene.render.resolution_y = w, h
    scene.render.resolution_percentage = 100
    scene.cycles.samples = 1
    scene.render.image_settings.file_format = "OPEN_EXR"
    scene.render.image_settings.color_depth = "32"
    target = workdir / f"{image.name}_denoised.exr"
    scene.render.filepath = str(target)
    bpy.ops.render.render(write_still=True)
    (scene.compositing_node_group, scene.render.use_compositing, scene.render.resolution_x,
     scene.render.resolution_y, scene.render.resolution_percentage, scene.cycles.samples,
     scene.render.image_settings.file_format, scene.render.filepath, scene.camera) = saved

    result = bpy.data.images.load(str(target), check_existing=False)
    result.colorspace_settings.name = "Non-Color"
    # Keep the bake's coverage mask: the denoiser fills alpha, but unbaked texels must stay marked.
    den_px = image_rgba(result)
    src_px = image_rgba(image)
    den_px[..., 3] = src_px[..., 3]
    out_img = bpy.data.images.new(f"{image.name}_dn", w, h, alpha=True, float_buffer=True)
    out_img.colorspace_settings.name = "Non-Color"
    out_img.pixels.foreach_set(den_px[::-1].ravel())
    return out_img
