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


# The broad debugger capability is admitted only as a narrow playback/cast activation transport.
# Synthetic browser input is limited to (a) one Space keydown/keyUp pair for JW playback,
# (b) one semantic JW Cast-control pointer click resolved from `.jw-icon-cast`,
# (c) one semantic HTML5 Cast-control pointer click resolved only inside the already-marked
# canonical HTML5 player surface, and (d) one userGesture Runtime.evaluate that calls only
# the Cast bridge's fixed trusted-session-request function for retained HTML5 Cast continuation.
# None may move the OS pointer, force foreground focus, inspect provider network traffic,
# select a receiver, construct/load Cast media, or click arbitrary page coordinates.
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

if activation_text.count('"Runtime.evaluate"') != 4:
    errors.append("gesture activation must have exactly four bounded Runtime.evaluate paths: canonical HTML5 play + trusted Cast session request + HTML5 Cast-control location + JW Cast-control location")
if 'userGesture: true' not in activation_text or 'data-qec-canonical-media' not in activation_text:
    errors.append("HTML5 trusted activation must target only the Provider Agent-marked canonical media with userGesture:true")
if '__QEC_CAST_TRUSTED_REQUEST_SESSION__' not in activation_text:
    errors.append("retained HTML5 Cast activation must call only the fixed Cast-bridge trusted requestSession entry point")
if activation_text.count('"Input.dispatchMouseEvent"') != 6 or '.jw-icon-cast' not in activation_text or '.vjs-chromecast-button' not in activation_text:
    errors.append("Cast activation must contain exactly two bounded move/press/release sequences: semantic JW and canonical-surface HTML5 cast controls")
if 'data-qec-canonical-media' not in activation_text or 'HTML5_CAST_CONTROL_NOT_FOUND' not in activation_text:
    errors.append("HTML5 Cast-control activation must stay scoped to the Provider Agent-marked canonical media surface and fail closed when no semantic control exists")
for forbidden_command in ["Network.", "DOM.", "Page.", "Input.insertText", "Fetch.", "Storage."]:
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


# Google Cast page API access belongs only to the Provider Agent's MAIN-world
# Cast bridge. QEC never constructs or loads Cast media itself. Under D-028 only,
# one provider-owned JW playlist item may cross the extension runtime opaquely and
# transiently from the next-episode helper tab to the retained JW Cast sender,
# solely so that retained sender can call jwplayer().requestCast([item]). The item
# must not be persisted, logged, inspected for media identifiers, or generalized
# into a stream-extraction interface.
cast_api_owners = []
for path in SRC.rglob("*.js"):
    text = path.read_text(encoding="utf-8")
    if "cast?.framework" in text or "chrome?.cast" in text or "cast.framework" in text or "chrome.cast" in text:
        cast_api_owners.append(str(path.relative_to(ROOT)))
if cast_api_owners != ["src/providers/cast-main-bridge.js"]:
    errors.append("Google Cast page API access must exist only in src/providers/cast-main-bridge.js; found " + repr(cast_api_owners))
cast_bridge_text = (SRC / "providers" / "cast-main-bridge.js").read_text(encoding="utf-8")
for forbidden_cast in ["loadMedia(", ".contentId", "media.contentId", "MediaInfo("]:
    if forbidden_cast in cast_bridge_text:
        errors.append(f"Cast bridge must reuse provider Cast sessions without media extraction/loading: {forbidden_cast}")
jw_bridge_text = (SRC / "providers" / "jw-main-bridge.js").read_text(encoding="utf-8")
if "requestCast(" in jw_bridge_text and "getPlaylistItem(" not in jw_bridge_text:
    errors.append("JW Cast handoff must forward the provider's current JW playlist item rather than construct Cast media")
for forbidden_cast in ["loadMedia(", ".contentId", "media.contentId", "MediaInfo("]:
    if forbidden_cast in jw_bridge_text:
        errors.append(f"JW bridge must not construct/extract Cast media: {forbidden_cast}")

background_text = (SRC / "background.js").read_text(encoding="utf-8")
session_text = (SRC / "core" / "session.js").read_text(encoding="utf-8")
popup_text = (SRC / "ui" / "popup.js").read_text(encoding="utf-8")

# Global session ownership is independent of episode phase. UI availability and
# background Start admission must consume the Session Core lifecycle rather than
# re-deriving "active" from RUNNING/BLOCKED/STOPPED/COMPLETED phase labels.
if 'status?.lifecycle === SessionLifecycle.ACTIVE' not in popup_text:
    errors.append("popup Start/Stop availability must derive from Session Core lifecycle")
if "SessionState.STOPPED" in popup_text or "SessionState.COMPLETED" in popup_text:
    errors.append("popup must not infer global session ownership from terminal episode-state labels")
if "isSessionActive(existing)" not in background_text:
    errors.append("background Start admission must use Session Core's global active-session contract")
if "markPlaybackSurfaceLost(session)" not in background_text:
    errors.append("unexpected canonical playback-tab loss must remain owned by Session Core rather than calling stop()")
for owner_name, owner_text in [("background", background_text), ("session core", session_text)]:
    for forbidden_cast in ["loadMedia(", ".contentId", "media.contentId", "MediaInfo(", "LoadRequest("]:
        if forbidden_cast in owner_text:
            errors.append(f"{owner_name} must not inspect/construct/load Cast media: {forbidden_cast}")
if "CAST_RELAY_ITEM" not in background_text or "CAST_RELAY_APPLY" not in background_text:
    errors.append("D-028 Cast continuity must use the dedicated bounded relay contract")
if "requestCast([item])" not in jw_bridge_text:
    errors.append("D-028 retained JW sender must receive the opaque item only through requestCast([item])")

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
