# Card pool and exploration plan

Status: draft for Paul's review, 2026-11-17. The Foundry combat batch, Pressure Works, the cross-floor bell puzzle and the paired staircases are playable. Other entries below are design proposals. Numbers are first-pass values, tuned in playtests. Paul asked for this in chat on 2026-11-17: plan the full card pool, including the lock pick and the other non-combat cards the roadmap needs, and make the game interesting between combat with puzzles, backtracking, optional paths and tasks.

The slice reference points every new card is measured against: 3 steam per turn, a hand of 5, Piston Strike (1 steam, 6 damage) and Brass Guard (1 steam, 5 block).

The dungeon preview continues Wave A with Torque Wrench, Counterweight, and Tension Coil. New runs can roll the cards in rewards and treasure and purchase them in the Workshop. Upper Works seeds `CRYPT001` and `CRYPT004` exercise the Mortar Scarab and Lantern Bailiff rules, respectively. Their concept sheet is ready for visual review, with the 3D actors and animation still to come. [Dungeon enemy concepts](../assets-source/concepts/dungeon/dungeon-enemies-sheet.png)

The next Wave A preview adds Spare Parts, Flywheel Swing and Patch Kit. Flywheel Swing's Block bonus is part of one hit and does not spend the Block. Patch Kit restores only missing HP and exhausts when played, including at full health. Older saves keep their original reward pools.

Wave A finishes with Grease Gun, Escapement Break, and Lucky Strike. Grease Gun opens a tabletop Scry choice. Select any revealed card to discard it, then confirm to keep the rest in draw order. Its upgrade draws once after confirmation. Escapement Break uses current Block without spending it. Lucky Strike uses a brass d6 and deals the higher damage on a 5 or 6. These cards enter combat rewards on new runs and are available in the Workshop.

Capacitor and Copper Coil introduce Charge in Wave B. Charge persists across turns. Each stack adds 0.1 to the next successful sigil multiplier, including above 1.25. The cast spends all Charge. A rejected trace or a half-power Fizzle keeps it.

Flash Boiler and Overdrive Piston introduce X-cost plays. Each spends all remaining Steam when played and scales its base effect by the amount spent. A zero-Steam play consumes the card. The hand tooltip forecasts the effect at the current Steam count, and the combat log records the spend.

## 1. Two kinds of card

| Kind | Where it lives | How it is used | Lasts |
| --- | --- | --- | --- |
| Combat card | The run deck | Drawn into the off-hand fan in a fight, grabbed and used with the trigger (D5) | The whole run, until removed |
| Field card | The satchel, an inventory of single-use items and spells, separate from the deck | Used while exploring, at a lock, a puzzle or a hearth. A few also work in combat (marked below) | One use, then gone |

Field cards come in two forms. **Field sigils** need their glyph traced on a plate that opens at the target: a lock, a wall or the floor. The trace score must clear the fizzle line (D6) to work. **Field items** (keys, salves, tools) work with no trace.

New card frames: Mechanism (combat), Field sigil, Field item, and Junk. That is 4 more frames on top of the 3 the slice has.

## 2. New combat rules the pool needs

Each one is engine work in `rules/` (pure and unit-tested), introduced in the wave that first uses it.

