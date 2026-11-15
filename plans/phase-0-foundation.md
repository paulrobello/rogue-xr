# Phase 0 — Foundation and deploy pipeline

PRD: [P0](../PRD.md#p0--foundation-and-deploy-pipeline). Gate for every task: `make checkall` (Biome, strict `tsc --noEmit`, Vitest, `vite build`). `make checkall-ci` = `checkall` + `gitleaks dir . --redact --no-banner`.

Pinned versions (write these into `package.json` in P0-T1, not before): bun 1.4.4 (`packageManager`), three 0.186.1, `@types/three` 0.186.0, `@types/webxr` 0.5.24, `@dimforge/rapier3d-compat` 0.21.0, vite 8.3.5, typescript 7.0.2, `@biomejs/biome` 2.5.15, vitest 5.0.3, happy-dom 21.0.4, `@par/xr-workspace` `file:../mux-xr/packages/xr-workspace` (0.2.0; brings troika-three-text 0.52.5). Ports: dev 4260, preview 4261.

### P0-T1 — Toolchain scaffold and Makefile
- Depends on: none.
- Work: `package.json` with the pinned versions above, `tsconfig.json` (strict, `moduleResolution: bundler`; not `noUncheckedIndexedAccess`, because the toolkit ships TypeScript source that fails it), `biome.json` (mirror mux-xr), `vite.config.ts` (host `0.0.0.0`, port 4260 strictPort, preview 4261), `vitest.config.ts` (happy-dom), `.gitignore` (`node_modules`, `dist`, `.env*`, `*.local.*`), `CLAUDE.md` (gate, ports, module map, asset routing from the PRD). Makefile with every standard target: `install build test lint fmt typecheck checkall checkall-ci dev dev-start dev-restart dev-stop preview`. `dev-start`/`dev-restart`/`dev-stop` run the dev server in a par-mux pane, never `&`. Add a pre-commit hook running `make checkall` that skips docs-only commits (mux-xr pattern). Module folders under `src/` per the PRD module table with one placeholder test.
- Verify: `make checkall` and `make checkall-ci` green; `make dev-start` serves on 4260 and `make dev-stop` stops it.

### P0-T2 — Toolkit integration and boot scene
- Depends on: P0-T1.
- Work: depend on `@par/xr-workspace` (public exports only). Run `stageWorkspaceAssets('public')` from a `prebuild`/`predev` script so fonts and hand models are always staged; gitignore the staged copies. Boot a `WebGLRenderer` with XR enabled, a placeholder brass-toned room (box geometry, warm point light), an Enter VR button driven by `createXrSession` (medium foveation), `createStandardHand` for both hands tinted brass (`handColor`/`armColor` from a `palette.ts`), `createPointer` + `createButtonEdges` wired to the action bus (P0-T3). Desktop mode: orbit/WASD placeholder camera.
- Verify: `make checkall`; desktop page renders the room (screenshot via headless Chromium on a GPU host, saved under `docs/verification/`); unit test that the session helper is called with medium foveation.

### P0-T3 — Seeded PRNG, action bus, state machine
- Depends on: P0-T1.
- Work: `core/rng.ts` — one root seed (string → 32-bit hash), named sub-streams `floor`, `deck`, `dice`, `loot`, `ai` derived by hashing the root seed with the stream name, each a small fast PRNG (e.g. sfc32) with `next()`, `int(min,max)`, `pick()`, `shuffle()`, and serializable state for run snapshots. Seed display format: 8 Crockford base32 characters. `core/actions.ts` — typed action bus shared by desktop and XR presenters. `core/state.ts` — game state machine skeleton: `title → explore → combat → reward → explore … → workshop`.
- Verify: Vitest — same seed gives identical sequences per stream; streams are independent (consuming `deck` does not change `dice`); snapshot/restore resumes the exact sequence; state-machine transition table test.

### P0-T4 — CI workflow
- Depends on: P0-T2.
- Work: `.github/workflows/ci.yml`: checkout rogue-xr into `rogue-xr/`, checkout `paulrobello/mux-xr` (public) at a pinned SHA (start at `3adb6bb`) into `mux-xr/` as a sibling, setup bun 1.4.4, `bun install --frozen-lockfile` in mux-xr then rogue-xr, `make checkall-ci`. Pin every `uses:` ref per `~/.claude/guides/git-ci.md`. Record the mux-xr SHA in one place (`toolkit-release.json`) read by CI.
- Verify: workflow lints with `actionlint`; the first CI run after Paul approves the push is watched to green.

### P0-T5 — Pages deploy to spire.pardev.net and update notice
- Depends on: P0-T4.
- Work: Pages deploy job (build artifact from the same sibling checkout). Follow the house recipe in order: (1) DNS-only CNAME `spire.pardev.net` → `paulrobello.github.io` in Cloudflare; (2) only then commit `public/CNAME`; (3) `PUT /repos/paulrobello/rogue-xr/pages` with the custom domain. New-version notice with Reload button per `~/.claude/guides/node-typescript.md` (build stamps `version.json`; the app polls and shows the notice in desktop and in-scene).
- Approval: the push, the DNS record and the Pages API call each need Paul's go-ahead.
- Verify: live render of `https://spire.pardev.net` in a browser (not an HTTP 200); update notice shown after a second deploy.

### P0-T6 — Physical: enter VR on Quest 3
- Depends on: P0-T5.
- Work: open `https://spire.pardev.net` (or the adb-reverse dev URL) in Quest Browser, enter VR, confirm brass hands and the placeholder room.
- Verify: Paul's headset check recorded in `docs/verification.md` as physical evidence, separate from browser evidence.
