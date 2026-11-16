"""Deterministic audio mastering for Clockwork Spire (P5-T8).

Usage: python3 -I scripts/assets/build_audio.py [--only id,id] [--out DIR] [--music-src DIR]
                                                 [--derived DIR] [--no-provenance]

Sources are immutable (assets-source/audio/sfx/raw/*.mp3, assets-source/audio/music/*.wav).
For each cue: decode to 48 kHz float, trim leading and trailing silence, fade the edges, fold
positional cues to mono, apply ONE linear gain toward the loudness target limited by the true-peak
ceiling, write a lossless float WAV intermediate, encode Ogg Opus, then decode the Opus file and
measure that (integrated LUFS, true peak, momentary max, duration, frames). If the lossy encode
overshoots the ceiling the gain is reduced by the measured overshoot and the encode repeated.
Nothing uses loudnorm, so the build never silently switches to a dynamic ride.

Targets (PRD slice proposal, newly defined here): SFX -16 LUFS integrated, music -18 LUFS, true
peak at most -1.0 dBTP. A cue whose crest factor cannot reach its loudness target under the peak
ceiling is mastered to the ceiling and reported as a deviation, never retargeted.

Music is optional: a cue with no source WAV is skipped (the runtime plays its fallback cue or
silence). The cue list and each cue's loop flag come from assets-source/audio/music/cues.json.
Loops get an equal-power tail-over-head crossfade that retains the start sample position, so the
wrap rejoins the correct material. One-shots are cut to optional start_s/end_s, trimmed of
silence and given a short raised-cosine fade out, so their natural ending is kept.

Outputs: public/assets/audio/{sfx,music}/<id>.ogg, public/assets/audio/report.json,
assets-source/audio/provenance.json, assets-source/audio/derived/<id>.wav (lossless intermediates).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]


def repo_relative(output: bytes) -> str:
    """Tool output with the checkout's absolute path removed, so reports carry no machine paths."""
    return output.decode().strip().replace(f"{ROOT}/", "")
AUDIO_SRC = ROOT / "assets-source" / "audio"
SR = 48000
SFX_LUFS = -16.0
MUSIC_LUFS = -18.0
TRUE_PEAK_CEILING = -1.0
LOUDNESS_TOLERANCE_LU = 1.0
# p99.9 is a noisy estimator and Opus re-quantizes the edges, so a wrap step up to 1.25x of it passes.
# The strict ratio is still reported, and check-audio-loops.py applies its own strict rule.
SEAM_RATIO_LIMIT = 1.25
MONO_CANCELLATION_LIMIT_DB = 1.5
SIDE_SCALES = (1.0, 0.7, 0.5, 0.35, 0.0)
SILENCE_BELOW_PEAK_DB = -50.0
SILENCE_ABS_FLOOR = 10 ** (-80 / 20)


def silence_floor(x: np.ndarray) -> float:
    """Samples below this are silence: 50 dB under the clip's own peak, never above -80 dBFS."""
    return max(float(np.abs(x).max()) * 10 ** (SILENCE_BELOW_PEAK_DB / 20), SILENCE_ABS_FLOOR)
SHORT_CLIP_S = 1.0
MUSIC_CUES_FILE = AUDIO_SRC / "music" / "cues.json"
ONE_SHOT_FADE_OUT_S = 0.25


def music_cues() -> list[dict]:
    """The music cue list (id, loop flag, ...) in first-heard order, shared with the runtime registry."""
    return json.loads(MUSIC_CUES_FILE.read_text())["cues"]
OPUS_KBPS = {"sfx-mono": 64, "sfx-stereo": 96, "music": 128}
SKILL_SCRIPTS = Path.home() / ".claude" / "skills" / "create-game-audio-assets" / "scripts"

FFMPEG = "ffmpeg"


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, **kw)


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def decode(path: Path, channels: int = 2) -> np.ndarray:
    """Decode any file to float32 (frames, channels) at 48 kHz."""
    proc = run([FFMPEG, "-nostdin", "-v", "error", "-i", str(path), "-f", "f32le",
                "-ar", str(SR), "-ac", str(channels), "-"])
    if proc.returncode != 0:
        raise SystemExit(f"decode failed for {path}: {proc.stderr.decode()}")
    return np.frombuffer(proc.stdout, dtype="<f4").reshape(-1, channels).copy()


