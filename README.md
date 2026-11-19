# Clockwork Spire

A seated WebXR roguelike deckbuilder for Meta Quest 3: climb a self-rebuilding arcane-brass wizard tower, fight rogue automatons with cards held in your hand, physical dice and drawn spell sigils.

Status: vertical slice in progress, playable at <https://spire.pardev.net> (open it in the Quest 3 browser and press Enter VR). See [PRD.md](PRD.md) for goals and the phase ladder, and [plans/](plans/) for per-phase implementation plans.

## In-run controls

Open the wrist menu to choose **Settings**, **Deck**, or **Items**. Select the center to resume. To draw a sigil, hold the drawing-hand trigger and trace on the plate. Lift between strokes and take as long as you need. Squeeze the drawing-hand grip or point at **Cast** and pull the trigger to commit. On desktop, draw with the mouse and click **Cast**. [Base and upgraded glyphs](docs/verification/spell-glyphs.png)

## Room layout showcase

[Walk the enemy-free room showcase](https://spire.pardev.net/?seed=MAPTEST2). The link uses a separate save slot. All ten rooms are accessible from the entry hall. Open the radial menu to see your room number, template, and dimensions.

| Route from room 0 | What to inspect |
| --- | --- |
| 0 → 1 → 2 | The armor stands beside the entry hall doorway under the wall clock. Continue through the gear shaft to the walnut dining table and upholstered chairs in the timber-paneled dining room. |
| 0 → 3 → 4 → 5 → 7 | A second hall leads through an 8 × 2 m corridor and a quarter-turned gear shaft into the 12 × 12 m guardian vault. |
| 0 → 6 → 8 → 9 | Two narrow corridors lead to the pressure gallery and the boiler room. Its west wall carries a finned copper heat exchanger, and the pressure controls sit between the tank banks. |

When reporting a layout issue, include `MAPTEST2`, the room number or route, and the fixture you were facing.

## CI and deploy

`.github/workflows/ci.yml` runs `make checkall-ci` on every push to `main` and every pull request. It checks out this repo and `paulrobello/mux-xr` side by side, because `@par/xr-workspace` is a `file:` dependency on the sibling. The mux-xr commit is pinned in one place, [toolkit-release.json](toolkit-release.json): to take a newer toolkit, change its `sha` to a full commit, run the gate locally against that checkout, and push.

On a push to `main` the gated `dist/` is uploaded as the Pages artifact. The deploy job runs only when the repository variable `PAGES_ENABLED` is `true`, which is set after the GitHub Pages site and its custom domain exist (`spire.pardev.net`; DNS first, then `public/CNAME`, then the Pages API call).

Every build stamps `version.json` (build id, commit, time) next to `index.html`. An open tab polls it every 60 seconds and on focus, visibility and reconnect (`?version-poll=<seconds>` shortens the interval) and offers Reload or Later when a newer build is live, as a bar on desktop and as a panel in the scene in VR. The dev server shows no notice.
