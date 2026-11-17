# Goal verification (P6-T3)

Per-goal evidence for G1 to G6 in the [PRD](../PRD.md#goals). Every goal below has the same four parts: a criteria table with a status per criterion, then separate Browser evidence, Emulator evidence and Physical evidence subsections, then a status line. A criterion lists which evidence class can close it, and no row mixes classes.

| Field | Value |
| --- | --- |
| Written | 2026-11-16, about 04:00 PST |
| Build verified | `f32f508` (HEAD of `p0-foundation` and of `origin/main`) |
| CI at that build | The GitHub Actions run for `f32f508` concluded `success` (2026-11-16 03:42 PST). CI runs `make checkall-ci`: Biome, strict `tsc`, Vitest, production build, `make asset-check`, Gitleaks. Vitest was not rerun for this document. |
| Live site | `https://spire.pardev.net/version.json` returned HTTP 200 with commit `f32f508` and `builtAt` 2026-11-16 03:43 PST. That is an HTTP check of the deployed build. No browser render of the live site was taken for this document. |
| Headset evidence | None recorded. `docs/performance/` does not exist, and no file in the repository holds Quest frame times, adb captures or a headset verdict. The only physical observations are the informal ones from Paul's 2026-11-15 Quest playtest, quoted under G1 and G4. |

## Evidence classes

| Class | What it is | What it can close |
| --- | --- | --- |
| Browser | Vitest, the desktop full-run harness (`scripts/full-run/run.mjs`, `make full-run`), the desktop bug bash in [playtesting.md](playtesting.md), screenshots from headless Chromium on an Apple GPU, `make asset-check`. | Logic, rules, determinism, desktop playability, asset file budgets by count. |
| Emulator | The IWER walk (`scripts/xr-emu/walk.mjs`, `make xr-emu`) emulating a Quest 3 in headless Chromium. IWER applies neither foveation nor the framebuffer scale, so it records what the app requests. | Whether XR code paths run: session, input routing, boards, panels in view. Per the project rule it never closes a comfort, budget, frame-rate, readability or tracking criterion. |
| Physical | A person on a Quest 3 in Quest Browser, with measured numbers where a budget is involved. | Everything the two classes above cannot. |

Owner record means a recorded approval by Paul. It is not a measurement and is used only for the approval criteria.

Desktop frame numbers only rank variants. Only headset measurements close a budget criterion.

## Summary

| Goal | Status | Gap |
| --- | --- | --- |
| G1 Full seeded run on a Quest 3 | Partially met | The run loop is met on browser evidence. No recorded title-to-death-or-victory run on a physical Quest 3. Seated comfort is unchecked on a headset. The teleport toggle and the drawn comfort vignette are wired and pass the emulator walk, so only their comfort remains open. |
| G2 Premium, consistent look approved by Paul | Partially met | Direction, style board and the six core materials are approved. The in-engine look of rooms, automatons, cards, UI and dice is not approved, every model has model, rig and animation gates pending, and nothing was viewed at Quest resolution. See [owner-review.md](owner-review.md). |
| G3 72 Hz exploring, 45 fps floor in combat, measured on the headset | Not met | No headset measurement exists. |
| G4 The VR verbs are the fun | Partially met | Logic and desktop equivalents are met on browser evidence. Fling, dice and sigil feel on the headset is not met. The fling aim-assist criterion was checked against synthetic traces only. |
| G5 Reproducible from a visible, shareable seed | Met on browser evidence | None for the seed logic. The title and end-of-run boards show the seed and `?seed=` starts that run. There is no copy or share control, and during a run the seed shows only in the desktop debug readout. |
| G6 Fully playable on desktop with mouse and keyboard | Met on browser evidence | Verified in Chromium only. The debug readout shows on every desktop load (Q-FR3 in [playtesting.md](playtesting.md)). |

## G1: a complete seeded run on a physical Quest 3, seated, with controllers

Requires: title screen to death or victory in one seeded run, on a Quest 3, seated, with controllers. PRD acceptance that carries it: P0 "Physical: enters VR on Quest 3 from the HTTPS URL", P1 "Physical: comfortable seated locomotion", P5 "Physical: full run on Quest 3 holds the budgets", P6 "Paul plays two seeded runs on Quest 3 and accepts the slice".

| Criterion | Closed by | Status |
| --- | --- | --- |
| G1.1 The run loop works end to end: title, New Run, rooms, fights, reward, death or victory, workshop, next run | Browser | Met |
| G1.2 A run can end in victory | Browser | Met |
| G1.3 Run state survives a reload | Browser | Met |
| G1.4 The XR code paths for the loop run | Emulator | Emulator evidence only. The fights were ended with a debug key, not played out. |
| G1.5 A whole run on a physical Quest 3, title to death or victory | Physical | Not met |
| G1.6a Seated height calibration, 30 degree snap turn and smooth move work as logic | Browser | Met |
| G1.6b Seated comfort, drawn vignette, teleport toggle (PRD D7) | Physical | Not met. Both are wired (G1.6c), but nobody has worn them. Paul's seated run decides whether the vignette strength, the arc and the teleport feel are comfortable. |
| G1.6c The teleport toggle and the drawn comfort vignette work (PRD D7) | Emulator | Emulator evidence only |
| G1.7 Enter VR on Quest 3 from the HTTPS URL (P0-T6) | Physical | Not met (unrecorded) |

### G1 browser evidence

- Full-run harness, 2026-11-16 on `bfa26ee`, 6 runs, 0 assertion failures: 18 fights (14 won, 4 lost), 12 rewards, 2 victory boards, 4 death boards, 355 cards played with none failing, second New Run in the same page ([playtesting.md](playtesting.md), "Automated full run"). The treasure-coffer rerun on the tree at `55730ef` kept every fight outcome and added SPIRE003. The earlier bug bash played 8 runs across the 4 seed classes. The reports were written to `/tmp/full-run/` and are not committed.
- G1.2: SPIRE010 beats the guardian honestly (`p6-fullrun-SPIRE010-victory.jpg`; 2026-11-16 full run, hp 44, with the rest-room hearth and the guardian's phase 2 in place). SPIRE034 beat it before those two defaults (`p6-fullrun-SPIRE034-guardian-won.jpg`, commit `0d0f4c2`, which predates them) and now loses to the guardian with 58 of 160 left, because the guardian's phase-1 move list changed ([playtesting.md](playtesting.md) F12). The planning bot won 27 of 600 seeds (4.5 percent) before them. The offline replay over 400 seeds now gives 19 wins before, 39 (9.8 percent) with both defaults, 30 with the guardian rule alone and 23 with the hearth alone.
- G1.3: `tests/flow.test.ts` › "restores the same run and offer, and continues identically"; `tests/workshop.test.ts` › "resumes to an identical continuation through JSON and IndexedDB". Continue matched in every bug-bash run that reached a reward.
- G1.6a: `tests/locomotion.test.ts` › "lifts a seated head to the standing eye height", "fires exactly one 30 degree step per push and ignores sub-threshold input", "ramps in under 0.2 s, holds while moving and fades out over a few tenths".
- Other tests: `tests/flow.test.ts` › "walks title, workshop and settings and back", "a defeat goes to the death screen once, banks the purse once, and never fights again", "clearing the guardian room wins the run with the guardian purse", "every declared transition is reachable from the title"; `tests/desktop.test.ts` describe "desktop walk through a seeded floor" (`reaches the guardian vault of ${seed} from the entry through doors only`).
- Screenshots: `p6-fullrun-SPIRE002-reward.jpg`, `p6-fullrun-SPIRE001-death.jpg`, `p5-flow-1-title.jpg` through `p5-flow-9-new-run.jpg`, `p6-fullrun-SPIRE010-workshop.jpg`. Commits: `22eaa0c` (flow), `65ab87f` (workshop, snapshots, export), `de48407` (desktop full-run harness).

### G1 emulator evidence

Emulator evidence, not a headset run.

- G1.4: Enter VR starts an `immersive-vr` session, boards sit in front of the head, the seed keypad types a seed, three fights are won with the debug `K` key and rewards picked with the ray, a death comes from a real automaton hit, the workshop Buy spends cogs, New Run in the same `XRSession` rebuilds the floor, and Continue resumes after a reload. 52 of 52 checks passed after the walk fix in `f32f508` (10 consecutive full walks documented in [playtesting.md](playtesting.md)). The walk now has 82 checks and passes them all (2026-11-16, MiniMac, 0 failed, 0 console errors): the 59 of G1.6c below plus 17 rest-room checks (a real fight loses hp, the ray and trigger use the hearth, hp rises by the panel's `+N hp`, a second pull heals nothing, resume keeps it spent) and 6 guardian phase-1 checks. It now has 95 checks (2026-11-16, 0 failed, 0 console errors): 10 more walk the guardian's phase 2. A `?debug` hook leaves the guardian 1 hp above its threshold, a real card crosses it through `checkPhase`, and the walk asserts one `enemy-phase` event, the case held open at the clip's last pose through idle, frozen and attack, intents from the six-move list including toll, and the `guardian-2` music request ([scripts/xr-emu/README.md](../scripts/xr-emu/README.md)). Re-run on 02e65a1 (2026-11-16 15:25 PST, MiniMac): 95 of 95, 0 console errors, after two checks were updated for the H1 and H9 fixes in 8cd86ac: `rerun-floor-rebuild-in-xr` now captures the dead floor at the death board, because Return to title already swaps in a pristine floor, and `xr-rest-no-stale-panel-or-nodes` no longer counts break-apart debris, which sinks and disposes on its own clock.
- The committed [xr-emu-report.json](verification/xr-emu-report.json) holds the 95-check run. The 41-, 52-, 59- and 82-check reports were written to `/tmp` or the host's scratch directory and are cited from the docs only.
- G1.6: `xr-seated-recenter`, `locomotion-smooth-move` (2 m in 1 s) and `locomotion-snap-turn` (exactly 30 degrees twice) pass. Update 2026-11-16: 8cd86ac (H6) moved smooth move to the right stick, snap turn and teleport aim to the left stick, and made teleport default on. Update 2026-11-17 (F1): the sticks swapped back, left stick moves, right stick turns and aims the teleport, and the walk was updated to match.
- G1.6c (2026-11-16, MiniMac, walk of 59 checks, 0 failed, 0 console errors): the title's Settings board has a Turning row (Snap or Smooth) and a Teleport row (On or Off). `settings-teleport-toggle` and `settings-turn-toggle` press them with the ray and read the app's settings, the locomotion settings and the profile stored in IndexedDB. The comfort vignette is drawn as its own pass after the boards and before the hit flash. `locomotion-vignette-follows-motion`: strength 0 while still, 0.7 with the stick held (pass rendered 18 times in 300 ms), 0 again 1.2 s after release with no pass. `locomotion-vignette-edge-band`: with the vignette held at its cap, the outer band's mean luma is 0.42 of the same view without it and the centre box is identical. `locomotion-vignette-composes-with-hit`: the red hit flash held on top still adds red at the frame edge (5.3 percent of the band) and none at the centre. Teleport: `locomotion-teleport-invalid-stays` (an arc blocked by a wall draws dim red with no ring, releasing moves the head 0 m) and `locomotion-teleport-valid-moves` (the head lands 0 m from the landing the arc showed, `rig.position.y` stays 0.4, the vignette pulses to 0.63 and is 0 a second later). `locomotion-locked-in-combat`: with the table up, neither smooth move nor teleport moves the rig. Smooth move stays the default (`teleportEnabled` now defaults to false). Screenshots: `p6-teleport-aim.jpg`, `p6-teleport-invalid.jpg`, `p6-comfort-vignette-held.jpg`. Update 2026-11-16: 8cd86ac (H6) moved smooth move to the right stick, snap turn and teleport aim to the left stick, and made teleport default on. Update 2026-11-17 (F1): the sticks swapped back, left stick moves, right stick turns and aims the teleport, and the walk was updated to match.
- The emulator found XF1, XF2 and XO1 to XO4 (seated lift 1 m too high, Skip did nothing, rig height reset on New Run, update notice hidden under boards, no pointer ray), all fixed with tests per [playtesting.md](playtesting.md).
- Screenshots: `xr-emu-1-session-hands.jpg`, `xr-emu-2-title-hover.jpg`, `xr-emu-5-explore.jpg`, `xr-emu-6-fight.jpg`, `xr-emu-8-death-board.jpg`, `xr-emu-9-workshop.jpg`, `p6-fullrun-xr-title-after-turned-entry.jpg`.

### G1 physical evidence

- Recorded formally: nothing.
- Informal, from commit messages only: Paul played a Quest 3 fight on 2026-11-15 and reported defects that became commit `8b5d7f4` (21:34 PST: the card fan clipped the off hand and sigil tracing produced no trail) and commit `8208232` (22:06 PST: enemies attacked at once and hits had no visible effect). No verdict, no run length, and no re-check after the fixes were recorded. The commits do not say whether he used `https://spire.pardev.net` or an adb-reverse dev URL.
- Pending for Paul: P0-T6, P1-T7, P5-T13, P6-T4 in the table at the end of this file.

Status: partially met. Met on browser evidence for the run loop, and on emulator evidence for the teleport toggle and the drawn comfort vignette. Not met: a physical Quest 3 run and seated comfort, including how the vignette strength and the teleport feel.

## G2: premium look, one consistent style approved by Paul

Requires: baked-lit brass, walnut and stained-glass rooms, full-scale automatons, painted card art, one consistent style approved by Paul. PRD acceptance that carries it: P4 "hero room renders with its baked lightmap in desktop and XR", "Paul approves the look (owner gate, not self-recorded)", "every asset passes `validate-generated-assets`".

| Criterion | Closed by | Status |
| --- | --- | --- |
| G2.1 Art direction approved by Paul | Owner record | Met |
| G2.2 Core materials approved by Paul | Owner record | Met |
| G2.3 Rooms are baked-lit to the lightmap contract | Browser | Met. Banding on a headset is unchecked. |
| G2.4 Full-scale automatons are integrated | Browser | Met as integrated and rendering. Not a look approval. |
| G2.5 Painted card art is integrated | Browser | Met as integrated. Not a look approval. |
| G2.6 One consistent style approved by Paul across rooms, automatons, cards, UI, dice | Owner record | Not met |
| G2.7 Every asset passes `validate-generated-assets` | Browser | Not met as recorded |
| G2.8 The look at Quest resolution: readability, glow, banding | Physical | Not met |

### G2 browser evidence

- G2.1 (owner record): [art-bible.md](art-bible.md) records Paul's 2026-11-15 approval of direction A, the locked style board `L-board-1.png`, the card layout and the depth-portal card window. Commits `6860947`, `f134b4e` (concept picks: study, Cog Sentry, table).
- G2.2 (owner record): six PBR materials approved and rights cleared on 2026-11-15, commits `0dde2df` and `1851b00`. Review images [p4-materials-live.jpg](verification/p4-materials-live.jpg), [p4-materials-2x2.jpg](verification/p4-materials-2x2.jpg).
- G2.3: pipeline proof, commit `6e13269`: three.js against the Cycles reference gave a whole-frame luminance ratio of 0.994 ([p4-lightmap-proof.md](verification/p4-lightmap-proof.md), [p4-lightmap-proof-threejs.jpg](verification/p4-lightmap-proof-threejs.jpg)). Five baked templates ship (study, hall, corridor, gear-shaft, guardian-vault), each with a lightmap, and `make asset-check` passes in CI. Tests: `tests/lightmap-loader.test.ts` › "requests exactly <base>/<template>.lightmap.ktx2", "puts the texture on UV channel 1 as sRGB, unflipped"; `tests/room-study-asset.test.ts` › "binds its lightmap by exact filename on UV1 at pi x scale". Screenshots: `p4-hero-1-explore-idle.jpg`, `p5-rooms-corridor-hero.jpg`, `p5-rooms-gear-shaft-hero.jpg`, `p5-rooms-guardian-vault-hero.jpg`, `p5-rooms-hall-hero.jpg`, `p5-int-study.jpg`.
- G2.4: five rigged automatons are integrated: Cog Sentry 1.96 m, Spring Hound 1.23 m, Bellows Golem 2.06 m, Orrery Warden 2.64 m, Grand Escapement 3.21 m (each `staging/report.json`, `reimport.bounds`). Tests: `tests/hero-integration.test.ts` › "dresses each body with its own kind and keeps capsules for kinds without a model", "freezes on contact, swings on its attack, and dies before the win hands over". Screenshots: `p4-sentry-idle.jpg`, `p4-sentry-attack.jpg`, `p4-sentry-death.jpg`, `p6-fullrun-SPIRE002-r3-warden.jpg`, `p6-fullrun-SPIRE004-r7-guardian.jpg`. Commits `a0e5ef7`, `665edd9`, `dfa29bf`, `bfa26ee`, `779462a`, `7ae84dc`.
- G2.5: 15 illustrations and 3 frames packed into four atlas pages. Tests: `tests/card-atlas.test.ts` › "covers every slice card and its type", "ships every page as PNG and KTX2 at the declared size, at most 2048 px". Commits `831c3d2`, `77b439d`. Screenshots: `p5-ui-fan-art.jpg`, `p5-ui-holo-card-proof.jpg`, `p5-ui-card-text-after.jpg`.
- G2.6 (owner record): approvals recorded for the style board, materials and three concept picks. Pending: the in-engine look of the study and four other rooms, all five automatons (model, rig, animation), the combat table, card illustrations and frames, UI icons, dice faces, sigil glyphs, key art, dice models, SFX, and four automaton concepts. Full list with review images: [owner-review.md](owner-review.md).
- G2.7: `make asset-check` (presence, hashes against provenance, PRD budgets for rooms and enemies) passes in CI. The independent visual score that the Blender asset skills require is `unscored` in every provenance file, and "technical" is recorded as pending a verdict from the orchestrating session for the rooms, dice, UI and brand records.
- The author self-scores of the Hound (67), Warden (78) and Escapement (78) are fidelity estimates against the concept sheets, not approvals.

### G2 emulator evidence

Emulator evidence, not a headset run: two eye-buffer screenshots, `xr-emu-5-explore.jpg` and `xr-emu-6-fight.jpg`. No emulator check can close G2.8, because IWER runs at desktop resolution without foveation.

### G2 physical evidence

None recorded. Paul's approvals above are of the art direction and the materials in chat, not of anything seen on a headset. Pending: the P4-T10 look approval on a Quest 3, plus checks on glow (cores read peach at `GLOW_STRENGTH` 0.7 under AgX), room banding and icon legibility.

Status: partially met. Gap: no owner approval of the in-engine look, four automaton concepts unapproved, every model gate pending, no independent score, nothing seen on a headset.

## G3: frame pacing, measured on the headset

Requires: 72 Hz held while exploring (reprojection counts as a miss) and never below 45 fps in seated combat, measured on the headset. Budgets in the PRD: 13.9 ms exploring, at most 22 ms combat, at most 350k visible triangles per eye in the worst combat view, at most 200 draw calls, at most 4 dynamic lights per room plus the lantern.

| Criterion | Closed by | Status |
| --- | --- | --- |
| G3.1 Exploration holds 72 Hz on Quest 3 | Physical | Not met |
| G3.2 Combat at 45 fps or above in the worst view (table, automaton, fanned hand, rolling dice) | Physical | Not met |
| G3.3 Visible triangles and draw calls in the worst combat view | Physical | Not met |
| G3.4 Asset budgets by count (PRD Quest 3 table) | Browser (counts, not timing) | Met by count. Does not close G3. |
| G3.5 Dynamic-light and precompile discipline | Browser | Met as design checks only |
| G3.6 Measurement tooling exists | Browser, emulator | Tooling met. No numbers taken. |

### G3 browser evidence

- G3.3 desktop figures (headless Chromium, 60 Hz rAF cap), from the bug bash: at most 30 draw calls exploring, 58 in combat, 24 on the reward board, at most 15.2k triangles, no frame interval above 16.8 ms. They were taken on `d8c73e9`, when only the study, the Cog Sentry, the table, the dice, the cards and the UI were real assets. The hall, corridor, gear-shaft and vault rooms and the Hound, Golem, Warden and Escapement came later (commits `e9d9b60`, `1ea7ac2`, `665edd9`, `dfa29bf`), and the Escapement alone is 37,296 triangles now. The numbers are stale, rank variants only, and close nothing.
- G3.4: rooms: study 6,948 tris and 9 materials, hall 4,213 and 8, corridor 1,556 and 9, gear-shaft 4,434 and 8, guardian-vault 7,263 and 8, all with at most 2048 px textures (limits 100k, 16, 2048 px). Automatons: Sentry 2,992 tris, 21 bones, 4 materials; Hound 23,044, 33, 4; Golem 9,400, 22, 4; Warden 24,794, 31, 4 (limits 25k, 40 bones, 4); Grand Escapement 37,296 tris, 38 bones, 4 materials (guardian limits 40k, 60). Table 4,184 tris and 4 materials (limits 20k, 4). Sources: each `assets-source/**/provenance.json` `budgets` and `reimport` blocks, enforced by `python3 -I scripts/assets/asset-check.py` in `make checkall-ci`. Tests: `tests/sentry-asset.test.ts` › "meets the PRD automaton budgets: <= 25k triangles, <= 4 materials, <= 40 bones"; `tests/room-study-asset.test.ts` › "stays inside the PRD room budgets". The counts fit the limits and say nothing about frame time.
- G3.5: `tests/room-lights.test.ts` › "accepts exactly MAX_LIGHT_SOCKETS sockets and throws on one more", "is 4 room lights plus the lantern"; `tests/veil.test.ts` › "compiles every program before uploading, and uploads a few textures per frame".
- G3.6: `?perf=1` mounts the wrist gauge and a desktop panel with a frame-log download; 2 s windows with p50, p95 and worst; framebuffer scale options with 0.85 default and foveation 0.5 re-asserted every frame. Tests: `tests/perf.test.ts` › "emits a summary when a frame crosses the 2 s boundary", "reports the worst frame and fps for a steady 72 Hz run", "assertFoveation re-asserts 0.5 every presenting frame and is idle otherwise".

### G3 emulator evidence

Emulator evidence, not a measurement: `xr-foveation-medium` and `xr-framebuffer-scale` confirm the app requests foveation 0.5 and a 0.85 framebuffer scale. IWER applies neither, so this says nothing about frame time.

### G3 physical evidence

None recorded. `docs/performance/` does not exist. Pending: P4-T10 (exploring in the study and the worst combat view, with scale and light tuning), P5-T13 (full run) and P6-T1 (before and after numbers), recorded in `docs/performance/` with device and load state.

Status: not met. The gap is the entire headset measurement.

## G4: the VR verbs are the fun (fling, dice, sigils)

Requires: flinging cards, rolling real dice and drawing sigils each feel physical and readable. "Feel" and "readable" are physical judgments. PRD acceptance: P3 "Physical: flinging, dice and sigils feel readable seated", and the logic criteria below.

| Criterion | Closed by | Status |
| --- | --- | --- |
| G4.1 Aim assist snaps to the nearest valid target in a 20 degree cone, with point-and-trigger fallback and drop-on-table (P3-T3) | Browser | Met on synthetic traces. Real flicks not checked. |
| G4.2 Seeded-face correction always shows the RNG result, eased within 100 ms (P3-T4) | Browser | Met. Visibility of the correction on a headset (risk R4) is unchecked. |
| G4.3 Sigil recognizer scores each of the 5 reference traces at or above 0.85, with cross-sigil confusion below the minimum (P3-T5) | Browser | Met |
| G4.4 A full fight plays on desktop through the same actions | Browser | Met |
| G4.5 The XR fight verbs run: fan, sigil stage, trail, cast, enemy turns, hit flash | Emulator | Emulator evidence only. No check covers the card flick or the dice throw. |
| G4.6 The fan clears the hand | Browser | Met |
| G4.7 The fan fix and the sigil trace fix work on the headset | Physical | Not re-verified |
| G4.8 Fling, dice and sigils feel physical and readable on the headset (P3-T8) | Physical | Not met |

### G4 browser evidence

- G4.1: `tests/fling.test.ts` › "picks a target inside the 20 degree cone and rejects one outside", "picks the nearest target in the cone", "falls back to the pointing ray when the card is let go slowly", "plays when dropped on the table", "springs the card back with no target and no pointing ray". The velocity traces are synthetic: `tests/fixtures/fling/generate.ts` says "Traces are synthetic but shaped like Quest controller captures", although the describe block says "recorded traces". Commit `a7877fc`.
- G4.2: `tests/dice-physics.test.ts` › "lands 500 seeded throws on the RNG face with a correction of at most 100 ms", "reaches the same result at any frame rate", "rescues a die thrown clean out of the tray and puts it back inside on its target face". Desktop: 36 of 36 throws in the bug bash settled on the rules roll. Commits `5b2d894`, `79556ba`.
- G4.3: `tests/sigil.test.ts` › `${id}: every redraw scores at least 0.85 and is recognized as ${id}` and `${id} traces stay below MIN_SCORE against every other sigil` (one case per sigil id). Desktop mouse casts: 15 of 15 recognized as their own sigil, clean traces 0.96 to 1.00, jittered 0.80 to 0.89 ([playtesting.md](playtesting.md), "Sigil traces (desktop)"; `p6-sigil-bolt.jpg`, `p6-sigil-flame.jpg`, `p6-sigil-gear.jpg`, `p6-sigil-spiral.jpg`, `p6-sigil-ward.jpg`). Commit `1ea21c3`.
- G4.4: full-run harness, 97 sigils traced and 58 dice throws settled across 6 runs; 561 desktop drags in the bug bash, 481 played or staged (the rest were intended dice gating and the sigil soft-lock F2).
- G4.6: `tests/fan-hand-clearance.test.ts` › "the grip fan clears the hand at 1 to 10 cards, resting and raised, at every curl" (2,051 card-quad crossings before the fix, 0 after, 18.6 mm minimum gap), commit `8b5d7f4`.

### G4 emulator evidence

Emulator evidence, not a headset run. `xr-fan-in-off-hand`, `xr-sigil-stage`, `xr-sigil-hint`, `xr-sigil-trail` (trail pixels appear in the rendered XR frame), `xr-sigil-cast` (Masterful, 59 points), `xr-enemy-turns-sequential`, `xr-hit-flash-natural` and `xr-hit-vignette-visible` pass in the 52-check walk. `walk.mjs` has no card-flick check and no dice-throw check, so G4.1 and the dice half of G4.2 have no emulator coverage. `xr-sigil-stage` was flaky until the walk waited for XR frames after pose writes (commit `f32f508`). The 2026-11-16 rest-room and guardian-phase rules (F11, F12 in [playtesting.md](playtesting.md)) do not change any G4 criterion: no fling, dice or sigil code was touched, and the 82-check walk still passes `xr-sigil-stage` and the fight checks.

### G4 physical evidence

- Recorded formally: nothing.
- Informal, from commit messages: Paul's 2026-11-15 Quest playtest reported the fan clipping the off hand and sigil tracing producing no trail (commit `8b5d7f4`), and enemies attacking at once with no visible hit effect (commit `8208232`). Both were fixed. None of the fixes was re-checked on a headset in any recorded way. There is no recorded observation about fling feel or dice readability.
- Pending for Paul: P3-T8, and real flick traces for G4.1 (D20 in [owner-review.md](owner-review.md)).

Status: partially met. Logic, determinism and desktop equivalents are met on browser evidence. Not met: all feel and readability criteria on a headset, real controller flick traces for aim assist, and any emulator check of the flick and the dice throw.

## G5: every run reproducible from a visible, shareable seed

Requires: same seed gives the same floor, the same draws and the same dice results, from a seed the player can see and share. All criteria are device-independent logic, so browser evidence closes them.

| Criterion | Closed by | Status |
| --- | --- | --- |
| G5.1 Named RNG streams replay exactly and stay independent | Browser | Met |
| G5.2 Same seed gives the same floor, over 1,000 seeds | Browser | Met |
| G5.3 Same inputs give the same draws and the same combat log | Browser | Met |
| G5.4 Same seed gives the same dice results, and the physical die shows them | Browser | Met |
| G5.5 A run resumes to an identical continuation | Browser | Met |
| G5.6 The browser agrees with an offline replay | Browser | Met. The replay script is not committed. |
| G5.7 The seed is visible and shareable | Browser | Met. Sharing means reading the seed or the URL. |
| G5.8 The seed keypad works in XR | Emulator | Emulator evidence only. Legibility at Quest resolution is unchecked. |

### G5 browser evidence

- G5.1: `tests/core.test.ts` › "replays identical sequences for the same seed on every stream", "keeps streams independent of each other", "resumes the exact sequence from a snapshot". Commit `1b313b4`.
- G5.2: `tests/floor.test.ts` › "repeats exactly for a repeated seed and differs across seeds", "reaches every room from the entry", "places no two room footprints over each other", "pairs every door with an opposite door at the same spot, or seals it". Commit `52cac7d`.
- G5.3: `tests/golden.test.ts` › `${script.enemy} script is deterministic and ends decided` and the golden files `tests/golden/{cog-sentry,spring-hound,bellows-golem,orrery-warden,grand-escapement}.jsonl`. Commit `3c082db`.
- G5.4: `tests/rules-dice.test.ts` › "is deterministic per seed and differs across seeds", "the value the presenter receives is exactly the value the engine applies"; the 500-throw Rapier test under G4.
- G5.5: `tests/workshop.test.ts` › "resumes to an identical continuation through JSON and IndexedDB", "keeps a pending reward so resuming does not re-roll the loot stream"; `tests/flow.test.ts` › "restores the same run and offer, and continues identically".
- G5.6: the offline replay of the same policy against the real rules and generator matched the browser fight for fight on all five counted play seeds ([playtesting.md](playtesting.md)).
- G5.7: the title board shows "Seed XXXXXXXX" with a seed keypad and the end-of-run summary board shows the seed (`src/flow/panels.ts`); `?seed=` starts that run (`src/main.ts`); `tests/desktop.test.ts` › "round-trips random seeds through the display form", "maps look-alikes and rejects bad input". Screenshot: `p1-seed-title-SPIRE001.jpg`. During a run the seed shows only in the desktop debug readout, which is what Q-FR3 proposes to hide (D5 in [owner-review.md](owner-review.md)). No clipboard or share control exists.

### G5 emulator evidence

Emulator evidence: `seed-keypad` types `BRASS042` into the keypad board with the main-hand ray. Screenshot: `xr-emu-4-seed-keypad.jpg`.

### G5 physical evidence

None recorded and none needed for the seed logic. The one device-dependent part is reading the keypad and seed label at Quest resolution, which is unchecked.

Status: met on browser evidence. Player input still changes outcomes by design: rewards, sigil accuracy and the order of treasure pickups change what the `loot` stream yields, so "same seed" means same floor and same streams, not the same run.

## G6: fully playable on desktop with mouse and keyboard through the same actions

Requires: the whole game runs in a desktop browser through the same action bus.

| Criterion | Closed by | Status |
| --- | --- | --- |
| G6.1 The action bus is shared | Browser | Met |
| G6.2 A full run plays with real mouse and keyboard only | Browser | Met |
| G6.3 Every verb has a desktop equivalent | Browser | Met |
| G6.4 The desktop view frames and fits the HUD | Browser | Met |
| G6.5 Browsers other than headless Chromium | Browser | Not tested |

### G6 browser evidence

- G6.1: `tests/core.test.ts` › "delivers typed actions and unsubscribes". Commit `1b313b4`.
- G6.2: the full-run harness uses only mouse clicks and drags, mouse-drawn sigils, WASD, `T` and `E`, with no cheat or teleport ([playtesting.md](playtesting.md)). Results under G1.1.
- G6.3: card drag and drop (`via point`, `via drop`), click-to-throw dice, mouse sigils, coffer click, and the reward, workshop and title boards. In the bug bash 481 of 561 drags played or staged. The rest were the sigil soft-lock (F2, fixed) and the intended "Throw the dice first" gating.
- G6.4: `tests/desktop.test.ts` › "tilts the view down to the table while a fight runs and restores it after", "matches the three.js camera projection"; `tests/combat-session.test.ts` describe "desktop HUD fit". Screenshots: `p6-hud-SPIRE001-r2.jpg`, `p6-hud-BASH7000-r5.jpg`, `p3-desktop-fight-1-table.jpg`.
- G6.5: every desktop run used headless Chromium (Playwright) on Apple GPUs. Firefox and Safari were not exercised.

### G6 emulator evidence

Not applicable. G6 is a desktop goal.

### G6 physical evidence

Not applicable. No headset is involved.

Status: met on browser evidence. Open notes, none blocking: the debug readout draws on every desktop load and overlaps the HUD at some placements (O8, Q-FR3), the desktop status panel keeps its XR facing (O9, Q-FR4), and the music cues are missing so the game logs `[audio] music not found` and plays silent (O1).

## Physical checks still pending

None of these are recorded anywhere. They are the cards that carry the physical half of each goal. Record each result here, or in `docs/performance/` for numbers, with the build commit, the date in PST and the device state.

| Card | Check | Closes |
| --- | --- | --- |
| P0-T6 | Open `https://spire.pardev.net` in Quest Browser, press Enter VR, confirm brass hands and the title board | G1.7 |
| P1-T7 | Walk a seeded floor seated: comfort, snap turn, locomotion, with the teleport toggle on (Settings, Teleport) and off and the comfort vignette. Judge the vignette strength and the arc | G1.6b |
| P3-T8 | Fight seated with controllers: fan feel, fling, dice readability, sigil drawing, correction visibility, 45 fps floor | G4.7, G4.8, G4.2, G3.2 |
| P4-T10 | Measure exploring in the study and the worst combat view with `?perf=1`, tune scale, approve the look | G3.1, G3.2, G3.3, G2.6, G2.8 |
| P5-T13 | Full seeded run on Quest 3, title to workshop, budgets held, numbers recorded | G1.5, G3 |
| P6-T1 | Before and after headset numbers in `docs/performance/` | G3 |
| P6-T4 | Two seeded runs on Quest 3 and acceptance of the slice | G1.5 |
| P3-T3 follow-up | Capture real flick traces on the headset and replay them through `releaseVelocity` | G4.1 |

The individual headset checks Paul listed (fan feel, sigil trail and hint legibility, hit vignette comfort, haptic strength, HP panel readability, coffer reach and panel legibility) are D-coded in [owner-review.md](owner-review.md).

## Corrections noticed while writing this file

- [playtesting.md](playtesting.md), "Flow, audio and frame numbers", says the elites and the guardian "are still capsule placeholders". That was accurate at `d8c73e9` and is out of date: commits `dfa29bf` and `7ae84dc` put rigged models in for the Orrery Warden and the Grand Escapement, and the frame numbers in the same bullet predate them. This file was not edited here because it belongs to another owner.
- `docs/verification/xr-emu-report.json` is the 30-check run of 2026-11-15, not the 59-check run the README cites.
- [plans/phase-6-slice-release.md](../plans/phase-6-slice-release.md) P6-T3 asks for unverified criteria to be named as not met. They are, above.
