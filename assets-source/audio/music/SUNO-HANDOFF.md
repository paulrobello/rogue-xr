# Suno music handoff (P5-T8, decision D12)

Status: **waiting on Paul**. D12, in Paul's words: "generate all needed suno music prompts and settings in order they are needed". Music is owner-generated per `~/.claude/guides/suno.md`: an agent writes the prompts and prepares the files, and Paul generates and picks the recordings and spends the credits. Nothing here has been generated yet. The runtime (`src/audio/`) knows every cue below. A cue whose file is missing falls back to the cue that covered that moment before this list existed, or stays silent when there is none, and the game logs the missing music once. So the cues can arrive one at a time in any order.

The same data is machine-readable in [`cues.json`](cues.json), which the build script and the audition page read. A test checks that its ids, loop flags and file paths match the runtime registry and that every Style prompt below is identical to the one in `cues.json`. Change both files together.

All cues are original instrumentals for a seated, close-range Quest 3 game in a warm brass clockwork wizard tower (`docs/art-bible.md`, "Gilded Lamplight": candlelit, warm, painterly, no horror). They stay in one key family, D dorian, D minor and D major, with the workshop in G major, so every crossfade between neighbouring cues is consonant. They also leave the upper midrange open for the SFX: card taps, brass dice and chimes.

## The cues, in the order a player first hears them

Order follows `src/flow/flow.ts` on a typical first run. A won fight goes from combat to the reward screen, so the reward comes right after the first fight. Rest rooms and the elite sit deeper in the floor. Most first runs end in death. The workshop needs banked cogs from a finished run, and the guardian and the victory screen come last. Generate them in this order: each one fills the next gap a player would notice.

| # | Id | Title | Plays | Type |
| --- | --- | --- | --- | --- |
| 1 | `title` | Title theme | Title screen (and settings) before a run | Loop |
| 2 | `explore` | Exploring the floor | Walking the floor between fights | Loop |
| 3 | `combat` | Regular fight | A regular fight, table unfold to fold | Loop |
| 4 | `reward` | Reward | Reward screen after a won regular or elite fight | Loop |
| 5 | `rest` | Hearth rest | Standing in a rest room with a hearth | Loop |
| 6 | `elite` | Elite fight | The elite fight (Orrery Warden) | Loop |
| 7 | `defeat` | Defeat lament | Death screen after a lost fight | One-shot |
| 8 | `workshop` | Workshop | Workshop hub between runs | Loop |
| 9 | `guardian-1` | Guardian, phase 1 | Guardian fight until its case opens | Loop |
| 10 | `guardian-2` | Guardian, phase 2: the case opens | Guardian fight after its case opens | Loop |
| 11 | `victory` | Victory | Victory screen after the guardian falls | One-shot |

The settings screen reuses the title theme and gets no cue of its own. The workshop is in the slice (PRD phase 5 scope: "the workshop hub with 3 upgrades"), so it has its own cue.

**Why the guardian has two tracks.** The case opens when the guardian's hit points first fall to half (`GUARDIAN_PHASE_TWO_HP_FRACTION` in `src/content/enemies.ts`). That moment depends on the player's damage, so it lands at a different time in every fight, and one recording cannot line its escalation up with it. Two loops at the same tempo and in the same key let the runtime crossfade (1.5 s) at the instant the rules report phase 2, so the case opening and the music change land together. Generate `guardian-2` after you have picked `guardian-1`, and judge it by how the two sound back to back. If Suno offers a cover or audio-reference option on your plan, you may make `guardian-2` from your own `guardian-1` take to keep the same theme. Record that option and its Audio Influence value if you use it.

## Rules for every cue

