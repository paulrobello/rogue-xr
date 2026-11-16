"""Generates P5-T5 card illustrations, layers, cutouts and frames through the Higgsfield CLI.

Usage: python3 -I assets-source/cards/gen_cards.py <stage> [--only key,key] [--workers 8] [--dry-run]

Stages (each reads the picks recorded in selection.json):
  frames-attack    2 attack frame candidates (2:3)
  frames-recolour  2 skill and 2 sigil frame candidates, edits of the picked attack frame
  keys             2 composite key candidates per card (1:1)
  layers           back, mid and front layers decomposed from each card's picked key
  regen            one regeneration round: <card>-<layer>-r1 from each card's `regen` prompts
  cutouts          image_background_remover on each picked mid and front layer (selection `layers`)

Downloads are untouched originals. Every finished job is appended to provenance.json beside this
file with its prompt, input files and sha256, job id, receipt job_type, credit cost and rights note.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import subprocess
import sys
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = ROOT / "assets-source/cards"
SPEC = json.loads((HERE / "prompts-cards.json").read_text())
PROVENANCE = HERE / "provenance.json"
SELECTION = HERE / "selection.json"
UPLOADS = Path("/tmp/p5t5-uploads.json")
RIGHTS = (
    "Generated on Paul's paid Higgsfield plan. Higgsfield Terms of Use §4.4 (checked 2026-11-15): "
    "no ownership claim on inputs or outputs and no restriction on commercial use on any plan. "
    "Reference inputs are this project's own Higgsfield style boards and card art. No attribution required."
)
LOCK = threading.Lock()
TALLY = {"credits": 0, "jobs": 0}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def hf(*args: str) -> str:
    proc = subprocess.run(["higgsfield", *args], capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"higgsfield {args[:2]} exit {proc.returncode}: {proc.stdout[-600:]} {proc.stderr[-600:]}")
    return proc.stdout


def upload_id(path: Path) -> str:
    digest = sha256(path)
    with LOCK:
        cache = json.loads(UPLOADS.read_text()) if UPLOADS.exists() else {}
        if digest in cache:
            return cache[digest]
    uid = json.loads(hf("upload", "create", str(path), "--json"))["id"]
    with LOCK:
        cache = json.loads(UPLOADS.read_text()) if UPLOADS.exists() else {}
        cache[digest] = uid
        UPLOADS.write_text(json.dumps(cache, indent=2))
    return uid


def selection() -> dict:
    return json.loads(SELECTION.read_text()) if SELECTION.exists() else {"frames": {}, "cards": {}}


def load_provenance() -> list[dict]:
    return json.loads(PROVENANCE.read_text()) if PROVENANCE.exists() else []


def record(entry: dict) -> None:
    # Several stage runs may write at once, so the thread lock is backed by a cross-process flock.
    with LOCK, open("/tmp/p5t5-provenance.lock", "w") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        items = [e for e in load_provenance() if e["key"] != entry["key"]]
        items.append(entry)
        items.sort(key=lambda e: e["key"])
        PROVENANCE.write_text(json.dumps(items, indent=2, ensure_ascii=False) + "\n")


def card_jobs(stage: str) -> list[dict]:
    style = [ROOT / p for p in SPEC["styleRefs"]]
    picks = selection()
    jobs: list[dict] = []
    if stage == "frames-attack":
        for c in "ab":
            jobs.append({
                "key": f"frame-attack-{c}", "item": "frame:attack", "role": "frame-candidate",
                "out": HERE / f"frames/attack/frame-attack-{c}", "model": SPEC["model"], "aspect": "2:3",
                "prompt": SPEC["frames"]["attack"], "refs": style,
            })
    elif stage == "frames-recolour":
        base = HERE / f"frames/attack/frame-attack-{picks['frames']['attack']}.png"
        for family in ("skill", "sigil"):
            prompt = SPEC["frames"]["recolour"].format(**SPEC["frames"][family])
            for c in "ab":
                jobs.append({
                    "key": f"frame-{family}-{c}", "item": f"frame:{family}", "role": "frame-candidate",
                    "out": HERE / f"frames/{family}/frame-{family}-{c}", "model": SPEC["model"], "aspect": "2:3",
                    "prompt": prompt, "refs": [style[0], style[1], base],
                })
    for card in SPEC["cards"]:
        cid, fam = card["id"], SPEC["families"][card["type"]]
        if stage == "keys":
            prompt = f"{SPEC['keyPrefix']} {card['key']} The glow is {fam['glow']}. {SPEC['keySuffix']}"
            for c in "ab":
                jobs.append({
                    "key": f"{cid}-key-{c}", "item": cid, "role": "key-candidate",
                    "out": HERE / f"{cid}/{cid}-key-{c}", "model": SPEC["model"], "aspect": "1:1",
                    "prompt": prompt, "refs": style,
                })
        elif stage == "layers" and cid in picks["cards"]:
            key = HERE / f"{cid}/{cid}-key-{picks['cards'][cid]}.png"
            texts = {
                "back": f"Recreate only the deep background of the second reference illustration as a full square painting: {card['back']}.",
                "mid": f"Recreate only {card['mid']} from the second reference illustration, isolated on a flat pure {fam['key']} background ({fam['keyHex']}). Nothing else in the image.",
                "front": f"Recreate only {card['front']} from the second reference illustration, isolated on a flat pure {fam['key']} background ({fam['keyHex']}). Nothing else in the image.",
            }
            for layer, text in texts.items():
                jobs.append({
                    "key": f"{cid}-{layer}", "item": cid, "role": f"layer-{layer}",
                    "out": HERE / f"{cid}/{cid}-{layer}", "model": SPEC["model"], "aspect": "1:1",
                    "prompt": f"{SPEC['layerPrefix']} {text} {SPEC['layerSuffix']}", "refs": [style[0], key],
                })
        elif stage == "regen" and cid in picks["cards"]:
            key = HERE / f"{cid}/{cid}-key-{picks['cards'][cid]}.png"
            for layer, text in card.get("regen", {}).items():
                jobs.append({
                    "key": f"{cid}-{layer}-r1", "item": cid, "role": f"layer-{layer}-regen",
                    "out": HERE / f"{cid}/{cid}-{layer}-r1", "model": SPEC["model"], "aspect": "1:1",
                    "prompt": f"{SPEC['layerPrefix']} {text} {SPEC['layerSuffix']}", "refs": [style[0], key],
                })
        elif stage == "cutouts" and cid in picks["cards"]:
            prov = {e["key"]: e for e in load_provenance()}
            for layer in ("mid", "front"):
                # A layer pick is a suffix ("-r1") or, when it names another file, a full stem.
                pick = picks.get("layers", {}).get(f"{cid}-{layer}", "")
                stem = f"{cid}-{layer}{pick}" if pick == "" or pick.startswith("-") else pick
                src = prov.get(stem)
                if src is None:
                    continue
                jobs.append({
                    "key": f"{stem}.cutout", "item": cid, "role": f"cutout-{layer}",
                    "out": HERE / f"{cid}/{stem}.cutout", "model": "image_background_remover",
                    "source": src,
                })
    return jobs


def media_args(job: dict) -> tuple[list[str], list[dict]]:
    if "source" in job:
        src = job["source"]
        return ["--image", src["jobId"]], [{"path": src["file"], "sha256": src["sha256"], "jobId": src["jobId"]}]
    args, inputs = [], []
    for ref in job["refs"]:
        uid = upload_id(ref)
        args += ["--image", uid]
        inputs.append({"path": str(ref.relative_to(ROOT)), "sha256": sha256(ref), "uploadId": uid})
    return args, inputs


def params(job: dict) -> list[str]:
    if job["model"] == "image_background_remover":
        return []
    return ["--prompt", job["prompt"], "--aspect-ratio", job["aspect"], "--resolution", SPEC["resolution"]]


def run(job: dict, cost: int) -> str:
    media, inputs = media_args(job)
    job_id = json.loads(hf("generate", "create", job["model"], *params(job), *media, "--json"))[0]
    with LOCK:
        TALLY["credits"] += cost
        TALLY["jobs"] += 1
        print(f"submitted {job['key']} {job_id} (+{cost}, running {TALLY['credits']} credits)", flush=True)
    proc = subprocess.run(
        ["higgsfield", "generate", "wait", job_id, "--timeout", "15m", "--json"], capture_output=True, text=True
    )
    result = json.loads(proc.stdout) if proc.stdout.strip().startswith("{") else {}
    if proc.returncode != 0 or result.get("status") != "completed":
        raise RuntimeError(f"{job['key']} {job_id}: exit {proc.returncode} {proc.stdout[-400:]} {proc.stderr[-400:]}")
    if result.get("job_type") != job["model"]:
        raise RuntimeError(f"{job['key']} {job_id}: receipt job_type {result.get('job_type')} != {job['model']}")
    url = result["result_url"]
    ext = url.split("?")[0].rsplit(".", 1)[-1].lower()
    out = job["out"].parent / f"{job['out'].name}.{ext}"  # not with_suffix: stems contain ".cutout"
    out.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=120) as resp:
        out.write_bytes(resp.read())
    entry = {
        "key": job["key"], "item": job["item"], "role": job["role"], "file": str(out.relative_to(ROOT)),
        "provider": "higgsfield", "model": job["model"], "receiptJobType": result["job_type"],
        "jobId": job_id, "settings": dict(result.get("params", {})),
        "prompt": job.get("prompt"), "inputs": inputs, "costCredits": cost,
        "sha256": sha256(out), "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "rights": RIGHTS,
    }
    entry["settings"].pop("prompt", None)
    entry["settings"].pop("image_references", None)
    entry["settings"].pop("input_images", None)
    record(entry)
    return f"ok {job['key']} -> {out.relative_to(ROOT)}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["frames-attack", "frames-recolour", "keys", "layers", "regen", "cutouts"])
    ap.add_argument("--only")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    jobs = card_jobs(args.stage)
    if args.only:
        keep = set(args.only.split(","))
        jobs = [j for j in jobs if j["key"] in keep or j["item"] in keep]
    done = {e["key"] for e in load_provenance()}
    jobs = [j for j in jobs if j["key"] not in done]
    if not jobs:
        print("nothing to do")
        return
    probe = jobs[0]
    media, _ = media_args(probe)
    cost = int(json.loads(hf("generate", "cost", probe["model"], *params(probe), *media, "--json"))["credits"])
    print(f"{args.stage}: {len(jobs)} jobs at {cost} credits each = {cost * len(jobs)} credits (preflight)")
    if args.dry_run:
        for j in jobs:
            print(j["key"], "|", j.get("prompt", "")[:160])
        return
    failures = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for fut in [pool.submit(run, j, cost) for j in jobs]:
            try:
                print(fut.result(), flush=True)
            except Exception as exc:  # noqa: BLE001 - report every failed job, keep the rest
                failures += 1
                print(f"FAIL {exc}", flush=True)
    print(f"stage {args.stage}: {TALLY['jobs']} submitted, {TALLY['credits']} credits charged, {failures} failed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
