# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = ["pillow>=11", "rembg[cpu]>=2.0.60"]
# ///
"""
3D models for every asset type: the generate_icons.py images → TRELLIS.2 on the team GPU box → web GLBs.

    uv run tools/art/generate_models.py [type ...]

1. Cuts the raw images (tools/art/out/raw/) out at full resolution (tools/art/out/cutout/).
2. Uploads them to the GPU box and runs ~/trellis2/run.py there, detached, so a dropped SSH connection
   doesn't kill it. run.py skips types that already have a model and carries on past failures.
3. Downloads the GLBs and previews to tools/art/out/models/ and writes web versions
   (512 px WebP textures, simplified, meshopt) to website/public/art/models/.

Every step skips work that is already done, so rerun it to pick up new images or retry failures.
The GPU box setup (TRELLIS.2 for an RTX 5090) is ~/trellis2/install.sh on that machine.
"""

import subprocess
import sys
import time
from pathlib import Path

from PIL import Image

TOOLS = Path(__file__).parent
REPO = TOOLS.parent.parent
RAW = TOOLS / "out" / "raw"
CUTOUT = TOOLS / "out" / "cutout"
MODELS = TOOLS / "out" / "models"
WEB = REPO / "website" / "public" / "art" / "models"

HOST = ["-p", "2222", "pancho@100.104.189.71"]  # gpu-sandbox over Tailscale
SCP_HOST = ["-P", "2222"], "pancho@100.104.189.71"
REMOTE = "~/trellis2"
POLL_SECONDS = 30


def ssh(command: str, check: bool = True) -> str:
    result = subprocess.run(["ssh", "-o", "BatchMode=yes", *HOST, command], capture_output=True, text=True)
    if check and result.returncode != 0:
        sys.exit(f"ssh failed: {command}\n{result.stderr}")
    return result.stdout


def scp(sources: list[str], target: str) -> None:
    flags, host = SCP_HOST
    subprocess.run(["scp", "-q", *flags, *sources, target.replace("REMOTE:", f"{host}:")], check=True)


def cut_out(names: list[str]) -> None:
    from rembg import new_session, remove

    todo = [n for n in names if not (CUTOUT / f"{n}.png").exists()]
    if not todo:
        return
    CUTOUT.mkdir(parents=True, exist_ok=True)
    session = new_session("isnet-general-use")
    for name in todo:
        print(f"cut out {name}", flush=True)
        remove(Image.open(RAW / f"{name}.png").convert("RGB"), session=session).save(CUTOUT / f"{name}.png")


def run_remote(names: list[str]) -> None:
    done = set(ssh(f"ls {REMOTE}/outputs 2>/dev/null").split())
    todo = [n for n in names if f"{n}.glb" not in done]
    if not todo:
        return
    ssh(f"mkdir -p {REMOTE}/inputs {REMOTE}/outputs")
    scp([str(CUTOUT / f"{n}.png") for n in todo], f"REMOTE:{REMOTE}/inputs/")
    busy = ssh("nvidia-smi --query-compute-apps=pid --format=csv,noheader").strip()
    if busy:
        print(f"note: GPU already has jobs running ({busy.replace(chr(10), ', ')})", flush=True)
    inputs = " ".join(f"inputs/{n}.png" for n in todo)
    ssh(f"cd {REMOTE} && setsid nohup .venv/bin/python run.py {inputs} > batch.log 2>&1 < /dev/null & echo $! > {REMOTE}/batch.pid")
    print(f"TRELLIS running on {len(todo)} types…", flush=True)
    reported: set[str] = set()
    while ssh(f"kill -0 $(cat {REMOTE}/batch.pid) 2>/dev/null && echo alive", check=False).strip() == "alive":
        time.sleep(POLL_SECONDS)
        for line in ssh(f"grep -E '^[a-z0-9_]+: [0-9]+ s|^FAILED' {REMOTE}/batch.log", check=False).splitlines():
            if line not in reported:
                reported.add(line)
                print(f"  {line}", flush=True)
    print(ssh(f"grep -E '^FAILED|Traceback|Error' {REMOTE}/batch.log | tail -5", check=False), end="")


def download_and_optimize(names: list[str]) -> None:
    MODELS.mkdir(parents=True, exist_ok=True)
    WEB.mkdir(parents=True, exist_ok=True)
    remote = set(ssh(f"ls {REMOTE}/outputs").split())
    fetch = [f"{n}{suffix}" for n in names for suffix in (".glb", "_preview.png")
             if f"{n}{suffix}" in remote and not (MODELS / f"{n}{suffix}").exists()]
    if fetch:
        flags, host = SCP_HOST
        subprocess.run(["scp", "-q", *flags, *[f"{host}:{REMOTE}/outputs/{f}" for f in fetch], str(MODELS)], check=True)
    for name in names:
        source, target = MODELS / f"{name}.glb", WEB / f"{name}.glb"
        if source.exists() and not target.exists():
            subprocess.run(["npx", "--yes", "@gltf-transform/cli", "optimize", str(source), str(target),
                            "--texture-compress", "webp", "--texture-size", "512",
                            "--simplify-ratio", "0.35", "--simplify-error", "0.002", "--compress", "meshopt"],
                           check=True, capture_output=True)
            print(f"web model {name} ({target.stat().st_size // 1024} KB)", flush=True)


def main() -> None:
    names = sys.argv[1:] or sorted(p.stem for p in RAW.glob("*.png"))
    missing = [n for n in names if not (RAW / f"{n}.png").exists()]
    if missing:
        sys.exit(f"No raw image (run generate_icons.py first): {', '.join(missing)}")
    cut_out(names)
    run_remote(names)
    download_and_optimize(names)
    print(f"{len(list(WEB.glob('*.glb')))} web models in {WEB.relative_to(REPO)}")


if __name__ == "__main__":
    main()