| Code | Mechanic | Rule |
| --- | --- | --- |
| M1 | **Plating** (status, you) | At the start of your turn, gain block equal to its stacks, then it loses 1 stack. |
| M2 | **Rust** (status, enemy or you) | The owner gains 50% less block, rounded down, and loses 1 stack at the end of its turn. |
| M3 | **Charge** (status, you) | Your next sigil cast gets +0.1 power multiplier per stack, which can exceed the D6 cap of 1.25. The cast spends all Charge. |
| M4 | **Stalled** (status, enemy) | The owner skips its next action, then loses the status. The guardian is immune, and an elite ignores a second Stall in the same fight. |
| M5 | **Pinned** (keyword) | The card stays in your hand at the end of your turn. |
| M6 | **Scry N** (effect) | Look at the top N cards of your draw pile and discard any of them. The cards show on the table. |
| M7 | **Heal N** (effect) | Restore up to N HP, never above your maximum. It is rare in combat. |
| M8 | **Overdrive** (an X cost) | Spend all your steam. The effect scales with the amount spent. |
| M9 | **Mechanism** (card type) | Play it onto the table. The three installed slots show the devices from oldest to newest. A fourth retires the oldest card for the rest of this fight. Start-turn devices fire after the player resets Block and Steam, before the hand is drawn. Turn-end devices fire before enemies act. Devices that fire together resolve in installation order. |
| M10 | **Loaded** and **Reroll** (dice) | Loaded adds one roll to your next dice card this turn. Keep the highest initial result, including any Workshop Spare Die roll. Reroll offers a choice once the tray settles. Click the die or press T on desktop, or grip and release it in XR. Keep Roll accepts the initial result. A rethrow uses the next result in the `dice` stream and replaces the initial result before the card resolves. |
| M11 | **Twin sigil** (card) | Trace two glyphs, one after the other. Each is scored separately, and each half of the effect uses its own multiplier. |
| M12 | **Junk** (cards enemies add) | Unplayable, and removed at the end of the fight. Some punish you while they sit in your hand. |
| M13 | **New dice** | Iron d4 (1 to 4, steady), crystal d12 (1 to 12, swingy, used by rare cards). Each needs a model and face set built in Blender. |
| M14 | **New glyphs** | key, eye, hourglass, anchor, plus the slice's gear, flame, ward, bolt and spiral. With every new glyph, the $P recognizer has to keep telling the set apart. A test must confirm that every pair stays distinct at each difficulty (R2). |

## 3. Combat pool: 15 in the slice plus 45 new

The pool is released in three waves of 15 cards. Each wave can ship on its own and is gated on its mechanics from section 2. Rarity weights for rewards start at 60% common, 30% uncommon and 10% rare. Later acts shift the weights toward rarer cards.

The slice's 15 stay as they are: Piston Strike, Cog Toss, Ratchet Flurry, Rivet Volley, Escapement Hammer, Brass Guard, Lucky Rivets, Release Valve, Overwind, Spanner Jam, Cogstorm, Furnace Brand, Warding Glyph, Arc Bolt and Time Spiral. The new cards fill these gaps: rare cards, costs of 3, effects that last the fight, healing, deck control, and more dice and sigil play.

### Wave A: armour, rust, deck control (mechanics M1, M2, M5, M6, M7, M13 iron d4, glyph anchor)

| Card | Type | Cost | Rarity | Effect | Upgrade |
| --- | --- | --- | --- | --- | --- |
| Rivet Plate | skill | 1 | common | 3 Plating | 4 Plating |
| Shear Pin | attack | 1 | common | 7 damage. Pinned | 9 damage |
| Rust Spray | skill | 1 | common | 2 Rust on all enemies | 3 Rust |
| Spare Parts | skill | 1 | common | Draw 2 | Draw 3 |
| Grease Gun | skill | 0 | common | Scry 3 | Scry 4, draw 1 |
| Iron Knuckle | attack | 1 | common | Twice: 3 + iron d4 damage | Twice: 5 + d4 |
| Brass Bulwark | skill | 3 | common | 14 block | 18 block |
| Torque Wrench | attack | 1 | common | 6 damage, 1 Rust | 9 damage, 2 Rust |
| Counterweight | skill | 2 | uncommon | 12 block. Pinned | 16 block |
| Flywheel Swing | attack | 2 | uncommon | 12 damage, +4 if you have block | 15 damage, +5 |
| Tension Coil | skill | 1 | uncommon | 4 block, 1 Wound-up | 6 block, 1 Wound-up |
| Patch Kit | skill | 1 | uncommon | Heal 4. Exhaust | Heal 6 |
| Anchor Glyph | sigil (anchor) | 1 | uncommon | 8 block, 2 Plating | 11 block, 3 Plating |
| Escapement Break | attack | 1 | rare | Damage equal to your block | Gain 3 block first |
| Lucky Strike | attack | 1 | rare | Roll a brass d6: 5 or 6 deals 18, otherwise 6 | 20 or 8 |

### Wave B: mechanisms, charge, overdrive (mechanics M3, M8, M9, M10, M13 crystal d12, glyph eye)

