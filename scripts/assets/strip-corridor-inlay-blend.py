"""Remove the original corridor floor inlays from a loaded baseline blend file.

Run Blender with --python-exit-code 1 -P this script -- OUTPUT.blend [guardian-vault].
"""

from __future__ import annotations

import sys
from pathlib import Path

import bmesh
import bpy


def strip_inlays(output: Path, room: str = "corridor") -> None:
    assert room in ("corridor", "guardian-vault")
    edited = 0
    for obj in bpy.data.objects:
        if obj.type != "MESH" or obj.name not in (room, f"{room}_high"):
            continue
        mesh = bmesh.new()
        mesh.from_mesh(obj.data)
        faces = [
            face
            for face in mesh.faces
            if all((abs(vertex.co.z - 0.005) < 1e-6 if room == "corridor" else
                    0.2899 <= vertex.co.x <= 1.7101 and -5.1601 <= vertex.co.y <= 0.9501 and -0.0001 <= vertex.co.z <= 0.0051) for vertex in face.verts)
        ]
        expected = 10 if room == "corridor" else (47 if obj.name.endswith("_high") else 14)
        if len(faces) != expected:
            raise ValueError(f"{obj.name}: expected {expected} inlay faces, found {len(faces)}")
        bmesh.ops.delete(mesh, geom=faces, context="FACES_ONLY")
        mesh.to_mesh(obj.data)
        mesh.free()
        obj.data.update()
        edited += 1
    if not edited:
        raise ValueError("No target room mesh found")
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(output), compress=True)


def main() -> None:
    args = sys.argv[sys.argv.index("--") + 1 :]
    if len(args) not in (1, 2):
        raise SystemExit("Expected output blend path and optional room after --")
    strip_inlays(Path(args[0]).resolve(), args[1] if len(args) == 2 else "corridor")


if __name__ == "__main__":
    main()
