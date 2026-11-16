# Clockwork Spire — art bible

Status: **approved by Paul on 2026-11-15** ("All recommendations for art direction are approved, as well as any needed spend", in chat). This covers the
direction (exploration A "Gilded Lamplight" with exploration C's slender automaton silhouette and
card-frame layout), `L-board-1.png` as the canonical style board, every rule below, and the depth
portal card window. Exploration record: [assets-source/style/brief.md](../assets-source/style/brief.md).

Every 2D asset is generated against the canonical references below (PRD D8), and every 3D asset is
modeled to match them.

## Canonical references

| File (`assets-source/style/locked/`) | Governs |
| --- | --- |
| `L-board-1.png` | The style board: palette, rendering, room, automaton, card, dice, sigil |
| `L-cards.png` | Card frame families and card illustration brushwork |
| `L-automaton.png` | Automaton construction: plates, joints, core, jewel inlays (front, side, back) |
| `L-study.png` | Room composition and enemy scale at seated eye height (ignore its teal foreground cards) |
| `../explore/A-room.png` | Hero study composition and lighting |

Concept sheets picked by Paul on 2026-11-15 (`assets-source/concepts/`): `room-sheet-1.png` for the
hero study, `sentry-sheet-1.png` for the Cog Sentry and `table-sheet-1.png` for the combat table.

`L-board-2.png` is kept for provenance only: its teal card frame is off-direction.

## Palette

Sampled from `L-board-1.png`. Brass is a gradient; the hex is its mid tone.

| Role | Hex | Use |
| --- | --- | --- |
| Candle amber | `#F3BE65` | Light colour of candles, lamps, automaton eyes and cores, sigil glow |
| Polished brass | `#DEC16A` | Gears, frames, fittings, automaton plates |
| Oiled walnut | `#583C26` | Furniture, panelling, floors, the combat table |
| Warm black | `#231D1A` | Shadows, gunmetal joints, UI backing |
| Ruby | `#93212B` | Stained glass, attack cards, damage |
| Sapphire | `#2D4A93` | Stained glass, skill cards, block and wards |
| Emerald | `#19744C` | Stained glass, sigil spell cards, healing and steam |

Jewel tones are the only cool or saturated colours. They appear as stained glass, gem inlays and
card families, never as large wall or floor areas. No teal and no cool ambient fill.

## Rendering and light

- Painterly semi-realism. Card art and 2D UI show visible oil-paint brushwork. 3D surfaces read as
  painted materials: soft value variation, worn edges, no photographic grime.
- Light is warm and low: candles and lamps make pools, stained glass throws coloured patches on
  the floor, and corners fall into warm dark rather than black. Baked into lightmaps per the PRD
  lightmap contract. Polished brass gets its highlights from probes.
- Forms are large and readable with clean silhouettes. Detail goes into textures and baked light,
  not geometry.
- Not used: smoke, fog or volumetric shafts as part of the look, soot and heavy grime,
  photoreal detail, and art-nouveau filigree rendered as geometry.

## Automatons

- Slender, man-sized humanoids with long limbs and a narrow head with two amber eye slits by
  default. Roster exceptions, approved by Paul on 2026-11-16 (D8): the four-legged Spring Hound,
  the squat Bellows Golem (round eye lights), the tall Orrery Warden and the clock-case Grand
  Escapement guardian. Their concept sheets are in `assets-source/concepts/`.
- Polished brass plates over dark gunmetal joints. The plates stay as separate readable shapes so a
  low-poly model can carry them.
- One amber core in the chest is the focal point and the hit-reaction light.
- Small jewel inlays (ruby, sapphire, emerald) at shoulders, elbows and knees may mark enemy
  variants.

## Cards

- Tall portrait card in a brass frame. A circular illustration window fills the upper two thirds,
  with a parchment text panel below and a gem medallion in each upper corner.
- The family colour fills the frame field and the gems: ruby for attack, sapphire for skill and
  emerald for sigil spell.
- Illustrations are painted, centred on one subject, and lit by that subject's own glow.
- Generated art never contains text. Card names and numbers are rendered at runtime.
- The illustration window is a depth portal (`src/cards/holo-card.ts`). Each illustration is painted
  as separate layers: an opaque backdrop, one or two mid elements and the subject, the cut-out
  layers on flat green for background removal. Layers sit 5 to 30 mm behind the card face, and
  the window glass carries a faint view-dependent foil sheen.

## Dice, sigils and UI

- Dice: brass bodies with walnut or enamel faces and amber pips or numerals (`L-board-1.png`, panel 4).
- Sigils: one continuous hand-drawn amber line with a soft glow, built from circles, triangles and
  spirals (`L-board-1.png`, panel 5). They must be traceable in a single stroke in the air.
- UI icons: brass line art on warm black, with amber for active states and the family jewel tone
  for card-related states.

## Generating against this bible

Pass `L-board-1.png` as the first `--image` reference on every Higgsfield call, and add the
reference for the asset class (`L-cards.png`, `L-automaton.png` or `A-room.png`). Start prompts
from the `shared` block in `assets-source/style/prompts-locked.json`. Generate with
`bun scripts/assets/gen_style.ts --spec <spec> --out <dir>`, which records provenance.

## Runtime palette

`src/palette.ts` follows the palette table. Change both together.
