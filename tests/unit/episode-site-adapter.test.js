import test from "node:test";
import assert from "node:assert/strict";

await import("../../src/sites/episode-site-adapter.js");
const adapter = globalThis.QEC_EpisodeSite;

test("supported episode sources parse into one canonical identity contract", () => {
  const cases = [
    ["https://aniworld.to/anime/stream/black-torch/staffel-1/episode-1", "aniworld", "black-torch"],
    ["https://serienstream.to/serie/last-seen/staffel-1/episode-3", "serienstream", "last-seen"],
    ["https://serienstream.to/serie/stream/found-2023/staffel-2/episode-17", "serienstream", "found-2023"],
    ["https://s.to/serie/last-seen/staffel-1/episode-3", "serienstream", "last-seen"],
    ["https://serienstream.cx/serie/last-seen/staffel-1/episode-3", "serienstream", "last-seen"],
    ["http://186.2.175.5/serie/trashtvwaskeinersehenwl/staffel-10/episode-13", "serienstream-ip", "trashtvwaskeinersehenwl"],
    ["http://186.2.175.5/serie/stream/lost-found-music-studios/staffel-2/episode-17", "serienstream-ip", "lost-found-music-studios"]
  ];

  for (const [url, site, slug] of cases) {
    const parsed = adapter.parseEpisodeUrl(url);
    assert.deepEqual(
      { site: parsed.site, seriesSlug: parsed.seriesSlug, season: parsed.season, episode: parsed.episode },
      { site, seriesSlug: slug, season: Number(url.match(/staffel-(\d+)/i)[1]), episode: Number(url.match(/episode-(\d+)/i)[1]) }
    );
  }

  assert.equal(adapter.parseEpisodeUrl("https://example.com/serie/x/staffel-1/episode-1"), null);
});

test("next episode is derived from links on the same controller origin and not guessed", () => {
  const current = adapter.parseEpisodeUrl("https://serienstream.to/serie/last-seen/staffel-1/episode-3");
  const next = adapter.nextEpisodeFromHrefs(current, [
    "https://serienstream.to/serie/last-seen/staffel-1/episode-6",
    "https://serienstream.to/serie/last-seen/staffel-1/episode-4",
    "http://186.2.175.5/serie/last-seen/staffel-1/episode-4",
    "https://serienstream.to/serie/other/staffel-1/episode-4"
  ]);
  assert.equal(next.episode, 4);
  assert.equal(next.origin, "https://serienstream.to");
});

test("same episode and lower episodes do not create a loop", () => {
  const current = adapter.parseEpisodeUrl("http://186.2.175.5/serie/last-seen/staffel-1/episode-2");
  const next = adapter.nextEpisodeFromHrefs(current, [
    "http://186.2.175.5/serie/last-seen/staffel-1/episode-1",
    "http://186.2.175.5/serie/last-seen/staffel-1/episode-2"
  ]);
  assert.equal(next, null);
});
