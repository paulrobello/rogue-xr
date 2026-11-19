"""Bake the study with its sun disabled on its existing UV1 atlas.

Extract study.basecolor.ktx2 to PNG first, then run Blender with:
  blender -b --factory-startup assets-source/rooms/study/blend/study_low.blend \
    --python-exit-code 1 -P scripts/assets/build-pump-floor-bake.py -- BASECOLOR.png OUTPUT.npy
The bake uses Cycles Metal, 256 samples, the study's original lights and panels.
"""
from __future__ import annotations

import sys
from pathlib import Path

import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lightmap_helpers as lm
import room_panels as panels


def main() -> None:
    args = sys.argv[sys.argv.index('--') + 1:]
    if len(args) != 2:
        raise SystemExit('Expected extracted basecolor PNG and output NPY')
    basecolor, output = map(lambda p: str(Path(p).resolve()), args)
    for image in bpy.data.images:
        if image.source == 'FILE' and image.filepath.endswith('study.basecolor.png'):
            image.filepath = basecolor
            image.reload()
    bpy.data.objects['study_sun'].hide_render = True
    print(lm.select_device('GPU'), flush=True)
    room = bpy.data.objects['study']
    frames = [bpy.data.objects[f'door-frame-{side}'] for side in ('e', 's')]
    plugs = [bpy.data.objects[f'door-plug-{side}'] for side in ('e', 's')]
    raw, times = panels.bake_with_panels([room], frames, plugs, 2048, 256, [])
    print(f'Bake seconds: {times}', flush=True)
    denoised = lm.denoise_image(raw, Path(output).parent)
    np.save(output, lm.image_rgba(denoised))


if __name__ == '__main__':
    main()
