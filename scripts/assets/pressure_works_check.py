"""Validate Pressure Works GLB structure, budgets, dimensions and provenance."""

from __future__ import annotations

import hashlib
import itertools
import json
import math
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "assets-source/props/pressure-works"
OUT = ROOT / "public/assets/props/pressure-works"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rotate(p, q):
    x, y, z, w = q
    # Quaternion rotation, including the nontrivial transforms on joined mesh roots.
    u = (x, y, z)
    cross = lambda a, b: (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )
    uv = cross(u, p)
    uuv = cross(u, uv)
    return tuple(p[i] + 2 * (w * uv[i] + uuv[i]) for i in range(3))


def check_pressure(errors: list[str]) -> None:
    try:
        prov = json.loads((SRC / "provenance.json").read_text())
        for path, expected in prov["sha256"].items():
            if digest(ROOT / path) != expected:
                errors.append(f"pressure-works: hash mismatch {path}")
        for name, width, depth, limit, material_limit in (
            ("manifold", 2.8, 0.76, 12000, 6),
            ("gallery-pipes", 3.3, 0.20, 12000, 6),
            ("accumulator-bank", 2.62, 0.38, 4501, 5),
        ):
            data = (OUT / f"{name}.glb").read_bytes()
            magic, version, length = struct.unpack_from("<4sII", data)
            if magic != b"glTF" or version != 2 or length != len(data):
                raise ValueError(f"{name}: invalid GLB header")
            chunk_len, kind = struct.unpack_from("<I4s", data, 12)
            if kind != b"JSON":
                raise ValueError(f"{name}: missing JSON chunk")
            gltf = json.loads(data[20 : 20 + chunk_len])
            if (
                gltf.get("images")
                or gltf.get("textures")
                or any("uri" in b for b in gltf.get("buffers", []))
            ):
                errors.append(
                    f"pressure-works/{name}: external or unexpected image/buffer"
                )
            tris = 0
            points = []
            scene = gltf["scenes"][gltf.get("scene", 0)]
            nodes = gltf["nodes"]
            if len(scene["nodes"]) != len(nodes):
                errors.append(f"pressure-works/{name}: expected root mesh nodes only")
            for node in nodes:
                if "mesh" not in node or node.get("children") or "matrix" in node:
                    raise ValueError(f"{name}: unsupported hierarchy")
                q = node.get("rotation", [0, 0, 0, 1])
                scale = node.get("scale", [1, 1, 1])
                t = node.get("translation", [0, 0, 0])
                for prim in gltf["meshes"][node["mesh"]]["primitives"]:
                    if prim.get("mode", 4) != 4:
                        raise ValueError(f"{name}: non-triangle primitive")
                    acc = gltf["accessors"][prim["attributes"]["POSITION"]]
                    count = (
                        gltf["accessors"][prim["indices"]]["count"]
                        if "indices" in prim
                        else acc["count"]
                    )
                    tris += count // 3
                    for p in itertools.product(*zip(acc["min"], acc["max"])):
                        r = rotate(tuple(p[i] * scale[i] for i in range(3)), q)
                        points.append(tuple(r[i] + t[i] for i in range(3)))
            lo = [min(p[i] for p in points) for i in range(3)]
            hi = [max(p[i] for p in points) for i in range(3)]
            if tris >= limit or len(gltf.get("materials", [])) > material_limit:
                errors.append(f"pressure-works/{name}: budget exceeded")
            if (
                hi[0] - lo[0] > width + 1e-4
                or hi[2] - lo[2] > depth + 1e-4
                or abs(lo[1]) > 1e-4
            ):
                errors.append(f"pressure-works/{name}: invalid bounds {lo}, {hi}")
            if name == "accumulator-bank" and (
                lo[0] < -1.3101
                or hi[0] > 1.3101
                or lo[2] < -1e-4
                or hi[2] > 0.3801
                or hi[1] > 2.8501
            ):
                errors.append(
                    f"pressure-works/{name}: invalid accumulator placement {lo}, {hi}"
                )
            if name == "manifold":
                for i, x in enumerate((-0.82, 0, 0.82)):
                    matches = [n for n in nodes if n.get("name") == f"valve-{i}"]
                    if len(matches) != 1:
                        errors.append(f"pressure-works: missing or duplicate valve-{i}")
                        continue
                    n = matches[0]
                    if (
                        any(
                            abs(a - b) > 1e-5
                            for a, b in zip(
                                n.get("translation", [0, 0, 0]), (x, 1.05, 0.39)
                            )
                        )
                        or n.get("rotation", [0, 0, 0, 1]) != [0, 0, 0, 1]
                        or n.get("scale", [1, 1, 1]) != [1, 1, 1]
                    ):
                        errors.append(
                            f"pressure-works: valve-{i} pivot/transform changed"
                        )
            report = json.loads((SRC / f"{name}.report.json").read_text())
            if (
                tris != report["triangles"]
                or len(gltf.get("materials", [])) != report["materials"]
            ):
                errors.append(f"pressure-works/{name}: report differs from GLB")
            print(
                f"asset-check props/pressure-works/{name}: {tris} tris, {len(gltf.get('materials', []))} materials, bounds {tuple(round(hi[i] - lo[i], 4) for i in range(3))}"
            )
    except (OSError, ValueError, KeyError, IndexError, struct.error) as exc:
        errors.append(f"pressure-works: {exc}")


if __name__ == "__main__":
    issues: list[str] = []
    check_pressure(issues)
    for issue in issues:
        print("FAIL", issue)
    raise SystemExit(bool(issues))
