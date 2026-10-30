# Rollout record: evidence-delta reusable (gate A+B applied 2026-10-23)

## Status
Committed `066286e` on `ops/guard-optin-rollout-prep-20261023` (no merge, no push).
AcroLab Lite: role file updated (prepared, NOT live-integrated). Nothing else touched.

## What this change is
- NEW (committed): `examples/evidence-delta/snapshot.mjs` v1.1.0, `examples/evidence-delta/reconcile.mjs` (with role+flow staging), `__tests__/evidence-delta-reusable.test.ts` (11 tests), `openspec/changes/evidence-delta-reusable/`.
- MODIFIED (committed, 2 lines): `examples/evidence-delta/agent.md` wording synthetic→per-invocation frozen; privilege unchanged.
- UNTOUCHED: `extensions/flow-engine/guard.ts`, `execution.ts`, `flow.yaml`, AcroLab product source/contract/sessions/goals/profiles/settings, other repos.

## Verification (this mission)
- RED→GREEN: initial 3/3 fail → 8/8 → 11/11 pass (`evidence-delta-reusable`: assembly, bounds incl manifest, digests, traversal/symlink/secret deny, missing/dirty/ambiguous/stale/injection, verify-only tamper detection, role+flow staging, 2 missions).
- Full suite: 115 files / 906 tests pass; `tsc --noEmit` clean; eslint clean.
- Prep canary: `/tmp/ed-canary-DrBNOV` via `reconcile.mjs --goal mvkpy8dz --spec evidence-delta-reusable` → 4 fixtures, digest-verified, git 42e2cf3.
- AcroLab one-shot canary (approved test canary, scripted faux — zero spend): `/tmp/ed-acro-demo-qUyX1S` from AcroLab goal `active_goal_2026102302513671_mvkdirny-8z2un6.md` (7378 B, read-only) + staged role/flow → `runFaux` complete, 4 real reads allowed, traversal + write denied, no mutation. Receipt: `.rollout-local/acrolab-e2e-receipt-20261023/receipt.json`. No live model ran: label is prepared, NOT live-integrated.
- Reviews (DeepSeek, cross-provider): #1 APPROVE + F1–F6; #2 (v1.1.0 delta) APPROVE, residuals accept-or-document (verify-only is fixture-write-free incl `.STALE` marker; default reconcile heals tamper — detect with `--verify-only`; snapshot-first ordering pinned by comment).

## Install record (gate B, 2026-10-23)
- Preflight: AcroLab `develop` dirty (pre-existing); installed role matched pre-change baseline; flow identical; no receipt file; no active competing driver (only this session's own log growing).
- Backup: `.rollout-local/acrolab-optin-backup-20261023/` (agents+fixtures+flows + `SHA256SUMS-before.txt`), outside `/tmp`.
- Wrote ONLY `.pi/flows/agents/role-evidence-delta.md` (new wording, sha256 `4a1807…` matches repo); flow.yaml identical → not rewritten; fixtures + all product paths untouched (post-install checksums match backup).
- Rollback: restore the role file from backup; verify sha256 `64c211…`; no other state to restore.

## Rollback (prep repo)
- `git revert 066286e` (or `git reset --soft HEAD~1` while unpushed); re-run reusable + full suites; confirm guard files match pinned HEAD.

## Gates
| Stage | State |
|---|---|
| Proposed | done (this OpenSpec change) |
| Tested | done (11/11 + 906 full + 2 canaries) |
| Reviewed | done (2× DeepSeek APPROVE) |
| Committed | done (`066286e`, unpushed) |
| Installed | done, scoped: AcroLab role file only (prepared) |
| Live / merge / push / publish / Beta | NOT — still requires separate Human Gate; nothing claimed |

## Addendum 2026-10-23: single live-model canary (gate C, executed)

- Authorization: user "Pues entonces adelante" — ONE bounded native real-LLM invocation only; no merge/push/publish, no AcroLab/product/profile/goal mutation.
- Run: fresh per-invocation bundle `/tmp/ed-live-demo-xSFKAU` (snapshot 1.1.0, AcroLab goal `active_goal_2026102302513671_mvkdirny-8z2un6.md` read-only, git `906d7a6`), spawned session `01a16818-…-07614c` (cwd = disposable target, shut down after run), single prompt `/role-lab:evidence-delta <frozen question>`.
- Native proof: Flow `role-lab:evidence-delta`, runId `b20b7fc4-2b40-4602-83eb-d8e8948bd037`, status `success`; agent `resolvedModel: opencode-go/muse-spark-1.3-contributor`; exactly 4 `read` calls (contract/surface/goal-excerpt/MANIFEST) + `finish(status=complete, facts, minimalDelta, gate)`; 0 extraneous calls; tokens 7650 in / 1738 out (~$0.0011 advisory vs $0.03 cap); outputs carry fixture+heading provenance, `ADVISORY / NOT APPLIED`, STOP gates, UNKNOWN markings.
- No mutation: no `mutation.txt`; AcroLab unchanged (role sha `4a1807…` as installed under gate B; fixtures/flow/product/goals/sessions untouched).
- Receipt: `.rollout-local/live-model-canary-20261023/receipt.json` (private, durable). Faux receipts (`faux/faux-1`, scripted) cannot pass as this: they lack native flow events + resolvedModel + real token usage.
- Remaining gates: merge/push of `fb88f04`, any further live runs, Beta/publish — all need separate Human Gate.
