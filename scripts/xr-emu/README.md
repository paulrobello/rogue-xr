# Emulated-XR walk (IWER)

`walk.mjs` drives the immersive-session code paths in headless Chromium on the GPU, with Meta's
[IWER](https://github.com/meta-quest/immersive-web-emulation-runtime) (`iwer`, pinned in
`devDependencies`) standing in for a Meta Quest 3. It is emulator evidence: IWER renders both eyes
into the page canvas and applies neither foveation nor the framebuffer scale, so headset checks
still close every comfort, budget and readability criterion.

The `--stairs` check aims a seated controller at the second and fifth treads on both flights.
It compares the marker and the player's landing against the authored step heights, walks to the
door, and checks that the sign, steps and rails ignore the trigger. Two trigger pulls on the
handle must produce one floor change at full blackout. The check also measures the door swing,
fade-in, arrival position, heading and seated head height.

## Run it

Start the dev server first (`make dev-start`, port 4260), then:

```sh
make xr-emu                                     # node scripts/xr-emu/walk.mjs
node scripts/xr-emu/walk.mjs --out /tmp/xr-emu  # keep screenshots out of the repo
PW_GPU=swiftshader node scripts/xr-emu/walk.mjs # software GL, only when no GPU is available
node scripts/xr-emu/walk.mjs --focus          # New Run, one fight: only the fan and sigil checks
node scripts/xr-emu/walk.mjs --turns          # a two-automaton fight (SPIRE002): only the enemy-phase and hit-flash checks
node scripts/xr-emu/walk.mjs --recenter       # Enter VR facing away from the title: only the board re-placement check (XO5)
node scripts/xr-emu/walk.mjs --treasure       # SPIRE001: open the treasure room's coffer with the main-hand ray and trigger
node scripts/xr-emu/walk.mjs --rest           # SPIRE007: lose hp in a real fight, then use the rest room's hearth with the main-hand ray and trigger
node scripts/xr-emu/walk.mjs --guardian       # SPIRE004: the Grand Escapement's phase 1 (case closed, four moves) and phase 2 (hp hook, real card, clip, six moves, music)
node scripts/xr-emu/walk.mjs --loco           # Settings comfort toggles, New Run, then smooth move, snap turn, the comfort vignette and teleport
```

The update-notice check needs a production build (the dev server stamps no build id):

```sh
bunx vite build --outDir /tmp/rxr-xremu-dist
bunx vite preview --outDir /tmp/rxr-xremu-dist --port 4262   # stop it afterwards
node scripts/xr-emu/walk.mjs --notice http://localhost:4262
```

Screenshots land in `docs/verification/xr-emu-*.jpg` with a JSON report
(`xr-emu-report.json`, `xr-emu-report-notice.json`). The exit code is 1 when any check fails
(`make` reports 2). As of 2026-11-16 the walk passes every check (95, which includes the 3 difficulty checks, the 11 treasure and resume checks, the 17 rest checks, the 16 guardian checks (6 for phase 1 and 10 for phase 2, each counting its Enter VR check) and the 9 comfort checks, 8 of which `--loco` runs on its own;
`xr-sigil-stage` failed intermittently until the walk waited for XR frames after pose writes, see `docs/playtesting.md`) and `--notice` last passed its 5 on 2026-11-15; XO1 to XO4 in `docs/playtesting.md` record the fixes. The two console 404s in the
notice run are the music tracks that are not produced yet.

## How it works

- `page-hooks.js` runs before any app script, right after IWER's UMD build. It installs the
  emulated Quest 3 (`installRuntime({ forceInstall: true })`, since desktop Chromium exposes its own
  `navigator.xr`), collects the renderer and scenes through three.js's `__THREE_DEVTOOLS__` hook,
  and records the requested session mode, the `XRWebGLLayer` init (framebuffer scale) and every
  `fixedFoveation` write.
- The walk loads `/?title&debug`, so `window.__flow` and `window.__combat` are available. Board
  controls are reached by posing the right controller with its ray on the control's world position,
  confirming `__flow.ui.hoveredId`, then pulling the trigger (IWER fires `select`).
