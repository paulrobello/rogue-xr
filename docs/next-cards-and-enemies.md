# The Scrivener’s Foundry

**Content design draft · November 18, 2026**

For the first playable encounter, pair **Twin Furnace Mites** with **Counterstroke**. Two open furnace doors tell the player two hits are coming. Counterstroke turns that tell into a choice between killing a mite and guarding against the other. It is a small encounter that exercises target selection, visible intents, and a new card without requiring a new room or die model.

The batch develops six cards from Wave A and adds two candidates, Counterstroke and Quench Seal. Values below are proposed playtest values. The live roster has 15 cards and five enemy kinds. [Card and exploration roadmap](card-pool-and-exploration.md) · [Live cards](../src/content/cards.ts) · [Live enemies](../src/content/enemies.ts)

## Cards

Steam is the cost to play one card. Base and upgraded text describe a single play. Sigil values assume a clean 1× trace.

| Card | Steam · target | Base | Upgraded | What the player sees |
| --- | --- | --- | --- | --- |
| **Rivet Plate** · skill | 1 · self | Gain 3 Plating. | Gain 4 Plating. | Three nested plates snap onto the forearm. One goes dark at each payout. |
| **Shear Pin** · attack | 1 · one enemy | Deal 7 damage. Pinned. | Deal 9 damage. Pinned. | A steel pin holds the unplayed card in the fan as the rest are discarded. Pulling the pin launches it. |
| **Rust Spray** · skill | 1 · all enemies | Apply 2 Rust. | Apply 3 Rust. | A wide copper nozzle sprays orange droplets. The next Block gain sheds flakes. |
| **Iron Knuckle** · dice attack | 2 · one enemy | Roll an iron d4 once. Deal 3 + roll damage twice. | Deal 5 + roll twice. | The rolled face locks into the gauntlet. Two piston strikes show separate damage numbers. |
| **Brass Bulwark** · skill | 2 · self | Gain 14 Block. | Gain 18 Block. | Two hinged plates meet in front of the tray and the Block counter rises immediately. |
| **Anchor Glyph** · sigil | 1 · self | Trace an anchor. Gain 8 Block and 2 Plating. | Gain 11 Block and 3 Plating. | A traced anchor drops onto the plate. Links closing around it count the Plating stacks. |
| **Counterstroke** · new attack | 2 · one enemy | Deal 10 damage. If the target’s shown intent has two or more hits, also gain 6 Block. | Deal 13 damage. Gain 8 Block when the condition holds. | Two marks on a ratchet align when aimed at a qualifying enemy. Its return stroke deploys a shield. |
| **Quench Seal** · new sigil | 1 · one enemy | Trace Ward. Remove up to 3 Overheat from the target. Gain 4 Block plus 2 per stack removed. | Remove up to 4. Gain 5 Block plus 2 per stack removed. | Heat leaves the enemy in visible pulses. Each pulse clouds the player’s glass shield. |

**Timing and balance**

- **Plating** pays Block at the start of your turn, after the normal Block reset, then loses one stack. Three stacks pay 3, 2, and 1 over three turns. **Pinned** keeps an unplayed card through the end-turn discard. Playing it still spends and discards it normally.
- **Rust** halves new Block gains, rounded down. It loses one stack at the end of the afflicted actor’s turn. Existing Block stays in place.
- **Iron Knuckle** averages 11 base damage across two hits before statuses. Ratchet Flurry deals 6 across three hits for 1 Steam. Prototype Knuckle at 2 Steam, up from the roadmap’s 1, and check it with Wound-up. Spare Die rolls two d4s, displays both and uses the same higher value for both hits.
- **Counterstroke** checks the target’s telegraphed hit count when the card is played. Two enemies with separate single-hit intents do not qualify. **Quench Seal** spends whole stacks, then applies the sigil multiplier once to the resulting Block. At three stacks and a clean trace it trades future burn damage for 10 Block now.