| Card | Type | Cost | Rarity | Effect | Upgrade |
| --- | --- | --- | --- | --- | --- |
| Capacitor | skill | 1 | common | 2 Charge, draw 1 | 3 Charge |
| Arc Chain | sigil (bolt) | 1 | common | 5 damage to the target, 3 to each other enemy | 7 and 4 |
| Gear Grinder | attack | 1 | common | 4 damage twice, three times if the target has Rust | 5 per hit |
| Reroll Lever | skill | 0 | common | Pinned. Your next thrown die may be thrown again | Also draw 1 |
| Copper Coil | attack | 1 | common | 5 damage, 1 Charge | 7 damage |
| Pendulum Ward | sigil (ward) | 2 | uncommon | 10 block, 2 Plating | 14 block, 3 Plating |
| Loaded Die | skill | 0 | uncommon | Your next die this turn is Loaded. Draw 1 | Not exhausted |
| Flash Boiler | skill | X | uncommon | 4 block per steam spent | 5 per steam |
| Gyro Stabilizer | mechanism | 2 | uncommon | Each turn, gain 3 block | 5 block |
| Pressure Gauge | mechanism | 1 | uncommon | Each turn, gain 1 Charge | Costs 0 |
| Clockwork Turret | mechanism | 2 | uncommon | Each turn end, 3 damage to the enemy with the least HP | 5 damage |
| Overdrive Piston | attack | X | rare | 7 damage per steam spent | 9 per steam |
| Crystal Gambit | attack | 2 | rare | Two crystal d12 rolls, added as damage | +4 |
| Echo Glyph | sigil (spiral) | 2 | rare | Recast the last sigil you cast this fight at its score | Costs 1 |
| Furnace Heart | mechanism | 3 | rare | Each turn, 2 Overheat on all enemies | 3 Overheat |

Arc Chain sends its first bolt to the aimed enemy and branches from there to the other living enemies. Gear Grinder checks Rust before the first strike and shows a separate number for each hit. Pendulum Ward forms a shield and applies Plating when the ward spell lands.

Crystal Gambit throws two numbered crystal d12s in the tray and displays the two kept values and their sum. Loaded and the Workshop Spare Die add rolls to the first die’s group. Reroll Lever lets the player rethrow that first contribution while keeping the second. The upgrade adds four damage to the sum once.

Echo Glyph is the version 30 rare spiral sigil. It costs 2 Steam, or 1 Steam upgraded. Draw a spiral to repeat the last successful sigil at its recorded strength and with its original dice result. Aim Echo at a living enemy if the remembered spell needs a target. Echo keeps the remembered spell available for another copy. A fizzle spends the card and its Steam, and the player needs a successful sigil before they can pick up Echo.

### Wave C: act 2 (mechanics M4, M11, M12, glyph hourglass)

| Card | Type | Cost | Rarity | Effect | Upgrade |
| --- | --- | --- | --- | --- | --- |
| Salvage | skill | 0 | common | Exhaust a card in your hand: gain 1 steam, draw 1 | Gain 2 steam |
| Copper Rivets | attack | 0 | common | 3 damage. Pinned | 5 damage |
| Ballast Drop | attack | 2 | common | 10 damage to all enemies if you have 10 or more block, else 5 | 13 or 7 |
| Smelter | skill | 1 | common | Exhaust all Junk in your hand, 4 block for each | 6 block each |
| Steam Lance | sigil (bolt) | 2 | common | 14 damage that ignores block | 18 damage |
| Seized Joint | skill | 1 | uncommon | Stalled on the target. Exhaust | Costs 0 |
| Lens Focus | sigil (eye) | 1 | uncommon | 3 Vulnerable on the target, Scry 2 | 4 Vulnerable |
| Blueprint | skill | 1 | uncommon | Copy a card in your hand; the copy costs 0 this turn. Exhaust | Not exhausted |
| Pressure Release | attack | 0 | uncommon | Spend all Charge: 4 damage per stack | 5 per stack |
| Storm Ward | twin sigil (gear + ward) | 2 | rare | Gear: 6 damage to all enemies. Ward: 8 block | 8 and 11 |
| Hourglass Glyph | sigil (hourglass) | 2 | rare | Stalled on all enemies (the guardian is immune). Exhaust | Costs 1 |
| Mainspring | skill | 2 | rare | 4 Wound-up. Exhaust | 5 Wound-up |
| Governor | mechanism | 2 | rare | Statuses you apply last 1 turn longer | Costs 1 |
| Grand Design | mechanism | 3 | rare | Each turn, draw 1 more card | Costs 2 |
| Clock Spring Reset | skill | 1 | rare | Shuffle your discard pile into your draw pile, draw 2. Exhaust | Draw 3 |

