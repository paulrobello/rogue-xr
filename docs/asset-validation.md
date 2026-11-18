# Asset validation sweep

Run 2026-11-17 (PST) on MacDaddy, against the worktree at HEAD 4fc29fa. Method: the `validate-generated-assets` skill applied to the nine slice assets. Four gates per asset: technical, rights, creative, owner. A gate is only `pass` with evidence, and missing evidence is `fail`. Nothing here records an approval. Quoted owner words are copied from files in the repo.

## Commands run

| Command | Exit | Result |
| --- | --- | --- |
| `python3 -I scripts/assets/asset-check.py` | 0 | `asset-check: pass`. Covers 5 rooms, 5 enemies, 2 dice. Does not cover the combat table or the UI set |
| `python3 -I /tmp/fb17/validate/hashes.py <12 provenance.json files>` (recomputes every `path`+`sha256`, name-to-hash map and `bytes` entry) | 0 | 0 mismatches in every file except `independentScore.evidence` blocks of corridor (16), gear-shaft (17), guardian-vault (21). Re-run at the end: identical |
| `python3 -I /tmp/fb17/validate/blends.py` (room blend files, hash and bytes) | 0 | 10 of 10 match |
| `python3 -I /tmp/fb17/validate/runtime.py` (public vs staging copies, derivedFiles completeness) | 0 | Every runtime file is listed in `derivedFiles`, none is missing, every staging copy equals its runtime copy |
| `python3 -I /tmp/fb17/validate/table.py` (combat table report hashes, GLB stats) | 0 | 13 of 13 `report.json` file hashes match, 9 of 9 material set hashes match `public/assets/materials/*.png` |
| `python3 -I /tmp/fb17/validate/ui.py` (UI provenance) | 0 | 4 of 4 sources, 15 of 15 derivative files, font hash match |
| `node_modules/.bin/vitest run tests/<file>` via `/tmp/fb17/validate/vt.sh` | 0 for each | combat-table-asset 6, room-study-asset 5, room-kit-asset 41, lightmap-loader 11, hero-rooms 12, enemy-asset-loader 12, automaton-assets 16, dice-asset 20, dice-integration 10, ui-atlas 7 tests passed |

No git, Blender, browser, vite, full vitest or build was run. The deterministic rebuild itself was not re-executed for any asset (needs Blender); "recipe present" below means the generator is checked in and its inputs are hashed in a record.

## Provenance fixes made

None. Every `sha256`, `bytes`, triangle count, material count, bone count and image dimension outside the `independentScore` blocks matched the file on disk. No provenance file was edited.

## Findings that need real work

- F1, combat table has no `provenance.json`. `assets-source/props/combat-table/staging/report.json` holds hashes but no license, no validation record and no approvals block. Fix: write a provenance record in the same shape as the dice, hashing the runtime GLB, AO map and manifest, with a `license` line. Not done here because `assets-source/props/` is off limits this run.
- F2, combat table fallback is untested. `src/main.ts` (the `tableAsset` promise, `console.warn('combat table asset unavailable, greybox kept')` and the factor-only material fallback) has no test. Fix: one test that fails the manifest fetch and one that fails `bindTableMaterials`, each asserting the greybox or factor materials stay.
- F3, UI set fallback is untested. `src/ui/icon-sheet.ts` (a failed load falls back to text chips) and the key art load in `src/flow/panels.ts` have no test. `tests/ui-atlas.test.ts` covers only the success path.
- F4, Grand Escapement is 37,296 triangles against the PRD table's 25k per automaton. `plans/phase-5-slice-content.md` line 22 sets a guardian budget of 40k triangles and 60 bones, and `scripts/assets/asset-check.py` and `tests/automaton-assets.test.ts` use it, but the PRD table was never amended. Fix: amend the PRD budget row or record Paul's word.
- F5, the corridor, gear-shaft and guardian-vault `independentScore.evidence` hashes no longer match disk (details in the room sections). The corridor score lists `corridor.glb` at 3d9de824, the file on disk is 442b67f4. These blocks are off limits and the re-score is running, so I only report them.
- F6, 10 of the 12 room, enemy and dice records state `blender: 5.3.0` (written by `bpy.app.version_string` in the generators), while the PRD pins Blender 5.2.2 LTS and the same records name a 5.2.2 glTF exporter. The Orrery Warden and Grand Escapement records and the combat table report say 5.2.2 LTS. Needs a decision on which version built what, or a PRD update.
- F7, the UI provenance records `scripts/assets/build_ui_atlas.py` by path only, no hash. Current sha256 5b33dacd0389a2d4 (first 16 hex shown). Adding it is a new field, not a stale value, so I did not add it.
- F8, stale prose in `docs/owner-review.md` and `docs/verification.md` (G3.4): Sentry 2,992 tris (now 10,140), study 6,948 (6,968), hall 4,213 (6,747), corridor 1,556 (1,986), gear-shaft 4,434 (9,872), guardian-vault 7,263 (12,277), Hound 23,044 (23,368), Golem 23,474 (24,340), Warden 24,794 (24,730). "independent score `unscored` on every asset" is stale for 11 of 12 records. Not edited, out of the stated scope.

