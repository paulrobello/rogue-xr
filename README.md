# Clockwork Spire

A seated WebXR roguelike deckbuilder for Meta Quest 3: climb a self-rebuilding arcane-brass wizard tower, fight rogue automatons with cards held in your hand, physical dice and drawn spell sigils.

Status: planning. See [PRD.md](PRD.md) for goals and the phase ladder, and [plans/](plans/) for per-phase implementation plans.

## CI and deploy

`.github/workflows/ci.yml` runs `make checkall-ci` on every push to `main` and every pull request. It checks out this repo and `paulrobello/mux-xr` side by side, because `@par/xr-workspace` is a `file:` dependency on the sibling. The mux-xr commit is pinned in one place, [toolkit-release.json](toolkit-release.json): to take a newer toolkit, change its `sha` to a full commit, run the gate locally against that checkout, and push.

On a push to `main` the gated `dist/` is uploaded as the Pages artifact. The deploy job runs only when the repository variable `PAGES_ENABLED` is `true`, which is set after the GitHub Pages site and its custom domain exist (`spire.pardev.net`; DNS first, then `public/CNAME`, then the Pages API call).

Every build stamps `version.json` (build id, commit, time) next to `index.html`. An open tab polls it every 60 seconds and on focus, visibility and reconnect (`?version-poll=<seconds>` shortens the interval) and offers Reload or Later when a newer build is live, as a bar on desktop and as a panel in the scene in VR. The dev server shows no notice.
