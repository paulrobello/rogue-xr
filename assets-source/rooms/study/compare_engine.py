"""Engine-versus-Blender checks for the study review (system Python with numpy and Pillow).

    python3 -I assets-source/rooms/study/compare_engine.py

1. Lightmap reproduction: engine frame (NoToneMapping, metalness 0) against the Cycles diffuse
   reference at the same camera, as mean-luminance ratios per region.
2. KTX2 orientation: the shipped KTX2 maps against their PNG twins, and against a vertically
   flipped control that must differ far more.
Writes staging/engine-compare.json.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image

R = Path(__file__).resolve().parent / "staging/renders"


def load(name: str) -> tuple[np.ndarray, np.ndarray]:
    a = np.asarray(Image.open(R / name).convert("RGB")).astype(float) / 255
    lin = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
    return lin @ np.array([0.2126, 0.7152, 0.0722]), a


def main() -> None:
    e, ea = load("engine.hero.diffuse.png")
    r, ra = load("hero.reference-diffuse.png")
    h, w = e.shape
    regions = {
        "floor": (slice(int(h * 0.78), h), slice(int(w * 0.3), w)),
        "ceiling": (slice(0, int(h * 0.12)), slice(0, w)),
        "left bookcase": (slice(int(h * 0.3), int(h * 0.7)), slice(0, int(w * 0.18))),
        "right wall": (slice(int(h * 0.2), int(h * 0.55)), slice(int(w * 0.82), w)),
        "back wall": (slice(int(h * 0.3), int(h * 0.55)), slice(int(w * 0.45), int(w * 0.75))),
    }
    out = {
        "lightmap_vs_cycles_diffuse": {
            "frame_ratio": round(float(e.mean() / r.mean()), 3),
            "rmse_srgb": round(float(np.sqrt(((ea - ra) ** 2).mean())), 4),
            "regions": {k: round(float(e[a, b].mean() / r[a, b].mean()), 3) for k, (a, b) in regions.items()},
        }
    }
    _, ka = load("engine.hero.png")
    _, pa = load("engine.hero.png-maps.png")
    out["ktx2_vs_png"] = {
        "mean_abs_diff_255": round(float(np.abs(ka - pa).mean() * 255), 2),
        "vs_flipped_png_255": round(float(np.abs(ka - pa[::-1]).mean() * 255), 2),
    }
    out["frame_means_255"] = {
        f.name: round(float(np.asarray(Image.open(f).convert("RGB")).mean()), 1) for f in sorted(R.glob("engine.*.png"))
    }
    (R.parent / "engine-compare.json").write_text(json.dumps(out, indent=2) + "\n")
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