## Resolved after the sweep (2026-11-17)

- F1: `assets-source/props/combat-table/provenance.json` written from `staging/report.json`, with the runtime and blend hashes recomputed from disk, a license line and every gate pending. Rights evidence now exists. Technical stays open on F2.
- F3: `tests/icon-sheet-fallback.test.ts` (fallback words with no icon; a failed manifest fetch rejects, keeps no sheet and retries) and `tests/key-art-fallback.test.ts` (the title, wordmark and controls build when the key art cannot load).
- F4: the PRD budget table has a floor guardian row (40k triangles, 4 materials, 60 bones), matching P5-T4 and the asset gate.
- F5: all five rooms re-scored on `b1df5d3` by an independent reviewer: study 84, corridor 80, hall 74, gear-shaft 78, guardian-vault 79. Each `independentScore` holds the new block with current evidence hashes; the previous blocks moved to `independentScoreHistory`.
- F7: `assets-source/ui/provenance.json` records `scriptSha256`. The script and its outputs last changed together in `04cb20e`.
- F8: `docs/owner-review.md` and `docs/verification.md` carry the current counts and scores.

- F2: the floor's table load moved out of `src/main.ts` into `loadCombatTable` (`src/combat/table-asset-proof.ts`). `tests/combat-table-fallback.test.ts` fails the manifest fetch and the GLB load (each resolves null, so the greybox stays) and fails the material bind (the factor-only materials stay). The combat table's technical gate has no open finding.

- Later (2026-11-17): the gear shaft and guardian vault were rebuilt in `8428cd8` and re-scored 81 and 82. The combat table scored 58 and the table decorations 69 (both below the bar; fix cards filed). The table rebuild `b241d9b` re-scored 72: walnut, felt, tray and brass swirl fixed; a black left body strap (reversed winding), flat cream brass and weak contact AO remain.
- The table decorations re-scored 84/100 on `31aa007`. Their provenance records the independent review and 38 verified evidence hashes. Quest appearance and owner approval remain open.

Still open: F6 (Blender version: the PRD pins 5.2.2 LTS, MiniMac runs 5.3.0).

## 1. Study hero room

Files: `assets-source/rooms/study/`, `public/assets/rooms/study/`.

- Technical: pass. asset-check: `study: 6968 tris, 9 materials; basecolor/lightmap/normal/orm ktx2 2048px` (budget 100k tris, 16 materials, 2048 px). All 23 path and name hashes match (generator `build-room-study.py` b918e851, 2 deps, 6 derived, 12 staging, 2 references), and the 2 blend files match hash and bytes. GLB 440,908 bytes equals `budgets.glbBytes`. Recipe present: generator and deps hashed, blends hashed. Loader tests: `tests/room-study-asset.test.ts` (5 tests, includes "stays inside the PRD room budgets" and "binds its lightmap by exact filename on UV1 at pi x scale"), `tests/lightmap-loader.test.ts`. Fallback: `tests/hero-rooms.test.ts` "keeps a room on its greybox when its manifest or model fails, and the run still starts". Note F6.
- Rights: pass. `license`: original Blender work from a checked-in script, concept references from Paul's paid Higgsfield plan (Terms of Use 4.4). References `room-sheet-1.png` (ae85e896) and `room-sheet-2.png` (00dc7053) hash-match, provider higgsfield, job ids in `assets-source/style/provenance.json`.
- Creative: pending, re-score in progress. Current block: no `independentScore` (unscored). `approvals` creative row: pending.
- Owner: pending. Only recorded Paul item is the concept gate, 2026-11-15, `docs/art-bible.md` picked room-sheet-1.png. `approvals` owner row: pending (P4-T10).

## 2. Combat table

Files: `scripts/assets/build-combat-table.py`, `assets-source/props/combat-table/staging/`, `public/assets/props/combat-table/`.

