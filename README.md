# Clockwork Spire

A seated WebXR roguelike deckbuilder for Meta Quest 3: climb a self-rebuilding arcane-brass wizard tower, fight rogue automatons with cards held in your hand, physical dice and drawn spell sigils.

Status: vertical slice in progress, playable at <https://spire.pardev.net> (open it in the Quest 3 browser and press Enter VR). See [PRD.md](PRD.md) for goals and the phase ladder, and [plans/](plans/) for per-phase implementation plans.

## In-run controls

Click the right thumbstick to open the radial menu. Tilt it toward **Settings**, **Deck**, **Items**, or **Logbook**, then pull the right trigger to select. Center the stick and pull the trigger to resume, or click the stick again to close the wheel. You can also press **Y** and point at a choice. To draw a sigil, hold the drawing-hand trigger and trace on the plate. Lift between strokes and take as long as you need. Squeeze the drawing-hand grip or point at **Cast** and pull the trigger to commit. On desktop, draw with the mouse and click **Cast**. [Base and upgraded glyphs](docs/verification/spell-glyphs.png)

## Room layout showcase

Open **Test seeds** on the title board, choose a named preset, then select **New Run**. Add `?playtest` to the title URL for a separate save slot and workshop.

[Walk the room showcase](https://spire.pardev.net/?seed=MAPTEST2). The link uses a separate save slot. Floor 1 includes two puzzle-operated return passages. Its entry hall opens onto the stairs to the enemy-free Upper Works. On a new run, Floor 2 opens in a furnace shaft with turning gears. Steel-lined halls and workshops lead away from the landing. Pressure Works branches off Floor 1. A save made inside its former upstairs wing resumes at the Upper Works stair landing. Walk with the left thumbstick (WASD on desktop), or aim the right controller at a tread, push the right stick forward, and release it to teleport there. Point at the door handle and pull either trigger, or click the handle on desktop. The door swings open and the view fades to the other floor, where you arrive on level ground. Open the radial menu to see your room number, template, and dimensions.

| Route from room 0 | What to inspect |
| --- | --- |
| 0 → 1 → 2 | The armor stands beside the entry hall doorway under the wall clock. Continue through the gear shaft to the walnut dining table and upholstered chairs in the timber-paneled dining room. |
| 0 → 3 → 4 → 5 → 7 | A second hall leads through an 8 × 2 m corridor and a quarter-turned gear shaft into the 12 × 12 m guardian vault. |
| 0 → 6 → 8 → 9 | Two narrow corridors lead to the pressure gallery and the boiler room. Its west wall carries a finned copper heat exchanger, and the pressure controls sit between the tank banks. |

When reporting a layout issue, include `MAPTEST2`, the room number or route, and the fixture you were facing.

## Cross-floor bell puzzle

Find and wind the Watchmaker’s Music Box on Floor 1. Watch the numbered lamps or listen to its four notes. Upstairs in the Upper Works, repeat the phrase on the three bells and take the released cog seal for 12 cogs. Use either controller’s trigger or click on desktop. The cog seal flies toward you when collected. **Items** keeps the score. The showcase adds walkthrough plaques to the music box, bells and pressure controls.

## Return routes and the Conservatory

The Upper Works balance raises a grille downstairs. Restoring Pressure Works also unlocks a separate supply room. Use the engraved astral lift in the Upper Works to reach Floor 3. The Conservatory contains two watching wizard portraits, a clockwork owl, broom caretakers and an alchemy bench. The pictured ingredients and striking hour vary with the seed. Ingredients and the finished potion appear in **Items**. A second brew opens the Conservatory archive. Its two clues are split between a wizard portrait and an object in the Upper Works, and both are recorded in **Items**.

The [floor roadmap and potion recipe book](docs/conservatory-and-return-routes.md) records the puzzle dependencies, clues, return trips, seed rules and future brews.

## Keeper’s commissions

The wax-sealed ledger on Floor 1 offers a seed-specific job. Point and pull the trigger, grip the letter or click to read it. Use the stamp to accept. Recovery asks for three marked springs on Floors 1 and 2. Restoration and delve orders recognize the existing pressure repair or opened Conservatory archive. Return to the ledger and collect the purse. [Order list and payments](docs/card-pool-and-exploration.md#e4-tasks-commissions)
## Clockmaker’s instruments

Once the pressure supply door opens, inspect the cabinet’s chart and take its winding key. The seed chooses a gear train or an orrery in the Upper Works. Restoring it releases a bonus card at the cabinet downstairs. **Items** retains the diagram, and installed parts and ring bearings survive Continue. [Instrument mechanics](docs/puzzle-recipe-book.md#the-clockmakers-calibration-order)

## Upper Works service recesses

Some seeds have a secret service room on Floor 2. Knock on a service panel using a controller trigger, a nearby grip or a desktop click. A hollow panel rings longer and its recessed brass catch moves outward. Pull the catch to open the passage. **Items** keeps the discovered landmark. Existing saves retain their original Upper Works layout.

## CI and deploy

`.github/workflows/ci.yml` runs `make checkall-ci` on every push to `main` and every pull request. It checks out this repo and `paulrobello/mux-xr` side by side, because `@par/xr-workspace` is a `file:` dependency on the sibling. The mux-xr commit is pinned in one place, [toolkit-release.json](toolkit-release.json): to take a newer toolkit, change its `sha` to a full commit, run the gate locally against that checkout, and push.

On a push to `main` the gated `dist/` is uploaded as the Pages artifact. The deploy job runs only when the repository variable `PAGES_ENABLED` is `true`, which is set after the GitHub Pages site and its custom domain exist (`spire.pardev.net`; DNS first, then `public/CNAME`, then the Pages API call).

Every build stamps `version.json` (build id, commit, time) next to `index.html`. An open tab polls it every 60 seconds and on focus, visibility and reconnect (`?version-poll=<seconds>` shortens the interval) and offers Reload or Later when a newer build is live, as a bar on desktop and as a panel in the scene in VR. The dev server shows no notice.
