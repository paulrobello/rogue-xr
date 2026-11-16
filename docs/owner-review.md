# Owner review page

One page to clear the creative and owner gates that block cards. Written 2026-11-16 for Paul's check-in. Every status below is read from the asset's own `provenance.json`, review sheet or notes. Nothing here records an approval: answer by code and the answer gets recorded in the matching provenance file.

How to use it: open the review image or images in each row, then answer `A<n> approve` or `A<n> reject: <why>`. Answer decisions as `D<n>: <choice>`. An answer on a multi-gate row such as A9 covers every pending gate in that row. To answer one gate only, write `A9 model approve` (gate word first), and the rest stay pending. The D codes on this page are local to it. The PRD uses D1 to D10 for its own design decisions, which are a different list.

Gate words, as the provenance files use them. Concept: the concept sheet. Model, rig, animation: the three gates of an automaton. Creative: the look judged from the review sheet. Owner: the in-engine look. Technical and rights are checks agents run. "Independent score" is the second-opinion visual score (80 out of 100 or better) that the Blender asset skills require. It is `unscored` on every asset, which those skills treat as unaccepted. Author self-scores are the authoring agent's own estimate of fidelity to the concept and are not that score.

## Already cleared

Nothing to do here. Listed so the pending rows below make sense.

| What | Cleared on | Where recorded |
| --- | --- | --- |
| Art direction A "Gilded Lamplight", locked style board `L-board-1.png`, card layout, depth-portal card window | 2026-11-15 | [art-bible.md](art-bible.md), [assets-source/style/brief.md](../assets-source/style/brief.md) |
| Concept picks: hero study `room-sheet-1.png`, Cog Sentry `sentry-sheet-1.png`, combat table `table-sheet-1.png` | 2026-11-15 | [art-bible.md](art-bible.md), [assets-source/concepts/provenance.json](../assets-source/concepts/provenance.json) |
| Six core PBR materials (aged and polished brass, walnut, stone floor, stained glass, wallpaper): creative, rights and owner | 2026-11-15 | [assets-source/materials/README.md](../assets-source/materials/README.md), review images [p4-materials-live.jpg](verification/p4-materials-live.jpg) and [p4-materials-2x2.jpg](verification/p4-materials-2x2.jpg) |

## Assets awaiting approval

Counting rule: one row per thing you review as one decision, so the 15 card illustrations and 3 frames are one row and the two dice models are one row. 17 rows (A1 to A17), plus 4 automaton concept sheets (A18 to A21).

### Rooms

Review sheet = Blender reference next to an engine screenshot at the same camera. The room gates are one set per template: technical (verdict not recorded), creative, rights, owner, independent score `unscored`. Approving a room's creative and owner gates closes that room's part of P4-T4 and P5-T1/T2 and the G2 criterion in [verification.md](verification.md).

| Code | Asset | Review images | Self-score | Gates pending | Approving unblocks |
| --- | --- | --- | --- | --- | --- |
| A1 | Hero study (baked, desk and shelves, stained glass) | [review-sheet.jpg](../assets-source/rooms/study/staging/review-sheet.jpg), [p5-int-study.jpg](verification/p5-int-study.jpg), [p4-hero-1-explore-idle.jpg](verification/p4-hero-1-explore-idle.jpg) | none | creative, owner (concept approved 2026-11-15) | The P4-T10 look approval and the PRD rule that 3D breadth is gated on it. G2.6. |
| A2 | Hall | [review-sheet.jpg](../assets-source/rooms/hall/staging/review-sheet.jpg), [p5-int-hall.jpg](verification/p5-int-hall.jpg), [p5-rooms-hall-hero.jpg](verification/p5-rooms-hall-hero.jpg) | none | concept (no sheet exists, you decide whether one is needed, see D10), technical, creative, rights, owner | P5-T1 and the room gates for G2 |
| A3 | Corridor | [review-sheet.jpg](../assets-source/rooms/corridor/staging/review-sheet.jpg), [p5-rooms-corridor-hero.jpg](verification/p5-rooms-corridor-hero.jpg), [p5-rooms-corridor-lamp.jpg](verification/p5-rooms-corridor-lamp.jpg) | none | concept, technical, creative, rights, owner | P5-T1 |
| A4 | Gear shaft (rigid turning ring gear) | [review-sheet.jpg](../assets-source/rooms/gear-shaft/staging/review-sheet.jpg), [p5-int-gear-shaft.jpg](verification/p5-int-gear-shaft.jpg), [p5-rooms-gear-shaft-ring.jpg](verification/p5-rooms-gear-shaft-ring.jpg) | none | concept, technical, creative, rights, owner | P5-T2 |
| A5 | Guardian vault (brazier, reward eye) | [review-sheet.jpg](../assets-source/rooms/guardian-vault/staging/review-sheet.jpg), [p5-int-guardian-vault.jpg](verification/p5-int-guardian-vault.jpg), [p5-rooms-guardian-vault-brazier.jpg](verification/p5-rooms-guardian-vault-brazier.jpg) | none | concept, technical, creative, rights, owner | P5-T2 |