- Technical: fail (F1, F2). Passing parts: 13 of 13 hashes in `staging/report.json` match, including runtime `combat-table.glb` (af23a6d8), `.ao.ktx2`, `.ao.png`, manifest. Generator hash 2dc281f2, helper `lightmap_helpers.py` c74c968a, concept `table-sheet-1.png` bc582396 all match, and the 9 source material hashes match `public/assets/materials/{walnut,brass-aged,brass-polished}/*.png`. GLB: 4,184 tris (report 4,184, manifest 4,184), 4 materials (manifest limit 4, triangle limit 20,000), 0 images, AO map 1024x1024. Within the PRD (no table-specific budget beyond draw calls, manifest says 12 per eye). Loader tests: `tests/combat-table-asset.test.ts` (6 tests, e.g. "binds only to shared sets that exist, and ships its AO map", "has the same node names, parents and transforms"). Recipe present. Missing: provenance record, asset-check coverage, fallback test.
- Rights: fail. No license, provider or origin statement in the table's own record. Indirect evidence only: concept sheet job in `assets-source/style/provenance.json` and the material sets' rights note in `assets-source/materials/README.md`. Fix with F1.
- Creative: pending. No `independentScore`, no approvals block (`docs/owner-review.md` row A6: self-score none).
- Owner: pending. Only the concept pick is recorded: "Paul, 2026-11-15 (docs/art-bible.md)" in the report. The P4 look approval is open.

## 3. Cog Sentry

Files: `assets-source/enemies/cog-sentry/`, `public/assets/enemies/cog-sentry/`.

- Technical: pass. asset-check: `10140 tris, 4 materials, 21 bones, clips idle/attack/hit/death/frozen` (budget 25k, 4, 40). 14 of 14 hashes match (generator 8f80d1ae, GLB 6025f67d 923,220 bytes, manifest, 2 blends, 2 reports). GLB equals `budgets.glbBytes`. Recipe present. Loader and fallback: `tests/enemy-asset-loader.test.ts` "loads cog-sentry from its own manifest and GLB, unchanged", "treats a 404 or the dev HTML fallback for the manifest as missing, never as an error", "treats a manifest whose GLB is absent as missing". Note F6.
- Rights: pass. `license`: original Blender work, concept from Paul's paid Higgsfield plan (Terms of Use 4.4). `sentry-sheet-1.png` (c5373556) hash-matches, provider higgsfield.
- Creative: pass. `independentScore` 80 of 100, bar 80, clears, 2026-11-16, independent reviewer.
- Owner: pending. Recorded: concept approved, Paul 2026-11-15, `docs/art-bible.md`. Model, rig and animation rows pending.

## 4. Hall and corridor rooms

Files: `assets-source/rooms/{hall,corridor}/`, `public/assets/rooms/{hall,corridor}/`. Generator `build-room-kit.py` plus `room_kit.py`, `lightmap_helpers.py`, `room_panels.py`, `build-cog-sentry.py`, `build-room-study.py`.

- Technical: pass for both. asset-check: `hall: 6747 tris, 8 materials; lightmap 2048px`, `corridor: 1986 tris, 7 materials; lightmap 2048px`. Hall 28 of 28 hashes match. Corridor 29 of 29 non-score hashes match, the other 16 are in the score block (F5). GLB sizes 484,480 and 158,048 equal `budgets.glbBytes`, triangle and material counts agree across report, reimport, manifest and GLB. Tests: `tests/room-kit-asset.test.ts` ("stays inside the PRD room budgets and reports measured figures", "binds its lightmap by exact filename on UV1 at pi x scale", "ships an image-free GLB whose every primitive has UV1 and a manifest slot"), fallback `tests/hero-rooms.test.ts` greybox test above. Note F6.
- Rights: pass for both. Same `license` line, references `L-board-1.png`, `L-study.png`, `room-sheet-1.png` hash-match and are Higgsfield jobs in `assets-source/style/provenance.json`.
- Creative: pending, re-score in progress. Current blocks: hall 68 of 100, 2026-11-16, below bar (no evidence list). Corridor 80 of 100, 2026-11-17, build 60cff33, clears bar, but 16 evidence hashes are stale, including `corridor.glb` (listed 3d9de824, disk 442b67f4, file modified 17:10 on 2026-11-17).
- Owner: hall recorded approval with an exception. Provenance creative and owner rows: "Paul, 2026-11-16, in the rogue-xr session: \"the rest room is approved except the contents of the hearth look very flat add more detail\"" (the rest room is the hall template). The hearth rework (`e4f18cb`) still waits on Paul's look. Corridor: pending. D10 (2026-11-16, "yes to all Quick picks") covers the concept gate only.