Lens Focus costs 1 Steam. Aim at an enemy and trace the Eye’s outline and angled pupil. A 1× cast applies 3 Vulnerable, or 4 with the upgrade, then shows the top two draw-pile cards. Select any to discard and confirm. The kept cards stay in order, and trace strength scales the Vulnerable without changing the number of cards shown.

### Junk (added to your deck by act 2 enemies)

| Card | Effect |
| --- | --- |
| Slag | Unplayable. |
| Bent Cog | Unplayable. When drawn, lose 1 steam. |
| Scalding Leak | Unplayable. At the end of your turn in hand, take 2 damage. |

## 4. Field cards (the satchel)

The satchel holds 3 cards, and a workshop upgrade raises that to 5. It opens from a wrist button in XR and a key on desktop, and in combat from the table edge for combat-usable cards. Every field card is single use. Field cards are found in chests, behind locks and in puzzle vaults, given as task rewards, and sometimes offered in place of a card reward.

| Card | Form | Rarity | Use | Where it matters |
| --- | --- | --- | --- | --- |
| Lock Pick | field sigil (key) | common | Point at a brass lock (door or chest), the plate opens on the lock, and you trace the key glyph. A trace above the fizzle line opens it, and the pick is spent | Locked side rooms and chests |
| Skeleton Key | item | uncommon | Opens any brass lock, no trace | Same, for a sure open |
| Vault Key | item | rare | Opens the floor's iron-locked vault. One drops per floor, from the elite or the floor's puzzle | The vault |
| Scrying Lens | field sigil (eye) | common | Shows the floor map, and hidden doors within 2 rooms | Hidden doors, planning a backtrack |
| Recall Spiral | field sigil (spiral) | uncommon | Takes you back to the entry, or to a hearth you lit | Fast backtracking |
| Oil Can | item | common | Frees a seized puzzle part, or quietens one wandering automaton so you can pass | Puzzles, avoiding a fight |
| Tuning Fork | item | common | A hint for the puzzle in the room: plays the tone order, or highlights the next gear | Puzzles |
| Mending Salve | item | common | Heal 12 outside combat | Between fights |
| Forge Ember | item | uncommon | At a hearth, remove one card from your deck | Deck thinning |
| Polishing Kit | item | uncommon | Upgrade one card | Deck building |
| Smoke Flask | item, combat | uncommon | Flee any fight, the elite included. Not the guardian | An escape hatch |
| Spare Valve | item, combat | common | +2 steam this turn | A burst turn |

## 5. Between combat: puzzles, optional paths, tasks

The goal: about 40% of a 15 to 20 minute run is spent outside fights, and every room you clear can matter again later. Each element uses the panel slots Paul chose on 2026-11-17 (PRD D2): puzzle parts, lock plates, loose panels and the task board are baked panels at fixed slots in room templates. Every choice comes from a named seed stream, so floors replay exactly. Solutions are generated by a pure module (`floor/` or a new `puzzle/`) that is fully unit-tested.

### E1. Locks

- **Brass locks** sit on side-room doors and on some chests. They open with a Lock Pick, a Skeleton Key, or a solved puzzle that releases them.
- **The iron vault** is one per floor, behind an iron lock that only the Vault Key opens. Inside is a rare card, field cards and cogs.
- Locks only guard optional branches. The path to the guardian is never locked, so a run can never get stuck.

### E2. Puzzles (seeded, with the clue in a different room from the lock)

At most 2 puzzles per floor, each about 30 to 90 seconds to solve. Each puzzle has its parts in one room and its clue in another, so the player crosses the floor and comes back. A solved puzzle opens a vault, a shortcut or a cache of field cards. Every puzzle works seated, with grab and trigger, and has a desktop equivalent (D9).