### Combat table and dice

| Code | Asset | Review images | Self-score | Gates pending | Approving unblocks |
| --- | --- | --- | --- | --- | --- |
| A6 | Combat table (unfolding leaves, tray, sigil plate socket) | [combat-table.review-sheet.jpg](../assets-source/props/combat-table/staging/combat-table.review-sheet.jpg), [engine-unfolded.jpg](../assets-source/props/combat-table/staging/engine-unfolded.jpg), [engine-player-view.jpg](../assets-source/props/combat-table/staging/engine-player-view.jpg) | none | Its `report.json` has no approvals block, so no gate is recorded for it beyond the concept pick (approved). The P4 look approval (owner) is the open gate. | P4-T5 close and the P4-T10 look approval |
| A7 | Dice models: brass d6 and glass d8, with face art from the UI atlas | [dice.review-sheet.jpg](../assets-source/dice/dice.review-sheet.jpg), [p5-dice-ingame-d6-closeup.jpg](verification/p5-dice-ingame-d6-closeup.jpg), [p5-dice-ingame-d8-closeup.jpg](verification/p5-dice-ingame-d8-closeup.jpg), [p5-dice-ingame-d6-tray.jpg](verification/p5-dice-ingame-d6-tray.jpg) | none | technical, creative, rights, owner (both dice) | P5-T7. Their dark read in the tray was fixed in F9 of [playtesting.md](playtesting.md), please judge the current shots. |

### Automatons

Each has four gates in its provenance: concept, model, rig, animation, plus the independent score (`unscored`). The review sheet has MODEL, RIG and ANIMATION sections to judge them. The fidelity-compare image puts orthographic renders of the low-poly model beside the concept at the concept's own scale. Approving model, rig and animation closes the asset's card (P4-T6, P5-T3, P5-T4) and the G2 criterion.

