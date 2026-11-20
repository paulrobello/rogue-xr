# Return routes and the Alchemical Conservatory

## Exploration roadmap

| Milestone | What players discover | Payoff on a return visit |
| --- | --- | --- |
| Floor 1, Pressure Works | Three service slips in separate rooms carry the intake, return and relief readings. Their hiding places and the three dial values come from the run seed. A repaired primer pressurizes the remote door. | Revisit the door with the pressure hardware to enter a supply room. The maker’s drawer still awards its cogs separately. |
| Floors 1 and 2, counterweight | A barred service grille has a chain rising through the lintel. In the Upper Works, weigh two candidates against a brass reference. A level beam identifies the weight that fits the chain. | Hang the matching weight, return downstairs and walk through the grille from either side. The route must shorten a journey the player can already make. |
| Floor 3, Alchemical Conservatory | An astral lift connects the Upper Works to an enchanted workshop. Original ingredients, a cauldron and a thorn ward tie together the laboratory, galleries and clock room. | Brew the seeded potion and bring it to the ward. The thorns part and the player can walk into the protected room. |
| The striking hour | A clue in a different room depicts a particular clock time. Find the ornate grandfather clock, watch its hands and swinging pendulum, and be present when it strikes that hour. | Its compartment briefly exposes an ingredient the cauldron needs. A missed chime repeats within a short in-game cycle. The seed selects one of twelve hours. A full clock cycle takes 60 seconds of exploration, and the compartment stays open for eight seconds if the player stays in the room. |
| The living gallery | Two original wizard portraits have the layered depth of the cards. Their frames stay fastened to the wall while the painted figures subtly turn to watch the visitor. | Portraits serve as visible landmarks from both directions. The animated broom caretakers and the mechanical owl encounter distinguish these rooms from the Upper Works. |

