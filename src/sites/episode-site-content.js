(() => {
  if (globalThis.__QEC_EPISODE_SITE_CONTENT__) return;
  globalThis.__QEC_EPISODE_SITE_CONTENT__ = true;

  const VERSION = 1;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.version !== VERSION) return;

    if (message.type === "SITE_PROBE") {
      try {
        sendResponse({ ok: true, probe: globalThis.QEC_EpisodeSite.probe(document, location, globalThis) });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
      return true;
    }
  });
})();
