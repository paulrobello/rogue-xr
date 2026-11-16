# Playtest notes: P6-T2 bug bash (desktop half)

| Field | Value |
| --- | --- |
| Date | 2026-11-15 |
| Build | `d8c73e9` plus the uncommitted fixes listed under Fixed issues |
| Environment | Desktop, headless Chromium (Playwright 1.63, `channel: 'chromium'`), 1600x1000, GPU backend confirmed through `WEBGL_debug_renderer_info`: `ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max)` |
| Server | The running Vite dev server on port 4260 (`?seed=…&title&debug`) |
| Assets | `public/assets` as staged at the time (audio, cards, dice, enemies, materials, props, rooms, ui, xr-hands). The music cues were missing (O1). A Blender agent was building room assets in parallel. |
| Headset half | Not observed. Comfort, real controller fling, controller sigils and Quest frame times wait for Paul's Quest 3 runs. |

## How the runs were played

A Playwright driver played each run with real inputs: mouse clicks on the in-scene boards, a mouse-drag yaw plus a held `W` to walk through the entry's first door, mouse drags from a fan card to an automaton (fling) or onto the table (drop), mouse-drawn sigils traced on the plate from the sigil's template strokes (every second trace jittered by 3 % of the plate), `T` to throw dice and `E` to end the turn. Debug helpers only reached states: `__combat.teleportToEncounter()` to stand at the next fight, and in runs marked `win`, `__flow.setCheat('win')` before elites and the guardian (they open at 1 hp), so a run reaches victory and a funded workshop. The bot blocks while the incoming intent damage exceeds its block and otherwise attacks. It is a test policy, so its deaths are not a balance verdict.

Each run went: title, New Run, a real door crossing, every fight in order with its reward, a reload to the title and Continue after the first reward, the guardian, death or victory, the summary board, title, the workshop (buying an upgrade when affordable), back to the title, and a second New Run in the same page to prove the loop restarts.

## Seed classes