The [keeper’s commission ledger](card-pool-and-exploration.md#e4-tasks-commissions) adds a separate reason to return to the entrance. A recovery order tracks marked springs across both lower floors. The other orders recognize a repaired service line or a breached Conservatory archive, even when found before the order is signed.

Beyond the keeper’s ledger, two routes give the player a reason to remember something seen earlier.

- A service chart and winding key wait inside the repaired pressure supply room. Complete the matching gear train or planetary orrery upstairs, then return to the downstairs cabinet for the raised card. [Calibration diagrams](puzzle-recipe-book.md#the-clockmakers-calibration-order)
- A three-tooth brass key hangs on a seeded Upper Works wall. Its enamel badge matches the padlock on an optional Floor 1 coffer. Inspecting the lock files its stamp in **Items**. Unlocking spends the key. The released coffer keeps its own loot and opens separately. A held key, a released lock and collected treasure each survive Continue.

A hollow Upper Works service panel is another optional discovery. Listen for its longer ring or watch the catch move, then pull the catch to enter the service recess. Solid panels answer with a shorter tap.

## Seed and save contract

Give each puzzle its own named random streams for answers and locations. Replaying a seed must reproduce the answer and each clue’s room and position, including the clock’s striking hour. Two runs containing the same puzzles should send the player looking in different places. A fixed showcase seed remains reproducible. Preserve the readings, discoveries, opened doors and rewards of an existing save.

Choose clue sites the player can reach before solving that puzzle. Keep stairs, doors and controller approach paths clear. Put collectible parts and the place that consumes them in recognizable rooms. Clues should refer to what actually spawned. Use the numbered bells, the portrait sitter’s gaze, instrument movement, engravings, or a journal entry to communicate the relationship. Reserve written walkthrough plaques for the guided showcase.

## Potion recipe book

After Thornwake, a second recipe leads to a seventh room, the Conservatory archive. The seed chooses the obstacle, ingredient order, record location, and which wizard portrait carries its seal. Inspect the seal on Floor 3 and the matching study object in the Upper Works. Either can be found first. Both observations remain in **Items** across floor travel and Continue. One ingredient is always the specimen the Thornwake recipe left unused.

| Recipe | Clue and ingredients | Brewing and obstacle |
| --- | --- | --- |
| **Thornwake Draught**, first playable brew | Mooncap has a crescent cap, star-thistle has a pointed bloom, and ember salt is a faceted crystal. Two engraved ingredient symbols give a seed-specific order. A separate dial clue identifies when to watch the clock for the second ingredient. | Find the ingredients, add them to the cauldron in the indicated order, then take the resulting draught to the thorn lattice. The thorns withdraw. A mistaken mix leaves the ingredients available. |
| **Lantern Ink** | The wizard’s seal gives the first ingredient. A silver rubbing of a star and crescent in the Upper Works gives the second. | Brew the ink at the cauldron and apply it to the plain masonry. A luminous arch and sapphire latch appear. Pull the latch to walk into the archive. The outlined doorway survives a return visit before it is opened. |
| **Stillwind Tincture** | The portrait identifies the first ingredient. An Upper Works wind chart records the second and shows the start of the still interval. A synchronized clock at the cauldron shows the local time. | Add the first ingredient during the two-hour interval on the dial (ten seconds of exploration). Add the second at any time. Pour the tincture into the draft engine to slow the fan, lift it into its housing and open the grilles. |
| **Looking-glass Elixir** | The apothecary’s handheld mirror in the Upper Works gives the first mark. Its counterpart on a Conservatory portrait gives the second. | Brew the elixir, return to the tarnished mirror and apply it. The silver surface clears and both halves of the botanical frame swing away from the passage. |

## Asset and playtest standard

Model, texture and light every asset for the distance at which a seated player encounters it. Inspect the brass and wood under the actual room lighting, transparent portrait edges at oblique angles, the owl’s silhouette before combat, and the clock hands and ingredient shapes at operating distance. Color and sound supplement shape, position and movement. Verify that both controller interaction and desktop input work, mistakes are recoverable, and Continue neither removes a discovered route nor pays a reward twice.


## Playtest evidence

The independent art review accepted the textured kit for playtesting. The production-build journey on desktop Metal and Quest Browser (Adreno 740) checked the locked and unlocked floor crossings, clock pickup, ingredient order, brew, ward, and a cold Continue. The desktop-input journey positions the tester near fixtures and stages the recovered Steamworks slips through the run flow. The clock ingredient is collected only after witnessing the chime. [Quest Browser capture](verification/quest-conservatory.jpg)

An emulated Quest controller also tested weighing and hanging the counterweight, riding the astral lift, collecting a Conservatory ingredient, and starting the owl fight. [Clockwork Owl in combat](verification/conservatory-owl-xr.jpg)

The separate archive walkthrough starts from an ordinary post-Thornwake save fixture. It reads the journal after inspecting both clues, finds the extra ingredient, operates the cauldron and archive, walks through, collects the treasure and reloads. `N0TE0032` exercises ink, `MAPTEST2` stillwind and `BREW0001` the mirror. [Three archive doorways in the game](verification/archive-doorways.jpg)

The keeper offers recovery on `KEEP0000`, restoration on `KEEP0010`, and the archive delve on `KEEP0005`. The upper workshop alternates between the gear train on `WIND0000` and the orrery on `WIND0001`. The hidden-panel playtest on `MAPTEST2` distinguishes the solid and hollow knocks, pulls the raised catch and crosses the open passage after Continue. [Upper Works playtest views](verification/upper-works-puzzles.jpg)

On Quest 3, `SPIRE001` and `CASE0042` placed the brass key in different Upper Works rooms and the marked coffer in different lower-floor rooms. Both trials first inspected the locked coffer, collected the key upstairs, continued from a save, returned with the key and unlocked the coffer. It stayed open after another Continue. [Key and coffer in Quest Browser](verification/brass-cache-quest.jpg)
