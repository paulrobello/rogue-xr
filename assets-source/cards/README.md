# Card illustrations and frames (P5-T5)

Sources for the 15 slice card illustrations and the 3 card frames. Art direction:
[docs/art-bible.md](../../docs/art-bible.md). Every Higgsfield call passed `L-board-1.png` first,
then `L-cards.png` and the P4 strike `frame-source.png` (composites and frames) or the picked
composite (layers).

Status: technical checks done. **Creative and owner approval are pending** (Paul reviews
`p5t5-review-sheet.jpg` as one batch). Nothing here is owner-approved.

## Files

| Path | What |
| --- | --- |
| `prompts-cards.json` | The spec: shared prompt blocks, per-card composite and layer prompts, regeneration prompts, frame prompts |
| `gen_cards.py` | Runner: `python3 -I assets-source/cards/gen_cards.py <stage>` with stages `frames-attack`, `frames-recolour`, `keys`, `layers`, `regen`, `cutouts`. Preflights cost, checks the receipt `job_type`, downloads untouched originals |
| `provenance.json` | One entry per job: provider, model, receipt job type, job id, prompt, inputs with sha256 (and upload id or source job id), settings, credit cost, sha256 of the download, rights note |
| `selection.json` | Picks and the reason for each: frame candidate per type, composite per card, and per-layer regeneration picks |
| `<card-id>/<id>-key-{a,b}.png` | Two composite candidates per card (reference only, not shipped) |
| `<card-id>/<id>-{back,mid,front}[-r1].png` | Layers decomposed from the picked composite; `-r1` is the single regeneration round |
| `<card-id>/<stem>.cutout.png` | `image_background_remover` output for mid and front layers |
| `frames/<type>/frame-<type>-{a,b}.png` | Frame candidates; skill and sigil are recolour edits of the picked attack frame |
| `attack-strike/` | P4 portal-card proof art, reused unchanged as the `strike` (Piston Strike) illustration |
| `make_review_sheet.py`, `p5t5-review-sheet.jpg` | Owner review sheet built from the shipped atlas |

## Pipeline

1. Composite: 2 candidates per card (1:1, 2k `nano_banana_pro`), one picked.
2. Layers: back (full square), mid and front (on flat green, or magenta for emerald sigil cards),
   each an edit that references the picked composite.
3. Self-review, then one regeneration round for layers that repeated another layer's element.
4. `image_background_remover` on mid and front.
5. `python3 -I scripts/assets/build_card_atlas.py` packs `public/assets/cards/atlas/`. It caps the
   remover's alpha with a chroma matte from the untouched keyed layer (the remover keeps enclosed
   key-colour regions, such as the inside of rings, opaque), despills the key, applies the two
   ellipse masks listed in `LAYER_MASKS`, fills colour under transparent pixels, and encodes KTX2.

Frames: the window is the flat green disc, detected and fitted so all three families share one
window; the alpha is a rounded card outline minus that window. Text regions (cost, name,
description) are recorded per frame in `card-atlas.json`; the frames carry no text.

## Known issues from self-review

- Regeneration did not remove repeated scenery in four layers: `spanner-jam` front still has gears,
  `overwind` front sits on a spring-drum disc, `arc-bolt` mid and front both carry the bolt, and
  `rivet-volley` mid (original) repeats the muzzle and rivets of its front (which is the
  regenerated mid image, `rivet-volley-mid-r1`).
- `furnace-brand` and `release-valve` fronts are kept to the subject by ellipse masks in the build.
- `lucky-rivets` mid keeps a tiny die inside the plate ring; `time-spiral` mid has a bronze
  spiral behind the emerald one; `cogstorm` mid and front keep a few gear teeth at the lower edge.
- The attack frame was regenerated with the other two so the three share one layout; the P4 board
  crop at `attack-strike/frame.png` is no longer the shipped attack frame.

## Rights

Generated on Paul's paid Higgsfield plan. Higgsfield Terms of Use §4.4 (checked 2026-11-15): no
ownership claim on inputs or outputs and no restriction on commercial use on any plan. The only
reference inputs are this project's own Higgsfield style boards and card art.

## Storage

The raw provider downloads in the per-card folders (composites, layers, cutouts, 127 files,
825 MB) are not in git. Per Paul's decision D21 (2026-11-16) they live on parnas1, in the `homes`
share under `game-data/rogue-xr/`, at the same relative paths as here (macOS mount:
`/Volumes/homes/game-data/rogue-xr/assets-source/cards/`). `raw-store.json` lists every file with
its sha256 and size; each hash also appears in `provenance.json`. To restore them, copy that folder
back over this one and check the hashes against `raw-store.json`.

## Foundry illustrations

The eight Foundry illustrations come from the two original transparent sheets in `foundry/`. Rebuild their supplemental atlas page with `python3 scripts/assets/build_card_atlas.py --foundry-only`. The generator crops the named quadrants, extrudes their gutters and reuses the shipped attack, skill and sigil backdrop layers. The full build also includes this page.
