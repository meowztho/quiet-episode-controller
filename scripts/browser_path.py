"""Cross-platform Chromium-family browser discovery.

Shared by ``scripts/validate_extension_package.py`` and the browser/fixture test
runners so that a browser installed outside ``PATH`` (the normal case on
Windows) is still found instead of being reported as missing.

Resolution order:

1. ``CHROMIUM`` environment override, used verbatim. It stays authoritative even
   when the file does not exist, so wrappers and CI-provided launchers keep
   working; the caller fails with the browser's own error in that case.
2. ``chromium``, ``chromium-browser``, ``google-chrome``,
   ``google-chrome-stable``, ``msedge`` on ``PATH``.
3. Well-known install locations: Windows ``ProgramFiles`` /
   ``ProgramFiles(x86)`` / ``ProgramW6432`` / ``LOCALAPPDATA`` Chrome and Edge
   installs, plus the usual POSIX and macOS locations.

``find_browser()`` returns ``None`` when nothing is found. Callers must then
report an honest ``INCONCLUSIVE`` result rather than converting a missing
browser into a pass.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

PATH_NAMES = (
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "msedge",
)

# Relative install locations, expanded against the listed environment variables.
_WINDOWS_INSTALLS = (
    ("Google/Chrome/Application/chrome.exe", ("ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "LOCALAPPDATA")),
    ("Microsoft/Edge/Application/msedge.exe", ("ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "LOCALAPPDATA")),
)

_POSIX_INSTALLS = (
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
)


def _install_candidates():
    if os.name == "nt":
        for relative, env_names in _WINDOWS_INSTALLS:
            for env_name in env_names:
                base = os.environ.get(env_name)
                if base:
                    yield str(Path(base) / relative)
    else:
        yield from _POSIX_INSTALLS


def attempted_browsers():
    """Ordered description of every location discovery considers."""
    override = os.environ.get("CHROMIUM")
    attempted = []
    if override:
        attempted.append(f"CHROMIUM={override}")
    attempted.extend(f"{name} (PATH)" for name in PATH_NAMES)
    attempted.extend(_install_candidates())
    return attempted


def find_browser():
    """Return the resolved browser executable path, or ``None`` when absent."""
    override = os.environ.get("CHROMIUM")
    if override:
        return override

    for name in PATH_NAMES:
        found = shutil.which(name)
        if found:
            return found

    for candidate in _install_candidates():
        if Path(candidate).is_file():
            return candidate

    return None


def describe_failure():
    """Multi-line explanation used by callers that must report INCONCLUSIVE."""
    tried = "\n".join(f"  - {item}" for item in attempted_browsers())
    return (
        "no Chromium-family browser found; set CHROMIUM to a browser executable to override.\n"
        f"tried:\n{tried}"
    )
