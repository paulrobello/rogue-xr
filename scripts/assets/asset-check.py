"""Asset gate (`make asset-check`): presence, hashes against provenance, and PRD budgets for
every runtime room template under public/assets/rooms/<template>/ and every rigged enemy under
public/assets/enemies/<id>/ (`--assemble-enemy <id>` writes an enemy's provenance, then checks). Standard library only and reads
committed files, so it runs without Blender.

    python3 -I scripts/assets/asset-check.py                      # check every room
    python3 -I scripts/assets/asset-check.py --assemble study     # write provenance, then check

Provenance (assets-source/rooms/<template>/provenance.json) is assembled from the generator's
build report and the clean reimport report; it never records an approval.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import math
import runpy
import struct
import sys
from collections.abc import Callable
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ARCHITECTURAL_RUNTIME = ROOT / "public/assets/props/architectural-finishes"
ARCHITECTURAL_SOURCE = ROOT / "assets-source/props/architectural-finishes"
RUNTIME = ROOT / "public/assets/rooms"
SOURCES = ROOT / "assets-source/rooms"
LIMITS = {"tris": 100_000, "materials": 16, "texture_px": 2048, "light_sockets": 4}
LIGHTMAP_SIZES = {1024, 2048}
KTX2_MAGIC = b"\xabKTX 20\xbb\r\n\x1a\n"
KHR_DF_TRANSFER_LINEAR, KHR_DF_TRANSFER_SRGB = 1, 2
# Generator and the helpers it imports; provenance pins their hashes.
_KIT_DEPS = ["scripts/assets/build-room-kit.py", "scripts/assets/room_kit.py", "scripts/assets/build-room-study.py",
             "scripts/assets/lightmap_helpers.py", "scripts/assets/build-cog-sentry.py", "scripts/assets/room_panels.py"]
GENERATOR_DEPS = {"study": ["scripts/assets/build-room-study.py", "scripts/assets/lightmap_helpers.py", "scripts/assets/room_panels.py"],
                  "hall": _KIT_DEPS, "corridor": _KIT_DEPS,
                  "gear-shaft": _KIT_DEPS, "guardian-vault": _KIT_DEPS}
_KIT_REFERENCES = ["assets-source/style/locked/L-board-1.png", "assets-source/style/locked/L-study.png", "assets-source/concepts/room-sheet-1.png"]
REFERENCES = {
    "study": [
        "assets-source/concepts/room-sheet-1.png",
        "assets-source/concepts/room-sheet-2.png",
    ],
    "hall": _KIT_REFERENCES,
    "corridor": _KIT_REFERENCES,
    "gear-shaft": _KIT_REFERENCES,
    "guardian-vault": _KIT_REFERENCES,
}
REFERENCE_NOTES = {
    "study": "P4-T2 concept sheets; room-sheet-1 picked (docs/art-bible.md)",
    "hall": "kit language only (approved art bible board, L-study and the study's room-sheet-1); no hall concept sheet exists",
    "corridor": "kit language only (approved art bible board, L-study and the study's room-sheet-1); no corridor concept sheet exists",
    "gear-shaft": "kit language only (approved art bible board, L-study and the study's room-sheet-1); no gear-shaft concept sheet exists",
    "guardian-vault": "kit language only (approved art bible board, L-study and the study's room-sheet-1); no guardian-vault concept sheet exists",
}
_KIT_GATES = [
    {"who": "Paul", "when": "2026-11-16", "gate": "concept", "status": "approved", "evidence": "Paul, 2026-11-16, in the rogue-xr session: \"yes to all Quick picks\" (D10: accept the rooms as built in the study-kit language, no new room concept sheets)"},
    {"gate": "technical", "status": "pending", "notes": "validate-generated-assets verdict is reported to the orchestrator, not self-recorded"},
    {"gate": "creative", "status": "pending", "notes": "review sheet assets-source/rooms/{t}/staging/review-sheet.jpg"},
    {"gate": "rights", "status": "pending", "notes": "original procedural geometry; shared P4-T3 sets carry their own provenance"},
    {"gate": "owner", "status": "pending", "notes": "in-engine look approval (docs/blender-kit-project.md ruling 3)"},
    {"gate": "independent visual score", "status": "unscored", "notes": "blender-kit-pieces requires an independent >= 80/100 score; unscored means unaccepted"},
]
_REST_ROOM = "Paul, 2026-11-16, in the rogue-xr session: \"the rest room is approved except the contents of the hearth look very flat add more detail\" (the rest room is the hall template; the hearth is src/world/hearth.ts)"
APPROVALS = {
    "study": [
        {"who": "Paul", "when": "2026-11-15", "gate": "concept", "status": "approved", "evidence": "docs/art-bible.md: room-sheet-1.png picked for the hero study"},
        {"gate": "creative", "status": "pending", "notes": "review sheet assets-source/rooms/study/staging/review-sheet.jpg"},
        {"gate": "owner", "status": "pending", "notes": "in-engine look approval (P4-T10)"},
    ],
    "hall": [{"who": "Paul", "when": "2026-11-16", "gate": g["gate"], "status": "approved", "evidence": _REST_ROOM}
             if g["gate"] in ("creative", "owner") else {**g, "notes": g["notes"].format(t="hall")} if "notes" in g else g
             for g in _KIT_GATES],
    "corridor": [{**g, "notes": g["notes"].format(t="corridor")} if "notes" in g else g for g in _KIT_GATES],
    "gear-shaft": [{**g, "notes": g["notes"].format(t="gear-shaft")} if "notes" in g else g for g in _KIT_GATES],
    "guardian-vault": [{**g, "notes": g["notes"].format(t="guardian-vault")} if "notes" in g else g for g in _KIT_GATES],
}
BLEND_STORE_NOTE = {"study": "PRD project file section 1.5"}
# Templates that must ship named rigid animated nodes (manifest rigidNodes).
RIGID_REQUIRED = {"gear-shaft": {"gear-shaft_gear_ring", "gear-shaft_gear_counter"}}
# Panels every template door carries (scripts/assets/room_panels.py SLOT_PANELS["door"]).
DOOR_PANELS = ("door-frame", "door-plug")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def glb_json(path: Path) -> dict:
    data = path.read_bytes()
    magic, version, _length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2:
        raise ValueError(f"{path.name}: not a glTF 2 binary")
    chunk_len, chunk_type = struct.unpack_from("<I4s", data, 12)
    if chunk_type != b"JSON":
        raise ValueError(f"{path.name}: first chunk is not JSON")
    return json.loads(data[20 : 20 + chunk_len])


def glb_stats(path: Path) -> dict:
    g = glb_json(path)
    tris = 0
    missing_uv1 = []
    for mesh in g.get("meshes", []):
        for i, prim in enumerate(mesh["primitives"]):
            if prim.get("mode", 4) != 4:
                raise ValueError(f"{path.name}: primitive {mesh.get('name')}#{i} is not triangles")
            count = g["accessors"][prim["indices"]]["count"] if "indices" in prim else g["accessors"][prim["attributes"]["POSITION"]]["count"]
            tris += count // 3
            if "TEXCOORD_1" not in prim["attributes"]:
                missing_uv1.append(f"{mesh.get('name')}#{i}")
    return {
        "triangles": tris,
        "materials": [m.get("name", "") for m in g.get("materials", [])],
        "images": len(g.get("images", [])),
        "textures": len(g.get("textures", [])),
        "missing_uv1": missing_uv1,
    }


def check_alchemy(errors: list[str]) -> None:
    source = ROOT / "assets-source/props/alchemy-kit"
    runtime = ROOT / "public/assets/props/alchemy-kit/alchemy-kit.glb"
    manifest = json.loads((source / "manifest.json").read_text())
    for path, key in [(runtime, "glb_sha256"), (source / "alchemy-kit.blend", "source_blend_sha256"),
                      (ROOT / "scripts/assets/build-alchemy-kit.py", "generator_sha256")]:
        if sha256(path) != manifest[key]:
            errors.append(f"Conservatory asset hash mismatch: {path.name}")
    glb = glb_json(runtime)
    missing = set(manifest["roots"]) - {n.get("name") for n in glb["nodes"]}
    if missing:
        errors.append(f"Conservatory GLB missing parts: {sorted(missing)}")
    if any("normalTexture" not in m or "baseColorTexture" not in m.get("pbrMetallicRoughness", {})
           for m in glb["materials"]):
        errors.append("Conservatory material is missing authored albedo or surface relief")
    for portrait in json.loads((source / "portraits/manifest.json").read_text())["assets"]:
        if sha256(source / "portraits" / portrait["source"]) != portrait["sourceSha256"] or \
                sha256(ROOT / portrait["runtime"]) != portrait["runtimeSha256"]:
            errors.append(f"Conservatory portrait hash mismatch: {portrait['name']}")


def check_mechanism_kit(errors: list[str], kit: str) -> None:
    source = ROOT / "assets-source/props" / kit
    runtime = ROOT / "public/assets/props" / kit / f"{kit}.glb"
    manifest = json.loads((source / "manifest.json").read_text())
    for path, key in [(runtime, "glb_sha256"), (source / f"{kit}.blend", "source_blend_sha256"),
                      (ROOT / "scripts/assets" / f"build-{kit}.py", "generator_sha256")]:
        if sha256(path) != manifest[key]:
            errors.append(f"{kit} asset hash mismatch: {path.name}")
    glb = glb_json(runtime)
    names = {n.get("name") for n in glb["nodes"]}
    if set(manifest["root_nodes"] + manifest.get("socket_nodes", [])) - names:
        errors.append(f"{kit} GLB is missing an authored root or socket")
    if any("normalTexture" not in material or "metallicRoughnessTexture" not in material["pbrMetallicRoughness"]
           or "baseColorTexture" not in material["pbrMetallicRoughness"] for material in glb["materials"]):
        errors.append(f"{kit} materials require embedded color, roughness and normal textures")


def check_stairwell(errors: list[str]) -> None:
    source = ROOT / "assets-source/props/stairwell"
    path = ROOT / "public/assets/props/stairwell/stairwell.glb"
    report = json.loads((source / "report.json").read_text())
    gltf = glb_json(path)
    if report["sha256"] != sha256(path) or report["bytes"] != path.stat().st_size:
        errors.append("stairwell: runtime revision and report disagree")
    for name, expected in report["files_sha256"].items():
        if sha256(ROOT / name) != expected:
            errors.append(f"stairwell: changed source or artifact {name}")
    nodes = gltf["nodes"]
    roots = [nodes[i] for i in gltf["scenes"][gltf.get("scene", 0)]["nodes"]]
    if {n["name"] for n in roots} != {"StairUp", "StairDown"} or len(roots) != 2:
        errors.append("stairwell: both directional roots are required")
    for root in roots:
        pending = list(root.get("children", []))
        descendants = []
        while pending:
            node = nodes[pending.pop()]
            descendants.append(node)
            pending.extend(node.get("children", []))
        meshes = [gltf["meshes"][n["mesh"]] for n in descendants if "mesh" in n]
        triangles = sum(gltf["accessors"][p["indices"]]["count"] // 3
                        for mesh in meshes for p in mesh["primitives"])
        recorded = report["roots"][root["name"]]
        if triangles != recorded["triangles"] or not 0 < triangles <= 12000 or len(meshes) != recorded["mesh_count"] or not 1 <= len(meshes) <= 10:
            errors.append(f"stairwell: invalid mesh budget for {root['name']}")
        pivot = next((n for n in descendants if n["name"] == root["name"] + "_DoorPivot"), {})
        if root["name"] + "_HandleSocket" not in [nodes[i]["name"] for i in pivot.get("children", [])]:
            errors.append(f"stairwell: missing hinged door handle in {root['name']}")
    reveal = next((m for m in gltf["materials"] if m.get("name") == "Stairwell dark recess"), {})
    if ("KHR_materials_unlit" not in reveal.get("extensions", {})
            or reveal.get("pbrMetallicRoughness", {}).get("baseColorFactor") != [0, 0, 0, 1]):
        errors.append("stairwell: door reveal must export as opaque, unlit black")
    if len(gltf["materials"]) != 7 or any("bufferView" not in image for image in gltf["images"]):
        errors.append("stairwell: expected seven materials and embedded texture maps")
    print(f"asset-check props/stairwell: {len(roots)} directional flights, {path.stat().st_size} bytes")


def check_hidden_panel(errors: list[str]) -> None:
    source = ROOT / "assets-source/props/panel-kit"
    runtime = ROOT / "public/assets/props/panel-kit/panel-kit.glb"
    manifest = json.loads((source / "manifest.json").read_text())
    for path, field in [(runtime, "glb_sha256"), (source / "panel-kit.blend", "source_blend_sha256"),
                        (ROOT / "scripts/assets/build-panel-kit.py", "generator_sha256")]:
        if sha256(path) != manifest[field]:
            errors.append(f"Service panel hash mismatch: {path.name}")
    glb = glb_json(runtime)
    if set(manifest["root_nodes"]) - {n.get("name") for n in glb["nodes"]}:
        errors.append("Missing service-panel controls")
    if any("normalTexture" not in m or "baseColorTexture" not in m.get("pbrMetallicRoughness", {})
           for m in glb["materials"]):
        errors.append("Service panel material lacks color or relief texture")
    sounds = json.loads((ROOT / "assets-source/audio/panel-knocks/manifest.json").read_text())
    if sha256(ROOT / sounds["generator"]) != sounds["generatorSha256"]:
        errors.append("Service-panel sound generator hash mismatch")
    for clip in sounds["clips"]:
        if sha256(ROOT / "public/assets/audio/sfx" / (clip["id"] + ".ogg")) != clip["sha256"]:
            errors.append(f"Service-panel sound hash mismatch: {clip['id']}")


def check_stone_dungeon(errors: list[str]) -> None:
    source = ROOT / "assets-source/props/stone-dungeon-kit"
    runtime = ROOT / "public/assets/props/stone-dungeon-kit/stone-dungeon-kit.glb"
    try:
        report = json.loads((source / "staging/report.json").read_text())
        glb = glb_json(runtime)
        for path, key in (
            (runtime, "staged_glb"),
            (source / "stone-dungeon-kit.blend", "blend"),
            (ROOT / "scripts/assets/build-stone-dungeon.py", "generator"),
        ):
            if sha256(path) != report["sha256"][key]:
                errors.append(f"Stone dungeon {key} hash mismatch")
        roots = {glb["nodes"][index]["name"] for index in glb["scenes"][glb.get("scene", 0)]["nodes"]}
        expected = {
            "StoneBay", "StoneDoor", "StoneNicheBay", "StoneFloor", "StoneCeiling",
            "StoneSkylight", "StoneShelf", "StoneTorch", "StonePlanter", "StoneDishes",
        }
        if roots != expected or roots != set(report["roots"]):
            errors.append(f"Stone dungeon roots differ from the modular contract: {sorted(roots)}")
        nodes = {node.get("name") for node in glb["nodes"]}
        sockets = {"SocketShelfDish", "SocketShelfPlant", "SocketTorchLight"}
        if not sockets | {"StoneTorchFlame"} <= nodes or sockets != set(report["sockets"]):
            errors.append("Stone dungeon is missing an authored prop socket or the flame root")
        counts = []
        for mesh in glb["meshes"]:
            for primitive in mesh["primitives"]:
                attrs = primitive["attributes"]
                if primitive.get("mode", 4) != 4 or not {"POSITION", "NORMAL", "TEXCOORD_0"} <= attrs.keys():
                    errors.append("Stone dungeon mesh is missing triangle topology or required attributes")
                counts.append(glb["accessors"][primitive.get("indices", attrs["POSITION"])]["count"] // 3)
        total = sum(counts)
        if total > 28000 or total != report["triangles"] or runtime.stat().st_size > 3 * 1024 * 1024:
            errors.append(f"Stone dungeon exceeds its transfer or triangle contract ({total} triangles)")
        if not glb["images"] or any("bufferView" not in image or "uri" in image for image in glb["images"]):
            errors.append("Stone dungeon requires self-contained embedded material maps")
        print(f"asset-check props/stone-dungeon-kit: {len(roots)} modules, {total} tris, {runtime.stat().st_size} bytes")
    except (OSError, ValueError, KeyError, IndexError, TypeError) as exc:
        errors.append(f"Stone dungeon kit is invalid: {exc}")


def check_architectural_finishes(errors: list[str]) -> dict:
    """Check the reusable boiler/timber finish kit and its source chain."""
    err = lambda msg: errors.append(f"props/architectural-finishes: {msg}")  # noqa: E731
    report_path = ARCHITECTURAL_SOURCE / "report.json"
    glb_path = ARCHITECTURAL_RUNTIME / "architectural-finishes.glb"
    summary: dict = {}
    if not report_path.exists() or not glb_path.exists():
        if not report_path.exists():
            err("report.json missing")
        if not glb_path.exists():
            err("architectural-finishes.glb missing")
        return summary
    report = json.loads(report_path.read_text())
    try:
        g = glb_json(glb_path)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        err(f"invalid GLB: {exc}")
        return summary

    scene = g.get("scenes", [])[g.get("scene", 0)] if g.get("scenes") else {}
    roots = scene.get("nodes", [])
    names = [g.get("nodes", [])[i].get("name") for i in roots if i < len(g.get("nodes", []))]
    expected_names = sorted(("BoilerBay", "BoilerServiceBay", "BoilerExchangerBay", "BoilerDoor", "TimberBay", "TimberCarvedBay", "TimberDoor", "EncounterDoorLeaf"))
    if sorted(names) != expected_names:
        err(f"GLB must expose the named roots {expected_names}, got {names}")
    if any(i >= len(g.get("nodes", [])) for i in roots):
        err("scene root index is outside nodes")

    triangles = 0
    per_root: dict[str, int] = {}
    for i in roots:
        if i >= len(g.get("nodes", [])):
            continue
        node = g["nodes"][i]
        if node.get("children") or any(k in node for k in ("translation", "rotation", "scale", "matrix")):
            err(f"root {node.get('name')} must be an identity, childless mesh node")
        if "mesh" not in node or node["mesh"] >= len(g.get("meshes", [])):
            err(f"root {node.get('name')} must reference one mesh")
            continue
        count = 0
        for prim in g["meshes"][node["mesh"]].get("primitives", []):
            if prim.get("mode", 4) != 4 or "POSITION" not in prim.get("attributes", {}):
                err(f"root {node.get('name')} has non-triangle or position-less geometry")
                continue
            if not {"NORMAL", "TEXCOORD_0", "COLOR_0"} <= prim["attributes"].keys():
                err(f"{node.get('name')} lacks shading normal, atlas UV or baked vertex color")
            count += g["accessors"][prim.get("indices", prim["attributes"]["POSITION"])]["count"] // 3
            pos = g["accessors"][prim["attributes"]["POSITION"]]
            if any(len(pos.get(k, [])) != 3 for k in ("min", "max")):
                err(f"root {node.get('name')} POSITION accessor lacks bounds")
        name = node.get("name", f"root-{i}")
        per_root[name] = count
        triangles += count
        if count > 7_000:
            err(f"{name} has {count} triangles over the 7000-per-root budget")
    if triangles > 20_000:
        err(f"{triangles} triangles over the 20000-kit budget")
    if per_root and any(per_root.get(n) != report.get("nodes", {}).get(n, {}).get("triangles") for n in per_root):
        err(f"report node triangle counts do not match measured geometry: {per_root}")
    summary["triangles"] = triangles
    summary["roots"] = len(roots)

    # Every image must be embedded in the GLB, and every textured finish must provide portable PBR maps.
    images = g.get("images", [])
    if len(images) != 6 or any("bufferView" not in image or not image.get("mimeType", "").startswith("image/") for image in images):
        err("GLB must contain six embedded image textures")
    if len(g.get("textures", [])) != 6 or any("source" not in texture for texture in g.get("textures", [])):
        err("GLB texture table must contain six embedded sources")
    for material in g.get("materials", []):
        pbr = material.get("pbrMetallicRoughness", {})
        if "baseColorTexture" not in pbr and "baseColorFactor" not in pbr:
            err(f"material {material.get('name')} lacks base colour PBR input")
        if "metallicRoughnessTexture" not in pbr and "metallicFactor" not in pbr:
            err(f"material {material.get('name')} lacks metallic/roughness PBR input")
        if material.get("name") != "PracticalAmberGlass" and "normalTexture" not in material:
            err(f"material {material.get('name')} lacks tangent normal map")
    if len(g.get("materials", [])) > 3:
        err("more than three material slots")

    bounds = [g["accessors"][p["attributes"]["POSITION"]] for mesh in g.get("meshes", []) for p in mesh.get("primitives", [])]
    mins = [min(a["min"][axis] for a in bounds) for axis in range(3)] if bounds else []
    maxs = [max(a["max"][axis] for a in bounds) for axis in range(3)] if bounds else []
    if not bounds or mins[0] < -1.001 or maxs[0] > 1.001 or mins[1] < -0.001 or maxs[1] > 4.001 or mins[2] < -0.251 or maxs[2] > 0.251:
        err(f"geometry exceeds the 2x4m, 0.5m-depth placement envelope: {mins}..{maxs}")

    if report.get("sha256") != sha256(glb_path):
        err("report sha256 differs from runtime GLB")
    if set(report.get("inputsSha256", {})) != {"scripts/assets/build-architectural-finishes.py", "scripts/assets/finish_surfaces.py", "public/assets/materials/walnut/walnut.basecolor.png"}:
        err("generator and texture input hashes are required")
    if set(report.get("blendSha256", {})) != {"architectural-finishes_high.blend", "architectural-finishes_low.blend"}:
        err("high and low Blender source hashes are required")
    for rel, recorded in report.get("inputsSha256", {}).items():
        path = ROOT / rel
        if not path.exists() or sha256(path) != recorded:
            err(f"source input hash differs or file is missing: {rel}")
    for name, recorded in report.get("blendSha256", {}).items():
        path = ARCHITECTURAL_SOURCE / name
        if not path.exists() or sha256(path) != recorded:
            err(f"blend source hash differs or file is missing: {name}")
    if report.get("runtimeBytes") != glb_path.stat().st_size:
        err("report runtimeBytes differs from runtime GLB")
    summary["materials"] = len(g.get("materials", []))
    summary["embeddedImages"] = len(images)
    return summary


def ktx2_header(path: Path) -> dict:
    data = path.read_bytes()
    if data[:12] != KTX2_MAGIC:
        raise ValueError(f"{path.name}: not KTX2")
    vk_format, _type_size, width, height, _depth, _layers, _faces, levels, scheme = struct.unpack_from("<9I", data, 12)
    dfd_offset = struct.unpack_from("<I", data, 48)[0]
    # DFD: total size (4), block header (8), then colorModel, colorPrimaries, transferFunction.
    transfer = data[dfd_offset + 4 + 8 + 2]
    return {"vkFormat": vk_format, "width": width, "height": height, "levels": levels, "supercompression": scheme, "transfer": transfer}


def check_room(template: str, errors: list[str], warnings: list[str], variant: str | None = None) -> dict:
    directory = variant or template
    rt = RUNTIME / directory
    src = SOURCES / directory
    err = lambda msg: errors.append(f"{directory}: {msg}")  # noqa: E731
    summary: dict = {"template": template}

    manifest_path = rt / f"{template}.manifest.json"
    if not manifest_path.exists():
        err("manifest missing")
        return summary
    m = json.loads(manifest_path.read_text())
    if m.get("template") != template or m.get("id") != template:
        err(f"manifest template/id must be {template}")
    if variant == "hall-closed":
        open_hall = json.loads((RUNTIME / "hall" / "hall.manifest.json").read_text())
        for key in ("footprint", "doors", "rotations", "enemySockets", "lootSockets", "walkable", "colliders"):
            if m.get(key) != open_hall.get(key):
                err(f"{key} differs from the hall layout")
    if m.get("glb") != f"{template}.glb":
        err(f"manifest glb must be {template}.glb")
    lmspec = m.get("lightmap") or {}
    if lmspec.get("file") != f"{template}.lightmap.ktx2":
        err(f"lightmap file must be {template}.lightmap.ktx2")
    if lmspec.get("uv") != 1 or lmspec.get("encoding") != "srgb-scaled":
        err("lightmap must be srgb-scaled on UV channel 1")
    scale, intensity = lmspec.get("scale", 0), lmspec.get("intensity", 0)
    if not (scale > 0 and abs(intensity - math.pi * scale) < 1e-4):
        err("lightmap intensity must be pi x scale")
    if len(m.get("lightSockets", [])) > LIMITS["light_sockets"]:
        err("more than 4 light sockets")

    # Presence: the GLB, the lightmap and every map a manifest slot names.
    files = {f"{template}.glb", f"{template}.lightmap.ktx2", manifest_path.name}
    for slot in m.get("materials", {}).values():
        files.update(slot.get("maps", {}).values())
    for name in sorted(files):
        if not (rt / name).exists():
            err(f"missing runtime file {name}")
    extra = sorted(p.name for p in rt.iterdir() if p.name not in files)
    if extra:
        err(f"unlisted runtime files {extra}")
    if errors and any(e.startswith(f"{directory}: missing") for e in errors):
        return summary

    # GLB budgets and structure.
    glb = glb_stats(rt / f"{template}.glb")
    summary["glb"] = glb
    if glb["triangles"] > LIMITS["tris"]:
        err(f"{glb['triangles']} triangles over {LIMITS['tris']}")
    if len(glb["materials"]) > LIMITS["materials"]:
        err(f"{len(glb['materials'])} materials over {LIMITS['materials']}")
    if glb["images"] or glb["textures"]:
        err("GLB must be image-free (maps ship as KTX2 beside it)")
    if glb["missing_uv1"]:
        err(f"primitives without TEXCOORD_1: {glb['missing_uv1']}")
    if variant == "hall-closed" and "hall_stained-glass" in glb["materials"]:
        err("the closed hall still has stained-glass geometry")
    unknown = [n for n in glb["materials"] if n not in m.get("materials", {})]
    if unknown:
        err(f"GLB material slots missing from the manifest: {unknown}")
    # Rigid animated nodes (P5-T2 gear ring): a named root node with a mesh, its origin on the spin
    # axis, unrotated and unscaled, so the runtime can turn node.rotation about the manifest axis.
    rigid = m.get("rigidNodes", [])
    if template in RIGID_REQUIRED and {r.get("node") for r in rigid} != RIGID_REQUIRED[template]:
        err(f"manifest rigidNodes must name {sorted(RIGID_REQUIRED[template])}")
    if rigid:
        g = glb_json(rt / f"{template}.glb")
        nodes = g.get("nodes", [])
        roots = set(g.get("scenes", [{}])[g.get("scene", 0)].get("nodes", []))
        for r in rigid:
            idx = next((i for i, n in enumerate(nodes) if n.get("name") == r.get("node")), None)
            if idx is None:
                err(f"rigid node {r.get('node')} not in the GLB")
                continue
            n = nodes[idx]
            t = n.get("translation", [0, 0, 0])
            if idx not in roots or "mesh" not in n or n.get("children"):
                err(f"rigid node {r['node']} must be a root mesh node without children")
            if any(abs(a - b) > 1e-5 for a, b in zip(t, r.get("pivot", []))) or len(r.get("pivot", [])) != 3:
                err(f"rigid node {r['node']} translation {t} != manifest pivot {r.get('pivot')}")
            if any(abs(a - b) > 1e-6 for a, b in zip(n.get("rotation", [0, 0, 0, 1]), [0, 0, 0, 1])) or n.get("scale", [1, 1, 1]) != [1, 1, 1]:
                err(f"rigid node {r['node']} must be unrotated and unscaled at rest")
            rate = r.get("radPerSec")
            if r.get("axis") != [0, 1, 0] or not isinstance(rate, (int, float)) or not math.isfinite(rate) or rate == 0:
                err(f"rigid node {r['node']} needs axis [0, 1, 0] and a finite nonzero radPerSec")
                continue
            # A meshing partner turns the other way at the inverse tooth ratio (runtime: one clock).
            mw = r.get("meshesWith")
            if mw is not None:
                partner = next((q for q in rigid if q.get("node") == mw.get("node")), None)
                if partner is None or not isinstance(mw.get("teeth"), int) or not isinstance(mw.get("partnerTeeth"), int):
                    err(f"rigid node {r['node']} meshesWith needs a rigid partner node, teeth and partnerTeeth")
                elif abs(rate * mw["teeth"] + partner["radPerSec"] * mw["partnerTeeth"]) > 1e-4 * abs(partner["radPerSec"] * mw["partnerTeeth"]):
                    err(f"rigid node {r['node']} rate {rate} is not -{mw['partnerTeeth']}/{mw['teeth']} x its partner's {partner['radPerSec']}")
        summary["rigidNodes"] = [r["node"] for r in rigid]
        # Two or more rigid nodes mesh: the build's numeric check over a full turn must have passed.
        if len(rigid) > 1:
            mesh = json.loads((src / "staging/report.json").read_text()).get("gear_mesh") or {}
            if not mesh.get("pass"):
                err("staging/report.json gear_mesh must pass (no interpenetration over a full turn)")
            summary["gearMesh"] = [{k: q.get(k) for k in ("crossing_steps", "min_clearance_m")} for q in mesh.get("pairs", [])]
    # Door panel slots (room_panels.py, PRD D2): every template door ships a frame and a plug as root
    # mesh nodes at the identity, so floor-world.ts dressRoom can show one and hide the other.
    g = glb_json(rt / f"{template}.glb")
    nodes = g.get("nodes", [])
    roots = set(g.get("scenes", [{}])[g.get("scene", 0)].get("nodes", []))
    for door in m.get("doors", []):
        for panel in DOOR_PANELS:
            name = f"{panel}-{door.get('id')}"
            idx = next((i for i, n in enumerate(nodes) if n.get("name") == name), None)
            if idx is None:
                err(f"door panel node {name} not in the GLB")
                continue
            n = nodes[idx]
            if idx not in roots or "mesh" not in n or n.get("children") or any(k in n for k in ("translation", "rotation", "scale", "matrix")):
                err(f"door panel node {name} must be a root mesh node at the identity transform")
    summary["doorPanels"] = sorted(n.get("name") for n in nodes if n.get("name", "").startswith(DOOR_PANELS))
    budget = m.get("budget", {})
    if budget.get("tris") != glb["triangles"]:
        err(f"manifest budget.tris {budget.get('tris')} != measured {glb['triangles']}")
    if budget.get("materials", 0) < len(glb["materials"]) or budget.get("materials", 0) > LIMITS["materials"]:
        err(f"manifest budget.materials {budget.get('materials')} inconsistent with {len(glb['materials'])} slots")

    # Textures: size, full mip chain, transfer function per role.
    maps = {}
    for name in sorted(n for n in files if n.endswith(".ktx2")):
        h = ktx2_header(rt / name)
        maps[name] = h
        if max(h["width"], h["height"]) > LIMITS["texture_px"]:
            err(f"{name} is {h['width']}x{h['height']}, over {LIMITS['texture_px']}")
        if h["levels"] != int(math.log2(max(h["width"], h["height"]))) + 1:
            err(f"{name} has {h['levels']} mip levels, not a full chain")
        color = name.endswith((".lightmap.ktx2", ".basecolor.ktx2", ".emissive.ktx2"))
        want = KHR_DF_TRANSFER_SRGB if color else KHR_DF_TRANSFER_LINEAR
        if h["transfer"] != want:
            err(f"{name} transfer {h['transfer']}, want {'sRGB' if color else 'linear'}")
    lm_h = maps.get(f"{template}.lightmap.ktx2")
    if lm_h and not (lm_h["width"] == lm_h["height"] and lm_h["width"] in LIGHTMAP_SIZES):
        err(f"lightmap must be 1024 or 2048 square, is {lm_h['width']}x{lm_h['height']}")
    if budget.get("texturePx", 0) < max((h["width"] for h in maps.values()), default=0):
        err("manifest budget.texturePx below the largest map")
    summary["maps"] = maps

    # Hashes against provenance, and the clean reimport.
    prov_path = src / "provenance.json"
    if not prov_path.exists():
        err("provenance.json missing (run --assemble)")
        return summary
    prov = json.loads(prov_path.read_text())
    if not prov.get("validation", {}).get("pass"):
        err("provenance validation.pass is not true")
    recorded = {d["path"]: d["sha256"] for d in prov.get("derivedFiles", [])}
    for name in sorted(files):
        rel = f"public/assets/rooms/{directory}/{name}"
        if rel not in recorded:
            err(f"{rel} not recorded in provenance")
        elif recorded[rel] != sha256(rt / name):
            err(f"{rel} hash differs from provenance")
    for dep in prov.get("generatorDeps", []) + [prov.get("generator", {})]:
        path = ROOT / dep.get("path", "")
        if not path.exists():
            err(f"generator file {dep.get('path')} missing")
        elif sha256(path) != dep.get("sha256"):
            warnings.append(f"{directory}: {dep['path']} changed since the build (stale; rebuild before re-review)")
    for ref in prov.get("references", []):
        path = ROOT / ref["path"]
        if not path.exists() or sha256(path) != ref["sha256"]:
            err(f"reference {ref['path']} missing or changed")
    for ev in prov.get("reviewEvidence", []):
        path = ROOT / ev["path"]
        if not path.exists() or sha256(path) != ev["sha256"]:
            err(f"review evidence {ev['path']} missing or changed since provenance (re-review needed)")
    uv1 = src / "staging/uv1-report.json"  # written by scripts/assets/asset-check-uv1.py
    if not uv1.exists():
        err("staging/uv1-report.json missing (run scripts/assets/asset-check-uv1.py)")
    else:
        u = json.loads(uv1.read_text())
        if u.get("glb_sha256") != sha256(rt / f"{template}.glb"):
            err("uv1-report.json was measured on a different GLB")
        elif u.get("overlap_px") != 0 or not isinstance(u.get("min_gap_px"), int) or u["min_gap_px"] < 8:
            err(f"UV1 overlaps or gaps under 8 px (4 px padding per island): {u}")
        elif u.get("claims_per_covered_texel", 9) > 1.01:
            err("UV1 has folded islands")
    reimport = src / "staging/reimport.json"
    if not reimport.exists():
        err("staging/reimport.json missing")
    else:
        r = json.loads(reimport.read_text())
        if not r.get("pass") or r.get("glb_sha256") != sha256(rt / f"{template}.glb"):
            err("clean reimport did not pass for the shipped GLB")
    return summary


# Rigged enemies (P4-T6): public/assets/enemies/<id>/ holds exactly the GLB and its manifest.
ENEMY_RUNTIME = ROOT / "public/assets/enemies"
ENEMY_SOURCES = ROOT / "assets-source/enemies"
ENEMY_LIMITS = {"tris": 25_000, "materials": 4, "bones": 40, "influences": 4}
ENEMY_CLIPS = {"idle", "attack", "hit", "death", "frozen"}
DUNGEON_CONCEPT = "assets-source/concepts/dungeon/dungeon-enemies-sheet.png"
ENEMY_BASE_DRAFTS = {
    "mortar-scarab": (DUNGEON_CONCEPT, (0.55, 0.64)),
    "lantern-bailiff": (DUNGEON_CONCEPT, (1.60, 1.75)),
    "trellis-keeper": (
        "assets-source/concepts/trellis-keeper/trellis-keeper.png",
        (1.70, 1.80),
    ),
}

# Move-specific poses and actions required for each authored enemy.
ENEMY_MOVES_WITH_TIMING = {
    "mortar-scarab": ("shell-seal", "mortar-rake", "grind"),
    "lantern-bailiff": ("draw-chain", "lantern-sweep", "cinder-glance", "lantern-parry"),
    "trellis-keeper": ("trellis-brace", "double-cut", "hook-jab"),
}
ENEMY_INTENTS = {
    "glasswing-scrivener": ("inscribe", "cross-out", "proof"),
    "furnace-mite": ("double-spark", "stoke", "clink"),
    "null-crown-auditor": ("tally", "reconcile", "levy"),
    **ENEMY_MOVES_WITH_TIMING,
}
ENEMY_ACTIONS = {"null-crown-auditor": ("levy",), **ENEMY_MOVES_WITH_TIMING}
# The floor guardian (P5-T4) gets a larger budget and a one-shot `phase-change` clip on top of the five.
GUARDIAN = "grand-escapement"
GUARDIAN_LIMITS = {**ENEMY_LIMITS, "tris": 40_000, "bones": 60}
ENEMY_GENERATORS = {"cog-sentry": "scripts/assets/build-cog-sentry.py", "spring-hound": "scripts/assets/build-spring-hound.py",
                     "bellows-golem": "scripts/assets/build-bellows-golem.py", "orrery-warden": "scripts/assets/build-orrery-warden.py",
                     GUARDIAN: "scripts/assets/build-grand-escapement.py"}
ENEMY_REFERENCES = {"cog-sentry": ["assets-source/concepts/sentry-sheet-1.png"], "spring-hound": ["assets-source/concepts/hound-sheet-1.png"],
                    "bellows-golem": ["assets-source/concepts/golem-sheet-1.png"], "orrery-warden": ["assets-source/concepts/warden-sheet-1.png"],
                    GUARDIAN: ["assets-source/concepts/escapement-sheet-1.png"]}
_STANDING = ("Paul, 2026-11-15, in the rogue-xr session: \"you have standing approval for all spending / modeling / deployments needed "
             "for this project\". Modeling proceeded under it; it is not a concept, creative or owner approval of this asset.")
_P5_META = {
    "reference_note": "P5-T3 concept sheet (Higgsfield nano_banana_pro); concept approved by Paul 2026-11-16 (D8)",
    "evidence_glob": ("assets-source/enemies/{enemy}/staging/engine", "*.jpg"),
    "concept": {"who": "Paul", "when": "2026-11-16", "gate": "concept", "status": "approved",
                "evidence": "Paul, 2026-11-16, in the rogue-xr session: \"D8 concepts look good amend the requirements to allow them\""},
}
# Per-enemy provenance fields that differ by asset (the sentry entry reproduces its P4-T6 record).
ENEMY_META = {
    "cog-sentry": {
        "reference_note": "P4-T2 concept sheet picked for the Cog Sentry (docs/art-bible.md)",
        "materials_used": "approved P4-T3 brass-polished and brass-aged sets bound by slot name at runtime, each sampled at one texel "
                          "(constant UV) and tinted by its manifest slot tint (linear multiplier); gunmetal (gunmetal and jewels "
                          "from COLOR_0) and sentry-glow are factor-only",
        "evidence_glob": ("docs/verification", "p4-sentry-*.jpg"),
        "concept": {"who": "Paul", "when": "2026-11-15", "gate": "concept", "status": "approved", "evidence": "docs/art-bible.md: sentry-sheet-1.png picked for the Cog Sentry"},
    },
    "spring-hound": {**_P5_META, "materials_used": "approved P4-T3 brass-polished and brass-aged sets bound by slot name at runtime, each sampled "
                                                   "at one texel (constant UV) and tinted by its manifest slot tint [0.87, 0.75, 0.78] (linear "
                                                   "multiplier); gunmetal (gunmetal and ruby from COLOR_0) and hound-glow are factor-only"},
    "bellows-golem": {**_P5_META, "materials_used": "approved P4-T3 brass-polished set bound by slot name at runtime, sampled at one "
                                                    "texel (constant UV) and tinted by the manifest slot tint [0.87, 0.78, 0.62] (linear "
                                                    "multiplier); golem-case (walnut, pleats from COLOR_0), golem-metal (gunmetal and emerald from COLOR_0) and golem-glow are factor-only"},
    "orrery-warden": {**_P5_META, "reference_note": _P5_META["reference_note"].replace("P5-T3", "P5-T4"),
                      "materials_used": "approved P4-T3 brass-polished set bound by slot name at runtime and tinted by the manifest slot tint "
                                        "[0.8, 0.55, 0.75] (linear multiplier); gunmetal, warden-glow and warden-jewel "
                                        "(ruby, sapphire and emerald from COLOR_0) are factor-only"},
    GUARDIAN: {**_P5_META, "reference_note": _P5_META["reference_note"].replace("P5-T3", "P5-T4"),
               "materials_used": "approved P4-T3 brass-polished set bound by slot name at runtime; escapement-case (mahogany, dark iron, "
                                 "sapphire and ember from COLOR_0), escapement-glass (alpha-blended) and escapement-glow are factor-only"},
}


def enemy_limits(enemy: str) -> tuple[dict, set[str]]:
    """Budget and exact clip set for one enemy."""
    return (GUARDIAN_LIMITS, ENEMY_CLIPS | {"phase-change"}) if enemy == GUARDIAN else (ENEMY_LIMITS, ENEMY_CLIPS)


def check_enemy_base(
    enemy: str, concept: str, height: tuple[float, float], errors: list[str]
) -> None:
    base = ENEMY_SOURCES / enemy / "staging/base"
    if not base.is_dir():
        return
    try:
        report = json.loads((base / "reimport-report.json").read_text())
        glb = base / f"{enemy}-base.glb"
        files = {
            "glb": glb,
            "blend": base / f"{enemy}-base.blend",
            "generator": ROOT / f"scripts/assets/build-{enemy}-base.py",
            "concept": ROOT / concept,
        }
        for angle in ("three-quarter", "side", "raised"):
            files[f"review-{angle}"] = base / f"review-{angle}.png"
        for key, path in files.items():
            expected = report["sha256"].get(key) or report["sha256"].get(path.relative_to(ROOT).as_posix())
            if sha256(path) != expected:
                errors.append(f"enemies/{enemy} base: {key} hash differs from the reimport report")
        data = glb_json(glb)
        stats = glb_stats(glb)
        if data.get("skins") or data.get("animations"):
            errors.append(f"enemies/{enemy} base: unexpected skin or animation in static draft")
        sockets = {"socket-eye", "socket-hit", "socket-weapon"}
        if not sockets <= {node.get("name") for node in data["nodes"]}:
            errors.append(f"enemies/{enemy} base: missing planned attachment sockets")
        tris = stats["triangles"]
        if not 0 < tris <= ENEMY_LIMITS["tris"] or tris != report["triangle_count"]:
            errors.append(f"enemies/{enemy} base: triangle count {tris} differs from the report or budget")
        if not 0 < len(stats["materials"]) <= ENEMY_LIMITS["materials"] or stats["images"]:
            errors.append(f"enemies/{enemy} base: exceeds the image-free material budget")
        footprint = report["bounds_blender_m"]
        lower, upper = height
        if abs(footprint["min"][2]) > 0.002 or not lower <= footprint["max"][2] <= upper:
            errors.append(f"enemies/{enemy} base: reimport ground contact or stature out of bounds")
        print(f"asset-check enemies/{enemy} base draft: {tris} tris, {len(stats['materials'])} materials")
    except (OSError, ValueError, KeyError, IndexError, TypeError, struct.error) as exc:
        errors.append(f"enemies/{enemy} base: {exc}")


def check_enemy_action_timings(enemy: str, manifest: dict, glb: dict, errors: list[str]) -> None:
    timings = manifest.get("actionTimings", {})
    if not isinstance(timings, dict) or set(timings) != set(ENEMY_MOVES_WITH_TIMING[enemy]):
        errors.append(f"enemies/{enemy}: actionTimings must cover each authored move")
        return
    animations = {clip["name"]: clip for clip in glb.get("animations", [])}
    for move, timing in timings.items():
        duration = timing.get("duration") if isinstance(timing, dict) else None
        impact = timing.get("impact") if isinstance(timing, dict) else None
        if any(type(value) not in (int, float) or not math.isfinite(value) for value in (duration, impact)) or not 0 < impact < duration:
            errors.append(f"enemies/{enemy}: {move} must place one impact inside its action clip")
            continue
        second = timing.get("secondImpact")
        if "secondImpact" in timing and (
            type(second) not in (int, float) or not math.isfinite(second)
            or not impact < second < duration
        ):
            errors.append(f"enemies/{enemy}: {move} must place its second impact after the first and inside its clip")
        clip = animations.get(f"action-{move}", {})
        accessors = glb.get("accessors", [])
        ends = [accessors[s["input"]].get("max", [0])[0] for s in clip.get("samplers", [])]
        if not ends or not math.isclose(duration, max(ends), abs_tol=1 / 30):
            errors.append(f"enemies/{enemy}: {move} action duration differs from its GLB")


def check_enemy(
    enemy: str, errors: list[str], warnings: list[str], *, staged: bool = False
) -> dict:
    src = ENEMY_SOURCES / enemy
    rt = src / "staging/runtime" if staged else ENEMY_RUNTIME / enemy
    err = lambda msg: errors.append(f"enemies/{enemy}: {msg}")  # noqa: E731
    summary: dict = {"enemy": enemy}
    limits, want_clips = enemy_limits(enemy)
    files = {f"{enemy}.glb", f"{enemy}.manifest.json"}
    for name in sorted(files):
        if not (rt / name).exists():
            err(f"missing runtime file {name}")
    extra = sorted(p.name for p in rt.iterdir() if p.name not in files) if rt.is_dir() else []
    if extra and not staged:
        err(f"unlisted runtime files {extra}")
    if any(not (rt / n).exists() for n in files):
        return summary
    m = json.loads((rt / f"{enemy}.manifest.json").read_text())
    if m.get("id") != enemy or m.get("glb") != f"{enemy}.glb":
        err("manifest id/glb do not match the directory")
    g = glb_json(rt / f"{enemy}.glb")
    glb = glb_stats(rt / f"{enemy}.glb")
    skins = g.get("skins", [])
    bones = len(skins[0]["joints"]) if len(skins) == 1 else -1
    clips = {a.get("name") for a in g.get("animations", [])}
    attrs = [prim["attributes"] for mesh in g.get("meshes", []) for prim in mesh["primitives"]]
    summary.update({"glb": glb, "bones": bones, "clips": sorted(clips)})
    if glb["triangles"] > limits["tris"]:
        err(f"{glb['triangles']} triangles over {limits['tris']}")
    if len(glb["materials"]) > limits["materials"]:
        err(f"{len(glb['materials'])} materials over {limits['materials']}")
    if not 0 < bones <= limits["bones"]:
        err(f"skeleton must be one skin with 1-{limits['bones']} joints (got {bones})")
    if glb["images"] or glb["textures"]:
        err("GLB must be image-free (brass slots bind the shared P4-T3 sets by name)")
    if any("JOINTS_0" not in a or "WEIGHTS_0" not in a for a in attrs) or any("WEIGHTS_1" in a for a in attrs):
        err("every primitive needs exactly one JOINTS_0/WEIGHTS_0 set (<= 4 influences)")
    intents = {name: "intent-" + name for name in ENEMY_INTENTS.get(enemy, ())}
    if m.get("intentClips", {}) != intents:
        err(f"intent clip map differs from the authored moves {intents}")
    actions = {name: "action-" + name for name in ENEMY_ACTIONS.get(enemy, ())}
    if m.get("actionClips", {}) != actions:
        err(f"action clip map differs from the authored moves {actions}")
    if clips != want_clips | set(intents.values()) | set(actions.values()) or set(m.get("clips", {})) != want_clips:
        err(f"clips {sorted(clips)} / manifest {sorted(m.get('clips', {}))} != {sorted(want_clips)}")
    if enemy in ENEMY_MOVES_WITH_TIMING:
        check_enemy_action_timings(enemy, m, g, errors)
    budget = m.get("budget", {})
    if budget.get("tris") != glb["triangles"] or budget.get("bones") != bones or budget.get("materials") != len(glb["materials"]):
        err(f"manifest budget {budget} != measured tris {glb['triangles']}, bones {bones}, materials {len(glb['materials'])}")
    unknown = [n for n in glb["materials"] if n not in m.get("materialSlots", {})]
    if unknown:
        err(f"GLB material slots missing from the manifest: {unknown}")
    for name, slot in m.get("materialSlots", {}).items():  # optional tint: linear multiplier on the shared set's colour
        tint = slot.get("tint")
        if tint is not None and not (isinstance(tint, list) and len(tint) == 3
                                     and all(isinstance(c, (int, float)) and not isinstance(c, bool) and 0 <= c <= 1 for c in tint)):
            err(f"material slot {name} tint must be three numbers in 0..1 (got {tint!r})")
    if abs(m.get("bounds", {}).get("min", [0, 1, 0])[1]) > 1e-3:
        err("rest pose must stand on y = 0")

    if staged:
        check_enemy_reimport(rt / "reimport-report.json", rt / f"{enemy}.glb", limits, err)
        return summary

    prov_path = src / "provenance.json"
    if not prov_path.exists():
        err("provenance.json missing (run --assemble-enemy)")
        return summary
    prov = json.loads(prov_path.read_text())
    if not prov.get("validation", {}).get("pass"):
        err("provenance validation.pass is not true")
    recorded = {d["path"]: d["sha256"] for d in prov.get("derivedFiles", []) + prov.get("sourceFiles", [])}
    for name in sorted(files):
        rel = f"public/assets/enemies/{enemy}/{name}"
        if rel not in recorded:
            err(f"{rel} not recorded in provenance")
        elif recorded[rel] != sha256(rt / name):
            err(f"{rel} hash differs from provenance")
    for d in prov.get("sourceFiles", []):
        path = ROOT / d["path"]
        if not path.exists() or sha256(path) != d["sha256"]:
            err(f"source {d['path']} missing or changed since provenance")
    gen = prov.get("generator", {})
    if not (ROOT / gen.get("path", "")).exists():
        err(f"generator {gen.get('path')} missing")
    elif sha256(ROOT / gen["path"]) != gen.get("sha256"):
        warnings.append(f"enemies/{enemy}: {gen['path']} changed since the build (stale; rebuild before re-review)")
    for ref in prov.get("references", []):
        path = ROOT / ref["path"]
        if not path.exists() or sha256(path) != ref["sha256"]:
            err(f"reference {ref['path']} missing or changed")
    for ev in prov.get("reviewEvidence", []):
        path = ROOT / ev["path"]
        if not path.exists() or sha256(path) != ev["sha256"]:
            err(f"review evidence {ev['path']} missing or changed since provenance (re-review needed)")
    check_enemy_reimport(src / "staging/reimport.json", rt / f"{enemy}.glb", limits, err)
    return summary


def check_enemy_reimport(report: Path, glb: Path, limits: dict, err: Callable[[str], None]) -> None:
    if not report.exists():
        err(f"missing reimport report {report.relative_to(ROOT)}")
        return
    data = json.loads(report.read_text())
    if not data.get("pass") or data.get("glb_sha256") != sha256(glb):
        err("reimport gate did not pass for this GLB")
    elif data.get("max_influences", 9) > limits["influences"] or data.get("unweighted_vertices", 1) or data.get("max_weight_sum_error", 1) > 2e-3:
        err("reimport skin checks failed")


def assemble_enemy(enemy: str) -> None:
    src = ENEMY_SOURCES / enemy
    rt = ENEMY_RUNTIME / enemy
    report = json.loads((src / "staging/report.json").read_text())
    reimport = json.loads((src / "staging/reimport.json").read_text())
    manifest = json.loads((rt / f"{enemy}.manifest.json").read_text())
    gen = ENEMY_GENERATORS[enemy]
    meta = ENEMY_META[enemy]
    entry = lambda p: {"path": str(p.relative_to(ROOT)), "sha256": sha256(p), "bytes": p.stat().st_size}  # noqa: E731
    sources = [entry(p) for p in sorted((src / "blend").iterdir()) if p.suffix == ".blend"]
    sources += [entry(src / "staging/report.json"), entry(src / "staging/reimport.json")]
    if meta["evidence_glob"][0].startswith("assets-source"):  # the engine-shot tools that made the evidence
        sources += [entry(src / n) for n in ("engine_shot.py", "engine-proof.ts") if (src / n).exists()]
    prov = {
        "pieceId": enemy,
        "version": 1,
        "route": "scripted (procedural Blender geometry, rig and keyed clips; no provider generation)",
        "generator": {"path": gen, "sha256": sha256(ROOT / gen)},
        "authoringAgent": {"harness": "claude-code (dispatched sub-agent)", "model": "claude-opus-5-5"},
        "blender": report["blender"],
        "toolVersions": {"gltfExporter": "Blender 5.2.2 bundled io_scene_gltf2"},
        "blendFiles": {"store": f"assets-source/enemies/{enemy}/blend (storage ruling pending, docs/blender-kit-project.md ruling 5)"},
        "budgets": {"triangles": reimport["triangles"], "highTriangles": report["triangles"]["high"], "materials": len(reimport["materials"]),
                    "bones": reimport["bone_count"], "maxInfluences": reimport["max_influences"], "glbBytes": reimport["glb_bytes"]},
        "skin": {"policy": "rigid: one bone per vertex at weight 1.0", "maxWeightSumError": reimport["max_weight_sum_error"],
                 "unweightedVertices": reimport["unweighted_vertices"]},
        "clips": {k: {**v, "measured": reimport["clips"][k]} for k, v in manifest["clips"].items()},
        "poseChecks": report.get("pose_checks"),
        "rootMotion": manifest["rootMotion"],
        "frame": manifest["frame"],
        "sockets": manifest["sockets"],
        "derivedFiles": [entry(p) for p in sorted(rt.iterdir())],
        "sourceFiles": sources,
        # What Paul reviews for the model, rig and animation gates, bound to the bytes shown.
        "reviewEvidence": [entry(src / f"{enemy}.review-sheet.jpg")]
        + [entry(p) for p in sorted((ROOT / meta["evidence_glob"][0].format(enemy=enemy)).glob(meta["evidence_glob"][1]))],
        "references": [{"path": r, "sha256": sha256(ROOT / r), "provider": "higgsfield", "note": meta["reference_note"]}
                       for r in ENEMY_REFERENCES[enemy]],
        "materialsUsed": meta["materials_used"],
        "license": "Original work generated in Blender from a checked-in script; concept reference from Paul's paid Higgsfield plan (Terms of Use 4.4)",
        "validation": {"pass": False, "date": datetime.date.today().isoformat(), "checks": []},
        "approvals": [
            meta["concept"],
            {"gate": "model", "status": "pending", "notes": f"assets-source/enemies/{enemy}/{enemy}.review-sheet.jpg, MODEL section"},
            {"gate": "rig", "status": "pending", "notes": "review sheet RIG section"},
            {"gate": "animation", "status": "pending", "notes": "review sheet ANIMATION sections (Blender frames and engine stills)"},
            {"gate": "independent visual score", "status": "unscored", "notes": "create-rigged-character-assets requires an independent >= 80/100 score; unscored means unaccepted"},
        ],
    }
    prov_path = src / "provenance.json"
    prov_path.write_text(json.dumps(prov, indent=2) + "\n")
    errors: list[str] = []
    warnings: list[str] = []
    check_enemy(enemy, errors, warnings)
    remaining = [e for e in errors if "validation.pass" not in e]
    if remaining:
        prov_path.unlink()
        raise SystemExit("assemble refused, gate errors:\n" + "\n".join(remaining))
    prov["validation"] = {"pass": True, "date": datetime.date.today().isoformat(),
                          "checks": ["presence", "hashes", "glb budgets (tris, materials, bones)", "one skin, one weight set", "image-free glb",
                                     "clip set", "manifest consistency", "reimport gate (weights, influences, clips, root motion, bounds, sockets)",
                                     "evaluated pose checks (floor, death on the floor, loop seams)"]}
    prov_path.write_text(json.dumps(prov, indent=2) + "\n")
    print(f"wrote {prov_path.relative_to(ROOT)}")


DICE_RUNTIME = ROOT / "public/assets/dice"
DICE_SOURCES = ROOT / "assets-source/dice"
DICE_LIMITS = {"tris": 1500, "materials": 2}
DICE_GENERATOR = "scripts/assets/build-dice.py"
DICE_GENERATOR_DEPS = ["scripts/assets/build-cog-sentry.py"]
# faces.ts face order: d6 normals by index, d8 sign bits (i & 4 -> x, i & 2 -> y, i & 1 -> z).
_S3 = 1 / math.sqrt(3)
D12_GEOMETRY = json.loads((ROOT / "src/dice/crystal-d12.json").read_text())
DICE_FACES = {
    "brass-d6": {"kind": "d6", "half": 0.02, "values": list(range(1, 7)),
                 "normals": [(0, 1, 0), (1, 0, 0), (0, 0, 1), (0, 0, -1), (-1, 0, 0), (0, -1, 0)]},
    "glass-d8": {"kind": "d8", "half": 0.026, "values": list(range(1, 9)),
                 "normals": [((-1 if i & 4 else 1) * _S3, (-1 if i & 2 else 1) * _S3, (-1 if i & 1 else 1) * _S3) for i in range(8)]},
    "crystal-d12": {"kind": "d12", "half": max(abs(v) for point in D12_GEOMETRY["vertices"] for v in point),
                    "values": list(range(1, 13)), "normals": [face["normal"] for face in D12_GEOMETRY["faces"]]},
}


def check_dice(die: str, errors: list[str], warnings: list[str]) -> dict:
    rt = DICE_RUNTIME / die
    src = DICE_SOURCES / die
    err = lambda msg: errors.append(f"dice/{die}: {msg}")  # noqa: E731
    summary: dict = {"die": die}
    spec = DICE_FACES.get(die)
    if spec is None:
        err("unknown die id (not in DICE_FACES)")
        return summary
    files = {f"{die}.glb", f"{die}.manifest.json"}
    for name in sorted(files):
        if not (rt / name).exists():
            err(f"missing runtime file {name}")
    extra = sorted(p.name for p in rt.iterdir() if p.name not in files)
    if extra:
        err(f"unlisted runtime files {extra}")
    if any(not (rt / n).exists() for n in files):
        return summary
    m = json.loads((rt / f"{die}.manifest.json").read_text())
    if m.get("id") != die or m.get("glb") != f"{die}.glb" or m.get("kind") != spec["kind"]:
        err("manifest id/glb/kind do not match the directory")
    g = glb_json(rt / f"{die}.glb")
    glb = glb_stats(rt / f"{die}.glb")
    summary["glb"] = glb
    if glb["triangles"] > DICE_LIMITS["tris"]:
        err(f"{glb['triangles']} triangles over {DICE_LIMITS['tris']}")
    if len(glb["materials"]) > DICE_LIMITS["materials"]:
        err(f"{len(glb['materials'])} materials over {DICE_LIMITS['materials']}")
    if glb["images"] or glb["textures"]:
        err("GLB must be image-free (faces sample the shared UI atlas page)")
    if any(mat.get("doubleSided") for mat in g.get("materials", [])):
        err("materials must be single-sided")
    budget = m.get("budget", {})
    if budget.get("tris") != glb["triangles"] or budget.get("materials") != len(glb["materials"]) or budget.get("texturesProduced") != 0:
        err(f"manifest budget {budget} != measured tris {glb['triangles']}, materials {len(glb['materials'])}, 0 textures")
    if sorted(glb["materials"]) != sorted(m.get("materialSlots", {})):
        err(f"GLB materials {glb['materials']} != manifest slots {sorted(m.get('materialSlots', {}))}")
    want = [{"index": i, "value": v, "normal": [float(x) for x in n]} for i, (v, n) in enumerate(zip(spec["values"], spec["normals"]))]
    node = next((n for n in g.get("nodes", []) if n.get("name") == m.get("node")), {})
    got_glb = node.get("extras", {}).get("die", {}).get("faces")
    got_manifest = [{k: f[k] for k in ("index", "value", "normal")} for f in m.get("faces", [])]
    for label, got in (("GLB node extras", got_glb), ("manifest", got_manifest)):
        if not got or len(got) != len(want) or any(
            a["index"] != b["index"] or a["value"] != b["value"] or max(abs(x - y) for x, y in zip(a["normal"], b["normal"])) > 1e-9
            for a, b in zip(got, want)
        ):
            err(f"{label} face table differs from faces.ts / content/dice.ts")
    bounds = m.get("bounds", {})
    if any(abs(abs(v) - spec["half"]) > 1e-6 for v in bounds.get("min", [9]) + bounds.get("max", [9])):
        err(f"bounds {bounds} do not match the collider half extent {spec['half']}")

    prov_path = src / "provenance.json"
    if not prov_path.exists():
        err("provenance.json missing (run --assemble-dice)")
        return summary
    prov = json.loads(prov_path.read_text())
    if not prov.get("validation", {}).get("pass"):
        err("provenance validation.pass is not true")
    recorded = {d["path"]: d["sha256"] for d in prov.get("derivedFiles", []) + prov.get("sourceFiles", [])}
    for name in sorted(files):
        rel = f"public/assets/dice/{die}/{name}"
        if rel not in recorded:
            err(f"{rel} not recorded in provenance")
        elif recorded[rel] != sha256(rt / name):
            err(f"{rel} hash differs from provenance")
    for d in prov.get("sourceFiles", []):
        path = ROOT / d["path"]
        if not path.exists() or sha256(path) != d["sha256"]:
            err(f"source {d['path']} missing or changed since provenance")
    for dep in [prov.get("generator", {})] + prov.get("generatorDeps", []):
        if not (ROOT / dep.get("path", "")).exists():
            err(f"generator {dep.get('path')} missing")
        elif sha256(ROOT / dep["path"]) != dep.get("sha256"):
            warnings.append(f"dice/{die}: {dep['path']} changed since the build (stale; rebuild before re-review)")
    for ref in prov.get("references", []) + prov.get("reviewEvidence", []) + prov.get("atlasInputs", []):
        path = ROOT / ref["path"]
        if not path.exists() or sha256(path) != ref["sha256"]:
            err(f"reference, atlas input or review evidence {ref['path']} missing or changed since provenance")
    reimport = src / "staging/reimport.json"
    if not reimport.exists():
        err("staging/reimport.json missing")
    else:
        r = json.loads(reimport.read_text())
        if not r.get("pass") or r.get("glb_sha256") != sha256(rt / f"{die}.glb"):
            err("reimport gate did not pass for the shipped GLB")
    return summary


def assemble_dice(die: str) -> None:
    src = DICE_SOURCES / die
    rt = DICE_RUNTIME / die
    report = json.loads((src / "staging/report.json").read_text())
    reimport = json.loads((src / "staging/reimport.json").read_text())
    manifest = json.loads((rt / f"{die}.manifest.json").read_text())
    entry = lambda p: {"path": str(p.relative_to(ROOT)), "sha256": sha256(p), "bytes": p.stat().st_size}  # noqa: E731
    sources = [entry(p) for p in sorted((src / "blend").iterdir()) if p.suffix == ".blend"]
    sources += [entry(src / "staging/report.json"), entry(src / "staging/reimport.json")]
    prov = {
        "pieceId": die,
        "version": 1,
        "route": "scripted (procedural Blender geometry; no provider generation; face art reused from the P5-T6 UI atlas)",
        "generator": {"path": DICE_GENERATOR, "sha256": sha256(ROOT / DICE_GENERATOR)},
        "generatorDeps": [{"path": d, "sha256": sha256(ROOT / d), "use": "read_glb and canonicalize_indices"} for d in DICE_GENERATOR_DEPS],
        "authoringAgent": {"harness": "claude-code (dispatched sub-agent)", "model": "claude-opus-5-5"},
        "blender": report["blender"],
        "toolVersions": {"gltfExporter": "Blender 5.2.2 bundled io_scene_gltf2"},
        "blendFiles": {"store": f"assets-source/dice/{die}/blend (storage ruling pending, docs/blender-kit-project.md ruling 5)"},
        "budgets": {"triangles": reimport["triangles"], "highTriangles": report["triangles"]["high"], "materials": len(reimport["materials"]),
                    "texturesProduced": 0, "texturesSampled": manifest["budget"]["texturesSampled"], "glbBytes": reimport["glb_bytes"]},
        "lods": "LOD0 only: a 40 mm die stays within the 1,500-triangle dice budget (DICE_LIMITS), so a LOD chain saves nothing measurable",
        "bake": "none: face art is the shared atlas page and brass is a factor (or the shared brass-polished set), so nothing is baked",
        "collider": manifest["collider"],
        "frame": manifest["frame"],
        "faces": manifest["faces"],
        "derivedFiles": [entry(p) for p in sorted(rt.iterdir())],
        "sourceFiles": sources,
        "atlasInputs": [{"path": report["atlas"]["manifest"], "sha256": sha256(ROOT / report["atlas"]["manifest"])}, entry(ROOT / report["atlas"]["page"])],
        "reviewEvidence": [entry(DICE_SOURCES / "dice.review-sheet.jpg")]
        + [entry(p) for p in sorted((ROOT / "docs/verification").glob(f"p5-dice-{die}*.jpg"))],
        "references": [{"path": "assets-source/style/locked/L-board-1.png", "sha256": sha256(ROOT / "assets-source/style/locked/L-board-1.png"),
                        "provider": "higgsfield", "note": "canonical style board (docs/art-bible.md): dice panel 4"}],
        "materialsUsed": "factor-only polished brass named after the approved P4-T3 brass-polished set (bindable at runtime); the face slot samples the shared P5-T6 UI atlas page",
        "license": "Original work generated in Blender from a checked-in script; face art and style reference from Paul's paid Higgsfield plan (Terms of Use 4.4)",
        "validation": {"pass": False, "date": datetime.date.today().isoformat(), "checks": []},
        "approvals": [
            {"gate": "technical", "status": "pending", "notes": "validate-generated-assets verdict is reported to the orchestrator, not self-recorded"},
            {"gate": "creative", "status": "pending", "notes": "assets-source/dice/dice.review-sheet.jpg"},
            {"gate": "rights", "status": "pending", "notes": "original procedural geometry; face art from the P5-T6 atlas (its own provenance)"},
            {"gate": "owner", "status": "pending", "notes": "Paul approves the in-engine look (docs/blender-kit-project.md ruling 3)"},
            {"gate": "independent visual score", "status": "unscored", "notes": "blender-kit-pieces requires an independent >= 80/100 score; unscored means unaccepted"},
        ],
    }
    prov_path = src / "provenance.json"
    prov_path.write_text(json.dumps(prov, indent=2) + "\n")
    errors: list[str] = []
    warnings: list[str] = []
    check_dice(die, errors, warnings)
    remaining = [e for e in errors if "validation.pass" not in e]
    if remaining:
        prov_path.unlink()
        raise SystemExit("assemble refused, gate errors:\n" + "\n".join(remaining))
    prov["validation"] = {"pass": True, "date": datetime.date.today().isoformat(),
                          "checks": ["presence", "hashes", "glb budgets (<= 1500 tris, <= 2 materials)", "image-free glb", "single-sided materials",
                                     "face table (GLB extras and manifest) equals faces.ts and content/dice.ts", "bounds equal the collider",
                                     "manifest consistency", "reimport gate (face-up UVs in the atlas cell, no mirrored UVs, Blender reimport)"]}
    prov_path.write_text(json.dumps(prov, indent=2) + "\n")
    print(f"wrote {prov_path.relative_to(ROOT)}")


DECOR_RUNTIME = ROOT / "public/assets/props/table-decor"
DECOR_SOURCES = ROOT / "assets-source/props/table-decor"
DECOR_GENERATOR = "scripts/assets/build-table-decor.py"
DECOR_GENERATOR_DEPS = ["scripts/assets/lightmap_helpers.py"]
DECOR_LIMITS = {"tris_per_kind": 600, "materials": 1, "texture_px": 1024}
# src/floor/table-decor.ts DECOR_RADIUS: the footprint placement reserves for each prop.
DECOR_RADIUS = {"candle": 0.072, "books": 0.11, "vase": 0.07}
# src/floor/table-decor.ts DECOR_VARIANTS: meshes per kind.
DECOR_VARIANTS = {"candle": 1, "books": 3, "vase": 1}
DECOR_MAPS = {"basecolor": KHR_DF_TRANSFER_SRGB, "normal": KHR_DF_TRANSFER_LINEAR,
              "orm": KHR_DF_TRANSFER_LINEAR, "emissive": KHR_DF_TRANSFER_SRGB}


def check_decor(errors: list[str], warnings: list[str]) -> dict:
    rt, src = DECOR_RUNTIME, DECOR_SOURCES
    err = lambda msg: errors.append(f"props/table-decor: {msg}")  # noqa: E731
    summary: dict = {}
    files = {"table-decor.glb", "table-decor.manifest.json", *(f"table-decor.{r}.ktx2" for r in DECOR_MAPS)}
    for name in sorted(files):
        if not (rt / name).exists():
            err(f"missing runtime file {name}")
    extra = sorted(p.name for p in rt.iterdir() if p.name not in files)
    if extra:
        err(f"unlisted runtime files {extra}")
    if any(not (rt / n).exists() for n in files):
        return summary
    m = json.loads((rt / "table-decor.manifest.json").read_text())
    if m.get("id") != "table-decor" or m.get("glb") != "table-decor.glb":
        err("manifest id/glb do not match the directory")
    g = glb_json(rt / "table-decor.glb")
    glb = glb_stats(rt / "table-decor.glb")
    summary["glb"] = glb
    if glb["images"] or glb["textures"]:
        err("GLB must be image-free (maps ship as KTX2 beside it)")
    if glb["materials"] != [m.get("material")] or len(glb["materials"]) > DECOR_LIMITS["materials"]:
        err(f"GLB materials {glb['materials']} != the one shared material {m.get('material')!r}")
    if any(mat.get("doubleSided") for mat in g.get("materials", [])):
        err("materials must be single-sided")
    meshes = g.get("meshes", [])
    per_kind: dict[str, int] = {}
    listed = set()
    for kind, radius in DECOR_RADIUS.items():
        spec = m.get("kinds", {}).get(kind)
        if not spec:
            err(f"manifest kinds.{kind} missing")
            continue
        if spec.get("reservedRadius") != radius:
            err(f"manifest {kind} reservedRadius {spec.get('reservedRadius')} != table-decor.ts {radius}")
        variants = spec.get("variants", [])
        if len(variants) != DECOR_VARIANTS[kind]:
            err(f"manifest {kind} has {len(variants)} variants, table-decor.ts DECOR_VARIANTS wants {DECOR_VARIANTS[kind]}")
        for v in variants:
            name = v.get("node")
            listed.add(name)
            node = next((n for n in g.get("nodes", []) if n.get("name") == name), None)
            if node is None or "mesh" not in node:
                err(f"node {name} missing from the GLB")
                continue
            if any(k in node for k in ("translation", "rotation", "scale", "matrix")):
                err(f"node {name} must carry no transform (its origin is the prop's base centre)")
            tris = 0
            for prim in meshes[node["mesh"]]["primitives"]:
                acc = g["accessors"][prim["indices"]] if "indices" in prim else g["accessors"][prim["attributes"]["POSITION"]]
                tris += acc["count"] // 3
                pos = g["accessors"][prim["attributes"]["POSITION"]]
                lo, hi = pos.get("min", [0, 0, 0]), pos.get("max", [0, 0, 0])
                if abs(lo[1]) > 1e-4:
                    err(f"{name} base sits at y {lo[1]:.4f}, not on the table top (y 0)")
                reach = max(abs(lo[0]), abs(hi[0]), abs(lo[2]), abs(hi[2]))
                if reach > radius + 1e-3:
                    err(f"{name} reaches {reach:.4f} m, beyond its {radius} m placement footprint")
            per_kind[name] = tris
            if tris > DECOR_LIMITS["tris_per_kind"]:
                err(f"{name} has {tris} triangles, over {DECOR_LIMITS['tris_per_kind']}")
            if v.get("tris") != tris:
                err(f"manifest {name} tris {v.get('tris')} != measured {tris}")
            contact = v.get("contact", {})
            if not all(isinstance(contact.get(f), (int, float)) for f in ("x", "z", "halfX", "halfZ", "corner")):
                err(f"manifest {name} contact footprint missing")
    unlisted = sorted(n.get("name") for n in g.get("nodes", []) if "mesh" in n and n.get("name") not in listed)
    if unlisted:
        err(f"GLB mesh nodes not in the manifest: {unlisted}")
    summary["perKind"] = per_kind
    sizes = set()
    summary["maps"] = {}
    for role, transfer in DECOR_MAPS.items():
        name = m.get("maps", {}).get(role)
        if name != f"table-decor.{role}.ktx2":
            err(f"manifest maps.{role} is {name!r}")
            continue
        h = ktx2_header(rt / name)
        summary["maps"][role] = h
        sizes.add((h["width"], h["height"]))
        if h["width"] != h["height"] or h["width"] > DECOR_LIMITS["texture_px"]:
            err(f"{name} is {h['width']}x{h['height']}, not square <= {DECOR_LIMITS['texture_px']}")
        if h["levels"] < 2:
            err(f"{name} has no mip chain")
        if h["transfer"] != transfer:
            err(f"{name} transfer {h['transfer']}, expected {'sRGB' if transfer == KHR_DF_TRANSFER_SRGB else 'linear'}")
    if len(sizes) > 1:
        err(f"maps differ in size {sorted(sizes)}")
    if m.get("texturePx") not in {w for w, _ in sizes}:
        err(f"manifest texturePx {m.get('texturePx')} != map size {sorted(sizes)}")

    prov_path = src / "provenance.json"
    if not prov_path.exists():
        err("provenance.json missing (run --assemble-decor)")
        return summary
    prov = json.loads(prov_path.read_text())
    if not prov.get("validation", {}).get("pass"):
        err("provenance validation.pass is not true")
    score = prov.get("independentScore")
    if score is not None and not str(score.get("scorer", "")).startswith("independent reviewer"):
        err("independentScore must come from an independent reviewer, not the builder")
    recorded = {d["path"]: d["sha256"] for d in prov.get("derivedFiles", []) + prov.get("sourceFiles", [])}
    for name in sorted(files):
        rel = f"public/assets/props/table-decor/{name}"
        if rel not in recorded:
            err(f"{rel} not recorded in provenance")
        elif recorded[rel] != sha256(rt / name):
            err(f"{rel} hash differs from provenance")
    for d in prov.get("sourceFiles", []) + prov.get("references", []) + prov.get("reviewEvidence", []):
        path = ROOT / d["path"]
        if not path.exists() or sha256(path) != d["sha256"]:
            err(f"{d['path']} missing or changed since provenance")
    for dep in [prov.get("generator", {})] + prov.get("generatorDeps", []):
        if not (ROOT / dep.get("path", "")).exists():
            err(f"generator {dep.get('path')} missing")
        elif sha256(ROOT / dep["path"]) != dep.get("sha256"):
            warnings.append(f"props/table-decor: {dep['path']} changed since the build (stale; rebuild before re-review)")
    reimport = src / "staging/reimport.json"
    if not reimport.exists():
        err("staging/reimport.json missing")
    else:
        r = json.loads(reimport.read_text())
        if not r.get("pass") or r.get("glb_sha256") != sha256(rt / "table-decor.glb"):
            err("reimport gate did not pass for the shipped GLB")
    return summary


def assemble_decor() -> None:
    src, rt = DECOR_SOURCES, DECOR_RUNTIME
    report = json.loads((src / "staging/report.json").read_text())
    reimport = json.loads((src / "staging/reimport.json").read_text())
    manifest = json.loads((rt / "table-decor.manifest.json").read_text())
    entry = lambda p: {"path": str(p.relative_to(ROOT)), "sha256": sha256(p), "bytes": p.stat().st_size}  # noqa: E731
    sources = [entry(p) for p in sorted((src / "blend").iterdir()) if p.suffix == ".blend"]
    sources += [entry(src / "staging" / n) for n in ("report.json", "reimport.json", "table-decor.basecolor.png", "table-decor.normal.png",
                                                     "table-decor.orm.png", "table-decor.emissive.png")]
    sources += [entry(ROOT / r) for r in report["renders"]]
    evidence = [src / "table-decor.review-sheet.jpg", *sorted((src / "engine").glob("*.jpg"))]
    prov = {
        "pieceId": "table-decor",
        "version": 1,
        "route": "scripted (procedural Blender high and low geometry, Cycles selected-to-active bake to one shared atlas; no provider generation)",
        "generator": {"path": DECOR_GENERATOR, "sha256": sha256(ROOT / DECOR_GENERATOR)},
        "generatorDeps": [{"path": d, "sha256": sha256(ROOT / d), "use": "select_device, image_rgba, srgb_encode, write_png_rgb"} for d in DECOR_GENERATOR_DEPS],
        "authoringAgent": {"harness": "claude-code (dispatched sub-agent)", "model": "claude-opus-5-5"},
        "blender": report["blender"],
        "toolVersions": {"ktx": report["ktx2"]["tool"], "gltfExporter": f"Blender {report['blender']} bundled io_scene_gltf2"},
        "blendFiles": {"store": "assets-source/props/table-decor/blend (storage ruling pending, docs/blender-kit-project.md ruling 5)"},
        "budgets": {"trianglesPerKind": {k: v["low"] for k, v in report["triangles"].items()},
                    "highTrianglesPerKind": {k: v["high"] for k, v in report["triangles"].items() if v["high"] is not None},
                    "materials": len(reimport["materials"]), "texturePx": manifest["texturePx"], "textures": 4,
                    "drawCallsPerDressedRoom": 2, "glbBytes": reimport["glb_bytes"]},
        "lods": "LOD0 only: every prop is under 600 triangles; a dressed room merges its props into one mesh (one draw call) and its light pools, flame halos and contact shadows into one decal child (one more, src/world/table-decor.ts)",
        "bake": {**report["bake"], "ktx2": report["ktx2"]["encodes"]},
        "texelDensityPxPerM": report["texel_density_px_per_m"],
        "geometry": report["geometry"],
        "pivot": "each node's origin is the prop's base centre (runtime y = 0 is the table top)",
        "placement": "src/floor/table-decor.ts placeTableDecor, stream Stream.fromKey(`${seed}:table-decor`)",
        "derivedFiles": [entry(p) for p in sorted(rt.iterdir())],
        "sourceFiles": sources,
        "reviewEvidence": [entry(p) for p in evidence if p.exists()],
        "references": [{"path": "assets-source/style/locked/L-board-1.png", "sha256": sha256(ROOT / "assets-source/style/locked/L-board-1.png"),
                        "provider": "higgsfield", "note": "canonical Gilded Lamplight style board (docs/art-bible.md); no prop concept sheet exists"}],
        "materialsUsed": "brass reuses the approved P4-T3 brass-aged set (box-projected into the bake); walnut, wax, glazed ceramic, leather and paper are procedural in the generator",
        "license": "Original work generated in Blender from a checked-in script; style reference from Paul's paid Higgsfield plan (Terms of Use 4.4)",
        "reimport": {k: reimport[k] for k in ("per_kind", "materials", "checks", "pass")},
        "validation": {"pass": False, "date": datetime.date.today().isoformat(), "checks": []},
        "approvals": [
            {"gate": "concept", "status": "pending", "notes": "Paul's 2026-11-17 playtest request names candle, book and vase; no prop concept sheet was made"},
            {"gate": "technical", "status": "pending", "notes": "validate-generated-assets verdict is reported to the orchestrator, not self-recorded"},
            {"gate": "creative", "status": "pending", "notes": "assets-source/props/table-decor/table-decor.review-sheet.jpg"},
            {"gate": "rights", "status": "pending", "notes": "original procedural geometry; brass-aged set carries its own provenance"},
            {"gate": "owner", "status": "pending", "notes": "Paul approves the in-engine look (docs/blender-kit-project.md ruling 3)"},
            {"gate": "independent visual score", "status": "unscored", "notes": "blender-kit-pieces requires an independent >= 80/100 score; unscored means unaccepted"},
        ],
    }
    prov_path = src / "provenance.json"
    # The independent reviewer's score is theirs: a rebuild carries it over verbatim, never rewrites it.
    previous_text = prov_path.read_text() if prov_path.exists() else None
    if previous_text:
        previous = json.loads(previous_text)
        if "independentScore" in previous:
            prov["independentScore"] = previous["independentScore"]
    prov_path.write_text(json.dumps(prov, indent=2) + "\n")
    errors: list[str] = []
    warnings: list[str] = []
    check_decor(errors, warnings)
    remaining = [e for e in errors if "validation.pass" not in e]
    if remaining:
        if previous_text:
            prov_path.write_text(previous_text)
        else:
            prov_path.unlink()
        raise SystemExit("assemble refused, gate errors:\n" + "\n".join(remaining))
    prov["validation"] = {"pass": True, "date": datetime.date.today().isoformat(),
                          "checks": ["presence, no unlisted files", "hashes", "image-free glb, one single-sided material",
                                     "transform-free prop nodes (candle, three book arrangements, vase), each <= 600 tris and matching the manifest",
                                     "each prop stands on y 0 inside its table-decor.ts footprint",
                                     "ktx2 maps square, same size <= 1024, mipped, sRGB colour and linear data",
                                     "clean Blender reimport"]}
    prov_path.write_text(json.dumps(prov, indent=2) + "\n")
    print(f"wrote {prov_path.relative_to(ROOT)}")


def assemble(template: str) -> None:
    src = SOURCES / template
    rt = RUNTIME / template
    report = json.loads((src / "staging/report.json").read_text())
    reimport = json.loads((src / "staging/reimport.json").read_text())
    manifest = json.loads((rt / f"{template}.manifest.json").read_text())
    deps = GENERATOR_DEPS[template]
    derived = [
        {"path": str(p.relative_to(ROOT)), "sha256": sha256(p), "bytes": p.stat().st_size}
        for p in sorted(rt.iterdir())
    ]
    prov = {
        "pieceId": template,
        "version": 1,
        "route": "scripted",
        "generator": {"path": deps[0], "sha256": sha256(ROOT / deps[0])},
        "generatorDeps": [{"path": d, "sha256": sha256(ROOT / d)} for d in deps[1:]],
        "authoringAgent": {"harness": "claude-code (dispatched sub-agent)", "model": "claude-opus-5-5"},
        "blender": report["blender"],
        # The exporter that ran (build-room-kit.py records it); older reports name only the Blender version.
        "toolVersions": {"ktx": report.get("ktx2", {}).get("tool"),
                         "gltfExporter": report.get("gltf_exporter", f"Blender {report['blender']} bundled io_scene_gltf2")},
        "blendFiles": {
            "store": f"assets-source/rooms/{template}/blend (storage ruling pending, {BLEND_STORE_NOTE.get(template, 'docs/blender-kit-project.md ruling 5')})",
            "files": report.get("blend", {}),
        },
        "bake": {
            "device": report.get("device"),
            "lightmap": {**report.get("lightmap", {}), **report.get("lightmap_bake", {}), "size": report["lightmap_size"], "samples": report["samples"],
                         "pass": "DIFFUSE direct+indirect, colour off, metallic forced 0, OIDN",
                         "marginPx": report.get("lightmap_bake", {}).get("margin_px", 8), "islandPadPx": report.get("lightmap_bake", {}).get("island_pad_px", 10)},
            "books": report.get("books_bake"),
            "ktx2": report.get("ktx2"),
        },
        "budgets": {"triangles": reimport["triangles"], "materials": reimport["material_count"], "texturePx": reimport["texture_px"],
                    "highTriangles": report["high"]["triangles"], "glbBytes": report["glb_bytes"]},
        "texelDensityPxPerM": {"lightmap": report["low"]["lightmap_density"], "lightmapBySlot": report["low"]["lightmap_density_by_slot"]},
        "pivot": "floor centre, z = 0 (runtime y = 0)",
        "sockets": {k: manifest[k] for k in ("doors", "enemySockets", "lootSockets", "dressingSockets", "lightSockets", "probe")},
        "derivedFiles": derived,
        "stagingFiles": report.get("files", {}),
        "references": [{"path": r, "sha256": sha256(ROOT / r), "provider": "higgsfield", "note": REFERENCE_NOTES[template]} for r in REFERENCES[template]],
        "materialsUsed": "approved P4-T3 set (public/assets/materials), bound by slot name; not regenerated",
        "license": "Original work generated in Blender from a checked-in script; concept references from Paul's paid Higgsfield plan (Terms of Use 4.4)",
        "reimport": {k: reimport[k] for k in ("triangles", "material_count", "uv_layers", "embedded_images", "bounds_blender", "checks", "pass")},
        "validation": {"pass": False, "date": datetime.date.today().isoformat(), "checks": []},
        "approvals": APPROVALS[template],
    }
    if manifest.get("rigidNodes"):
        prov["rigidNodes"] = {"manifest": manifest["rigidNodes"], "lowPoly": report["low"].get("rigid_nodes"), "lightmap": report.get("rigid_lightmap"),
                              "reimport": reimport.get("rigid_nodes"), "gearMesh": report.get("gear_mesh"),
                              "shadowPolicy": "baked with the node invisible to shadow rays (Cycles visible_shadow off), so no static surface holds its shadow"}
    if template != "study":  # kit rooms bind their review evidence to the bytes shown
        prov["reviewEvidence"] = [{"path": str(p.relative_to(ROOT)), "sha256": sha256(p)} for p in
                                  [src / "staging/review-sheet.jpg", *sorted((ROOT / "docs/verification").glob(f"p5-rooms-{template}-*.jpg"))] if p.exists()]
    prov_path = src / "provenance.json"
    prov_path.write_text(json.dumps(prov, indent=2) + "\n")
    errors: list[str] = []
    warnings: list[str] = []
    check_room(template, errors, warnings)
    # The only error a not-yet-passed record may raise is its own pass flag.
    remaining = [e for e in errors if "validation.pass" not in e]
    if remaining:
        prov_path.unlink()
        raise SystemExit("assemble refused, gate errors:\n" + "\n".join(remaining))
    prov["validation"] = {"pass": True, "date": datetime.date.today().isoformat(),
                          "checks": ["presence", "hashes", "glb budgets", "uv1 on every primitive", "uv1 no overlap, gap >= 8 px", "image-free glb", "ktx2 size/mips/transfer", "manifest consistency", "clean reimport"]}
    prov_path.write_text(json.dumps(prov, indent=2) + "\n")
    print(f"wrote {prov_path.relative_to(ROOT)}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--assemble", metavar="TEMPLATE")
    parser.add_argument("--assemble-enemy", metavar="ENEMY")
    parser.add_argument("--staged-enemy", choices=ENEMY_MOVES_WITH_TIMING, action="append", default=[])
    parser.add_argument("--assemble-dice", metavar="DIE")
    parser.add_argument("--assemble-decor", action="store_true")
    args = parser.parse_args()
    if args.assemble:
        assemble(args.assemble)
    if args.assemble_enemy:
        assemble_enemy(args.assemble_enemy)
    if args.assemble_dice:
        assemble_dice(args.assemble_dice)
    if args.assemble_decor:
        assemble_decor()
    errors: list[str] = []
    warnings: list[str] = []
    rooms = sorted(p.name for p in RUNTIME.iterdir() if p.is_dir()) if RUNTIME.exists() else []
    if not rooms:
        print("asset-check: no runtime rooms")
    for room in rooms:
        s = check_room("hall", errors, warnings, room) if room == "hall-closed" else check_room(room, errors, warnings)
        glb = s.get("glb", {})
        sizes = ", ".join(f"{k} {v['width']}px" for k, v in s.get("maps", {}).items())
        print(f"asset-check {room}: {glb.get('triangles')} tris, {len(glb.get('materials', []))} materials; {sizes}")
    enemies = sorted(p.name for p in ENEMY_RUNTIME.iterdir() if p.is_dir()) if ENEMY_RUNTIME.exists() else []
    runpy.run_path(str(ROOT / "scripts/assets/build-sentry-patrol-contract.py"))["check_patrol"](errors)
    for enemy in enemies:
        if enemy == "cog-sentry-patrol":
            continue
        s = check_enemy(enemy, errors, warnings)
        glb = s.get("glb", {})
        print(f"asset-check enemies/{enemy}: {glb.get('triangles')} tris, {len(glb.get('materials', []))} materials, {s.get('bones')} bones, clips {s.get('clips')}")
    for enemy in args.staged_enemy:
        s = check_enemy(enemy, errors, warnings, staged=True)
        glb = s.get("glb", {})
        print(f"asset-check enemies/{enemy} staged: {glb.get('triangles')} tris, {s.get('bones')} bones, clips {s.get('clips')}")
    for enemy, (concept, height) in ENEMY_BASE_DRAFTS.items():
        check_enemy_base(enemy, concept, height, errors)
    dice = sorted(p.name for p in DICE_RUNTIME.iterdir() if p.is_dir()) if DICE_RUNTIME.exists() else []
    for die in dice:
        s = check_dice(die, errors, warnings)
        glb = s.get("glb", {})
        print(f"asset-check dice/{die}: {glb.get('triangles')} tris, {len(glb.get('materials', []))} materials, {glb.get('images')} images")
    if DECOR_RUNTIME.exists():
        s = check_decor(errors, warnings)
        sizes = ", ".join(f"{k} {v['width']}px" for k, v in s.get("maps", {}).items())
        print(f"asset-check props/table-decor: tris {s.get('perKind')}, {len(s.get('glb', {}).get('materials', []))} material; {sizes}")
    check_stairwell(errors)
    check_hidden_panel(errors)
    check_alchemy(errors)
    check_mechanism_kit(errors, "archive-kit")
    check_mechanism_kit(errors, "conservatory-specimens")
    check_mechanism_kit(errors, "commission-kit")
    check_mechanism_kit(errors, "calibration-kit")
    check_mechanism_kit(errors, "brass-key-kit")
    architectural = check_architectural_finishes(errors)
    if architectural:
        print(f"asset-check props/architectural-finishes: {architectural.get('triangles')} tris, {architectural.get('materials')} materials, {architectural.get('embeddedImages')} embedded images, {architectural.get('roots')} roots")
    check_stone_dungeon(errors)
    runpy.run_path(str(ROOT / "scripts/assets/pressure_works_check.py"))["check_pressure"](errors)
    for w in warnings:
        print(f"WARN {w}")
    for e in errors:
        print(f"FAIL {e}")
    print("asset-check: " + ("FAIL" if errors else "pass"))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
