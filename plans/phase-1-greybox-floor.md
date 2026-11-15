# Phase 1 — Greybox seeded floor and seated locomotion

PRD: [P1](../PRD.md#p1--greybox-seeded-floor-and-seated-locomotion). Gate: `make checkall`. Depends on Phase 0 ([phase-0-foundation.md](phase-0-foundation.md)).

### P1-T1 — Room-template manifest schema and greybox templates
- Depends on: P0-T3.
- Work: `content/rooms.ts` schema (validated at load): template id, footprint bounds, doors (local position, facing N/E/S/W, width), allowed placement rotations, enemy sockets, loot sockets, dressing sockets, light sockets (max 4), probe position, walkable bounds and wall colliders as simple boxes, budget fields (tris, materials, texture px). Five greybox templates built in code from the manifest (hall, corridor, study, gear-shaft chamber, guardian vault), same shape the Blender templates will use in P4/P5.
- Verify: Vitest — schema rejects malformed manifests (doors outside bounds, >4 light sockets); each greybox template validates.

### P1-T2 — Floor generator (pure)
- Depends on: P1-T1.
- Work: `floor/generate.ts(seed, params)` → floor graph: entry hall, 2 to 3 branching wings, 6 to 8 rooms, one guardian vault at the deepest wing, optional side rooms (treasure, rest) tagged. Grid-snapped placement with door matching and allowed rotations, no overlaps. Assigns enemy and loot to sockets from the `floor`, `loot` and `ai` streams. Output is plain data.
- Verify: property test over 1,000 seeds — all rooms reachable from the entry, exactly one guardian vault, no footprint overlaps, every door paired with a door or a sealed cap, deterministic output for a repeated seed (deep-equal).

### P1-T3 — World build and room streaming
- Depends on: P1-T2, P0-T2.
- Work: `world/` builds three.js rooms from generator output, instancing repeated dressing, keeping the current room plus its neighbours visible and hiding the rest (visible-only matrix updates per the webxr guide). Door crossing triggers the transition; enemy sockets show greybox automaton placeholders.
- Verify: Vitest for visibility-set logic; desktop screenshot of a seeded floor; draw-call counter readout under 200 in the worst greybox view.

### P1-T4 — Seated locomotion
- Depends on: P0-T2.
- Work: `xr/locomotion.ts` — thumbstick smooth move (head-relative), 30° snap turn default with smooth-turn option, comfort vignette during movement, teleport toggle (arc + landing validation against walkable bounds), seated height calibration on recenter (virtual standing eye height, default 1.6 m), wall collision against template box colliders.
- Verify: Vitest for snap-turn quantization, vignette ramp, teleport landing validation and collision resolution against a fixture room.

### P1-T5 — Desktop controls and debug title
- Depends on: P1-T3, P0-T3.
- Work: WASD + mouse-look exploration through the action bus; debug title with seed display and seed entry (8-char Crockford base32), "new random seed".
- Verify: Vitest for seed parse/format round-trip; manual desktop walk of a seeded floor from entry to guardian vault.

### P1-T6 — Settings persistence (IndexedDB)
- Depends on: P0-T3.
- Work: `persist/db.ts` — versioned IndexedDB store with `settings` (comfort options, turn mode, height, volume) and placeholder `workshop` and `run` stores; schema migration hook.
- Verify: Vitest with `fake-indexeddb` (pin the version when adding it) — write, reload, migrate.

### P1-T7 — Physical: seated exploration on Quest 3
- Depends on: P1-T3, P1-T4, P1-T5.
- Work: walk a seeded greybox floor seated on Quest 3.
- Verify: Paul's comfort check plus measured frame timing (target 72 Hz) recorded in `docs/verification.md` as physical evidence.
