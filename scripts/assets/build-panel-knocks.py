"""Render the two original Upper Works knock cues with a reproducible impact exciter."""
from array import array
import hashlib
import json
import math
from pathlib import Path
import random
import subprocess
import tempfile
import wave

ROOT = Path(__file__).resolve().parents[2]
RATE = 48_000
RUNTIME = ROOT / "public/assets/audio/sfx"
SOURCE = ROOT / "assets-source/audio/panel-knocks"


def level(samples: list[float]) -> float:
    return 10 * math.log10(max(1e-12, sum(x * x for x in samples) / len(samples)))


def strike(hollow: bool) -> list[float]:
    modes = ([(167, .21, .62), (261, .14, .40), (427, .085, .31), (801, .047, .23),
              (1411, .030, .13)] if hollow else
             [(572, .038, .28), (1037, .033, .55), (1591, .024, .30), (2377, .017, .20)])
    rng = random.Random(4197)
    count = round(RATE * (.58 if hollow else .26))
    samples = []
    previous_noise = 0.
    for i in range(count):
        t = i / RATE
        noise = rng.uniform(-1, 1)
        transient = (noise - previous_noise * .70) * math.exp(-t / .0038)
        previous_noise = noise
        response = sum(gain * math.exp(-t / decay) * math.sin(math.tau * freq * t)
                       for freq, decay, gain in modes)
        samples.append((1 - math.exp(-t / .00042)) * (response + .52 * transient))
    if hollow:
        original = samples[:]
        for delay, gain in [(.023, .18), (.046, -.08)]:
            offset = round(delay * RATE)
            for i in range(offset, count):
                samples[i] += gain * original[i - offset]
    gain = min(10 ** ((-16.5 - level(samples[:RATE // 20])) / 20),
               .74 / max(abs(x) for x in samples))
    return [x * gain * min(1., (count - i) / (RATE * .016)) for i, x in enumerate(samples)]


def build(name: str, hollow: bool, directory: Path = RUNTIME) -> dict:
    samples = strike(hollow)
    directory.mkdir(parents=True, exist_ok=True)
    output = directory / (name + ".ogg")
    with tempfile.TemporaryDirectory() as folder:
        wav = Path(folder) / "impact.wav"
        with wave.open(str(wav), "wb") as stream:
            stream.setparams((1, 2, RATE, len(samples), "NONE", ""))
            stream.writeframes(array("h", (round(x * 32767) for x in samples)).tobytes())
        subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(wav),
                        "-c:a", "libopus", "-b:a", "64k", "-vbr", "on", "-application", "audio",
                        "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact",
                        "-f", "ogg", str(output)], check=True)
    data = subprocess.check_output(["ffmpeg", "-nostdin", "-v", "error", "-i", str(output),
                                    "-f", "f32le", "-ac", "1", "-ar", str(RATE), "-"])
    decoded = array("f")
    decoded.frombytes(data)
    peak = max(abs(x) for x in decoded)
    if peak >= .98:
        raise ValueError(f"Decoded {name} peak exceeds headroom")
    return {"id": name, "codec": "Opus", "channels": 1, "sampleRate": RATE,
            "seconds": round(len(decoded) / RATE, 4), "peakDbfs": round(20 * math.log10(peak), 2),
            "onsetRmsDbfs": round(level(decoded[:RATE // 20]), 2),
            "tailRmsDbfs": round(level(decoded[RATE // 8:RATE // 4]), 2),
            "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}


if __name__ == "__main__":
    RUNTIME.mkdir(parents=True, exist_ok=True)
    SOURCE.mkdir(parents=True, exist_ok=True)
    clips = [build("panel-solid", False), build("panel-hollow", True)]
    if abs(clips[0]["onsetRmsDbfs"] - clips[1]["onsetRmsDbfs"]) > 2 or clips[1]["tailRmsDbfs"] < clips[0]["tailRmsDbfs"] + 10:
        raise ValueError("Knocks must have comparable attacks and distinguishable tails")
    report = {"origin": "Original modal synthesis for Clockwork Spire", "license": "MIT",
              "generator": "scripts/assets/build-panel-knocks.py",
              "generatorSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "encoder": subprocess.check_output(["ffmpeg", "-version"], text=True).splitlines()[0],
              "clips": clips}
    (SOURCE / "manifest.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(clips))
