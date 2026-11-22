# Trellis Keeper

The Trellis Keeper is a seeded solo Conservatory opponent. Its arched trellis body exposes a seed-pod lamp and the two pruning arms have separate hinges. The front, side and back views show the same neutral assembly for owner review. [Concept sheet](../assets-source/concepts/trellis-keeper/trellis-keeper.png)

The current gameplay build uses the standard combat stand-in until the model, rig and clips are accepted. New Conservatory runs can choose either the Owl or the Keeper. Earlier saves and the showcase keep the Owl. Seed `TRE10002` places the Keeper in Conservatory room 1 and opens with Trellis Brace.

## Combat and tells

| Move | Before the action | At contact |
| --- | --- | --- |
| Trellis Brace | Lock the frame around the pod and bring both arms in. The guarded band names Double Cut as the next action. | The frame locks and gains 10 Block on Hard. |
| Double Cut | Raise the left and right shears clear of each other and expose the body. | Cut left then right. The player receives two separately applied 5-damage hits on Hard. |
| Hook Jab | Set one arm forward with the other resting against the frame. | Make one short cut for 6 damage on Hard. |

The brace and jab can be drawn as ordinary intents. The double cut occurs only after a brace. Pose the sequence for a seated view so both cuts read independently of the sound and the UI.

## Model and rig

- Use the existing automaton contract in metres, +Y up, −Z forward, with the feet on the ground plane. Gameplay owns position and facing.
- Keep the torso frame, seed-pod core, shoulders, elbows, forearm tools, hips and feet as separately articulated forms. Use up to one skin with 40 joints and at most four influences per vertex. Target a 25k-triangle ceiling and four material slots. Bind the shared brass, steel and accent sets with a separate emissive core slot.
- Put `socket-hit` on the front torso frame, `socket-eye` at the visor, and `socket-weapon` on the leading pruning jaw. Keep weapon and hit sockets separate through every attack.
- Export `idle`, `frozen`, `attack`, `hit`, and grounded `death` clips. Add `intent-<move-id>` poses and `action-<move-id>` clips with measured durations and contact markers. Keep the forearm jaws clear of the torso and each other. A played hardware sound must agree with visible contact.
- Reimport the runtime GLB and check the neutral silhouette, feet and sockets, finite skin weights, and bounds during both cuts and defeat. Retain the editable source and the reproducible export. The combat capsule stays available if a future model fails to load.

Concept, model, rig and animation approval are tracked separately. This sheet is at the concept stage. [Provenance](../assets-source/concepts/trellis-keeper/provenance.json) · [Enemy loader](../src/enemies/enemy-asset.ts)
