# Enemy rig and animation review

Paul approved the three base models and one combined rig and animation review on November 21, 2026. The rigged exports are staged for that review. The local headset preview on port 4261 loads them through the game’s normal enemy loader. Use a fresh run to get the listed encounter.

| Enemy | Seed and encounter | Independent score | Review evidence |
| --- | --- | --- | --- |
| Lantern Bailiff | `CRYPT004`, Upper Works room 4 | 89/100 | [Sweep](../assets-source/enemies/lantern-bailiff/staging/runtime/review-sweep.mp4) · [Pose sheet](../assets-source/enemies/lantern-bailiff/staging/runtime/review-contact-sheet.png) · [Reimport report](../assets-source/enemies/lantern-bailiff/staging/runtime/reimport-report.json) |
| Mortar Scarab | `CRYPT001`, Upper Works room 6 | 82/100 | [Moves](../assets-source/enemies/mortar-scarab/staging/runtime/review-moves.mp4) · [Pose sheet](../assets-source/enemies/mortar-scarab/staging/runtime/review-contact-sheet.png) · [Reimport report](../assets-source/enemies/mortar-scarab/staging/runtime/reimport-report.json) |
| Trellis Keeper | `TRE10002`, Conservatory room 1 | 87/100 | [Moves](../assets-source/enemies/trellis-keeper/staging/runtime/review-moves.mp4) · [Pose sheet](../assets-source/enemies/trellis-keeper/staging/runtime/review-contact-sheet.png) · [Reimport report](../assets-source/enemies/trellis-keeper/staging/runtime/reimport-report.json) |

## Authored motion

The Bailiff’s five steel links and pendant have separate joints. Rotation peaks travel from frame 13 at the grip end to frame 16 at the pendant, a lag of 0.10 seconds. The lantern reaches the forward impact at 0.50 seconds and overshoots before settling. Sampled motion kept at least 62 mm of torso clearance and 205 mm of floor clearance. Its weapon socket follows the pendant.

Scarab rake contacts were measured at 0.300 and 0.533 seconds. The shell plates clear one another and four feet stay planted through the rake. Keeper Double Cut closes the left jaw at 0.400 seconds and the right at 0.867 seconds. Reimport checked the tool clearances, planted soles, and the grounded defeat.

The independent review saw a stiff planted lower body on the Bailiff, partial obstruction of the Scarab’s forefeet by the table, and a less distinct head-on Keeper jab. Owner review of the rigs and clips and physical Quest checks remain open.

## Gameplay evidence

Seeded browser encounters mounted the authored actors, played their wind-ups and attacks, reacted to a Strike, and played defeat before returning to exploration. The hit and defeat fixture started the same Strike with the target at 20 and 1 HP. The browser showed the Scarab's two hits 0.250 seconds apart and the Keeper's two hits 0.483 seconds apart, each within one 60 Hz frame of the authored gap. The Bailiff's sweep showed one hit at the lantern's forward contact. Emulated Quest 3 rendered both eyes for each seeded fight and accepted a controller-trigger reward pick after its defeat.

## Exact exports

| Enemy | SHA-256 of reviewed GLB | Source and generation |
| --- | --- | --- |
| Lantern Bailiff | `2363b7e7bb5d7267620f9710396210be670ee90e1f7d183ca022a55123c67754` | [Editable rig](../assets-source/enemies/lantern-bailiff/staging/runtime/lantern-bailiff.blend) · [Generator](../scripts/assets/build-lantern-bailiff.py) |
| Mortar Scarab | `25cf660e7c86c6845c92f7b282bcd35f70daa8162f711f48655d4e0f3f9708a4` | [Editable rig](../assets-source/enemies/mortar-scarab/staging/runtime/mortar-scarab.blend) · [Generator](../scripts/assets/build-mortar-scarab.py) |
| Trellis Keeper | `c0aff4bc245b5e3ee59375b6271911aef1f26a64fa350a434a21e7d4d33e18e4` | [Editable rig](../assets-source/enemies/trellis-keeper/staging/runtime/trellis-keeper.blend) · [Generator](../scripts/assets/build-trellis-keeper.py) |

Run the asset gate against the staging directory with one `--staged-enemy <id>` per enemy. The approved base exports stay in each `staging/base` directory.
