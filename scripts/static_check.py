from pathlib import Path
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
errors = []

manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
if manifest.get("manifest_version") != 3:
    errors.append("manifest must use MV3")
if "scripting" not in manifest.get("permissions", []):
    errors.append("scripting permission missing")
if "debugger" not in manifest.get("permissions", []):
    errors.append("hands-free v0.3 requires debugger permission for bounded trusted playback activation")
if "webRequest" in manifest.get("permissions", []):
    errors.append("v0.2 playback-tab architecture must not retain webRequest")
required_controller_hosts = [
    "https://aniworld.to/*",
    "https://serienstream.to/*",
    "http://186.2.175.5/*",
]
for host in required_controller_hosts:
    if host not in manifest.get("host_permissions", []):
        errors.append(f"controller site host permission missing: {host}")
required_provider_hosts = [
    "https://playmogo.com/*",
    "https://voe.sx/*",
    "https://jeremyparticipantanything.com/*",
]
for host in required_provider_hosts:
    if host not in manifest.get("host_permissions", []):
        errors.append(f"known provider host permission missing for first-run hands-free startup: {host}")

for path in SRC.rglob("*.js"):
    text = path.read_text(encoding="utf-8")
    rel = path.relative_to(ROOT)
    forbidden = [
        r"\bpyautogui\b",
        r"\bRobotJS\b",
        r"SendInput",
        r"keybd_event",
        r"mouse_event",
        r"\.focus\(\)",
        r"windows\.update\([^\n]*focused\s*:\s*true"
    ]
    for pattern in forbidden:
        if re.search(pattern, text, flags=re.I):
            errors.append(f"{rel}: forbidden non-interference pattern {pattern}")


# The broad debugger capability is admitted only as a narrow playback-activation transport.
# The only synthetic browser input allowed is one Space keydown/keyUp pair sent
# directly to the canonical playback tab. OS input, mouse input and arbitrary keys remain forbidden.
debugger_owners = []
for path in SRC.rglob("*.js"):
    text = path.read_text(encoding="utf-8")
    if "chrome.debugger" in text:
        debugger_owners.append(str(path.relative_to(ROOT)))
    if re.search(r"[\"']Input\.", text) and path.name != "gesture-activation.js":
        errors.append(f"{path.relative_to(ROOT)}: DevTools Input domain bypasses the bounded playback activation transport")
if debugger_owners != ["src/providers/gesture-activation.js"]:
    errors.append("chrome.debugger must exist only in src/providers/gesture-activation.js; found " + repr(debugger_owners))
activation_text = (SRC / "providers" / "gesture-activation.js").read_text(encoding="utf-8")
if '"Input.dispatchKeyEvent"' not in activation_text:
    errors.append("gesture activation must use the bounded Input.dispatchKeyEvent transport")
if 'code: "Space"' not in activation_text or 'windowsVirtualKeyCode: 32' not in activation_text:
    errors.append("gesture activation must be statically constrained to the Space key")

if activation_text.count('"Runtime.evaluate"') != 1:
    errors.append("gesture activation must use exactly one Runtime.evaluate path for canonical HTML5 playback")
if 'userGesture: true' not in activation_text or 'data-qec-canonical-media' not in activation_text:
    errors.append("HTML5 trusted activation must target only the Provider Agent-marked canonical media with userGesture:true")
for forbidden_command in ["Network.", "DOM.", "Page.", "Input.dispatchMouseEvent", "Input.insertText", "Fetch.", "Storage."]:
    if forbidden_command in activation_text:
        errors.append(f"gesture activation must not use DevTools {forbidden_command}")

permission_request_owners = []
for path in SRC.rglob("*.js"):
    text = path.read_text(encoding="utf-8")
    if "chrome.permissions.request" in text:
        permission_request_owners.append(str(path.relative_to(ROOT)))
if permission_request_owners != ["src/ui/popup.js"]:
    errors.append(
        "chrome.permissions.request must exist only in src/ui/popup.js; found "
        + repr(permission_request_owners)
    )

# Generic programmatic page clicking remains forbidden. The Provider Frame Agent may
# synchronously activate exactly one already-resolved semantic player control from
# the extension's explicit user-activation button; coordinate/arbitrary clicking is
# still outside the architecture.
for path in SRC.rglob("*.js"):
    text = path.read_text(encoding="utf-8")
    clicks = re.findall(r"\b([A-Za-z_$][\w$]*)\.click\s*\(", text)
    if not clicks:
        continue
    rel = str(path.relative_to(ROOT))
    if rel != "src/providers/frame-agent.js" or clicks != ["trigger"]:
        errors.append(f"{rel}: only the Provider Frame Agent's semantic trigger.click() is authorized; found {clicks!r}")

controller_host_literals = ["aniworld.to", "serienstream.to", "186.2.175.5"]
for path in SRC.rglob("*.js"):
    if "sites" in path.parts:
        continue
    text = path.read_text(encoding="utf-8").lower()
    for host in controller_host_literals:
        if host in text:
            errors.append(f"{path.relative_to(ROOT)}: controller hostname {host} leaked outside site adapter boundary")

# Top-level provider navigation/document resolution belongs to Playback Surface.
for path in SRC.rglob("*.js"):
    if path.name == "playback-surface.js":
        continue
    text = path.read_text(encoding="utf-8")
    if "chrome.webNavigation" in text or "chrome.webRequest" in text:
        errors.append(f"{path.relative_to(ROOT)}: provider navigation inspection bypasses Playback Surface")

for path in SRC.rglob("*.js"):
    if path.name == "frame-agent.js":
        continue
    text = path.read_text(encoding="utf-8")
    if re.search(r"querySelector(All)?\(\s*[\"']video", text):
        errors.append(f"{path.relative_to(ROOT)}: video DOM interpretation bypasses Provider Frame Agent")


# Page-level JW API access belongs only to the Provider Frame Agent's MAIN-world bridge.
for path in SRC.rglob("*.js"):
    if path.name == "jw-main-bridge.js":
        continue
    text = path.read_text(encoding="utf-8")
    if re.search(r"\bjwplayer\s*\(", text, flags=re.I):
        errors.append(f"{path.relative_to(ROOT)}: direct JW page-API access bypasses Provider Frame Agent MAIN-world bridge")

# Playback tab creation/removal belongs to Playback Surface; orchestration commands it through the contract.
for path in SRC.rglob("*.js"):
    text = path.read_text(encoding="utf-8")
    if path.name != "playback-surface.js" and ("chrome.tabs.create" in text or "chrome.tabs.remove" in text):
        errors.append(f"{path.relative_to(ROOT)}: playback tab lifecycle bypasses Playback Surface")

for path in SRC.rglob("*.js"):
    if path.name == "window-controller.js":
        continue
    text = path.read_text(encoding="utf-8")
    if re.search(r"chrome\.windows\.update\([^)]*state\s*:\s*[\"']fullscreen", text, flags=re.S):
        errors.append(f"{path.relative_to(ROOT)}: fullscreen state write bypasses Window Controller")

if errors:
    print("STATIC CHECK: FAIL")
    for error in errors:
        print(" -", error)
    sys.exit(1)

print("STATIC CHECK: PASS")
