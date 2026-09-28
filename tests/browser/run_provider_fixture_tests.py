from pathlib import Path
import shutil

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
CHROMIUM = shutil.which("chromium") or shutil.which("chromium-browser")

BOOTSTRAP = r"""
window.__qecMessages = [];
window.__qecListener = null;
window.chrome = {
  runtime: {
    sendMessage(message) { window.__qecMessages.push(message); return Promise.resolve({ok:true}); },
    onMessage: { addListener(fn) { window.__qecListener = fn; } }
  }
};
"""


def main() -> int:
    if not CHROMIUM:
        print("PROVIDER FIXTURE TESTS: INCONCLUSIVE - Chromium not found")
        return 2

    agent = (ROOT / "src/providers/frame-agent.js").read_text(encoding="utf-8")
    jw_bridge = (ROOT / "src/providers/jw-main-bridge.js").read_text(encoding="utf-8")
    cast_bridge = (ROOT / "src/providers/cast-main-bridge.js").read_text(encoding="utf-8")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, executable_path=CHROMIUM, args=["--no-sandbox"])
        try:
            page = browser.new_page()
            page.set_content("<video id='video'></video>")
            page.add_script_tag(content=BOOTSTRAP + "\n" + r"""
HTMLMediaElement.prototype.play = function () {
  queueMicrotask(() => this.dispatchEvent(new Event('playing')));
  return Promise.resolve();
};
""")
            page.add_script_tag(content=agent)
            attached = page.evaluate("""
              new Promise(resolve => window.__qecListener(
                {version:1,sessionId:'fixture',epoch:1,type:'PROVIDER_ATTACH',payload:{provider:'VOE'}},
                {}, resolve
              ))
            """)
            assert attached["ok"] is True
            page.wait_for_function("window.__qecMessages.some(m => m.type === 'MEDIA_PLAYING')")
            kinds = page.evaluate("window.__qecMessages.map(m => m.type)")
            assert "MEDIA_FOUND" in kinds
            assert "MEDIA_PLAYING" in kinds
            presentation = page.locator("video").evaluate("v => ({controls:v.controls, position:getComputedStyle(v).position, width:getComputedStyle(v).width, height:getComputedStyle(v).height, z:getComputedStyle(v).zIndex})")
            assert presentation["controls"] is False
            assert presentation["position"] == "fixed"
            assert presentation["z"] == "2147483646"
            assert page.locator("#__qec_controls_root__").count() == 1
            assert page.locator("[data-qec-action='toggle']").count() == 1
            assert page.locator("[data-qec-action='back']").count() == 1
            assert page.locator("[data-qec-action='forward']").count() == 1
            assert page.locator("[data-qec-action='seek']").count() == 1
            assert page.locator("[data-qec-action='mute']").count() == 1
            assert page.locator("[data-qec-action='volume']").count() == 1

            page.locator("video").evaluate("v => v.dispatchEvent(new Event('ended'))")
            page.wait_for_function("window.__qecMessages.some(m => m.type === 'MEDIA_ENDED')")

            page.evaluate("""
              const next = document.createElement('video');
              next.id = 'replacement';
              document.querySelector('video').replaceWith(next);
            """)
            page.wait_for_function("window.__qecMessages.some(m => m.type === 'MEDIA_REPLACED')")

            retrying = browser.new_page()
            retrying.set_content("<video></video>")
            retrying.add_script_tag(content=BOOTSTRAP + "\n" + r"""
window.__playAttempts = 0;
HTMLMediaElement.prototype.play = function () {
  window.__playAttempts += 1;
  if (window.__playAttempts === 1) {
    return Promise.reject(new DOMException('source changed during startup', 'AbortError'));
  }
  queueMicrotask(() => this.dispatchEvent(new Event('playing')));
  return Promise.resolve();
};
""")
            retrying.add_script_tag(content=agent)
            retrying.evaluate("""
              new Promise(resolve => window.__qecListener(
                {version:1,sessionId:'retry',epoch:1,type:'PROVIDER_ATTACH',payload:{provider:'Doodstream'}},
                {}, resolve
              ))
            """)
            retrying.wait_for_function("window.__qecMessages.some(m => m.type === 'MEDIA_PLAYING')")
            assert retrying.evaluate("window.__playAttempts") >= 2
            assert retrying.evaluate("!window.__qecMessages.some(m => m.type === 'MEDIA_PLAY_BLOCKED')")

            # A provider-owned HTML5 skin (representative of Doodstream/Plyr)
            # must remain the single visible control owner. QEC sizes the native
            # player surface but does not layer its own controls or browser-native
            # controls on top.
            dood_ui = browser.new_page()
            dood_ui.set_content("""
              <div class='plyr' style='width:640px;height:360px'>
                <video></video>
                <button class='plyr__control--overlaid' aria-label='Play'>Play</button>
                <div class='plyr__controls'>provider controls</div>
              </div>
            """)
            dood_ui.add_script_tag(content=BOOTSTRAP + "\n" + r"""
HTMLMediaElement.prototype.play = function () {
  queueMicrotask(() => this.dispatchEvent(new Event('playing')));
  return Promise.resolve();
};
""")
            dood_ui.add_script_tag(content=agent)
            dood_ui.evaluate("""
              new Promise(resolve => window.__qecListener(
                {version:1,sessionId:'dood-ui',epoch:1,type:'PROVIDER_ATTACH',payload:{provider:'Doodstream'}},
                {}, resolve
              ))
            """)
            dood_ui.wait_for_function("window.__qecMessages.some(m => m.type === 'MEDIA_PLAYING')")
            assert dood_ui.locator("#__qec_controls_root__").count() == 0
            assert dood_ui.locator(".plyr__controls").is_visible()
            dood_ui_presentation = dood_ui.locator(".plyr").evaluate("e => ({position:getComputedStyle(e).position,width:getComputedStyle(e).width,height:getComputedStyle(e).height})")
            assert dood_ui_presentation["position"] == "fixed"
            assert dood_ui.locator("video").evaluate("v => v.controls") is False
            assert dood_ui.locator("video").get_attribute("data-qec-canonical-media") == "true"

            # Same-provider retained Cast continuation with an HTML5 player
            # cannot use the JW-only opaque relay. The provider agent must
            # switch to Cast-session rejoin, keep local playback deferred, and
            # accept only real REMOTE_PLAYING as the successful handoff signal.
            dood_cast = browser.new_page()
            dood_cast.set_content("""
              <div class='plyr' style='width:640px;height:360px'>
                <video></video>
                <div class='plyr__controls'>provider controls</div>
              </div>
            """)
            dood_cast.add_script_tag(content=BOOTSTRAP + "\n" + r"""
window.__castCommands = [];
window.__html5PlayCalls = 0;
window.__html5PauseCalls = 0;
window.addEventListener('message', event => {
  const data = event.data;
  if (data?.channel === '__QEC_CAST_BRIDGE_V1__' && data?.direction === 'isolated-to-main') {
    window.__castCommands.push(data);
  }
});
HTMLMediaElement.prototype.play = function () {
  window.__html5PlayCalls += 1;
  queueMicrotask(() => this.dispatchEvent(new Event('playing')));
  return Promise.resolve();
};
HTMLMediaElement.prototype.pause = function () {
  window.__html5PauseCalls += 1;
};
""")
            dood_cast.add_script_tag(content=agent)
            dood_cast.evaluate("""
              new Promise(resolve => window.__qecListener(
                {version:1,sessionId:'dood-cast',epoch:2,type:'PROVIDER_ATTACH',payload:{provider:'Doodstream',castSessionId:'cast-123',castReceiverApplicationId:'CC1AD845',castRelayMode:true}},
                {}, resolve
              ))
            """)
            dood_cast.wait_for_function("window.__qecMessages.some(m => m.type === 'CAST_STATUS' && m.payload.traceEvent === 'HTML5_CAST_REJOIN')")
            dood_cast.wait_for_function("window.__castCommands.some(m => m.command === 'REJOIN_SESSION' && m.payload.sessionId === 'cast-123')")
            assert dood_cast.evaluate("window.__html5PlayCalls") == 0
            assert dood_cast.evaluate("window.__qecMessages.some(m => m.type === 'CAST_RELAY_ITEM')") is False

            dood_cast.evaluate("""
              window.postMessage({
                channel:'__QEC_CAST_BRIDGE_V1__', direction:'main-to-isolated', event:'REJOIN_INTERACTION_REQUIRED',
                payload:{connected:false,requestedSessionId:'cast-123',rejoinReason:'REQUEST_SESSION_BY_ID_UNAVAILABLE',traceEvent:'REJOIN_INTERACTION_REQUIRED:REQUEST_SESSION_BY_ID_UNAVAILABLE'}
              }, '*')
            """)
            dood_cast.wait_for_function("window.__qecMessages.some(m => m.type === 'CAST_HANDOFF_REQUIRED' && m.payload.playerKind === 'HTML5' && m.payload.handoffMethod === 'TRUSTED_HTML5_CAST_CONTROL')")
            # The provider may emit playing while its semantic Cast control is
            # being triggered. That transient native-trigger phase must remain
            # non-authoritative and keep local playback paused.
            dood_cast.locator("video").evaluate("v => v.dispatchEvent(new Event('playing'))")
            dood_cast.wait_for_function("window.__html5PauseCalls > 0")
            assert dood_cast.evaluate("window.__qecMessages.some(m => m.type === 'MEDIA_PLAYING' && m.payload.playerKind === 'HTML5')") is False

            # If no provider-owned HTML5 Cast control is available, the frame
            # agent falls back once to the Google-owned CastContext picker.
            dood_cast.evaluate("""
              new Promise(resolve => window.__qecListener(
                {version:1,sessionId:'dood-cast',epoch:2,type:'CAST_HANDOFF_RESULT',payload:{ok:false,reason:'HTML5_CAST_CONTROL_NOT_FOUND',handoffMethod:'TRUSTED_HTML5_CAST_CONTROL'}},
                {}, resolve
              ))
            """)
            dood_cast.wait_for_function("window.__qecMessages.some(m => m.type === 'CAST_HANDOFF_REQUIRED' && m.payload.playerKind === 'HTML5' && m.payload.handoffMethod === 'TRUSTED_CAST_CONTEXT_REQUEST')")

            dood_cast.evaluate("""
              new Promise(resolve => window.__qecListener(
                {version:1,sessionId:'dood-cast',epoch:2,type:'CAST_HANDOFF_RESULT',payload:{ok:true,handoffMethod:'TRUSTED_CAST_CONTEXT_REQUEST'}},
                {}, resolve
              ))
            """)
            dood_cast.wait_for_function("window.__qecMessages.some(m => m.type === 'CAST_STATUS' && m.payload.traceEvent === 'TRUSTED_CAST_CONTEXT_REQUEST')")

            dood_cast.locator("video").evaluate("v => v.dispatchEvent(new Event('playing'))")
            dood_cast.wait_for_function("window.__html5PauseCalls > 0")
            assert dood_cast.evaluate("window.__qecMessages.some(m => m.type === 'MEDIA_PLAYING' && m.payload.playerKind === 'HTML5')") is False

            dood_cast.evaluate("""
              window.postMessage({
                channel:'__QEC_CAST_BRIDGE_V1__', direction:'main-to-isolated', event:'STATUS',
                payload:{connected:true,sessionId:'cast-123',deviceName:'Seb',receiverApplicationId:'CC1AD845',mediaPlayerState:'IDLE'}
              }, '*');
              window.postMessage({
                channel:'__QEC_CAST_BRIDGE_V1__', direction:'main-to-isolated', event:'REMOTE_PLAYING',
                payload:{connected:true,sessionId:'cast-123',deviceName:'Seb',receiverApplicationId:'CC1AD845',mediaPlayerState:'PLAYING'}
              }, '*')
            """)
            dood_cast.wait_for_function("window.__qecMessages.some(m => m.type === 'MEDIA_PLAYING' && m.payload.playerKind === 'GoogleCast')")

            # A Framework page can also surface the retained session immediately
            # after setOptions()/resumeSavedSession. Session ownership alone is
            # not media transfer: HTML5 must still request the provider-owned
            # Cast control so the provider loads the new episode.
            dood_cast_joined = browser.new_page()
            dood_cast_joined.set_content("""
              <div class='video-js' style='width:640px;height:360px'>
                <video></video>
                <div class='vjs-control-bar'>provider controls</div>
              </div>
            """)
            dood_cast_joined.add_script_tag(content=BOOTSTRAP + "\n" + r"""
HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
HTMLMediaElement.prototype.pause = function () {};
""")
            dood_cast_joined.add_script_tag(content=agent)
            dood_cast_joined.evaluate("""
              new Promise(resolve => window.__qecListener(
                {version:1,sessionId:'dood-cast-joined',epoch:3,type:'PROVIDER_ATTACH',payload:{provider:'Doodstream',castSessionId:'cast-123',castReceiverApplicationId:'CC1AD845',castRelayMode:true}},
                {}, resolve
              ))
            """)
            dood_cast_joined.wait_for_function("window.__qecMessages.some(m => m.type === 'CAST_STATUS' && m.payload.traceEvent === 'HTML5_CAST_REJOIN')")
            dood_cast_joined.evaluate("""
              window.postMessage({
                channel:'__QEC_CAST_BRIDGE_V1__', direction:'main-to-isolated', event:'STATUS',
                payload:{connected:true,sessionId:'cast-123',deviceName:'Seb',receiverApplicationId:'CC1AD845',mediaPlayerState:'IDLE'}
              }, '*')
            """)
            dood_cast_joined.wait_for_function("window.__qecMessages.some(m => m.type === 'CAST_HANDOFF_REQUIRED' && m.payload.playerKind === 'HTML5' && m.payload.handoffMethod === 'TRUSTED_HTML5_CAST_CONTROL' && m.payload.rejoinReason === 'HTML5_CAST_SESSION_REJOINED')")

            blocked = browser.new_page()
            blocked.set_content("<video></video>")
            blocked.add_script_tag(content=BOOTSTRAP + "\n" + r"""
window.__allowUserStart = false;
HTMLMediaElement.prototype.play = function () {
  if (window.__allowUserStart) {
    queueMicrotask(() => this.dispatchEvent(new Event('playing')));
    return Promise.resolve();
  }
  return Promise.reject(new DOMException('fixture policy block', 'NotAllowedError'));
};
""")
            blocked.add_script_tag(content=agent)
            blocked.evaluate("""
              new Promise(resolve => window.__qecListener(
                {version:1,sessionId:'blocked',epoch:1,type:'PROVIDER_ATTACH',payload:{provider:'Doodstream'}},
                {}, resolve
              ))
            """)
            blocked.wait_for_function("window.__qecMessages.some(m => m.type === 'MEDIA_PLAY_BLOCKED')")
            reason = blocked.evaluate("window.__qecMessages.find(m => m.type === 'MEDIA_PLAY_BLOCKED').payload.reason")
            assert reason == "AUTOPLAY_BLOCKED"
            assert blocked.locator("#__qec_start_button__").is_visible()
            blocked.evaluate("window.__allowUserStart = true")
            blocked.locator("#__qec_start_button__").click()
            blocked.wait_for_function("window.__qecMessages.some(m => m.type === 'MEDIA_PLAYING')")
            assert blocked.locator("#__qec_start_button__").is_hidden()

            gated = browser.new_page()
            gated.set_content("<button id='provider-play' aria-label='Play video'>Play</button>")
            gated.add_script_tag(content=BOOTSTRAP + "\n" + r"""
document.querySelector('#provider-play').addEventListener('click', () => {
  if (document.querySelector('video')) return;
  const video = document.createElement('video');
  document.body.append(video);
});
HTMLMediaElement.prototype.play = function () {
  queueMicrotask(() => this.dispatchEvent(new Event('playing')));
  return Promise.resolve();
};
""")
            gated.add_script_tag(content=agent)
            gated.evaluate("""
              new Promise(resolve => window.__qecListener(
                {version:1,sessionId:'gated',epoch:1,type:'PROVIDER_ATTACH',payload:{provider:'VOE'}},
                {}, resolve
              ))
            """)
            gated.wait_for_selector("#__qec_start_button__")
            assert gated.locator("#__qec_start_button__").is_visible()
            gated.locator("#__qec_start_button__").click()
            gated.wait_for_function("window.__qecMessages.some(m => m.type === 'MEDIA_PLAYING')")
            assert gated.locator("video").count() == 1
            assert gated.locator("[data-qec-action='toggle']").count() == 1

            jw = browser.new_page()
            jw.set_content("""
              <div id='jw-main' class='jwplayer' style='width:640px;height:360px'>
                <div class='jw-controlbar'>native JW controls</div>
                <video></video>
              </div>
            """)
            jw.add_script_tag(content=BOOTSTRAP + "\n" + r"""
window.__html5PlayCalls = 0;
HTMLMediaElement.prototype.play = function () {
  window.__html5PlayCalls += 1;
  return Promise.reject(new Error('HTML5 fallback must not own a JW player'));
};
window.__jwCalls = [];
window.__jwHandlers = new Map();
window.__jwState = 'idle';
window.__jwPlayer = {
  on(name, fn) {
    const list = window.__jwHandlers.get(name) || [];
    list.push(fn);
    window.__jwHandlers.set(name, list);
  },
  off(name, fn) {
    const list = window.__jwHandlers.get(name) || [];
    window.__jwHandlers.set(name, list.filter(item => item !== fn));
  },
  getState() { return window.__jwState; },
  getPosition() { return 12; },
  getDuration() { return 100; },
  getVolume() { return 80; },
  getMute() { return false; },
  getFullscreen() { return false; },
  play() {
    window.__jwCalls.push('play');
    window.__jwState = 'playing';
    queueMicrotask(() => (window.__jwHandlers.get('play') || []).forEach(fn => fn({newstate:'playing', playReason:'external'})));
  },
  pause() { window.__jwCalls.push('pause'); window.__jwState = 'paused'; },
  seek(position) { window.__jwCalls.push(['seek', position]); },
  setVolume(volume) { window.__jwCalls.push(['volume', volume]); },
  setMute(muted) { window.__jwCalls.push(['mute', muted]); },
  setControls(enabled) { window.__jwCalls.push(['controls', enabled]); },
  setAllowFullscreen(enabled) { window.__jwCalls.push(['allowFullscreen', enabled]); },
  resize(width, height) { window.__jwCalls.push(['resize', width, height]); }
};
window.jwplayer = function () { return window.__jwPlayer; };
""")
            jw.add_script_tag(content=jw_bridge)
            jw.add_script_tag(content=agent)
            jw.evaluate("""
              new Promise(resolve => window.__qecListener(
                {version:1,sessionId:'jw',epoch:1,type:'PROVIDER_ATTACH',payload:{provider:'VOE'}},
                {}, resolve
              ))
            """)
            jw.wait_for_function("window.__qecMessages.some(m => m.type === 'MEDIA_PLAYING' && m.payload.playerKind === 'JWPlayer')")
            assert jw.evaluate("window.__html5PlayCalls") == 0
            assert jw.evaluate("window.__jwCalls.includes('play')") is True
            jw.wait_for_function("window.__jwCalls.some(call => Array.isArray(call) && call[0] === 'resize' && call[1] === '100%' && call[2] > 0)")
            assert jw.evaluate("window.__jwCalls.some(call => Array.isArray(call) && call[0] === 'controls' && call[1] === true)") is True
            assert jw.evaluate("window.__jwCalls.some(call => Array.isArray(call) && call[0] === 'allowFullscreen' && call[1] === true)") is True
            jw_presentation = jw.locator("#jw-main").evaluate("e => ({position:getComputedStyle(e).position,width:getComputedStyle(e).width,height:getComputedStyle(e).height})")
            assert jw_presentation["position"] == "fixed"
            assert jw.locator(".jw-controlbar").is_visible()
            assert jw.locator("#__qec_controls_root__").count() == 0

            # Provider wrappers may swallow Space before JW receives it. The QEC
            # driver preserves the real key event and maps only this missing
            # shortcut to the native JW play/pause API.
            jw.locator("body").click(position={"x": 2, "y": 2})
            jw.keyboard.press("Space")
            jw.wait_for_function("window.__jwCalls.includes('pause')")
            jw.keyboard.press("Space")
            jw.wait_for_function("window.__jwCalls.filter(call => call === 'play').length >= 2")

            jw.evaluate("(window.__jwHandlers.get('complete') || []).forEach(fn => fn({}))")
            jw.wait_for_function("window.__qecMessages.some(m => m.type === 'MEDIA_ENDED' && m.payload.playerKind === 'JWPlayer')")

            # A JW wrapper that silently ignores ordinary play must escalate
            # quickly instead of waiting for the full 12-second startup bound.
            slow_jw = browser.new_page()
            slow_jw.set_content("<div id='jw-slow' class='jwplayer' style='width:640px;height:360px'></div>")
            slow_jw.add_script_tag(content=BOOTSTRAP + "\n" + r"""
window.__jwSlowHandlers = new Map();
window.__jwSlowCalls = 0;
window.__jwSlowPlayer = {
  on(name, fn) { const list = window.__jwSlowHandlers.get(name) || []; list.push(fn); window.__jwSlowHandlers.set(name, list); },
  off() {},
  getState() { return 'idle'; },
  getPosition() { return 0; },
  getDuration() { return 100; },
  getVolume() { return 80; },
  getMute() { return false; },
  getFullscreen() { return false; },
  play() { window.__jwSlowCalls += 1; },
  setControls() {}, setAllowFullscreen() {}, resize() {}
};
window.jwplayer = function () { return window.__jwSlowPlayer; };
""")
            slow_jw.add_script_tag(content=jw_bridge)
            slow_jw.add_script_tag(content=agent)
            slow_jw.evaluate("""
              new Promise(resolve => window.__qecListener(
                {version:1,sessionId:'jw-slow',epoch:1,type:'PROVIDER_ATTACH',payload:{provider:'VOE'}},
                {}, resolve
              ))
            """)
            slow_jw.wait_for_function("window.__qecMessages.some(m => m.type === 'MEDIA_PLAY_BLOCKED' && m.payload.startupPhase === 'EARLY_TRUSTED_ESCALATION')", timeout=5000)
            assert slow_jw.evaluate("window.__jwSlowCalls") >= 1

            # CDP can dispatch a trusted Space key directly to a background page.
            # The foreground page remains separate, while the playback document
            # receives transient user activation; this is the hands-free recovery
            # primitive used by the extension when ordinary JW play() is blocked.
            targeted = browser.new_context()
            playback = targeted.new_page()
            foreground = targeted.new_page()
            playback.set_content("""
              <script>
              window.__qecTargetedInput = [];
              addEventListener('keydown', event => {
                window.__qecTargetedInput.push({
                  key: event.key,
                  code: event.code,
                  trusted: event.isTrusted,
                  active: navigator.userActivation.isActive
                });
              });
              </script>
            """)
            foreground.set_content("<h1>foreground work</h1>")
            foreground.bring_to_front()
            cdp = targeted.new_cdp_session(playback)
            cdp.send("Input.dispatchKeyEvent", {
              "type": "rawKeyDown", "key": " ", "code": "Space",
              "windowsVirtualKeyCode": 32, "nativeVirtualKeyCode": 32
            })
            cdp.send("Input.dispatchKeyEvent", {
              "type": "keyUp", "key": " ", "code": "Space",
              "windowsVirtualKeyCode": 32, "nativeVirtualKeyCode": 32
            })
            playback.wait_for_function("window.__qecTargetedInput.length > 0")
            targeted_event = playback.evaluate("window.__qecTargetedInput[0]")
            assert targeted_event == {"key": " ", "code": "Space", "trusted": True, "active": True}
            targeted.close()

            # Runtime.evaluate(userGesture=true) can activate the canonical HTML5
            # media in a background page without OS focus. This is the HTML5/Plyr
            # counterpart to the JW Space transport.
            html5_ctx = browser.new_context()
            html5_playback = html5_ctx.new_page()
            html5_foreground = html5_ctx.new_page()
            html5_playback.set_content("""
              <video data-qec-canonical-media='true'></video>
              <script>
              window.__qecHtml5Gesture = null;
              HTMLMediaElement.prototype.play = function () {
                window.__qecHtml5Gesture = { active: navigator.userActivation.isActive };
                queueMicrotask(() => this.dispatchEvent(new Event('playing')));
                return Promise.resolve();
              };
              </script>
            """)
            html5_foreground.set_content("<h1>foreground work</h1>")
            html5_foreground.bring_to_front()
            html5_cdp = html5_ctx.new_cdp_session(html5_playback)
            result = html5_cdp.send("Runtime.evaluate", {
              "expression": "document.querySelector('video[data-qec-canonical-media=\"true\"]').play().then(() => ({ok:true, active:navigator.userActivation.isActive}))",
              "awaitPromise": True,
              "returnByValue": True,
              "userGesture": True
            })
            assert result["result"]["value"]["ok"] is True
            assert html5_playback.evaluate("window.__qecHtml5Gesture") == {"active": True}
            html5_ctx.close()

            # Sticky Cast continuity: reconnect the provider-created Cast
            # session, then ask JW's own casting implementation to update the
            # receiver with the NEW episode. QEC never serializes the playlist
            # item or source URL across its extension boundary.
            cast_page = browser.new_page()
            cast_page.set_content("""
              <div id='jw-cast' class='jwplayer' style='width:640px;height:360px'>
                <div class='jw-controlbar'>native JW controls <button class='jw-icon-cast' aria-label='Cast'>cast</button></div>
              </div>
            """)
            cast_page.add_script_tag(content=BOOTSTRAP + "\n" + r"""
window.__castRequests = [];
window.__castEndCalls = [];
window.__castContextListeners = new Map();
window.__castLoadMediaRequests = [];
window.__legacyLoadMediaRequests = [];
window.__castOptions = null;
window.__castMedia = null;
window.__castSession = null;
window.__castRemoteListeners = new Map();
window.__castRemotePlayer = null;
window.__castRemoteControlCalls = [];
window.__jwCastCalls = [];
window.__jwCastHandlers = new Map();
window.__jwCastState = 'idle';
window.__jwCastItem = {
  title: 'Episode 3',
  file: 'https://media.example.invalid/private-episode.m3u8',
  sources: [{file:'https://media.example.invalid/private-episode.m3u8', type:'hls'}]
};
class MockLegacyCastSession {
  constructor() { this.sessionId = 'cast-123'; }
  loadMedia(request, successCallback, errorCallback) {
    window.__legacyLoadMediaRequests.push(request);
    try {
      window.__castMedia = { mediaSessionId: 88, playerState: 'PLAYING', idleReason: null };
      const p = window.__castRemotePlayer;
      if (p) {
        p.isConnected = true;
        p.isMediaLoaded = true;
        p.playerState = 'PLAYING';
        p.currentTime = 98;
        p.duration = 100;
        queueMicrotask(() => window.__emitCastRemote('PLAYER_STATE_CHANGED'));
      }
      if (typeof successCallback === 'function') queueMicrotask(() => successCallback(window.__castMedia));
    } catch (error) {
      if (typeof errorCallback === 'function') errorCallback(error);
    }
  }
}
window.__legacyCastSession = new MockLegacyCastSession();
window.__castSessionObject = {
  getSessionId() { return 'cast-123'; },
  getSessionObj() { return window.__legacyCastSession; },
  getSessionState() { return window.__castSession ? 'SESSION_RESUMED' : 'SESSION_ENDED'; },
  getCastDevice() { return { friendlyName: 'Wohnzimmer TV' }; },
  getApplicationMetadata() { return { applicationId: 'CC1AD845' }; },
  getMediaSession() { return window.__castMedia; },
  loadMedia(request) {
    window.__castLoadMediaRequests.push(request);
    return new Promise((resolve, reject) => {
      window.__legacyCastSession.loadMedia(request, resolve, reject);
    });
  }
};
window.__emitCastContext = function(type, payload) {
  for (const fn of (window.__castContextListeners.get(type) || [])) fn({type, ...(payload || {})});
};
window.__castContext = {
  getCurrentSession() { return window.__castSession; },
  getCastState() { return window.__castSession ? 'CONNECTED' : 'NOT_CONNECTED'; },
  setOptions(options) { window.__castOptions = options; },
  addEventListener(type, fn) {
    const list = window.__castContextListeners.get(type) || [];
    list.push(fn);
    window.__castContextListeners.set(type, list);
  },
  removeEventListener(type, fn) {
    const list = window.__castContextListeners.get(type) || [];
    window.__castContextListeners.set(type, list.filter(item => item !== fn));
  },
  endCurrentSession(stopCasting) {
    window.__castEndCalls.push(stopCasting);
    window.__castSession = null;
    const p = window.__castRemotePlayer;
    if (p) p.isConnected = false;
  }
};
class MockRemotePlayer {
  constructor() {
    this.isConnected = false;
    this.isMediaLoaded = false;
    this.playerState = null;
    this.currentTime = 0;
    this.duration = 0;
    window.__castRemotePlayer = this;
  }
}
class MockRemotePlayerController {
  constructor(player) { this.player = player; }
  playOrPause() {
    window.__castRemoteControlCalls.push('playOrPause');
    this.player.playerState = this.player.playerState === 'PLAYING' ? 'PAUSED' : 'PLAYING';
    queueMicrotask(() => window.__emitCastRemote('PLAYER_STATE_CHANGED'));
  }
  seek() {
    window.__castRemoteControlCalls.push(['seek', this.player.currentTime]);
  }
  stop() {
    window.__castRemoteControlCalls.push('stop');
    this.player.playerState = 'IDLE';
    this.player.isMediaLoaded = false;
    queueMicrotask(() => window.__emitCastRemote('PLAYER_STATE_CHANGED'));
  }
  addEventListener(type, fn) {
    const list = window.__castRemoteListeners.get(type) || [];
    list.push(fn);
    window.__castRemoteListeners.set(type, list);
  }
  removeEventListener(type, fn) {
    const list = window.__castRemoteListeners.get(type) || [];
    window.__castRemoteListeners.set(type, list.filter(item => item !== fn));
  }
}
window.__emitCastRemote = function(type) {
  for (const fn of (window.__castRemoteListeners.get(type) || [])) fn({type});
};
window.cast = { framework: {
  CastContext: { getInstance() { return window.__castContext; } },
  RemotePlayer: MockRemotePlayer,
  RemotePlayerController: MockRemotePlayerController,
  RemotePlayerEventType: {
    PLAYER_STATE_CHANGED: 'PLAYER_STATE_CHANGED',
    IS_MEDIA_LOADED_CHANGED: 'IS_MEDIA_LOADED_CHANGED',
    MEDIA_INFO_CHANGED: 'MEDIA_INFO_CHANGED',
    IS_CONNECTED_CHANGED: 'IS_CONNECTED_CHANGED'
  },
  CastContextEventType: {
    SESSION_STATE_CHANGED: 'SESSION_STATE_CHANGED',
    CAST_STATE_CHANGED: 'CAST_STATE_CHANGED'
  }
} };
window.chrome.cast = {
  AutoJoinPolicy: { ORIGIN_SCOPED: 'ORIGIN_SCOPED' },
  Session: MockLegacyCastSession,
  requestSessionById(sessionId) {
    if (!window.__castOptions || window.__castOptions.receiverApplicationId !== 'CC1AD845') {
      window.__castRequests.push(`UNCONFIGURED:${sessionId}`);
      return;
    }
    window.__castRequests.push(sessionId);
    window.__castSession = window.__castSessionObject;
    const p = window.__castRemotePlayer;
    if (p) {
      p.isConnected = true;
      p.isMediaLoaded = false;
      p.playerState = 'IDLE';
      queueMicrotask(() => {
        window.__emitCastContext('SESSION_STATE_CHANGED', {sessionState:'SESSION_RESUMED'});
        window.__emitCastRemote('IS_CONNECTED_CHANGED');
      });
    }
  }
};
window.__jwCastPlayer = {
  on(name, fn) {
    const list = window.__jwCastHandlers.get(name) || [];
    list.push(fn);
    window.__jwCastHandlers.set(name, list);
  },
  off(name, fn) {
    const list = window.__jwCastHandlers.get(name) || [];
    window.__jwCastHandlers.set(name, list.filter(item => item !== fn));
  },
  getState() { return window.__jwCastState; },
  getPosition() { return 0; },
  getDuration() { return 100; },
  getVolume() { return 80; },
  getMute() { return false; },
  getFullscreen() { return false; },
  getPlaylistItem() { return window.__jwCastItem; },
  play() {
    window.__jwCastCalls.push('play');
    window.__jwCastState = 'playing';
    queueMicrotask(() => (window.__jwCastHandlers.get('play') || []).forEach(fn => fn({newstate:'playing'})));
  },
  pause() { window.__jwCastCalls.push('pause'); window.__jwCastState = 'paused'; },
  setControls() {}, setAllowFullscreen() {}, resize() {},
  requestCast(items) {
    window.__jwCastCalls.push(['requestCast', items]);
    if (items.length !== 1 || items[0] !== window.__jwCastItem) throw new Error('current JW item not forwarded');
    window.__castMedia = { mediaSessionId: 88, playerState: 'PLAYING', idleReason: null };
    const p = window.__castRemotePlayer;
    p.isConnected = true;
    p.isMediaLoaded = true;
    p.playerState = 'PLAYING';
    p.currentTime = 98;
    p.duration = 100;
    queueMicrotask(() => window.__emitCastRemote('PLAYER_STATE_CHANGED'));
    return Promise.resolve();
  }
};
window.jwplayer = function () { return window.__jwCastPlayer; };
document.querySelector('.jw-icon-cast').addEventListener('click', () => {
  window.__jwCastCalls.push('native-cast-control');
  (window.__jwCastHandlers.get('cast') || []).forEach(fn => fn({active:true, available:true, deviceName:'Wohnzimmer TV', type:'cast'}));
  const session = window.__castContext.getCurrentSession();
  if (!session) throw new Error('native cast control requires an active Cast session');
  session.loadMedia({
    autoplay: true,
    media: {
      contentId: 'https://media.example.invalid/private-episode.m3u8',
      contentType: 'application/x-mpegURL',
      metadata: { title: 'Episode 3' }
    }
  });
});
const __originalSendMessage = window.chrome.runtime.sendMessage;
window.chrome.runtime.sendMessage = function(message) {
  window.__qecMessages.push(message);
  if (message.type === 'CAST_HANDOFF_REQUIRED') {
    queueMicrotask(() => {
      document.querySelector('.jw-icon-cast').click();
      window.__qecListener(
        {version:1,sessionId:'cast-fixture',epoch:1,type:'CAST_HANDOFF_RESULT',payload:{ok:true,target:'.jw-icon-cast'}},
        {},
        () => {}
      );
    });
  }
  return Promise.resolve({ok:true});
};
""")
            cast_page.add_script_tag(content=cast_bridge)
            cast_page.add_script_tag(content=jw_bridge)
            cast_page.add_script_tag(content=agent)
            cast_page.evaluate("""
              new Promise(resolve => window.__qecListener(
                {version:1,sessionId:'cast-fixture',epoch:1,type:'PROVIDER_ATTACH',payload:{provider:'VOE',castSessionId:'cast-123',castReceiverApplicationId:'CC1AD845'}},
                {}, resolve
              ))
            """)
            cast_page.wait_for_function("window.__castOptions && window.__castOptions.receiverApplicationId === 'CC1AD845'")
            cast_page.wait_for_function("window.__castOptions && window.__castOptions.autoJoinPolicy === 'ORIGIN_SCOPED' && window.__castOptions.resumeSavedSession === true")
            cast_page.wait_for_function("window.__qecMessages.some(m => m.type === 'CAST_STATUS' && m.payload.traceEvent === 'CAST_CONTEXT_CONFIGURED')")
            cast_page.wait_for_function("window.__castRequests.includes('cast-123')")
            cast_page.wait_for_function("window.__jwCastCalls.includes('native-cast-control')")
            cast_page.wait_for_function("window.__qecMessages.some(m => m.type === 'CAST_STATUS' && m.payload.jwCastActive === true && m.payload.jwCastDeviceName === 'Wohnzimmer TV')")
            cast_page.wait_for_function("window.__qecMessages.some(m => m.type === 'CAST_STATUS' && m.payload.connected && m.payload.deviceName === 'Wohnzimmer TV')")
            cast_page.wait_for_function("window.__qecMessages.some(m => m.type === 'CAST_STATUS' && m.payload.traceEvent === 'SESSION:SESSION_RESUMED')")
            cast_page.wait_for_function("window.__qecMessages.some(m => m.type === 'CAST_STATUS' && m.payload.traceEvent === 'LOAD_MEDIA_CALLED:framework-instance:title')")
            cast_page.wait_for_function("window.__qecMessages.some(m => m.type === 'CAST_STATUS' && m.payload.traceEvent === 'LOAD_MEDIA_CALLED:legacy:title')")
            cast_page.wait_for_function("window.__qecMessages.some(m => m.type === 'CAST_STATUS' && m.payload.traceEvent === 'LOAD_MEDIA_SUCCEEDED:framework-instance:title')")
            cast_page.wait_for_function("window.__qecMessages.some(m => m.type === 'CAST_STATUS' && m.payload.traceEvent === 'LOAD_MEDIA_SUCCEEDED:legacy:title')")
            cast_page.wait_for_function("window.__qecMessages.some(m => m.type === 'MEDIA_PLAYING' && m.payload.playerKind === 'GoogleCast')")
            assert cast_page.evaluate("window.__jwCastCalls.includes('play')") is False
            assert cast_page.evaluate("window.__jwCastCalls.some(call => Array.isArray(call) && call[0] === 'requestCast')") is False
            assert "media.example.invalid" not in cast_page.evaluate("JSON.stringify(window.__qecMessages)")
            toggle_result = cast_page.evaluate("""
              new Promise(resolve => window.__qecListener(
                {version:1,sessionId:'cast-fixture',epoch:1,type:'POPUP_CAST_REMOTE_CONTROL',payload:{action:'TOGGLE_PLAY_PAUSE',castSessionId:'cast-123'}},
                {}, resolve
              ))
            """)
            assert toggle_result["ok"] is True
            assert cast_page.evaluate("window.__castRemotePlayer.playerState") == "PAUSED"
            seek_relative_result = cast_page.evaluate("""
              new Promise(resolve => window.__qecListener(
                {version:1,sessionId:'cast-fixture',epoch:1,type:'POPUP_CAST_REMOTE_CONTROL',payload:{action:'SEEK_RELATIVE',seconds:10,castSessionId:'cast-123'}},
                {}, resolve
              ))
            """)
            assert seek_relative_result["ok"] is True
            assert cast_page.evaluate("window.__castRemotePlayer.currentTime") == 100
            seek_to_result = cast_page.evaluate("""
              new Promise(resolve => window.__qecListener(
                {version:1,sessionId:'cast-fixture',epoch:1,type:'POPUP_CAST_REMOTE_CONTROL',payload:{action:'SEEK_TO',seconds:12,castSessionId:'cast-123'}},
                {}, resolve
              ))
            """)
            assert seek_to_result["ok"] is True
            assert cast_page.evaluate("window.__castRemotePlayer.currentTime") == 12
            assert cast_page.evaluate("JSON.stringify(window.__castRemoteControlCalls)") == '["playOrPause",["seek",100],["seek",12]]'
            # Restore the separate near-end completion precondition before
            # exercising the existing media-unload normalization below.
            cast_page.evaluate("""
              const p = window.__castRemotePlayer;
              p.currentTime = 98;
              p.duration = 100;
              window.__emitCastRemote('MEDIA_INFO_CHANGED');
            """)
            cast_page.evaluate("""
              window.__castMedia = null;
              const p = window.__castRemotePlayer;
              p.currentTime = 0;
              p.duration = 0;
              p.isMediaLoaded = false;
              p.playerState = 'IDLE';
              window.__emitCastRemote('IS_MEDIA_LOADED_CHANGED');
            """)
            cast_page.wait_for_function("window.__qecMessages.some(m => m.type === 'MEDIA_ENDED' && m.payload.playerKind === 'GoogleCast' && m.payload.endDetection === 'MEDIA_UNLOADED_NEAR_END')")
            assert cast_page.evaluate("JSON.stringify(window.__castEndCalls)") == "[]"
            assert cast_page.evaluate("window.__castLoadMediaRequests.length") == 1
            assert cast_page.evaluate("window.__legacyLoadMediaRequests.length") == 1
            assert cast_page.evaluate("window.__qecMessages.some(m => m.type === 'MEDIA_ENDED' && m.payload.senderHeldForOverlap === true)") is True
            stop_result = cast_page.evaluate("""
              new Promise(resolve => window.__qecListener(
                {version:1,sessionId:'cast-fixture',epoch:1,type:'POPUP_CAST_REMOTE_CONTROL',payload:{action:'STOP',castSessionId:'cast-123'}},
                {}, resolve
              ))
            """)
            assert stop_result["ok"] is True
            assert cast_page.evaluate("window.__castRemoteControlCalls.at(-1)") == "stop"

            # Real JW/VOE sender pages may expose a usable Cast media session
            # without exposing Framework RemotePlayer/RemotePlayerController.
            # The canonical Cast bridge must keep the same semantic command
            # contract and fall back to chrome.cast.media.Media controls.
            legacy_remote_page = browser.new_page()
            legacy_remote_page.set_content("<div>legacy cast media remote</div>")
            legacy_remote_page.add_script_tag(content=r"""
window.__legacyRemoteMessages = [];
window.__legacyRemoteCalls = [];
window.addEventListener('message', event => {
  const data = event.data;
  if (data?.channel === '__QEC_CAST_BRIDGE_V1__' && data?.direction === 'main-to-isolated') {
    window.__legacyRemoteMessages.push(data);
  }
});
window.__legacyMedia = {
  playerState: 'PLAYING',
  currentTime: 25,
  mediaSessionId: 41,
  idleReason: null,
  media: { duration: 120 },
  getEstimatedTime() { return this.currentTime; },
  play(request, success) {
    window.__legacyRemoteCalls.push('play');
    this.playerState = 'PLAYING';
    if (success) success();
  },
  pause(request, success) {
    window.__legacyRemoteCalls.push('pause');
    this.playerState = 'PAUSED';
    if (success) success();
  },
  seek(request, success) {
    window.__legacyRemoteCalls.push(['seek', request.currentTime]);
    this.currentTime = request.currentTime;
    if (success) success();
  },
  stop(request, success) {
    window.__legacyRemoteCalls.push('stop');
    this.playerState = 'IDLE';
    if (success) success();
  }
};
window.__legacyRemoteSession = {
  getSessionId() { return 'legacy-cast-123'; },
  getCastDevice() { return { friendlyName: 'Seb' }; },
  getApplicationMetadata() { return { applicationId: 'CC1AD845' }; },
  getSessionState() { return 'SESSION_STARTED'; },
  getMediaSession() { return window.__legacyMedia; }
};
window.__legacyRemoteContext = {
  getCurrentSession() { return window.__legacyRemoteSession; },
  getCastState() { return 'CONNECTED'; },
  addEventListener() {},
  removeEventListener() {}
};
window.cast = { framework: {
  CastContext: { getInstance() { return window.__legacyRemoteContext; } },
  CastContextEventType: {}
} };
window.chrome = { cast: {
  media: { SeekRequest: class SeekRequest { constructor() { this.currentTime = 0; } } }
} };
""")
            legacy_remote_page.add_script_tag(content=cast_bridge)
            legacy_remote_page.wait_for_function("window.__legacyRemoteMessages.some(m => m.event === 'STATUS' && m.payload.remoteControlAvailable === true && m.payload.remoteControlDriver === 'LEGACY_MEDIA' && m.payload.remoteCurrentTime === 25 && m.payload.remoteDuration === 120)")
            legacy_remote_page.evaluate("""
              window.postMessage({
                channel:'__QEC_CAST_BRIDGE_V1__', direction:'isolated-to-main', command:'REMOTE_CONTROL',
                payload:{commandId:'legacy-toggle',action:'TOGGLE_PLAY_PAUSE',castSessionId:'legacy-cast-123'}
              }, '*')
            """)
            legacy_remote_page.wait_for_function("window.__legacyRemoteMessages.some(m => m.event === 'REMOTE_CONTROL_RESULT' && m.payload.commandId === 'legacy-toggle' && m.payload.ok === true)")
            legacy_remote_page.evaluate("""
              window.postMessage({
                channel:'__QEC_CAST_BRIDGE_V1__', direction:'isolated-to-main', command:'REMOTE_CONTROL',
                payload:{commandId:'legacy-seek',action:'SEEK_RELATIVE',seconds:10,castSessionId:'legacy-cast-123'}
              }, '*')
            """)
            legacy_remote_page.wait_for_function("window.__legacyRemoteMessages.some(m => m.event === 'REMOTE_CONTROL_RESULT' && m.payload.commandId === 'legacy-seek' && m.payload.ok === true)")
            assert legacy_remote_page.evaluate("JSON.stringify(window.__legacyRemoteCalls)") == '["pause",["seek",35]]'
            assert legacy_remote_page.evaluate("window.__legacyMedia.currentTime") == 35

            # Some current Cast sender surfaces expose the Framework API but do
            # not expose legacy chrome.cast.requestSessionById(). In that case
            # the bridge must not silently stall after setOptions(): it emits a
            # bounded interaction requirement and exposes exactly one fixed
            # requestSession entry point for the trusted activation transport.
            cast_framework_fallback = browser.new_page()
            cast_framework_fallback.set_content("<div>cast framework fallback</div>")
            cast_framework_fallback.add_script_tag(content=r"""
window.__castBridgeMessages = [];
window.__castRequestSessionCalls = 0;
window.__castContextListeners = new Map();
window.addEventListener('message', event => {
  const data = event.data;
  if (data?.channel === '__QEC_CAST_BRIDGE_V1__' && data?.direction === 'main-to-isolated') {
    window.__castBridgeMessages.push(data);
  }
});
window.__castContext = {
  getCurrentSession() { return null; },
  getCastState() { return 'NOT_CONNECTED'; },
  setOptions(options) { window.__castOptions = options; },
  addEventListener(type, fn) {
    const list = window.__castContextListeners.get(type) || [];
    list.push(fn);
    window.__castContextListeners.set(type, list);
  },
  removeEventListener(type, fn) {
    const list = window.__castContextListeners.get(type) || [];
    window.__castContextListeners.set(type, list.filter(item => item !== fn));
  },
  requestSession() {
    window.__castRequestSessionCalls += 1;
    return Promise.resolve(null);
  }
};
class MockRemotePlayer {
  constructor() {
    this.isConnected = false;
    this.isMediaLoaded = false;
    this.playerState = null;
    this.currentTime = 0;
    this.duration = 0;
  }
}
class MockRemotePlayerController {
  addEventListener() {}
  removeEventListener() {}
}
window.cast = { framework: {
  CastContext: { getInstance() { return window.__castContext; } },
  RemotePlayer: MockRemotePlayer,
  RemotePlayerController: MockRemotePlayerController,
  RemotePlayerEventType: {},
  CastContextEventType: {
    SESSION_STATE_CHANGED: 'SESSION_STATE_CHANGED',
    CAST_STATE_CHANGED: 'CAST_STATE_CHANGED'
  }
} };
window.chrome = { cast: {
  AutoJoinPolicy: { ORIGIN_SCOPED: 'ORIGIN_SCOPED' }
} };
""")
            cast_framework_fallback.add_script_tag(content=cast_bridge)
            cast_framework_fallback.evaluate("""
              window.postMessage({
                channel:'__QEC_CAST_BRIDGE_V1__', direction:'isolated-to-main', command:'REJOIN_SESSION',
                payload:{sessionId:'cast-123',receiverApplicationId:'CC1AD845'}
              }, '*')
            """)
            cast_framework_fallback.wait_for_function("window.__castBridgeMessages.some(m => m.event === 'CAST_CONTEXT_CONFIGURED')")
            cast_framework_fallback.wait_for_function("window.__castBridgeMessages.some(m => m.event === 'REJOIN_INTERACTION_REQUIRED' && m.payload.rejoinReason === 'REQUEST_SESSION_BY_ID_UNAVAILABLE')")
            request_result = cast_framework_fallback.evaluate("window.__QEC_CAST_TRUSTED_REQUEST_SESSION__()")
            assert request_result["ok"] is True
            assert cast_framework_fallback.evaluate("window.__castRequestSessionCalls") == 1
            cast_framework_fallback.wait_for_function("window.__castBridgeMessages.some(m => m.event === 'REQUEST_SESSION_CALLED')")
            cast_framework_fallback.wait_for_function("window.__castBridgeMessages.some(m => m.event === 'REQUEST_SESSION_RESOLVED')")

            # A stale/foreign Framework current session must not suppress the
            # retained-session by-id rejoin. Only the exact desired session id
            # counts as already rejoined.
            cast_session_mismatch = browser.new_page()
            cast_session_mismatch.set_content("<div>cast session mismatch</div>")
            cast_session_mismatch.add_script_tag(content=r"""
window.__castBridgeMessages = [];
window.__requestSessionByIdCalls = [];
window.addEventListener('message', event => {
  const data = event.data;
  if (data?.channel === '__QEC_CAST_BRIDGE_V1__' && data?.direction === 'main-to-isolated') {
    window.__castBridgeMessages.push(data);
  }
});
window.__foreignSession = {
  getSessionId() { return 'foreign-999'; },
  getCastDevice() { return { friendlyName: 'Other' }; },
  getApplicationMetadata() { return { applicationId: 'CC1AD845' }; },
  getMediaSession() { return null; },
  getSessionState() { return 'SESSION_STARTED'; },
  getSessionObj() { return null; }
};
window.__castContext = {
  getCurrentSession() { return window.__foreignSession; },
  getCastState() { return 'CONNECTED'; },
  setOptions(options) { window.__castOptions = options; },
  addEventListener() {},
  removeEventListener() {}
};
class MockRemotePlayer {
  constructor() {
    this.isConnected = true;
    this.isMediaLoaded = false;
    this.playerState = 'IDLE';
    this.currentTime = 0;
    this.duration = 0;
  }
}
class MockRemotePlayerController { addEventListener() {} removeEventListener() {} }
window.cast = { framework: {
  CastContext: { getInstance() { return window.__castContext; } },
  RemotePlayer: MockRemotePlayer,
  RemotePlayerController: MockRemotePlayerController,
  RemotePlayerEventType: {},
  CastContextEventType: {}
} };
window.chrome = { cast: {
  AutoJoinPolicy: { ORIGIN_SCOPED: 'ORIGIN_SCOPED' },
  requestSessionById(sessionId) { window.__requestSessionByIdCalls.push(sessionId); }
} };
""")
            cast_session_mismatch.add_script_tag(content=cast_bridge)
            cast_session_mismatch.evaluate("""
              window.postMessage({
                channel:'__QEC_CAST_BRIDGE_V1__', direction:'isolated-to-main', command:'REJOIN_SESSION',
                payload:{sessionId:'cast-123',receiverApplicationId:'CC1AD845'}
              }, '*')
            """)
            cast_session_mismatch.wait_for_function("window.__castBridgeMessages.some(m => m.event === 'REJOIN_REQUESTED')")
            assert cast_session_mismatch.evaluate("window.__requestSessionByIdCalls[0]") == "cast-123"

            # v0.5.7: when the next VOE page cannot own/rejoin the Cast session,
            # it may export its provider-owned JW playlist item exactly once. The
            # retiring sender passes that opaque item straight back into JW
            # requestCast(). QEC may transport the item transiently but must not
            # leak its media fields into status/diagnostic messages.
            relay_source = browser.new_page()
            relay_source.set_content("<div id='jw-relay-source' class='jwplayer' style='width:640px;height:360px'></div>")
            relay_source.add_script_tag(content=BOOTSTRAP + "\n" + r"""
window.__relaySourceHandlers = new Map();
window.__relaySourceCalls = [];
window.__relayOpaqueItem = {
  title: 'Episode Relay',
  file: 'https://media.example.invalid/relay-next.m3u8',
  sources: [{file:'https://media.example.invalid/relay-next.m3u8', type:'hls'}]
};
window.__relaySourcePlayer = {
  on(name, fn) { const list = window.__relaySourceHandlers.get(name) || []; list.push(fn); window.__relaySourceHandlers.set(name, list); },
  off() {},
  getState() { return 'idle'; },
  getPosition() { return 0; },
  getDuration() { return 100; },
  getVolume() { return 80; },
  getMute() { return false; },
  getFullscreen() { return false; },
  getPlaylistItem() { window.__relaySourceCalls.push('getPlaylistItem'); return window.__relayOpaqueItem; },
  play() { window.__relaySourceCalls.push('play'); },
  pause() {}, setControls() {}, setAllowFullscreen() {}, resize() {}
};
window.jwplayer = function () { return window.__relaySourcePlayer; };
""")
            relay_source.add_script_tag(content=jw_bridge)
            relay_source.add_script_tag(content=agent)
            relay_source.evaluate("""
              new Promise(resolve => window.__qecListener(
                {version:1,sessionId:'relay-session',epoch:2,type:'PROVIDER_ATTACH',payload:{provider:'VOE',castSessionId:'cast-123',castReceiverApplicationId:'CC1AD845',castRelayMode:true}},
                {}, resolve
              ))
            """)
            relay_source.wait_for_function("window.__qecMessages.some(m => m.type === 'CAST_RELAY_ITEM')")
            assert relay_source.evaluate("window.__relaySourceCalls.includes('getPlaylistItem')") is True
            assert relay_source.evaluate("window.__relaySourceCalls.includes('play')") is False
            relay_payload = relay_source.evaluate("window.__qecMessages.find(m => m.type === 'CAST_RELAY_ITEM').payload.item")
            assert relay_payload["title"] == "Episode Relay"
            assert relay_payload["file"] == "https://media.example.invalid/relay-next.m3u8"
            assert relay_source.evaluate("window.__qecMessages.filter(m => m.type !== 'CAST_RELAY_ITEM').some(m => JSON.stringify(m).includes('media.example.invalid'))") is False

            relay_sender = browser.new_page()
            relay_sender.set_content("<div id='jw-relay-sender' class='jwplayer' style='width:640px;height:360px'></div>")
            relay_sender.add_script_tag(content=BOOTSTRAP + "\n" + r"""
window.__relaySenderHandlers = new Map();
window.__relaySenderCalls = [];
window.__relaySenderState = 'idle';
window.__relaySenderPlayer = {
  on(name, fn) { const list = window.__relaySenderHandlers.get(name) || []; list.push(fn); window.__relaySenderHandlers.set(name, list); },
  off() {},
  getState() { return window.__relaySenderState; },
  getPosition() { return 0; },
  getDuration() { return 100; },
  getVolume() { return 80; },
  getMute() { return false; },
  getFullscreen() { return false; },
  play() {}, pause() {}, setControls() {}, setAllowFullscreen() {}, resize() {},
  requestCast(items) {
    window.__relaySenderCalls.push(['requestCast', items]);
    return Promise.resolve();
  }
};
window.jwplayer = function () { return window.__relaySenderPlayer; };
""")
            relay_sender.add_script_tag(content=jw_bridge)
            relay_sender.add_script_tag(content=agent)
            relay_sender.evaluate("""
              new Promise(resolve => window.__qecListener(
                {version:1,sessionId:'old-session',epoch:1,type:'PROVIDER_ATTACH',payload:{provider:'VOE'}},
                {}, resolve
              ))
            """)
            relay_sender.wait_for_function("window.__qecMessages.some(m => m.type === 'MEDIA_FOUND' && m.payload.playerKind === 'JWPlayer')")
            relay_sender.evaluate("""(item) => new Promise(resolve => window.__qecListener(
              {version:1,sessionId:'relay-session',epoch:2,type:'CAST_RELAY_APPLY',payload:{transferId:'relay-session:2:cast-relay',item}},
              {}, resolve
            ))""", relay_payload)
            relay_sender.wait_for_function("window.__relaySenderCalls.some(call => Array.isArray(call) && call[0] === 'requestCast')")
            relayed_item = relay_sender.evaluate("window.__relaySenderCalls.find(call => Array.isArray(call) && call[0] === 'requestCast')[1][0]")
            assert relayed_item["title"] == "Episode Relay"
            assert relayed_item["file"] == "https://media.example.invalid/relay-next.m3u8"
            relay_sender.evaluate("""
              window.postMessage({
                channel:'__QEC_CAST_BRIDGE_V1__', direction:'main-to-isolated', event:'REMOTE_PLAYING',
                payload:{connected:true,sessionId:'cast-123',deviceName:'Seb',receiverApplicationId:'CC1AD845',mediaPlayerState:'PLAYING'}
              }, '*')
            """)
            relay_sender.wait_for_function("window.__qecMessages.some(m => m.type === 'CAST_RELAY_PLAYING' && m.payload.transferId === 'relay-session:2:cast-relay')")
            assert relay_sender.evaluate("window.__qecMessages.some(m => m.type === 'CAST_RELAY_PLAYING' && m.payload.playerKind === 'GoogleCast')") is True
            assert relay_sender.evaluate("window.__qecMessages.some(m => m.type !== 'CAST_RELAY_ITEM' && JSON.stringify(m).includes('media.example.invalid'))") is False

            print("PROVIDER FIXTURE TESTS: PASS")
            print(" exercised: MEDIA_FOUND MEDIA_PLAYING MEDIA_ENDED MEDIA_REPLACED START_RETRY AUTOPLAY_BLOCKED USER_START_CONTROLS PRE_VIDEO_ACTIVATION JW_NATIVE_DRIVER JW_VIEWPORT_RESIZE JW_SPACE_TOGGLE TARGETED_BACKGROUND_SPACE_ACTIVATION HTML5_PROVIDER_UI HTML5_STICKY_CAST_REJOIN CAST_FRAMEWORK_REQUEST_SESSION_FALLBACK HTML5_BACKGROUND_USER_GESTURE CAST_SESSION_REJOIN CAST_TRUSTED_NATIVE_CONTROL CAST_JW_CAST_EVENT CAST_CONTEXT_BOOTSTRAP CAST_DUAL_LOAD_MEDIA_TRACE CAST_REMOTE_EVENT_END CAST_REMOTE_LEGACY_MEDIA_FALLBACK CAST_SENDER_OVERLAP CAST_OPAQUE_JW_RELAY CHROME_EARLY_TRUSTED_ESCALATION")
            return 0
        finally:
            browser.close()


if __name__ == "__main__":
    raise SystemExit(main())
