"""Generate the Boiler and Timber architectural bays. Run in factory-startup Blender."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import sys
import tempfile

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from finish_surfaces import GRID, TILE, finish_material

NAMES = ("BoilerBay", "BoilerServiceBay", "BoilerDoor", "TimberBay", "TimberCarvedBay", "TimberDoor", "BoilerExchangerBay")
WIDTH, HEIGHT = 2.0, 4.0
LAMP_Z = 2.75
Point = tuple[float, float, float]
Outline = list[tuple[float, float]]


def rect(x: float, z: float, w: float, h: float, clip: float = 0.) -> Outline:
    a, b, low, top = x - w / 2, x + w / 2, z - h / 2, z + h / 2
    if clip <= 0:
        return [(a, low), (b, low), (b, top), (a, top)]
    c = min(clip, w * .31, h * .31)
    return [(a + c, low), (b - c, low), (b, low + c), (b, top - c),
            (b - c, top), (a + c, top), (a, top - c), (a, low + c)]


def oval(x: float, z: float, rx: float, rz: float, steps: int) -> Outline:
    return [(x + rx * math.cos(math.tau * i / steps), z + rz * math.sin(math.tau * i / steps))
            for i in range(steps)]


class Bay:
    def __init__(self, name: str, material: bpy.types.Material, lamp: bpy.types.Material, high: bool):
        self.name = name
        self.finish = material
        self.glass = lamp
        self.high = high
        self.objects = []

    def mesh(self, name: str, points: list[Point], faces: list[tuple], swatch: int,
             grain: str = "v", glass: bool = False) -> bpy.types.Mesh:
        # Coordinates are (right, up, proud). Blender's front is -Y.
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata([(x, -depth, z) for x, z, depth in points], [], faces)
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        mesh.materials.append(self.glass if glass else self.finish)
        self.objects.append(obj)
        uv = mesh.uv_layers.new(name="Surface")
        mins = [min(p[k] for p in points) for k in range(3)]
        maxes = [max(p[k] for p in points) for k in range(3)]
        lengths = [max(.005, maxes[i] - mins[i]) for i in range(3)]
        # Each swatch represents a 1.25 m cut. Long rails sample along the grain.
        col, row = swatch % GRID[0], swatch // GRID[0]
        seed = sum((i + 1) * ord(c) for i, c in enumerate(name))
        seed += round((mins[0] + maxes[0]) * 29) + round((mins[1] + maxes[1]) * 47)
        for poly in mesh.polygons:
            n = poly.normal
            if abs(n.y) >= max(abs(n.x), abs(n.z)):
                axes = (0, 1)
            elif abs(n.x) >= abs(n.z):
                axes = (2, 1)
            else:
                axes = (0, 2)
            if grain == "h":
                axes = axes[::-1]
            for li in poly.loop_indices:
                p = points[mesh.loops[li].vertex_index]
                coords = []
                for j, axis in enumerate(axes):
                    window = min(.965, lengths[axis] / (1.25 if j == 0 else 1.75))
                    offset = ((seed * (17 + axis) % 97) / 97) * (1 - window)
                    position = (p[axis] - mins[axis]) / lengths[axis]
                    if self.name.startswith("Timber") and maxes[0] + mins[0] > 0 and j == 0:
                        position = 1 - position
                    coords.append((2 + (TILE - 4) * (offset + window * position)) / TILE)
                uv.data[li].uv = ((col + coords[0]) / GRID[0], (row + coords[1]) / GRID[1])
        return mesh

    def profile(self, name: str, rings: list[tuple[Outline, float]], swatch: int,
                grain: str = "v", glass: bool = False) -> None:
        points = [(x, z, d) for outline, d in rings for x, z in outline]
        n = len(rings[0][0])
        faces = []
        for k in range(len(rings) - 1):
            for i in range(n):
                j = (i + 1) % n
                faces.append((k * n + i, k * n + j, (k + 1) * n + j, (k + 1) * n + i))
        last = (len(rings) - 1) * n
        cap = tuple(last + i for i in range(n))
        outline, depth = rings[-1]
        xs, zs = zip(*outline)
        if (max(xs) - min(xs)) * (max(zs) - min(zs)) > .22 and name in (
                "Punched steel plate", "Lintel cover", "Field tablet", "Service door"):

            # The AO and practical pool need receivers inside the face, not just along the trim.
            rim = []
            for i, (x, z) in enumerate(outline):
                end_x, end_z = outline[(i + 1) % n]
                segments = max(1, math.ceil(math.hypot(end_x - x, end_z - z) / .28))
                for j in range(segments):
                    f = j / segments
                    rim.append((x + f * (end_x - x), z + f * (end_z - z)))
            cx, cz = sum(xs) / n, sum(zs) / n
            center_index = len(points)
            points.append((cx, cz, depth))
            count = len(rim)
            for k in range(1, 4):
                start = len(points)
                points.extend((cx + k * (x - cx) / 3, cz + k * (z - cz) / 3, depth) for x, z in rim)
                for i in range(count):
                    j = (i + 1) % count
                    if k == 1:
                        faces.append((center_index, start + i, start + j))
                    else:
                        faces.append((start - count + i, start + i, start + j, start - count + j))
        else:
            faces.append(cap)
        mesh = self.mesh(name, points, faces, swatch, grain, glass)
        if glass:
            for face in mesh.polygons:
                face.use_smooth = True

    def plate(self, name: str, x: float, z: float, w: float, h: float,
              back: float, front: float, swatch: int, bevel: float = .007, clip: float = 0., grain: str = "v") -> None:
        bevel = min(bevel, w / 4, h / 4, (front - back) * .7)
        rings = [(rect(x, z, w, h, clip), back), (rect(x, z, w, h, clip), front - bevel)]
        if bevel > 0:
            rings.append((rect(x, z, w - 2 * bevel, h - 2 * bevel, clip), front))
        else:
            rings = [rings[0], (rings[1][0], front)]
        self.profile(name, rings, swatch, grain)

    def round(self, name: str, x: float, z: float, rx: float, rz: float, back: float, front: float,
              swatch: int, sides: int = 12, glass: bool = False) -> None:
        n = sides * (2 if self.high and sides >= 10 else 1)
        outline = oval(x, z, rx, rz, n)
        self.profile(name, [(outline, back), (outline, front - .003),
                            (oval(x, z, rx * .94, rz * .94, n), front)], swatch, glass=glass)

    def beam(self, name: str, start: tuple, end: tuple, back: float, front: float,
             width: float, swatch: int) -> None:
        x0, z0 = start
        x1, z1 = end
        delta = Vector((x1 - x0, z1 - z0)).normalized()
        dx, dz = delta.y * width / 2, -delta.x * width / 2
        ring = [(x0 + dx, z0 + dz), (x1 + dx, z1 + dz), (x1 - dx, z1 - dz), (x0 - dx, z0 - dz)]
        self.profile(name, [(ring, back), (ring, front)], swatch)

    def pipe(self, name: str, x0: float, x1: float, z: float, d: float, r: float, swatch: int) -> None:
        steps = 16 if self.high else 10
        points = [(x, z + r * math.sin(math.tau * j / steps), d + r * math.cos(math.tau * j / steps))
                  for x in (x0, x1) for j in range(steps)]
        faces = [(j, (j + 1) % steps, steps + (j + 1) % steps, steps + j) for j in range(steps)]
        faces += [tuple(reversed(range(steps))), tuple(range(steps, steps * 2))]
        # Ring order is clockwise looking along the positive shaft.
        mesh = self.mesh(name, points, [tuple(reversed(f)) for f in faces], swatch, "h")
        for face in mesh.polygons[:steps]:
            face.use_smooth = True
        for edge in mesh.edges:
            a, b = (mesh.vertices[i].co for i in edge.vertices)
            if abs(a.x - b.x) < .00001:
                edge.use_edge_sharp = True

    def shell(self, door: bool, swatch: int) -> None:
        slabs = [(0, 2, 2, 4)] if not door else [(-.9, 2, .2, 4), (.9, 2, .2, 4), (0, 3.2, 1.6, 1.6)]
        for x, z, w, h in slabs:
            self.plate("Backing", x, z, w, h, 0., .012, swatch, bevel=0)


def rivets(b: Bay, x: float, z: float, width: float, height: float) -> None:
    for xx in (x - width / 2, x + width / 2):
        for zz in (z - height / 2, z + height / 2):
            b.round("Rivet", xx, zz, .017, .017, .043, .063, 2, 8)


def practical(b: Bay, timber: bool) -> None:
    z = LAMP_Z
    dark, gold = (3, 4) if timber else (1, 2)
    b.round("Wall rose", 0, z, .16, .21, .046, .09, dark, 20)
    b.round("Escutcheon", 0, z, .131, .184, .087, .112, gold, 20)
    # The convex opal and pressure lens are actual domes under their hardware.
    rx, rz = (.084, .137) if timber else (.099, .145)
    sides = 36 if b.high else 24
    lens = [(oval(0, z, rx * radius, rz * radius, sides), depth)
            for radius, depth in ((1., .110), (.91, .142), (.70, .162), (.38, .176), (.08, .182))]
    b.profile("Opal shade" if timber else "Inspection glass", lens, gold, glass=True)
    if timber:
        for sign in (-1, 1):
            for j, width in enumerate((.153, .117, .064)):
                b.plate("Spun collar", 0, z + sign * (.128 + .021 * j), width, .030,
                        .098, .185 - .010 * j, gold, .008, .014)
        b.round("Lantern finial", 0, z - .194, .029, .035, .100, .148, gold, 16)
        for side in (-1, 1):
            b.beam("Shade stile", (.063 * side, z - .109), (.081 * side, z), .145, .161, .008, gold)
            b.beam("Shade stile", (.081 * side, z), (.063 * side, z + .109), .145, .161, .008, gold)
    else:
        for xx in (-.065, 0., .065):
            extent = .144 * math.sqrt(1 - (xx / .108) ** 2)
            parts = 8 if b.high else 6
            profiles = []
            for i in range(parts + 1):
                f = i / parts
                zz = extent * (2 * f - 1)
                d = .119 + .076 * math.sqrt(max(0., 1 - (xx / .108) ** 2 - (zz / .145) ** 2))
                profiles.append((zz + z, d))
            for (z0, d0), (z1, d1) in zip(profiles, profiles[1:]):
                pts = [(xx + x, zz, d + lift) for zz, d in ((z0, d0), (z1, d1))
                       for x, lift in ((-.005, -.004), (.005, -.004), (.005, .004), (-.005, .004))]
                faces = [(i, (i + 1) % 4, 4 + (i + 1) % 4, 4 + i) for i in range(4)]
                b.mesh("Curved guard", pts, [tuple(reversed(face)) for face in faces], dark)
        for zz in (-.117, .117):
            b.plate("Lamp guard strap", 0, z + zz, .142, .018, .147, .182, gold, .004, .006)
        for sx in (-1, 1):
            for sz in (-1, 1):
                b.round("Lens screw", .081 * sx, z + .128 * sz, .011, .011, .110, .124, dark, 6)


def boiler(b: Bay, service: bool, door: bool, has_exchanger: bool = False) -> None:
    b.shell(door, 4)
    # Twin supply mains are continuous even across the lintel.
    b.plate("Header web", 0, 3.68, 2, .64, .008, .039, 1, .007)
    for zz, radius, metal in ((3.52, .052, 3), (3.74, .071, 0)):
        b.pipe("Steam main", -1, 1, zz, .115, radius, metal)
        for x in (-.72, .72):
            b.plate("Pipe saddle foot", x, zz, .12, radius * 3, .026, .107, 1, .01, .01)
            b.pipe("Cast sleeve", x - .033, x + .033, zz, .115, radius + .009, 2)
        b.pipe("Rolled union lip", -.024, .024, zz, .115, radius + .014, 1)
    b.plate("Top angle", 0, 3.967, 2, .066, .029, .10, 0, .009)
    for x in (-.945, .945):
        b.plate("Rib foot", x, 1.68, .11, 3.36, .011, .065, 1, .008)
        b.plate("Rib nose", x, 1.68, .044, 3.36, .061, .095, 0, .008)
        for z in (.24, 1.0, 1.84, 2.66, 3.22):
            b.round("Web fastener", x, z, .019, .021, .09, .107, 2, 6)
    if door:
        for x in (-.85, .85):
            b.plate("Portal jamb", x, 1.23, .10, 2.46, .009, .116, 0, .011)
        b.plate("Cast lintel", 0, 2.47, 1.8, .14, .01, .12, 0, .012)
        b.plate("Lintel cover", 0, 2.92, 1.78, .69, .009, .047, 0, .012, .075)
        for x in (-.64, .64):
            for i in range(3):
                b.beam("Gusset flute", (x + .045 * i - .08, 2.67), (x + .045 * i + .08, 3.13), .046, .071, .021, 1)
        b.plate("Head badge", 0, 2.92, .33, .18, .045, .075, 2, .014, .07)
        b.plate("Badge inset", 0, 2.92, .218, .095, .075, .085, 1, .007, .04)
        for i, hh in enumerate((.022, .042, .063, .042, .022)):
            b.plate("Cast pressure mark", (i - 2) * .026, 2.92, .014, hh, .084, .092, 2, .003)
        return
    for z, h in ((.49, .88), (1.29, .64), (2.49, 1.66)):
        b.plate("Punched steel plate", 0, z, 1.785, h, .008, .046, 0, .01, .041)
        rivets(b, 0, z, 1.655, h - .12)
    b.plate("Kick channel", 0, .09, 2, .18, .045, .094, 1, .012)
    b.plate("Belt channel", 0, 1.63, 1.81, .065, .025, .078, 1, .008)
    if service:
        b.plate("Louver casting", 0, 2.07, 1.04, .68, .044, .104, 1, .018, .091)
        b.plate("Louver opening", 0, 2.07, .918, .56, .101, .116, 4, .012, .051)
        for i in range(7):
            z = 1.85 + .073 * i
            width = .829 if i in (0, 6) else .86
            # Sloping return on each hood catches warm light against an actual dark recess.
            shape = [(z - .019, .124), (z - .010, .157), (z + .016, .149), (z + .015, .111)]
            pts = [(x, zz, d) for x in (-width / 2, width / 2) for zz, d in shape]
            faces = [(i, (i + 1) % 4, 4 + (i + 1) % 4, 4 + i) for i in range(4)]
            faces += [(3, 2, 1, 0), (4, 5, 6, 7)]
            b.mesh("Louver blade", pts, [tuple(reversed(f)) for f in faces], 0, "h")
        for xx in (-.46, .46):
            for zz in (1.82, 2.32):
                b.round("Grille screw", xx, zz, .018, .018, .102, .113, 2, 6)
        practical(b, False)
    elif has_exchanger:
        exchanger(b)
    else:
        for x in (-.57, .57):
            b.plate("Pressed vertical stiffener", x, 2.46, .095, 1.28, .044, .070, 0, .012, .045)
        b.plate("Flush inspection cover", 0, .485, 1.05, .295, .044, .053, 0, .004, .025)
        for x in (-.455, .455):
            b.round("Countersunk fixing", x, .485, .012, .012, .051, .056, 1, 8)
        return
    for x in (-.49, .49):
        b.plate("Service door", x, .52, .76, .53, .045, .073, 1, .011, .035)
        for z in (.43, .57):
            b.plate("Vented stamping", x, z, .51, .042, .07, .087, 0, .008, .018)
        for zz in (.375, .657):
            b.plate("Lift-off hinge", x - .324, zz, .066, .102, .071, .094, 2, .008)
        b.round("Quarter-turn catch", x + .319, .514, .033, .033, .071, .094, 2, 10)
        b.plate("Catch cam", x + .319, .514, .014, .039, .093, .097, 1, .003)


def circuit(b: Bay, path: list[Point], radius: float, swatch: int) -> None:
    """Sweep the continuous return from the overhead tee, through six passes, into the wall flange."""
    centers = [Vector(v) for v in path]
    sides = 16 if b.high else 10
    points, faces = [], []
    for i, p in enumerate(centers):
        tangent = (centers[min(i + 1, len(centers) - 1)] - centers[max(i - 1, 0)]).normalized()
        # Keep the ring orientation continuous through horizontal, vertical and wall-normal segments.
        if i == 0:
            normal = tangent.cross(Vector((0, 0, 1))).normalized()
        else:
            normal = (normal - tangent * normal.dot(tangent)).normalized()
        cross = tangent.cross(normal)
        for j in range(sides):
            a = math.tau * j / sides
            points.append(tuple(p + radius * (normal * math.cos(a) + cross * math.sin(a))))
        if i:
            for j in range(sides):
                a, c = (i - 1) * sides + j, (i - 1) * sides + (j + 1) % sides
                faces.append((a, c, c + sides, a + sides))
    mesh = b.mesh("Continuous copper steam return", points, faces, swatch)
    for face in mesh.polygons:
        face.use_smooth = True


def exchanger(b: Bay) -> None:
    top, pitch, half, depth = 2.39, .20, .49, .169
    bottom = top - 5 * pitch
    b.plate("Exchanger mounting web", 0, 1.88, 1.52, 1.51, .047, .081, 1, .016, .09)
    for side in (-1, 1):
        x = side * .645
        for h in (1.25, 2.51):
            b.plate("Angle bracket foot", x, h, .205, .13, .078, .102, 2, .009, .022)
            b.plate("Casting saddle", x - side * .044, h, .073, .084, .100, .181, 1, .008)
            b.round("Bracket bolt", x + side * .053, h, .022, .022, .101, .119, 0, 6)
    for h in (1.25, 2.51):
        b.pipe("Tie rail", -.67, .67, h, .163, .026, 1)
        for x in (-.38, .38):
            b.plate("Tube sheet hanger", x, (h + (top if h > 2 else bottom)) / 2, .082,
                    abs(h - (top if h > 2 else bottom)) + .06, .122, .180, 1, .007)
    rail_x = -.742
    path = [(rail_x, 3.52, .115), (rail_x, 3.04, .115), (rail_x, 2.85, depth),
            (rail_x, top + .12, depth)]
    for k in range(1, 9):
        a = math.pi + math.pi / 2 * k / 8
        path.append((rail_x + .12 + .12 * math.cos(a), top + .12 + .12 * math.sin(a), depth))
    for i in range(6):
        z = top - i * pitch
        side = 1 if i % 2 == 0 else -1
        path.append((side * half, z, depth))
        if i < 5:
            arc_steps = 12 if b.high else 6
            for k in range(1, arc_steps + 1):
                a = math.pi * k / arc_steps
                path.append((side * (half + pitch / 2 * math.sin(a)),
                             z - pitch / 2 + pitch / 2 * math.cos(a), depth))
    path.append((rail_x + .12, bottom, depth))
    for k in range(1, 9):
        a = math.pi / 2 + math.pi / 2 * k / 8
        path.append((rail_x + .12 + .12 * math.cos(a), bottom - .12 + .12 * math.sin(a), depth))
    path.append((rail_x, 1.08, depth))
    for k in range(1, 9):
        a = math.pi / 2 * k / 8
        path.append((rail_x, 1.08 - .117 * math.sin(a), depth - .117 + .117 * math.cos(a)))
    path.append((rail_x, .963, .030))
    circuit(b, path, .039, 3)
    b.round("Return wall flange", rail_x, .963, .110, .110, .030, .060, 1, 24)
    for i in range(6):
        a = math.tau * i / 6
        b.round("Flange cap screw", rail_x + .079 * math.cos(a), .963 + .079 * math.sin(a),
                .012, .012, .057, .072, 2, 6)
    for h in (top, bottom):
        for x in (-.627, .457):
            b.pipe("Soldered header union", x - .021, x + .021, h, depth, .051, 2)
    b.pipe("Feed tee barrel", rail_x - .073, rail_x + .073, 3.52, .115, .065, 2)
    b.plate("Drop pipe clamp", rail_x, 2.98, .133, .085, .037, .16, 1, .01, .012)
    # Scallops reveal each copper pass from an oblique view. Rolled noses stiffen each cast fin.
    for side in (-1, 1):
        for index in range(6):
            x = side * (.084 + .063 * index)
            rings, points, faces = [], [], []
            heights = [bottom - .064, *(bottom + k * pitch / 2 for k in range(11)), top + .064]
            for k, z in enumerate(heights):
                wave = (.5 + .5 * math.cos(math.tau * (z - bottom) / pitch))
                front = .197 + .025 * wave
                if k in (0, len(heights) - 1):
                    front -= .023
                rings.append((z, front))
            for k, (z, front) in enumerate(rings):
                for xx, d in ((x - .012, .100), (x + .012, .100),
                              (x + .007, front), (x - .007, front)):
                    points.append((xx, z, d))
                if k:
                    for j in range(4):
                        a, c = (k - 1) * 4 + j, (k - 1) * 4 + (j + 1) % 4
                        faces.append((a + 4, c + 4, c, a))
            faces += [tuple(range(4)), tuple(reversed(range(len(points) - 4, len(points))))]
            b.mesh("Scalloped cast fin", points, faces, 0 if index % 3 == 0 else 1)
    b.plate("Foundry nameplate", 0, 2.51, .217, .085, .163, .199, 2, .010, .021)
    for i, h in enumerate((.019, .032, .048, .032, .019)):
        b.plate("Foundry stamp", (i - 2) * .023, 2.51, .009, h, .198, .202, 1, .002)


def exchanger_contacts(objects: list) -> dict:
    def surface(obj: bpy.types.Object) -> BVHTree:
        mesh = obj.data
        return BVHTree.FromPolygons([v.co for v in mesh.vertices], [list(f.vertices) for f in mesh.polygons])

    tube = next(o for o in objects if o.name.startswith("Continuous copper steam return"))
    tube_surface = surface(tube)
    fins = [o for o in objects if o.name.startswith("Scalloped cast fin")]
    assert len(fins) == 12 and all(tube_surface.overlap(surface(o)) for o in fins)
    for label in ("Feed tee barrel", "Return wall flange"):
        fitting = next(o for o in objects if o.name.startswith(label))
        assert tube_surface.overlap(surface(fitting)), label
    return {"steamPasses": 6, "connectedFins": len(fins), "mountingFeet": 4,
            "tubeContacts": ["overhead supply tee", "all 12 fin meshes", "wall return flange"]}


def casing(b: Bay, name: str, x: float, z: float, w: float, h: float, clip: float,
           base: float, swatch: int) -> None:
    # Four mitred rail and stile runs turn the grain with the joinery.
    layers = [(0, base), (.006, base + .024), (.018, base + .038), (.030, base + .039),
              (.044, base + .024), (.052, base + .026), (.063, base + .008)]
    rings = [(rect(x, z, w - 2 * inset, h - 2 * inset, max(.005, clip - inset * .58) if clip else 0), depth)
             for inset, depth in layers]
    n = len(rings[0][0])
    for i in range(n):
        j = (i + 1) % n
        pts = [(*outline[k], depth) for outline, depth in rings for k in (i, j)]
        faces = [(2 * k, 2 * k + 1, 2 * k + 3, 2 * k + 2) for k in range(len(layers) - 1)]
        p, q = rings[0][0][i], rings[0][0][j]
        grain = "h" if abs(q[0] - p[0]) > abs(q[1] - p[1]) else "v"
        b.mesh(name, pts, faces, swatch, grain)


def wood_panel(b: Bay, x: float, z: float, w: float, h: float, clip: float = .055) -> None:
    b.plate("Field tablet", x, z, w - .115, h - .115, .017, .054, 0, .024, max(.01, clip - .025))
    casing(b, "Ogee mitre", x, z, w, h, clip, .024, 2)


def fan(b: Bay, x: float, z: float, size: float) -> None:
    # Fan patera, with tapering reeded segments and a half-round brass boss.
    for i in range(9):
        a = math.radians(15 + 150 * i / 8)
        source = (x + .055 * size * math.cos(a), z + .055 * size * math.sin(a))
        target = (x + size * math.cos(a), z + size * .79 * math.sin(a))
        b.beam("Sunburst reed", source, target, .051, .067, .016, 2)
    b.round("Patera boss", x, z, .043, .041, .049, .081, 4, 12)


def timber(b: Bay, accent: bool, door: bool) -> None:
    b.shell(door, 1)
    # Entablature with a projecting cyma, fillet, fascia and dentil bed.
    for z, h, depth, color in ((3.95, .10, .174, 1), (3.879, .055, .144, 2),
                               (3.823, .07, .11, 0), (3.735, .121, .072, 1),
                               (3.638, .074, .105, 2)):
        b.plate("Cornice course", 0, z, 2, h, .01, depth, color, .010, grain="h")
    for i in range(12):
        b.plate("Cornice dentil", -.915 + i / 6, 3.753, .09, .095, .069, .099, 2, .004)
    for x in (-.951, .951):
        b.plate("Engaged pilaster", x, 1.8, .098, 3.60, .01, .083, 1, .008)
        for off in (-.021, .021):
            b.plate("Reeded pilaster", x + off, 1.78, .021, 3.20, .081, .094, 2, .006)
        for z, h, d in ((.095, .19, .108), (3.48, .18, .104), (3.584, .044, .116)):
            b.plate("Capital and plinth", x, z, .098, h, .012, d, 2, .009)
    if door:
        for x in (-.85, .85):
            b.plate("Door lining", x, 1.27, .10, 2.54, .012, .109, 1, .009)
            b.plate("Jamb bead", x, 1.245, .036, 2.49, .107, .128, 2, .006)
        for z, h, width, depth, color in ((2.446, .092, 1.80, .117, 1), (2.534, .084, 1.82, .103, 0),
                                         (2.588, .044, 1.84, .137, 2)):
            b.plate("Architrave", 0, z, width, h, .012, depth, color, .009, grain="h")
        wood_panel(b, 0, 3.100, 1.72, .83, .13)
        fan(b, 0, 3.01, .28)
        return
    for z, h, d, c in ((.075, .15, .085, 1), (.161, .032, .097, 2), (.191, .032, .065, 0),
                       (1.092, .12, .080, 1), (1.165, .045, .107, 2), (1.198, .024, .084, 0)):
        b.plate("Skirt and chair rail", 0, z, 2, h, .01, d, c, .008, grain="h")
    for x in (-.438, .438):
        wood_panel(b, x, .619, .807, .731, .04)
    if accent:
        wood_panel(b, 0, 2.375, 1.67, 2.22, .225)
        # A marquetry lozenge surrounds the sconce, filled with upright matched grain.
        cx, cz, w, h = 0., 2.5, .51, .82
        loop = [(cx, cz - h), (cx + w, cz), (cx, cz + h), (cx - w, cz)]
        for i in range(4):
            b.beam("Diamond inlay", loop[i], loop[(i + 1) % 4], .054, .059, .021, 2)
        fan(b, 0, 1.83, .18)
        practical(b, True)
    else:
        for x in (-.438, .438):
            wood_panel(b, x, 2.232, .807, 1.88, .112)
            b.plate("Upper field crest", x, 3.367, .804, .253, .017, .05, 0, .012, .038, "h")
            casing(b, "Crest mitre", x, 3.367, .829, .28, .05, .023, 2)


def vertex_ambient(objects: list, lit: bool) -> None:
    """Cosine-weighted ray-tested contact shading on the assembled kit, baked to COLOR_0."""
    coords, polygons = [], []
    for obj in objects:
        offset = len(coords)
        coords.extend(v.co.copy() for v in obj.data.vertices)
        polygons.extend([offset + j for j in face.vertices] for face in obj.data.polygons)
    tree = BVHTree.FromPolygons(coords, polygons)
    dome = []
    samples = 48
    for j in range(samples):
        q = (j + .5) / samples
        a = j * 2.39996323
        dome.append((math.sqrt(q) * math.cos(a), math.sqrt(q) * math.sin(a), math.sqrt(1 - q)))
    cache = {}
    for obj in objects:
        mesh = obj.data
        attr = mesh.color_attributes.new(name="Ambient", type="BYTE_COLOR", domain="CORNER")
        for poly in mesh.polygons:
            n = poly.normal
            axis = (Vector((1, 0, 0)) if abs(n.x) < .8 else Vector((0, 0, 1))).cross(n).normalized()
            other = n.cross(axis)
            for li in poly.loop_indices:
                p = mesh.vertices[mesh.loops[li].vertex_index].co
                # Sample just inside this face instead of on the seam shared with a neighbour.
                sample = p.lerp(poly.center, .012) + n * .0012
                key = tuple(round(v, 3) for v in (*sample, *n))
                color = cache.get(key)
                if color is None:
                    occlusion = 0.
                    for a, b, c in dome:
                        _, _, _, distance = tree.ray_cast(sample, a * axis + b * other + c * n, .4)
                        if distance is not None:
                            occlusion += max(0, 1 - distance / .4)
                    # Soft contact shading on the broad planar fields avoids baking false triangular dents.
                    strength = .33 if n.y < -.99 and poly.area > .007 else .76
                    ao = max(.38, 1 - strength * occlusion / samples)
                    base = ao * (.83 + .12 * n.z + .04 * min(1., max(0., p.z / 3.8)))
                    # Amber local bounce is anchored to a visible fitting, in linear colour.
                    pool = .36 * math.exp(-((p.x / .52) ** 2 + ((p.z - LAMP_Z) / .76) ** 2)) if lit else 0.
                    color = tuple(min(1., base + pool * v) for v in (1., .57, .23)) + (1.,)
                    cache[key] = color
                attr.data[li].color = color


def join(objects: list, name: str) -> bpy.types.Object:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    root = objects[0]
    root.name = name
    root.data.name = name
    return root


def layout(i: int) -> tuple:
    return (4.16, 0., 4.08) if NAMES[i] == "BoilerExchangerBay" else ((i % 3 - 1) * 2.08, 0., (1 - i // 3) * 4.08)


def shot(roots: list, path: Path) -> None:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = 1100, 758
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "JPEG"
    scene.render.image_settings.quality = 90
    scene.world.color = (.105, .095, .08)
    scene.view_settings.view_transform = "AgX"
    for i, obj in enumerate(roots):
        obj.location = layout(i)
    bpy.ops.object.camera_add(location=(.30, -16., 4.5))
    camera = bpy.context.object
    camera.rotation_euler = (Vector((0., 0., 4.05)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 12.1
    scene.camera = camera
    for name, pos, target, energy, size, col in (
        ("Warm window", (-3., -5., 8.1), (0, 0, 4.8), 600, 4.8, (1., .87, .74)),
        ("Broad fill", (3.6, -4.0, 3.9), (0, 0, 3.4), 270, 4., (1., .96, .90)),
        ("Lower fill", (-1.5, -4., 2.7), (0, 0, 2), 100, 3., (1., .84, .72))):
        light = bpy.data.lights.new(name, "AREA")
        light.energy, light.shape, light.size, light.color = energy, "DISK", size, col
        obj = bpy.data.objects.new(name, light)
        scene.collection.objects.link(obj)
        obj.location = pos
        obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()
    for row, style in enumerate(("boiler", "timber")):
        # One strip per style keeps the metre-wide details readable in review.
        for i, obj in enumerate(roots):
            obj.hide_render = obj.name.startswith("Timber") != bool(row)
        z = (1 - row) * 4.08 + 2
        cx = 1.04 if row == 0 else 0.
        camera.location = (cx + .90, -12, z + .38)
        camera.rotation_euler = (Vector((cx, 0, z)) - camera.location).to_track_quat("-Z", "Y").to_euler()
        camera.data.ortho_scale = 8.48 if row == 0 else 6.38
        scene.render.resolution_x = 1460 if row == 0 else 1100
        scene.render.filepath = str(path / (style + "-elevation.jpg"))
        bpy.ops.render.render(write_still=True)
    for obj in roots:
        obj.hide_render = obj.name != "BoilerExchangerBay"
    center = Vector((4.16, -.10, 6.04))
    camera.location = center + Vector((2.0, -4.4, .61))
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.ortho_scale = 2.66
    scene.render.resolution_x = 900
    scene.render.resolution_y = 930
    scene.render.filepath = str(path / "boiler-exchanger.jpg")
    bpy.ops.render.render(write_still=True)


def build(src: Path, destination: Path, texture_dir: Path, high: bool) -> tuple[list, dict]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.name = "Architectural Finishes"
    bpy.context.scene.world = bpy.data.worlds.new("Review world")
    mat = {name: finish_material(name, texture_dir) for name in ("Boiler", "Timber")}
    glass = bpy.data.materials.new("PracticalAmberGlass")
    glass.use_nodes = True
    glass.use_backface_culling = True
    p = glass.node_tree.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = (.96, .76, .40, 1)
    p.inputs["Roughness"].default_value = .28
    p.inputs["Emission Color"].default_value = (1., .64, .28, 1)
    p.inputs["Emission Strength"].default_value = 1.7
    roots, info = [], {}
    for i, name in enumerate(NAMES):
        wood = name.startswith("Timber")
        accent = name in ("BoilerServiceBay", "TimberCarvedBay")
        door = name.endswith("Door")
        bay = Bay(name, mat["Timber" if wood else "Boiler"], glass, high)
        if wood:
            timber(bay, accent, door)
        else:
            boiler(bay, accent, door, name == "BoilerExchangerBay")
        vertex_ambient(bay.objects, accent)
        if high:
            root = bpy.data.objects.new(name, None)
            bpy.context.scene.collection.objects.link(root)
            for obj in bay.objects:
                obj.parent = root
            root.location = layout(i)
        else:
            contacts = exchanger_contacts(bay.objects) if name == "BoilerExchangerBay" else {}
            root = join(bay.objects, name)
            mesh = root.data
            mesh.calc_loop_triangles()
            xmin = min(v.co.x for v in mesh.vertices)
            xmax = max(v.co.x for v in mesh.vertices)
            ymin = min(v.co.z for v in mesh.vertices)
            ymax = max(v.co.z for v in mesh.vertices)
            depth = max(-v.co.y for v in mesh.vertices)
            assert abs(xmin + 1) < .0001 and abs(xmax - 1) < .0001
            assert abs(ymin) < .0001 and abs(ymax - 4) < .0001 and depth <= (.24 if name == "BoilerExchangerBay" else .21)
            assert len(mesh.loop_triangles) <= (7500 if name == "BoilerExchangerBay" else 6000), (name, len(mesh.loop_triangles))
            if door:
                for tri in mesh.loop_triangles:
                    pts = [mesh.vertices[j].co for j in tri.vertices]
                    assert (all(v.x <= -.7999 for v in pts) or all(v.x >= .7999 for v in pts)
                            or all(v.z >= 2.3999 for v in pts)), name
            info[name] = {**contacts, "triangles": len(mesh.loop_triangles), "depthMeters": round(depth, 4),
                          "vertices": len(mesh.vertices), "materials": [m.name for m in mesh.materials]}
        roots.append(root)
    if not high:
        for i, obj in enumerate(roots):
            obj.location = layout(i)
    for area in bpy.context.screen.areas:
        if area.type == "VIEW_3D":
            view = area.spaces.active
            view.region_3d.view_rotation = Vector((0., 1., -.025)).to_track_quat("-Z", "Y")
            view.region_3d.view_perspective = "ORTHO"
            view.region_3d.view_distance = 12.4
            view.region_3d.view_location = (0, 0, 4.05)
            view.shading.type = "MATERIAL"
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(src / ("architectural-finishes_high.blend" if high else "architectural-finishes_low.blend")),
                                compress=True)
    if not high:
        bpy.ops.object.select_all(action="DESELECT")
        for root in roots:
            root.location = (0, 0, 0)
            root.select_set(True)
        bpy.ops.export_scene.gltf(filepath=str(destination), export_format="GLB", use_selection=True,
                                  export_yup=True, export_materials="EXPORT", export_vertex_color="ACTIVE",
                                  export_all_vertex_colors=False, export_attributes=False)
    return roots, info


def validate(path: Path) -> dict:
    data = path.read_bytes()
    n = int.from_bytes(data[12:16], "little")
    gltf = json.loads(data[20:20+n])
    names = {node.get("name") for node in gltf["nodes"]}
    assert names == set(NAMES), names
    for node in gltf["nodes"]:
        assert all(key not in node for key in ("matrix", "translation", "rotation", "scale")), node
    for material in gltf["materials"]:
        if material["name"] == "PracticalAmberGlass":
            assert max(material.get("emissiveFactor", [0])) > 0
        else:
            assert "baseColorTexture" in material["pbrMetallicRoughness"], material
            assert "metallicRoughnessTexture" in material["pbrMetallicRoughness"], material
            assert "normalTexture" in material, material
    assert all("bufferView" in image for image in gltf["images"])
    for mesh in gltf["meshes"]:
        for prim in mesh["primitives"]:
            assert {"NORMAL", "POSITION", "TEXCOORD_0", "COLOR_0"} <= prim["attributes"].keys(), prim
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path))
    imported = {obj.name for obj in bpy.context.scene.objects}
    assert imported == set(NAMES), imported
    for obj in bpy.context.scene.objects:
        mesh = obj.data
        coords = [v.co for v in mesh.vertices]
        assert all(math.isfinite(value) for v in coords for value in v)
        assert max(v.y for v in coords) <= .000001, obj.name
        assert abs(min(v.x for v in coords) + 1) < .0001 and abs(max(v.x for v in coords) - 1) < .0001
        assert abs(min(v.z for v in coords)) < .0001 and abs(max(v.z for v in coords) - 4) < .0001
        assert max(-v.y for v in coords) <= (.24 if obj.name == "BoilerExchangerBay" else .21)
        mesh.calc_loop_triangles()
        assert all(t.area > 1e-12 for t in mesh.loop_triangles), obj.name
        assert not any(all(abs(coords[i].y) < .000001 for i in tri.vertices)
                       for tri in mesh.loop_triangles), obj.name
        assert all(math.isfinite(u) and 0 <= u <= 1 for entry in mesh.uv_layers.active.data for u in entry.uv)
        if obj.name.endswith("Door"):
            for a, b in (((-.8, 0.), (-.8, 4.)), ((.8, 0.), (.8, 4.)),
                         ((-.8, 2.4), (.8, 2.4))):
                def contains(pts: list, p: tuple) -> bool:
                    return any(abs(v.x - p[0]) < .000001 and abs(v.y) < .000001
                               and abs(v.z - p[1]) < .000001 for v in pts)
                assert any(contains([coords[i] for i in tri.vertices], a)
                           and contains([coords[i] for i in tri.vertices], b)
                           for tri in mesh.loop_triangles), (obj.name, a, b)
            for tri in mesh.loop_triangles:
                pts = [coords[index] for index in tri.vertices]
                assert (all(v.x <= -.7999 for v in pts) or all(v.x >= .7999 for v in pts)
                        or all(v.z >= 2.3999 for v in pts)), obj.name
    return {"meshes": len(gltf["meshes"]), "materials": len(gltf["materials"]), "packedTextures": len(gltf["images"]),
            "runtimeBytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "reimport": "Seven identity roots, finite UV0 and coordinates, nonzero triangles, exact 2x4m bounds, clear portals, zero-plane contacts and no rear faces"}


def main() -> None:
    parser = argparse.ArgumentParser()
    project = Path(__file__).resolve().parents[2]
    parser.add_argument("--output-root", type=Path, default=project)
    parser.add_argument("--skip-review", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    root = args.output_root.resolve()
    source = root / "assets-source/props/architectural-finishes"
    source.mkdir(parents=True, exist_ok=True)
    target = root / "public/assets/props/architectural-finishes/architectural-finishes.glb"
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temp:
        temp_dir = Path(temp)
        staged = temp_dir / target.name
        build(source, staged, temp_dir, True)
        roots, info = build(source, staged, temp_dir, False)
        if not args.skip_review:
            shot(roots, source)
        report = validate(staged)
        target.write_bytes(staged.read_bytes())
    report.update({"blender": bpy.app.version_string, "nodes": info, "units": "metres", "front": "glTF +Z",
                   "dimensionsMeters": [2, 4], "source": "Original scripted geometry, cast finishes and wood-cut atlas derived from the project walnut",
                   "woodSource": "public/assets/materials/walnut/walnut.basecolor.png",
                   "inputsSha256": {str(f.relative_to(project)): hashlib.sha256(f.read_bytes()).hexdigest()
                                    for f in (Path(__file__).resolve(), Path(__file__).resolve().with_name("finish_surfaces.py"),
                                              project / "public/assets/materials/walnut/walnut.basecolor.png")},
                   "blendSha256": {f.name: hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(source.glob("*.blend"))},
                   "atlasPixels": [TILE * GRID[0], TILE * GRID[1]], "ambient": "48 cosine-weighted BVH rays per corner",
                   "pbr": "Embedded sRGB base colour, tangent-space normal and packed linear roughness/metallic",
                   "sourceRights": "Original geometry and procedural finishes. Walnut source approval and commercial-use record: assets-source/materials/README.md.",
                   "rebuild": "blender -b --factory-startup --python-exit-code 1 -P scripts/assets/build-architectural-finishes.py",
                   "ownerVisualApproval": "pending"})
    (source / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