## 5. Gear-shaft and guardian-vault rooms

Files: `assets-source/rooms/{gear-shaft,guardian-vault}/`, `public/assets/rooms/...`.

- Technical: pass for both. asset-check: `gear-shaft: 9872 tris, 12 materials`, `guardian-vault: 12277 tris, 10 materials`, both lightmap 2048 px. Non-score hashes all match (gear-shaft 40 of 40, guardian-vault 30 of 30, remaining 17 and 21 entries are score evidence, F5). GLBs 768,920 and 913,556 bytes equal `budgets.glbBytes`. Rigid nodes `gear-shaft_gear_ring` (4,776 tris) and `gear-shaft_gear_counter` (1,644) present, tested in `tests/room-kit-asset.test.ts` "names the crown gear on the room axis and its counter gear" and "counter-rotates the counter gear at the inverse tooth ratio", plus `tests/hero-rooms.test.ts` "gear-shaft crown gear spin". Fallback as in section 4. Note F6.
- Rights: pass for both, same evidence as section 4.
- Creative: pending, re-score in progress. Current blocks: gear-shaft 75 of 100 (2026-11-17, build 60cff33, below bar), guardian-vault 79 of 100 (2026-11-17, build 60cff33, below bar). Evidence hash drift: 17 entries (gear-shaft), 21 (guardian-vault), listing reports, renders and hero shots.
- Owner: pending for both. Concept approval row (Paul, 2026-11-16, D10 "yes to all Quick picks") is the only recorded item.

## 6. Spring Hound and Bellows Golem

Files: `assets-source/enemies/{spring-hound,bellows-golem}/`, `public/assets/enemies/...`.

- Technical: pass for both. asset-check: `spring-hound: 23368 tris, 4 materials, 33 bones`, `bellows-golem: 24340 tris, 4 materials, 22 bones`, clips idle/attack/hit/death/frozen (PRD 25k, 4, 40). Hashes 18 of 18 each. GLBs 1,365,152 and 1,865,644 bytes equal `budgets.glbBytes`. High-vs-low evidence: `staging/fidelity.json` and `*.fidelity-compare.jpg` exist. Tests: `tests/automaton-assets.test.ts` (per id: parser, schema, clips, budget and sockets), `tests/enemy-asset-loader.test.ts` fallback tests listed in section 3 (the loader is shared across ids, tested with the sentry fixture and 404 routes for the hound). Note F6.
- Rights: pass for both. `license` line with Terms of Use 4.4. Concept sheets `hound-sheet-1.png` and `golem-sheet-1.png` hash-match their Higgsfield records in `assets-source/concepts/provenance.json` (job ids e8ed205a, 7a63b261).
- Creative: pass for both. Hound `independentScore` 82, 2026-11-16, bar 80. Golem 82, 2026-11-16 (supersedes the 59 and 77 passes quoted in `docs/owner-review.md`).
- Owner: pending for both. Concept approval only: Paul, 2026-11-16, D8: "concepts look good amend the requirements to allow them". Model, rig and animation rows pending, and the provenance says modeling under the standing 2026-11-15 approval is not a creative or owner approval.

## 7. Orrery Warden and Grand Escapement

Files: `assets-source/enemies/{orrery-warden,grand-escapement}/`, `public/assets/enemies/...`.

- Technical: Orrery Warden pass, Grand Escapement fail (F4). asset-check: `orrery-warden: 24730 tris, 4 materials, 31 bones`, `grand-escapement: 37296 tris, 4 materials, 38 bones, clips incl. phase-change`. Hashes 35 of 35 and 31 of 31 match. GLBs 2,616,300 and 3,545,328 bytes equal `budgets.glbBytes`. PRD automaton row: at most 25k tris, 4 materials, 40 bones. Warden fits. Escapement exceeds the triangle figure by 12,296 and meets materials and bones, and fits only the plan's guardian budget (40k, 60). Tests: `tests/automaton-assets.test.ts` (guardian budget encoded there), loader tests as in section 3. Note F6 (grand-escapement and orrery-warden records say `5.2.2 LTS`, matching the PRD).
- Rights: pass for both. Concept sheets `warden-sheet-1.png` and `escapement-sheet-1.png` hash-match their Higgsfield records (job ids 61b312b4, a0abfe99). `license` line present.
- Creative: pass for both. Warden `independentScore` 82, 2026-11-16, build d950e09. Escapement 80, 2026-11-16, bar 80 (exactly at bar).
- Owner: pending for both. Concept approval only: Paul, 2026-11-16, D8 (quote in section 6). Model, rig, animation pending.

