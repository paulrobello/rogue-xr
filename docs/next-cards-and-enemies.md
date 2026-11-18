# The Scrivener’s Foundry

**Playable Foundry batch · November 18, 2026**

For the first playable encounter, pair **Twin Furnace Mites** with **Counterstroke**. Two open furnace doors tell the player two hits are coming. Counterstroke turns that tell into a choice between killing a mite and guarding against the other. It is a small encounter that exercises target selection, visible intents, and a new card without requiring a new room or die model.

The batch adds six cards from Wave A, plus Counterstroke and Quench Seal. The playable roster has 23 cards and eight enemy kinds. Values below are the initial gameplay tuning. [Card and exploration roadmap](card-pool-and-exploration.md) · [Live cards](../src/content/cards.ts) · [Live enemies](../src/content/enemies.ts)

## Cards

Steam is the cost to play one card. Base and upgraded text describe a single play. Sigil values assume a clean 1× trace.

| Card | Steam · target | Base | Upgraded | What the player sees |
| --- | --- | --- | --- | --- |
| **Rivet Plate** · skill | 1 · self | Gain 3 Plating. | Gain 4 Plating. | Three blue, brass-rimmed plates slide together when cast. The Plating counter tracks the remaining stacks. |
| **Shear Pin** · attack | 1 · one enemy | Deal 7 damage. Pinned. | Deal 9 damage. Pinned. | A steel pin with a red head flies at the target. The card stays in the fan if held through the turn. |
| **Rust Spray** · skill | 1 · all enemies | Apply 2 Rust. | Apply 3 Rust. | Orange rust dust fans outward toward each affected enemy. |
| **Iron Knuckle** · dice attack | 2 · one enemy | Roll an iron d4 once. Deal 3 + roll damage twice. | Deal 5 + roll twice. | An iron gauntlet punches twice, using the same visible d4 result for both hits. |
| **Brass Bulwark** · skill | 3 · self | Gain 14 Block. | Gain 18 Block. | Two hinged plates meet in front of the tray and the Block counter rises immediately. |
| **Anchor Glyph** · sigil | 1 · self | Trace an anchor. Gain 8 Block and 2 Plating. | Gain 11 Block and 3 Plating. | A green anchor drops on a short brass chain at the traced glyph. |
| **Counterstroke** · new attack | 2 · one enemy | Deal 10 damage. If the target’s shown intent has two or more hits, also gain 6 Block. | Deal 13 damage. Gain 8 Block when the condition holds. | A ratchet ram strikes. A ruby guard unfolds on the return stroke when the target telegraphs multiple hits. |
| **Quench Seal** · new sigil | 1 · one enemy | Trace Ward. Remove up to 3 Overheat from the target. Gain 4 Block plus 2 per stack removed. | Remove up to 4. Gain 5 Block plus 2 per stack removed. | Heat motes travel from the enemy to a translucent shield when the seal consumes Overheat. |

**Timing and balance**

- **Plating** pays Block at the start of your turn, after the normal Block reset, then loses one stack. Three stacks pay 3, 2, and 1 over three turns. **Pinned** keeps an unplayed card through the end-turn discard. Playing it still spends and discards it normally. The next turn draws five additional cards up to the ten-card fan limit.
- **Rust** halves new Block gains, rounded down. It loses one stack at the end of the afflicted actor’s turn. Existing Block stays in place.
- **Iron Knuckle** averages 11 base damage across two hits before statuses. Ratchet Flurry deals 6 across three hits for 1 Steam. Iron Knuckle costs 2 Steam, up from the roadmap’s 1, to account for its two hits and interaction with Wound-up. Spare Die rolls two d4s, displays both and uses the same higher value for both hits.
- **Counterstroke** checks the target’s telegraphed hit count when the card is played. Two enemies with separate single-hit intents do not qualify. **Quench Seal** spends whole stacks, then applies the sigil multiplier once to the resulting Block. At three stacks and a clean trace it trades future burn damage for 10 Block now.

## Enemies

HP and damage are Hard/base values. Use the existing difficulty scaling at other levels. Each enemy begins with zero Block. Inscribe uses two Vulnerable stacks so one survives the end of the player’s turn and can affect the next attack. Weights below use the existing seeded intent picker except for the Auditor’s announced follow-up.

