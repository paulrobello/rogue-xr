"""Fingerprint retained Blender mesh faces for before-and-after corridor comparisons.

Run Blender with --python-exit-code 1 -P this script -- OUTPUT.json [guardian-vault] on each blend.
The original inlay faces are excluded. Face and corner ordering is normalized, and
positions, vertex normals and every UV layer are rounded to seven decimal places.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import bpy


def mesh_fingerprints(room: str = "corridor") -> dict[str, str]:
    assert room in ("corridor", "guardian-vault")
    fingerprints: dict[str, str] = {}
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        mesh = obj.data
        faces = []
        for polygon in mesh.polygons:
            vertices = [mesh.vertices[mesh.loops[index].vertex_index].co for index in polygon.loop_indices]
            if obj.name in (room, f"{room}_high") and all(
                (abs(vertex.z - 0.005) < 1e-6 if room == "corridor" else
                 0.2899 <= vertex.x <= 1.7101 and -5.1601 <= vertex.y <= 0.9501 and -0.0001 <= vertex.z <= 0.0051) for vertex in vertices
            ):
                continue
            corners = []
            for index in polygon.loop_indices:
                loop = mesh.loops[index]
                vertex = mesh.vertices[loop.vertex_index]
                uvs = [component for layer in mesh.uv_layers for component in layer.data[index].uv]
                corners.append(tuple(round(float(value), 7) for value in (*vertex.co, *vertex.normal, *uvs)))
            faces.append((polygon.material_index, tuple(sorted(corners))))
        fingerprints[obj.name] = hashlib.sha256(repr(sorted(faces)).encode()).hexdigest()
    return fingerprints


def main() -> None:
    args = sys.argv[sys.argv.index("--") + 1 :]
    if len(args) not in (1, 2):
        raise SystemExit("Expected output JSON path and optional room after --")
    Path(args[0]).write_text(json.dumps(mesh_fingerprints(args[1] if len(args) == 2 else "corridor"), sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
