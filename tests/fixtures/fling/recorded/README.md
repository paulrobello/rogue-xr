# Recorded fling traces

Card releases captured on a Quest 3 under `?debug` and downloaded with the "Download N fling traces" button (`src/hand/fling-trace.ts`). Each file holds `{ "traces": [...] }` exactly as downloaded.

Before committing a file, set each trace's `intended` to the id of the enemy the throw was meant for, from the session notes. Leave it `null` for throws that were not aimed at an enemy. `tests/fling.test.ts` replays every trace here to its recorded decision and checks each reviewed one against `intended`.

Procedure: `docs/playtesting.md`, "Recording fling traces in the headset (P3-T3)".