- Fights are ended with the debug `K` key (win) and `?cheat`-style `__flow.setCheat('lose')` plus
  `E` (end turn) for the death; the reward, death and title boards are always used with the ray.
- The head sits at a seated 1.2 m, so the recenter's height lift is visible in the checks.
- The locomotion checks (`locomotionCheck`, run inside the walk and alone with `--loco`) use both
  sticks and the right controller: the left stick smooth moves, the right stick x snap turns and the right
  stick forward aims the teleport (teleport defaults on since 8cd86ac, H6; F1 swapped the sticks). Smooth move and snap turn come first. The comfort vignette is then read
  three ways: `__combat.locomotion.vignetteStrength` and `__combat.comfortVignette` while the stick is held
  and after it is released, whether the comfort pass appears in `__xrEmu.passes`, and the mean luma of
  the outer frame band and the centre box at one pose with `comfortVignette.hold = 0.7` against the same
  view with it off (the hit flash is then held on top, to check the two stack). The teleport check sets
  teleport on through the app's settings path (it is already the default, and the title's Settings toggle is pressed off and on with the ray in
  `settingsComfortCheck`, which also reads the stored profile from IndexedDB), pushes the right stick
  forward and scans controller aims in 8 headings until the app itself reports an invalid landing
  (a wall, preferably), checks the arc and ring are dim red and that releasing moves nothing, then scans
  until the app reports a valid landing at least 1.5 m away, and checks the head ends within 3 cm of the
  landing the arc showed, with `rig.position.y` unchanged and a vignette pulse that fades. The aims are
  found by scanning because the room geometry is generated per seed. Every pose or axes write is followed
  by `__xrEmu.frames()` before anything is read. `locomotion-locked-in-combat` runs only in the full
  walk, inside the first fight: with the table up, a held left stick (smooth move) and right stick forward (teleport aim) move nothing with teleport off
  and on, no aim is held and the vignette stays 0.
- The treasure check (`treasureCheck`, 11 checks) starts SPIRE001 (room 3 is a study with a card coffer),
  moves the seated rig to a spot 2.2 m from the coffer with the debug `__combat.teleportToLoot()`, turns the
  head toward it, aims the main-hand ray at the lid and pulls the trigger. It checks that the lid opens
  and the opened key is recorded, that the purse or deck changed by exactly what the in-scene panel
  shows, that no board locked locomotion, that the panel is inside the left eye's view, that a second
  trigger pull pays nothing, and that the saved snapshot holds the opened key. It then reloads to the
  title, resumes with Continue and checks that the coffer is open at once and a trigger pull pays
  nothing. The 2.2 m approach is the
  only teleport: the ray, the pick and the opening are the game's own paths. Pick a seed for it with
  `generateFloor(seed).rooms.filter((r) => r.role === 'treasure')`.
