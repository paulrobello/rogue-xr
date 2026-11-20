"""Generate the display harness's tileable planished steel. Run with uv --with numpy --with Pillow."""

from pathlib import Path

import numpy as np
from PIL import Image

OUT = (
    Path(__file__).resolve().parents[2]
    / "assets-source/props/interior-furnishings/textures"
)
N = 256
rng = np.random.default_rng(8415)
pixels = np.arange(N) / N
u, v = np.meshgrid(pixels, pixels)
surface = np.zeros_like(u)
for frequency, strength in [(3, 0.33), (7, 0.19), (14, 0.1), (29, 0.038)]:
    for _ in range(5):
        dx, dy = rng.integers(-frequency, frequency + 1, 2)
        surface += strength * np.cos(
            np.pi * 2 * (dx * u + dy * v) + rng.uniform(0, np.pi * 2)
        )
brush = np.zeros_like(u)
for _ in range(15):
    dx, dy = rng.integers(0, 4), rng.integers(72, 122)
    brush += 0.055 * np.sin(np.pi * 2 * (dx * u + dy * v) + rng.uniform(0, np.pi * 2))
wear = np.clip(0.22 * surface + 0.16 * brush + 0.44, 0, 1)
pits = np.zeros_like(u)
for _ in range(95):
    x, y = rng.random(2)
    dx = np.minimum(np.abs(u - x), 1 - np.abs(u - x))
    dy = np.minimum(np.abs(v - y), 1 - np.abs(v - y))
    pits += rng.uniform(0.22, 0.72) * np.exp(-((dx / 0.0035) ** 2 + (dy / 0.0026) ** 2))


def save(channel, values):
    Image.fromarray(np.uint8(np.clip(values, 0, 1) * 255 + 0.5)).save(
        OUT / f"armor-steel.{channel}.png"
    )


tone = wear * 0.19 - pits * 0.18 + brush * 0.022
save("basecolor", np.stack([0.389 + tone, 0.431 + tone, 0.463 + tone], axis=2))
height = surface * 0.29 + brush * 0.24 - pits * 0.8
gx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) * 0.5
gy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) * 0.5
norm = np.stack([-gx, gy, np.ones_like(u)], axis=2)
save("normal", norm / np.linalg.norm(norm, axis=2, keepdims=True) * 0.5 + 0.5)
save(
    "orm",
    np.stack(
        [
            1 - pits * 0.12,
            0.49 - 0.19 * wear + 0.08 * brush + 0.19 * pits,
            0.83 + 0.1 * wear - 0.33 * pits,
        ],
        axis=2,
    ),
)
