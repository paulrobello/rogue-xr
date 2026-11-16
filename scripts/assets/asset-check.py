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
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / "public/assets/rooms"
SOURCES = ROOT / "assets-source/rooms"
LIMITS = {"tris": 100_000, "materials": 16, "texture_px": 2048, "light_sockets": 4}
LIGHTMAP_SIZES = {1024, 2048}
KTX2_MAGIC = b"\xabKTX 20\xbb\r\n\x1a\n"
KHR_DF_TRANSFER_LINEAR, KHR_DF_TRANSFER_SRGB = 1, 2
# Generator and the helpers it imports; provenance pins their hashes.
_KIT_DEPS = ["scripts/assets/build-room-kit.py", "scripts/assets/room_kit.py", "scripts/assets/build-room-study.py",
             "scripts/assets/lightmap_helpers.py", "scripts/assets/build-cog-sentry.py"]
GENERATOR_DEPS = {"study": ["scripts/assets/build-room-study.py", "scripts/assets/lightmap_helpers.py"], "hall": _KIT_DEPS, "corridor": _KIT_DEPS,
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
RIGID_REQUIRED = {"gear-shaft": {"gear-shaft_gear_ring"}}


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


def ktx2_header(path: Path) -> dict:
    data = path.read_bytes()
    if data[:12] != KTX2_MAGIC:
        raise ValueError(f"{path.name}: not KTX2")
    vk_format, _type_size, width, height, _depth, _layers, _faces, levels, scheme = struct.unpack_from("<9I", data, 12)
    dfd_offset = struct.unpack_from("<I", data, 48)[0]
    # DFD: total size (4), block header (8), then colorModel, colorPrimaries, transferFunction.
    transfer = data[dfd_offset + 4 + 8 + 2]
    return {"vkFormat": vk_format, "width": width, "height": height, "levels": levels, "supercompression": scheme, "transfer": transfer}


def check_room(template: str, errors: list[str], warnings: list[str]) -> dict:
    rt = RUNTIME / template
    src = SOURCES / template
    err = lambda msg: errors.append(f"{template}: {msg}")  # noqa: E731
    summary: dict = {"template": template}

    manifest_path = rt / f"{template}.manifest.json"
    if not manifest_path.exists():
        err("manifest missing")
        return summary
    m = json.loads(manifest_path.read_text())
    if m.get("template") != template or m.get("id") != template:
        err("manifest template/id does not match its directory")
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
    if errors and any(e.startswith(f"{template}: missing") for e in errors):
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
            if r.get("axis") != [0, 1, 0] or not r.get("radPerSec", 0) > 0:
                err(f"rigid node {r['node']} needs axis [0, 1, 0] and a positive radPerSec")
        summary["rigidNodes"] = [r["node"] for r in rigid]
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
        rel = f"public/assets/rooms/{template}/{name}"
        if rel not in recorded:
            err(f"{rel} not recorded in provenance")
        elif recorded[rel] != sha256(rt / name):
            err(f"{rel} hash differs from provenance")
    for dep in prov.get("generatorDeps", []) + [prov.get("generator", {})]:
        path = ROOT / dep.get("path", "")
        if not path.exists():
            err(f"generator file {dep.get('path')} missing")
        elif sha256(path) != dep.get("sha256"):
            warnings.append(f"{template}: {dep['path']} changed since the build (stale; rebuild before re-review)")
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
        "materials_used": "approved P4-T3 brass-polished and brass-aged sets bound by slot name at runtime; gunmetal and sentry-glow are factor-only",
        "evidence_glob": ("docs/verification", "p4-sentry-*.jpg"),
        "concept": {"who": "Paul", "when": "2026-11-15", "gate": "concept", "status": "approved", "evidence": "docs/art-bible.md: sentry-sheet-1.png picked for the Cog Sentry"},
    },
    "spring-hound": {**_P5_META, "materials_used": "approved P4-T3 brass-polished and brass-aged sets bound by slot name at runtime, each sampled "
                                                   "at one texel (constant UV) and tinted by its manifest slot tint [0.87, 0.75, 0.78] (linear "
                                                   "multiplier); gunmetal (gunmetal and ruby from COLOR_0) and hound-glow are factor-only"},
    "bellows-golem": {**_P5_META, "materials_used": "approved P4-T3 brass-polished set bound by slot name at runtime; golem-case (walnut, pleats from COLOR_0), golem-metal (gunmetal and emerald from COLOR_0) and golem-glow are factor-only"},
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