| Code | Asset | Review images | Self-score | Gates pending | Approving unblocks |
| --- | --- | --- | --- | --- | --- |
| A8 | Cog Sentry (regular, 2,992 tris) | [cog-sentry.review-sheet.jpg](../assets-source/enemies/cog-sentry/cog-sentry.review-sheet.jpg), [p4-sentry-idle.jpg](verification/p4-sentry-idle.jpg), [p4-sentry-attack.jpg](verification/p4-sentry-attack.jpg) | none | model, rig, animation (concept approved 2026-11-15) | P4-T6 and the P4-T10 look approval |
| A9 | Spring Hound (regular, 23,044 tris, 1.23 m) | [spring-hound.review-sheet.jpg](../assets-source/enemies/spring-hound/spring-hound.review-sheet.jpg), [spring-hound.fidelity-compare.jpg](../assets-source/enemies/spring-hound/spring-hound.fidelity-compare.jpg) | 67 of 100 (author, 2026-11-16). Gaps: ruby jewels are brass caps (4-material budget), glow reads peach, front skull narrow and dark, ears read as flaps | concept (A18), model, rig, animation | P5-T3 |
| A10 | Bellows Golem (regular, 9,400 tris, 2.06 m) | [bellows-golem.review-sheet.jpg](../assets-source/enemies/bellows-golem/bellows-golem.review-sheet.jpg) | none (no fidelity-compare image exists for it) | concept (A19), model, rig, animation | P5-T3 |
| A11 | Orrery Warden (elite, 24,794 tris, 2.64 m) | [orrery-warden.review-sheet.jpg](../assets-source/enemies/orrery-warden/orrery-warden.review-sheet.jpg), [orrery-warden.fidelity-compare.jpg](../assets-source/enemies/orrery-warden/orrery-warden.fidelity-compare.jpg), [p6-fullrun-SPIRE002-r3-warden.jpg](verification/p6-fullrun-SPIRE002-r3-warden.jpg) | 78 of 100 (author, 2026-11-16). Gaps: core reads peach not hot orange (see D11), sculpted head relief and engraving not modelled, cuirass dimmer than the concept | concept (A20), model, rig, animation | P5-T4 |
| A12 | Grand Escapement (guardian, 37,296 tris, 38 bones, 3.21 m, phase-change clip) | [grand-escapement.review-sheet.jpg](../assets-source/enemies/grand-escapement/grand-escapement.review-sheet.jpg), [grand-escapement.fidelity-compare.jpg](../assets-source/enemies/grand-escapement/grand-escapement.fidelity-compare.jpg), [p6-fullrun-SPIRE004-r7-guardian.jpg](verification/p6-fullrun-SPIRE004-r7-guardian.jpg) | 78 of 100 (author, 2026-11-16). Gaps: case lighter than the sheet's near-black mahogany, doors read as even amber pane, limb plates smooth, small sabatons | concept (A21), model, rig, animation | P5-T4. The phase-change clip is judged under D4. |

Modeling of A9 to A12 proceeded under your 2026-11-15 standing approval of spend and modeling. Their provenance files say that is not a concept, creative or owner approval.

### Card art, UI and brand

| Code | Asset | Review images | Self-score | Gates pending | Approving unblocks |
| --- | --- | --- | --- | --- | --- |
| A13 | Card illustrations (15) and frames (3: attack, skill, sigil), packed as four atlas pages | [p5t5-review-sheet.jpg](../assets-source/cards/p5t5-review-sheet.jpg), [p5-ui-fan-art.jpg](verification/p5-ui-fan-art.jpg), [p5-ui-holo-card-proof.jpg](verification/p5-ui-holo-card-proof.jpg), [p5-ui-combat-frame.jpg](verification/p5-ui-combat-frame.jpg) | none | creative, owner. The batch is one decision per P5-T5. Technical checks are done. Known issues from the agent's own review (repeated scenery in four layers, a tiny die inside the lucky-rivets plate ring, gear teeth on the cogstorm edge) are listed in [assets-source/cards/README.md](../assets-source/cards/README.md). | P5-T5 and P5-T11 |
| A14 | UI icons (16: resources, intents, statuses), dice face sets (2), sigil glyphs (5) | [p5-ui-review.png](verification/p5-ui-review.png), [p5-ui-icons-legibility.png](verification/p5-ui-icons-legibility.png), [p5-ui-dice-d6.jpg](verification/p5-ui-dice-d6.jpg), [p5-ui-dice-d8.jpg](verification/p5-ui-dice-d8.jpg) | none | technical verdict, creative, owner. Headset legibility is a separate check (D18). | P5-T6 |
| A15 | Title key art (no baked text, title-safe dark left wall) | [title-2048.jpg](../public/assets/ui/title-2048.jpg), [p5-flow-1-title.jpg](verification/p5-flow-1-title.jpg) | none | technical verdict, creative, owner | P5-T6 and P5-T9 look |
| A16 | Launch kit: brand mark, favicons, PWA icons, share image | [launch-icons.png](verification/launch-icons.png), [launch-favicon-16-32.png](verification/launch-favicon-16-32.png), [launch-og-image.png](verification/launch-og-image.png) | none | technical verdict, creative, owner | The release (P6-T4) |

### Audio

