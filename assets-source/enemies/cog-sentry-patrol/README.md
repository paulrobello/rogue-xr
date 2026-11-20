# Cog Sentry patrol motion

This animation pack drives the existing plated Cog Sentry on its original 21-joint rig. The game loads the combat model and binds the separate locomotion GLB by joint name. The package contains five actions and zero meshes, skins, materials or images. Gameplay owns the character's heading and world position. The hips carry the weight transfers, the knees articulate around their forward hinge and the brass soles settle level during support.

| Action | Seconds | Gameplay motion at authored speed |
| --- | ---: | --- |
| `patrol-start` | 0.50 | Accelerate uniformly from rest to 0.90 m/s. The left shoe supports the first 0.225 m while the right steps forward. |
| `patrol-walk` | 1.20 | Travel 1.08 m per full stride. The right foot makes contact at phase 0 and the left at phase 0.5. Each provides support for 7/12 of the cycle. |
| `patrol-stop` | 0.70 | Begin at walk phase 0. Decelerate uniformly over 0.315 m as the trailing left foot recovers to neutral. |
| `patrol-turn-left` | 1.20 | Rotate +90° about world Y with smoothstep timing. The mask sights the turn before the shoulders. The inside foot opens, the outside foot steps through and the inside foot closes. |
| `patrol-turn-right` | 1.20 | Mirror the three-step pivot through −90° about world Y. |

The walk loops. Both turns start and end in the combat idle's opening pose, which lets the game chain quarter turns. The start ends on walk phase 0 and the stop begins there. To change travel speed, advance the simulation distance and action clock together. The forward axis is local −Z in glTF and +Y in Blender. Anatomical right is +X.

## Source and rebuild

Codex authored the animation in Blender using GPT-6.2 Astra at extra-high effort for the November 20, 2026 roaming-enemy request. The source rig and body are from `assets-source/enemies/cog-sentry/blend/cog-sentry.low.blend`. The editable `locomotion.blend` contains the rig, original body, five keyed actions and relative references to the project's six existing brass texture images. The animation uses project-owned joint poses and analytical two-link leg solves. The source rig, combat GLB, patrol GLB, editable source and generator hashes are in [validation.json](validation.json).

Run from the repository root with Blender 5.2.3 LTS. Both scripts use the same 60 Hz action data.

```sh
blender -b -t 2 --python-exit-code 1 -P scripts/assets/build-sentry-patrol.py -- --renders --movie
```

The generator samples the original armature, exports the actions, copies the original GLB joint hierarchy into the animation pack and removes redundant static translation and scale channels. Before writing the runtime file, it binds the resulting tracks to the combat GLB, reimports the combined skin in Blender and checks the deformed vertices at 120 Hz. The mesh contact check applies gameplay travel first and measures every vertex on each planted shoe. It also measures floor height, maximum sole clearance, root stability, opposite-shoe triangle intersections and full-mesh endpoint agreement. Three independent exports produced the same 122,684-byte runtime GLB. Across 581 samples, the greatest planted-vertex drift was 0.255 mm, with zero intersections between the two shoes.

The six frames in [patrol-poses.jpg](patrol-poses.jpg) show departure, right contact, left swing, left support, the left pivot and arrival. An independent Astra review scored this pose strip 91/100 for the support and swing silhouettes, opposing forearm motion and upright chest. The optional movie uses the gameplay distance and heading curves across two walking segments joined by a quarter turn. The studio floor uses 0.5 m squares.