## Enemies

HP and damage are Hard/base values. Use the existing difficulty scaling at other levels. Each enemy begins with zero Block. Weights below use the existing seeded intent picker except for the Auditor’s announced follow-up.

| Enemy | Placement and silhouette | Intent and tell | Counterplay |
| --- | --- | --- | --- |
| **Glasswing Scrivener** · 34 HP | Regular solo. A brass writing insect opens two glass nibs over its target. | **Inscribe** (weight 3) raises one nib, deals 5, then applies 1 Vulnerable. **Cross Out** (2) crosses both nibs and deals 3 twice. **Proof** (2) folds its wings into a shield for 10 Block. | Attack when the wings fold, or use Rust Spray to halve the pending shield. Counterstroke pays out on Cross Out. Block absorbs Inscribe’s damage, while Vulnerable still lands. |
| **Twin Furnace Mites** · 20 HP each | Regular pair. One asset with two distinct enamel markings. Each mite shows its own intent above its own body. | **Double Spark** (3) opens two shutters and deals 3 twice. **Stoke** (2) uncovers one orange coal, deals 4 and applies 1 Overheat. **Clink** (1) pulls in its legs and gains 6 Block. | Rivet Volley can soften both. Focus one down to remove its next intent. Quench Seal can spend heat that **you** previously applied to a mite with Furnace Brand. |
| **Null-Crown Auditor** · 78 HP | Alternate elite. A suspended ledger mask has a broad brass stamp on one arm and an abacus on the other. The stamp remains visible from the seat. | **Tally** (weight 3) shifts two beads and deals 4 twice. **Reconcile** (2) closes the ledger for 14 Block and raises the stamp. Its next intent is always **Levy**, one hit for 18. After Levy, resume the seeded picker. | Reconcile gives a full turn’s warning. Apply Rust before its shield forms, or hold a Pinned attack while drawing defense. Counterstroke helps against Tally. Brass Bulwark helps against Levy. |

## Three turns to test

1. **Open against the mites.** Both show Double Spark. Rivet Volley costs 1 and deals 4 to each. Counterstroke costs the remaining 2, deals 10 to one and gives 6 Block. With no other statuses, the pair deals 12 total and the player takes 6. Killing a weakened mite with that stroke removes its attack entirely.
2. **Read the Auditor.** It shows Reconcile. Rust Spray costs 1 and makes its impending 14 Block become 7. Play Rivet Plate for 1 and Piston Strike for 1. Next turn, Plating pays 3 Block. A base Brass Bulwark brings that to 17 against the announced 18-damage Levy.
3. **Cash out heat.** The Scrivener has 3 Overheat and shows Cross Out. A clean Quench Seal costs 1, removes those stacks and grants 10 Block. Iron Knuckle costs 2. A d4 result of 3 deals 6 twice before defenses. The player covers the incoming two hits at the cost of the burn they would otherwise have kept.

## Build and playtest

**First prototype:** Counterstroke and the mites. Use fixed intents for the first playtest so testers see both a qualifying attack and a single hit. Check whether they can point to the correct mite and explain the bonus from its silhouette and intent panel before pulling the trigger.

**Second prototype:** Rivet Plate, Rust Spray, Brass Bulwark, and the Auditor. Plating and Rust need pure rules, stack badges and keyword tips. Levy needs a deterministic one-move follow-up that survives resume. Compare seeded starter-deck fights with the Orrery Warden at the same difficulty and Workshop level, recording turns, HP lost, and opportunities to see Levy coming.

**Then add:** Shear Pin and the end-turn retention rule, Iron Knuckle and its physical d4, Anchor Glyph and recognizer testing against all five existing glyphs, and Quench Seal with atomic stack removal and Block calculation. Test zero heat, maximum heat, weak traces, and Spare Die ties. Test two permanent copies of each candidate and verify that both copies can be inspected and drawn. Set permanent purchase prices after these trials.
