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
```

The update-notice check needs a production build (the dev server stamps no build id):

```sh
bunx vite build --outDir /tmp/rxr-xremu-dist
bunx vite preview --outDir /tmp/rxr-xremu-dist --port 4262   # stop it afterwards
node scripts/xr-emu/walk.mjs --notice http://localhost:4262
```

Screenshots land in `docs/verification/xr-emu-*.jpg` with a JSON report
(`xr-emu-report.json`, `xr-emu-report-notice.json`). The exit code is 1 when any check fails
(`make` reports 2). As of 2026-11-15 both runs pass every check (30 for the walk, 5 for
`--notice`); XO1 to XO4 in `docs/playtesting.md` record the fixes. The two console 404s in the
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