- **Settings.** Every cue uses Instrumental On, an empty lyrics field, no Vocal Gender, Max Mode Off (each take is at most 2:00), Variety Off and Personalize Off. Weirdness and Style Influence come from the Line Run starting values in the guide: 15 to 25 % and 75 to 80 %. They are starting values, not a proven optimum. Change one setting at a time when comparing takes, and note any change.
- **Every take.** Listen for stray voices or choir, a fade-out ending on a loop cue, silent gaps inside the body, and a recognisable existing melody, which would be unusable. Suno can reject artist or game names, so the prompts describe instruments and mood only.
- **Loudness** (applied by the build, not something to set in Suno). Every cue is gained to -18 LUFS integrated ±1 LU, with true peak at or below -1.0 dBTP, measured on the decoded Ogg Opus file. The runtime gain in each cue's table then sets how loud it sits in the mix. One linear gain, no compression and no limiting.
- **Loop points** (loop cues). The build cuts the loop from the middle of the take, so the intro and the ending are never heard. Put `loop_start_s` and `loop_end_s` on bar lines: one bar is `240 / BPM` seconds, given in each table. Use a whole number of phrases (four or eight bars) between them, and leave at least the crossfade length of music after `loop_end_s`. Without `loops.json` the loop starts at the first audible sample and ends one crossfade before the end of the file.
- **Loop length and memory.** The runtime decodes every music file into memory as 32-bit float stereo at 48 kHz, which is about 0.37 MiB per second of music. Uncut 2:00 takes for all eleven cues would be about 440 MiB on the Quest. Cut loop bodies to the lengths given in each table with `loop_end_s`: about 90 s for `explore` and `combat` and 45 to 60 s for the rest. Without `loops.json` a loop keeps nearly the whole take. At those lengths the set is about 280 MiB, still a lot for the Quest, so loading music on demand is an open follow-up.
- **One-shots** (`defeat`, `victory`). The build trims silence from the head and tail and applies a 0.25 s raised-cosine fade at the end, so a ringing final chord is kept. Use `start_s` and `end_s` in `loops.json` to cut a take that runs long, and `fade_out_s` to change the fade.

## 1. `title`: Title theme

The first music a player hears. It introduces the tower's main motif, so it is the cue that sets the game's identity. It also plays under the settings screen.