| Code | Asset | Review | Self-score | Gates pending | Approving unblocks |
| --- | --- | --- | --- | --- | --- |
| A17 | 20 ElevenLabs SFX (card draw, fling, impacts, dice, sigil, steam, gears, doors, UI, stingers) | Listen: the files are in [public/assets/audio/sfx/](../public/assets/audio/sfx/), measurements in [report.json](../public/assets/audio/report.json), prompts and gates in [assets-source/audio/README.md](../assets-source/audio/README.md) | none | creative (nobody has auditioned them in the live mix), rights (the API reported the Starter plan on 2026-11-16 and no provider-terms evidence is attached), owner. Technical passes for SFX, with 12 cues below -16 LUFS because of full-scale peaks over quiet bodies (flagged, not limited). | P5-T8 SFX half |

### Concept sheets (automatons)

All four have concept, creative, rights and owner pending. Approving a concept is also the concept gate of the model above it. Review all four on [p5-automatons-review-sheet.jpg](../assets-source/concepts/p5-automatons-review-sheet.jpg). Design notes and per-sheet inspection: [p5-automatons-design.md](../assets-source/concepts/p5-automatons-design.md).

| Code | Sheet | Image | Notes from inspection |
| --- | --- | --- | --- |
| A18 | Spring Hound (also the A9 concept gate) | [hound-sheet-1.png](../assets-source/concepts/hound-sheet-1.png) | Correct four-legged subject, no defects found |
| A19 | Bellows Golem (A10 concept gate) | [golem-sheet-1.png](../assets-source/concepts/golem-sheet-1.png) | Eyes are round lights, not slits. A flame plume above a chimney in the vent pose (the model uses an emissive mouth only, because the art bible rules out smoke) |
| A20 | Orrery Warden (A11 concept gate) | [warden-sheet-1.png](../assets-source/concepts/warden-sheet-1.png) | A stray partial Cog Sentry with a spear fades out below the front view (D9) |
| A21 | Grand Escapement (A12 concept gate) | [escapement-sheet-1.png](../assets-source/concepts/escapement-sheet-1.png) | Reads as a squat cabinet, not a tall longcase. The side view holds the anchor like a spear. The phase-two panel crops at the knees |

## Decisions waiting on Paul

"Source" names where the question is recorded. D21 sits in the art table and the headset checks are D14 to D20.

### Gameplay and balance

| Code | Question | Proposal or options | Evidence | Source | Answering unblocks |
| --- | --- | --- | --- | --- | --- |
| D1 | Is a coin flip on the elite the intended difficulty? | Keep as is. Or put more fights before the elite. Or lower the Orrery Warden's 92 hp or its numbers. | The elite stands on the route to the guardian on most floors. The planning bot beat it on 2 of the 3 counted floors that put it on the route (3 hp and 30 hp left) and on 46 percent of 490 replayed floors. The starter deck lost to it (warden at 32 of 92). | Q-FR1 in [playtesting.md](playtesting.md) | Balance pass before the Quest runs |
| D2 | Is a 4.5 percent win rate for a bot that plans every turn the intended slice difficulty? | Keep. Or lower the guardian's 160 hp. Or pair with D3. | Honest play beat the guardian on 2 of the 4 runs that reached it. 27 wins in 600 seeds. hp only falls across a run, and a 160 hp guardian takes 12 to 13 turns. The 4.5 percent was measured before treasure coffers opened. | Q-FR2 | Balance pass |
| D3 | What do rest rooms do? | Proposal: a one-use hearth that heals 30 percent of max hp. | The generator tags rooms with the role `rest` (`src/floor/generate.ts`) and nothing at runtime acts on it. Nothing on a floor restores hp. | Q-FR2 | Healing is the only way to lower D2's difficulty without touching numbers. Implementing it changes the full-run results. |
| D4 | Guardian phase 2 | Proposal: at 50 percent hp the Grand Escapement adds toll and overwind to its moves. Today it has a single move list that already contains both, so the proposal means moving them out of phase 1. | The 3.0 s `phase-change` clip exists in `public/assets/enemies/grand-escapement/grand-escapement.manifest.json` (event `open` at 1.0 s) and nothing in `src/` plays it. The rules engine has no phase mechanic. | [p5-automatons-design.md](../assets-source/concepts/p5-automatons-design.md) decision 3 | Wiring the clip, the rules change and golden-log regeneration. A12 animation gate. |
| D5 | Keep the debug readout (seed, room, draw calls, combat log, key help) in the shipped desktop build, or show it only under `?debug`? | Show only under `?debug`. | It draws on every desktop load and overlaps the HUD at some placements (`p6-fullrun-SPIRE004-r1-fight.jpg`). Hiding it also removes the only in-run display of the seed, because the title and end-of-run boards show the seed and nothing else does. A small seed label in the HUD would keep G5 visible. | Q-FR3, O8 | G6 note, release polish |
| D6 | Desktop status panel: keep the XR seat-facing turn or face the desktop camera? | Face the desktop camera. | It reads slightly skewed on the desktop (`p6-fullrun-SPIRE004-r7-guardian.jpg`). | Q-FR4, O9 | Desktop polish |
| D7 | Resolved, no decision needed: comfort vignette and teleport toggle. | Wired per PRD decision D7 in `cae9468`. | Settings has Turning and Teleport rows (teleport defaults off); the vignette is drawn while moving and composes with the hit flash; 9 emulator walk checks pass. Headset comfort is still unchecked and belongs with the headset checks below. | [verification.md](verification.md) G1.6 | P1-T7 comfort check means something |

