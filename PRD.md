# Clockwork Spire — Product Requirements

| Field | Value |
| --- | --- |
| Product | Clockwork Spire, a seated WebXR roguelike deckbuilder |
| Repo | `~/Repos/rogue-xr` (deploys to `spire.pardev.net`) |
| Owner | Paul Robello |
| Status | Planning — no implementation yet |
| Date | 2026-11-15 |

## Overview

Clockwork Spire is a first-person roguelike for Meta Quest 3 in Quest Browser. The player is an apprentice climbing a warm, candlelit, arcane-brass wizard tower that rebuilds itself every run. Each floor is a seeded, procedurally generated set of branching wings. The player explores in real time with smooth locomotion while seated. Touching a rogue automaton freezes time: a brass combat table unfolds at the player's seat and the fight is turn-based, played with a hand of cards held in the off-hand, physical dice rolled when a card asks for them, and spell sigils drawn in the air whose accuracy scales their power. A run lasts 15 to 20 minutes. Death or victory returns the player to a workshop where run currency buys permanent upgrades.

The first deliverable is a **vertical slice**: one floor at final visual quality, proving that the look, the VR verbs and the frame budget hold together on a Quest 3 before the game grows in breadth.

## Goals

1. G1 — A complete seeded run of the slice plays from title screen to death or victory on a physical Quest 3, seated, with controllers.
2. G2 — The look reads as premium: baked-lit brass, walnut and stained-glass rooms, full-scale automatons, painted card art, all in one consistent style approved by Paul.
3. G3 — Frame pacing holds 72 Hz while exploring and never drops below 45 fps in seated combat, measured on the headset.
4. G4 — The VR verbs are the fun: playing cards from the hand, rolling real dice and drawing sigils each feel physical and readable.
5. G5 — Every run is reproducible from a visible, shareable seed: same seed, same floor, same draws, same dice results.
6. G6 — The game is fully playable in a desktop browser with mouse and keyboard, running the same actions, for development and tests.

## Non-Goals (slice)

- Hand-tracking input (controllers first; hands come after the slice).
- PCVR or a high-quality desktop tier. Quest 3 standalone defines the bar.
- Cloud saves, accounts or a backend. Progress stays on the device.
- Multiplayer, leaderboards, daily-seed challenges.
- More than one floor, more than one act, or a full card pool.
- Custom-modeled mage gloves (the slice uses the toolkit hands retinted as brass gauntlets).
- A Playwright/IWER browser e2e suite (deferred until after the slice; see Phase gate).
- Standing locomotion design. The game is seated-only.

## Reference Projects

| Repo | Reused for |
| --- | --- |
| `mux-xr` → `packages/xr-workspace` (`@par/xr-workspace` 0.2.0) | XR session creation with medium fixed foveation (`createXrSession`), standard hands retinted (`createStandardHand`), pointer and button-edge helpers (`createPointer`, `createButtonEdges`, `createAxisRepeat`), radial and wrist menus, `createMenuPanel` for workshop/settings UI, `createPerfGaugeWidget` for the dev FPS readout, `keepAbove` for UI draw order, `findControl`/`controlId` for automated checks, `stageWorkspaceAssets` for fonts and hand models. Public exports only, never `/internal/*`. |
| `gogh-xr` | Quest 3 performance discipline (`~/.claude/guides/webxr.md`, Quest 3 section): fixed framebuffer scale chosen at session start, foveation 0.5 re-asserted per frame, program precompilation behind a veil, uploads spread over frames, `createImageBitmap` decode. Makefile shape. |
| `the-cube` | three.js + `@dimforge/rapier3d-compat` pairing, Vite + bun + Vitest gate, module-per-domain layout, object pooling. |
| `mux-xr` (app) | Vite/bun/Biome/TypeScript/Vitest toolchain versions, Makefile gate shape, new-version Reload notice, observatory Blender asset contract (`docs/blender-kit-project.md`) as the template for room-template contracts. |

## Architecture Direction

### Stack (pinned in plans, not manifests)

