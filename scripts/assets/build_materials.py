"""Builds the core PBR material set (P4-T3) from the Higgsfield sources.

Usage: python3 -I scripts/assets/build_materials.py [--only walnut,...]

Per material: square best-match crop so opposite edges continue (no blend ghosting on structured
patterns), wrapped-FFT de-lighting of the base colour, height from the high-passed luminance,
OpenGL tangent normal (+Y up, glTF convention), ORM packed AO R / roughness G / metallic B,
optional emissive. Masters stay at 2048; runtime copies are 1024 PNGs in
public/assets/materials/<name>/<name>.<role>.png. Every derived file is hashed into report.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "assets-source/materials/raw"
WORK = ROOT / "assets-source/materials/derived"
CHECKS = ROOT / "assets-source/materials/checks"
RUNTIME = ROOT / "public/assets/materials"
RUNTIME_SIZE = 1024


@dataclass(frozen=True)
class Material:
    name: str
    tile_m: float  # physical edge length of one tile
    metallic: float
    roughness: float
    roughness_var: float
    normal_strength: float
    detail_sigma: float  # high-pass radius as a fraction of the tile
    delight: float  # 0 keeps painted shading, 1 removes all low-frequency luminance variation
    emissive: bool = False
    # Seam repair per axis (y, x), applied when the wrap ratio exceeds 1.6: "feather" cross-fades a
    # wide centre band (invisible on fine organic grain), "quilt" joins along a minimum-difference
    # cut (keeps hard features such as mortar crisp), "none" leaves the axis alone.
    repair: tuple[str, str] = ("quilt", "quilt")
    # Fixed source column range for the crop; its width sets the tile size. Walnut uses it so both
    # x edges fall on plank seams, which keeps the planks aligned without any x repair.
    crop_cols: tuple[int, int] | None = None
    # Scales base-colour variation around its mean (linear). Below 1 hides feather blending on
    # near-uniform materials whose look comes from specular response rather than colour.
    color_contrast: float = 1.0


MATERIALS = [
    Material("brass-aged", 0.5, 1.0, 0.45, 0.18, 2.0, 1 / 24, 0.5, repair=("feather", "feather"), crop_cols=(0, 2048)),
    Material("brass-polished", 0.5, 1.0, 0.22, 0.06, 0.8, 1 / 24, 1.0, repair=("feather", "feather"), crop_cols=(0, 2048), color_contrast=0.4),
    # Source plank seams sit at columns 512, 1021 and 1540: the tile holds two planks, so 0.5 m.
    Material("walnut", 0.5, 0.0, 0.55, 0.12, 3.0, 1 / 32, 0.4, repair=("feather", "none"), crop_cols=(512, 1540)),
    Material("stone-floor", 1.5, 0.0, 0.82, 0.08, 5.0, 1 / 16, 0.4),
    Material("stained-glass", 0.6, 0.0, 0.12, 0.04, 2.0, 1 / 32, 0.0, emissive=True),
    Material("wallpaper", 0.75, 0.0, 0.75, 0.06, 1.5, 1 / 48, 0.3),
]


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def wrapped_blur(x: np.ndarray, sigma_px: float) -> np.ndarray:
    """Gaussian blur with wrap-around edges (the tile's own periodic boundary), via FFT."""
    h, w = x.shape[:2]
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.fftfreq(w)[None, :]
    kernel = np.exp(-2 * (np.pi * sigma_px) ** 2 * (fx**2 + fy**2))
    if x.ndim == 3:
        kernel = kernel[..., None]
    return np.fft.ifft2(np.fft.fft2(x, axes=(0, 1)) * kernel, axes=(0, 1)).real


def edge_cost(img: np.ndarray, length: int, axis: int) -> tuple[float, int]:
    """Best start offset for a crop of `length` along `axis` whose wrap is most continuous."""
    a = np.moveaxis(img, axis, 0)
    n = a.shape[0]
    diffs = np.abs(a[: n - length] - a[length:]).mean(axis=tuple(range(1, a.ndim)))
    i = int(np.argmin(diffs))
    return float(diffs[i]), i


def best_square_crop(img: np.ndarray) -> tuple[int, int, int, dict]:
    """Search crop sizes from 45 to 100% at quarter resolution for the most continuous wrap."""
    small = np.asarray(Image.fromarray((img * 255).astype(np.uint8)).reduce(4), dtype=np.float64) / 255
    n = min(small.shape[:2])
    interior = 0.5 * (np.abs(np.diff(small, axis=0)).mean() + np.abs(np.diff(small, axis=1)).mean())
    best = None
    for length in range(int(n * 0.45), n, 2):
        cy, y0 = edge_cost(small, length, 0)
        cx, x0 = edge_cost(small, length, 1)
        # Prefer larger crops: a 45% crop pays about 28% more than a full-size one.
        score = (cx + cy) * (1 + 0.5 * (1 - length / n))
        if best is None or score < best[0]:
            best = (score, length, x0, y0, cx / interior, cy / interior)
    assert best is not None
    _, length, x0, y0, sx, sy = best
    return x0 * 4, y0 * 4, length * 4, {"crop_px": length * 4, "seam_x_est": round(sx, 2), "seam_y_est": round(sy, 2)}


def seam_ratio(img: np.ndarray, axis: int) -> float:
    a = np.moveaxis(img, axis, 0)
    return float(np.abs(a[0] - a[-1]).mean() / max(np.abs(np.diff(a, axis=0)).mean(), 1e-9))


def _min_cut_rows(cost: np.ndarray) -> np.ndarray:
    """Per-column row of the cheapest left-to-right path through `cost` (rows x cols), steps of 1."""
    rows, cols = cost.shape
    acc = cost.copy()
    back = np.zeros((rows, cols), dtype=np.int64)
    for x in range(1, cols):
        prev = acc[:, x - 1]
        cand = np.stack([np.r_[np.inf, prev[:-1]], prev, np.r_[prev[1:], np.inf]])
        pick = np.argmin(cand, axis=0)
        back[:, x] = np.arange(rows) + pick - 1
        acc[:, x] += cand[pick, np.arange(rows)]
    path = np.empty(cols, dtype=np.int64)
    path[-1] = int(np.argmin(acc[:, -1]))
    for x in range(cols - 1, 0, -1):
        path[x - 1] = back[path[x], x]
    return path


def quilt_wrap(tile: np.ndarray, axis: int, band_frac: float = 1 / 8) -> np.ndarray:
    """Makes `tile` continuous across its wrap along `axis` without cross-fade ghosting.

    Rolling by half moves the wrap seam to the centre and makes the edges continuous. The centre
    band is then replaced by the unrolled tile (continuous there), entering and leaving along
    minimum-difference cuts so the joins follow places where both versions already agree.
    """
    img = np.moveaxis(tile, axis, 0)
    n = img.shape[0]
    c, band = n // 2, max(8, int(n * band_frac))
    rolled = np.roll(img, c, axis=0)
    diff = np.abs(rolled - img).sum(axis=2)
    out = rolled.copy()
    top = _min_cut_rows(diff[c - band : c])
    bottom = _min_cut_rows(diff[c : c + band])
    rows = np.arange(n)[:, None]
    use_orig = (rows >= (c - band + top)[None, :]) & (rows < (c + bottom)[None, :])
    mask = wrapped_blur(use_orig.astype(np.float64), 1.5)[..., None]
    out = mask * img + (1 - mask) * rolled
    return np.moveaxis(out, 0, axis)


def feather_wrap(tile: np.ndarray, axis: int, band_frac: float = 1 / 2) -> np.ndarray:
    """Rolls `tile` by half along `axis`, then fades the unrolled tile back in over a wide centre band.

    The rolled copy is continuous at the edges and the original is continuous at the centre, so a
    smooth raised-cosine weight between them leaves no discontinuity anywhere.
    """
    img = np.moveaxis(tile, axis, 0)
    n = img.shape[0]
    c, half = n // 2, max(8, int(n * band_frac / 2))
    rolled = np.roll(img, c, axis=0)
    t = np.clip(1 - np.abs(np.arange(n) - c) / half, 0, 1)
    w = (0.5 - 0.5 * np.cos(np.pi * t))[:, None, None]
    out = w * img + (1 - w) * rolled
    return np.moveaxis(out, 0, axis)


def column_crop(src: np.ndarray, cols: tuple[int, int]) -> tuple[int, int, int, dict]:
    """Square crop over fixed columns, picking the start row with the most continuous y wrap."""
    x0, x1 = cols
    size = x1 - x0
    strip = src[:, x0:x1]
    interior = np.abs(np.diff(strip, axis=0)).mean()
    best = min(range(0, src.shape[0] - size + 1, 4), key=lambda y: np.abs(strip[y] - strip[y + size - 1]).mean())
    sy = np.abs(strip[best] - strip[best + size - 1]).mean() / interior
    return x0, best, size, {"crop_px": size, "seam_x_est": None, "seam_y_est": round(float(sy), 2)}


def normalize01(x: np.ndarray) -> np.ndarray:
    lo, hi = np.percentile(x, 0.5), np.percentile(x, 99.5)
    return np.clip((x - lo) / max(hi - lo, 1e-9), 0, 1)


def to_png(path: Path, arr: np.ndarray) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = np.clip(np.round(arr * 255), 0, 255).astype(np.uint8)
    Image.fromarray(data).save(path, optimize=True)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def resize(arr: np.ndarray, size: int) -> np.ndarray:
    """Resizes float channels together. Lanczos on 16-bit-per-channel copies keeps precision."""
    chans = []
    for c in range(arr.shape[2]):
        im = Image.fromarray(np.clip(arr[..., c], 0, 1).astype(np.float32), mode="F")
        chans.append(np.asarray(im.resize((size, size), Image.Resampling.LANCZOS), dtype=np.float64))
    return np.clip(np.stack(chans, axis=2), 0, 1)


def mip_check(rt: np.ndarray, is_normal: bool) -> dict:
    """Box-filters the runtime map down the mip chain to 16 px, as the GPU does.

    Reports `wrap_excess_8bit`: over every level and axis, how far the step across the wrap exceeds
    the largest step between interior rows, in 8-bit units. Zero or below means the wrap is no
    harsher than a step already in the texture (a plank groove or mortar line landing on the wrap
    raises the mean-based seam ratio but not this). Also the channel-mean drift from level 0, and
    for normals the smallest mean vector length (low means detail averages away into gloss).
    """
    level, excess, drift, min_len = rt, -255.0, 0.0, 1.0
    mean0 = rt.reshape(-1, rt.shape[2]).mean(axis=0)
    while level.shape[0] > 16:
        h = level.shape[0] // 2
        level = level.reshape(h, 2, h, 2, -1).mean(axis=(1, 3))
        for axis in (0, 1):
            b = np.moveaxis(level, axis, 0)
            interior = float(np.abs(np.diff(b, axis=0)).mean(axis=(1, 2)).max())
            excess = max(excess, (float(np.abs(b[0] - b[-1]).mean()) - interior) * 255)
        drift = max(drift, float(np.abs(level.reshape(-1, level.shape[2]).mean(axis=0) - mean0).max()))
        if is_normal:
            min_len = min(min_len, float(np.linalg.norm(level * 2 - 1, axis=2).mean()))
    out = {"wrap_excess_8bit": round(excess, 2), "mean_drift": round(drift, 4)}
    if is_normal:
        out["min_normal_length"] = round(min_len, 3)
    return out


def grid2x2(arr: np.ndarray) -> np.ndarray:
    return np.tile(arr, (2, 2, 1))


def build(m: Material) -> dict:
    src_path = RAW / f"mat-{m.name}.png"
    src = np.asarray(Image.open(src_path).convert("RGB"), dtype=np.float64) / 255
    x0, y0, size, crop_info = column_crop(src, m.crop_cols) if m.crop_cols else best_square_crop(src)
    tile = src[y0 : y0 + size, x0 : x0 + size]
    repaired = []
    for axis, label, mode in ((0, "y", m.repair[0]), (1, "x", m.repair[1])):
        if mode == "none" or seam_ratio(tile, axis) <= 1.6:
            continue
        tile = feather_wrap(tile, axis) if mode == "feather" else quilt_wrap(tile, axis)
        repaired.append(f"{label}:{mode}")

    lin = srgb_to_linear(tile)
    lum = lin @ np.array([0.2126, 0.7152, 0.0722])
    if m.delight > 0:
        low = wrapped_blur(lum, size / 6)
        gain = (lum.mean() / np.maximum(low, 1e-4)) ** m.delight
        lin = lin * gain[..., None]
        lum = lin @ np.array([0.2126, 0.7152, 0.0722])
    if m.color_contrast != 1.0:
        mean = lin.reshape(-1, 3).mean(axis=0)
        lin = mean + (lin - mean) * m.color_contrast
    base = linear_to_srgb(lin)

    detail = lum - wrapped_blur(lum, size * m.detail_sigma)
    height = normalize01(wrapped_blur(detail, 1.0))
    dx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) * 0.5
    dy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) * 0.5
    s = m.normal_strength * size / 256
    n = np.stack([-dx * s, dy * s, np.ones_like(height)], axis=2)
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    normal = n * 0.5 + 0.5

    cavity = np.clip(wrapped_blur(height, size / 128) - height, 0, None)
    ao = 1 - np.clip(cavity * 4, 0, 0.4)
    rough = np.clip(m.roughness + m.roughness_var * (0.5 - normalize01(detail)), 0.04, 1)
    orm = np.stack([ao, rough, np.full_like(ao, m.metallic)], axis=2)

    maps = {"basecolor": base, "normal": normal, "orm": orm}
    if m.emissive:
        maps["emissive"] = base

    out = {"material": asdict(m), "source": str(src_path.relative_to(ROOT)), "crop": {"x": x0, "y": y0, **crop_info}}
    out["quilted_axes"] = repaired
    out["source_sha256"] = hashlib.sha256(src_path.read_bytes()).hexdigest()
    out["seam_after"] = {"x": round(seam_ratio(base, 1), 2), "y": round(seam_ratio(base, 0), 2)}
    out["files"] = {}
    for role, arr in maps.items():
        out["files"][f"derived/{m.name}.{role}.png"] = to_png(WORK / f"{m.name}.{role}.png", arr)
        rt = resize(arr, RUNTIME_SIZE)
        if role == "normal":
            v = rt * 2 - 1
            v /= np.linalg.norm(v, axis=2, keepdims=True)
            rt = v * 0.5 + 0.5
        rel = f"{m.name}/{m.name}.{role}.png"
        out["files"][f"runtime/{rel}"] = to_png(RUNTIME / rel, rt)
        out.setdefault("mips", {})[role] = mip_check(rt, role == "normal")
    out["ranges"] = {
        "roughness": [round(float(rough.min()), 3), round(float(rough.max()), 3)],
        "ao": [round(float(ao.min()), 3), round(float(ao.max()), 3)],
    }
    to_png(CHECKS / f"{m.name}.basecolor-2x2.png", resize(grid2x2(base), 1024))
    to_png(CHECKS / f"{m.name}.normal-2x2.png", resize(grid2x2(normal), 1024))
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default="")
    args = parser.parse_args()
    only = {s for s in args.only.split(",") if s}
    report_path = WORK / "report.json"
    report = json.loads(report_path.read_text()) if report_path.exists() else {}
    for m in MATERIALS:
        if only and m.name not in only:
            continue
        report[m.name] = build(m)
        r = report[m.name]
        print(f"{m.name:16s} crop={r['crop']['crop_px']} quilt={r['quilted_axes']} seam_after={r['seam_after']} rough={r['ranges']['roughness']} ao={r['ranges']['ao']}")
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    manifest = {
        m.name: {
            "tileMeters": m.tile_m,
            "maps": {role: f"{m.name}.{role}.png" for role in (["basecolor", "normal", "orm"] + (["emissive"] if m.emissive else []))},
        }
        for m in MATERIALS
    }
    (RUNTIME / "materials.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
