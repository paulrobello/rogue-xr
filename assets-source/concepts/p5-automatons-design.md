# P5 automaton concept sheets — design notes (P5-T3, P5-T4)

Concept sheets for the four remaining slice automatons, generated against the approved style board
(PRD D8, `docs/art-bible.md`). Every gate is **pending**: concept, creative, rights and owner
approval belong to Paul and are not recorded here.

- Model: Higgsfield `nano_banana_pro`, 2k, 16:9, one generation per automaton, no retries.
- References, in order: `style/locked/L-board-1.png` (style board), `style/locked/L-automaton.png`
  (automaton construction), `concepts/sentry-sheet-1.png` (sheet layout and family materials).
- Spec: `prompts-p5.json` (same `shared` block as `style/prompts-p4t2.json`).
- Provenance: `provenance.json` in this folder, same record shape as `style/provenance.json` plus
  `refSha256`, `credits`, `status`, `rejectReason`, `approval` and `inspection`.
- Owner review: `p5-automatons-review-sheet.jpg`.

Combat roles come from `src/content/enemies.ts`. Rig budgets: regular and elite automatons follow
P4-T6 (at most 25k triangles, 4 materials, 40 bones, clips idle, attack, hit, death and a frozen
pose with dimmed eyes). The guardian gets at most 40k triangles, 60 bones and a phase-change clip.
The shipped Sentry uses 21 bones with rigid one-bone skinning; every design below keeps that
approach: rigid brass plates parented to single bones over gunmetal ball joints.

## Family markers kept on every design

Narrow head with two amber eye lights, polished brass plates over dark gunmetal joints, one amber
chest core as focal point and hit-reaction light, and a jewel inlay colour per enemy (Sentry mixed,
Hound ruby, Golem emerald, Warden ruby/sapphire/emerald planets, Escapement sapphire).

## Spring Hound — `hound-sheet-1.png` (regular, 30 HP)

Moves: snap (3 x 2), pounce (9), coil (Wound-up 1 and 4 block).

- Silhouette: a low horizontal quadruped about 0.9 m at the shoulder and 1.6 m long, against the
  Sentry's tall vertical figure. It reads at play distance as the only low, long shape.
- Intent tells: snap drops the head and opens the hinged jaw; pounce crouches the haunches and
  compresses the coiled spring spine; coil curls the body and lights the tail winding key amber.
- Rig sketch (about 28 bones): root, pelvis, three spine-spring segments, two neck, head, jaw, four
  bones per leg, three tail. The spring spine is three rigid coil sections, not a deforming mesh.

## Bellows Golem — `golem-sheet-1.png` (regular, 52 HP)

Moves: crush (12), vent (4 and Overheat 3), bank (12 block).

- Silhouette: squat and nearly as wide as tall (about 2.1 m), a walnut-and-leather bellows barrel
  with long gorilla arms and huge round fists. It is the broadest shape in the roster.
- Intent tells: crush raises both fists overhead; vent squeezes the bellows and lights both
  shoulder chimney mouths bright amber (a glow, no smoke, per the art bible); bank crosses the
  forearms in front of the bellows.
- Rig sketch (about 23 bones): root, pelvis, two spine, head, bellows top and bottom (the pump is
  two rigid plates moving on bones), four per arm, three per leg, two chimney flaps.
- Deviations from the sheet prompt: the eyes are round amber lights, not slits, and the vent pose
  paints a flame plume above the chimney. Model the vent as an emissive chimney mouth only; the art
  bible rules out smoke as part of the look.

## Orrery Warden — `warden-sheet-1.png` (elite, 92 HP)

Moves: transit (5 x 3), eclipse (10 and Vulnerable 2), align (Wound-up 2 and 10 block),
zenith (17).

- Silhouette: the Sentry's slender body stretched to about 2.4 m, with two armillary rings framing
  the head (about 2.6 m to the ring top) and a long brass plate skirt. The halo and skirt separate
  it from the Sentry at distance.
- Intent tells: transit swings the three planets (ruby, sapphire, emerald) outward, one per hit;
  eclipse slides a dark disc across the sun-disc chest core, dimming it; align (not drawn) lines
  the rings and planets up vertically; zenith lifts the sun core overhead.
- Rig sketch (about 31 bones): the Sentry's 21-bone humanoid, plus two ring bones, three planet-arm
  bones, one eclipse disc and four skirt plates.
- Artifact outside the subject panels: a fading partial copy of the Cog Sentry with a spear sits
  below the front view. It leaked from the third reference and is not part of the design. Not
  retried, because the retry rule covers wrong subject, text garbage and broken anatomy only.

