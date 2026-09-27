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

            print("PROVIDER FIXTURE TESTS: PASS")
            print(" exercised: MEDIA_FOUND MEDIA_PLAYING MEDIA_ENDED MEDIA_REPLACED START_RETRY AUTOPLAY_BLOCKED USER_START_CONTROLS PRE_VIDEO_ACTIVATION JW_NATIVE_DRIVER JW_VIEWPORT_RESIZE JW_SPACE_TOGGLE TARGETED_BACKGROUND_SPACE_ACTIVATION HTML5_PROVIDER_UI HTML5_BACKGROUND_USER_GESTURE")
            return 0
        finally:
            browser.close()


if __name__ == "__main__":
    raise SystemExit(main())