- Runtime: three.js **0.186.1** (exact; peer dependency of `@par/xr-workspace`), WebGL2, raw `WebXRManager`.
- Toolkit: `@par/xr-workspace` via `"file:../mux-xr/packages/xr-workspace"`; its `troika-three-text` 0.52.5 for SDF labels.
- Physics: `@dimforge/rapier3d-compat` **0.21.0**, used only for dice and the combat table surface.
- Tooling: bun 1.4.4, Vite 8.3.5, TypeScript 7.0.2 (strict), Biome 2.5.15, Vitest 5.0.3 + happy-dom 21.0.4, `@types/three` 0.186.0, `@types/webxr` 0.5.24.
- Asset tools: Blender 5.2.2 LTS (headless generators + Cycles bakes), Higgsfield CLI (images), Suno (music), ElevenLabs (SFX). KTX2 texture compression.
- Ports: 4260 dev (LAN + adb-reverse headset preview), 4261 production preview. Reserved in `~/.claude/used_ports.md`.

### Module layout (one domain per folder under `src/`)

| Module | Owns |
| --- | --- |
| `core/` | Seeded PRNG (one root seed, named sub-streams: `floor`, `deck`, `dice`, `loot`, `ai`), game state machine (title → explore → combat → reward → workshop), action bus shared by desktop and XR input. |
| `floor/` | Pure procedural floor generator: branching-wing room graph, template choice, door connections, dressing/loot/enemy placement. No rendering. |
| `rules/` | Pure, data-driven deckbuilder rules engine: cards, steam (energy), block, damage, statuses, enemy intents, dice-result hooks, sigil multiplier hooks. No rendering. Fully unit-tested. |
| `content/` | Data files: card definitions, enemy definitions and intent scripts, dice definitions, room-template manifest, workshop upgrades. |
| `world/` | Room-template loading, lightmap binding, dynamic-light budget, set dressing instancing, door/transition streaming. |
| `xr/` | Session, locomotion (smooth, snap turn, vignette, teleport toggle, seated height calibration), combat table, card fan, card grab-and-use with aim assist, dice presentation, sigil capture. |
| `desktop/` | Mouse/keyboard presentation of every action. |
| `sigil/` | $P point-cloud recognizer, templates, score → power-multiplier mapping. Pure. |
| `dice/` | Rapier world for dice, settle detection, throw-time look-ahead that numbers the die so it lands on the seeded face (settle correction as fallback). |
| `persist/` | IndexedDB saves (workshop progress, settings, in-progress run snapshot), JSON export/import. |
| `audio/` | Music state cues and SFX playback. |
| `ui/` | In-scene menus built on `@par/xr-workspace` panels; title screen, seed entry, reward and workshop screens. |

### Key design decisions (settled in the 2026-11-15 interview)