| Field | Value |
| --- | --- |
| Plays | Title screen before a run, and the settings screen reached from it |
| Type and length | Loop. Loop body of about 60 s cut from the middle of a 2:00 take |
| Tempo and key | 76 BPM, D dorian, 4/4. One bar is 3.158 s |
| Runtime | Gain 1.0, 2.5 s crossfade in. Until `title.ogg` exists the runtime plays `explore` at 0.6 instead (today's behaviour). |
| Save the WAV as | `assets-source/audio/music/title.wav` |
| Built to | `public/assets/audio/music/title.ogg` |
| Pick the take that has | A clear, original, hummable motif inside the first 30 s that returns later; no drums entering; a steady level with no climax; a sustained final chord rather than a fade. |

Style:
```text
Original instrumental title theme for a cosy clockwork wizard tower roguelike. Inviting, warm, wondrous and a little melancholy. A memorable original melody on felt piano answered by solo French horn, music-box and celesta glints, warm string pad, plucked harp arpeggios, a slow ticking clockwork pulse like a grandfather clock escapement, soft low cello. Approximately 76 BPM, D dorian, 4/4, eight-bar phrases that state the theme, then repeat it with fuller strings and brass. Lamplit analog room sound, gentle and intimate. No drums, no big build and no fade-out ending. Leave the upper midrange open for small brass and glass interface sounds.
```

Lyrics: leave the field empty (Instrumental On).

Exclude styles:
```text
vocals, singing, spoken word, choir, electric guitar, synth lead, heavy drums, trap hats, EDM drops, risers, epic trailer percussion, fade out, harsh high frequencies
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

## 2. `explore`: Exploring the floor

The bed under most of a run. It plays for minutes at a time, so it must stay calm and unobtrusive. Prompt and settings are unchanged from the first handoff, and so is the filename, so the existing loop build keeps working.

| Field | Value |
| --- | --- |
| Plays | Walking the floor between fights, in every room except a rest room |
| Type and length | Loop. Loop body of about 90 s cut from the middle of a 2:00 take |
| Tempo and key | 72 BPM, D dorian, 4/4. One bar is 3.333 s |
| Runtime | Gain 1.0, 3.0 s crossfade in. No fallback: silent until `explore.ogg` exists. |
| Save the WAV as | `assets-source/audio/music/explore.wav` |
| Built to | `public/assets/audio/music/explore.ogg` |
| Pick the take that has | Steady four-bar phrases, no build, no drum fills, nothing that pulls focus after several minutes of repetition. |

Style:
```text
Original instrumental exploration music for a cosy clockwork wizard tower. Warm, curious, unhurried and gently mysterious. Felt piano playing a sparse repeating motif, music-box and celesta glints, soft brass pad swells, plucked harp and pizzicato strings, a quiet ticking clockwork percussion pattern like a distant escapement, warm low cello drone. Approximately 72 BPM, D dorian, steady four-bar phrases that repeat with small variations. Intimate warm room sound, lamplit and analog. No big build, no climax and no fade-out ending. Leave the upper midrange open for small brass and glass sound effects.
```

Lyrics: leave the field empty (Instrumental On).

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

## 3. `combat`: Regular fight

Regular fights against the Cog Sentry, Spring Hound and Bellows Golem. The player is thinking about cards and dice for minutes, so it drives without being frantic. Unchanged from the first handoff.

| Field | Value |
| --- | --- |
| Plays | A regular fight, from the combat table unfolding until it folds away |
| Type and length | Loop. Loop body of about 90 s cut from the middle of a 2:00 take |
| Tempo and key | 108 BPM, D minor, 4/4. One bar is 2.222 s |
| Runtime | Gain 1.0, 1.0 s crossfade while the table unfolds (0.6 s), and it rides through the table folding away. No fallback. |
| Save the WAV as | `assets-source/audio/music/combat.wav` |
| Built to | `public/assets/audio/music/combat.ogg` |
| Pick the take that has | Constant energy with no stops or breakdowns, a groove that stays in time, and room above the strings for dice and card impacts. |

Style:
```text
Original instrumental combat music for a clockwork brass automaton duel in a wizard tower. Tense, driving and mechanical but readable. Pulsing low strings ostinato, muted brass stabs, ticking and clanking metallic percussion like gears, soft war-drum pulse on a steady half-time groove, harpsichord and plucked harp counter-line, low cello and bass clarinet. Approximately 108 BPM, D minor, steady eight-bar phrases with constant energy. Warm brass and walnut room sound, dry and focused. No breakdown to silence, no fade-out ending and no solo drum fills. Leave the upper midrange open for card, dice and impact sound effects.
```

Lyrics: leave the field empty (Instrumental On).

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

## 4. `reward`: Reward

The reward screen after a won regular or elite fight, while the player chooses a card or skips. It is the first relief after the first fight. A guardian win goes to the victory screen instead.

| Field | Value |
| --- | --- |
| Plays | Reward screen after a won regular or elite fight, while the player picks a card or skips |
| Type and length | Loop. Loop body of about 45 s |
| Tempo and key | 84 BPM, D major, 4/4. One bar is 2.857 s |
| Runtime | Gain 0.8, 2.0 s crossfade, under the `reward-chime` stinger. Until `reward.ogg` exists the runtime plays `explore` at 0.5 (today's behaviour). |
| Save the WAV as | `assets-source/audio/music/reward.wav` |
| Built to | `public/assets/audio/music/reward.ogg` |
| Pick the take that has | Warm and lightly triumphant without a fanfare, so the chime stays the moment of reward; even phrases that loop cleanly. |

Style:
```text
Original instrumental reward music for choosing spoils after a won duel in a clockwork wizard tower. Relieved, warm, quietly triumphant and curious. Rippling harp and celesta arpeggios, a music-box melody, warm brass chorale swells, pizzicato strings, soft glockenspiel accents, light ticking clockwork percussion. Approximately 84 BPM, D major, 4/4, gentle four-bar phrases that repeat with small variations. Warm intimate room sound. No big fanfare, no heavy drums and no fade-out ending. Leave the upper midrange open for card and chime sound effects.
```

Lyrics: leave the field empty (Instrumental On).

Exclude styles:
```text
vocals, singing, spoken word, choir, electric guitar, heavy drums, trap hats, EDM drops, risers, big fanfare, march, fade out, harsh high frequencies
```

Settings (panel order):
```text
Instrumental: On
Vocal Gender: not selected
Duration: 1:30 (or the nearest offered at or above 1:30)
Max Mode: Off
Weirdness: 20%
Style Influence: 75%
Variety: Off (0)
Personalize / My Taste: Off
Model: record the model actually selected
```

## 5. `rest`: Hearth rest

A safe-haven cue for rest rooms, the dead-end rooms holding a brass hearth that heals once. It plays while the player stands in one and crossfades back to exploring when they leave.

| Field | Value |
| --- | --- |
| Plays | Standing in a rest room with a hearth while exploring; crossfades back to exploring on leaving |
| Type and length | Loop. Loop body of about 60 s |
| Tempo and key | 60 BPM, D major, 4/4. One bar is 4.000 s |
| Runtime | Gain 1.0, 3.0 s crossfade. Until `rest.ogg` exists the runtime keeps `explore` at 1.0 (today's behaviour). |
| Save the WAV as | `assets-source/audio/music/rest.wav` |
| Built to | `public/assets/audio/music/rest.ogg` |
| Pick the take that has | The calmest cue in the set, with no percussion beyond a soft tick and no fire crackle or other sound effects baked in, because the hearth has its own SFX. |

Style:
```text
Original instrumental lullaby for a safe resting nook beside a warm brass hearth in a clockwork wizard tower. Peaceful, cosy, restorative and tender. Slow felt piano melody, warm solo cello, soft bowed string pad, gentle music box, low warm clarinet, very soft brushed ticking like a slow pendulum clock. Approximately 60 BPM, D major, 4/4, slow four-bar phrases that repeat with small variations. Intimate close room sound, candlelit and analog. No percussion build, no climax and no fade-out ending. Leave the upper midrange open for steam and brass sound effects.
```

Lyrics: leave the field empty (Instrumental On).

Exclude styles:
```text
vocals, singing, spoken word, choir, electric guitar, drums, trap hats, EDM, risers, crackling fire sound effects, rain sounds, ambient noise, fade out, harsh high frequencies
```

Settings (panel order):
```text
Instrumental: On
Vocal Gender: not selected
Duration: 2:00 (or the longest offered at or above 2:00)
Max Mode: Off
Weirdness: 15%
Style Influence: 75%
Variety: Off (0)
Personalize / My Taste: Off
Model: record the model actually selected
```

## 6. `elite`: Elite fight

The one elite fight per floor, against the Orrery Warden. It should feel like a step up from a regular fight while staying in D, so the move from exploring sounds consonant.

| Field | Value |
| --- | --- |
| Plays | The elite fight (the Orrery Warden in the deepest combat room of a wing), from the table unfolding until it folds away |
| Type and length | Loop. Loop body of about 60 s |
| Tempo and key | 116 BPM, D minor, 4/4. One bar is 2.069 s |
| Runtime | Gain 1.0, 1.0 s crossfade while the table unfolds. Until `elite.ogg` exists the runtime plays `combat` (today's behaviour). |
| Save the WAV as | `assets-source/audio/music/elite.wav` |
| Built to | `public/assets/audio/music/elite.ogg` |
| Pick the take that has | Clearly heavier than `combat`; the circling high arpeggios must not mask dice and card SFX; constant energy with no breakdown. |

Style:
```text
Original instrumental elite combat music for a duel with a towering brass orrery automaton in a clockwork wizard tower. Ominous, heavier and more urgent than an ordinary fight but still readable. Driving low strings ostinato, high celesta and glass harmonica arpeggios that circle like orbiting planets, heavy muted brass hits, timpani and deep metallic gear clanks on a steady groove, harpsichord counter-line, low contrabassoon. Approximately 116 BPM, D minor, 4/4, steady eight-bar phrases with constant high energy. Warm, dry, focused room sound. No breakdown to silence, no fade-out ending and no solo drum fills. Leave the upper midrange open for card, dice and impact sound effects.
```

Lyrics: leave the field empty (Instrumental On).

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

## 7. `defeat`: Defeat lament

The death screen after a lost fight, which shows the run summary until the player returns to the title. On a first run this is the most likely ending, so it is heard before the guardian cues.

| Field | Value |
| --- | --- |
| Plays | Death screen after a lost fight, until the player returns to the title |
| Type and length | One-shot. One-shot of 40 to 60 s, played once and then silence |
| Tempo and key | 66 BPM slowing at the end, D minor, 4/4. One bar is 3.636 s |
| Runtime | One-shot (no loop), gain 1.0, fades in over 1.5 s under the `defeat-sting` stinger, then plays to its natural end. Silent until `defeat.ogg` exists (today's behaviour). |
| Save the WAV as | `assets-source/audio/music/defeat.wav` |
| Built to | `public/assets/audio/music/defeat.ogg` |
| Pick the take that has | Sad but gentle, never horror; a soft first two seconds so the stinger lands on top; a real ending on a ringing chord, not a fade or an abrupt cut. |

Style:
```text
Original instrumental short lament for the end of a failed climb in a clockwork wizard tower. Sorrowful, gentle and reflective, not horror. Opens softly on a held low chord, then a solo cello melody over slow felt piano, a music box that winds down and slows, a soft string pad, and a final distant low clock chime. Approximately 66 BPM, slowing at the end, D minor, 4/4. A complete short piece of about 45 seconds with a clear ending on a sustained low D minor chord that rings out naturally to silence. Intimate warm room sound.
```

Lyrics: leave the field empty (Instrumental On).

Exclude styles:
```text
vocals, singing, spoken word, choir, electric guitar, drums, trap hats, EDM, risers, horror stingers, jump scare, abrupt cut, harsh high frequencies
```

Settings (panel order):
```text
Instrumental: On
Vocal Gender: not selected
Duration: 1:00 (or the shortest offered)
Max Mode: Off
Weirdness: 20%
Style Influence: 80%
Variety: Off (0)
Personalize / My Taste: Off
Model: record the model actually selected
```

## 8. `workshop`: Workshop

The workshop hub between runs, where banked cogs buy permanent upgrades. Upgrades need cogs from a finished run, so the player first spends time here after the first run ends.

| Field | Value |
| --- | --- |
| Plays | Workshop hub reached from the title between runs, where banked cogs buy permanent upgrades |
| Type and length | Loop. Loop body of about 60 s |
| Tempo and key | 88 BPM, G major, 4/4. One bar is 2.727 s |
| Runtime | Gain 1.0, 2.0 s crossfade. Until `workshop.ogg` exists the runtime plays `explore` at 0.5 (today's behaviour). |
| Save the WAV as | `assets-source/audio/music/workshop.wav` |
| Built to | `public/assets/audio/music/workshop.ogg` |
| Pick the take that has | Busy and hopeful, a little playful but not childish; no big build; the tool-like ticking stays soft. |

Style:
```text
Original instrumental workshop music for an apprentice tinkering at a warm brass workbench between climbs of a clockwork wizard tower. Hopeful, playful, busy and cosy. Bouncy pizzicato strings, a felt piano and celesta melody, clarinet and bassoon counter-lines, plucked harp, a light ticking and ratcheting clockwork percussion groove like small tools at work, warm low strings. Approximately 88 BPM, G major, 4/4, steady four-bar phrases that repeat with small variations. Warm intimate room sound. No big build, no heavy drums and no fade-out ending. Leave the upper midrange open for small brass and interface sounds.
```

Lyrics: leave the field empty (Instrumental On).

Exclude styles:
```text
vocals, singing, spoken word, choir, electric guitar, heavy drums, trap hats, EDM drops, risers, big orchestral climax, fade out, harsh high frequencies
```

Settings (panel order):
```text
Instrumental: On
Vocal Gender: not selected
Duration: 2:00 (or the longest offered at or above 2:00)
Max Mode: Off
Weirdness: 25%
Style Influence: 75%
Variety: Off (0)
Personalize / My Taste: Off
Model: record the model actually selected
```

## 9. `guardian-1`: Guardian, phase 1

The floor guardian, the Grand Escapement, a giant clock automaton. Phase 1 runs while its case is still closed: grave and controlled, holding back.

| Field | Value |
| --- | --- |
| Plays | The floor guardian fight (the Grand Escapement), from the table unfolding until its case opens at half hit points |
| Type and length | Loop. Loop body of about 60 s |
| Tempo and key | 96 BPM, D minor, 4/4. One bar is 2.500 s |
| Runtime | Gain 1.0, 1.0 s crossfade while the table unfolds. Until `guardian-1.ogg` exists the runtime plays `combat` (today's behaviour). |
| Save the WAV as | `assets-source/audio/music/guardian-1.wav` |
| Built to | `public/assets/audio/music/guardian-1.ogg` |
| Pick the take that has | A steady pendulum tick on the beat that loops cleanly; restrained compared with phase 2; a four-bar bell pattern, so put the loop points on a multiple of four bars (10 s). |

Style:
```text
Original instrumental final boss music, first phase, for a duel with a giant grandfather-clock automaton guardian at the top of a clockwork wizard tower. Grave, majestic and menacing, measured and controlled. Deep pipe organ pedal tones, low brass chorale, a heavy tick-tock pendulum percussion on every beat, low strings ostinato, a distant tower bell on the first beat of every fourth bar, harpsichord figures, timpani. Approximately 96 BPM, D minor, 4/4, steady eight-bar phrases with constant restrained intensity, held back as if something is still locked inside. Warm, dry, focused room sound. No breakdown to silence, no fade-out ending and no solo drum fills. Leave the upper midrange open for card, dice and impact sound effects.
```

Lyrics: leave the field empty (Instrumental On).

Exclude styles:
```text
vocals, singing, spoken word, choir, epic choir, electric guitar, distorted guitar, dubstep, trap hats, EDM drops, trailer braams, risers, breakdown, silence gap, fade out, harsh high frequencies, long reverb
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

## 10. `guardian-2`: Guardian, phase 2: the case opens

The guardian after its case opens at half hit points. The runtime crossfades to it the moment the rules emit the phase-2 event.

| Field | Value |
| --- | --- |
| Plays | The guardian fight from the moment its case opens until the fight ends |
| Type and length | Loop. Loop body of about 60 s |
| Tempo and key | 96 BPM with a double-time feel, D minor, 4/4. One bar is 2.500 s |
| Runtime | Gain 1.0, 1.5 s crossfade from `guardian-1` when the case opens. Until `guardian-2.ogg` exists the runtime keeps playing `guardian-1` (or `combat`). |
| Save the WAV as | `assets-source/audio/music/guardian-2.wav` |
| Built to | `public/assets/audio/music/guardian-2.ogg` |
| Pick the take that has | The same key, tempo and instrument family as your chosen `guardian-1` take, so the crossfade sounds like the same piece escalating; maximum energy that still leaves room for SFX. |

Style:
```text
Original instrumental final boss music, second phase, for a giant grandfather-clock automaton guardian whose case has burst open to reveal racing gears. Furious, urgent and climactic but still readable. The same grave organ and brass world at full force: full brass section, tolling tower bells, racing double-time strings ostinato, rapid ticking and ratcheting metallic gear percussion, pounding timpani and low war drums, harpsichord runs, full pipe organ. Approximately 96 BPM with a driving double-time feel, D minor, 4/4, steady eight-bar phrases with constant maximum energy. Warm, dry, focused room sound. No breakdown to silence, no fade-out ending and no solo drum fills. Leave the upper midrange open for card, dice and impact sound effects.
```

Lyrics: leave the field empty (Instrumental On).

Exclude styles:
```text
vocals, singing, spoken word, choir, epic choir, electric guitar, distorted guitar, dubstep, trap hats, EDM drops, trailer braams, risers, breakdown, silence gap, fade out, harsh high frequencies, long reverb
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

## 11. `victory`: Victory

The victory screen after the guardian falls, showing the run summary until the player returns to the title. The rarest cue, so it is heard last.

| Field | Value |
| --- | --- |
| Plays | Victory screen after the guardian falls, until the player returns to the title |
| Type and length | One-shot. One-shot of 45 to 75 s, played once and then silence |
| Tempo and key | 92 BPM, D major, 4/4. One bar is 2.609 s |
| Runtime | One-shot (no loop), gain 1.0, fades in over 2.0 s under the `victory-sting` stinger, then plays to its natural end. Silent until `victory.ogg` exists (today's behaviour). |
| Save the WAV as | `assets-source/audio/music/victory.wav` |
| Built to | `public/assets/audio/music/victory.ogg` |
| Pick the take that has | A soft opening for the stinger, an original fanfare melody rather than a recognisable tune, a calm coda, and a real ending that rings out. |

Style:
```text
Original instrumental victory music for reaching the top of a clockwork wizard tower after defeating its guardian. Triumphant, warm, relieved and wondrous. Opens softly on a held chord for two seconds, then a bright brass fanfare on an original melody, celebratory tolling bells, sweeping strings, rippling harp and celesta, timpani rolls, then a calm warm coda on felt piano and music box. Approximately 92 BPM, D major, 4/4. A complete short piece of about 60 seconds with a clear ending on a sustained D major chord that rings out naturally to silence. Lamplit warm hall sound.
```

Lyrics: leave the field empty (Instrumental On).

Exclude styles:
```text
vocals, singing, spoken word, choir, electric guitar, trap hats, EDM drops, dubstep, risers, abrupt cut, harsh high frequencies
```

Settings (panel order):
```text
Instrumental: On
Vocal Gender: not selected
Duration: 1:00 (or the shortest offered)
Max Mode: Off
Weirdness: 20%
Style Influence: 80%
Variety: Off (0)
Personalize / My Taste: Off
Model: record the model actually selected
```

## How to hand back

1. For each picked take, download the full-song **WAV** from the Suno web interface. Mobile downloads default to MP3.
2. Save the untouched download under `assets-source/audio/music/` with the exact name from that cue's table: `title.wav`, `explore.wav`, `combat.wav`, `reward.wav`, `rest.wav`, `elite.wav`, `defeat.wav`, `workshop.wav`, `guardian-1.wav`, `guardian-2.wav`, `victory.wav`. These are the immutable sources. Never edit them.
3. Send in chat, per cue: the cue id, the song link or ID, the model actually selected, the account plan at generation, and any change you made to the prompt or settings. Also send the original Suno filename. The build records the SHA-256 and size but cannot know the original name.
4. Optional: if you hear where a loop should start and end, give the times. Otherwise the agent picks bar-aligned points in `loops.json` and you audition them.

You can hand back cues one at a time. Each one replaces its fallback the next time the build runs.

## Loop preparation (automatic once the WAVs exist)

`python3 -I scripts/assets/build_audio.py --only <id>,<id>` reads the cue list from `cues.json` and does this deterministically:

1. Decode to 48 kHz stereo float. The source is never modified.
2. **Loop cues.** Start the loop at `loop_start_s` from `assets-source/audio/music/loops.json`, or at the first sample above -50 dBFS. End it at `loop_end_s`, or `crossfade_s` before the end of the file. Blend the material after the loop end under the first `crossfade_s` seconds (default 2.0, equal power), so the last sample runs straight into the first and the loop restarts on the retained start position.
3. **One-shots.** Cut to `start_s` and `end_s` when set, trim silence more than 50 dB under the peak from both ends, and apply a 2 ms fade in and a `fade_out_s` (default 0.25 s) raised-cosine fade out.
4. One linear gain to -18 LUFS integrated, limited by a -1.0 dBTP ceiling, then Ogg Opus 128 kbps stereo at 48 kHz, written to `public/assets/audio/music/<id>.ogg`.
5. Measure the decoded Opus file: LUFS and true peak for every cue, plus the wrap step, the head-to-tail level and interior dropouts for loops. Results land in `public/assets/audio/report.json` and `assets-source/audio/provenance.json`.

Optional `loops.json` shape (bar-aligned examples, to be replaced by points picked from the real takes):

```json
{
  "explore":    { "loop_start_s": 3.333, "loop_end_s": 93.333, "crossfade_s": 2.0 },
  "combat":     { "loop_start_s": 2.222, "loop_end_s": 91.111, "crossfade_s": 1.5 },
  "guardian-1": { "loop_start_s": 10.0,  "loop_end_s": 70.0,   "crossfade_s": 1.5 },
  "victory":    { "end_s": 62.0, "fade_out_s": 0.5 }
}
```

Then audition each loop for several repeats, and each one-shot under its stinger, on the Quest speakers before approving. Source selection, technical preparation, creative acceptance and release rights are separate facts. None of them is recorded as approved here.
