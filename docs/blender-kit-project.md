# Clockwork Spire — Blender kit project file

Project file for the user-level `blender-kit-pieces` skill. Rules here win over the skill. Sections follow `references/project-contract.md`. The game-level contract (budgets, asset routing, slice asset list) is in [PRD.md](../PRD.md).

## 1. Owner rulings

1. 2026-11-15: Room templates are authored and lightmapped in Blender. Procedural generation arranges whole templates and never re-lights them (PRD D2).
2. 2026-11-15: Paid generation is pre-approved only inside the PRD's slice asset list. Meshy is not authorized.
3. 2026-11-15: Paul approves the style board, the concept direction and the in-engine look himself (PRD P4). Agents never record an approval.
4. Fleet renderer policy: EEVEE for renders, and Cycles only for texture and lightmap bakes, which have no EEVEE equivalent (`~/.claude/guides/infra-gate-runners.md`, "Blender on fleet hosts").
5. Pending: where `.blend` files are stored, and the authoring model for hero pieces. Both are asked before P4-T4 begins.

## 2. Agent policy

At most one Blender asset agent at a time. Pipeline fixtures (for example `room-proof`) need no reference approval: they exist to prove the toolchain and never ship. `authoringAgent` in provenance names the session or the model.

## 3. Frame and pivot

Units are metres. Blender is Z-up, and runtime (x, y, z) = Blender (x, z, −y). A room template's pivot is the centre of its floor at z = 0. Doors open on the template's ±X and ±Y edges (manifest schema P1-T1).

## 4. Seams

Doors match by width and centre line. A template is never decimated at a door frame.

## 5. Textures

- Material maps: `<piece>.<channel>.png` for albedo (sRGB), normal and ORM (linear; R = AO, G = roughness, B = metallic), and emissive (sRGB).
- Lightmaps: `<template>.lightmap.png` (KTX2 once the encoder is installed). The values are scaled irradiance stored with the sRGB transfer function. The runtime binds the file to `material.lightMap` on UV channel 1, with `lightMapIntensity` taken from the manifest. The full contract is in the PRD under "Lightmap contract".
- Texel density targets: lightmap 32 to 64 px/m on walls and floors. Material texel density is set per piece in P4.

## 6. Budgets

As in the PRD Quest 3 table: a room template has at most 100k triangles, 16 materials, and textures up to 2048 px. A lightmap is 1024 or 2048 px.

## 7. Deliverables

A checked-in generator under `scripts/assets/`, staged outputs under `assets-source/<piece>/staging/`, and runtime copies promoted to `public/assets/rooms/` after the gate. Pipeline fixtures promote to `public/assets/fixtures/` only.

## 8. Paths

| What | Path | Committed |
| --- | --- | --- |
| Generators and helpers | `scripts/assets/` | yes |
| Staging, reports, renders | `assets-source/<piece>/staging/` | yes (small files); EXR intermediates no |
| Runtime files | `public/assets/rooms/`, `public/assets/fixtures/` | yes |
| Friction log | `docs/asset-friction.md` | yes |

## 9. Commands

`BLENDER=/Applications/Blender.app/Contents/MacOS/Blender` (5.2.2 LTS on MacDaddy, 5.3.0 on MiniMac; each report records the version). Build: `"$BLENDER" -b --factory-startup --python-exit-code 1 -P scripts/assets/<generator>.py -- --out <dir> [--skip-bake] [--device GPU|CPU]`. Bakes run on a booked host.

## 10. Gate table

`make asset-check` validates the asset chain, manifests, and format and budget requirements. `make checkall-ci` includes it alongside the runtime checks and secret scanner.

## 11. Runtime loader

three.js 0.186.1 `GLTFLoader`. No meshopt or quantization yet. Lightmaps load through `TextureLoader` (`KTX2Loader` once encoded) in `src/world/lightmap.ts`. A template that fails to load falls back to its greybox.

## 12. Runtime couplings

Each template's manifest entry (doors, sockets, colliders) is used by the floor generator (P1-T2) and by locomotion collision (P1-T4).

## 13. Review and provenance

The review sheet is an engine screenshot beside the Blender reference render at the same camera. Provenance lives in `assets-source/<piece>/staging/report.json`.
