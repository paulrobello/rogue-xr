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

Each map has a KTX2 copy beside its PNG (`<name>.<role>.ktx2`), made by `python3 -I scripts/assets/encode_materials_ktx2.py` with KTX-Software 4.4.2, installed from Khronos's signed and notarized release into `~/.local/opt/ktx-software-4.4.2`. The encoding is UASTC at quality 2 with RDO, Zstandard level 18 and an encoder-generated mip chain. The copies are stored bottom-up, because three.js flips PNGs on upload but cannot flip compressed data. Per-file sizes and sha256 are in `public/assets/materials/ktx2-report.json`.

| All 19 maps | PNG | KTX2 |
| --- | --- | --- |
| Download | 27.3 MB | 15.5 MB |
| GPU memory with mips | about 106 MB (RGBA8) | 26.6 MB (ASTC 4x4 on Quest 3) |

The two copies of the stained-glass base colour and emissive maps are identical, about 1 MB each. Pointing the emissive role at the base colour file would save that if memory gets tight.

KTX2 check: `?view=material-proof&tex=ktx2` loads the copies through `KTX2Loader`. Rendered against the PNG path at four views (near brass, grazing stone, warm glass and wallpaper, 70 degree oblique), the mean difference is 0.16 to 2.4 out of 255. A vertically flipped comparison differs by 28 to 59 out of 255, which confirms orientation and normal-map green match. That was measured on desktop Chrome on an M-series Mac, whose transcode target differs from Quest 3's ASTC.

## Validation (`validate-generated-assets`, 2026-11-15)

| Gate | Status | Evidence |
| --- | --- | --- |
| Technical | Pass on desktop | All 6 raw sha256 values match `provenance.json`. All 19 runtime maps fully decode as 1024x1024 RGB and match the sha256 in `report.json`. Every `materials.json` reference exists. The rebuild is byte-identical. Seam, mip and live-render checks are in the table above, and `tests/materials.test.ts` covers manifest parsing, colour spaces, ORM binding, tile repeat and the KTX2 copies. All 19 KTX2 copies render within 2.4 of 255 of the PNGs. |
| Creative | Approved by Paul, 2026-11-15 | Asked "Do you approve the six materials as shown in the two review sheets?" about `docs/verification/p4-materials-live.jpg` and `p4-materials-2x2.jpg`. Paul answered: "Yes" |
| Rights | Pending | Generated under Paul's Higgsfield account with spend approved in the PRD. The plan's commercial-use terms are not recorded in the repo. |
| Owner | Approved by Paul, 2026-11-15 | Same answer, for use as the slice's core room materials |

Not tested: Quest 3 on-device rendering and memory, a missing-texture fallback (no consumer defines one yet, and `loadPbrSet` rejects the whole set when any map fails to load), and dispose and reload cycles (the room loader in P4-T4 and P4-T7 owns texture lifetime).

## Known limits

- The plan said "Blender-derived maps". These are derived by a checked-in numpy script instead, because the sources are 2D painted textures and a Blender bake would add no information.
- stone-floor repeats a recognisable stone arrangement across a 2x2 grid at 3 m. That is fine on a floor broken up by furniture. A large open floor would need a second variant or a detail overlay.
- Polished brass still shows a faint large-scale grid in a flat-lit 2x2 preview. Under its reflections in the live render it does not show.
