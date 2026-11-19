"""Remove corridor inlay indices from an existing GLB without changing its lightmap UVs.

Usage: python3 scripts/assets/strip-corridor-inlay.py BASELINE.glb OUTPUT.glb [guardian-vault]
The baseline is the original room GLB. All retained vertex attributes remain byte-identical.
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import numpy as np


def strip(source: Path, target: Path, room: str = "corridor") -> None:
    assert room in ("corridor", "guardian-vault")
    data = source.read_bytes()
    magic, version, _ = struct.unpack_from('<4sII', data)
    assert (magic, version) == (b'glTF', 2)
    json_len = struct.unpack_from('<I', data, 12)[0]
    gltf = json.loads(data[20:20 + json_len])
    binary_len = struct.unpack_from('<I', data, 20 + json_len)[0]
    binary = bytearray(data[28 + json_len:28 + json_len + binary_len])
    original = bytes(binary)
    removed = 0
    for mesh in gltf['meshes']:
        if mesh.get('name') != room:
            continue
        for prim in mesh['primitives']:
            if gltf['materials'][prim['material']]['name'] != f'{room}_brass-aged':
                continue
            pos_acc = gltf['accessors'][prim['attributes']['POSITION']]
            pos_view = gltf['bufferViews'][pos_acc['bufferView']]
            assert pos_acc['componentType'] == 5126 and 'byteStride' not in pos_view
            pos = np.frombuffer(original, dtype='<f4', count=pos_acc['count'] * 3,
                                offset=pos_view.get('byteOffset', 0) + pos_acc.get('byteOffset', 0)).reshape(-1, 3)
            idx_acc = gltf['accessors'][prim['indices']]
            idx_view = gltf['bufferViews'][idx_acc['bufferView']]
            assert idx_acc['componentType'] == 5123 and 'byteStride' not in idx_view
            offset = idx_view.get('byteOffset', 0) + idx_acc.get('byteOffset', 0)
            triangles = np.frombuffer(original, dtype='<u2', count=idx_acc['count'], offset=offset).reshape(-1, 3)
            points = pos[triangles]
            if room == 'corridor':
                mask = np.all(np.isclose(points[:, :, 1], .005, atol=1e-6), axis=1)
                selected = points[mask]
                assert selected.shape == (10, 3, 3)
                assert np.all(np.abs(selected[:, :, 0]) <= .516) and np.all(np.abs(selected[:, :, 2]) <= 3.921)
            else:
                mask = np.all((points[:, :, 0] >= .2899) & (points[:, :, 0] <= 1.7101) & (points[:, :, 1] >= -.0001) & (points[:, :, 1] <= .0051) & (points[:, :, 2] >= -.9501) & (points[:, :, 2] <= 5.1601), axis=1)
                assert points[mask].shape == (14, 3, 3)
            kept = triangles[~mask].copy()
            raw = kept.astype('<u2').tobytes()
            binary[offset:offset + len(raw)] = raw
            idx_acc['count'] = kept.size
            assert np.array_equal(kept, triangles[~mask])
            removed += int(mask.sum())
    assert removed == (10 if room == 'corridor' else 14), removed
    j = json.dumps(gltf, separators=(',', ':')).encode()
    j += b' ' * (-len(j) % 4)
    total = 12 + 8 + len(j) + 8 + len(binary)
    target.write_bytes(struct.pack('<4sII', b'glTF', 2, total) + struct.pack('<I4s', len(j), b'JSON') + j + struct.pack('<I4s', len(binary), b'BIN\0') + binary)
    print(f'Removed {removed} triangles; retained indices and every vertex attribute are byte-identical.')


if __name__ == '__main__':
    strip(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3] if len(sys.argv) > 3 else "corridor")
