# Conservatory art review

The clock has a short diamond-shaped hour hand and a longer narrow minute hand. Both turn around one fixed brass pin. The cauldron has a curved surface current and four separately animated bubbles. Desktop gameplay verification showed the current turning and the bubbles rising. Both recipe ingredients traveled from the tray into the liquid before the vial appeared. A wrong ingredient returned to the tray after mixing. [Clock face at 10:10](staging/review-clock-face-1010.png) · [Cauldron and ingredient models](staging/review-detail.png)

The Mooncap has a flared ivory stem under its blue crescent. The recipe tile uses a shallow relief of the same sculpture, including the stem, foot and three glints. On reimport the stem overlapped the cap by 16.47 mm on the ingredient and 7.40 mm on the tile. That Mooncap revision was reviewed in the Conservatory on Metal with an emulated Quest controller. The stem was visible on the recipe tile, during pickup from the grandfather clock, and during the jump into the cauldron. The Blender stills above show the earlier kit. [Current geometry measurements](staging/report.json)

The Quest playtest exposed a gap between the grandfather clock uprights and its plinth. Both uprights now extend 10 mm into the plinth, measured on the reimported GLB. The clock's top, dial, pendulum and drawer retain their placements. [Clock contact measurements](staging/report.json)

The kit has 50,388 triangles across all models and 17 materials with embedded color, roughness and normal maps. Ambient occlusion has no separate bake. The broom bristles and repeated owl breast scales are visible simplifications. Individual objects are instantiated by name and culled with their rooms. The gameplay colliders are authored in the runtime. Owner visual and immersive comfort sign-off remain open. [Generator, packed Blender source and runtime hashes](manifest.json)

The paintings are original foreground cutouts and an original observatory background. [Portrait source and runtime hashes](portraits/manifest.json) · [Original Quest Browser play-distance comparison](../../../docs/verification/quest-conservatory.jpg)