- The rest check (`restCheck`, 17 checks) starts SPIRE007 (room 4 is a hall rest room). It first loses hp the
  way a player does: the first encounter is entered with the `?debug` cheat that leaves the automaton 1 hp,
  `E` ends turns until the enemy's blows have taken the player to 50 hp or less, then a played card kills
  the automaton through the controller (`select` and `target`, the path a desktop click takes) so the fight
  ends as a won one and keeps the player's hp (the debug `K` key does not carry hp into the run), and the
  reward is skipped with the ray. `__combat.teleportToHearth()` then stands the seated rig 2.2 m from the
  hearth. The checks: the beam of the main-hand controller reaches the hearth (the game's own pick along the
  controller's -Z axis, the thing the laser ends on); the trigger heals by exactly the `+N hp` on the panel,
  with N equal to the lesser of the missing hp and 30 percent of max hp rounded down; the hearth is spent
  and recorded as `<room>/chest` in `usedHearths`; the coals dim; only hp changed (cogs, deck, phase); no
  board locked locomotion; the panel is inside the left eye's view; a second pull heals nothing and the beam
  no longer reaches it; once the panel expires the floor's node count is what it was before (no stale panel);
  the saved snapshot holds the key and the new hp; and after a reload and Continue the hearth is spent at
  once, no panel shows, and a trigger pull heals nothing. The run on 2026-11-16 lost 12 hp, so it also
  exercised the cap (+12, not +18).
- Difficulty (3 checks): on the title the ray presses Casual (`xr-title-difficulty`, the settings now hold
  Casual), New Run starts at it (`xr-new-run-difficulty`) and the resumed run after the reload keeps it
  (`xr-continue-keeps-difficulty`). The choice is saved, so the checks that run later in the same browser
  context play Casual. None of them depends on enemy numbers, except the guardian check, which is pinned.
- The guardian phase-1 check (`guardianPhaseCheck`, 6 checks with Enter VR) loads `/?seed=SPIRE004&debug&difficulty=hard`, the
  content as written (the lower levels shrink the guardian's hp and move its threshold), fights the Grand
  Escapement in a real XR session and reads its phase-1 half: the model carries the `phase-change` clip, the
  case is closed, the phase is 1 in the rules and in the shown state, the move list is the four phase-1 moves
  without toll and overwind, the intents shown over three real enemy turns come from those four, and the clip
  never plays.
- The guardian phase-2 check (`guardianPhaseTwoCheck`, 10 checks with Enter VR and the teleport, also run by `--guardian`) starts a fresh Hard
  fight. A starter-deck player cannot reach the flip with legitimate play (a greedy player, every attack then
  block with sigil cards skipped, simulated through `CombatController` on four seeds is dead on turn 6 to 8 with
  the guardian still at 97 to 103 hp), so the debug hook `__combat.setGuardianNearPhaseTwo()` (`src/main.ts`,
  `?debug` only) lowers the guardian's hp to one above its threshold (81 of 160) and flips nothing else. A
  Strike then selected and aimed through the controller (the path a desktop click takes) crosses the threshold
  through the rules' own `checkPhase`. The checks: the hook leaves hp at threshold plus one with the case still
  closed (hinge bones 105 degrees from the clip's last pose), phase 1 and no event; the card drops hp to the
  threshold or below with phase 2 in the rules and the shown state and the six-move list; the `enemy-phase` event
  fires exactly once (counted by wrapping `audio.playCombatEvent`, which receives every rules event once); the
  clip plays once (`caseOpening`, state `phase-change`) and the case is held open, with the door and plate bones
  at the clip's last keyframe within 1 degree in every sample (every 30 ms, about 580 samples) across idle, frozen
  and attack; every intent shown over the real enemy turns after the flip comes from the six moves and a
  phase-2-only one (toll or overwind) is shown within 14 turns (the player only plays Brass Guard, so the fight
  lasts; the seed makes the pick sequence repeatable, toll showed on turn 6); the audio director's
  `musicRequest` goes from `guardian-1` to `guardian-2` in the `guardian-active` state; and no console error
  appears during the check. Evidence: `xr-emu-22-guardian-phase2-before.jpg` (case closed, 81 hp),
  `xr-emu-22-guardian-phase2-open.jpg` (case open, 75 hp) and `xr-emu-22-guardian-phase2-intent.jpg` (toll shown
  as a 30 damage attack, 75 hp). The rules side stays covered by `tests/guardian-phase.test.ts` and the GLB side
  by `tests/guardian-case.test.ts`.
- In the first fight the walk holds the off hand up to read the fan (`12-fan-held`), stages a
  sigil card with a main-hand squeeze released over the table, and traces the card's template by
  holding the trigger and sweeping the main-hand ray across the plate. `xr-sigil-trail` counts
  trail-coloured pixels that appear between two screenshots taken at the same controller pose, so
  it fails unless the trail is in the rendered XR frame; `xr-sigil-cast` fails on Too short or
  Fizzle.
- A pose written with `setHead`, `aimAt` or `placeAt` reaches three.js (camera, grips, rays) and
  the app's hover only in the next XR frame, and the camera's world position moves with the head's
  pitch. So the walk awaits `__xrEmu.frames()` after a pose write before it reads anything derived
  from it (`headPoint`, a card's slot on the fan), and squeezes a card only once
  `fan.hovered` is that card. Reading straight after the write made `xr-sigil-stage` grab the
  neighbouring Strike whenever a frame landed between two reads (see `docs/playtesting.md`).
