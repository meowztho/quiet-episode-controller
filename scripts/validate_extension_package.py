from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CHROMIUM = os.environ.get("CHROMIUM") or shutil.which("chromium") or shutil.which("chromium-browser")

if not CHROMIUM:
    print("EXTENSION PACKAGE VALIDATION: INCONCLUSIVE - Chromium not found")
    raise SystemExit(2)

with tempfile.TemporaryDirectory(prefix="qec-pack-") as td:
    temp_root = Path(td)
    extension = temp_root / "extension"
    extension.mkdir()
    shutil.copy2(ROOT / "manifest.json", extension / "manifest.json")
    shutil.copytree(ROOT / "src", extension / "src", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    result = subprocess.run(
        [CHROMIUM, "--no-sandbox", f"--pack-extension={extension}"],
        capture_output=True,
        text=True
    )
    if result.returncode != 0:
        print("EXTENSION PACKAGE VALIDATION: FAIL")
        if result.stderr.strip():
            print(result.stderr.strip())
        raise SystemExit(result.returncode or 1)

    crx = temp_root / "extension.crx"
    if not crx.exists() or crx.stat().st_size == 0:
        print("EXTENSION PACKAGE VALIDATION: FAIL - Chromium produced no CRX")
        raise SystemExit(1)

    print("EXTENSION PACKAGE VALIDATION: PASS")
