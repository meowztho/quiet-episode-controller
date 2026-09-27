# Interview Ledger

No formal compiler interview was required because the product intent was already materially specified in the conversation. The entries below preserve the user's requirement statements verbatim. Where no compiler question preceded a statement, that is recorded rather than inventing one.

## R0Q1 — Browser-page controllability

**Exact question:** N/A — requirement exploration was volunteered by the user.

**Verbatim user statement:**
> kann man mit einen chrom addon links oder videoplayer auf seiten bedinen oder auf einer seite sich bewegen

**Materialized into:** Vision; Product Realization PR-01/PR-02/PR-03; Architecture.

---

## R0Q2 — Concrete episode workflow

**Exact question:** N/A — concrete workflow was volunteered by the user.

**Verbatim user statement:**
> aniworld.to/anime/stream/black-torch/staffel-1/episode-1 z.b. verhält sich immer gleich klick auf play bei den video starte volbilld, bende vollbild wenn video zuende gehe zu episode 2 unsw. denkst du ich kann das automatisieren?

**Materialized into:** Vision desired experience; PR-01..PR-07; PLAN M1..M6.

---

## R0Q3 — Embedded providers and non-interference

**Exact question:** N/A — integration and UX constraint were volunteered by the user.

**Verbatim user statement:**
> aber es sind meistens die anbieter voe und dodostream, die sind auf der seite eingebettet, die müssten das doch können, das wichtige ist, das der user dabei nicht gesört wird also wie beim zocken oder sonstiges

**Materialized into:** PR-02, PR-04, PR-08; architecture adapter/frame ownership; non-interference acceptance criteria.

---

## R0Q4 — Package request

**Exact question:** N/A — explicit delivery request.

**Verbatim user statement:**
> ok [$prompt-compiler-gpt](app://plugin_0dd9f3cd6ffc8191bd1631511a218099) bitte einmal als projekt

**Materialized into:** this standalone project authority package.

---

## R1Q1 — Playback control requirement

**Exact question:** N/A — live-test feedback and requirement refinement were volunteered by the user.

**Verbatim user statement:**
> aber wenn ich einmal klicke startet es, also wir sind zumindest fast richtig, was fehlt ist die bedining kein paus play oder sontige palyer navigation

**Materialized into:** Provider Frame Agent user-activation recovery and provider-independent Play/Pause/seek/volume controls; M3 acceptance and provider media verification.

---

## R0Q5 — Separate provider playback from AniWorld

**Exact question:** N/A — architecture clarification was volunteered by the user.

**Verbatim user statement:**
> im endefekt, müsste doch unser addon nur den direkt link des ifram auslesen, diesen voll wiedergeben über den player und dann die logik die aniworld nutzt für nächste episode verwenden, der player hat ja an sich nichts mit aniworld zu tun

**Materialized into:** Vision; D-011/D-012/D-013; Playback Surface responsibility; top-level provider playback design.

---

## R0Q6 — Persistent AniWorld controller + temporary playback tab

**Exact question:** N/A — architecture decision was volunteered by the user.

**Verbatim user statement:**
> es wäre ok aniworld in seinen tab geöffnet zu lassen und das alles in einen zeiten tab statfindet der nach der episode sich schließt dann wird aniworld auf die nöxhste episode gesetzt, usw.

**Materialized into:** Vision desired flow; D-011/D-014; Session Core controller/playback identities; multi-episode transition contract.


## R1Q2 — Automatic provider fallback

**Exact question:** N/A — runtime behavior refinement was requested directly by the user.

**Verbatim user statement:**
> ja genau so umsetzen

**Context immediately accepted by the user:** `Auto` should switch from a failed provider to the next provider, try each provider at most once per episode, end in `NO_WORKING_PROVIDER` when all fail, and manual provider selection should remain strict.

**Materialized into:** D-020; Session Core provider-attempt ledger; Provider Registry exclusions; Auto-only runtime failover tests and acceptance criteria.
