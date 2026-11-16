# Emulated-XR walk (IWER)

`walk.mjs` drives the immersive-session code paths in headless Chromium on the GPU, with Meta's
[IWER](https://github.com/meta-quest/immersive-web-emulation-runtime) (`iwer`, pinned in
`devDependencies`) standing in for a Meta Quest 3. It is emulator evidence: IWER renders both eyes
into the page canvas and applies neither foveation nor the framebuffer scale, so headset checks
still close every comfort, budget and readability criterion.

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
```

The update-notice check needs a production build (the dev server stamps no build id):

```sh
bunx vite build --outDir /tmp/rxr-xremu-dist
bunx vite preview --outDir /tmp/rxr-xremu-dist --port 4262   # stop it afterwards
node scripts/xr-emu/walk.mjs --notice http://localhost:4262
```

Screenshots land in `docs/verification/xr-emu-*.jpg` with a JSON report
(`xr-emu-report.json`, `xr-emu-report-notice.json`). The exit code is 1 when any check fails
(`make` reports 2). As of 2026-11-16 the walk passes every check (52, which includes the 11 treasure and resume checks;
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
