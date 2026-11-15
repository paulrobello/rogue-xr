# Phase 2 — Combat rules engine (desktop-playable)

PRD: [P2](../PRD.md#p2--combat-rules-engine-desktop-playable). Gate: `make checkall`. Depends on Phase 0 only; runs in parallel with Phase 1.

Rules baseline (D3): 3 steam per turn, draw 5, discard hand at end of turn, reshuffle discard into draw when empty (via the `deck` stream), block resets each turn, enemies show next intent, statuses tick at turn boundaries.

### P2-T1 — Rules engine core
- Depends on: P0-T3.
- Work: `rules/` pure TypeScript: combat state (player HP, block, steam, piles, statuses; enemies with HP, block, intent), reducer-style `apply(state, action) → {state, events}`, turn loop, damage/block resolution with modifiers, statuses (at least: Weak, Vulnerable, Overheat, Wound-up), event log for presentation. No three.js imports (enforced by a Biome import restriction or a test that scans imports).
- Verify: Vitest for every rule; import-boundary test.

### P2-T2 — Slice card set (15 cards)
- Depends on: P2-T1.
- Work: `content/cards.ts` — data-driven card schema (cost, type attack/skill/sigil, target rule, effect list, dice hook, sigil id, upgrade variant). 15 cards: about 5 attacks, 5 skills, 5 sigil spells; at least 4 cards with a dice roll; starter deck of 10 defined.
- Verify: Vitest per card effect, including upgrade variants.

### P2-T3 — Automaton roster and intent AI
- Depends on: P2-T1.
- Work: `content/enemies.ts` — 3 regular automatons (e.g. Cog Sentry, Spring Hound, Bellows Golem), 1 elite (Orrery Warden), 1 floor guardian (Grand Escapement); intent scripts as weighted patterns seeded from the `ai` stream; floor-budget encounter sets.
- Verify: Vitest — intent sequences deterministic per seed; every intent resolves through the engine.

### P2-T4 — Dice and sigil hooks
- Depends on: P2-T1.
- Work: `content/dice.ts` — 2 dice types (brass d6, glass d8) with face values; `rules/dice.ts` resolves a roll from the `dice` stream *before* presentation (D1) and exposes the result to the presenter; `rules/sigil.ts` accepts a 0.5 to 1.25 multiplier and scales the card's effect (rounding rule documented).
- Verify: Vitest — dice results deterministic, presenter receives the same value the engine applies; multiplier clamping and rounding.

### P2-T5 — Rewards and run currency
- Depends on: P2-T2.
- Work: post-combat reward: choose 1 of 3 cards (from `loot` stream) or skip; currency ("cogs") awarded by encounter tier; deck mutation in run state.
- Verify: Vitest — reward offers deterministic per seed; currency totals.

### P2-T6 — Desktop debug combat view
- Depends on: P2-T2, P2-T3, P2-T4, P0-T2.
- Work: mouse-playable combat in the 3D scene with plain placeholder card meshes: click card then target, end turn, dice result shown, sigil drawn with the mouse on a plate (uses a stub score until P3-T5 lands).
- Verify: manual full fight win and loss against each enemy on desktop; screenshot in `docs/verification/`.

### P2-T7 — Golden combat logs
- Depends on: P2-T2, P2-T3, P2-T4.
- Work: scripted input sequences per enemy produce event logs checked into `tests/golden/`.
- Verify: Vitest compares logs byte-for-byte; regenerating requires an explicit flag.
