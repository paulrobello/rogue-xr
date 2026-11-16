# Core PBR material set (P4-T3)

Six tileable materials for the Gilded Lamplight direction ([docs/art-bible.md](../../docs/art-bible.md)).

| Material | Tile (m) | Crop from source | Seam repair (y, x) | Notes |
| --- | --- | --- | --- | --- |
| brass-aged | 0.5 | full 2048 | feather, none needed | metallic 1, roughness 0.36 to 0.54 |
| brass-polished | 0.5 | full 2048 | feather, feather | metallic 1, roughness 0.19 to 0.25, colour contrast 0.4 hides feather blending |
| walnut | 0.5 | columns 512 to 1540, rows from 492 | feather, none | both x edges sit on plank seams, two 0.25 m planks per tile |
| stone-floor | 1.5 | 1984 at (32, 32) | quilt, quilt | minimum-difference cuts keep mortar crisp |
| stained-glass | 0.6 | 1024 at (520, 72) | none | emissive map equals base colour; the material starts at emissive intensity 0 |
| wallpaper | 0.75 | 1024 at (572, 496) | none | crop lands on whole pattern periods |

## Files

- `raw/mat-<name>.png`: immutable 2048 px Higgsfield `nano_banana_pro` sources. Spec `assets-source/style/prompts-materials.json`, provenance (prompt, job id, sha256) in `assets-source/style/provenance.json`.
- `derived/report.json`: per-material crop, repairs, source sha256, seam ratios, mip checks, value ranges and the sha256 of every derived and runtime file.
- `derived/*.png` and `checks/*-2x2.png`: full-resolution maps and 2x2 tiling previews. Gitignored, because `build_materials.py` reproduces them byte for byte (two consecutive builds gave identical hashes for all 19 runtime maps).
- Runtime: `public/assets/materials/<name>/<name>.<role>.png` at 1024 px, roles `basecolor`, `normal`, `orm` and `emissive`, plus `materials.json` (tile size and map filenames). `src/world/materials.ts` binds them by exact role.

Rebuild: `python3 -I scripts/assets/build_materials.py [--only name,name]` (system Python with numpy and Pillow).

## Channel contract

- Base colour and emissive are sRGB. Normal and ORM are linear data.
- Normal is OpenGL tangent space (+Y up, the glTF and three.js convention), derived from a high-passed luminance height and renormalised after resizing.
- ORM packs ambient occlusion in R, roughness in G and metallic in B, the layout three.js reads from one texture bound to `aoMap`, `roughnessMap` and `metalnessMap`.
- Base colour is de-lit: low-frequency luminance is divided out (strength per material) so painted lighting does not fight the room's lights.

## Checks

| Check | Result |
| --- | --- |
| Wrap seam ratio at full size (1.0 means as continuous as the interior) | all at most 1.54 (`seam_after` in the report) |
| Mip chain, 512 down to 16 px: wrap step above the largest interior step | at most +2.15/255 (walnut normal, its plank groove on the wrap). Polished brass +0.09, every other map at or below +1.14 |
| Mip mean drift | 0.0 for every map |
| Smallest mean normal length over the mips | 0.863 (brass-aged) to 0.988 (glass) |
| Live render, `?view=material-proof` | neutral, grazing and warm light, near, far and 70 degree oblique views: [docs/verification/p4-materials-live.jpg](../../docs/verification/p4-materials-live.jpg). Grazing light from above lights the upper stone edges, so the normal orientation is correct |
| 2x2 tiling sheet | [docs/verification/p4-materials-2x2.jpg](../../docs/verification/p4-materials-2x2.jpg) |

## Budget

Uncompressed, each 1024 px RGBA map with mips takes about 5.6 MB of GPU memory, so the 19 maps take about 106 MB. That is too much for Quest 3, so the runtime will load KTX2 copies (P4-T7). The KTX2 copies and their sizes are pending, because KTX-Software is not installed and downloading it needs Paul's approval.

## Validation (`validate-generated-assets`, 2026-11-15)

| Gate | Status | Evidence |
| --- | --- | --- |
| Technical | Pass, except KTX2 | All 6 raw sha256 values match `provenance.json`. All 19 runtime maps fully decode as 1024x1024 RGB and match the sha256 in `report.json`. Every `materials.json` reference exists. The rebuild is byte-identical. Seam, mip and live-render checks are in the table above, and `tests/materials.test.ts` covers manifest parsing, colour spaces, ORM binding and tile repeat. KTX2 copies and their sizes are pending. |
| Creative | Pending owner review | Live sheet and 2x2 sheet in `docs/verification/` |
| Rights | Pending | Generated under Paul's Higgsfield account with spend approved in the PRD. The plan's commercial-use terms are not recorded in the repo. |
| Owner | Pending | Paul has not reviewed the set |

Not tested: Quest 3 on-device rendering and memory, a missing-texture fallback (no consumer defines one yet, and `loadPbrSet` rejects the whole set when any map fails to load), and dispose and reload cycles (the room loader in P4-T4 and P4-T7 owns texture lifetime).

## Known limits

- The plan said "Blender-derived maps". These are derived by a checked-in numpy script instead, because the sources are 2D painted textures and a Blender bake would add no information.
- stone-floor repeats a recognisable stone arrangement across a 2x2 grid at 3 m. That is fine on a floor broken up by furniture. A large open floor would need a second variant or a detail overlay.
- Polished brass still shows a faint large-scale grid in a flat-lit 2x2 preview. Under its reflections in the live render it does not show.
