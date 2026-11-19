"""Build the architectural kit's two original six-swatch PBR atlases."""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

import bpy
import numpy as np

TILE = 256
GRID = (3, 2)


def png(path: Path, rgb: np.ndarray) -> None:
    rgb = np.ascontiguousarray(np.rint(np.clip(rgb, 0, 255)).astype(np.uint8))
    h, w, _ = rgb.shape

    def chunk(name: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + name + data + struct.pack(">I", zlib.crc32(name + data))

    rows = b"".join(b"\0" + row.tobytes() for row in rgb[::-1])
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">2I5B", w, h, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def noise(rng: np.random.Generator, x: np.ndarray, y: np.ndarray, nx: int, ny: int) -> np.ndarray:
    grid = rng.uniform(-1, 1, (ny + 1, nx + 1))
    xx, yy = x * nx, y * ny
    ix, iy = xx.astype(int), yy.astype(int)
    tx, ty = xx - ix, yy - iy
    tx, ty = tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty)
    return ((grid[iy, ix] * (1 - tx) + grid[iy, ix + 1] * tx) * (1 - ty)
            + (grid[iy + 1, ix] * (1 - tx) + grid[iy + 1, ix + 1] * tx) * ty)


def walnut_swatch(source: Path, cut: int) -> np.ndarray:
    image = bpy.data.images.load(str(source), check_existing=True)
    image.colorspace_settings.name = "Non-Color"
    w, h = image.size
    pixels = np.empty(w * h * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    pixels = pixels.reshape(h, w, 4)
    # Cut faces inside individual boards, away from the photographed plank seams.
    left, right = ((.055, .45), (.56, .95))[cut % 2]
    yi = np.linspace(.04 + .025 * cut, .94 - .018 * cut, TILE)
    xi = np.linspace(left + .012 * (cut % 3), right, TILE)
    if cut % 2:
        xi = xi[::-1]
    return pixels[np.ix_((yi * (h - 1)).astype(int), (xi * (w - 1)).astype(int))][:, :, :3] * 255


def make_maps(style: str, directory: Path) -> dict[str, Path]:
    colors = ([(107, 107, 101), (69, 66, 61), (173, 128, 78), (146, 87, 53), (43, 40, 38), (108, 81, 65)]
              if style == "Boiler" else
              [(137, 87, 53), (105, 66, 42), (164, 110, 66), (93, 60, 42), (160, 115, 65), (56, 42, 33)])
    maps = {k: np.zeros((TILE * GRID[1], TILE * GRID[0], 3)) for k in ("color", "normal", "orm")}
    y, x = (np.indices((TILE, TILE)) + .5) / TILE
    walnut = Path(__file__).resolve().parents[2] / "public/assets/materials/walnut/walnut.basecolor.png"
    for i, color in enumerate(colors):
        rng = np.random.default_rng(1401 + i + (20 if style == "Boiler" else 0))
        cloud = noise(rng, x, y, 4, 4)
        micro = noise(rng, x, y, 44, 47)
        brushed = noise(rng, x, y, 81, 4)
        if style == "Timber" and i != 4:
            # Saw-cut cathedral figure rises across long fibres. Narrow medullary flecks interrupt the pores.
            wander = noise(rng, x, y, 4, 3)
            track = 15 * (x + .042 * wander + .016 * np.sin(6 * y))
            crown = 21 * (np.sqrt((x - .48 + .023 * wander) ** 2 + .005) + .22 * (y - .12) ** 2)
            ring = (.5 + .5 * np.cos(2 * np.pi * crown)) ** 5
            fibre = (.5 + .5 * np.sin(2 * np.pi * track + 3 * brushed)) ** 6
            fleck = np.maximum(0, noise(rng, x, y, 70, 14) - .58)
            field = .05 * cloud + .025 * brushed - .035 * ring - .026 * fibre + .04 * fleck
            height = .014 * ring + .017 * brushed + .009 * micro
            rough, metal = .52 + .025 * brushed + .025 * ring, np.zeros_like(x)
        else:
            cast = noise(rng, x, y, 17, 18)
            peen = np.maximum(0, cast - .48) * .25
            field = .10 * cloud + .045 * brushed + .048 * cast + .025 * micro - peen
            height = .025 * cast + .027 * micro + .017 * brushed
            rough = (.43 if i in (2, 3, 4) else .54) + .065 * cloud + .024 * micro
            metal = np.full_like(x, .66 if i in (2, 3, 4) else .42)
        rgb = np.array(color) * (1 + field[:, :, None])
        if style == "Timber" and i != 4:
            figure = walnut_swatch(walnut, i)
            avg = np.mean(figure, axis=(0, 1))
            rgb *= .20 + .80 * figure / avg
        dy, dx = np.gradient(height)
        norm = np.stack((-dx * 4, -dy * 4, np.ones_like(x)), axis=2)
        norm /= np.linalg.norm(norm, axis=2, keepdims=True)
        normal = np.rint((norm + 1) * 127.5 / 2) * 2
        orm = np.rint(255 * np.stack((np.ones_like(x), rough, metal), axis=2) / 3) * 3
        row, col = divmod(i, GRID[0])
        sl = (slice(row * TILE, (row + 1) * TILE), slice(col * TILE, (col + 1) * TILE))
        for name, data in (("color", np.rint(rgb / 2) * 2), ("normal", normal), ("orm", orm)):
            maps[name][sl] = data
    result = {}
    for name, data in maps.items():
        path = directory / f"{style.lower()}.{name}.png"
        png(path, data)
        result[name] = path
    return result


def finish_material(style: str, directory: Path) -> bpy.types.Material:
    mat = bpy.data.materials.new(style + "Finish")
    mat.use_nodes = True
    mat.use_backface_culling = True
    nodes, link = mat.node_tree.nodes, mat.node_tree.links.new
    p = nodes.get("Principled BSDF")
    tex = {}
    for key, path in make_maps(style, directory).items():
        img = bpy.data.images.load(str(path))
        if key != "color":
            img.colorspace_settings.name = "Non-Color"
        img.pack()
        img.filepath_raw = "//packed/" + path.name
        tex[key] = nodes.new("ShaderNodeTexImage")
        tex[key].image = img
    colors = nodes.new("ShaderNodeVertexColor")
    colors.layer_name = "Ambient"
    multiply = nodes.new("ShaderNodeMixRGB")
    multiply.blend_type = "MULTIPLY"
    multiply.inputs[0].default_value = 1
    link(tex["color"].outputs["Color"], multiply.inputs[1])
    link(colors.outputs["Color"], multiply.inputs[2])
    link(multiply.outputs[0], p.inputs["Base Color"])
    normal = nodes.new("ShaderNodeNormalMap")
    link(tex["normal"].outputs["Color"], normal.inputs["Color"])
    link(normal.outputs[0], p.inputs["Normal"])
    split = nodes.new("ShaderNodeSeparateColor")
    link(tex["orm"].outputs["Color"], split.inputs[0])
    link(split.outputs[1], p.inputs["Roughness"])
    link(split.outputs[2], p.inputs["Metallic"])
    return mat
