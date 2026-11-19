#!/usr/bin/env -S uv run --no-project --with pillow --with numpy python
"""Derive shadow-free book chart lighting from the study's existing UV1 bake."""

from __future__ import annotations

import json
import struct
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
ROOM = ROOT / "public/assets/rooms/study"
REVIEW = ROOT / ".local/review"
KTX = Path.home() / ".local/opt/ktx-software-4.4.2/bin/ktx"
SIZE = 512


def source_charts() -> list[tuple[np.ndarray, np.ndarray, bool]]:
    raw = (ROOM / "study.glb").read_bytes()
    length, kind = struct.unpack_from("<I4s", raw, 12)
    assert kind == b"JSON"
    doc = json.loads(raw[20 : 20 + length])
    off = 20 + length
    _, kind = struct.unpack_from("<I4s", raw, off)
    assert kind == b"BIN\0"
    binary = raw[off + 8 :]
    material = next(
        i for i, m in enumerate(doc["materials"]) if m.get("name") == "study_books"
    )
    primitive = next(
        p
        for m in doc["meshes"]
        for p in m["primitives"]
        if p.get("material") == material
    )

    def read(name: str, components: int) -> np.ndarray:
        a = doc["accessors"][primitive["attributes"][name]]
        v = doc["bufferViews"][a["bufferView"]]
        assert a["componentType"] == 5126 and not a.get("sparse")
        offset = v.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = v.get("byteStride", components * 4)
        return np.array(
            [
                struct.unpack_from("<" + "f" * components, binary, offset + i * stride)
                for i in range(a["count"])
            ]
        )

    pos = read("POSITION", 3)
    uv = read("TEXCOORD_1", 2)
    normals = read("NORMAL", 3)
    assert len(pos) == len(uv) and len(pos) % 8 == 0
    result = []
    for i in range(0, len(pos), 8):
        pair = []
        for top in (False, True):
            ids = [j for j in range(i, i + 8) if bool(normals[j, 1] > 0.9) == top]
            assert len(ids) == 4
            p = pos[ids]
            t = uv[ids]
            horizontal = 0 if np.ptp(p[:, 0]) > np.ptp(p[:, 2]) else 2
            vertical = (2 if horizontal == 0 else 0) if top else 1
            # Canonical corners (low horizontal, low vertical), then right, then up.
            x = (p[:, horizontal] - p[:, horizontal].min()) / np.ptp(p[:, horizontal])
            y = (p[:, vertical] - p[:, vertical].min()) / np.ptp(p[:, vertical])

            def corner(a: int, b: int) -> np.ndarray:
                return t[np.argmin((x - a) ** 2 + (y - b) ** 2)]

            corners = np.array([corner(0, 0), corner(1, 0), corner(0, 1), corner(1, 1)])
            assert (
                np.linalg.norm(corners[0] + corners[3] - corners[1] - corners[2]) < 1e-4
            )
            pair.append((corners, np.ptp(p[:, horizontal]), top))
        assert not pair[0][2] and pair[1][2]
        result.append((pair[0][0], pair[1][0], pair[0][1]))
    return result


def sample_profile(image: np.ndarray, uv: np.ndarray, span: float) -> np.ndarray:
    count = 256
    source_h, source_w = image.shape[:2]
    s = np.linspace(0, 1, count)
    radius = 0.20 / span
    # A local 80th percentile across the face rejects shadow silhouettes while
    # retaining changes over the length of the shelf.
    profiles = []
    for x in s:
        ss = np.clip(x + np.linspace(-radius, radius, 17), 0.01, 0.99)
        tt = np.linspace(0.12, 0.88, 11)
        S, T = np.meshgrid(ss, tt)
        coords = uv[0] + S[..., None] * (uv[1] - uv[0]) + T[..., None] * (uv[2] - uv[0])
        ix = np.clip(
            np.rint(coords[..., 0] * (source_w - 1)).astype(int), 0, source_w - 1
        )
        iy = np.clip(
            np.rint(coords[..., 1] * (source_h - 1)).astype(int), 0, source_h - 1
        )
        samples = image[iy, ix, :3].reshape(-1, 3)
        profiles.append(np.percentile(samples, 80, axis=0))
    profile = np.array(profiles)
    # Softly average the percentile envelope to prevent thin texture stripes.
    padded = np.pad(profile, ((5, 5), (0, 0)), mode="edge")
    return np.stack(
        [np.convolve(padded[:, c], np.ones(11) / 11, mode="valid") for c in range(3)],
        axis=1,
    )


