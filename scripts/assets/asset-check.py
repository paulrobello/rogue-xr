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
GENERATOR_DEPS = {"study": ["scripts/assets/build-room-study.py", "scripts/assets/lightmap_helpers.py"]}
REFERENCES = {
    "study": [
        "assets-source/concepts/room-sheet-1.png",
        "assets-source/concepts/room-sheet-2.png",
    ]
}


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
ENEMY_GENERATORS = {"cog-sentry": "scripts/assets/build-cog-sentry.py"}
ENEMY_REFERENCES = {"cog-sentry": ["assets-source/concepts/sentry-sheet-1.png"]}


def check_enemy(enemy: str, errors: list[str], warnings: list[str]) -> dict:
    rt = ENEMY_RUNTIME / enemy
    src = ENEMY_SOURCES / enemy
    err = lambda msg: errors.append(f"enemies/{enemy}: {msg}")  # noqa: E731
    summary: dict = {"enemy": enemy}
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
    if glb["triangles"] > ENEMY_LIMITS["tris"]:
        err(f"{glb['triangles']} triangles over {ENEMY_LIMITS['tris']}")
    if len(glb["materials"]) > ENEMY_LIMITS["materials"]:
        err(f"{len(glb['materials'])} materials over {ENEMY_LIMITS['materials']}")
    if not 0 < bones <= ENEMY_LIMITS["bones"]:
        err(f"skeleton must be one skin with 1-{ENEMY_LIMITS['bones']} joints (got {bones})")
    if glb["images"] or glb["textures"]:
        err("GLB must be image-free (brass slots bind the shared P4-T3 sets by name)")
    if any("JOINTS_0" not in a or "WEIGHTS_0" not in a for a in attrs) or any("WEIGHTS_1" in a for a in attrs):
        err("every primitive needs exactly one JOINTS_0/WEIGHTS_0 set (<= 4 influences)")
    if clips != ENEMY_CLIPS or set(m.get("clips", {})) != ENEMY_CLIPS:
        err(f"clips {sorted(clips)} / manifest {sorted(m.get('clips', {}))} != {sorted(ENEMY_CLIPS)}")
    budget = m.get("budget", {})
    if budget.get("tris") != glb["triangles"] or budget.get("bones") != bones or budget.get("materials") != len(glb["materials"]):
        err(f"manifest budget {budget} != measured tris {glb['triangles']}, bones {bones}, materials {len(glb['materials'])}")
    unknown = [n for n in glb["materials"] if n not in m.get("materialSlots", {})]
    if unknown:
        err(f"GLB material slots missing from the manifest: {unknown}")
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
        elif r.get("max_influences", 9) > ENEMY_LIMITS["influences"] or r.get("unweighted_vertices", 1) or r.get("max_weight_sum_error", 1) > 2e-3:
            err("reimport skin checks failed")
    return summary


def assemble_enemy(enemy: str) -> None:
    src = ENEMY_SOURCES / enemy
    rt = ENEMY_RUNTIME / enemy
    report = json.loads((src / "staging/report.json").read_text())
    reimport = json.loads((src / "staging/reimport.json").read_text())
    manifest = json.loads((rt / f"{enemy}.manifest.json").read_text())
    gen = ENEMY_GENERATORS[enemy]
    entry = lambda p: {"path": str(p.relative_to(ROOT)), "sha256": sha256(p), "bytes": p.stat().st_size}  # noqa: E731
    sources = [entry(p) for p in sorted((src / "blend").iterdir()) if p.suffix == ".blend"]
    sources += [entry(src / "staging/report.json"), entry(src / "staging/reimport.json")]
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
        + [entry(p) for p in sorted((ROOT / "docs/verification").glob(f"p4-{enemy.split('-')[-1]}-*.jpg"))],
        "references": [{"path": r, "sha256": sha256(ROOT / r), "provider": "higgsfield", "note": "P4-T2 concept sheet picked for the Cog Sentry (docs/art-bible.md)"}
                       for r in ENEMY_REFERENCES[enemy]],
        "materialsUsed": "approved P4-T3 brass-polished and brass-aged sets bound by slot name at runtime; gunmetal and sentry-glow are factor-only",
        "license": "Original work generated in Blender from a checked-in script; concept reference from Paul's paid Higgsfield plan (Terms of Use 4.4)",
        "validation": {"pass": False, "date": datetime.date.today().isoformat(), "checks": []},
        "approvals": [
            {"who": "Paul", "when": "2026-11-15", "gate": "concept", "status": "approved", "evidence": "docs/art-bible.md: sentry-sheet-1.png picked for the Cog Sentry"},
            {"gate": "model", "status": "pending", "notes": f"assets-source/enemies/{enemy}/cog-sentry.review-sheet.jpg, MODEL section"},
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
            "store": "assets-source/rooms/study/blend (storage ruling pending, PRD project file section 1.5)",
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
        "references": [{"path": r, "sha256": sha256(ROOT / r), "provider": "higgsfield", "note": "P4-T2 concept sheets; room-sheet-1 picked (docs/art-bible.md)"} for r in REFERENCES[template]],
        "materialsUsed": "approved P4-T3 set (public/assets/materials), bound by slot name; not regenerated",
        "license": "Original work generated in Blender from a checked-in script; concept references from Paul's paid Higgsfield plan (Terms of Use 4.4)",
        "reimport": {k: reimport[k] for k in ("triangles", "material_count", "uv_layers", "embedded_images", "bounds_blender", "checks", "pass")},
        "validation": {"pass": False, "date": datetime.date.today().isoformat(), "checks": []},
        "approvals": [
            {"who": "Paul", "when": "2026-11-15", "gate": "concept", "status": "approved", "evidence": "docs/art-bible.md: room-sheet-1.png picked for the hero study"},
            {"gate": "creative", "status": "pending", "notes": "review sheet assets-source/rooms/study/staging/review-sheet.jpg"},
            {"gate": "owner", "status": "pending", "notes": "in-engine look approval (P4-T10)"},
        ],
    }
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
    args = parser.parse_args()
    if args.assemble:
        assemble(args.assemble)
    if args.assemble_enemy:
        assemble_enemy(args.assemble_enemy)
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
    for w in warnings:
        print(f"WARN {w}")
    for e in errors:
        print(f"FAIL {e}")
    print("asset-check: " + ("FAIL" if errors else "pass"))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
