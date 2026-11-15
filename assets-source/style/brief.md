# Clockwork Spire — direction exploration brief (P4-T1)

Goal: pick one art direction before any asset production. Every later concept sheet, card
illustration, UI icon and 3D asset is generated or modeled against the chosen board (PRD D8).

Fixed by the PRD: a warm, candlelit, arcane-brass wizard tower that rebuilds itself each run;
brass, walnut and stained glass; rogue clockwork automatons; a brass combat table that unfolds at
a seated player; painted card art; physical dice; sigils drawn in the air.

Fixed by the platform (Quest 3 standalone, baked lightmaps, 72 Hz): large readable forms and
clean silhouettes, detail carried by textures and baked light rather than dense geometry, no
volumetric fog or heavy particle haze as a load-bearing part of the look, glossy brass highlights
supplied by probes. Concept art should depict something this pipeline can build.

## Directions

| Code | Name | Read |
| --- | --- | --- |
| A | Gilded Lamplight | Painterly semi-realism. Deep warm shadows, amber candlelight, saturated jewel-tone stained glass. The most "premium" read. |
| B | Storybook Brass | Stylized, slightly exaggerated chunky forms, hand-painted textures, soft bounce light. The most Quest-friendly read. |
| C | Nouveau Orrery | Art-nouveau curves and brass filigree, teal and gold complementary palette, cool moonlight through glass against warm candles. |
| D | Alchemist's Forge | Heavier and grittier: copper, iron and soot, ember orange, glowing furnace cores in the automatons. |

Per direction: one style board (environment thumbnail, automaton, card, dice, sigil, palette) and
one hero-room frame (the study with the gear shaft and stained-glass window, seated eye height).

Model: Higgsfield `nano_banana_pro`, 2k. Prompts, job ids and hashes in `provenance.json`.

## Direction choice (2026-11-15)

Paul chose the recommendation "A as the base, borrowing C's slender automaton silhouette and card
frame layout" with a one-word "Yes" in chat on 2026-11-15. This picks the direction to refine. It
is not approval of the style board; that owner gate (P4-T1) stays open until Paul approves the
locked board.

## Board approval (2026-11-15)

Paul approved the locked board and every art-direction recommendation in chat: "All recommendations for art direction are approved, as well as any needed spend".
Canonical board: `locked/L-board-1.png`. Rules: `docs/art-bible.md`.
