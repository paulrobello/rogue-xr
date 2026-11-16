# Suno music handoff (P5-T8)

Status: **waiting on Paul**. Per `~/.claude/guides/suno.md` music is owner-generated: an agent supplies the prompts and prepares the files, the owner generates and selects the recordings and spends the credits. Nothing here has been generated. The runtime (`src/audio/`) plays silence for a missing music file and logs that once, so the game works until the files arrive.

Two cues, both original instrumentals for a seated, close-range Quest 3 game in a warm brass clockwork wizard tower (`docs/art-bible.md`, "Gilded Lamplight"). They share a key family so the crossfade between them is consonant, and they leave the upper-mid range open for the SFX (card taps, brass dice, chimes).

## Cue 1: `explore` (also plays under the title, reward and workshop screens at lower gain)

| Field | Value |
| --- | --- |
| Role | Calm exploration bed: curious, warm, unhurried, a little mysterious. Plays for minutes while the player walks the floor. |
| Tempo / key | 72 BPM, D dorian, 4/4 |
| Length to select | 2:00 or longer in the Duration control. The loop is cut from the middle of the take, so the intro and ending are not used |
| Loop behaviour | Steady four-bar phrases with no big build, no drum fills and no fade-out ending. A sustained final chord is fine because the build crops it |

Style:
```text
Original instrumental exploration music for a cosy clockwork wizard tower. Warm, curious, unhurried and gently mysterious. Felt piano playing a sparse repeating motif, music-box and celesta glints, soft brass pad swells, plucked harp and pizzicato strings, a quiet ticking clockwork percussion pattern like a distant escapement, warm low cello drone. Approximately 72 BPM, D dorian, steady four-bar phrases that repeat with small variations. Intimate warm room sound, lamplit and analog. No big build, no climax and no fade-out ending. Leave the upper midrange open for small brass and glass sound effects.
```

Exclude styles:
```text
vocals, singing, spoken word, choir, electric guitar, distorted guitar, heavy drums, dubstep, trap hats, EDM drops, risers, big orchestral climax, fade out, harsh high frequencies
```

Settings (panel order):
```text
Instrumental: On
Vocal Gender: not selected
Duration: 2:00 (or the longest offered at or above 2:00)
Max Mode: Off
Weirdness: 20%
Style Influence: 75%
Variety: Off (0)
Personalize / My Taste: Off
Model: record the model actually selected
```

## Cue 2: `combat` (plays while the combat table is unfolding and during the fight)

| Field | Value |
| --- | --- |
| Role | Tense but readable fight music for a turn-based card game. Driving without being frantic, because the player is thinking about dice and card choices for minutes. |
| Tempo / key | 108 BPM, D minor, 4/4 |
| Length to select | 2:00 or longer |
| Loop behaviour | Steady groove with a constant energy level. No stops, no breakdown to silence, no drum solos, no fade-out ending |

Style:
```text
Original instrumental combat music for a clockwork brass automaton duel in a wizard tower. Tense, driving and mechanical but readable. Pulsing low strings ostinato, muted brass stabs, ticking and clanking metallic percussion like gears, soft war-drum pulse on a steady half-time groove, harpsichord and plucked harp counter-line, low cello and bass clarinet. Approximately 108 BPM, D minor, steady eight-bar phrases with constant energy. Warm brass and walnut room sound, dry and focused. No breakdown to silence, no fade-out ending and no solo drum fills. Leave the upper midrange open for card, dice and impact sound effects.
```

Exclude styles:
```text
vocals, singing, spoken word, choir, electric guitar, distorted guitar, dubstep, trap hats, EDM drops, risers, breakdown, silence gap, fade out, harsh high frequencies, long reverb
```

Settings (panel order):
```text
Instrumental: On
Vocal Gender: not selected
Duration: 2:00 (or the longest offered at or above 2:00)
Max Mode: Off
Weirdness: 25%
Style Influence: 80%
Variety: Off (0)
Personalize / My Taste: Off
Model: record the model actually selected
```

These are starting values taken from the Line Run examples in the guide, not a proven optimum. Change one setting at a time when comparing takes.

## What to send back

For each selected take: the full-song **WAV** (web download), the song link or ID, the actual model, the account plan at generation, the cue role (`explore` or `combat`), and any prompt or setting you changed. Listen for stray vocals, a fade-out ending, and silent gaps inside the body.

Save the untouched downloads here as the immutable sources, named exactly:

```text
assets-source/audio/music/explore.wav
assets-source/audio/music/combat.wav
```

(Keep the original Suno filename in a note beside them: the build records the SHA-256 and size but cannot know the original name.)

## Loop preparation (automatic once the WAVs exist)

`python3 -I scripts/assets/build_audio.py --only explore,combat` does this deterministically:

1. Decode to 48 kHz stereo float. The source is never modified.
2. Start the loop at the first sample above -50 dBFS, or at `loop_start_s` from `assets-source/audio/music/loops.json` when set.
3. End the loop at `loop_end_s` from `loops.json`, or by default `crossfade_s` before the end of the file.
4. Blend the material after the loop end under the first `crossfade_s` seconds (default 2.0, equal power) so the last sample runs straight into the first and the loop restarts on the retained start position. Pick `loop_start_s` and `loop_end_s` on bar lines (`60 / BPM * 4` seconds per bar: 3.333 s at 72 BPM, 2.222 s at 108 BPM) so the groove stays in time across the wrap.
5. One linear gain to -18 LUFS integrated, limited by a -1.0 dBTP ceiling, then Ogg Opus 128 kbps stereo at 48 kHz.
6. Measure the decoded Opus file: LUFS, true peak, wrap step, head-to-tail level and interior dropouts. Results land in `public/assets/audio/report.json` and `assets-source/audio/provenance.json`.

Optional `loops.json` shape:

```json
{ "explore": { "loop_start_s": 3.333, "loop_end_s": 56.667, "crossfade_s": 2.0 },
  "combat":  { "loop_start_s": 2.222, "loop_end_s": 55.556, "crossfade_s": 1.5 } }
```

Then audition each loop for several repeats on the Quest speakers before approving. Source selection, technical preparation, creative acceptance and release rights are separate facts. None of them is recorded as approved here.
