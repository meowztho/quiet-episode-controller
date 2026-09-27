from pathlib import Path
import shutil

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
CHROMIUM = shutil.which("chromium") or shutil.which("chromium-browser")

SITES = [
    {
        "name": "AniWorld",
        "base": "https://aniworld.to/anime/stream/black-torch/staffel-1/episode-1",
        "episode_1": "/anime/stream/black-torch/staffel-1/episode-1",
        "episode_2": "/anime/stream/black-torch/staffel-1/episode-2",
        "episode_3": "/anime/stream/black-torch/staffel-1/episode-3",
        "site": "aniworld",
    },
    {
        "name": "SerienStream",
        "base": "https://serienstream.to/serie/last-seen/staffel-1/episode-1",
        "episode_1": "/serie/last-seen/staffel-1/episode-1",
        "episode_2": "/serie/last-seen/staffel-1/episode-2",
        "episode_3": "/serie/last-seen/staffel-1/episode-3",
        "site": "serienstream",
    },
    {
        "name": "S.to mirror",
        "base": "https://s.to/serie/last-seen/staffel-1/episode-1",
        "episode_1": "/serie/last-seen/staffel-1/episode-1",
        "episode_2": "/serie/last-seen/staffel-1/episode-2",
        "episode_3": "/serie/last-seen/staffel-1/episode-3",
        "site": "serienstream",
    },
    {
        "name": "SerienStream CX mirror",
        "base": "https://serienstream.cx/serie/last-seen/staffel-1/episode-1",
        "episode_1": "/serie/last-seen/staffel-1/episode-1",
        "episode_2": "/serie/last-seen/staffel-1/episode-2",
        "episode_3": "/serie/last-seen/staffel-1/episode-3",
        "site": "serienstream",
    },
    {
        "name": "SerienStream IP",
        "base": "http://186.2.175.5/serie/last-seen/staffel-1/episode-1",
        "episode_1": "/serie/last-seen/staffel-1/episode-1",
        "episode_2": "/serie/last-seen/staffel-1/episode-2",
        "episode_3": "/serie/last-seen/staffel-1/episode-3",
        "site": "serienstream-ip",
    },
]


def fixture(site):
    if site["site"] == "aniworld":
        providers = """
  <div class="hosterSiteVideo">
    <ul>
      <li data-link-id="111" data-lang-key="1"><a class="watchEpisode" href="/redirect/111"><h4>VOE</h4></a></li>
      <li data-link-id="333" data-lang-key="1"><a class="watchEpisode" href="/redirect/333"><h4>Doodstream</h4></a></li>
    </ul>
  </div>
"""
    else:
        providers = """
  <div class="player-wrap"><iframe id="player-iframe"></iframe></div>
  <div id="episode-links">
    <button class="link-box active" data-provider-name="VOE" data-provider-id="1" data-language-id="1" data-play-url="https://voe.sx/e/fixture-voe">VOE</button>
    <button class="link-box" data-provider-name="Doodstream" data-provider-id="2" data-language-id="1" data-play-url="https://playmogo.com/e/fixture-dood">Doodstream</button>
  </div>
"""

    return f"""
<!doctype html>
<html>
<head><base href="{site['base']}"></head>
<body>
  <nav id="episode-nav">
    <a href="{site['episode_1']}">Episode 1</a>
    <a href="{site['episode_2']}">Episode 2</a>
    <a href="{site['episode_3']}">Episode 3</a>
  </nav>
  {providers}
</body>
</html>
"""


def fail(message: str) -> None:
    raise AssertionError(message)


def main() -> int:
    if not CHROMIUM:
        print("DOM FIXTURE TESTS: INCONCLUSIVE - Chromium not found")
        return 2

    adapter = (ROOT / "src/sites/episode-site-adapter.js").read_text(encoding="utf-8")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, executable_path=CHROMIUM, args=["--no-sandbox"])
        page = browser.new_page()
        try:
            for site in SITES:
                html = fixture(site)
                page.set_content(html)
                page.add_script_tag(content=adapter)

                probe = page.evaluate(
                    f"QEC_EpisodeSite.probe(document, {{href: {site['base']!r}}}, window)"
                )
                if not probe.get("supported"):
                    fail(f"{site['name']}: expected supported probe, got {probe!r}")
                if probe["episodeIdentity"]["site"] != site["site"]:
                    fail(f"{site['name']}: unexpected site identity: {probe!r}")
                if probe["episodeIdentity"]["episode"] != 1:
                    fail(f"{site['name']}: unexpected current episode: {probe!r}")
                if probe["nextEpisode"]["episode"] != 2:
                    fail(f"{site['name']}: unexpected next episode: {probe!r}")

                providers = probe["providers"]
                if [p["provider"] for p in providers] != ["VOE", "Doodstream"]:
                    fail(f"{site['name']}: unexpected provider order: {providers!r}")
                if [p["activation"]["kind"] for p in providers] != ["provider-navigation"] * 2:
                    fail(f"{site['name']}: providers did not converge to provider-navigation: {providers!r}")
                expected_targets = (["/redirect/111", "/redirect/333"] if site["site"] == "aniworld"
                                    else ["https://voe.sx/e/fixture-voe", "https://playmogo.com/e/fixture-dood"])
                if [p["activation"]["target"] for p in providers] != expected_targets:
                    fail(f"{site['name']}: unexpected provider targets: {providers!r}")
                if site["site"] != "aniworld":
                    if [p["metadata"].get("layout") for p in providers] != ["sto-new", "sto-new"]:
                        fail(f"{site['name']}: new S.to layout metadata missing: {providers!r}")

                no_loop_html = html.replace(
                    f'<a href="{site["episode_2"]}">Episode 2</a>',
                    f'<a href="{site["episode_1"]}">Episode 1 duplicate</a>'
                )
                page.set_content(no_loop_html)
                page.add_script_tag(content=adapter)
                no_loop = page.evaluate(
                    f"QEC_EpisodeSite.probe(document, {{href: {site['base']!r}}}, window)"
                )
                if no_loop["nextEpisode"]["episode"] != 3:
                    fail(f"{site['name']}: same-episode link was not skipped: {no_loop!r}")

            page.set_content("<html><body></body></html>")
            page.add_script_tag(content=adapter)
            unsupported = page.evaluate(
                "QEC_EpisodeSite.probe(document, {href: 'https://example.com/not-an-episode'}, window)"
            )
            if unsupported.get("supported"):
                fail(f"unsupported URL did not fail closed: {unsupported!r}")

            print("DOM FIXTURE TESTS: PASS")
            print(" verified: AniWorld + SerienStream + s.to + serienstream.cx + SerienStream-IP episode/provider contract")
            return 0
        finally:
            browser.close()


if __name__ == "__main__":
    raise SystemExit(main())
