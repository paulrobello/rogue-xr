# Audio sources (P5-T8)

Music and SFX for Clockwork Spire. Runtime files are in `public/assets/audio/`, the code in `src/audio/`.

## Layout

| Path | What |
| --- | --- |
| `sfx/prompts.json` | The 20 SFX specs: exact prompt text, duration, prompt influence, loop flag, class. The generation record quotes this file. |
| `sfx/raw/*.mp3` | Immutable ElevenLabs outputs, 44.1 kHz stereo MP3 (the Starter plan cannot request PCM). Never edited. |
| `sfx/generation-log.json` | One entry per request: payload, response headers (including `character-cost`), sha256, size, time. |
| `sfx/meter-before.txt`, `meter-after.txt` | `GET /v1/user/subscription` credit counters around the batch. |
| `music/SUNO-HANDOFF.md` | Suno prompts, settings and loop preparation for all eleven music cues (D12). Music is owner-generated; no music source exists yet. |
| `music/cues.json` | The music cue list in first-heard order: id, loop flag, source and runtime paths, Style prompt and Suno settings. The build and the audition page read it; a test keeps it in step with `src/audio/cues.ts`. |
| `derived/*.wav` | Lossless 48 kHz float intermediates, one per cue, rebuilt by the script. |
| `provenance.json` | Machine-readable record: rights, approvals, prompts, per-cue source and runtime hashes and processing steps. Written by the build. |

## Build

`python3 -I scripts/assets/build_audio.py` (system Python with numpy; ffmpeg 9.0.2 with libopus on PATH). It is deterministic: two consecutive builds gave identical Ogg hashes and an identical `report.json`. `scripts/assets/generate_sfx.py` made the generations and skips any cue whose raw file exists; `--retry <id>` is the only way to spend a second take.

Per cue: decode to 48 kHz float, trim silence more than 50 dB under the clip peak (5 ms head, 10 ms tail margin), 2 ms fade in and a raised-cosine fade out, fold positional cues to mono with `0.5*L + 0.5*R`, apply one linear gain toward the target, encode, then **measure the decoded Opus file**. The gain is capped so the decoded true peak stays at or under -1.0 dBTP, and re-encoded with less gain if the lossy encode overshoots. `loudnorm` is not used, because it silently stops honouring its targets past the linear limit.

## Format decision

Ogg Opus at 48 kHz. Quest Browser is Chromium and decodes Ogg Opus, as does desktop Chrome and Firefox, so no AAC fallback is shipped. Opus gives the smallest files at transparent quality for short cues (the 20 SFX total 283 KB) and has no encoder-delay problem: the Ogg container carries exact sample counts, which keeps music loops gapless. Positional cues are mono 64 kbps because a `PannerNode` needs a mono input, UI cues and stingers are stereo 96 kbps, music is stereo 128 kbps. Safari support for Ogg Opus is not a target of this slice.

## Targets and results

SFX -16 LUFS integrated and music -18 LUFS, true peak at most -1.0 dBTP, tolerance 1 LU. These were proposed in the task and are new project values. Measured results per cue are in `public/assets/audio/report.json`. Twelve SFX miss -16 LUFS because their peaks sit at full scale while the body is quiet (crest factor), so the true-peak ceiling stops the gain. They are mastered to the ceiling and flagged `deviation` with `limited_by_true_peak`. Nothing was limited or compressed to hide that. Integrated loudness of clips under one second is a gated measurement over a single 400 ms block, so the report also carries the momentary maximum. Measurements pad the clip with digital silence to 1.2 s, which the absolute gate ignores.

## Gates

| Gate | Status |
| --- | --- |
| Technical | SFX pass: full decode in Node and in Chromium 156 with exact frame counts, loop and mono checks, deterministic rebuild, hashes reconciled. Loudness deviations above are open. Music: no source, so nothing to check. |
| Creative | Pending. No cue has been auditioned by a person or in the live mix. |
| Rights | Cleared 2026-11-16 (D13): Paul confirms all his plans are paid with commercial use. The API reported the Starter plan the same day. |
| Owner | Pending. Nothing here records Paul's approval. |
