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
- Cards that roll gate everything else until `T` throws ("Throw the dice first"). That reads well in the HUD. The Throw button itself is out of the desktop view (O2).

### Sigils (mouse)

- Ward traced cleanly gave 10 block (38 casts) and the jittered trace gave 8 block (33 casts), so the score-to-multiplier mapping shows in the numbers.
- Before F2, the second sigil card played within 1.6 s of a cast never got a plate (SPIRE002, room 4, Arc Bolt). The fight sat in the sigil stage refusing every card until End Turn.
- Only Ward was traced by the bot. Bolt, Flame, Gear and Spiral were not drawn with the mouse in these runs.

### Comfort

Not observable on desktop. Seated comfort, snap turn, the vignette and teleport need the Quest 3 run.

### Flow, audio and frame numbers

- Title, New Run, reward, death, summary, title, workshop and New Run all worked with mouse clicks on the boards. Continue after a reload restored hp, cogs, deck and cleared rooms exactly in every run that reached a reward. Continue is no longer offered after a run ends. The workshop spent banked cogs (SPIRE002: 44 to 14 for Sturdy Frame).
- Stingers: each of the 21 fight ends played exactly one stinger (16 victory-sting, 5 defeat-sting). The second request from the flow's state change was refused by the stinger-family claim, as intended. The turn-start draw of five cards asks for five `card-draw` sounds in one frame, and the director refuses all but one.
- Desktop frame numbers rank variants only (headless rAF is capped at 60 Hz): no frame interval above 16.8 ms in any sampled state; draw calls at most 30 exploring, 58 in combat, 24 on the reward board; at most 15.2k triangles.
- Balance note (not a bug): SPIRE001's only fight before the guardian is the elite Orrery Warden (92 hp) with the starter deck. The bot lost it twice (warden at 25/92 after 11 turns). The elites and the guardian are still capsule placeholders, as the P5 asset status says.

## Fixed issues

| Id | Severity | Issue | Fix | Test |
| --- | --- | --- | --- | --- |
| F1 | Major | On the desktop a fight opened at pitch 0, with the table, dice tray and sigil plate below the view. When walls pushed the table off the player's heading (BASH0000 room 1, SPIRE002 room 3), the plate was entirely out of view and the walker cannot turn during a fight, so a sigil card could not be cast with the mouse at all. | `src/desktop/controls.ts`: `combatPitch(distance, drop, fov)` puts the table centre at 70 % down the view, and `frameCombat()` holds it for the fight and restores the earlier pitch after. `src/main.ts` turns the walker to the table heading on the fight's opening frame. All 15 fights in the five runs with both halves opened with the table and the plate in view (the tray and readouts at the closer placements are O3). | `tests/desktop.test.ts` › desktop combat framing: "tilts the view down to the table while a fight runs and restores it after", "frames the table centre and the automaton line with the table 0.5 m ahead", "… 0.65 m ahead", "lands on about -0.4 rad at the default placement" |
| F2 | Major | A sigil card staged while the previous cast's result was still on the plate (the 1.6 s hold) never got its plate back. The controller waited on the sigil and refused every other card ("Draw the sigil on the plate") until End Turn or Esc (SPIRE002, room 4). | `src/combat/combat-session.ts` `update()`: when the result hold ends the session re-syncs, so a waiting sigil shows its plate. | `tests/combat-session.test.ts` › "shows the plate for a sigil card staged while the last result is on screen" (fails without the fix: plate stays `hidden`) |

## Open issues

| Id | Severity | Issue | Repro |
| --- | --- | --- | --- |
| O1 | Major (content) | The exploration and combat music cues are missing: every load logs `[audio] music not found (combat, explore): music stays silent`. | Any seed, any load. The cues belong under `public/assets/audio` (off limits to this pass). |
| O2 | Minor | End Turn and Throw sit 0.28 m toward the player on the table, more than 60° below the eye, so they are out of the desktop view at the combat framing. `E`, `T` and clicking the dice tray still work, but a mouse-only player cannot end a turn. | Any fight, desktop 1600x1000: `__combat.screenOf('end-turn')` lands below the screen (for example y 1102 at the default placement). |
| O3 | Minor | The automatons' readouts (hp, block, intent) float above the view when the table falls back closer than 0.65 m (pitch -0.44 to -0.53 rad, where the dice tray also drops below the view) and for every guardian, whose readout is lifted at least 1.3 m. The HUD line still lists enemy hp, but not intents. A wider desktop combat fov or a lower guardian readout would fix both. | 0.5 m table: SPIRE001 room 2, BASH7000 room 3, BASHA000 room 3, BASH4000 room 6. Guardian: BASH7000 room 5, SPIRE006 room 6, BASH4000 room 7. See `p6-bash-fight-framed-0p5m-SPIRE001.jpg`. |
| O4 | Minor | The player's status readout (hp, steam, turn, stage) hangs 0.6 m left of the table centre and is clipped by the left screen edge on the desktop. | Any fight at 1600x1000, see `p6-bash-fight-framed-0p5m-SPIRE001.jpg`. |
| O5 | Note | Only Ward was traced with the mouse. Bolt, Flame, Gear and Spiral desktop traces were not exercised in these runs. | Next bash: deck of the sigil cards via `?combat` view or a rigged deck. |

## Screenshots

- `docs/verification/p6-bash-fight-framed-0p5m-SPIRE001.jpg`: a fight opening with F1 in place (SPIRE001 room 2, table at 0.5 m). The table, plate and hand are in view. The warden's readout is above the view (O3) and the player readout is clipped at the left (O4).
- `docs/verification/p6-bash-reward-SPIRE002.jpg`: the reward board after SPIRE002 room 2, with the fight banner correctly hidden.
- `docs/verification/p6-bash-victory-SPIRE006.jpg`: the victory summary (guardian rigged to 1 hp), with no fight banner over it.
- `docs/verification/p6-bash-workshop-SPIRE006.jpg`: the workshop after banking 85 cogs.