def probe(path: Path) -> dict:
    proc = run(["ffprobe", "-v", "error", "-show_entries",
                "stream=codec_name,sample_rate,channels:format=duration", "-of", "json", str(path)])
    info = json.loads(proc.stdout)
    stream = info["streams"][0]
    return {
        "codec": stream["codec_name"],
        "sample_rate": int(stream["sample_rate"]),
        "channels": int(stream["channels"]),
        "duration_s": round(float(info["format"]["duration"]), 4),
    }


def write_wav_f32(path: Path, data: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    proc = run([FFMPEG, "-nostdin", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR),
                "-ac", str(data.shape[1]), "-i", "-", "-c:a", "pcm_f32le", "-fflags", "+bitexact",
                "-flags:a", "+bitexact", str(path)], input=data.astype("<f4").tobytes())
    if proc.returncode != 0:
        raise SystemExit(f"wav write failed: {proc.stderr.decode()}")


def encode_opus(src_wav: Path, dest: Path, kbps: int) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    proc = run([FFMPEG, "-nostdin", "-v", "error", "-y", "-i", str(src_wav), "-c:a", "libopus",
                "-b:a", f"{kbps}k", "-vbr", "on", "-application", "audio", "-ar", str(SR),
                "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact",
                "-f", "ogg", str(dest)])
    if proc.returncode != 0:
        raise SystemExit(f"opus encode failed: {proc.stderr.decode()}")


def measure(path: Path) -> dict:
    """EBU R128 measurement of a decoded file: integrated, true peak, momentary max."""
    # Digital silence is excluded by the absolute gate, so padding to 1.2 s lets a clip shorter
    # than one 400 ms block report a finite integrated value.
    proc = run([FFMPEG, "-nostdin", "-nostats", "-i", str(path), "-af",
                "apad=whole_dur=1.2,ebur128=peak=true", "-f", "null", "-"])
    text = proc.stderr.decode()
    summary = text[text.rfind("Summary:"):]
    integrated = float(re.search(r"I:\s+(-?[\d.]+|-inf) LUFS", summary).group(1)) if "Summary" in text else float("nan")
    peak_match = re.search(r"Peak:\s+(-?[\d.]+|-inf) dBFS", summary)
    true_peak = float(peak_match.group(1)) if peak_match else float("nan")
    momentary = [float(m) for m in re.findall(r"\bM:\s*(-?\d+\.\d+)", text)]
    return {
        "integrated_lufs": round(integrated, 2),
        "true_peak_dbtp": round(true_peak, 2),
        "momentary_max_lufs": round(max(momentary), 2) if momentary else None,
    }


def trim_silence(x: np.ndarray) -> tuple[np.ndarray, dict]:
    level = np.abs(x).max(axis=1)
    loud = np.flatnonzero(level > silence_floor(x))
    if loud.size == 0:
        return x, {"trimmed_head_ms": 0.0, "trimmed_tail_ms": 0.0}
    head = max(0, int(loud[0]) - int(0.005 * SR))
    tail = min(len(x), int(loud[-1]) + 1 + int(0.010 * SR))
    return x[head:tail], {
        "trimmed_head_ms": round(head / SR * 1000, 1),
        "trimmed_tail_ms": round((len(x) - tail) / SR * 1000, 1),
    }