| Enemy | Placement and silhouette | Intent and tell | Counterplay |
| --- | --- | --- | --- |
| **Glasswing Scrivener** · 34 HP | Regular solo. A brass writing insect opens two glass nibs over its target. | **Inscribe** (weight 3) raises one nib, deals 5, then applies 2 Vulnerable. **Cross Out** (2) crosses both nibs and deals 3 twice. **Proof** (2) folds its wings into a shield for 10 Block. | Attack when the wings fold, or use Rust Spray to halve the pending shield. Counterstroke pays out on Cross Out. Block absorbs Inscribe’s damage, while Vulnerable still lands. |
| **Twin Furnace Mites** · 20 HP each | Regular pair. One asset with two distinct enamel markings. Each mite shows its own intent above its own body. | **Double Spark** (3) opens two shutters and deals 3 twice. **Stoke** (2) uncovers one orange coal, deals 4 and applies 1 Overheat. **Clink** (1) pulls in its legs and gains 6 Block. | Rivet Volley can soften both. Focus one down to remove its next intent. Quench Seal can spend heat that **you** previously applied to a mite with Furnace Brand. |
| **Null-Crown Auditor** · 78 HP | Alternate elite. A suspended ledger mask has a broad brass stamp on one arm and an abacus on the other. The stamp remains visible from the seat. | **Tally** (weight 3) shifts two beads and deals 4 twice. **Reconcile** (2) closes the ledger for 14 Block and raises the stamp. Its next intent is always **Levy**, one hit for 18. After Levy, resume the seeded picker. | Reconcile gives a full turn’s warning. Apply Rust before its shield forms, or hold a Pinned attack while drawing defense. Counterstroke helps against Tally. Brass Bulwark helps against Levy. |

### Approved concept sheets

Paul approved these three art references on November 18, 2026.

The Glasswing Scrivener telegraphs with its pen nibs and folding wings. The Twin Furnace Mites share a body shape, with a ruby stripe on one and ivory bands on the other. The Null-Crown Auditor raises the stamp for Reconcile and brings it down for Levy. [Glasswing Scrivener](../assets-source/concepts/foundry/glasswing-scrivener.png) · [Twin Furnace Mites](../assets-source/concepts/foundry/twin-furnace-mites.png) · [Null-Crown Auditor](../assets-source/concepts/foundry/null-crown-auditor.png)

## Three turns to test

1. **Open against the mites.** Both show Double Spark. Rivet Volley costs 1 and deals 4 to each. Counterstroke costs the remaining 2, deals 10 to one and gives 6 Block. With no other statuses, the pair deals 12 total and the player takes 6. Killing a weakened mite with that stroke removes its attack entirely.
2. **Read the Auditor.** It shows Reconcile. Rust Spray costs 1 and makes its impending 14 Block become 7. Play Rivet Plate for 1 and Piston Strike for 1. Next turn, Plating pays 3 Block. Spend all 3 Steam on Brass Bulwark for 14 more Block. With 17 Block, the announced 18-damage Levy deals 1 damage.
3. **Cash out heat.** The Scrivener has 3 Overheat and shows Cross Out. A clean Quench Seal costs 1, removes those stacks and grants 10 Block. Iron Knuckle costs 2. A d4 result of 3 deals 6 twice before defenses. The player covers the incoming two hits at the cost of the burn they would otherwise have kept.

[In-game card faces](verification/foundry-cards.jpg) · [Combat effects at cast time](verification/foundry-effects.jpg)

## Playtest routes

Start a fresh run to encounter the Foundry enemies and draw from the expanded reward pool. Earlier saved runs keep their original encounter and reward pools. Each Foundry card costs 60 cogs per permanent Workshop copy.

| Seed | Room | Encounter |
| --- | ---: | --- |
| SP1RE003 | 3 | Twin Furnace Mites |
| SP1RE004 | 1 | Glasswing Scrivener |
| SP1RE023 | 2 | Null-Crown Auditor |

The functional playtest covers the eight card plays, both Spare Die d4 results, drawing the Anchor and Ward glyphs, and the Auditor’s Reconcile-to-Levy sequence. Remaining balance checks include comparing elite clear time and HP lost against the Orrery Warden on the same difficulty, and whether players can choose a Counterstroke target from the shutter tells at seated distance.
