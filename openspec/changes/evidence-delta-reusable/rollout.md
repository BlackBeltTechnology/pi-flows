# Rollout record: evidence-delta reusable (NOT authorized for live rollout)

## Status
Proposed + tested. NOT committed, NOT installed live, NOT active anywhere.

## What this change is
- NEW (uncommitted): `examples/evidence-delta/snapshot.mjs`, `examples/evidence-delta/reconcile.mjs`, `__tests__/evidence-delta-reusable.test.ts`, `openspec/changes/evidence-delta-reusable/`.
- MODIFIED (uncommitted, 2 lines): `examples/evidence-delta/agent.md` wording synthetic→per-invocation frozen; privilege unchanged.
- UNTOUCHED: `extensions/flow-engine/guard.ts`, `execution.ts` (verified `git diff --quiet HEAD`), `flow.yaml`, AcroLab Lite, other repos, profiles, settings.

## Verification (this mission)
- RED→GREEN: initial 3/3 fail → final 8/8 pass (`evidence-delta-reusable`).
- Full suite: 115 files / 906 tests pass; `tsc --noEmit` clean; eslint clean (agent.md ignored by config, expected).
- Native canary: `/tmp/ed-canary-DrBNOV` via `reconcile.mjs --goal mvkpy8dz --spec evidence-delta-reusable` → 4 fixtures, digest-verified, git 42e2cf3.
- Independent review (DeepSeek, cross-provider): APPROVE with non-blocking F1–F6 (verify-only mode, doc alignment done for F2/F3, exact-match-first, manifest cap accounting, stale-bundle stamping deferred as follow-ups).

## Install (requires separate Human Gate — DO NOT run yet)
1. Commit this worktree's files on a branch; open PR; obtain rollout approval.
2. Per-project opt-in only: run `snapshot.mjs`/`reconcile.mjs` against an owned disposable cwd; never copy into a live package or global profile.
3. New-session discovery via existing `flow:register-*-dir` or fresh Pi session; running sessions need explicit rediscover/restart.

## Rollback
- Uncommitted: `git checkout -- examples/evidence-delta/agent.md` + delete the four new paths above. No package/profile/session state to restore.
- Post-commit (if ever): revert the commit; re-run reusable + full suites; confirm guard files still match pinned HEAD.

## Gates
| Stage | State |
|---|---|
| Proposed | done (this OpenSpec change) |
| Tested | done (8/8 + 906 full + canary) |
| Reviewed | done (DeepSeek APPROVE, F1–F6 follow-ups open) |
| Committed | NOT — awaiting human gate |
| Installed/Live | NOT — separate Human Gate required; no Beta/publish claimed |
