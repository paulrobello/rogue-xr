"""Bake a clear pump-room north wall with the study's retained lamps.

Run in Blender with study_low.blend open; argument after -- is the output PNG.
The box is an unobstructed proxy for the room shell. It excludes the study's
shelves and window, while retaining the authored candle and sconce lights.
"""
from __future__ import annotations

import sys
from pathlib import Path

import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lightmap_helpers as lm


def surface(name: str, vertices: list[tuple[float, float, float]], color: tuple[float, float, float]) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], [(0, 1, 2, 3)])
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = (*color, 1)
    obj.data.materials.append(mat)
    return obj


def main() -> None:
    output = Path(sys.argv[sys.argv.index('--') + 1]).resolve()
    lamps = [obj for obj in bpy.data.objects if obj.type == 'LIGHT' and
             (obj.name.startswith('study_sconce_') or obj.name.startswith('study_candle_'))]
    if len(lamps) != 5:
        raise RuntimeError(f'Expected three sconces and two candles, found {[obj.name for obj in lamps]}')
    for obj in list(bpy.data.objects):
        if obj.type == 'LIGHT':
            obj.hide_render = not (obj.name.startswith('study_sconce_') or obj.name.startswith('study_candle_'))
        elif obj.type == 'MESH':
            bpy.data.objects.remove(obj, do_unlink=True)
    for image in list(bpy.data.images):
        if image.source == 'FILE':
            bpy.data.images.remove(image, do_unlink=True)
    wall = surface('pump_wall_bake', [(-4, 4, 1), (4, 4, 1), (4, 4, 4), (-4, 4, 4)], (0.25, 0.12, 0.055))
    uv0 = wall.data.uv_layers.new(name='UVMap')
    uv1 = wall.data.uv_layers.new(name='lightmap')
    for i, coord in enumerate(((0, 0), (1, 0), (1, 1), (0, 1))):
        uv0.data[i].uv = coord
        uv1.data[i].uv = coord
    # Enclosing diffuse proxies provide room bounce without obsolete object shadows.
    for name, vertices, color in [
        ('north_lower', [(-4,4,0),(4,4,0),(4,4,1),(-4,4,1)], (0.15,0.08,0.04)),
        ('south', [(4,-4,0),(-4,-4,0),(-4,-4,4),(4,-4,4)], (0.25,0.12,0.055)),
        ('west', [(-4,-4,0),(-4,4,0),(-4,4,4),(-4,-4,4)], (0.25,0.12,0.055)),
        ('east', [(4,4,0),(4,-4,0),(4,-4,4),(4,4,4)], (0.25,0.12,0.055)),
        ('floor', [(-4,-4,0),(4,-4,0),(4,4,0),(-4,4,0)], (0.25,0.20,0.14)),
        ('ceiling', [(-4,4,4),(4,4,4),(4,-4,4),(-4,-4,4)], (0.15,0.08,0.04)),
    ]:
        surface(name, vertices, color)
    bpy.context.view_layer.update()
    print(lm.select_device('GPU'), flush=True)
    image, elapsed = lm.bake_irradiance(wall, 512, 256)
    print(f'Bake seconds: {elapsed}', flush=True)
    pixels = lm.image_rgba(lm.denoise_image(image, output.parent))[:, :, :3]
    encoded = np.round(lm.srgb_encode(pixels / 3.7835512161254883) * 255).astype(np.uint8)
    lm.write_png_rgb(output, encoded)


if __name__ == '__main__':
    main()
