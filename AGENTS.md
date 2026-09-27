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
- No coordinate automation.
- No repeated focus stealing after session activation.
- No media downloading, DRM circumvention, stream extraction, credential automation, or anti-access-control bypass.
- Provider-specific selectors/quirks stay in provider adapters.
- Episode-site selectors/quirks stay in site adapters.
- The Session Core consumes canonical adapter contracts; it must not know VOE/Doodstream/AniWorld DOM details.
- Detect reusable player technology first (for example JW Player), use its native API/UI when available, and fall back to generic HTMLMediaElement control only when no supported player driver exists.
- Keep the AniWorld controller tab stable and allow exactly one canonical temporary playback tab per episode; do not create extra playback windows/tabs outside that lifecycle.
- Hands-free JW autoplay recovery may use the admitted `chrome.debugger` transport only through `src/providers/gesture-activation.js`, only against the canonical playback tab, and only for one fixed CDP Space rawKeyDown/keyUp pair; detach immediately after the pair. Other keys, mouse/pointer events, Network/DOM inspection, OS input, focus forcing, coordinates, and general debugger use are forbidden.
- If unattended continuation is still blocked after the bounded trusted-activation attempt, enter a passive blocked state rather than escalating to intrusive input simulation.

## Verification

Use the narrowest relevant checks first. Fixture tests prove parser/state-machine logic only. They do not prove live provider compatibility.

Live/browser claims require browser execution evidence. Record evidence in `authority/ACCEPTANCE_EVIDENCE.yaml`, then update `authority/STATE.yaml`. Never move STATE ahead of evidence.

Run `python scripts/build_atlas.py` after material authority changes, then `python scripts/project_gate.py`.

Product Complete is derived, not asserted.