def fade_edges(x: np.ndarray, fade_in_s: float, fade_out_s: float) -> np.ndarray:
    x = x.copy()
    n_in = min(len(x) // 2, int(fade_in_s * SR))
    n_out = min(len(x) // 2, int(fade_out_s * SR))
    if n_in:
        x[:n_in] *= (0.5 - 0.5 * np.cos(np.linspace(0, np.pi, n_in)))[:, None]
    if n_out:
        x[-n_out:] *= (0.5 + 0.5 * np.cos(np.linspace(0, np.pi, n_out)))[:, None]
    return x


def fold_mono(x: np.ndarray) -> np.ndarray:
    if x.shape[1] == 1:
        return x
    return (0.5 * x[:, :1] + 0.5 * x[:, 1:2]).astype(np.float32)


def mono_cancellation_db(x: np.ndarray) -> float:
    """Power lost when a stereo cue is summed to one speaker; 0 for identical channels."""
    stereo = float(np.mean(x.astype(np.float64) ** 2) * 2)
    fold = float(np.mean(((x[:, 0] + x[:, 1]) / 2).astype(np.float64) ** 2) * 2)
    return 10 * np.log10(stereo / fold) if fold > 0 and stereo > 0 else 0.0


def narrow_side(x: np.ndarray, scale: float) -> np.ndarray:
    mid, side = (x[:, :1] + x[:, 1:2]) / 2, (x[:, :1] - x[:, 1:2]) / 2
    return np.concatenate([mid + side * scale, mid - side * scale], axis=1).astype(np.float32)


def window_db(x: np.ndarray, start: int, n: int) -> float:
    seg = x[start:start + n]
    rms = float(np.sqrt(np.mean(seg.astype(np.float64) ** 2))) if len(seg) else 0.0
    return 20 * np.log10(rms) if rms > 0 else -120.0


def loop_metrics(x: np.ndarray) -> dict:
    """Wrap step against the loop's own sample-to-sample motion, head/tail level, interior dropouts."""
    mono = x.mean(axis=1) if x.ndim == 2 else x
    steps = np.abs(np.diff(mono))
    seam = float(abs(mono[0] - mono[-1]))
    p999 = float(np.quantile(steps, 0.999)) if len(steps) else 0.0
    win = int(0.1 * SR)
    levels = np.array([window_db(mono, s, win) for s in range(0, len(mono) - win + 1, win)])
    edge = 5
    head, tail = float(levels[:edge].max()), float(levels[-edge:].max())
    peak = float(levels.max())
    interior = levels[edge:-edge]
    dropouts = int(np.sum(interior - peak < -24.0)) if len(interior) else 0
    return {
        "wrap_step": round(seam, 6),
        "p999_step": round(p999, 6),
        "seam_ratio": round(seam / p999, 3) if p999 > 0 else 0.0,
        "head_tail_level_diff_db": round(abs(head - tail), 2),
        "interior_dropout_windows": dropouts,
        "pass": bool((p999 == 0 or seam <= SEAM_RATIO_LIMIT * p999) and abs(head - tail) <= 6.0 and dropouts == 0),
    }


def crossfade_loop(x: np.ndarray, start: int, end: int | None, xf: int) -> np.ndarray:
    """Loop body x[start:end] whose head is blended with the material that follows `end`.

    out[:xf] = head*fade_in + x[end:end+xf]*fade_out, so out[-1] -> out[0] continues x[end-1] ->
    x[end] and the loop restarts at the retained start position.
    """
    end = len(x) - xf if end is None else end
    if end + xf > len(x) or end - start <= 2 * xf:
        raise SystemExit("loop crossfade needs material after the loop end")
    body = x[start:end].copy()
    t = np.linspace(0.0, 1.0, xf, endpoint=False)[:, None]
    body[:xf] = body[:xf] * np.sin(t * np.pi / 2) + x[end:end + xf] * np.cos(t * np.pi / 2)
    return body


def solve_gain(measured: dict, target: float) -> float:
    return min(target - measured["integrated_lufs"], TRUE_PEAK_CEILING - measured["true_peak_dbtp"])


def master_and_encode(
    name: str, clip: np.ndarray, kind: str, target: float, derived: Path, dest: Path
) -> dict:
    """Linear gain toward `target`, capped by the ceiling, then measured on the decoded Opus file."""
    channels_kind = "music" if kind == "music" else ("sfx-mono" if clip.shape[1] == 1 else "sfx-stereo")
    flat = derived / f"{name}.pre-gain.wav"
    write_wav_f32(flat, clip)
    pre = measure(flat)
    flat.unlink()
    gain_db = solve_gain(pre, target)
    decoded: np.ndarray | None = None
    final: dict = {}
    for attempt in range(1, 6):
        mastered = (clip * np.float32(10 ** (gain_db / 20))).astype(np.float32)
        wav = derived / f"{name}.wav"
        write_wav_f32(wav, mastered)
        encode_opus(wav, dest, OPUS_KBPS[channels_kind])
        final = measure(dest)
        over = final["true_peak_dbtp"] - TRUE_PEAK_CEILING
        if over <= 0.0:
            break
        gain_db -= over + 0.05
    decoded = decode(dest, clip.shape[1])
    capped = (target - pre["integrated_lufs"]) > (TRUE_PEAK_CEILING - pre["true_peak_dbtp"]) + 1e-6
    deviation = round(final["integrated_lufs"] - target, 2)
    return {
        "intermediate_wav": rel(wav),
        "intermediate_sha256": sha256_file(wav),
        "pre_gain": pre,
        "gain_db": round(gain_db, 2),
        "encode_attempts": attempt,
        "opus_kbps": OPUS_KBPS[channels_kind],
        "measured": final,
        "target_lufs": target,
        "deviation_lu": deviation,
        "loudness_status": "met" if abs(deviation) <= LOUDNESS_TOLERANCE_LU else "deviation",
        "limited_by_true_peak": bool(capped),
        "short_clip_lufs_unreliable": bool(len(decoded) / SR < SHORT_CLIP_S),
        "decoded_frames": int(len(decoded)),
        "decoded_duration_s": round(len(decoded) / SR, 4),
        "decoded_pcm_sha256": sha256_bytes(decoded.astype("<f4").tobytes()),
        "decoded": decoded,
    }


def external_checks(files: list[Path], loops: list[Path], stereo: list[Path]) -> dict:
    out: dict = {}
    loop_script = SKILL_SCRIPTS / "check-audio-loops.py"
    mono_script = SKILL_SCRIPTS / "check-mono-compatibility.py"
    if loops and loop_script.exists():
        proc = run([sys.executable, "-I", str(loop_script), *map(str, loops)])
        out["check-audio-loops"] = {"exit": proc.returncode, "stdout": repo_relative(proc.stdout)}
    if stereo and mono_script.exists():
        proc = run([sys.executable, "-I", str(mono_script), *map(str, stereo)])
        out["check-mono-compatibility"] = {"exit": proc.returncode, "stdout": repo_relative(proc.stdout)}
    return out


def build_sfx(spec: dict, only: set[str], derived: Path, out: Path) -> dict[str, dict]:
    results: dict[str, dict] = {}
    for cue in spec["cues"]:
        cid = cue["id"]
        if only and cid not in only:
            continue
        src = AUDIO_SRC / "sfx" / "raw" / f"{cid}.mp3"
        steps: list[str] = []
        clip = decode(src, 2)
        loop_info = None
        if cue["loop"]:
            native = loop_metrics(clip)
            loop_info = {"source": native}
            if not native["pass"]:
                xf = int(0.30 * SR)
                clip = crossfade_loop(clip, 0, None, xf)
                steps.append("equal-power tail-over-head crossfade 300 ms (source wrap failed)")
            else:
                steps.append("loop kept native: source wrap passed")
            trim = {"trimmed_head_ms": 0.0, "trimmed_tail_ms": 0.0}
        else:
            clip, trim = trim_silence(clip)
            steps.append("trim silence more than 50 dB under the clip peak (5 ms head pre-roll, 10 ms tail pad)")
            fade_out = min(0.03, len(clip) / SR * 0.1)
            clip = fade_edges(clip, 0.002, fade_out)
            steps.append(f"fade in 2 ms, fade out {fade_out * 1000:.0f} ms (raised cosine)")
        if cue["class"] == "positional":
            clip = fold_mono(clip)
            steps.append("fold to mono 0.5*L+0.5*R (positional cue)")
        else:
            before = mono_cancellation_db(clip)
            for scale in SIDE_SCALES:
                if mono_cancellation_db(narrow_side(clip, scale)) < MONO_CANCELLATION_LIMIT_DB:
                    break
            if scale != 1.0:
                clip = narrow_side(clip, scale)
                steps.append(f"side channel x{scale} (mono cancellation {before:.1f} dB before, "
                             f"{mono_cancellation_db(clip):.1f} dB after)")
        dest = out / "sfx" / f"{cid}.ogg"
        result = master_and_encode(cid, clip, "sfx", SFX_LUFS, derived, dest)
        decoded = result.pop("decoded")
        if cue["loop"]:
            loop_info["runtime"] = loop_metrics(decoded)
            result["loop"] = loop_info
        result.update({
            "id": cid,
            "class": cue["class"],
            "source_file": rel(src),
            "source_sha256": sha256_file(src),
            "source_probe": probe(src),
            "trim": trim,
            "steps": steps,
            "runtime_file": rel(dest),
            "runtime_sha256": sha256_file(dest),
            "runtime_bytes": dest.stat().st_size,
            "runtime_probe": probe(dest),
        })
        results[cid] = result
        print(f"sfx {cid}: {result['measured']['integrated_lufs']} LUFS, "
              f"{result['measured']['true_peak_dbtp']} dBTP ({result['loudness_status']})")
    return results


def build_music(music_src: Path, only: set[str], derived: Path, out: Path) -> dict[str, dict]:
    results: dict[str, dict] = {}
    loops_cfg_path = music_src / "loops.json"
    loops_cfg = json.loads(loops_cfg_path.read_text()) if loops_cfg_path.exists() else {}
    for cue in music_cues():
        mid = cue["id"]
        if only and mid not in only:
            continue
        candidates = sorted(music_src.glob(f"{mid}.*"))
        src = next((p for p in candidates if p.suffix.lower() in {".wav", ".flac", ".mp3"}), None)
        if src is None:
            print(f"music {mid}: no source in {music_src}, skipped (runtime plays silence)")
            continue
        cfg = loops_cfg.get(mid, {})
        clip = decode(src, 2)
        steps: list[str] = []
        if cue["loop"]:
            loud = np.flatnonzero(np.abs(clip).max(axis=1) > silence_floor(clip))
            start = int(cfg.get("loop_start_s", loud[0] / SR if loud.size else 0.0) * SR)
            end = int(cfg["loop_end_s"] * SR) if "loop_end_s" in cfg else None
            xf = int(cfg.get("crossfade_s", 2.0) * SR)
            source_metrics = loop_metrics(clip)
            clip = crossfade_loop(clip, start, end, xf)
            steps.append(
                f"loop body from {start / SR:.3f}s, {xf / SR:.2f}s equal-power tail-over-head crossfade, "
                "start position retained"
            )
        else:
            cut_start = int(cfg.get("start_s", 0.0) * SR)
            cut_end = int(cfg["end_s"] * SR) if "end_s" in cfg else len(clip)
            clip, trim = trim_silence(clip[cut_start:cut_end])
            fade_out_s = float(cfg.get("fade_out_s", ONE_SHOT_FADE_OUT_S))
            clip = fade_edges(clip, 0.002, fade_out_s)
            steps.append(
                f"one-shot cut {cut_start / SR:.3f}s..{cut_end / SR:.3f}s, silence trimmed "
                f"(head {trim['trimmed_head_ms']} ms, tail {trim['trimmed_tail_ms']} ms), "
                f"2 ms fade in, {fade_out_s:.2f}s raised-cosine fade out"
            )
        dest = out / "music" / f"{mid}.ogg"
        result = master_and_encode(mid, clip, "music", MUSIC_LUFS, derived, dest)
        decoded = result.pop("decoded")
        if cue["loop"]:
            shape = {"loop": {"source": source_metrics, "runtime": loop_metrics(decoded),
                              "loop_start_s": start / SR, "crossfade_s": xf / SR}}
        else:
            shape = {"one_shot": {"cut_start_s": cut_start / SR, "cut_end_s": cut_end / SR,
                                  "trim": trim, "fade_out_s": fade_out_s}}
        result.update({
            "id": mid,
            "source_file": rel(src),
            "source_sha256": sha256_file(src),
            "source_probe": probe(src),
            **shape,
            "steps": steps,
            "runtime_file": rel(dest),
            "runtime_sha256": sha256_file(dest),
            "runtime_bytes": dest.stat().st_size,
            "runtime_probe": probe(dest),
        })
        results[mid] = result
        shape_note = f"loop pass={result['loop']['runtime']['pass']}" if cue["loop"] else "one-shot"
        print(f"music {mid}: {result['measured']['integrated_lufs']} LUFS, "
              f"{result['measured']['true_peak_dbtp']} dBTP, {shape_note}")
    return results


def tool_versions() -> dict:
    ff = run([FFMPEG, "-version"]).stdout.decode().splitlines()[0]
    opus = run([FFMPEG, "-hide_banner", "-encoders"]).stdout.decode()
    return {"ffmpeg": ff, "libopus_encoder": "libopus" in opus, "numpy": np.__version__,
            "python": sys.version.split()[0]}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default="")
    parser.add_argument("--out", default=str(ROOT / "public" / "assets" / "audio"))
    parser.add_argument("--music-src", default=str(AUDIO_SRC / "music"))
    parser.add_argument("--derived", default=str(AUDIO_SRC / "derived"))
    parser.add_argument("--no-provenance", action="store_true")
    args = parser.parse_args()
    if shutil.which(FFMPEG) is None:
        raise SystemExit("ffmpeg not found on PATH")
    only = {s for s in args.only.split(",") if s}
    out, derived = Path(args.out), Path(args.derived)
    out.mkdir(parents=True, exist_ok=True)
    derived.mkdir(parents=True, exist_ok=True)

    spec = json.loads((AUDIO_SRC / "sfx" / "prompts.json").read_text())
    sfx = build_sfx(spec, only, derived, out)
    music = build_music(Path(args.music_src), only, derived, out)

    loops = [out / "sfx" / f"{k}.ogg" for k, v in sfx.items() if "loop" in v]
    loops += [out / "music" / f"{k}.ogg" for k, v in music.items() if "loop" in v]
    stereo = [out / "sfx" / f"{k}.ogg" for k, v in sfx.items() if v["runtime_probe"]["channels"] == 2]
    report = {
        "tools": tool_versions(),
        "targets": {"sfx_lufs": SFX_LUFS, "music_lufs": MUSIC_LUFS, "true_peak_dbtp_max": TRUE_PEAK_CEILING,
                    "loudness_tolerance_lu": LOUDNESS_TOLERANCE_LU, "sample_rate": SR,
                    "container": "ogg", "codec": "opus"},
        "sfx": sfx,
        "music": music,
        "music_status": "present" if music else "absent: runtime plays silence",
        "external_checks": external_checks(sorted(set(loops + stereo)), loops, stereo),
    }
    (out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    if not args.no_provenance:
        log_path = AUDIO_SRC / "sfx" / "generation-log.json"
        generations = json.loads(log_path.read_text())["generations"] if log_path.exists() else []
        provenance = {
            "rights": {
                "provider": "ElevenLabs Sound Effects (eleven_text_to_sound_v2)",
                "plan_reported_by_api": "starter (GET /v1/user/subscription, 2026-11-16)",
                "claim": "Output generated under a paid plan, commercial use intended.",
                "status": "cleared: owner confirms every account plan is paid and covers commercial use",
                "ownerStatement": "Paul, 2026-11-16, in the rogue-xr session: \"D13 all my plans are paid with commercial use\"",
            },
            "approvals": {"technical": "see report.json", "creative": "pending", "rights": "approved (D13)",
                          "owner": "pending"},
            "prompts_file": "assets-source/audio/sfx/prompts.json",
            "generation_log": "assets-source/audio/sfx/generation-log.json",
            "generations": generations,
            "sfx": {k: {key: v[key] for key in ("source_file", "source_sha256", "runtime_file",
                                                "runtime_sha256", "runtime_bytes", "steps")}
                    for k, v in sfx.items()},
            "music": {k: {key: v[key] for key in ("source_file", "source_sha256", "runtime_file",
                                                  "runtime_sha256", "runtime_bytes", "steps")}
                      for k, v in music.items()},
            "music_note": "Suno is owner-generated; see assets-source/audio/music/SUNO-HANDOFF.md",
        }
        music_log = Path(args.music_src) / "generation-log.json"
        if music and music_log.exists():
            provenance["music_source"] = json.loads(music_log.read_text())["source"]
            provenance["music_generation_log"] = rel(music_log)
        (AUDIO_SRC / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    print(f"wrote {out / 'report.json'}")


if __name__ == "__main__":
    main()
