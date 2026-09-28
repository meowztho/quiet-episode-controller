# AGENTS.md

You are implementing **Quiet Episode Controller** from the canonical project authorities.

## Mandatory startup

At repository start, after context loss, or after changing directories:

1. identify repository root;
2. read `PROJECT_INDEX.yaml`;
3. read the canonical authorities required for `STATE.yaml.current_stage`;
4. inspect `git status` and relevant diffs;
5. run `python scripts/project_gate.py`;
6. only then make material edits.

If the `core-first-governance` skill/plugin is available, load and apply it in addition to these authorities. Do not pretend it was used if unavailable.

## Change discipline

Prefer, in order: reuse > configure/compose > correct/extend > create new ownership.

Use the smallest robust reversible change. Do not introduce frameworks, bundlers, abstractions, dependencies, permissions, files, or cleanup without a demonstrated need.

Do not redesign Product Truth. Reversible technical choices are yours unless an authority marks them as a user decision.

Preserve foreign changes. Never discard unrelated work.

## Product-specific hard guardrails

- No OS mouse movement.
- No OS keyboard synthesis.
- No arbitrary/OS coordinate automation. Semantic Cast-control pointer clicks are admitted only under the bounded rules below.
- No repeated focus stealing after session activation.
- No media downloading, DRM circumvention, general stream extraction, credential automation, or anti-access-control bypass. The only media-bearing exception is D-028: during same-provider JW Cast continuity, the next provider tab may relay its current provider-owned JW playlist item once, opaquely and transiently, to the retained Cast sender solely for `jwplayer().requestCast([item])`. QEC must not persist, log, inspect, reconstruct, or reuse its media fields, and must not construct `MediaInfo`/`LoadRequest` or call `loadMedia()` itself.
- Provider-specific selectors/quirks stay in provider adapters.
- Episode-site selectors/quirks stay in site adapters.
- The Session Core consumes canonical adapter contracts; it must not know VOE/Doodstream/AniWorld DOM details.
- Detect reusable player technology first (for example JW Player), use its native API/UI when available, and fall back to generic HTMLMediaElement control only when no supported player driver exists.
- Keep the controller tab stable and allow exactly one canonical playback tab per episode. During D-028 Cast continuity only, one retiring sender tab may overlap with one next-episode helper tab until remote `PLAYING` or bounded fallback resolves the handoff; this overlap must not become a general multi-playback-tab lifecycle.
- Privileged browser activation may use `chrome.debugger` only through `src/providers/gesture-activation.js` and only against the canonical playback tab. Admitted actions are: one fixed JW Space rawKeyDown/keyUp pair; one HTML5 `userGesture:true` play call on the already-marked canonical media; one retained-Cast pointer move/press/release targeted only at the visible semantic JW `.jw-icon-cast` control; one retained-HTML5-Cast pointer move/press/release targeted only at a visible semantic Cast control inside the already-marked canonical HTML5 player surface (`google-cast-launcher`, known player Cast-control classes, or Cast-labelled button); and, only when that HTML5 control is absent and silent `requestSessionById` is unavailable/exhausted, one `userGesture:true` call to the Cast MAIN-world bridge's fixed `__QEC_CAST_TRUSTED_REQUEST_SESSION__` entry point. That bridge may call only Google `CastContext.requestSession()` to open the Google-owned Cast session UI; QEC must not select a receiver or construct/load media. Detach immediately. Other keys, arbitrary pointer targets/coordinates, arbitrary Runtime.evaluate code, Network/DOM/Fetch/Storage inspection, OS input, focus forcing, and general debugger use are forbidden.
- If unattended continuation is still blocked after the bounded trusted-activation attempt, enter a passive blocked state rather than escalating to intrusive input simulation.

## Verification

Use the narrowest relevant checks first. Fixture tests prove parser/state-machine logic only. They do not prove live provider compatibility.

Live/browser claims require browser execution evidence. Record evidence in `authority/ACCEPTANCE_EVIDENCE.yaml`, then update `authority/STATE.yaml`. Never move STATE ahead of evidence.

Run `python scripts/build_atlas.py` after material authority changes, then `python scripts/project_gate.py`.

Product Complete is derived, not asserted.
