# Dungeon enemies

Mortar Scarab and Lantern Bailiff already run as seeded Upper Works encounters in the dungeon preview. This brief binds their proposed visuals to the existing moves and game loader. The concept sheet is staged for owner review. [Concept sheet](../assets-source/concepts/dungeon/dungeon-enemies-sheet.png) · [Rules](../src/content/enemies.ts)

| Enemy | Base-model direction | Seeded in-game check |
| --- | --- | --- |
| Mortar Scarab (`mortar-scarab`) | Low limestone shell with sliding lamellae, six independent metal limbs with brass joint caps, and an amber vent. Set the neutral back height near 0.6 m. Keep all six feet readable from the combat seat. | `CRYPT001`, Upper Works room 6 |
| Lantern Bailiff (`lantern-bailiff`) | A compact 1.6–1.75 m gaoler with an amber torso lantern, armored shoulders, and a different, smaller lantern on a short chain. The chain hand and torso lantern must have distinct silhouettes. | `CRYPT004`, Upper Works room 4 |

## Tells and actions

| Move | Pose while the intent is shown | Action pose |
| --- | --- | --- |
| `shell-seal` | Fold shell plates inward and tuck the forelegs. Keep the face of the shell readable. | Lock the plates closed and settle the feet. |
| `mortar-rake` | Open the plates and raise the forelimbs to expose the amber vent. | Sweep the forelimbs in quick succession and place `impact` at the first clear strike. |
| `grind` | Lower the head to one side and raise the lead leg. | Turn the front plate toward the player as the limb grinds forward. |
| `draw-chain` | Raise the chain hand and pull the outer lantern back. | Draw the chain taut, revealing the sweep on the next turn. |
| `lantern-sweep` | Hold the chain fully cocked. Leave the torso lantern exposed. | Swing the outer lantern in a readable arc and place `impact` at its forward peak. |
| `cinder-glance` | Angle torso and visor toward the player. Keep the chain lowered. | Flash the torso lantern on the attack beat. |
| `lantern-parry` | Raise the off arm between the player and the torso lantern. | Brace the arm and keep the feet planted. |

The Scarab scrape already plays when `mortar-rake` is announced. The Bailiff chain cue plays when `draw-chain` is announced. An action clip should leave space around those tells. [Cue routing](../src/audio/cues.ts)

## Runtime delivery

- Use metres, glTF +Y up, and a −Z-facing neutral pose with planted feet at y=0. Gameplay owns translation and yaw. Bound the culling sphere to cover the moving limbs and the lantern arc.
- Stage one skin with up to 40 joints and four influences per vertex, a maximum of 25,000 triangles, and up to four material slots. The existing enemy gate expects image-free GLBs bound to the shared material sets. Use a separate emissive core slot and record the exact slot names in the manifest.
- Include `socket-hit`, `socket-eye`, and `socket-weapon`. Attach the Scarab weapon socket to its lead attacking limb and the Bailiff weapon socket to its outer lantern. The hit socket belongs on the exposed armored body where the game’s impact effects read correctly.
- Export the shared `idle`, `attack`, `hit`, `death`, and `frozen` clips plus `intent-<move>` poses and `action-<move>` clips for the table above. Record each action’s measured duration and `impact` timing. Keep the held intent stable until the action begins and keep `death` on the floor. Reimport to check foot contact, shell and chain clearance, and socket tracking at the shown and impact poses.
- Preserve the checked-in generator, editable Blender files, reimport images and stage hashes. Before promotion, extend the asset gate’s current move-map expectations for these two asset IDs and exercise the seeded fights through spawn, both telegraphs, impact, hit, death, and return to exploration. [Runtime manifest and loader](../src/enemies/enemy-asset.ts) · [Enemy asset gate](../scripts/assets/asset-check.py)