### Art direction and assets

| Code | Question | Proposal or options | Evidence | Source | Answering unblocks |
| --- | --- | --- | --- | --- | --- |
| D8 | Approve or reject the four automaton concept sheets (A18 to A21), and amend the art-bible line? The bible says automatons are "slender, man-sized humanoids". | Approve and amend the line to: slender humanoids by default, with a quadruped, a squat bellows body and a clock-case guardian as roster exceptions. The sizes were chosen so each reads apart from the Sentry. | Built heights, measured from each GLB's bounds: Cog Sentry 1.96 m, Spring Hound 1.23 m (proposed 1.2), Bellows Golem 2.06 m (2.1), Orrery Warden 2.64 m to the ring top (2.6), Grand Escapement 3.21 m (3.2). | [p5-automatons-design.md](../assets-source/concepts/p5-automatons-design.md) decisions 1, 2, 4 | The concept gate of A9 to A12 |
| D9 | Orrery Warden sheet: accept the stray Sentry artifact as is, or retry? | Accept. The subject is correct and the artifact sits outside the panels. A retry costs 2 credits. | `warden-sheet-1.png` inspection note. Within the standing spend approval. | design notes decision 5 | A20 |
| D10 | Concept sheets for the four other rooms and the workshop: generate them, or accept the rooms as built in the study-kit language? | Your call. The PRD list allows 12 sheets (5 rooms, 5 automatons, table, workshop) with about 3 times that as retry headroom. Spend on art that follows the bible is pre-approved. | 10 concept sheet files exist: 6 from P4-T2 (two each for study, Sentry, table, of which you picked one each) and 4 from P5. That leaves 2 of the 12 on the PRD count. Hall, corridor, gear shaft, guardian vault and the workshop have no sheet. The workshop room is not built yet as its own asset. | design notes decision 6, room provenance `concept` gate | The concept gate of A2 to A5 |
| D11 | Automaton glow strength: keep `GLOW_STRENGTH` 0.7 or raise it? Cores read peach rather than hot orange. | Keep 0.7 for the slice. Higher values wash the core to cream or white under AgX tone mapping. Raising it needs a per-material exception or bloom. | `scripts/assets/build-cog-sentry.py` comment on `GLOW_STRENGTH`. Self-scores of the Hound, Warden and Escapement list the peach core as a gap. | A9, A11, A12 self-scores | The model gate of A9 to A12 |
| D12 | Suno music cues | Generate the two cues from the prompts and settings in the handoff, then save the WAVs as `assets-source/audio/music/explore.wav` and `combat.wav`. The loop build then runs on its own. | Music is owner-generated. The game logs `[audio] music not found (combat, explore): music stays silent` on every load (O1). | [SUNO-HANDOFF.md](../assets-source/audio/music/SUNO-HANDOFF.md) | P5-T8 music half, the O1 notice |
| D13 | ElevenLabs SFX rights | Confirm which plan the account is on and attach the provider terms, or state that the plan covers commercial game use. | The API reported the Starter plan on 2026-11-16 and no provider-terms evidence is attached. | A17, [assets-source/audio/README.md](../assets-source/audio/README.md) | The rights gate of A17 |
| D21 | Where do the raw card sources live? | Pick a storage: Git LFS, a separate asset repo, or an external store with a manifest. | `assets-source/cards/` holds 820 MB of raw provider downloads (127 files: composites, layers, cutouts), untracked, as the commit that added the atlas says: "stay out of git pending Paul's storage decision". `assets-source/cards/provenance.json` hashes them, but they exist only in this worktree. [blender-kit-project.md](blender-kit-project.md) ruling 5 also lists where `.blend` files are stored, and the authoring model for hero pieces, as pending. | Commit `831c3d2`, [blender-kit-project.md](blender-kit-project.md) | Rebuilding the card atlas from a clean checkout, and a trustworthy provenance record for A13 |

