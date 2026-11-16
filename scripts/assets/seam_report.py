"""Seam and periodicity report for tileable texture sources.

Usage: python3 -I scripts/assets/seam_report.py <image>...

seam_x / seam_y: mean absolute difference across the wrap boundary divided by the mean
difference between neighbouring interior columns / rows. Near 1.0 means the wrap is as
continuous as the interior; well above 2 is a visible seam.
period: strongest autocorrelation peak (x, y) in pixels, found by FFT; a strong peak means the
pattern repeats and can be cropped to whole periods instead of blended.
"""

from __future__ import annotations

import sys

import numpy as np
from PIL import Image


def load(path: str) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float64) / 255.0


def seam_ratio(img: np.ndarray, axis: int) -> float:
    a = np.moveaxis(img, axis, 0)
    interior = np.abs(np.diff(a, axis=0)).mean()
    wrap = np.abs(a[0] - a[-1]).mean()
    return float(wrap / max(interior, 1e-9))


def period(img: np.ndarray, min_px: int = 32) -> tuple[int, int, float]:
    g = img.mean(axis=2)
    g = g - g.mean()
    f = np.fft.fft2(g)
    ac = np.fft.ifft2(f * np.conj(f)).real
    ac /= ac[0, 0]
    h, w = ac.shape
    ac[:min_px, :min_px] = ac[:min_px, -min_px:] = ac[-min_px:, :min_px] = ac[-min_px:, -min_px:] = -1
    iy, ix = np.unravel_index(np.argmax(ac), ac.shape)
    dy = iy if iy <= h // 2 else iy - h
    dx = ix if ix <= w // 2 else ix - w
    return int(dx), int(dy), float(ac[iy, ix])


if __name__ == "__main__":
    for path in sys.argv[1:]:
        img = load(path)
        dx, dy, strength = period(img)
        print(
            f"{path.split('/')[-1]:32s} seam_x={seam_ratio(img, 1):5.2f} seam_y={seam_ratio(img, 0):5.2f} "
            f"period=({dx},{dy}) r={strength:.2f}"
        )
