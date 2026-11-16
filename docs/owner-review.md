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

## Answered by Paul on 2026-11-16

Paul's words are quoted. The rows are removed from the tables below. Work still in progress is named.

| Code | Answer | Recorded or acted on |
| --- | --- | --- |
| D1, D2 | "lower the hp (also add difficulty level selection so casual players dont struggle)" | Done in `392ee72`. Normal (the default) lowers the Orrery Warden from 92 to 69 hp and the Grand Escapement from 160 to 120. Casual also scales enemy hp, enemy damage by 0.85 and player hp by 1.2. Hard keeps the old numbers. Planning-bot replay: Hard 9.8 percent, Normal 26.5 percent, Casual 76.3 percent wins. |
| D3 | "approved" | One-use rest hearth, 30 percent heal, as shipped in `2990e46`. |
| D4 | "approved" | Guardian phase 2 at 50 percent hp, as shipped in `2990e46`. |
| D5, D6, D9, D10 | "yes to all Quick picks" | D5: debug readout only under `?debug` (`392ee72`). D6: the desktop status panel faces the desktop camera (`392ee72`). D9: the Orrery Warden sheet is accepted with its stray artifact. D10: the other rooms are accepted in the study-kit language, with no new room concept sheets. |
| D8 | "concepts look good amend the requirements to allow them" | Concept gate approved in `assets-source/concepts/provenance.json` and in the four enemy provenance files. The [art bible](art-bible.md) automaton line now names the four roster exceptions. This also clears A18 to A21 and the concept gate of A9 to A12. |
| D11 | "fix the glow" | Done in `ab14b81`: every automaton glow reads as saturated amber (images in `docs/verification/p6-glow-*.jpg`). Headset check pending. |
| D12 | "generate all needed suno music prompts and settings in order they are needed" | Done in `a32ab5d`: 11 cues in the order they are first heard, in [SUNO-HANDOFF.md](../assets-source/audio/music/SUNO-HANDOFF.md) and `cues.json`. Generating them in Suno is yours. |
| D13 | "all my plans are paid with commercial use" | ElevenLabs rights gate approved in `assets-source/audio/provenance.json` and the [audio README](../assets-source/audio/README.md). |
| D21 | "store the raw data on parnas1 in /Volumes/homes/game-data/rogue-xr" | 127 raw card files (825 MB) copied to parnas1. Every sha256 matched, and the hashes are in `assets-source/cards/raw-store.json`. The raw files are now gitignored. |
| Rest room | "the rest room is approved except the contents of the hearth look very flat add more detail" | Hall creative and owner gates approved in its rest-room role. The hearth coal bed was detailed in `e4f18cb` ([close-up](verification/p6-rest-hearth-closeup.jpg)) and waits on your look. |
| Audio review | "create a web page for all the audio auditions so i can review each" | Live at https://spire.pardev.net/audition.html (`b545342`). Export your verdicts there and paste them back. |

## Assets awaiting approval

Counting rule: one row per thing you review as one decision, so the 15 card illustrations and 3 frames are one row and the two dice models are one row. 17 rows (A1 to A17), plus 4 automaton concept sheets (A18 to A21).

### Rooms

Review sheet = Blender reference next to an engine screenshot at the same camera. The room gates are one set per template: technical (verdict not recorded), creative, rights, owner, independent score `unscored`. Approving a room's creative and owner gates closes that room's part of P4-T4 and P5-T1/T2 and the G2 criterion in [verification.md](verification.md).