| Puzzle | Verb | Clue elsewhere |
| --- | --- | --- |
| Gear train (playable) | Seat and swap three wheels in the Upper Works and wind the driver | A service diagram and winding key wait inside the Floor 1 pressure supply room. |
| Pressure valves | Turn 3 valves until the gauge reads the target | A gauge plate gives the reading |
| Orrery alignment (playable) | Turn three distinct planets to their charted bearings in the Upper Works | The calibration cabinet has the chart and key. Its drawer releases a real card after a correct wind. |
| Sigil door | Trace an unfamiliar glyph that is not in your deck | A torn page shows the glyph |
| Bell chimes (playable) | In the Upper Works, ring the three numbered bells in the order played downstairs | The Floor 1 music box plays four notes and lights the matching numbers and colors. Items keeps the score. |

**Playable Floor 1 Pressure Works wing.** The Pipe Gallery sends you looking for three circuit readings. A runner’s dispatch points toward a real find. Pick up each service slip to read it; **Items** in the pause menu keeps it for the run. Slips can lie on a desk, bench or floor, appear inside an opened coffer, or drop after an encounter. Uncollected slips remain available on return.

Read all three circuits, set the wheels, and pull the primer. Steam vents and the gear drive starts. Pull the toothed maker’s mark to open the drawer, then take the cogs. The machine pays 20 run cogs only on collection. Prior runs that already received the automatic payout stay paid.

Use seed `N0TE0032` for a wing branching from the starting hall and a mix of coffer, automaton and bench notes. The quest, journal, modular decor palette, and independent ingredient pool are recorded in the [puzzle recipe book](puzzle-recipe-book.md). [Pressure Works room views](verification/pressure-works.jpg)

### E3. Optional paths

- **Locked side wings** branch off the main path (E1). A brass key on a seeded Upper Works hook fits a marked optional coffer downstairs. A trigger pull or nearby grip collects the key. The key turns once in the lock, and a second interaction opens the released lid. Existing runs keep their original coffers.
- **Hidden doors** can occur in the Upper Works on new runs. Knock three times inside the marked brass circle to raise the service door’s catch. Pull the catch to walk into the service recess and open its coffer. A released latch or opened door stays that way on return. The Scrying Lens is a future field-card alternative.
- **Elite detour:** the elite room becomes optional, with a Vault Key as its reward.
- **Shortcut doors** connect otherwise distant locations. The Floor 1 grille opens when the Upper Works balance lifts its counterweight. Other shortcuts can use far-side latches.

### E4. Tasks (commissions)

The keeper posts one optional order per run on the Floor 1 wall ledger. It prefers the entrance hall and moves to a clear nearby room if necessary. Read the letter, then sign it with the wax stamp. **Items** records progress. A purse appears at the ledger after the signed work is complete. Collecting it pays once, including after Continue.

| Shipped order | Work credited | Payment |
| --- | --- | --- |
| Missing escapements | Bring back the flat spiral and spool from separate Floor 1 rooms, and the bowed spring from the Upper Works. Parts found before signing count. | 15 cogs |
| Cold return line | Restore Pressure Works on Floor 1. A repair completed before signing counts. | 10 cogs |
| The sealed collection | Open the optional Conservatory archive on Floor 3. Reaching the thorn collection alone does not complete this order. | 18 cogs |

Additional commission ideas include the following.

| Task | Example |
| --- | --- |
| Recovery | Find 3 escapement springs hidden in rooms (some behind locks) |
| Restoration | Relight every hearth on the floor |
| Challenge | Win a fight using only sigil cards |
| Delve | Open the vault |
| Mercy | Pass a wandering automaton without fighting it |

### E5. Wandering automaton

One avoidable Cog Sentry patrols the Upper Works on new runs with a clear route through an ordinary doorway. Seed `PAT00000` places it between Upper Works rooms 1 and 2. Close contact starts a regular encounter. A patrol win stays cleared independently of the room's encounter and treasure. The layout showcase keeps its enemy-free Upper Works. Later floors and the Oil Can interaction remain roadmap work.

Use the existing Cog Sentry rig and material set. Astra Extra High owns all visual and animation work for this feature, including the independent review. Game code owns position and facing. Synchronize the authored gait to route distance and verify foot contact, braking, pivots and the combat handoff in the running game.

### E6. Stairs between floors

