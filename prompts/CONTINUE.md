# CONTINUE — Quiet Episode Controller

Continue from repository truth, not chat memory.

1. Read `PROJECT_INDEX.yaml`, `authority/STATE.yaml`, `authority/PROJECT_PLAN.yaml`, and the current stage's referenced authorities/acceptance.
2. Inspect `git status` and relevant diffs.
3. Run `python scripts/project_gate.py`.
4. Reconstruct what is actually verified from `authority/ACCEPTANCE_EVIDENCE.yaml`.
5. Select the next admitted unfinished work only.
6. Implement the smallest robust change that preserves owner boundaries and non-interference.
7. Run the narrowest relevant tests, then applicable browser/live checks.
8. Record evidence before advancing STATE.
9. Run `python scripts/build_atlas.py` and `python scripts/project_gate.py`.
10. Continue automatically unless COMPLETE or genuinely blocked.

Never infer completion from file existence, test count, fixture success, or a previous chat claim.
