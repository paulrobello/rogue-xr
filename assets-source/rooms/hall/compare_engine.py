"""Engine-versus-Cycles lightmap check for a P5-T1 kit room (system Python with numpy and Pillow):

    python3 -I assets-source/rooms/hall/compare_engine.py hall|corridor

The three.js frame with the lightmap only (NoToneMapping, metalness 0, no environment) against the
Cycles diffuse reference at the same camera, as mean-luminance ratios over the frame and per
horizontal band. Writes assets-source/rooms/<room>/staging/engine-compare.json.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]


def load(path: Path) -> tuple[np.ndarray, np.ndarray]:
    a = np.asarray(Image.open(path).convert("RGB")).astype(float) / 255
    lin = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
    return lin @ np.array([0.2126, 0.7152, 0.0722]), a


def main(room: str) -> None:
    r = ROOT / f"assets-source/rooms/{room}/staging/renders"
    e, ea = load(r / "engine.hero.diffuse.png")
    c, ca = load(r / "hero.reference-diffuse.png")
    h, w = e.shape
    bands = {"ceiling": (0, 0.2), "upper walls": (0.2, 0.45), "lower walls": (0.45, 0.65), "floor near": (0.75, 1.0)}
    regions = {}
    for k, (a, b) in bands.items():
        sl = slice(int(h * a), int(h * b))
        regions[k] = round(float(e[sl].mean() / c[sl].mean()), 3)
    out = {
        "lightmap_vs_cycles_diffuse": {
            "frame_ratio": round(float(e.mean() / c.mean()), 3),
            "rmse_srgb": round(float(np.sqrt(((ea - ca) ** 2).mean())), 4),
            "bands": regions,
        },
        "frame_means_255": {f.name: round(float(np.asarray(Image.open(f).convert("RGB")).mean()), 1) for f in sorted(r.glob("engine.*.png"))},
    }
    (r.parent / "engine-compare.json").write_text(json.dumps(out, indent=2) + "\n")
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main(sys.argv[1])
