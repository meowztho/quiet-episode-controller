(() => {
  const SITE_PROFILES = Object.freeze([
    Object.freeze({
      id: "aniworld",
      hosts: Object.freeze(["aniworld.to"]),
      episodeRe: /^\/anime\/stream\/([^/]+)\/staffel-(\d+)\/episode-(\d+)\/?$/i
    }),
    Object.freeze({
      id: "serienstream",
      hosts: Object.freeze(["serienstream.to", "s.to", "serienstream.cx"]),
      episodeRe: /^\/serie\/(?:stream\/)?([^/]+)\/staffel-(\d+)\/episode-(\d+)\/?$/i
    }),
    Object.freeze({
      id: "serienstream-ip",
      hosts: Object.freeze(["186.2.175.5"]),
      episodeRe: /^\/serie\/(?:stream\/)?([^/]+)\/staffel-(\d+)\/episode-(\d+)\/?$/i
    })
  ]);

  function siteProfile(url) {
    return SITE_PROFILES.find((profile) => profile.hosts.includes(url.hostname)) ?? null;
  }

  function parseEpisodeUrl(input) {
    try {
      const url = input instanceof URL ? input : new URL(input);
      if (!/^https?:$/.test(url.protocol)) return null;
      const profile = siteProfile(url);
      if (!profile) return null;
      const match = url.pathname.match(profile.episodeRe);
      if (!match) return null;
      return {
        site: profile.id,
        origin: url.origin,
        seriesSlug: match[1],
        season: Number(match[2]),
        episode: Number(match[3]),
        url: `${url.origin}${url.pathname.replace(/\/$/, "")}`
      };
    } catch {
      return null;
    }
  }

  function nextEpisodeFromHrefs(current, hrefs) {
    if (!current) return null;
    const options = [];
    for (const href of hrefs ?? []) {
      const candidate = parseEpisodeUrl(href);
      if (!candidate) continue;
      if (candidate.origin !== current.origin || candidate.seriesSlug !== current.seriesSlug) continue;
      const greater = candidate.season > current.season ||
        (candidate.season === current.season && candidate.episode > current.episode);
      if (greater) options.push(candidate);
    }
    options.sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
    return options[0] ?? null;
  }

  function text(el) {
    return String(el?.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  function providerLabel(element, index) {
    const anchor = element?.matches?.("a") ? element : element?.querySelector?.("a[href]");
    const image = element?.querySelector?.("img") || anchor?.querySelector?.("img");
    const candidates = [
      text(element?.querySelector?.("h4")),
      image?.getAttribute?.("alt"),
      image?.getAttribute?.("title"),
      anchor?.getAttribute?.("title"),
      text(anchor),
      text(element)
    ];
    return candidates.find((value) => String(value ?? "").trim()) || `Provider ${index + 1}`;
  }

  function isVisible(el, view) {
    if (!el) return false;
    if (el.hidden) return false;
    if (el.style?.display === "none") return false;
    try {
      const style = view?.getComputedStyle?.(el);
      if (style?.display === "none" || style?.visibility === "hidden") return false;
    } catch {}
    return true;
  }

  function candidateFromElement(element, index, view) {
    const anchor = element?.matches?.("a[href*='/redirect/']")
      ? element
      : element?.querySelector?.("a[href*='/redirect/']");
    const linkId = element?.dataset?.linkId || element?.getAttribute?.("data-link-id") ||
      anchor?.dataset?.linkId || anchor?.getAttribute?.("data-link-id") || null;
    const target = element?.dataset?.linkTarget || element?.getAttribute?.("data-link-target") ||
      anchor?.dataset?.linkTarget || anchor?.getAttribute?.("data-link-target") ||
      anchor?.getAttribute?.("href") || (linkId ? `/redirect/${linkId}` : null);
    if (!target) return null;

    const externalEmbed = (element?.dataset?.externalEmbed || element?.getAttribute?.("data-external-embed") ||
      anchor?.dataset?.externalEmbed || anchor?.getAttribute?.("data-external-embed")) === "true";
    const languageOwner = element?.closest?.("[data-lang-key]") || anchor?.closest?.("[data-lang-key]");

    return {
      key: linkId || anchor?.getAttribute?.("href") || `${index}`,
      provider: providerLabel(element, index),
      available: isVisible(element, view) && (!anchor || isVisible(anchor, view)),
      activation: {
        kind: externalEmbed ? "external-embed" : "provider-navigation",
        target
      },
      metadata: {
        langKey: element?.dataset?.langKey || element?.getAttribute?.("data-lang-key") ||
          anchor?.dataset?.langKey || anchor?.getAttribute?.("data-lang-key") ||
          languageOwner?.getAttribute?.("data-lang-key") || null
      }
    };
  }

  function candidateFromNewStoButton(element, index, view) {
    const target = element?.dataset?.playUrl || element?.getAttribute?.("data-play-url") || null;
    if (!target) return null;

    const provider = element?.dataset?.providerName || element?.getAttribute?.("data-provider-name") ||
      providerLabel(element, index);

    return {
      key: element?.dataset?.linkId || element?.getAttribute?.("data-link-id") ||
        element?.dataset?.providerId || element?.getAttribute?.("data-provider-id") ||
        `${provider}:${index}`,
      provider,
      available: isVisible(element, view),
      activation: {
        kind: "provider-navigation",
        target
      },
      metadata: {
        langKey: element?.dataset?.languageId || element?.getAttribute?.("data-language-id") || null,
        layout: "sto-new"
      }
    };
  }

  function providerCandidates(document, view) {
    const newStoButtons = Array.from(document.querySelectorAll("#episode-links .link-box[data-play-url]"));
    const newStoCandidates = newStoButtons
      .map((element, index) => candidateFromNewStoButton(element, index, view))
      .filter(Boolean);
    if (newStoCandidates.length) return newStoCandidates;

    const primary = Array.from(document.querySelectorAll(".hosterSiteVideo > ul > li"));
    const primaryCandidates = primary
      .map((element, index) => candidateFromElement(element, index, view))
      .filter(Boolean);
    if (primaryCandidates.length) return primaryCandidates;

    const anchors = Array.from(document.querySelectorAll("a[href*='/redirect/']"));
    return anchors
      .map((anchor, index) => candidateFromElement(anchor, index, view))
      .filter(Boolean);
  }

  function probe(document, locationLike, view = globalThis) {
    const href = locationLike?.href ?? String(locationLike ?? "");
    const current = parseEpisodeUrl(href);
    if (!current) {
      return { supported: false, episodeIdentity: null, nextEpisode: null, providers: [], diagnostics: ["URL_NOT_SUPPORTED"] };
    }

    const hrefs = Array.from(document.querySelectorAll("a[href]"), (anchor) => anchor.href || anchor.getAttribute("href"));
    const nextEpisode = nextEpisodeFromHrefs(current, hrefs);
    const providers = providerCandidates(document, view);

    return {
      supported: true,
      episodeIdentity: current,
      nextEpisode,
      providers,
      diagnostics: [
        `SITE:${current.site}`,
        nextEpisode ? "NEXT_EPISODE_FOUND" : "NEXT_EPISODE_NOT_FOUND",
        providers.length ? `PROVIDERS_FOUND:${providers.length}` : "PROVIDERS_NOT_FOUND"
      ]
    };
  }

  globalThis.QEC_EpisodeSite = Object.freeze({
    SITE_PROFILES,
    parseEpisodeUrl,
    nextEpisodeFromHrefs,
    providerCandidates,
    probe
  });
})();
