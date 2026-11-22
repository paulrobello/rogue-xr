# CLAUDE.md

Clockwork Spire (`rogue-xr`) is a seated WebXR roguelike deckbuilder for Quest 3, built on three.js 0.186.1 and `@par/xr-workspace` from the sibling `../mux-xr` checkout. [PRD.md](PRD.md) holds goals, design decisions D1–D10, budgets and the phase ladder; [plans/](plans/) holds per-phase tasks; cards live on the kanban board (project `rogue-xr`).

## Development and verification

| Command | Use |
| --- | --- |
| `make install` | Install dependencies (bun 1.4.4) and point git hooks at `.githooks/` |
| `make dev` | Vite dev server on port 4260 (foreground). `make dev-start` runs it in a par-mux window, `make dev-stop` stops it |
| `make preview` | Serve the production build on port 4261 |
| `make checkall` | Biome, strict TypeScript, Vitest, production build |
| `make checkall-ci` | `checkall` plus asset validation and Gitleaks. Must pass before any push |

`../mux-xr` must exist as a sibling checkout: the toolkit is a `file:` dependency. `bun run prep` stages the toolkit's fonts and hand models into `public/` (gitignored) and runs before `dev` and `build`.

## Constraints

- Import `@par/xr-workspace` through its public exports only, never `/internal/*`.
- Keep `three` pinned to exactly the toolkit's peer version.
- `rules/`, `floor/` and `sigil/` stay pure: no three.js imports, fully unit-tested.
- Every random choice comes from a named stream of the run seed (`core/rng.ts`), so runs replay exactly.
- Quest 3 budgets and the lightmap contract are in the PRD. Desktop frame numbers only rank variants; only headset measurements close a budget criterion.
- Asset work goes through the owning workflow skill named in the PRD asset table, and every asset finishes with `validate-generated-assets`. Paid generation follows the slice asset list and any explicit post-slice approvals recorded in the PRD.
