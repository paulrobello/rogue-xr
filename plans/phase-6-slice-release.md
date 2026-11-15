# Phase 6 — Slice acceptance and release

PRD: [P6](../PRD.md#p6--slice-acceptance-and-release). Gate: `make checkall-ci`. Depends on [Phase 5](phase-5-slice-content.md).

### P6-T1 — Performance pass
- Depends on: P5-T13.
- Work: profile the worst views on Quest 3, fix budget breaches (merge static dressing, trim lights, tune scale), re-measure.
- Verify: before/after headset numbers in `docs/performance/` with load and device state; no estimates.

### P6-T2 — Bug bash and playtest notes
- Depends on: P5-T13.
- Work: two or more seeded runs per seed class, issues fixed or filed, `docs/playtesting.md` with observations on fling, dice, sigils and comfort.
- Verify: every fix has a test where testable; `make checkall-ci` green.

### P6-T3 — Goal verification
- Depends on: P6-T1, P6-T2.
- Work: `docs/verification.md` — per-goal evidence for G1 to G6, browser evidence and physical evidence recorded separately; any unverified criterion named as not met.
- Verify: each goal has its own evidence line.

### P6-T4 — Release
- Depends on: P6-T3.
- Work: README status section linking to the PRD phases; release deploy to `spire.pardev.net` (push needs Paul's approval); confirm the update notice prompts existing clients.
- Verify: live render of the released build; Paul plays two seeded runs on Quest 3 and accepts the slice.