def paint_chart(
    out: np.ndarray,
    mask: np.ndarray,
    uv: np.ndarray,
    profile: np.ndarray,
    brightness: float,
) -> None:
    p = uv * SIZE
    basis = np.column_stack((p[1] - p[0], p[2] - p[0]))
    assert abs(np.linalg.det(basis)) > 1e-5
    lo = np.maximum(np.floor(p.min(axis=0)).astype(int) - 1, 0)
    hi = np.minimum(np.ceil(p.max(axis=0)).astype(int) + 1, SIZE - 1)
    xx, yy = np.meshgrid(
        np.arange(lo[0], hi[0] + 1) + 0.5, np.arange(lo[1], hi[1] + 1) + 0.5
    )
    coords = np.stack((xx - p[0, 0], yy - p[0, 1]), axis=-1) @ np.linalg.inv(basis).T
    inside = (
        (coords[..., 0] >= 0)
        & (coords[..., 0] <= 1)
        & (coords[..., 1] >= 0)
        & (coords[..., 1] <= 1)
    )
    indices = np.clip(np.rint(coords[..., 0] * 255).astype(int), 0, 255)
    colors = np.clip(profile[indices] * brightness, 8, 245).astype(np.uint8)
    view = out[lo[1] : hi[1] + 1, lo[0] : hi[0] + 1]
    view[inside] = colors[inside]
    mask[lo[1] : hi[1] + 1, lo[0] : hi[0] + 1] |= inside


def main() -> None:
    REVIEW.mkdir(parents=True, exist_ok=True)
    extracted = REVIEW / "study-lightmap-extracted.png"
    subprocess.run(
        [
            str(KTX),
            "extract",
            "--transcode",
            "rgba8",
            str(ROOM / "study.lightmap.ktx2"),
            str(extracted),
        ],
        check=True,
    )
    source = np.asarray(Image.open(extracted).convert("RGB"))
    assert source.shape == (2048, 2048, 3)
    charts = source_charts()
    assert len(charts) == 18, len(charts)
    base = np.asarray(
        Image.fromarray(source).resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    ).copy()
    result = np.zeros_like(base)
    mask = np.zeros((SIZE, SIZE), bool)
    contact = Image.new("RGB", (512, 18 * 32))
    for i, (front, top, span) in enumerate(charts):
        profile = sample_profile(source, front, span)
        paint_chart(result, mask, front, profile, 1.0)
        paint_chart(result, mask, top, profile, 1.12)
        band = np.tile(
            np.clip(profile, 8, 245).astype(np.uint8)[None, :, :], (16, 1, 1)
        )
        band = np.concatenate(
            (band, np.clip(band.astype(float) * 1.12, 8, 245).astype(np.uint8)), axis=0
        )
        contact.paste(Image.fromarray(band).resize((512, 32)), (0, i * 32))
    # Extend chart edges into two UV texels, then overlay exact faces. The
    # original surrounding bake remains unchanged and is never written back.
    padded = result.copy()
    filled = mask.copy()
    for _ in range(2):
        nxt = padded.copy()
        new = filled.copy()
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            shifted = np.roll(filled, (dy, dx), (0, 1))
            available = shifted & ~new
            if dy == -1:
                available[-1, :] = False
            if dy == 1:
                available[0, :] = False
            if dx == -1:
                available[:, -1] = False
            if dx == 1:
                available[:, 0] = False
            vals = np.roll(padded, (dy, dx), (0, 1))
            nxt[available] = vals[available]
            new |= available
        padded, filled = nxt, new
    base[filled] = padded[filled]
    base[mask] = result[mask]
    preview = REVIEW / "book-irradiance.png"
    Image.fromarray(base).save(preview)
    contact.save(REVIEW / "book-irradiance-profiles.png")
    stage = REVIEW / "book-irradiance.staged.ktx2"
    out = ROOT / "public/assets/props/study-books/book-irradiance.ktx2"
    subprocess.run(
        [
            str(KTX),
            "create",
            "--format",
            "R8G8B8_SRGB",
            "--assign-tf",
            "srgb",
            "--assign-texcoord-origin",
            "top-left",
            "--encode",
            "uastc",
            "--uastc-quality",
            "2",
            "--zstd",
            "18",
            "--generate-mipmap",
            str(preview),
            str(stage),
        ],
        check=True,
    )
    subprocess.run([str(KTX), "validate", str(stage)], check=True)
    raw = stage.read_bytes()
    assert raw[:12] == b"\xabKTX 20\xbb\r\n\x1a\n"
    assert (
        struct.unpack_from("<I", raw, 20)[0],
        struct.unpack_from("<I", raw, 24)[0],
        struct.unpack_from("<I", raw, 40)[0],
    ) == (512, 512, 10)
    out.write_bytes(raw)
    print(
        f"{out}: {len(charts)} rows, {mask.sum()} chart pixels, 512x512, 10 mips, {len(raw)} bytes"
    )


if __name__ == "__main__":
    main()
