"""Standard-library asset gate for the animation-only Cog Sentry patrol library."""
from __future__ import annotations

import hashlib
import itertools
import json
import math
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DURATIONS = {"patrol-start": 0.5, "patrol-walk": 1.2, "patrol-stop": 0.7,
             "patrol-turn-left": 1.2, "patrol-turn-right": 1.2}


def inspect_motion(root: Path) -> None:
    art = root / "assets-source/enemies/cog-sentry-patrol"
    models = root / "public/assets/enemies"
    source = root / "assets-source/enemies/cog-sentry/blend/cog-sentry.low.blend"
    combat = models / "cog-sentry/cog-sentry.glb"
    motion = models / "cog-sentry-patrol/locomotion.glb"
    proof = json.loads((art / "validation.json").read_text())
    files = [(source, "sourceRigSha256"), (combat, "combatGlbSha256"), (motion, "locomotionGlbSha256"),
             (art / "locomotion.blend", "editableSha256"),
             (root / "scripts/assets/build-sentry-patrol.py", "generatorSha256"),
             (root / "scripts/assets/build-sentry-patrol-check.py", "inspectorSha256")]
    for path, key in files:
        if hashlib.sha256(path.read_bytes()).hexdigest() != proof[key]:
            raise ValueError(f"{path.name} differs from the reimported candidate")

    def glb(path: Path) -> tuple[dict, bytes]:
        data = path.read_bytes()
        magic, version, total, size, kind = struct.unpack_from("<4sIII4s", data)
        if (magic, version, total, kind) != (b"glTF", 2, len(data), b"JSON"):
            raise ValueError(f"invalid glTF header in {path.name}")
        return json.loads(data[20:20 + size]), data[28 + size:]

    original, _ = glb(combat)
    lib, binary = glb(motion)
    if any(lib.get(key) for key in ("meshes", "skins", "materials", "textures", "images")):
        raise ValueError("motion library contains duplicate combat resources")
    joints = original["skins"][0]["joints"]
    by_name = {original["nodes"][i]["name"]: original["nodes"][i] for i in joints}
    nodes = lib["nodes"]
    if len(nodes) != len(joints) or {n["name"] for n in nodes} != set(by_name):
        raise ValueError("motion node names differ from the combat skeleton")
    for node in nodes:
        name = node["name"]
        expected = by_name[name]
        for attr in ("rotation", "translation", "scale", "matrix"):
            if node.get(attr) != expected.get(attr):
                raise ValueError(f"{name} bind {attr} differs from the combat joint")
        children = [nodes[i]["name"] for i in node.get("children", [])]
        wanted = [original["nodes"][i]["name"] for i in expected.get("children", []) if i in joints]
        if children != wanted:
            raise ValueError(f"{name} joint hierarchy differs from the combat skeleton")
    if len(lib["animations"]) != len(DURATIONS) or {a["name"] for a in lib["animations"]} != set(DURATIONS):
        raise ValueError("expected start, walk, stop, left pivot and right pivot")
    targets = {(n, "rotation") for n in by_name if n != "root"} | {("hips", "translation")}

    def values(idx: int, kind: str) -> tuple[float, ...]:
        acc = lib["accessors"][idx]
        view = lib["bufferViews"][acc["bufferView"]]
        lanes = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}[kind]
        if acc["type"] != kind or acc["componentType"] != 5126:
            raise ValueError(f"expected float {kind} values")
        return struct.unpack_from(f"<{lanes * acc['count']}f", binary, view.get("byteOffset", 0) + acc.get("byteOffset", 0))

    for clip in lib["animations"]:
        seen = []
        name = clip["name"]
        for ch in clip["channels"]:
            prop = ch["target"]["path"]
            seen.append((nodes[ch["target"]["node"]]["name"], prop))
            sampler = clip["samplers"][ch["sampler"]]
            times = values(sampler["input"], "SCALAR")
            if not times or not all(map(math.isfinite, times)) or times[0] != 0 or abs(times[-1] - DURATIONS[name]) > 1e-5 or any(a >= b for a, b in itertools.pairwise(times)):
                raise ValueError(f"{name} has an invalid time range")
            motion_values = values(sampler["output"], "VEC4" if prop == "rotation" else "VEC3")
            if lib["accessors"][sampler["output"]]["count"] != len(times) or not all(map(math.isfinite, motion_values)):
                raise ValueError(f"{name} has invalid transform samples")
        if len(seen) != len(targets) or set(seen) != targets:
            raise ValueError(f"{name} joint targets differ from the authored motion contract")
        metrics = proof["clips"][name]
        if (metrics["oppositeShoeIntersectionSamples"] != 0 or metrics["rootMatrixError"] > 0.0001 or max(metrics["maxPlantedVertexDriftM"].values()) >= 0.002
                or metrics["minimumMeshHeightM"] <= -0.001):
            raise ValueError(f"{name} failed the planted mesh, floor or root-motion measurement")
    if proof["samplesHz"] < 120 or max(proof["maxEndpointVertexErrorM"].values()) >= 0.0001:
        raise ValueError("reimported mesh failed clip transition or sampling requirements")


def check_patrol(errors: list[str]) -> None:
    try:
        inspect_motion(ROOT)
    except (OSError, ValueError, KeyError, IndexError, TypeError, struct.error) as error:
        errors.append(f"Cog Sentry patrol: {error}")
    else:
        print("asset-check Cog Sentry patrol: 5 clips on the original skeleton, planted mesh and transitions verified")


if __name__ == "__main__":
    inspect_motion(ROOT)
