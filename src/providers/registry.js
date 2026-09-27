const NORMALIZED = new Map([
  ["voe", "VOE"],
  ["doodstream", "Doodstream"],
  ["dood", "Doodstream"]
]);

export const SUPPORTED_PROVIDERS = Object.freeze(["VOE", "Doodstream"]);
export const DEFAULT_PROVIDER_PRIORITY = Object.freeze(["VOE", "Doodstream"]);

export function canonicalProviderName(name) {
  const raw = String(name ?? "").trim();
  const lower = raw.toLowerCase();
  for (const [needle, canonical] of NORMALIZED) {
    if (lower.includes(needle)) return canonical;
  }
  return raw || "Unknown";
}

export function chooseProvider(candidates, priority = DEFAULT_PROVIDER_PRIORITY, { excludeProviders = [] } = {}) {
  const supported = new Set(SUPPORTED_PROVIDERS);
  const excluded = new Set((excludeProviders ?? []).map(canonicalProviderName));
  const available = (candidates ?? [])
    .filter((item) => item && item.available !== false)
    .map((item) => ({ ...item, provider: canonicalProviderName(item.provider) }))
    .filter((item) => supported.has(item.provider) && !excluded.has(item.provider));

  if (!available.length) return null;

  for (const preferred of priority) {
    const wanted = canonicalProviderName(preferred);
    if (!supported.has(wanted)) continue;
    const hit = available.find((item) => item.provider === wanted);
    if (hit) return hit;
  }
  return null;
}
