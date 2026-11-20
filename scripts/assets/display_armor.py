"""The Clockwork Spire's fluted parade harness. All dimensions in metres."""

from collections.abc import Callable, Sequence
from math import cos, sin, tau
from mathutils import Vector
import bpy

Obj = bpy.types.Object
Mat = bpy.types.Material
Point2 = tuple[float, float]
Point3 = tuple[float, float, float]


def build_display_armor(
    empty: Callable[..., Obj],
    cyl: Callable[..., Obj],
    mat_steel: Mat,
    brass: Mat,
    iron: Mat,
    lining: Mat,
    wood: Mat,
) -> Obj:
    def shell(
        parent: Obj,
        name: str,
        center: Point3,
        rings: Sequence[Point2],
        material: Mat = mat_steel,
        n: int = 20,
        flutes: float = 0.0,
        keel: float = 0.0,
        slope: float = 0.0,
    ) -> Obj:
        """Form curved sheet over unequal dies, with a front keel and scalloped lower rim."""
        vertices = []
        for z, rx, ry in rings:
            for i in range(n):
                a = tau * i / n
                f = max(0.0, cos(a))
                flute = 1 + flutes * (0.5 + 0.5 * cos(8 * a)) ** 2
                vertices.append(
                    (
                        center[0] + rx * sin(a) * flute,
                        center[1] - ry * cos(a) * flute - keel * f**9,
                        center[2] + z - slope * f**4,
                    )
                )
        faces = []
        for row in range(len(rings) - 1):
            for i in range(n):
                j, k = row * n + i, row * n + (i + 1) % n
                faces.append((j, k, k + n, j + n))
        faces.extend(
            [tuple(reversed(range(n))), tuple(range(len(vertices) - n, len(vertices)))]
        )
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(vertices, [], faces)
        mesh.update()
        ob = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(ob)
        ob.parent = parent
        mesh.materials.append(material)
        uv = mesh.uv_layers.new(name="UVMap")
        for face in mesh.polygons:
            side = face.index < len(faces) - 2
            face.use_smooth = side
            for j, li in enumerate(face.loop_indices):
                v = mesh.loops[li].vertex_index
                uv.data[li].uv = (
                    (
                        ((face.index % n) + int(j in (1, 2))) / n,
                        (vertices[v][2] - center[2]) * 2.8 + 0.14,
                    )
                    if side
                    else (vertices[v][0] * 2.8, vertices[v][1] * 2.8)
                )
        return ob

    def stud(parent: Obj, x: float, y: float, z: float, radius: float = 0.009) -> Obj:
        return cyl(parent, "Peened rivet", (x, y, z), radius, 0.009, brass, "Y", 10)

    def applique(
        parent: Obj,
        receiver: Obj,
        name: str,
        outlines: Sequence[Sequence[Point2]],
        material: Mat,
        rise: float = 0.0016,
    ) -> Obj:
        """Project the relief onto the curved metal; its high point follows the fitted face."""
        vertices, faces = [], []
        for outline in outlines:
            cx = sum(x for x, _ in outline) / len(outline)
            cz = sum(z for _, z in outline) / len(outline)
            base = len(vertices)
            for j, (x, z) in enumerate([(cx, cz), *outline]):
                hit, point, normal, _ = receiver.ray_cast(
                    Vector((x, -2, z)), Vector((0, 1, 0))
                )
                if not hit:
                    raise ValueError(f"{name} missed receiver at {(x, z)}")
                vertices.append(tuple(point + normal * (rise if j == 0 else 0.0006)))
            for j in range(len(outline)):
                face = (base, base + 1 + j, base + 1 + (j + 1) % len(outline))
                a, b, c = (Vector(vertices[i]) for i in face)
                if (b - a).cross(c - a).y > 0:
                    face = face[::-1]
                faces.append(face)
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(vertices, [], faces)
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        obj.parent = parent
        mesh.materials.append(material)
        return obj

    root = empty("ClockworkArmor")
    shell(
        root,
        "Octagonal display plinth",
        (0, 0, 0),
        [
            (0, 0.325, 0.268),
            (0.022, 0.325, 0.268),
            (0.042, 0.302, 0.247),
            (0.074, 0.302, 0.247),
            (0.088, 0.287, 0.234),
        ],
        wood,
        8,
    )
    shell(
        root,
        "Plinth band",
        (0, 0, 0),
        [(0.042, 0.304, 0.249), (0.049, 0.305, 0.25), (0.053, 0.302, 0.247)],
        brass,
        8,
    )
    cyl(root, "Exhibition stand", (0, 0.083, 0.78), 0.031, 1.43, iron)
    for s in (-1, 1):
        leg = (0.121 * s, 0, 0)
        # The front of each sabaton extends past the greave and carries four overlapping toe lames.
        shell(
            root,
            "Sole",
            (leg[0], -0.065, 0),
            [(0.087, 0.082, 0.145), (0.104, 0.084, 0.15), (0.124, 0.082, 0.147)],
            iron,
            16,
        )
        for i in range(4):
            shell(
                root,
                "Sabatons",
                (leg[0], -0.136 + 0.04 * i, 0),
                [
                    (0.102 + i * 0.004, 0.075, 0.068),
                    (0.123 + i * 0.009, 0.079, 0.067),
                    (0.139 + i * 0.016, 0.067, 0.051),
                ],
                n=14,
                keel=0.005,
            )
        shell(
            root,
            "Fluted greave",
            leg,
            [
                (0.146, 0.06, 0.067),
                (0.171, 0.069, 0.08),
                (0.32, 0.072, 0.094),
                (0.485, 0.092, 0.087),
                (0.578, 0.087, 0.081),
                (0.603, 0.081, 0.079),
            ],
            n=20,
            flutes=0.035,
            keel=0.014,
        )
        shell(
            root,
            "Greave lip",
            leg,
            [(0.569, 0.092, 0.085), (0.579, 0.093, 0.086), (0.585, 0.089, 0.083)],
            brass,
            20,
            keel=0.014,
        )
        shell(
            root,
            "Cuisses",
            leg,
            [
                (0.615, 0.076, 0.091),
                (0.68, 0.086, 0.1),
                (0.828, 0.111, 0.105),
                (0.935, 0.119, 0.111),
            ],
            n=16,
            flutes=0.025,
            keel=0.009,
        )
        for i in range(3):
            shell(
                root,
                "Knee articulation",
                (leg[0], -0.021, 0),
                [
                    (0.559 + i * 0.044, 0.086, 0.088),
                    (0.583 + i * 0.044, 0.099, 0.095),
                    (0.61 + i * 0.044, 0.079, 0.079),
                ],
                n=14,
                slope=0.014,
            )
        shell(
            root,
            "Poleyn fan",
            (leg[0], -0.066, 0),
            [
                (0.592, 0.05, 0.052),
                (0.624, 0.083, 0.07),
                (0.654, 0.11, 0.07),
                (0.688, 0.066, 0.052),
            ],
            n=14,
            keel=0.017,
            slope=0.008,
        )
        stud(root, leg[0] + s * 0.087, -0.069, 0.652, 0.013)
        # Each tasset hangs independently below the fauld and follows the upper thigh.
        for i in range(3):
            shell(
                root,
                "Tasset lame",
                (s * (0.118 - 0.005 * i), -0.061 + 0.012 * i, 0),
                [
                    (0.775 + 0.062 * i, 0.102 - 0.003 * i, 0.085),
                    (0.782 + 0.062 * i, 0.104 - 0.003 * i, 0.09),
                    (0.845 + 0.062 * i, 0.096 - 0.003 * i, 0.071),
                ],
                n=20,
                flutes=0.028,
                keel=0.008,
                slope=0.026,
            )
            stud(
                root, s * (0.125 + 0.066), -0.122 + 0.011 * i, 0.798 + 0.062 * i, 0.007
            )

    shell(
        root,
        "Arming doublet",
        (0, 0, 0),
        [
            (0.882, 0.163, 0.099),
            (1.086, 0.183, 0.126),
            (1.298, 0.206, 0.126),
            (1.431, 0.193, 0.108),
            (1.473, 0.098, 0.082),
        ],
        lining,
        24,
    )
    for i in range(3):
        shell(
            root,
            "Fauld lame",
            (0, 0, 0),
            [
                (0.922 + 0.051 * i, 0.222 - 0.009 * i, 0.147),
                (0.929 + 0.051 * i, 0.224 - 0.009 * i, 0.15),
                (0.986 + 0.051 * i, 0.201 - 0.01 * i, 0.128),
            ],
            n=24,
            slope=0.023,
        )
    # Breastplate has a narrow waist, full upper chest, beaten medial ridge and rolled neck.
    chest = shell(
        root,
        "Peascod breastplate",
        (0, 0, 0),
        [
            (1.058, 0.177, 0.119),
            (1.076, 0.186, 0.125),
            (1.169, 0.203, 0.153),
            (1.294, 0.253, 0.172),
            (1.387, 0.257, 0.151),
            (1.439, 0.203, 0.118),
            (1.466, 0.126, 0.096),
        ],
        n=48,
        flutes=0.035,
        keel=0.033,
        slope=0.023,
    )
    # The clockmaker's sunburst and split sprays are repousse set into the cuirass.
    rays = []
    for i in range(24):
        angle = tau * i / 24
        radius = 0.047 if i % 6 == 0 else 0.037 if i % 2 == 0 else 0.022
        rays.append((radius * sin(angle), 1.35 + radius * cos(angle)))
    applique(root, chest, "Sunburst badge", [rays], brass, 0.004)
    for sign in (-1, 1):

        def mirrored(poly: Sequence[Point2]) -> list[Point2]:
            return [(sign * x, z) for x, z in poly]

        leaves = [
            [(0.041, 1.345), (0.083, 1.328), (0.13, 1.333), (0.091, 1.332)],
            [(0.091, 1.332), (0.133, 1.345), (0.177, 1.379), (0.147, 1.35)],
            [(0.096, 1.335), (0.12, 1.362), (0.143, 1.374), (0.125, 1.35)],
            [(0.142, 1.349), (0.171, 1.354), (0.19, 1.364), (0.164, 1.358)],
        ]
        applique(root, chest, "Chased laurel", list(map(mirrored, leaves)), brass)
    shell(
        root,
        "Rolled waist",
        (0, 0, 0),
        [(1.054, 0.179, 0.122), (1.064, 0.185, 0.126), (1.073, 0.181, 0.124)],
        brass,
        20,
        keel=0.027,
        slope=0.023,
    )
    for i in range(2):
        shell(
            root,
            "Gorget overlap",
            (0, -0.003, 0),
            [
                (1.422 + i * 0.047, 0.183 - i * 0.046, 0.127 - i * 0.022),
                (1.435 + i * 0.047, 0.188 - i * 0.046, 0.13 - i * 0.022),
                (1.493 + i * 0.047, 0.118 - i * 0.017, 0.105 - i * 0.015),
            ],
            n=24,
            keel=0.009,
            slope=0.039 - i * 0.019,
        )
    for s in (-1, 1):
        for i in range(3):
            stud(
                root,
                s * (0.157 + 0.029 * i),
                -0.123 + 0.023 * i,
                1.427 - 0.012 * i,
                0.006,
            )
        arm = empty(
            "ClockworkArmor_%sArm" % ("Left" if s < 0 else "Right"),
            root,
            (s * 0.283, 0, 1.423),
        )
        shell(
            arm,
            "Sleeve",
            (s * 0.038, 0, 0),
            [
                (-0.332, 0.057, 0.065),
                (-0.194, 0.071, 0.08),
                (-0.027, 0.082, 0.085),
                (0.044, 0.073, 0.077),
            ],
            lining,
            16,
        )
        for i in range(3):
            shell(
                arm,
                "Pauldron lame",
                (s * (0.034 - 0.008 * i), 0, 0),
                [
                    (-0.143 + 0.061 * i, 0.103 + 0.004 * i, 0.105 + 0.007 * i),
                    (-0.133 + 0.061 * i, 0.107 + 0.004 * i, 0.111 + 0.007 * i),
                    (-0.073 + 0.061 * i, 0.092 + 0.003 * i, 0.096 + 0.006 * i),
                ],
                n=20,
                flutes=0.028,
                slope=0.012,
            )
        shell(
            arm,
            "Fluted pauldron",
            (s * 0.008, 0, 0),
            [
                (-0.012, 0.135, 0.143),
                (0.004, 0.136, 0.145),
                (0.066, 0.111, 0.12),
                (0.112, 0.062, 0.075),
                (0.128, 0.006, 0.013),
            ],
            n=32,
            flutes=0.054,
            keel=0.007,
        )
        shell(
            arm,
            "Pauldron rolled hem",
            (s * 0.008, 0, 0),
            [(-0.016, 0.135, 0.143), (-0.009, 0.138, 0.146), (-0.003, 0.135, 0.143)],
            brass,
            32,
            flutes=0.054,
        )
        shell(
            arm,
            "Rerebrace",
            (s * 0.055, 0, 0),
            [(-0.288, 0.056, 0.065), (-0.27, 0.066, 0.077), (-0.131, 0.078, 0.081)],
            n=20,
            flutes=0.027,
        )
        shell(
            arm,
            "Couter",
            (s * 0.065, -0.004, 0),
            [
                (-0.348, 0.06, 0.072),
                (-0.325, 0.081, 0.082),
                (-0.301, 0.087, 0.087),
                (-0.266, 0.062, 0.072),
            ],
            n=14,
            keel=0.022,
            slope=0.011,
        )
        stud(arm, s * 0.073, -0.101, -0.315, 0.012)
        shell(
            arm,
            "Tapered vambrace",
            (s * 0.075, -0.009, 0),
            [
                (-0.515, 0.046, 0.057),
                (-0.499, 0.052, 0.059),
                (-0.405, 0.064, 0.069),
                (-0.345, 0.067, 0.071),
                (-0.335, 0.062, 0.067),
            ],
            n=20,
            flutes=0.03,
            keel=0.012,
        )
        shell(
            arm,
            "Gauntlet bell",
            (s * 0.078, -0.018, 0),
            [(-0.551, 0.056, 0.062), (-0.527, 0.051, 0.054), (-0.496, 0.061, 0.067)],
            n=20,
            slope=0.011,
        )
        for i in range(4):
            shell(
                arm,
                "Finger lames",
                (s * 0.079, -0.029, 0),
                [
                    (-0.628 + 0.024 * i, 0.043 + 0.004 * i, 0.044 + 0.003 * i),
                    (-0.619 + 0.024 * i, 0.046 + 0.004 * i, 0.05 + 0.003 * i),
                    (-0.598 + 0.024 * i, 0.043 + 0.004 * i, 0.047 + 0.003 * i),
                ],
                n=12,
                slope=0.008,
            )
        shell(
            arm,
            "Thumb plate",
            (s * 0.034, -0.045, 0),
            [(-0.596, 0.023, 0.028), (-0.578, 0.027, 0.033), (-0.55, 0.023, 0.025)],
            n=12,
        )
        for i in range(3):
            stud(arm, s * 0.095, -0.101 - i * 0.004, -0.116 + i * 0.059, 0.006)

    head = empty("ClockworkArmor_Head", root, (0, 0, 1.574))
    shell(
        head,
        "Sallet skull",
        (0, 0.023, 0),
        [
            (-0.025, 0.121, 0.122),
            (0.035, 0.14, 0.151),
            (0.126, 0.147, 0.147),
            (0.191, 0.128, 0.127),
            (0.24, 0.087, 0.081),
            (0.271, 0.005, 0.008),
        ],
        n=32,
        keel=0.009,
    )
    shell(
        head,
        "Aventail",
        (0, 0.046, 0),
        [(-0.048, 0.151, 0.125), (-0.021, 0.146, 0.131), (0.058, 0.126, 0.118)],
        n=16,
        slope=0.016,
    )
    visor = empty("ClockworkArmor_Visor", head, (-0.14, -0.08, 0.17))
    # Lower and upper shell terminate on separate bevels. The recessed black sight line remains
    # visible from both the front and side when the visor is shut.
    c = (0.14, 0.044, -0.17)
    shell(
        visor,
        "Sight recess",
        c,
        [(0.035, 0.143, 0.142), (0.085, 0.148, 0.15), (0.118, 0.139, 0.144)],
        lining,
        24,
        keel=0.02,
    )
    faceplate = shell(
        visor,
        "Visor prow",
        c,
        [
            (-0.037, 0.059, 0.067),
            (-0.007, 0.105, 0.128),
            (0.036, 0.135, 0.153),
            (0.074, 0.147, 0.159),
            (0.082, 0.145, 0.157),
        ],
        n=24,
        keel=0.033,
        slope=0.025,
    )
    shell(
        visor,
        "Visor peak",
        c,
        [
            (0.105, 0.148, 0.161),
            (0.113, 0.15, 0.163),
            (0.132, 0.142, 0.15),
            (0.165, 0.128, 0.129),
        ],
        n=24,
        keel=0.027,
        slope=0.025,
    )
    shell(
        visor,
        "Peak bead",
        c,
        [(0.109, 0.151, 0.164), (0.115, 0.151, 0.164), (0.12, 0.148, 0.16)],
        brass,
        32,
        keel=0.027,
        slope=0.025,
    )
    for s in (-1, 1):
        cyl(
            head,
            "Visor hinge",
            (s * 0.145, -0.019, 0.085),
            0.019,
            0.014,
            brass,
            "X",
            16,
        )
        slits = []
        for i in range(4):
            x = 0.14 + s * (0.042 + 0.017 * i)
            z = -0.17 + 0.025 + i * 0.004
            slits.append(
                [
                    (x - 0.0038, z + 0.012),
                    (x + 0.002, z + 0.014),
                    (x + 0.0044, z + 0.01),
                    (x + 0.002, z - 0.012),
                    (x - 0.003, z - 0.013),
                    (x - 0.004, z - 0.008),
                ]
            )
        applique(visor, faceplate, "Visor breaths", slits, lining, 0.0009)
    return root
