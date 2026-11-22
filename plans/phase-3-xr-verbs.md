# Phase 3 — XR combat verbs

PRD: [P3](../PRD.md#p3--xr-combat-verbs). Gate: `make checkall`. Depends on [Phase 1](phase-1-greybox-floor.md) (world, locomotion) and [Phase 2](phase-2-combat-rules.md) (rules).

### P3-T1 — Encounter trigger, time freeze and table unfold
- Depends on: P1-T3, P2-T1.
- Work: proximity/touch trigger on an automaton, freeze exploration (enemy idle loops pause, dust motes slow), lock locomotion, unfold a greybox brass table at waist height in front of the seated player (aligned to the player's facing and calibrated height), place the encounter's automatons 2 to 3 m beyond it (D4). Reverse on combat end.
- Verify: Vitest for table placement math (faces player, clear of walls, enemies within the room's walkable bounds); desktop run-through.

### P3-T2 — Card fan in the off-hand and grab
- Depends on: P3-T1, P2-T2.
- Work: hand of up to 10 cards fanned on the off-hand controller grip (arc spacing scales with count), card hover highlight from the main-hand pointer, grab with the main-hand grip, card label text via troika batched text (one batch per hand).
- Verify: Vitest for fan layout; draw-count check that the fanned hand costs at most 3 draws.

### P3-T3 — Fling, aim assist and fallbacks
- Depends on: P3-T2.
- Work: release velocity from a smoothed controller velocity window; flick over a threshold plays the card at the nearest valid target within a 20° cone of the throw direction; point-and-trigger at a target as the always-available fallback; untargeted cards played by dropping them on the table; invalid play (insufficient steam) springs the card back to the fan.
- Verify: Vitest for target selection (cone, nearest, validity) and velocity smoothing against recorded controller traces.

### P3-T4 — Physical dice with seeded-face correction
- Depends on: P2-T4, P0-T2.
- Work: `dice/` Rapier 0.21.0 world (table surface + tray walls only), throw from the hand on release, settle detection (linear and angular velocity under threshold for N steps), seeded-face correction (D1): during settling, rotate about the contact point so the engine's result face is up, eased over about 100 ms; fixed-step simulation decoupled from frame rate.
- Verify: Vitest running Rapier headless — over 500 random throws, the face that ends up showing always equals the RNG result, and the correction completes within 100 ms of settle.

### P3-T5 — Sigil recognizer (pure)
- Depends on: P0-T3.
- Work: `sigil/` $P point-cloud recognizer (resample, scale, translate, greedy cloud match), 5 sigil templates authored as point sets, score normalized 0 to 1, mapping to a multiplier (D6): below the minimum score → 0.5, linear to 1.25 at a near-perfect trace.
- Verify: Vitest — reference traces of each sigil score at least 0.85; cross-sigil confusion stays below the minimum score; jittered traces degrade smoothly.

### P3-T6 — Sigil plate capture in XR
- Depends on: P3-T5, P3-T1.
- Work: a sigil card reveals a glowing plate above the table with a faint guide glyph; main-hand trigger draws a trail from the controller tip projected onto the plate; release scores and casts; the multiplier and a quality word appear in-scene.
- Verify: Vitest for trace projection; desktop mouse drawing uses the same scoring path.

### P3-T7 — Desktop equivalents
- Depends on: P3-T3, P3-T4, P3-T6.
- Work: mouse drag-and-flick for cards, click-to-throw dice with a randomized impulse, mouse sigil drawing — all through the action bus.
- Verify: full fight on desktop using only these verbs.

### P3-T8 — Physical: combat verbs on Quest 3
- Depends on: P3-T3, P3-T4, P3-T6.
- Work: full greybox fight seated with controllers.
- Verify: Paul's check of fling feel, dice readability and sigil drawability; combat measured at 30 fps or above, targeting 72 Hz; recorded as physical evidence.
