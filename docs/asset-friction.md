# Asset friction log

Snags hit while building generated assets, with the fix and the time lost. The Blender project file ([blender-kit-project.md](blender-kit-project.md)) points here.

| Date | Asset | What happened | Fix | Minutes lost |
| --- | --- | --- | --- | --- |
| 2026-11-17 | corridor, guardian-vault, gear-shaft | `build-room-kit.py` stamps the report `files` map before `uv1-report.json` and `compare_engine` are written, and the assemble step copies that map into provenance `stagingFiles`. Both recorded stale hashes for those two files after the first re-bake (fixed in dcbdab6); the hall's `uv1-report.json` hash had been stale since its own build. | Refresh the report `files` map from disk immediately before assembling, then check every recorded hash against its file for all rooms at the end of a build. | about 15 |
| 2026-11-17 | study | The study's pinned engine shots come from `src/world/room-asset-proof.ts`, which does not load rooms through `loadStudyAsset`, so they cannot show runtime material changes such as the c0dd517 emitter fix. | Open: route the study proof through `loadStudyAsset`, or treat its engine shots as lightmap-path evidence only. | about 5 |
