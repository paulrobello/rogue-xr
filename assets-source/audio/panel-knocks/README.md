# Upper Works panel knocks

These original, positional mono effects distinguish a solid service plate from a hollow side chamber. A short filtered strike excites four higher, quickly damped modes on the solid plate. The hollow plate adds lower-frequency body resonance and two short reflected impulses. Both use the same deterministic noise source and matched attack level. A successful hollow knock also moves the leaf and raises its catch, so the panel can be discovered while muted.

The standard-library [synthesis source](../../../scripts/assets/build-panel-knocks.py) writes 48 kHz mono Opus with bit-exact container flags. The [decoded measurements and hashes](manifest.json) record per-cue peak, onset RMS and tail RMS. Rebuilding twice with the recorded encoder produced identical files.
