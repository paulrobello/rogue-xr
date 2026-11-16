# UI icons, dice faces, sigil glyphs, title key art (P5-T6)

Immutable sources for the 2D UI set. Never edit files in `raw/`; regenerate the runtime copies with

```bash
make install    # links @par/xr-workspace; the build reads node_modules/@par/xr-workspace/assets/fonts/NotoSans-Regular.ttf
python3 -I scripts/assets/build_ui_atlas.py    # writes public/assets/ui/ and docs/verification/p5-ui-*.png
```

The build is deterministic (two runs produce byte-identical PNG, JPG and KTX2 files). Provenance,
rights, spend, output hashes and approval state are in [provenance.json](provenance.json).

| File | Origin |
| --- | --- |
| `prompts.json` | Prompt text and references for the three generations |
| `raw/icons-sheet.png` | Higgsfield `nano_banana_pro`, 2k 1:1, 16 medallions on flat green, ref `L-board-1.png` |
| `raw/icons-sheet.cutout.png` | Higgsfield `image_background_remover` on the icon sheet job |
| `raw/dice-plates.png` | Higgsfield `nano_banana_pro`, 2k 16:9, blank d6 and d8 face plates, ref `L-board-1.png` |
| `raw/key-art.png` | Higgsfield `nano_banana_pro`, 2k 16:9, refs `L-board-1.png`, `A-room.png` |
| `icon-map.json` | Icon id per sheet cell (row-major), checked by eye against the sheet |
| `sigil-strokes.json` | `SIGIL_TEMPLATES` dumped from `src/sigil/templates.ts`; `tests/ui-atlas.test.ts` checks it still matches |

## Runtime contract (`public/assets/ui/`)

- **Manifest** `ui-atlas.json`, typed by `src/ui/icon-atlas.ts`. Every entry has `px` (image pixels,
  origin top-left) and `uv` in three.js texture space (origin bottom-left, v up). PNG pages load with
  the default `flipY = true`; KTX2 pages are encoded with `--convert-texcoord-origin bottom-left`, so
  the same rect fits both.
- **Icons** `icons.png` / `icons.ktx2`, 512x512 RGBA. 16 slots of 128 px: a 112 px medallion with 8 px
  of transparent padding on each side (16 px between neighbours). Alpha is the remover matte times a
  fitted disc; the outer rim band is green-despilled; RGB is dilated into transparent pixels so
  filtering and mips show no dark fringe. Ids: resources `steam block hp cogs draw dice`, intents
  `intent-<IntentKind>` (all six, including `attack-debuff` and `unknown`), statuses
  `status-<StatusId>` (`weak vulnerable overheat wound-up`). `INTENT_ICON` and `STATUS_ICON` are
  typed `Record`s, so a new intent or status fails the type check until it has an icon.
- **Dice** `dice-d6.png` and `dice-d8.png` (+ KTX2), 1024x512, 256 px slots, slot `i` = model face `i`
  in the `src/dice/faces.ts` order, value `faces[i]` (index + 1), opposite faces sum to N + 1. Pips and
  numerals are rendered by the script, not generated. d6 slots are the full square face; the slot top
  is the face's "up" for the rotation-dependent 2, 3 and 6 layouts. d8 slots hold an equilateral
  triangle, apex up; its corners in slot-relative 0..1 coordinates (y down) are in the manifest
  (`dice.glass-d8.triangle`: apex, bottom right, bottom left), the numeral sits on the centroid,
  and 6 is underlined.
- **Glyphs** `glyphs.png` (+ KTX2), 1024x512 RGBA, 256 px slots in `SIGIL_IDS` order, drawn from the
  template strokes (+y up flipped to image space) as an amber line with a soft glow on transparent.
- **Title key art** `title-2048.jpg` (2048x1152) and `title-1024.jpg` (1024x576), quality 88, centre
  crop of the 2752x1536 source to 16:9. `keyArt.titleSafe` (0..1, origin top-left) marks the dark
  left wall kept clear for the runtime title. No text is baked into the art.

## Legibility target

An icon should read at about 2.5 cm on a panel 0.6 m away, which is roughly 24 to 32 px on a 1080p
desktop. `docs/verification/p5-ui-icons-legibility.png` shows every atlas slot downscaled to 24, 32
and 48 px on the warm-black panel colour. The headset check is still to do.
