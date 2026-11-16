"""Measures a room GLB's lightmap UV (TEXCOORD_1): overlap between islands, folds within an island,
and the smallest gap between islands at the lightmap resolution. System Python with numpy.

    python3 -I scripts/assets/asset-check-uv1.py study

Islands are found by union-find on rounded (POSITION, TEXCOORD_1) across every primitive, because
glTF splits vertices per material primitive and pure connectivity would cut islands at slot seams.
Writes assets-source/rooms/<template>/staging/uv1-report.json, which `asset-check` requires.
"""

from __future__ import annotations

import hashlib
import json
import struct
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
COMPONENTS = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
WIDTHS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}
MAX_RADIUS = 24


def read_glb(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    jlen = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20 : 20 + jlen])
    blen = struct.unpack_from("<I", data, 20 + jlen)[0]
    return gltf, data[28 + jlen : 28 + jlen + blen]


def accessor(gltf: dict, binary: bytes, index: int) -> np.ndarray:
    acc = gltf["accessors"][index]
    view = gltf["bufferViews"][acc["bufferView"]]
    dtype = np.dtype(COMPONENTS[acc["componentType"]])
    width = WIDTHS[acc["type"]]
    stride = view.get("byteStride", dtype.itemsize * width)
    if stride != dtype.itemsize * width:
        raise ValueError("interleaved buffers are not supported")
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    arr = np.frombuffer(binary, dtype=dtype, count=acc["count"] * width, offset=start)
    return arr.reshape(acc["count"], width) if width > 1 else arr


def main(template: str) -> int:
    glb = ROOT / f"public/assets/rooms/{template}/{template}.glb"
    manifest = json.loads((ROOT / f"public/assets/rooms/{template}/{template}.manifest.json").read_text())
    size = 2048 if "2048" in str(manifest.get("budget", {}).get("texturePx")) else 1024
    gltf, binary = read_glb(glb)
    tris_uv, tris_key = [], []
    keys: dict[tuple, int] = {}
    for mesh in gltf["meshes"]:
        for prim in mesh["primitives"]:
            pos = accessor(gltf, binary, prim["attributes"]["POSITION"])
            uv = accessor(gltf, binary, prim["attributes"]["TEXCOORD_1"]).astype(np.float64)
            idx = accessor(gltf, binary, prim["indices"]).reshape(-1, 3)
            vid = []
            for p, t in zip(np.round(pos, 4), np.round(uv, 6)):
                vid.append(keys.setdefault((*p.tolist(), *t.tolist()), len(keys)))
            vid = np.array(vid)
            tris_uv.append(uv[idx])
            tris_key.append(vid[idx])
    tri_uv = np.concatenate(tris_uv)  # (n, 3, 2), glTF v (top-down)
    tri_key = np.concatenate(tris_key)

    parent = list(range(len(keys)))

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for a, b, c in tri_key:
        ra, rb, rc = find(a), find(b), find(c)
        parent[rb] = ra
        parent[find(rc)] = ra
    island_of_tri = np.array([find(t[0]) for t in tri_key])
    _, island_of_tri = np.unique(island_of_tri, return_inverse=True)

    labels = np.full((size, size), -1, dtype=np.int32)
    claimed = np.zeros((size, size), dtype=np.int32)
    inter_overlap = 0
    area_px = np.zeros(island_of_tri.max() + 1)
    texels_px = np.zeros_like(area_px)
    for tri, isl in zip(tri_uv * size, island_of_tri):
        (x0, y0), (x1, y1), (x2, y2) = tri
        area_px[isl] += abs((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)) / 2
        lo_x, hi_x = int(np.floor(min(x0, x1, x2))), int(np.ceil(max(x0, x1, x2)))
        lo_y, hi_y = int(np.floor(min(y0, y1, y2))), int(np.ceil(max(y0, y1, y2)))
        xs = np.arange(max(lo_x, 0), min(hi_x, size)) + 0.5
        ys = np.arange(max(lo_y, 0), min(hi_y, size)) + 0.5
        if xs.size == 0 or ys.size == 0:
            continue
        gx, gy = np.meshgrid(xs, ys)
        d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(d) < 1e-12:
            continue
        a = ((y1 - y2) * (gx - x2) + (x2 - x1) * (gy - y2)) / d
        b = ((y2 - y0) * (gx - x2) + (x0 - x2) * (gy - y2)) / d
        inside = (a >= 0) & (b >= 0) & (a + b <= 1)
        rows = (gy[inside] - 0.5).astype(int)
        cols = (gx[inside] - 0.5).astype(int)
        prev = labels[rows, cols]
        inter_overlap += int(((prev >= 0) & (prev != isl)).sum())
        labels[rows, cols] = isl
        claimed[rows, cols] += 1
        texels_px[isl] += inside.sum()
    # A fold inside one island claims texels twice; shared edges claim a thin line twice at most.
    double = int((claimed > 1).sum())
    fold_ratio = float(texels_px.sum() / max(1, (labels >= 0).sum()))

    min_gap = None
    for r in range(1, MAX_RADIUS + 1):
        hit = False
        for dy in range(-r, r + 1):
            for dx in (-r, r) if abs(dy) != r else range(-r, r + 1):
                a = labels[max(0, dy) : size + min(0, dy), max(0, dx) : size + min(0, dx)]
                b = labels[max(0, -dy) : size + min(0, -dy), max(0, -dx) : size + min(0, -dx)]
                if np.any((a >= 0) & (b >= 0) & (a != b)):
                    hit = True
                    break
            if hit:
                break
        if hit:
            min_gap = r - 1
            break
    report = {
        "glb": glb.name,
        "glb_sha256": hashlib.sha256(glb.read_bytes()).hexdigest(),
        "size": size,
        "islands": int(island_of_tri.max() + 1),
        "coverage": round(float((labels >= 0).mean()), 4),
        "overlap_px": inter_overlap,
        "texels_claimed_twice": double,
        "claims_per_covered_texel": round(fold_ratio, 4),
        "min_gap_px": min_gap if min_gap is not None else f">{MAX_RADIUS - 1}",
    }
    out = ROOT / f"assets-source/rooms/{template}/staging/uv1-report.json"
    out.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "study"))