def check_enemy(enemy: str, errors: list[str], warnings: list[str]) -> dict:
    rt = ENEMY_RUNTIME / enemy
    src = ENEMY_SOURCES / enemy
    err = lambda msg: errors.append(f"enemies/{enemy}: {msg}")  # noqa: E731
    summary: dict = {"enemy": enemy}
    limits, want_clips = enemy_limits(enemy)
    files = {f"{enemy}.glb", f"{enemy}.manifest.json"}
    for name in sorted(files):
        if not (rt / name).exists():
            err(f"missing runtime file {name}")
    extra = sorted(p.name for p in rt.iterdir() if p.name not in files)
    if extra:
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
    if clips != want_clips or set(m.get("clips", {})) != want_clips:
        err(f"clips {sorted(clips)} / manifest {sorted(m.get('clips', {}))} != {sorted(want_clips)}")
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
    reimport = src / "staging/reimport.json"
    if not reimport.exists():
        err("staging/reimport.json missing")
    else:
        r = json.loads(reimport.read_text())
        if not r.get("pass") or r.get("glb_sha256") != sha256(rt / f"{enemy}.glb"):
            err("reimport gate did not pass for the shipped GLB")
        elif r.get("max_influences", 9) > limits["influences"] or r.get("unweighted_vertices", 1) or r.get("max_weight_sum_error", 1) > 2e-3:
            err("reimport skin checks failed")
    return summary


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
DICE_FACES = {
    "brass-d6": {"kind": "d6", "half": 0.02, "values": list(range(1, 7)),
                 "normals": [(0, 1, 0), (1, 0, 0), (0, 0, 1), (0, 0, -1), (-1, 0, 0), (0, -1, 0)]},
    "glass-d8": {"kind": "d8", "half": 0.026, "values": list(range(1, 9)),
                 "normals": [((-1 if i & 4 else 1) * _S3, (-1 if i & 2 else 1) * _S3, (-1 if i & 1 else 1) * _S3) for i in range(8)]},
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
        "lods": "LOD0 only: a 40 mm die stays under 700 triangles, so a LOD chain saves nothing measurable",
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
        "toolVersions": {"ktx": report.get("ktx2", {}).get("tool"), "gltfExporter": "Blender 5.2.2 bundled io_scene_gltf2"},
        "blendFiles": {
            "store": f"assets-source/rooms/{template}/blend (storage ruling pending, {BLEND_STORE_NOTE.get(template, 'docs/blender-kit-project.md ruling 5')})",
            "files": report.get("blend", {}),
        },
        "bake": {
            "device": report.get("device"),
            "lightmap": {**report.get("lightmap", {}), **report.get("lightmap_bake", {}), "size": report["lightmap_size"], "samples": report["samples"],
                         "pass": "DIFFUSE direct+indirect, colour off, metallic forced 0, OIDN", "marginPx": 8, "islandPadPx": 10},
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
                              "reimport": reimport.get("rigid_nodes"),
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
    parser.add_argument("--assemble-dice", metavar="DIE")
    args = parser.parse_args()
    if args.assemble:
        assemble(args.assemble)
    if args.assemble_enemy:
        assemble_enemy(args.assemble_enemy)
    if args.assemble_dice:
        assemble_dice(args.assemble_dice)
    errors: list[str] = []
    warnings: list[str] = []
    rooms = sorted(p.name for p in RUNTIME.iterdir() if p.is_dir()) if RUNTIME.exists() else []
    if not rooms:
        print("asset-check: no runtime rooms")
    for room in rooms:
        s = check_room(room, errors, warnings)
        glb = s.get("glb", {})
        sizes = ", ".join(f"{k} {v['width']}px" for k, v in s.get("maps", {}).items())
        print(f"asset-check {room}: {glb.get('triangles')} tris, {len(glb.get('materials', []))} materials; {sizes}")
    enemies = sorted(p.name for p in ENEMY_RUNTIME.iterdir() if p.is_dir()) if ENEMY_RUNTIME.exists() else []
    for enemy in enemies:
        s = check_enemy(enemy, errors, warnings)
        glb = s.get("glb", {})
        print(f"asset-check enemies/{enemy}: {glb.get('triangles')} tris, {len(glb.get('materials', []))} materials, {s.get('bones')} bones, clips {s.get('clips')}")
    dice = sorted(p.name for p in DICE_RUNTIME.iterdir() if p.is_dir()) if DICE_RUNTIME.exists() else []
    for die in dice:
        s = check_dice(die, errors, warnings)
        glb = s.get("glb", {})
        print(f"asset-check dice/{die}: {glb.get('triangles')} tris, {len(glb.get('materials', []))} materials, {glb.get('images')} images")
    for w in warnings:
        print(f"WARN {w}")
    for e in errors:
        print(f"FAIL {e}")
    print("asset-check: " + ("FAIL" if errors else "pass"))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
