# Vision — Quiet Episode Controller

## Product Truth

Quiet Episode Controller is a small Chromium/Edge Manifest V3 extension that removes repetitive browser interaction from episodic playback without taking over the user's OS mouse, keyboard, or foreground application.

The initial episode source is `aniworld.to`. Current provider families are VOE and DoodStream. FileMoon is explicitly deferred because its current CAPTCHA/user-gate conflicts with hands-free playback; the extension does not automate or bypass that gate. Providers are integrations, not the architecture.

## Desired experience

The user opens an episode on a supported source site in a **controller tab** and explicitly starts the extension. Initial supported sources are AniWorld, SerienStream, and the SerienStream IP mirror.

After that:

1. the controller tab remains open for episode identity, next-episode logic, and provider entry links;
2. the extension opens exactly one temporary **playback tab** for the selected provider redirect;
3. provider redirects settle in that top-level playback tab;
4. the extension requests access to the currently loaded provider origin when needed;
5. the provider agent detects the actual player technology, preserves a recognized native player UI/API (initially JW Player 8), and falls back to ordinary HTML `<video>` control only when needed;
6. when the media ends, the playback tab closes;
7. the controller tab navigates to the next episode;
8. a fresh playback tab is created for that episode;
9. the cycle repeats until no next episode exists or the user stops it.

The user may game or work in another application while this runs. Normal progression must not move the OS mouse, synthesize keys, Alt-Tab, or repeatedly force browser focus.

## Fullscreen intent

The browser window may enter fullscreen once after the first provider is permission-ready and attached. The recognized native player container is styled to fill the browser viewport while preserving its own controls/keyboard behavior. Only the generic HTML5 fallback promotes the `<video>` itself. This avoids repeated player-native fullscreen requests and their user-activation constraints.

## Failure behavior

When safe unattended continuation is not possible:
- keep the user's foreground application untouched;
- preserve the controller session where practical;
- expose a passive blocked state such as `PROVIDER_PERMISSION_REQUIRED`, `AUTOPLAY_BLOCKED`, or `PLAYER_NOT_FOUND`;
- never fall back to OS input simulation.

## Scope boundary

The extension controls normal browser navigation and playback only. It does not download media, extract protected stream URLs, bypass DRM/access controls, automate credentials, or defeat provider security mechanisms.