## 8. UI icons, dice face sets, glyphs, title key art

Files: `assets-source/ui/`, `public/assets/ui/`, `scripts/assets/build_ui_atlas.py`. Commit b64a1dd could not be inspected (git is off limits this run).

- Technical: fail (F3, F7). Passing parts: 4 of 4 raw sources match hash, bytes and dimensions (e.g. `icons-sheet.png` 76c8c393 2048x2048, `key-art.png` 447a015a 2752x1536). 15 of 15 runtime files match hash and bytes. Font `NotoSans-Regular.ttf` b85c38ec matches. Page sizes: icons 512x512, dice and glyph pages 1024x512 (limit 2048), title 2048x1152 and 1024x576 as the README states. Recipe: script and inputs checked in, README claims a byte-identical rebuild (not re-run here). Tests: `tests/ui-atlas.test.ts` (7 tests: "keeps every page at most 2048 px and matching its PNG", "numbers dice faces in src/dice/faces.ts order with opposite faces summing to N + 1", "has one glyph per sigil, drawn from the same strokes as the templates", "loads through the typed loader and resolves uvs"). `asset-check` does not cover this set.
- Rights: pass. `rights`: provider Higgsfield (paid plan), commercial use cleared under Terms of Use section 4.4, references `L-board-1.png` and `A-room.png` project-owned, font OFL 1.1. All four sources have model, job id, created time and prompt.
- Creative: pending. No `independentScore`. `approvals.creative`: "pending Paul".
- Owner: pending. `approvals.owner`: "pending Paul". `approvals.technical` still reads "pending validate-generated-assets review by the orchestrating session".

## 9. Dice models (brass d6, glass d8)

Files: `assets-source/dice/{brass-d6,glass-d8}/`, `public/assets/dice/...`. Generator `scripts/assets/build-dice.py` (282bb125) with dep `build-cog-sentry.py`.

- Technical: pass for both. asset-check: `brass-d6: 1254 tris, 2 materials, 0 images`, `glass-d8: 512 tris, 2 materials, 0 images` (the PRD has no die budget, the project test limit is 1,500 tris and 2 materials). 14 of 14 hashes each match, including `atlasInputs` (`ui-atlas.json`, `dice-d6.png`) against the current UI pages. GLBs 53,528 and 25,052 bytes equal `budgets.glbBytes`. Tests: `tests/dice-asset.test.ts` (20 tests, e.g. "meets the dice budgets", "face art is never mirrored", "bounds match the DiceWorld collider exactly", "rejects corrupt GLB bytes", "rejects a manifest whose face table disagrees with the GLB or the frame"), fallback `tests/dice-integration.test.ts` "keeps the greybox dice when models is null or absent". Note F6.
- Rights: pass for both. `license`: original Blender work, face art and style reference from Paul's paid Higgsfield plan (Terms of Use 4.4), face pages carry the UI set's own provenance (section 8).
- Creative: pass for both. `independentScore` brass-d6 83, glass-d8 87, both 2026-11-16, bar 80.
- Owner: pending for both. `approvals` owner row: "Paul approves the in-engine look". Provenance `technical` and `rights` rows still read pending, because the verdict is reported to the orchestrator and not self-recorded.

## Summary

| Asset | Technical | Rights | Creative | Owner |
| --- | --- | --- | --- | --- |
| 1 Study | pass | pass | pending (re-score in progress, unscored) | pending |
| 2 Combat table | fail (F1, F2) | fail (F1) | pending | pending |
| 3 Cog Sentry | pass | pass | pass (80) | pending |
| 4a Hall | pass | pass | pending (re-score in progress, 68 below bar) | pass with exception (Paul 2026-11-16, hearth open) |
| 4b Corridor | pass | pass | pending (re-score in progress, 80, evidence stale F5) | pending |
| 5a Gear-shaft | pass | pass | pending (re-score in progress, 75 below bar) | pending |
| 5b Guardian-vault | pass | pass | pending (re-score in progress, 79 below bar) | pending |
| 6a Spring Hound | pass | pass | pass (82) | pending |
| 6b Bellows Golem | pass | pass | pass (82) | pending |
| 7a Orrery Warden | pass | pass | pass (82) | pending |
| 7b Grand Escapement | fail (F4) | pass | pass (80) | pending |
| 8 UI, dice faces, glyphs, key art | fail (F3, F7) | pass | pending | pending |
| 9a Brass d6 | pass | pass | pass (83) | pending |
| 9b Glass d8 | pass | pass | pass (87) | pending |
