# Phase 5 — Slice content

PRD: [P5](../PRD.md#p5--slice-content). Gate: `make checkall` + `make asset-check`. Depends on [Phase 3](phase-3-xr-verbs.md) and [Phase 4](phase-4-look-proof.md). 3D breadth (rooms, automatons, dice models) waits for P4-T10; 2D art batches need only the approved style board (P4-T1). Asset rules from Phase 4 apply to every task here.

### P5-T1 — Room templates: hall and corridor
- Depends on: P4-T10.
- Work: same route and contract as P4-T4 — entry hall and corridor templates with lightmaps and manifests.
- Verify: reimport budgets; `validate-generated-assets`; generator places them in a 1,000-seed property run.

### P5-T2 — Room templates: gear-shaft chamber and guardian vault
- Depends on: P4-T10.
- Work: same contract as P4-T4 — gear-shaft chamber (animated gear ring as a separate rigid piece) and the guardian vault.
- Verify: as P5-T1.

### P5-T3 — Automatons: Spring Hound and Bellows Golem
- Depends on: P4-T10.
- Work: `create-rigged-character-assets`, same budgets and clips as P4-T6.
- Verify: per-skill rig and clip checks; `validate-generated-assets`.

### P5-T4 — Elite and floor guardian
- Depends on: P4-T10.
- Work: Orrery Warden (elite) and Grand Escapement (guardian, larger budget: at most 40k triangles, at most 60 bones, plus a phase-change clip).
- Verify: as P5-T3.

### P5-T5 — Card illustrations and frames
- Depends on: P4-T1, P2-T2.
- Work: via `art` (Higgsfield) against the style board: 15 card illustrations, 3 card frames (attack, skill, sigil spell). Packed into a texture atlas (KTX2) with a JSON index; provenance per card.
- Verify: atlas budget (at most 2048 px per page); style consistency reviewed by Paul as one batch; `validate-generated-assets`.

### P5-T6 — UI icons, dice faces, sigil glyphs, title key art
- Depends on: P4-T1, P2-T4, P3-T5.
- Work: about 16 UI icons (steam, block, intents, statuses, cogs), 2 dice face sets, 5 sigil glyphs (matching the P3-T5 templates), title key art via `create-game-key-art`. Alpha via `image_background_remover`.
- Verify: icons legible at in-headset size (desktop check now, physical later); `validate-generated-assets`.

### P5-T7 — Dice models
- Depends on: P4-T3, P5-T6.
- Work: brass d6 and glass d8 via `blender-kit-pieces`, with face orientation metadata matching `content/dice.ts` so seeded-face correction knows each face's normal.
- Verify: Vitest that face normals in the GLB metadata match the dice definitions; budgets; `validate-generated-assets`.

### P5-T8 — Music and SFX
- Depends on: P0-T2.
- Work: `create-game-audio-assets` — Suno (per `~/.claude/guides/suno.md`) exploration loop and combat loop, mastered and loop-trimmed; ElevenLabs ~20 SFX (card draw, fling whoosh, card impact, dice roll and settle, sigil trace and cast, steam vent, gear clank, door, UI tick, automaton hit and death). `audio/` module: music state cues following the game state machine, positional SFX for impacts.
- Verify: loudness and loop-seam checks; `validate-generated-assets`; Vitest for state-to-cue mapping.

### P5-T9 — Title, reward, death and victory flow
- Depends on: P2-T5, P3-T7.
- Work: in-scene title (key art, New Run, seed entry, Continue, Workshop, Settings) built on `createMenuPanel`; reward screen (1 of 3 cards); death and victory screens summarizing the run and cogs earned.
- Verify: Vitest for flow transitions; desktop and XR walk-through.

### P5-T10 — Workshop and run snapshots
- Depends on: P1-T6, P2-T5.
- Work: workshop hub room (simple, reuses the study kit), 3 upgrades bought with cogs (e.g. +1 starting HP tier, start with an extra die, one extra card reward choice), IndexedDB persistence, run snapshot for resume (RNG stream states + run state), JSON export and import of saves.
- Verify: Vitest — upgrades persist across reload; snapshot resumes to an identical continuation; export→import round-trip.

### P5-T11 — Integrate card art and UI
- Depends on: P5-T5, P5-T6, P3-T2.
- Work: card meshes sample the atlas; batched text for names and costs; intent and status icons over automatons; dice faces applied.
- Verify: draw-count check (fanned hand at most 3 draws); desktop screenshot set.

### P5-T12 — Integrate rooms, automatons and dice
- Depends on: P5-T1, P5-T2, P5-T3, P5-T4, P5-T7.
- Work: all templates in the generator pool; all enemies with their models and clips; dice models in the Rapier presenter.
- Verify: 1,000-seed property run with final templates; desktop full run.

### P5-T13 — Physical: full run on Quest 3
- Depends on: P5-T8, P5-T9, P5-T10, P5-T11, P5-T12.
- Work: full seeded run on Quest 3 from title to workshop.
- Verify: budgets held (30 fps floor in exploration and combat, 72 Hz target) with numbers recorded; physical evidence only.