## Grand Escapement — `escapement-sheet-1.png` (floor guardian, 160 HP)

Moves: tick (8 x 2), tock (16 block and 7), pallet (13 and Weak 2), mainspring (Wound-up 2 and
8 block), overwind (Overheat 3 and Vulnerable 2), toll (26).

- Silhouette: a walnut clock-case torso on long brass legs, with anchor-shaped pallet claws and a
  bell crown, about 3.2 m. The boxy case is unlike any other enemy.
- Phase 1 (top row): wound and closed. Glass chest doors shut, pendulum calm, soft amber.
- Phase 2 (bottom row): overwound. The chest doors and case plates spring open on hinges, the
  escapement wheel and pendulum blaze amber, and the back winding key spins. Panel 2 shows the
  phase change mid-transition, panel 3 the escapement call-out.
- Intent tells: tick and tock swing the pendulum left and right; pallet clamps both anchor claws;
  mainspring turns the back key; overwind flares the open case; toll rings the bell crown.
- Rig sketch (40 of the 60-bone budget): humanoid 29 (root, pelvis, three spine, neck, head, four
  per arm plus three claw bones each, four per leg), pendulum rod and bob 2, escapement wheel 1,
  pallet anchor 1, chest doors 2, side case plates 2, winding key 1, bell 1 and clapper 1. That
  leaves 20 bones of headroom for extra case plates or finger segments. Every part that opens in phase 2 is a rigid bone already present, closed, in phase 1, so
  the phase-change clip runs on one skeleton with no mesh swap.
- Minor drift: the case reads as a squat cabinet rather than a tall longcase, and the side view
  holds the anchor like a spear.

## Validation record (`validate-generated-assets`, 2026-11-15)

| Sheet | sha256 | Size |
| --- | --- | --- |
| `hound-sheet-1.png` | `7f16cf73b18efffb7a612cc1f6a01fdadc4e20f06a0fcadb84fb94e07b50c7e6` | 2752x1536 RGB PNG |
| `golem-sheet-1.png` | `8c5bafcf4a25372cab90935515ca4372933bb5c83d61213a528958a1ec29352b` | 2752x1536 RGB PNG |
| `warden-sheet-1.png` | `c07d34ae5d7412f26c561508bc5a80f14de584ffebbcff31272cc356b07ec5c7` | 2752x1536 RGB PNG |
| `escapement-sheet-1.png` | `42f8031f0391d392cbafd30756f7c69fde1a3c0c216f37aef3fc7060c8a61b9f` | 2752x1536 RGB PNG |

- Technical: each source fully decodes; recomputed sha256, prompt (spec job plus `shared`), refs
  and reference hashes match `provenance.json`. Sources are the untouched provider downloads.
  Credits: quoted 2 per sheet by `higgsfield generate cost` with identical arguments, debited
  4 x 2 = 8 (account 605 to 597).
- Creative: each sheet inspected at native resolution; findings are in each record's
  `inspection` field. Owner review pending.
- Rights: pending. Generated on Paul's paid Higgsfield plan; no rights decision is recorded here.
- Owner: pending.
- Not applicable at concept stage: runtime consumer, budgets, lifecycle and fallback checks.
  These belong to the model, rig and animation gates of P5-T3 and P5-T4.

## Decisions for Paul

1. Approve or reject each concept (all four gates pending).
2. The art bible says automatons are "slender, man-sized humanoids". The Hound (quadruped), the
   Golem (squat) and the Escapement (3.2 m clock case) break that on purpose so each reads apart
   from the Sentry at play distance. Approving them means amending that line.
3. The rules engine has no guardian phase mechanic: `enemies.ts` gives the Grand Escapement one
   move list. Proposal only: phase 2 at 50% HP, adding toll and overwind to the move list.
4. The proposed heights (Hound 1.2 m to the head, Golem 2.1 m, Warden 2.6 m to the rings,
   Escapement 3.2 m) are not set anywhere in the code yet. Fixed points: the shipped Sentry is
   1.96 m (`assets-source/enemies/cog-sentry/staging/report.json` bounds), the regular placeholder
   capsule is 1.9 m and the guardian placeholder capsule 3.0 m (`src/world/floor-world.ts`).
5. Warden artifact: accept the sheet as is, or retry it (2 credits, sheet 11 of the 12-sheet
   concept allowance).
6. Allowance: this batch brings the slice's concept sheets to 10 of 12 (6 earlier: rooms, Sentry,
   table, two each). Two remain, while three or more room templates and the workshop still have no
   sheet. The PRD allows about 3 times the count as retry headroom; the 12-sheet cap in this brief
   is stricter.
