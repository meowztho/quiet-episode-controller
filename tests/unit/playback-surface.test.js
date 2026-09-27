import test from "node:test";
import assert from "node:assert/strict";

const state = {
  nextTabId: 30,
  created: [],
  updated: [],
  removed: [],
  frames: []
};

globalThis.chrome = {
  tabs: {
    async create(options) {
      const tab = { id: state.nextTabId++, ...options };
      state.created.push(tab);
      return tab;
    },
    async update(tabId, patch) {
      state.updated.push({ tabId, ...patch });
      return { id: tabId, ...patch };
    },
    async remove(tabId) { state.removed.push(tabId); }
  },
  webNavigation: {
    async getFrame() {
      if (!state.frames.length) return null;
      if (state.frames.length === 1) return { ...state.frames[0] };
      return { ...state.frames.shift() };
    }
  }
};

const {
  providerEntryUrl,
  currentPlaybackDocument,
  waitForExternalPlaybackDocument,
  openPlaybackSurface,
  activatePlaybackSurface
} = await import(`../../src/providers/playback-surface.js?test=${Date.now()}`);

test("provider candidate resolves to a top-level navigation entry", () => {
  const url = providerEntryUrl(
    { activation: { kind: "provider-navigation", target: "/redirect/11" } },
    "https://aniworld.to/anime/stream/x/staffel-1/episode-1"
  );
  assert.equal(url.href, "https://aniworld.to/redirect/11");
  assert.equal(providerEntryUrl({ activation: { kind: "external-embed", target: "https://x.test" } }, "https://aniworld.to"), null);
  const serienstream = providerEntryUrl(
    { activation: { kind: "provider-navigation", target: "/redirect/22" } },
    "https://serienstream.to/serie/x/staffel-1/episode-1"
  );
  assert.equal(serienstream.href, "https://serienstream.to/redirect/22");

  const directProvider = providerEntryUrl(
    { activation: { kind: "provider-navigation", target: "https://playmogo.com/e/direct" } },
    "https://serienstream.to/serie/example/staffel-1/episode-1"
  );
  assert.equal(directProvider.href, "https://playmogo.com/e/direct");
});

test("current playback document describes the top-level provider page", async () => {
  state.frames = [{ frameId: 0, parentFrameId: -1, documentId: "doc-1", url: "https://voe.sx/e/example" }];
  assert.deepEqual(await currentPlaybackDocument(30), {
    tabId: 30,
    frameId: 0,
    documentId: "doc-1",
    url: "https://voe.sx/e/example",
    origin: "https://voe.sx"
  });
});

test("playback navigation waits until the provider leaves the controller site and settles", async () => {
  state.frames = [
    { frameId: 0, documentId: "redirect", url: "https://aniworld.to/redirect/11" },
    { frameId: 0, documentId: "provider", url: "https://voe.sx/e/example" },
    { frameId: 0, documentId: "provider", url: "https://voe.sx/e/example" }
  ];
  const result = await waitForExternalPlaybackDocument(30, "https://aniworld.to", {
    timeoutMs: 100,
    intervalMs: 1,
    stableObservations: 2
  });
  assert.equal(result.origin, "https://voe.sx");
  assert.equal(result.documentId, "provider");
});

test("opening a playback surface discovers provider origin in an inactive tab", async () => {
  state.created = [];
  state.updated = [];
  state.removed = [];
  state.frames = [
    { frameId: 0, documentId: "provider", url: "https://player.example/e/abc" },
    { frameId: 0, documentId: "provider", url: "https://player.example/e/abc" }
  ];
  const opened = await openPlaybackSurface({
    windowId: 20,
    candidate: { activation: { kind: "provider-navigation", target: "/redirect/22" } },
    baseUrl: "https://aniworld.to/anime/stream/x/staffel-1/episode-1",
    timeoutMs: 100,
    intervalMs: 1
  });
  assert.equal(opened.tabId, state.created[0].id);
  assert.equal(state.created[0].url, "https://aniworld.to/redirect/22");
  assert.equal(state.created[0].active, false);
  assert.equal(opened.document.origin, "https://player.example");
  await activatePlaybackSurface(opened.tabId);
  assert.deepEqual(state.updated, [{ tabId: opened.tabId, active: true }]);
});