New runs have three floors. The astral lift connects Floor 2 to the [Alchemical Conservatory](conservatory-and-return-routes.md). A player can take the marked staircase to Floor 2 and return to Floor 1. New runs enter the Upper Works through a gear shaft, with longer wings, steel-lined halls and workshops. A save in the former upstairs pressure wing returns to its stair landing. The other rooms keep their progress. Both landings show the direction and destination floor. Walk or teleport onto individual treads. Pull the trigger while pointing at the door handle, or click the handle on desktop. The door opens into darkness and the view fades out. It fades back in on level ground facing into the destination room.

Keep the deck, HP and cog purse with the run. Keep each floor’s layout, opened chests, cleared encounters and unlocked doors with that floor. A return trip resumes exploration at the matching landing. Repeated crossings and save/resume must preserve those changes without paying a reward twice.

## 6. Work items, in build order

| Code | Work | Depends on |
| --- | --- | --- |
| W1 | Satchel: inventory model in `rules/run.ts`, saving and resuming, the XR wrist panel and the desktop key, and the field card frame | none |
| W2 | Locks: brass and iron lock panels, the lock-pick plate on a lock, key items, lock placement on optional branches from a named stream | W1, the panel slot card |
| W3 | Wave A combat cards with M1, M2, M5, M6, M7, the iron d4 and the anchor glyph, plus the glyph-distinctness test | none |
| W4 | Pressure valves, separate collectible field notes and a reward compartment are playable. The sigil door is planned. | W2 for the sigil door |
| W5 | The downstairs counterweight loop and knock-open Upper Works service passage are playable. | the panel slot card |
| W6 | The keeper’s ledger offers recovery, restoration and delve commissions with a physical return payment. | W1 |
| W7 | Wave B combat cards with M3, M8, M9, M10, the crystal d12 and the eye glyph | W3 |
| W8 | Remaining field cards (Scrying Lens, Recall Spiral, Oil Can, Tuning Fork, Forge Ember, Polishing Kit, Smoke Flask, Spare Valve) | W1, W4, W5 |
| W9 | Gear train and orrery are playable alternate instruments. The Upper Works also has a seeded Cog Sentry patrol. | W4 |
| W10 | Wave C combat cards, Junk cards, and the act 2 enemies that add Junk | W7, PRD Q1 (acts) |
| W11 | Paired up/down stairs and per-floor saves are playable. Each floor keeps its opened chests and cleared encounters. Pressure Works is on Floor 1. The astral lift links the Upper Works and Conservatory. | Three seeded floors |

Assets per wave go through the art bible (D8) and the asset table:
- **Wave A:** 15 illustrations, the iron d4 model and faces, the anchor glyph.
- **Wave B:** 15 illustrations, the Mechanism frame, the crystal d12, the eye glyph.
- **Wave C:** 15 illustrations, 3 Junk illustrations, the hourglass glyph.
- **Field cards:** 12 illustrations, 2 field frames, the key glyph.
- **Exploration:** lock, puzzle and board panels, paired staircase landings and directional floor signs through the room kit (Blender).

## 7. Decisions for Paul

| Code | Decision | Status or recommendation |
| --- | --- | --- |
| CP1 | Pool size for the full game | 60 combat cards (15 slice + 45 in three waves), 12 field cards, 3 Junk |
| CP2 | What a failed Lock Pick trace does | Approved. A miss keeps the pick and the lock stays shut. Every attempt uses the selected mode’s normal tracing difficulty. Spend the pick on success. Lock-pick rooms are optional. |
| CP3 | Satchel size | Approved. Three consumable-tool slots, upgradeable to five. Discovered puzzle keys and ingredients use their own inventory. |
| CP4 | Field cards in the reward offer | Sometimes, as a fourth option beside the card choices, from the `loot` stream |
| CP5 | Mechanism cap | 3 on the table at once, so the table stays readable |
| CP6 | Puzzles per floor | 1 to 2, never on the path to the guardian |
| CP7 | Shortcut and hidden doors | Yes. They need loops in the floor generator (W5) |
| CP8 | Wandering automaton | Approved to build first. Begin with an avoidable Upper Works patrol, with particular attention to movement and animation. |
| CP9 | Where to start after the slice | W1 satchel, then W2 locks, then W3 Wave A cards, so locks and backtracking land first |