`src/floor/generate.ts` varies two things that change how a run plays: the wing count (2 or 3, which sets how deep the guardian's wing is) and whether an elite exists (it needs a combat room at depth 2 or more). Over 406 seeds (SPIRE001 to SPIRE006 and 400 generated `BASH…` seeds) the four classes split 184 / 31 / 177 / 14.

| Class | Wings | Elite | Seeds |
| --- | --- | --- | --- |
| A | 3 | yes | SPIRE001, SPIRE002 |
| B | 3 | no | SPIRE006, BASH7000 |
| C | 2 | yes | BASH0000, BASH4000 |
| D | 2 | no | BASHA000, BASHB200 |

## Run log

Fight cells read `r<room> <tier> <outcome> t<turns> hp<player hp at the end>`, with the enemies' hp when the player lost.

| Seed | Class | Mode | Door crossed | Fights | End | Continue after reload | Workshop |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SPIRE001 | A | play | yes | r2 elite lost t11 hp0 (Orrery Warden 25/92) | death, 0 won, 0 cogs | n/a (no reward reached) | nothing affordable |
| SPIRE002 | A | win | yes | r2 regular won t14 hp52; r3 elite won t1 hp52; r4 regular lost t7 hp0 (Spring Hound 10/30, Spring Hound 30/30) | death, 2 won, 44 cogs | matched | Sturdy Frame, 44 to 14 cogs |
| SPIRE006 | B | win | yes | r3 regular won t14 hp57; r5 regular won t8 hp38; r6 guardian won t1 hp38 | victory, 3 won, 85 cogs | matched | Sturdy Frame, 85 to 55 cogs |
| BASH7000 | B | play | yes | r3 regular won t3 hp59; r5 guardian lost t19 hp0 (Grand Escapement 83/160) | death, 1 won, 11 cogs | matched | nothing affordable |
| BASH0000 | C | play | yes | r1 regular won t6 hp45; r3 elite lost t7 hp0 (Orrery Warden 44/92) | death, 1 won, 12 cogs | matched | nothing affordable |
| BASH4000 | C | win | yes | r1 regular won t10 hp47; r4 elite won t1 hp47; r6 regular won t18 hp15; r7 guardian won t1 hp15 | victory, 4 won, 114 cogs | matched | Sturdy Frame, 114 to 84 cogs |
| BASHA000 | D | play | yes | r1 regular won t7 hp45; r3 regular won t13 hp27; r5 guardian lost t11 hp0 (Grand Escapement 115/160) | death, 2 won, 25 cogs | matched | nothing affordable |
| BASHB200 | D | win | yes | r1 regular won t7 hp40; r3 regular won t8 hp40; r6 guardian won t1 hp40 | victory, 3 won, 85 cogs | matched | Sturdy Frame, 85 to 55 cogs |

SPIRE001, SPIRE002 and BASH0000 ran with F1's pitch but before its turn-to-table half; the other five ran with both fixes and F2. Every run ended with a second New Run starting in the entry room.

Every teleport opened its fight (21 of 21). The earlier report of a scripted teleport that never started a fight did not reproduce.

## Observations

### Fling (desktop drag)

- Targeted cards dragged at an automaton resolved through the point fallback (`via point`), and untargeted cards dropped on the table resolved as drops (`via drop`). Of 561 drags over the eight runs, 481 played or staged. The rest were the sigil soft-lock (F2) and dice gating ("Throw the dice first"), not misses.
- A drop needs the release over the table. Before F1 the table sat below the view, so a desktop player could only drop by dragging below the screen edge.

### Dice

- 36 of 36 throws settled with the physical up face equal to the rules roll (the up face index mapped through the die's `faces`), so the D1 seeded-face correction held on desktop. Whether the correction is visible needs the headset.
- Cards that roll gate everything else until `T` throws ("Throw the dice first"). That reads well in the HUD. The Throw button was out of the desktop view when this was written (O2, fixed in F3).

### Sigils (mouse)

- Ward traced cleanly gave 10 block (38 casts) and the jittered trace gave 8 block (33 casts), so the score-to-multiplier mapping shows in the numbers.
- Before F2, the second sigil card played within 1.6 s of a cast never got a plate (SPIRE002, room 4, Arc Bolt). The fight sat in the sigil stage refusing every card until End Turn.
- Only Ward was traced by the bot in these runs. The other four sigils are covered under Sigil traces (desktop) below.

### Comfort

Not observable on desktop. Seated comfort, snap turn, the vignette and teleport need the Quest 3 run.

### Flow, audio and frame numbers

- Title, New Run, reward, death, summary, title, workshop and New Run all worked with mouse clicks on the boards. Continue after a reload restored hp, cogs, deck and cleared rooms exactly in every run that reached a reward. Continue is no longer offered after a run ends. The workshop spent banked cogs (SPIRE002: 44 to 14 for Sturdy Frame).
- Stingers: each of the 21 fight ends played exactly one stinger (16 victory-sting, 5 defeat-sting). The second request from the flow's state change was refused by the stinger-family claim, as intended. The turn-start draw of five cards asks for five `card-draw` sounds in one frame, and the director refuses all but one.
- Desktop frame numbers rank variants only (headless rAF is capped at 60 Hz): no frame interval above 16.8 ms in any sampled state; draw calls at most 30 exploring, 58 in combat, 24 on the reward board; at most 15.2k triangles.
- Balance note (not a bug): SPIRE001's only fight before the guardian is the elite Orrery Warden (92 hp) with the starter deck. The bot lost it twice (warden at 25/92 after 11 turns). The elites and the guardian are still capsule placeholders, as the P5 asset status says.

## Sigil traces (desktop)

Method: headless Chromium on the GPU (Apple M4 Max, 1600x1000) against the dev server, `?seed=BASH7000&debug`, the guardian fight in room 5 (160 hp, so nothing dies mid-run). Before each cast the player's hand was set to the one sigil card and steam to 9 through the debug controller state, so the five cards could be cast back to back. Everything after that was real input: a mouse drag of the card (at the automaton for Bolt and Flame, onto the table for the rest), then mouse-down, `mouse.move` along the template strokes mapped to the screen through `__combat.screenOf('plate', undefined, u, v)` and mouse-up. `T` threw the dice of Bolt and Flame. The glyph filled 72 % of the plate. Noise is a deterministic generator (the same traces every run).

| Trace | What it adds to the template shape |
| --- | --- |
| clean | Nothing: the template strokes as drawn by the authors |
| human | A smooth wobble of about 1.5 % of the plate (1 to 2 cycles per stroke), 4 degree tilt, 6 % stretch |
| jittered | Independent per-point noise of up to 2.5 % of the plate, 6 degree tilt, 10 % stretch (the rough hand of the bug bash) |

| Sigil | Trace | Points drawn / kept | Score | Multiplier | Quality | Recognized as | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| bolt | clean | 37 / 37 | 1.000 | 1.25 | Masterful | bolt | You hit guardian for 13 |
| bolt | human | 37 / 37 | 0.928 | 1.19 | Clean | bolt | You hit guardian for 8 |
| bolt | jittered | 37 / 42 | 0.891 | 1.07 | Clean | bolt | You hit guardian for 11 |
| flame | clean | 48 / 43 | 0.960 | 1.25 | Masterful | flame | guardian: +1 overheat (1) |
| flame | human | 48 / 44 | 0.880 | 1.04 | Clean | flame | guardian: +3 overheat (4) |
| flame | jittered | 48 / 53 | 0.833 | 0.90 | Rough | flame | guardian: +4 overheat (8) |
| gear | clean | 74 / 98 | 1.000 | 1.25 | Masterful | gear | You hit guardian for 5 |
| gear | human | 74 / 81 | 0.905 | 1.11 | Clean | gear | You hit guardian for 4 |
| gear | jittered | 74 / 81 | 0.865 | 0.99 | Clean | gear | You hit guardian for 4 |
| spiral | clean | 64 / 83 | 0.972 | 1.25 | Masterful | spiral | guardian: +1 weak (1) |
| spiral | human | 64 / 87 | 0.900 | 1.10 | Clean | spiral | guardian: +1 weak (2) |
| spiral | jittered | 64 / 88 | 0.835 | 0.91 | Rough | spiral | guardian: +1 weak (3) |
| ward | clean | 59 / 59 | 1.000 | 1.25 | Masterful | ward | You gained 10 block |
| ward | human | 59 / 59 | 0.894 | 1.08 | Clean | ward | You gained 9 block |
| ward | jittered | 59 / 68 | 0.801 | 0.80 | Rough | ward | You gained 6 block |

"Points drawn" is the template points walked with the mouse (the mouse events add two steps between each pair). "Kept" is what the plate stored after its 12 mm spacing filter (`MIN_POINT_SPACING`), which drops the dense points of Flame and keeps more of the others because of the interpolated steps.

Findings:

- All 15 casts were recognized as their own sigil. A smooth hand-like trace scores 0.88 to 0.93 (multiplier 1.04 to 1.19), a rough hand with independent per-point noise 0.80 to 0.89 (0.80 to 1.07), and a clean trace 0.96 to 1.00 (the 1.25 cap). No sigil is an outlier, so the templates, the resampling and the desktop plate projection needed no change. Ward is the most sensitive to a rough hand (0.801), Bolt the least (0.891).
- Flame and Spiral score 0.960 and 0.972 on a perfect trace because the plate's spacing filter drops their dense template points. Both stay above the 0.95 perfect threshold, so they still earn the full multiplier.
- The pure scorer in `src/sigil/**` was not touched.
- The traces exposed F4 (the dragged card springing back after a sigil cast). Before the fix, 5 of the 6 Bolt and Flame casts after the first needed a second drag (`dragAttempts` 2 in the run log). After it, all 15 casts took one drag.

## Fixed issues

| Id | Severity | Issue | Fix | Test |
| --- | --- | --- | --- | --- |
| F1 | Major | On the desktop a fight opened at pitch 0, with the table, dice tray and sigil plate below the view. When walls pushed the table off the player's heading (BASH0000 room 1, SPIRE002 room 3), the plate was entirely out of view and the walker cannot turn during a fight, so a sigil card could not be cast with the mouse at all. | `src/desktop/controls.ts`: `combatPitch(distance, drop, fov)` puts the table centre at 70 % down the view, and `frameCombat()` holds it for the fight and restores the earlier pitch after. `src/main.ts` turns the walker to the table heading on the fight's opening frame. All 15 fights in the five runs with both halves opened with the table and the plate in view (the tray and readouts at the closer placements were O3, fixed in F3). | `tests/desktop.test.ts` › desktop combat framing: "tilts the view down to the table while a fight runs and restores it after", "frames the table centre and the automaton line with the table 0.5 m ahead", "… 0.65 m ahead", "lands on about -0.4 rad at the default placement" |
| F2 | Major | A sigil card staged while the previous cast's result was still on the plate (the 1.6 s hold) never got its plate back. The controller waited on the sigil and refused every other card ("Draw the sigil on the plate") until End Turn or Esc (SPIRE002, room 4). | `src/combat/combat-session.ts` `update()`: when the result hold ends the session re-syncs, so a waiting sigil shows its plate. | `tests/combat-session.test.ts` › "shows the plate for a sigil card staged while the last result is on screen" (fails without the fix: plate stays `hidden`) |
| F3 | Minor | Desktop combat HUD out of view (O2, O3, O4): End Turn and Throw below the view, the enemy readouts above it at the 0.5 m fallback tables and for every guardian, the dice tray cut off at close tables, and the status panel clipped at the left edge. | Desktop only, XR layout untouched. `src/desktop/combat-framing.ts` `fitCombatFraming()` picks the pitch (and a wider vertical fov, 70 up to 95 degrees, only when the fit needs it) that keeps the tray, sigil plate and automaton aim points inside 0.88 NDC. `src/desktop/controls.ts` `refineCombat()` applies it once the session exists and restores pitch and fov after the fight. `src/combat/combat-session.ts` `fitHudToView()` slides End Turn, Throw, the readouts and the status panel (drawn at 0.6 scale on the desktop) into the view every frame, and `resetHud()` puts them back for XR. `src/main.ts` calls them. | `tests/desktop.test.ts` › "desktop combat framing fit" (math against the three.js projection, 36 placements, fov widening, fallback, control restore); `tests/combat-session.test.ts` › "desktop HUD fit" |
| F4 | Major | A targeted card dragged at an enemy right after a sigil cast sprang back into the fan instead of being played. Found by the sigil traces: 5 of 6 Bolt and Flame casts after the first needed a second drag. `FlingController.staged` kept the cast card's fan index after the card was played, so the next grab at that index was returned to the fan by `abortStaged()` (a mouse player lost the first drag of every card played after a sigil, for the card that took the played card's slot). | `src/hand/fling.ts` `update()` drops `staged` once the controller is no longer waiting on a sigil. This file is outside the P6-T3 file list and is a one-line change. | `tests/combat-session.test.ts` › "plays a targeted card dragged at an enemy right after a sigil cast" (fails without the fix: the card stays in hand) |

## Open issues

| Id | Severity | Issue | Repro |
| --- | --- | --- | --- |
| O1 | Major (content) | The exploration and combat music cues are missing: every load logs `[audio] music not found (combat, explore): music stays silent`. | Any seed, any load. The cues belong under `public/assets/audio` (off limits to this pass). |
| O6 | Note | While the sigil plate shows, it covers the lower part of the enemy readout at the 0.5 m fallback tables (SPIRE001 room 2, BASH7000 room 3) and, for the guardian, the plate's result label (for example "x1.25 Masterful", 1.6 s) lands on the readout. The desktop view has no room above the plate at those placements. | `docs/verification/p6-sigil-bolt.jpg` (guardian, BASH7000 room 5). |
| O7 | Note | The desktop hand strip hangs in front of the dice tray, so a die thrown into the tray is partly behind the cards. | `docs/verification/p6-hud-BASH7000-r5.jpg`. |

## Screenshots

- `docs/verification/p6-bash-fight-framed-0p5m-SPIRE001.jpg`: a fight opening with F1 in place (SPIRE001 room 2, table at 0.5 m). The table, plate and hand are in view. The warden's readout was above the view (O3) and the player readout clipped at the left (O4) when this was taken, both fixed in F3 (see `p6-hud-SPIRE001-r2.jpg`).
- `docs/verification/p6-bash-reward-SPIRE002.jpg`: the reward board after SPIRE002 room 2, with the fight banner correctly hidden.
- `docs/verification/p6-bash-victory-SPIRE006.jpg`: the victory summary (guardian rigged to 1 hp), with no fight banner over it.
- `docs/verification/p6-bash-workshop-SPIRE006.jpg`: the workshop after banking 85 cogs.
- `docs/verification/p6-hud-<seed>-r<room>.jpg`: the desktop combat framing at 1600x1000 for the seven cases that failed in the bug bash (SPIRE001 r2, BASH7000 r3 and r5, BASHA000 r3, BASH4000 r6 and r7, SPIRE006 r6). End Turn, Throw, every readout, the tray and the status panel are on screen in each.
- `docs/verification/p6-sigil-<sigil>.jpg`: each sigil right after its clean mouse trace was cast (BASH7000 room 5): the plate with the trace, the multiplier label and the result.

## Emulated XR (IWER)

Emulator evidence, not a headset run. `scripts/xr-emu/walk.mjs` (`make xr-emu`, see `scripts/xr-emu/README.md`) drives the immersive-session paths in headless Chromium on the GPU (ANGLE Metal, Apple M4 Max) with Meta's IWER 2.8.0 emulating a Quest 3. IWER renders both eyes into the page canvas and applies neither foveation nor the framebuffer scale, so the values below are what the app requests, not what a compositor applied. Comfort, readability at Quest resolution and every frame budget still need the Quest 3 run. The head sits at a seated 1.2 m, controllers are posed with their target ray on a board control's world position, the app's own hover state is checked, then the trigger is pulled (IWER fires `select`). Run 2026-11-15 against the dev server (seed BRASS042); the update notice ran against a production preview with a different `version.json` served by a Playwright route.

### Session (P0-T2 criterion 2)

- Enter VR starts an `immersive-vr` session through the toolkit's `createXrSession`: the request carries `local-floor`, `local`, `hand-tracking` (its reference spaces plus its default features) and the Enter VR button hides.
- Foveation: `'medium'` is 0.5 in the toolkit (`FOVEATION_LEVELS`) and `XR_FOVEATION` in `src/perf/xr-perf.ts` is 0.5, so they agree. `renderer.xr.getFoveation()` is 0.5 and every per-frame layer write is 0.5. three.js writes its own default (1) once inside `setSession`, before the first frame. Two owners re-assert the same value every frame (the toolkit's `update` and perf's `assertFoveation`), a maintenance note only.
- Framebuffer scale: the `XRWebGLLayer` is created with `framebufferScaleFactor: 0.85`.
- Hands: both toolkit standard hands load, are visible on the posed controllers and wear the brass tint (`#b98a4a`, dimmed by the toolkit to `#946e3b`). See `xr-emu-1-session-hands.jpg`.
- Seated recenter now lifts the rig 0.4 m, putting the eye at 1.6 m (XF1).

### Flow with the ray (P5-T9 criterion 1, XR half)

All on the main (right) hand: hover moves with it and the off hand does not hover. Title (New Run, Enter seed keypad typing BRASS042, Workshop, Settings Lower/Raise volume: the board has buttons, not a slider), three fights won with the debug `K` key while presenting, a reward card picked and two rewards skipped with the ray, a death from a real automaton hit (1 hp cheat, `E` end turn), the death board's Return to the title, a Workshop Buy (Sturdy Frame, 56 to 26 cogs), then New Run after the death without leaving XR: same `XRSession`, a fresh floor. Continue was used with the ray after a reload and a second Enter VR. The boards draw in their own pass after a depth clear inside the immersive session (while a board is up, every presenting frame renders the world, then the boards). Measured from the head: title board 1.35 m (key art 2.74 m), reward cards 1.33 m, death board 1.32 m.

### Locomotion (as far as the emulator allows)

Left stick smooth move covered 2.0 m in 1 s (2 m/s), right stick snap turn stepped exactly 30° twice. Teleport is not wired (`main.ts` passes `teleportAim: null` and the setting defaults off) and the comfort vignette is computed (`Locomotion.vignetteStrength`) but nothing draws it.

### Fixed issues (XR)

| Id | Severity | Issue | Fix | Test |
| --- | --- | --- | --- | --- |
| XF1 | Major | The seated recenter on a session's first frame read the head camera that `enter-xr` had just zeroed (three.js only writes the viewer pose inside `render()`), so it lifted the rig by its 1 m maximum: a seated 1.2 m head saw the world from 2.2 m. | `src/xr/session.ts`: `XrRig.update` writes the frame's viewer pose into the head camera (`applyViewerPose`) before the frame's logic runs. | `tests/xr-session.test.ts` › applyViewerPose: "lets the first-frame recenter lift a seated head to standing eye height" |
| XF2 | Major | Skip the card did nothing, on desktop and in XR, and never showed its hover. Its id `reward-skip-skip` was routed to the `reward` card row (the first board whose name prefixes it), which has no `skip-skip` cell. | `src/flow/panels.ts`: `splitControlId` picks the longest matching board name, used by `activate` and the hover paint. | `tests/flow-panels.test.ts` › "skips the card when Skip is activated", splitControlId cases |
| XO1 | Major | New Run and Continue reset `rig.position.y` to 0 while presenting, dropping the seated player to their real head height until a headset recenter. | `src/main.ts` `startRun`, `continueRun` and the debug `teleportToEncounter`, and `src/world/floor-view.ts` (floor build) now move the rig in x/z only and keep its y. | `make xr-emu`: `seated-height-after-new-run`, `seated-height-after-continue` pass |
| XO2 | Major | The in-scene update notice drew in the world pass, under the boards' depth-cleared pass, so the key art and boards hid it. | `src/main.ts`: the notice gets its own scene, rendered after the boards (the panel already skips the depth test), followed by the laser pass. | `walk.mjs --notice`: `xr-notice-shown`, `xr-notice-above-boards` (notice pass after the boards pass), `xr-notice-later` pass; `xr-emu-11b-xr-update-notice.jpg` |
| XO3 | Minor | The desktop update bar covered the Enter VR button (both bottom-centre). | `src/update/dom-notice.ts`: the bar sits at the top centre. | `walk.mjs --notice`: `enter-vr-clickable` passes with the bar showing; `xr-emu-11a-desktop-notice.jpg` |
| XO4 | Minor | No pointer ray was drawn in XR, so the faint hover tint was the only sign of what the ray targets. | `src/xr/laser.ts` (b34b6e6): a brass beam per controller, ending on the board it hits, drawn after the boards. | `tests/xr-laser.test.ts` |

### Open issues (XR)

| Id | Severity | Issue | Repro and proposed change |
| --- | --- | --- | --- |
| XO5 | Note | The title board keeps its desktop placement when the session starts; boards are only re-placed on a phase change. With XF1 it measured 1.35 m ahead, but a player turned away at Enter VR finds the title behind them. | Inferred from `FlowUi.sync`, not run: Enter VR facing away from the board. |

### Screenshots (emulated eye buffer, both eyes)

`docs/verification/xr-emu-0-desktop-title.jpg` (desktop title over the placeholder brass room), `-1-session-hands`, `-2-title-hover`, `-3-settings`, `-4-seed-keypad`, `-5-explore`, `-6-fight`, `-7-reward-hover`, `-8-death-board`, `-9-workshop` (after the Buy), `-10-rerun-explore` (byte-identical to `-5-explore` as expected: same seed, same spawn; the rebuild proof is `rebuilt: true, sameSession: true` in the report), `-11a-desktop-notice`, `-11b-xr-update-notice`. Raw results: `xr-emu-report.json`, `xr-emu-report-notice.json`.
