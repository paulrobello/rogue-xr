# Phase 4 — Quest look proof

PRD: [P4](../PRD.md#p4--quest-look-proof). Gate: `make checkall`, plus `make asset-check` once P4-T4 adds it (budgets, hashes, file presence — folded into `checkall-ci`). Asset tasks run alongside Phases 1 to 3. Integration depends on [Phase 1](phase-1-greybox-floor.md) and [Phase 3](phase-3-xr-verbs.md).

Every asset task starts by invoking its owning workflow skill (PRD asset routing table) and reading `~/.claude/guides/game-assets.md` and `~/.claude/guides/blender-game-export.md`. Sources are immutable under `assets-source/<asset>/`; runtime copies are promoted to `public/assets/` only after the technical checks pass; each asset finishes with `validate-generated-assets`. Paid generation stays inside the PRD's slice asset list. Blender runs headless (`/Applications/Blender.app/Contents/MacOS/Blender -b --python-exit-code 1`) with deterministic seeds and the Blender version recorded; book host time per the host-load rules before bakes.

### P4-T1 — Style-reference board
- Depends on: P0-T1.
- Work: via `art` (Higgsfield `nano_banana_pro` / `gpt_image_2`), up to about 8 explorations of the warm-arcane-brass direction: palette (brass, walnut, candle gold, stained-glass jewel accents), painted brushwork for card art, card frame language, UI icon language. Assemble one board under `assets-source/style/` with prompts, model, seeds and provenance.
- Verify: Paul approves the board (owner gate, recorded by Paul, not self-recorded). D8: everything 2D after this is generated against it.

### P4-T2 — Concept sheets: hero room, automaton, combat table
- Depends on: P4-T1.
- Work: Higgsfield concept sheets against the style board — the hero room (study with gear shaft and stained-glass window), Cog Sentry automaton (front/side/back silhouette), the unfolding combat table (folded/unfolded states).
- Verify: provenance recorded; Paul picks one direction per sheet.

### P4-T3 — Core PBR material set
- Depends on: P4-T1.
- Work: via `create-tileable-pbr-materials`: aged brass, polished brass, walnut, worn stone floor, stained glass (emissive-capable), wallpaper. Higgsfield texture sources where useful, then Blender-derived maps: base color, tangent normal, packed ORM (AO R, roughness G, metallic B), emissive where used. Maps bound by exact role filename. KTX2 runtime copies with sizes recorded.
- Verify: seamless-tiling check and mip check per material; budgets recorded; `validate-generated-assets`.

### P4-T4 — Hero room template (lightmapped)
- Depends on: P4-T2, P4-T3, P1-T1.
- Work: via `create-modular-3d-assets` → `blender-kit-pieces`: checked-in generator `scripts/assets/build-room-study.py`, high and low `.blend` sources, low-poly UV0 for materials and a non-overlapping UV1 for the lightmap (at least 4 px padding), high-to-low bakes, Cycles lightmap bake (combined diffuse direct and indirect) at 1024 or 2048 px, `study.glb` + `study.lightmap.ktx2`, and a manifest entry matching the P1-T1 schema (doors, sockets, light sockets, probe, budgets). Add `make asset-check` (budget, hash and presence checks).
- Verify: reimport in clean Blender — triangles at most 100k, materials at most 16, textures at most 2048 px; high vs low fixed-view renders; `validate-generated-assets`.

### P4-T5 — Combat table asset
- Depends on: P4-T2, P4-T3.
- Work: via `create-modular-3d-assets` → `blender-kit-pieces`: brass and walnut table with an unfold rig (named nodes per leaf so the runtime animates the unfold), dice tray, draw and discard slots, sigil plate socket. glTF animation clip or node transforms for the unfold.
- Verify: reimport; budgets (at most 20k triangles, at most 4 materials); `validate-generated-assets`.

### P4-T6 — Rigged automaton #1 (Cog Sentry)
- Depends on: P4-T2.
- Work: via `create-rigged-character-assets`, authored in Blender: low-poly mesh at most 25k triangles, at most 4 materials, at most 40 bones, clips idle, attack, hit, death and a frozen pose (for the time freeze). Separate concept, model, rig and animation approvals per that skill.
- Verify: rig and clip checks per the skill; spawn, play, interrupt and despawn in the engine; `validate-generated-assets`.

### P4-T7 — Lightmap loader, light/probe rig, KTX2, precompile veil
- Depends on: P1-T3.
- Work: `world/lightmap.ts` binds `<template>.lightmap.ktx2` by exact filename to `material.lightMap` with `texture.channel = 1` and the manifest intensity; KTX2Loader with the transcoder self-hosted; at most 4 dynamic lights per room from light sockets plus the hand lantern; probe-based env map per room; load veil that precompiles every program (`renderer.compileAsync`) and spreads uploads over frames; images decoded with `createImageBitmap`.
- Verify: Vitest for binding by filename (no substring role inference) and light-socket budget enforcement; desktop render of a test GLB with a lightmap.

### P4-T8 — Performance instrumentation
- Depends on: P0-T2.
- Work: `createPerfGaugeWidget` on the wrist (dev toggle), frame-time logger (p50/p95/worst over 2 s windows, exported as JSON), framebuffer scale setting applied at session start, foveation 0.5 re-asserted each frame, a debug panel to pick scale.
- Verify: Vitest for the frame-stat aggregator; gauge visible in XR on desktop preview.

### P4-T9 — Integrate hero assets
- Depends on: P4-T4, P4-T5, P4-T6, P4-T7, P3-T3.
- Work: the study template replaces its greybox in floor generation; the table asset replaces the greybox table with its unfold animation; the Cog Sentry replaces its placeholder in exploration (idle, frozen pose) and combat (attack, hit, death driven by engine events).
- Verify: desktop full fight in the hero room; screenshot set in `docs/verification/`.

### P4-T10 — Physical: Quest measurement and owner look approval
- Depends on: P4-T8, P4-T9.
- Work: on Quest 3, measure exploration in the hero room and the worst combat view (table unfolded, Cog Sentry attacking, full fanned hand, two dice rolling, sigil plate up). Tune framebuffer scale and budgets. Record numbers in `docs/performance/`.
- Verify: exploration 72 Hz held, combat at 45 fps or above, numbers recorded with load and device state; Paul approves the look. Physical evidence only.