| Code | Asset | Review images | Self-score | Gates pending | Approving unblocks |
| --- | --- | --- | --- | --- | --- |
| A1 | Hero study (baked, desk and shelves, stained glass) | [review-sheet.jpg](../assets-source/rooms/study/staging/review-sheet.jpg), [p5-int-study.jpg](verification/p5-int-study.jpg), [p4-hero-1-explore-idle.jpg](verification/p4-hero-1-explore-idle.jpg) | none | creative, owner (concept approved 2026-11-15) | The P4-T10 look approval and the PRD rule that 3D breadth is gated on it. G2.6. |
| A2 | Hall | [review-sheet.jpg](../assets-source/rooms/hall/staging/review-sheet.jpg), [p5-int-hall.jpg](verification/p5-int-hall.jpg), [p5-rooms-hall-hero.jpg](verification/p5-rooms-hall-hero.jpg) | none | technical, rights (concept not needed per D10; creative and owner approved as the rest room, hearth contents pending) | P5-T1 and the room gates for G2 |
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
| A9 | Spring Hound (regular, 23,044 tris, 1.23 m) | [spring-hound.review-sheet.jpg](../assets-source/enemies/spring-hound/spring-hound.review-sheet.jpg), [spring-hound.fidelity-compare.jpg](../assets-source/enemies/spring-hound/spring-hound.fidelity-compare.jpg) | 67 of 100 (author, 2026-11-16). Gaps: ruby jewels are brass caps (4-material budget), glow reads peach, front skull narrow and dark, ears read as flaps | model, rig, animation (concept approved, D8) | P5-T3 |
| A10 | Bellows Golem (regular, 23,474 tris, rebuilt in `6d7c5e6`) | [bellows-golem.review-sheet.jpg](../assets-source/enemies/bellows-golem/bellows-golem.review-sheet.jpg), [bellows-golem.fidelity-compare.jpg](../assets-source/enemies/bellows-golem/bellows-golem.fidelity-compare.jpg) | 66 (independent 59, bar 80) | model, rig, animation (concept approved, D8) | P5-T3 |
| A11 | Orrery Warden (elite, 24,794 tris, 2.64 m) | [orrery-warden.review-sheet.jpg](../assets-source/enemies/orrery-warden/orrery-warden.review-sheet.jpg), [orrery-warden.fidelity-compare.jpg](../assets-source/enemies/orrery-warden/orrery-warden.fidelity-compare.jpg), [p6-fullrun-SPIRE002-r3-warden.jpg](verification/p6-fullrun-SPIRE002-r3-warden.jpg) | 78 of 100 (author, 2026-11-16). Gaps: core reads peach not hot orange (see D11), sculpted head relief and engraving not modelled, cuirass dimmer than the concept | model, rig, animation (concept approved, D8) | P5-T4 |
| A12 | Grand Escapement (guardian, 37,296 tris, 38 bones, 3.21 m, phase-change clip) | [grand-escapement.review-sheet.jpg](../assets-source/enemies/grand-escapement/grand-escapement.review-sheet.jpg), [grand-escapement.fidelity-compare.jpg](../assets-source/enemies/grand-escapement/grand-escapement.fidelity-compare.jpg), [p6-fullrun-SPIRE004-r7-guardian.jpg](verification/p6-fullrun-SPIRE004-r7-guardian.jpg) | 78 of 100 (author, 2026-11-16). Gaps: case lighter than the sheet's near-black mahogany, doors read as even amber pane, limb plates smooth, small sabatons | model, rig, animation (concept approved, D8) | P5-T4 |

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
| A17 | 20 ElevenLabs SFX (card draw, fling, impacts, dice, sigil, steam, gears, doors, UI, stingers) | Listen: the files are in [public/assets/audio/sfx/](../public/assets/audio/sfx/), measurements in [report.json](../public/assets/audio/report.json), prompts and gates in [assets-source/audio/README.md](../assets-source/audio/README.md) | none | creative (nobody has auditioned them in the live mix), owner (rights cleared, D13). Technical passes for SFX, with 12 cues below -16 LUFS because of full-scale peaks over quiet bodies (flagged, not limited). | P5-T8 SFX half |

## Decisions waiting on Paul

Only the headset checks D14 to D20 remain. D7 is listed as resolved.

### Resolved

| Code | Question | Proposal or options | Evidence | Source | Answering unblocks |
| --- | --- | --- | --- | --- | --- |
| D7 | Resolved, no decision needed: comfort vignette and teleport toggle. | Wired per PRD decision D7 in `cae9468`. | Settings has Turning and Teleport rows (teleport defaults off); the vignette is drawn while moving and composes with the hit flash; 9 emulator walk checks pass. Headset comfort is still unchecked and belongs with the headset checks below. | [verification.md](verification.md) G1.6 | P1-T7 comfort check means something |

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
