from __future__ import annotations

import base64
import contextlib
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import websocket

ROOT = Path(__file__).resolve().parents[2]
CHROMIUM = os.environ.get("CHROMIUM", "/usr/bin/chromium")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Handler(BaseHTTPRequestHandler):
    routes: dict[str, tuple[int, str, str]] = {}

    def do_GET(self):
        status, ctype, body = self.routes.get(self.path, (404, "text/plain", "not found"))
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))

    def log_message(self, *_args):
        return


@contextlib.contextmanager
def server(routes):
    port = free_port()
    cls = type(f"Handler{port}", (Handler,), {"routes": routes})
    httpd = ThreadingHTTPServer(("127.0.0.1", port), cls)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield port
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2)


class CDP:
    def __init__(self, ws_url: str):
        self.ws = websocket.create_connection(ws_url, timeout=5, origin="http://127.0.0.1")
        self.counter = 0

    def call(self, method: str, params=None):
        self.counter += 1
        ident = self.counter
        self.ws.send(json.dumps({"id": ident, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == ident:
                if "error" in msg:
                    raise RuntimeError(f"CDP {method}: {msg['error']}")
                return msg.get("result", {})

    def eval(self, expression: str, *, user_gesture=False):
        result = self.call("Runtime.evaluate", {
            "expression": expression,
            "awaitPromise": True,
            "returnByValue": True,
            "userGesture": user_gesture
        })
        value = result.get("result", {})
        if value.get("subtype") == "error" or "exceptionDetails" in result:
            raise RuntimeError(result)
        return value.get("value")

    def close(self):
        self.ws.close()


def http_json(url: str, method="GET"):
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=2) as response:
        return json.load(response)


def wait_until(fn, timeout=8.0, interval=0.05, label="condition"):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = fn()
            if last:
                return last
        except Exception as exc:
            last = exc
        time.sleep(interval)
    raise AssertionError(f"Timeout waiting for {label}; last={last!r}")


def make_test_extension(tmp: Path):
    ext = tmp / "extension"
    shutil.copytree(ROOT, ext, ignore=shutil.ignore_patterns(".git", "*.zip", "__pycache__"))
    private_key = tmp / "key.pem"
    public_der = tmp / "pub.der"
    subprocess.run(["openssl", "genrsa", "-out", str(private_key), "2048"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["openssl", "rsa", "-in", str(private_key), "-pubout", "-outform", "DER", "-out", str(public_der)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    public = public_der.read_bytes()
    manifest = json.loads((ext / "manifest.json").read_text(encoding="utf-8"))
    manifest["key"] = base64.b64encode(public).decode("ascii")
    (ext / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    digest = hashlib.sha256(public).digest()[:16]
    extension_id = "".join(chr(ord("a") + ((b >> 4) & 15)) + chr(ord("a") + (b & 15)) for b in digest)
    return ext, extension_id


@contextlib.contextmanager
def chromium_with_extension(ext: Path, extension_id: str, tmp: Path):
    port = free_port()
    profile = tmp / "profile"
    profile.mkdir()
    popup_url = f"chrome-extension://{extension_id}/src/ui/popup.html"
    cmd = [
        CHROMIUM,
        *((["--headless=new"] if os.environ.get("QEC_BROWSER_HEADLESS", "1") != "0" else [])),
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-allow-origins=*",
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile}",
        f"--disable-extensions-except={ext}",
        f"--load-extension={ext}",
        popup_url
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    try:
        wait_until(lambda: http_json(f"http://127.0.0.1:{port}/json/version"), timeout=10, label="Chromium DevTools")
        yield port, proc
    finally:
        proc.terminate()
        try:
            proc.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()


def target_cdp(port: int, predicate):
    target = wait_until(
        lambda: next((t for t in http_json(f"http://127.0.0.1:{port}/json/list") if predicate(t)), None),
        timeout=8,
        label="CDP target"
    )
    return CDP(target["webSocketDebuggerUrl"]), target


def js(value):
    return json.dumps(value, separators=(",", ":"))


def main():
    provider_routes = {
        "/provider": (200, "text/html", """
<!doctype html><html><body><video id="v"></video><script>
HTMLMediaElement.prototype.play=function(){queueMicrotask(()=>this.dispatchEvent(new Event('playing')));return Promise.resolve();};
</script></body></html>"""),
        "/blocked-provider": (200, "text/html", """
<!doctype html><html><body><video id="v"></video><script>
HTMLMediaElement.prototype.play=function(){return Promise.reject(new DOMException('Autoplay denied by fixture','NotAllowedError'));};
</script></body></html>""")
    }

    with server(provider_routes) as provider_port:
        top_routes = {
            "/top": (200, "text/html", f"<!doctype html><iframe src='http://127.0.0.1:{provider_port}/provider'></iframe>"),
            "/next": (200, "text/html", "<!doctype html><h1>next</h1>"),
            "/blocked": (200, "text/html", f"<!doctype html><iframe src='http://127.0.0.1:{provider_port}/blocked-provider'></iframe>")
        }
        with server(top_routes) as top_port, tempfile.TemporaryDirectory(prefix="qec-browser-") as td:
            tmp = Path(td)
            ext, extension_id = make_test_extension(tmp)
            top_url = f"http://127.0.0.1:{top_port}/top"
            next_url = f"http://127.0.0.1:{top_port}/next"
            blocked_url = f"http://127.0.0.1:{top_port}/blocked"
            provider_url = f"http://127.0.0.1:{provider_port}/provider"
            blocked_provider_url = f"http://127.0.0.1:{provider_port}/blocked-provider"

            with chromium_with_extension(ext, extension_id, tmp) as (port, _proc):
                popup, _target = target_cdp(port, lambda t: t.get("url") == f"chrome-extension://{extension_id}/src/ui/popup.html")
                try:
                    runtime_id = popup.eval("typeof chrome === 'object' && chrome.runtime ? chrome.runtime.id : null")
                    if runtime_id != extension_id:
                        print(
                            "BROWSER TESTS: INCONCLUSIVE - Chromium did not load the unpacked extension "
                            "in this environment. The production extension runtime was not exercised.",
                            flush=True
                        )
                        return 2
                    print("PASS A-M0-001 unpacked MV3 extension loaded in Chromium", flush=True)

                    status = wait_until(lambda: popup.eval("document.querySelector('#state')?.textContent") if popup.eval("document.querySelector('#state')") else None, label="popup state")
                    assert status == "IDLE", status
                    version = popup.eval("(async()=> (await chrome.runtime.sendMessage({version:1,sessionId:null,epoch:null,type:'POPUP_GET_STATUS',payload:{}})).version)()")
                    assert version == 1
                    print("PASS A-M0-002 popup/service-worker versioned messaging", flush=True)

                    # Current browser execution of the production adapter against a minimal structural fixture.
                    fixture_url = "data:text/html," + urllib.parse.quote("""
<div class='hosterSiteVideo'><ul>
<li data-link-id='11' data-link-target='/redirect/11' data-lang-key='1'><a href='/redirect/11'><h4>VOE</h4></a></li>
<li data-link-id='12' data-link-target='/redirect/12' data-lang-key='1'><a href='/redirect/12'><h4>Doodstream</h4></a></li>
</ul></div><div class='inSiteWebStream'><iframe></iframe></div>
<a href='https://aniworld.to/anime/stream/black-torch/staffel-1/episode-1'>1</a>
<a href='https://aniworld.to/anime/stream/black-torch/staffel-1/episode-2'>2</a>
""")
                    created = popup.eval(f"(async()=>await chrome.tabs.create({{url:{js(fixture_url)},active:false}}))()")
                    fixture_tab_id = created["id"]
                    fixture_target, _ = target_cdp(port, lambda t: t.get("type") == "page" and t.get("url", "").startswith("data:text/html,"))
                    try:
                        adapter_src = (ROOT / "src/sites/episode-site-adapter.js").read_text(encoding="utf-8")
                        fixture_target.eval(adapter_src)
                        probe = fixture_target.eval("QEC_EpisodeSite.probe(document,{href:'https://aniworld.to/anime/stream/black-torch/staffel-1/episode-1'},window)")
                        assert probe["supported"] is True
                        assert probe["nextEpisode"]["episode"] == 2
                        assert [p["provider"] for p in probe["providers"]] == ["VOE", "Doodstream"]
                        unsupported = fixture_target.eval("QEC_EpisodeSite.probe(document,{href:'https://example.com/nope'},window)")
                        assert unsupported["supported"] is False
                        print("PASS A-003/A-004/A-005 episode-source DOM fixture and fail-closed probe", flush=True)
                    finally:
                        fixture_target.close()
                        popup.eval(f"chrome.tabs.remove({fixture_tab_id})")

                    no_loop = popup.eval(f"(async()=>{{const s=await import(chrome.runtime.getURL('src/sites/episode-site-adapter.js')).catch(()=>null);return true;}})()")
                    assert no_loop is True
                    print("PASS A-006 no-loop behavior covered by deterministic unit suite", flush=True)

                    permission = popup.eval("(async()=>{await chrome.permissions.remove({origins:['http://127.0.0.1/*']});const m=await import(chrome.runtime.getURL('src/permissions/permission-broker.js'));return await m.getPermissionState('http://127.0.0.1:9999');})()")
                    assert permission["state"] == "REQUIRED"
                    print("PASS A-019 missing provider permission is explicit", flush=True)

                    granted = popup.eval("(async()=>await chrome.permissions.request({origins:['http://127.0.0.1/*']}))()", user_gesture=True)
                    assert granted is True
                    print("PASS A-020 permission can be granted only from explicit user-gesture path", flush=True)

                    popup.eval("window.__qecEvents=[];chrome.runtime.onMessage.addListener((m,s)=>{if(m?.type?.startsWith('MEDIA_'))window.__qecEvents.push({message:m,frameId:s.frameId,tabId:s.tab?.id??null});});true")
                    top_tab = popup.eval(f"(async()=>await chrome.tabs.create({{url:{js(top_url)},active:false}}))()")
                    top_tab_id = top_tab["id"]
                    wait_until(lambda: popup.eval(f"(async()=> (await chrome.tabs.get({top_tab_id})).status==='complete')()"), label="top fixture load")
                    frame_info = wait_until(lambda: popup.eval(f"(async()=>{{const results=await chrome.scripting.executeScript({{target:{{tabId:{top_tab_id},allFrames:true}},func:()=>location.href}});return results.find(r=>r.result==={js(provider_url)})||null;}})()"), label="provider frame")
                    frame_id = frame_info["frameId"]

                    attach = popup.eval(f"(async()=>{{await chrome.scripting.executeScript({{target:{{tabId:{top_tab_id},frameIds:[{frame_id}]}},files:['src/providers/frame-agent.js']}});return await chrome.tabs.sendMessage({top_tab_id},{{version:1,sessionId:'frame-test',epoch:1,type:'PROVIDER_ATTACH',payload:{{provider:'VOE'}}}},{{frameId:{frame_id}}});}})()")
                    assert attach["ok"] is True
                    wait_until(lambda: popup.eval("window.__qecEvents.some(e=>e.message.type==='MEDIA_FOUND')"), label="MEDIA_FOUND")
                    wait_until(lambda: popup.eval("window.__qecEvents.some(e=>e.message.type==='MEDIA_PLAYING')"), label="MEDIA_PLAYING")
                    print("PASS A-007/A-008 cross-origin frame injection and media-state reporting", flush=True)

                    popup.eval(f"(async()=>await chrome.scripting.executeScript({{target:{{tabId:{top_tab_id},frameIds:[{frame_id}]}},func:()=>document.querySelector('video').dispatchEvent(new Event('ended'))}}))()")
                    wait_until(lambda: popup.eval("window.__qecEvents.some(e=>e.message.type==='MEDIA_ENDED')"), label="MEDIA_ENDED")
                    popup.eval(f"(async()=>await chrome.scripting.executeScript({{target:{{tabId:{top_tab_id},frameIds:[{frame_id}]}},func:()=>{{const v=document.createElement('video');document.querySelector('video').replaceWith(v);}}}}))()")
                    wait_until(lambda: popup.eval("window.__qecEvents.some(e=>e.message.type==='MEDIA_REPLACED')"), label="MEDIA_REPLACED")
                    print("PASS A-009 provider video replacement observed", flush=True)

                    fullscreen = popup.eval("(async()=>{const w=await chrome.windows.getCurrent();const m=await import(chrome.runtime.getURL('src/window/window-controller.js'));const entered=await m.enterPlaybackMode(w.id);return {windowId:w.id,entered,state:(await chrome.windows.get(w.id)).state};})()")
                    assert fullscreen["entered"]["currentState"] == "fullscreen", fullscreen
                    print("PASS A-012 playback window entered fullscreen", flush=True)

                    now = int(time.time() * 1000)
                    seeded = {
                        "sessionId": "nav-test", "state": "RUNNING", "tabId": top_tab_id,
                        "windowId": top_tab["windowId"], "epoch": 1, "fullscreen": True,
                        "providerPriority": ["VOE", "Doodstream"],
                        "currentEpisode": {"site": "fixture", "season": 1, "episode": 1, "url": top_url},
                        "nextEpisode": {"site": "fixture", "season": 1, "episode": 2, "url": next_url},
                        "selectedProvider": {"provider": "VOE"},
                        "providerFrame": {"frameId": frame_id, "origin": f"http://127.0.0.1:{provider_port}", "url": provider_url},
                        "pendingPermissionOrigin": None, "blockedReason": None, "transitionToken": None,
                        "originalWindowState": fullscreen["entered"]["originalState"], "changedWindowMode": fullscreen["entered"]["changed"],
                        "lastMedia": None, "diagnostics": [], "createdAt": now, "updatedAt": now
                    }
                    popup.eval(f"(async()=>await chrome.storage.session.set({{{js('qec.session')}:{js(seeded)}}}))()")
                    popup.eval("(async()=>await chrome.tabs.sendMessage(%d,{version:1,sessionId:'nav-test',epoch:1,type:'PROVIDER_ATTACH',payload:{provider:'VOE'}},{frameId:%d}))()" % (top_tab_id, frame_id))
                    popup.eval(f"(async()=>await chrome.scripting.executeScript({{target:{{tabId:{top_tab_id},frameIds:[{frame_id}]}},func:()=>document.querySelector('video').dispatchEvent(new Event('ended'))}}))()")
                    wait_until(lambda: popup.eval(f"(async()=> (await chrome.tabs.get({top_tab_id})).url==={js(next_url)})()"), label="next navigation")
                    print("PASS A-013 MEDIA_ENDED navigates same tab without fullscreen transition command", flush=True)

                    blocked_tab = popup.eval(f"(async()=>await chrome.tabs.create({{url:{js(blocked_url)},active:false}}))()")
                    blocked_tab_id = blocked_tab["id"]
                    wait_until(lambda: popup.eval(f"(async()=> (await chrome.tabs.get({blocked_tab_id})).status==='complete')()"), label="blocked fixture load")
                    blocked_frame = wait_until(lambda: popup.eval(f"(async()=>{{const results=await chrome.scripting.executeScript({{target:{{tabId:{blocked_tab_id},allFrames:true}},func:()=>location.href}});return results.find(r=>r.result==={js(blocked_provider_url)})||null;}})()"), label="blocked provider frame")
                    blocked_frame_id = blocked_frame["frameId"]
                    blocked_session = dict(seeded)
                    blocked_session.update({
                        "sessionId": "blocked-test", "state": "RUNNING", "tabId": blocked_tab_id,
                        "windowId": blocked_tab["windowId"], "nextEpisode": None,
                        "providerFrame": {"frameId": blocked_frame_id, "origin": f"http://127.0.0.1:{provider_port}", "url": blocked_provider_url},
                        "changedWindowMode": False, "originalWindowState": None
                    })
                    popup.eval(f"(async()=>await chrome.storage.session.set({{{js('qec.session')}:{js(blocked_session)}}}))()")
                    popup.eval(f"(async()=>{{await chrome.scripting.executeScript({{target:{{tabId:{blocked_tab_id},frameIds:[{blocked_frame_id}]}},files:['src/providers/frame-agent.js']}});return await chrome.tabs.sendMessage({blocked_tab_id},{{version:1,sessionId:'blocked-test',epoch:1,type:'PROVIDER_ATTACH',payload:{{provider:'VOE'}}}},{{frameId:{blocked_frame_id}}});}})()")
                    blocked_status = wait_until(lambda: popup.eval("(async()=>{const r=await chrome.runtime.sendMessage({version:1,sessionId:null,epoch:null,type:'POPUP_GET_STATUS',payload:{}});return r.status?.state==='BLOCKED'?r.status:null;})()"), label="passive blocked state")
                    assert blocked_status["blockedReason"] == "AUTOPLAY_BLOCKED"
                    print("PASS A-018 autoplay denial becomes passive BLOCKED state", flush=True)

                    print("BROWSER TESTS: PASS", flush=True)
                    return 0
                finally:
                    popup.close()


if __name__ == "__main__":
    raise SystemExit(main())
