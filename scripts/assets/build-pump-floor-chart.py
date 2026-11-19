"""Combine the original study atlas and no-sun bake into a pump floor chart.

Run `uv run --with numpy --with pillow --with scipy python` on this script,
passing the PNG decoded from study.lightmap.ktx2, the no-sun NPY, and output PNG.
The crop (0, 1500, 550, 2048) contains the complete study floor UV1 island.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import binary_dilation, gaussian_filter


SCALE = 3.7835512161254883


def build_chart(atlas: Path, bake: Path, output: Path) -> None:
    original = np.asarray(Image.open(atlas).convert('RGB'))
    irradiance = np.load(bake)[:, :, :3]
    if original.shape != (2048, 2048, 3) or irradiance.shape != original.shape:
        raise ValueError('Expected matching 2048-square study atlases')
    linear = np.clip(irradiance / SCALE, 0, 1)
    srgb = np.where(linear <= 0.0031308, linear * 12.92, 1.055 * linear ** (1 / 2.4) - 0.055)
    no_sun = np.uint8(np.round(srgb * 255))
    delta = original.astype(np.int16) - no_sun.astype(np.int16)
    mask = np.zeros(original.shape[:2], dtype=bool)
    mask[1745:1855, 240:425] = np.max(delta[1745:1855, 240:425], axis=2) > 5
    mask = binary_dilation(mask, iterations=5)
    alpha = gaussian_filter(mask.astype(np.float32), 3)[:, :, None]
    combined = np.round(original * (1 - alpha) + no_sun * alpha).astype(np.uint8)
    Image.fromarray(combined[1500:2048, :550]).save(output, optimize=True)
    changed = np.any(combined != original, axis=2)
    y, x = np.where(changed)
    print(f'Changed {changed.sum()} atlas pixels; bounds x={x.min()}..{x.max()}, y={y.min()}..{y.max()}')


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit('Expected original atlas PNG, no-sun NPY and output PNG')
    build_chart(*(Path(arg) for arg in sys.argv[1:]))