### Headset checks

These need the Quest 3. None has a recorded result. Open `https://spire.pardev.net` and append `?perf=1` to show the wrist frame-time gauge. Record the result per code.

| Code | Check | What to look at | Tunable if it fails | Source |
| --- | --- | --- | --- | --- |
| D14 | Fan feel | Off-hand fan sits just above the knuckles and does not clip the hand, readable at 1 to 10 cards. | `GRIP_FAN_ORIGIN [0, 0.13, -0.04]` | Commit `8b5d7f4` (fixed from your report, not re-checked) |
| D15 | Sigil trail and hint legibility | The 9 mm additive trail is visible on the plate while you trace. The hint "Hold the trigger and point at the plate" reads. The scores land in the expected range for a seated hand. | Trail width, plate size, `MIN_SCORE` margins (P3-T8 note) | `8b5d7f4` |
| D16 | Hit vignette comfort | The red edge vignette on a player hit is not uncomfortable. The OS reduced-motion preference softens it. There is no setting for it. | `src/combat-view/hit-feedback.ts` | `8208232` |
| D17 | Haptic strength | A block pulses at 0.25 for 50 ms. A hit pulses at 0.45 plus hp lost over 20, capped at 1, for 110 ms. A partial block is 0.8 of that. | `hapticFor` in `src/combat-view/hit-feedback.ts` | `8208232` |
| D18 | HP and status panel readability, and UI icon legibility at in-headset size | The panel sits up and left of the sigil plate and covers part of the left automaton at the Golem and two-Sentry placements (O11, XO6). Icons should read at about 2.5 cm on a panel 0.6 m away. | `STATUS_AT` in `src/combat/combat-session.ts` | [playtesting.md](playtesting.md) F8, O11. Images: [p6-fullrun-xr-fight-status.jpg](verification/p6-fullrun-xr-fight-status.jpg), [p6-fullrun-xr-enemy-turn-status.jpg](verification/p6-fullrun-xr-enemy-turn-status.jpg) |
| D19 | Treasure coffer reach and panel legibility | The 4 m ray reach, the beam ending on the coffer, the "+N cogs" or "New card" panel size, and the amber latch gem at Quest resolution. | Reach and panel size in `src/world/loot.ts` | F10 in [playtesting.md](playtesting.md). Image: [p6-treasure-xr-opened-SPIRE001.jpg](verification/p6-treasure-xr-opened-SPIRE001.jpg) (emulator) |
| D20 | Real Quest flick traces for the fling aim-assist criterion (P3-T3) | The recorded traces in `tests/fixtures/fling/` are synthetic. Throw a dozen cards at enemies and keep the controller poses so the 20 degree cone and the speed threshold can be tested on real data. No capture tool exists in the repository yet. | Cone, speed threshold, `DEFAULT_WINDOW_SECONDS` in `src/hand/velocity.ts` | `tests/fixtures/fling/generate.ts`; [verification.md](verification.md) G4.1 |

Also pending and in Paul's court, listed for completeness: the physical cards P0-T6, P1-T7, P3-T8, P4-T10, P5-T13 and P6-T4 in [verification.md](verification.md).
