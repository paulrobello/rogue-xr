# attack-strike (prototype holo card)

Prototype for the portal card window. Not an approved card illustration.

| File | Origin |
| --- | --- |
| `frame-source.png` | Crop `740x1110+220+250` of `assets-source/style/locked/L-cards.png` |
| `frame.png` | `frame-source.png` cropped `716x1086+12+10`, alpha: rounded card outline (radius 40) minus the window circle, centre (350, 408), radius 288 |
| `attack-strike-{back,mid,front}.png` | Higgsfield `nano_banana_pro`, spec `assets-source/style/prompts-holo.json`, provenance in `assets-source/style/provenance.json` |
| `attack-strike-{mid,front}.cutout.png` | Higgsfield `image_background_remover` on the mid and front layers (mid: job `0530b12e-915d-4a75-a137-50088a4b910d`, front: job `202f7f3b-11a2-41b4-bc7c-055001121a85`) |

Runtime copies in `public/assets/cards/attack-strike/`: `back.jpg` (1024², quality 88), `mid.png`
and `front.png` (cutouts at 1024², green despilled with `-channel G -fx 'min(g,max(r,b))'`), and
`frame.png` unchanged. Layer depths and sizes live in `src/cards/card-proof.ts`.
