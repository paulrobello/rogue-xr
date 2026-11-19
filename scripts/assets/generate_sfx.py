"""Generate the slice SFX from assets-source/audio/sfx/prompts.json with ElevenLabs.

Usage: python3 -I scripts/assets/generate_sfx.py [--only id,id] [--retry id]

Sequential, one request per cue, never overwrites an existing source: a cue whose raw file exists
is skipped. `--retry id` is the only way to spend a second generation on a cue; the failed take is
kept as raw/<id>.attempt1.<ext> and the new take becomes the source. Every response is recorded
(request body, response headers, sha256, size, timestamp) in assets-source/audio/sfx/generation-log.json.
The API key is read from ~/.env and never printed or logged.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SFX_DIR = ROOT / "assets-source" / "audio" / "sfx"
RAW = SFX_DIR / "raw"
LOG = SFX_DIR / "generation-log.json"
SECRET_HEADERS = {"set-cookie", "authorization", "xi-api-key"}


def api_key() -> str:
    for path in (Path.home() / ".env", Path.home() / ".claude" / ".env"):
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            if line.startswith("ELEVENLABS_API_KEY="):
                return line.split("=", 1)[1].strip().strip("'\"")
    sys.exit("ELEVENLABS_API_KEY not found in ~/.env")


def request_audio(spec: dict, cue: dict, key: str) -> tuple[bytes, dict, int]:
    payload: dict = {
        "text": cue["text"],
        "model_id": spec["model_id"],
        "duration_seconds": cue["duration_seconds"],
        "prompt_influence": cue["prompt_influence"],
    }
    if cue.get("loop"):
        payload["loop"] = True
    url = f"{spec['endpoint']}?output_format={spec['output_format']}"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            audio = resp.read()
            headers = {k.lower(): v for k, v in resp.headers.items() if k.lower() not in SECRET_HEADERS}
            return audio, {"payload": payload, "headers": headers}, resp.status
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")[:500]
        sys.exit(f"HTTP {err.code} for {cue['id']}: {detail}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default="")
    parser.add_argument("--retry", default="")
    args = parser.parse_args()
    spec = json.loads((SFX_DIR / "prompts.json").read_text())
    log = json.loads(LOG.read_text()) if LOG.exists() else {"generations": []}
    wanted = {s for s in args.only.split(",") if s}
    retry = {s for s in args.retry.split(",") if s}
    key = api_key()
    RAW.mkdir(parents=True, exist_ok=True)
    for cue in spec["cues"]:
        if cue.get("local_edit"):
            continue
        cue_id = cue["id"]
        if wanted and cue_id not in wanted and cue_id not in retry:
            continue
        out = RAW / f"{cue_id}.mp3"
        attempt = 1
        if out.exists():
            if cue_id not in retry:
                print(f"skip {cue_id} (source exists)")
                continue
            attempt = 2
            out.rename(RAW / f"{cue_id}.attempt1.mp3")
        started = time.time()
        audio, record, status = request_audio(spec, cue, key)
        out.write_bytes(audio)
        entry = {
            "cue": cue_id,
            "attempt": attempt,
            "file": f"raw/{cue_id}.mp3",
            "http_status": status,
            "requested_at_unix": int(started),
            "elapsed_s": round(time.time() - started, 2),
            "bytes": len(audio),
            "sha256": hashlib.sha256(audio).hexdigest(),
            **record,
        }
        log["generations"].append(entry)
        LOG.write_text(json.dumps(log, indent=2) + "\n")
        print(f"ok {cue_id} attempt={attempt} {len(audio)} bytes")


if __name__ == "__main__":
    main()
