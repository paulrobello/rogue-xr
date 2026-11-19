"""Remove the original corridor floor inlays from a loaded baseline blend file.

Run Blender with --python-exit-code 1 -P this script -- OUTPUT.blend.
"""

from __future__ import annotations

import sys
from pathlib import Path

import bmesh
import bpy


def strip_inlays(output: Path) -> None:
    edited = 0
    for obj in bpy.data.objects:
        if obj.type != "MESH" or obj.name not in ("corridor", "corridor_high"):
            continue
        mesh = bmesh.new()
        mesh.from_mesh(obj.data)
        faces = [
            face
            for face in mesh.faces
            if all(abs(vertex.co.z - 0.005) < 1e-6 for vertex in face.verts)
        ]
        if len(faces) != 10:
            raise ValueError(f"{obj.name}: expected 10 inlay triangles, found {len(faces)}")
        bmesh.ops.delete(mesh, geom=faces, context="FACES_ONLY")
        mesh.to_mesh(obj.data)
        mesh.free()
        obj.data.update()
        edited += 1
    if not edited:
        raise ValueError("No corridor mesh found")
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(output), compress=True)


def main() -> None:
    args = sys.argv[sys.argv.index("--") + 1 :]
    if len(args) != 1:
        raise SystemExit("Expected one output blend path after --")
    strip_inlays(Path(args[0]).resolve())


if __name__ == "__main__":
    main()