- **D1 — Dice are physical, results are seeded.** The `dice` RNG stream decides each roll's result. The die is thrown and simulated fully in Rapier. At the moment of release, a look-ahead runs the same throw to rest on a snapshot of the dice world (same fixed step and settle rule) and reads which face of the body lands up. The die is then numbered for that landing: its faces are relabelled by a rotation of the solid onto itself (a cube or octahedron symmetry), so the face that will land up carries the seeded number. The live die lands on the seeded number by itself and is left where it comes to rest, with no turn after it settles. A settle correction is kept as a fallback for a die that lands off its prediction (another die knocked it) or that a guard stops (it never comes to rest, or it leaves the tray). The fallback turns the die about its contact point to show the seeded face, easing in over about 100 ms. Replays and tests are deterministic.
- **D2 — Procedural floors from authored, baked room templates.** Blender produces 8 to 12 room templates for the full game (4 to 5 for the slice). Each template is fully lightmapped and baked. Procgen builds the branching-wing graph, chooses templates and their door orientation, and varies dressing, loot and enemies. Each room has at most 4 dynamic lights (candles, a hand-held lantern) and one baked environment probe. Rooms are built from swappable wall panels at fixed slots inside each baked template (Paul, 2026-11-17). A door slot takes a door frame or a plain wall panel, and later slots can take window or decoration panels. Every panel is baked in place, and the floor chooses which one shows. Different room sizes come from more templates built from the same panel kit, each baked offline. Rooms are not assembled at runtime, which keeps the baked lighting and the Quest frame budget.
- **D3 — Familiar rules, novel verbs.** 3 steam per turn, a hand of 5, visible enemy intents, standard block and damage. The novelty lives in how cards, dice and sigils are performed.
- **D4 — Full-scale foes.** Automatons stand at full scale 2 to 3 m beyond a waist-high brass table that unfolds at the seat. The table holds the draw and discard piles, the dice tray and the sigil plate.
- **D5 — Card play.** Cards fan in the off-hand controller. One verb for every card: grab it with the main-hand grip, then pull the trigger to use it; letting go of the grip puts it back in the hand. The trigger does nothing to a card still in the fan. A targeted card fires at the enemy the main hand aims at; aim assist snaps to the nearest valid target within a 20° cone of the aim, and a card with no target in reach stays held. A card with no target plays where it is. A sigil card is laid down by the trigger and opens the plate; each later trigger press draws a stroke and the glyph casts 0.6 s after the last release. A dice card plays and hands its die to the gripping hand; letting go throws it. Desktop: click a card to pick it up, click again to use it where the mouse aims, right click to put it back (Paul's playtest, 2026-11-17).
- **D6 — Sigils.** A sigil is traced in the air with the controller tip onto a glowing plate. A $P point-cloud recognizer scores it against the card's template. The score maps to a 0.5 to 1.25 power multiplier, and a trace below the minimum score fizzles to the 0.5 floor rather than failing outright.
- **D7 — Seated comfort.** The game is seated-only. Recenter calibrates a virtual standing eye height. Turning is a 30° snap by default with smooth turn as an option, a comfort vignette shows during locomotion, and teleport is a toggle.
- **D8 — One style board governs all 2D art.** A Higgsfield style-reference board (palette, brushwork, card frame) is approved first. Every card illustration, UI element and concept image is generated against it.
- **D9 — Desktop parity.** Every action is reachable from mouse and keyboard through the same action bus.
- **D10 — Device-local persistence.** IndexedDB holds saves and settings, with JSON export and import for backup.

### Lightmap contract (room templates)

The house Blender export guide has no lightmap section, so this project defines one:

- Every room template has a second UV set (glTF `TEXCOORD_1`) for lightmaps. It has no overlaps and at least 4 px of padding at its bake resolution.
- Cycles bakes combined diffuse direct and indirect light at 1024 or 2048 px per template. The bake is shipped as `<template>.lightmap.ktx2` beside `<template>.glb`, and is never embedded as an inferred material role.
- The loader binds it by exact filename to `material.lightMap` with `texture.channel = 1`, with intensity set from the template manifest.
- Dynamic lights affect only the dynamic objects (automatons, cards, dice, hands) plus a specular term on the room. Baked direct light is not double-counted. Metallic room surfaces, which have no diffuse term, reflect the baked irradiance as specular (weighted by metalness); the bake zeroes Metallic so the lightmap holds that irradiance.
- The template manifest lists, for each template: its doors (position, facing, width), its enemy and loot sockets, its dressing sockets, its light sockets, its probe and its budget figures.

### Quest 3 budgets (slice)

| Item | Budget |
| --- | --- |
| Exploration frame | 13.9 ms (72 Hz) held. Reprojection is counted as a miss |
| Combat frame | at most 22 ms (45 fps floor) |
| Framebuffer scale | chosen at session start (start at 0.85, adjust from measurements); foveation 0.5 re-asserted every frame |
| Visible triangles | at most 350k per eye, both eyes counted, in the worst combat view |
| Room template | at most 100k triangles, at most 16 materials, textures up to 2048 px KTX2 |
| Automaton | at most 25k triangles skinned, at most 4 materials, at most 40 bones |
| Floor guardian | at most 40k triangles skinned, at most 4 materials, at most 60 bones, plus a phase-change clip (plans/phase-5-slice-content.md P5-T4; only one guardian is on screen) |
| Draw calls | at most 200 per frame (no multiview, so every draw runs twice) |
| Dynamic lights | at most 4 per room, plus the lantern |
| Shaders | all programs precompiled behind the load veil; variants driven by uniforms |
| Uploads | big textures and buffers uploaded over several frames; images decoded with `createImageBitmap` |

Desktop numbers only rank variants. Only headset measurements close a budget criterion (`~/.claude/guides/webxr.md`).

### Asset pipeline and routing

| Asset class | Owning workflow | Execution |
| --- | --- | --- |
| Room templates, combat table, props, doors | `create-modular-3d-assets` | `blender-kit-pieces` (checked-in headless generator, high and low `.blend` sources, Cycles bakes, lightmap UV1, GLB + KTX2) |
| Automatons (rigged, animated) | `create-rigged-character-assets` | Blender (rig, skin, idle, attack, hit and death clips) |
| Dice models | `create-modular-3d-assets` | `blender-kit-pieces` |
| Brass, walnut, stone, glass materials | `create-tileable-pbr-materials` | Blender bakes plus Higgsfield texture sources |
| Style board, concept sheets, card illustrations, UI icons, dice faces, sigil glyphs | `art` (Higgsfield-first) | Higgsfield CLI `nano_banana_pro` / `gpt_image_2`; alpha via `image_background_remover` |
| Title key art | `create-game-key-art` | Higgsfield |
| Music cues | `create-game-audio-assets` + Suno guide (`~/.claude/guides/suno.md`) | Suno |
| SFX | `create-game-audio-assets` | `elevenlabs` |
| Release gate for every asset | `validate-generated-assets` | provenance, licensing, budgets, live-engine check |

Sources stay immutable under `assets-source/<asset>/`. Runtime copies are promoted to `public/assets/` only after the technical checks pass. Owner creative approval is recorded separately and is never self-recorded by an agent.

### Slice asset list (boundary of the standing spend approval)

Paid generation **inside this list** is pre-approved for the slice, with up to about 3 times the count as retry headroom. Anything outside it needs a new approval. On 2026-11-15 Paul widened this for art-direction work in chat: "All recommendations for art direction are approved, as well as any needed spend". Spend needed to produce art that follows the approved art bible (`docs/art-bible.md`) no longer needs a per-batch ask. Meshy is not authorized, because 3D models go through Blender.

| Provider | Assets | Count |
| --- | --- | --- |
| Higgsfield | Style-reference board explorations | ~8 |
| Higgsfield | Concept sheets: 5 room templates, 5 automatons, combat table, workshop | 12 |
| Higgsfield | Card illustrations | 15 |
| Higgsfield | Card frames (attack, skill, sigil spell) | 3 |
| Higgsfield | UI icons (steam, block, intents, statuses, currency) | ~16 |
| Higgsfield | Dice face sets (2 dice types) | 2 |
| Higgsfield | Sigil glyph designs | 5 |
| Higgsfield | Texture sources (stained glass, wallpaper, fabric, window vistas) | ~10 |
| Higgsfield | Title key art | 1 |
| Suno | Music cues (D12, 2026-11-16): title, explore, combat, reward, rest, elite, defeat, workshop, guardian phase 1 and 2, victory; list in `assets-source/audio/music/cues.json` | 11 |
| ElevenLabs | SFX (card draw, fling, impacts, dice, sigil, steam, gears, doors, UI) | ~20 |

## Phases

Each phase ends with the project gate green and something demonstrable. Physical Quest acceptance criteria are recorded separately from browser evidence and stay open until checked on the headset.

**Phase gate (P0 to P6):** `make checkall` = Biome lint, strict `tsc --noEmit`, Vitest, production build. `make checkall-ci` currently equals `checkall` plus Gitleaks. The Playwright + IWER e2e suite is deferred to post-slice (Open Question Q3).

### P0 — Foundation and deploy pipeline

Scope: repo scaffold, toolchain at pinned versions, Makefile with every standard target (`build`, `test`, `lint`, `fmt`, `typecheck`, `checkall`, `checkall-ci`, `dev`, `dev-start`, `dev-restart`, `dev-stop`, `preview`), the `@par/xr-workspace` file dependency with assets staged into `public/` as part of the build, an empty scene that runs both on desktop and in an immersive session, the seeded PRNG and action bus, CI, GitHub Pages deploy at `spire.pardev.net`, and the new-version Reload notice.

Acceptance:
- `make checkall` and `make checkall-ci` are green locally and in CI.
- CI checks out `paulrobello/mux-xr` at a pinned SHA as a sibling directory, so the `file:` dependency resolves.
- Desktop page shows a placeholder brass room. Enter VR starts a session with medium foveation and toolkit hands tinted brass.
- PRNG sub-streams are deterministic across runs (unit test).
- `spire.pardev.net` renders live in a browser (not merely an HTTP 200). The push and DNS steps need Paul's approval.
- Physical: enters VR on Quest 3 from the HTTPS URL.

### P1 — Greybox seeded floor and seated locomotion

Scope: the floor generator (branching wings, 6 to 8 rooms, door graph), greybox room templates with the same door and socket manifest shape as the final ones, room streaming and transitions, seated locomotion (smooth, 30° snap turn with smooth turn optional, vignette, teleport toggle, height calibration), desktop WASD and mouse, seed shown and entered on a debug title.

Acceptance:
- Same seed gives the same floor graph and placements (unit test over 1,000 seeds: every room reachable, no overlapping rooms, door pairs consistent).
- A seeded floor can be walked start to exit on desktop and in XR.
- Locomotion comfort options persist in IndexedDB.
- Physical: comfortable seated locomotion on Quest; exploration holds 72 Hz in greybox.

### P2 — Combat rules engine (desktop-playable)

Scope: the pure rules engine, the 15 slice cards as data, 3 regular automatons + 1 elite + 1 floor guardian with intent scripts, hooks for seeded dice results and sigil multipliers, a desktop debug combat view (mouse-playable), rewards (card choice, currency).

Can run in parallel with P1.

Acceptance:
- Unit tests cover every card, every enemy intent, steam, block, damage, statuses, and the dice and sigil hooks.
- Same seed and same inputs give an identical combat log (golden-log test).
- A full fight against each enemy can be won or lost on desktop.

### P3 — XR combat verbs

Scope: time-freeze and the combat table unfolding at the seat, full-scale greybox automatons, card fan in the off-hand, grab then trigger to use a card with 20° aim assist (letting go puts it back), Rapier dice with seeded-face correction, sigil plate capture with $P scoring and the multiplier mapping, desktop equivalents for all of these.

Depends on P1 (the world and locomotion) and P2 (the rules).

Acceptance:
- In Rapier unit tests, the seeded-face correction always shows the RNG result, with no visible snap above a 100 ms ease.
- $P recognizer tests: the reference traces of each of the 5 sigils score ≥ 0.85, and cross-sigil confusion stays below the minimum score.
- A full fight is playable in XR with controllers and on desktop through the same actions.
- Physical: card play, dice and sigils feel readable seated; combat stays ≥ 45 fps in greybox.

### P4 — Quest look proof

Scope: the approved style board, one hero room template authored, lightmapped and baked in Blender to the lightmap contract, the final combat table asset, one rigged and animated automaton, the core PBR material set (brass, walnut, stone, stained glass), the lightmap loader, a light and probe rig, and the performance instrumentation (perf gauge widget, frame-time logging, framebuffer scale and foveation settings).

Asset authoring can start alongside P1 to P3. Integration depends on P1 (world loading) and P3 (the table and the automaton's combat role).

Acceptance:
- Every asset passes `validate-generated-assets` (provenance, budgets, reimport checks, high vs low comparison).
- The hero room renders with its baked lightmap in desktop and XR.
- Physical: measured on Quest 3, the hero room holds 72 Hz exploring, and the worst combat view (table, automaton, fanned hand, rolling dice) stays at or above 45 fps. Numbers recorded in `docs/performance/`.
- Paul approves the look (owner gate, not self-recorded). 3D breadth work in P5 (rooms, automatons, dice models) does not start until it passes. 2D art batches need only the approved style board.

### P5 — Slice content

Scope: the remaining 3 to 4 room templates, 2 more regular automatons + the elite + the floor guardian, all 15 card illustrations and frames, UI icons, dice faces and models, 5 sigil glyphs, the title key art, 11 music cues (owner-generated in Suno, D12), about 20 SFX, the title screen with seed entry, the reward screen, death and victory flow, the workshop hub with 3 upgrades, run currency, a run snapshot for resume, and save export and import.

Depends on P3 and P4.

Acceptance:
- Every slice asset in the asset list is integrated and passes `validate-generated-assets`.
- A full run plays from title through workshop on desktop.
- Workshop upgrades persist across reloads and survive JSON export and import (unit and integration tests).
- Physical: full run on Quest 3 holds the budgets.

### P6 — Slice acceptance and release

Scope: a performance pass against the budgets, bug fixing, a playtest notes doc, release to `spire.pardev.net`, and a README status section that links to the PRD.

Acceptance:
- G1 to G6 each verified, with per-criterion evidence in `docs/verification.md`.
- Physical: Paul plays two seeded runs on Quest 3 and accepts the slice.

### Post-slice (not yet planned)

The full spire (number of floors and acts), hand tracking, custom mage gloves, a larger card and dice pool, more room templates, a Playwright/IWER e2e gate, and possibly a daily seed. See Open Questions.

Locks and consumables (Paul, 2026-11-17): some doors and chests are locked and open only with a key or an unlock spell. The player carries an inventory of single-use items and cards, separate from the deck. Keys are found or won and are spent on use. A lock-pick spell needs its sigil drawn on the lock and is gone once cast. The goal is to make backtracking worth doing.

The full card pool and the between-combat design (puzzles, optional paths, shortcuts, tasks) are planned in [docs/card-pool-and-exploration.md](docs/card-pool-and-exploration.md), with decisions CP1 to CP9 awaiting Paul. Draft, 2026-11-17.

## Risks

- **R1 — Quest frame budget.** Baked rooms plus skinned automatons plus transparent cards may exceed 13.9 ms. Mitigated by putting the P4 proof before content breadth, and by per-asset budgets.
- **R2 — Lightmaps on rotated templates.** Rotating a template when it is placed must not break baked light directions. Mitigated by baking world-independent lighting inside each template and restricting rotations to the door orientations the manifest permits.
- **R3 — Card aim feel.** Controller pointing is noisy at range. Mitigated by the 20° aim-assist cone around the aim, the point radius behind it, and tunable thresholds. Throw velocity no longer plays cards (D5), so its noise no longer matters.
- **R4 — Dice correction visibility.** If the seeded-face correction is visible it breaks trust. Mitigated since 2026-11-17 by numbering the die at the throw from a physics look-ahead, so it settles naturally on the seeded face; the eased settle correction remains only as a counted fallback. Headset check of the new presentation pending.
- **R5 — Sigil drawing with controllers.** Tracing in the air may be imprecise when seated. Mitigated by the forgiving score floor (0.5), large plate, and per-sigil tolerance tuning.
- **R6 — Art consistency across Higgsfield generations.** Mitigated by D8 (one style board) and owner review of the style board before any batch.
- **R7 — Sibling-repo dependency.** `@par/xr-workspace` is consumed via `file:../mux-xr`. CI must check it out at a pinned SHA, and a breaking toolkit change can stall this project. Mitigated by pinning the SHA and bumping it deliberately.
- **R8 — WebGL lacks multiview in three r186.** Every draw renders twice, so vertex and draw-call work doubles. Mitigated by the triangle and draw budgets, and by merging static dressing.
- **R9 — Program compile hitches.** A shader linked mid-session hitches visibly. Mitigated by precompiling behind the load veil.

## Open Questions

- **Q1** — How many floors and acts does the full 15 to 20 minute run have after the slice?
- **Q2** — Which workshop upgrades and unlock tree make up the full meta-progression?
- **Q3** — When does the Playwright/IWER e2e gate land (post-slice by default)?
- **Q4** — When does hand-tracking input come in, and what replaces the grip-and-trigger card use and the sigil gestures for it?
- **Q5** — Story framing: who is the apprentice, and why does the spire rebuild itself?
- **Q6** — Should the house Blender export guide adopt this project's lightmap contract once P4 proves it?
