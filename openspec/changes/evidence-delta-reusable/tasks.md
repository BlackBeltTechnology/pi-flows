# Tasks: evidence-delta reusable

- [x] Baseline: docs-first grep, guard pin intact, synthetic-only repro (select.mjs only copies 4 fixed fixtures).
- [x] RED: `__tests__/evidence-delta-reusable.test.ts` failed 3/3 on missing `snapshot.mjs`/`reconcile.mjs` + synthetic-fixed wording (verified 2026-10-23); now GREEN 11/11.
- [x] Implement `examples/evidence-delta/snapshot.mjs` v1.1.0 (allowlist, 8KB/file + 32KB total incl manifest, digest manifest, DIRTY_GIT/MISSING_SPEC_FILE/TRUNCATED warnings, traversal/symlink/secret denials, --verify-only, exact-match-first/error-on-ambiguous, stale-stamp on failure).
- [x] Implement `examples/evidence-delta/reconcile.mjs` wrapper (owned-cwd preflight, snapshot, manifest verify, role+flow staging into disposable workspace with refuse-overwrite, --verify-only/--no-role flags).
- [x] Generalize `examples/evidence-delta/agent.md` wording synthetic→frozen per-invocation (privilege clauses unchanged); keep `flow.yaml` + guard untouched.
- [x] GREEN: 11/11 unit/negative tests (assembly, bounds incl manifest, digest manifest, traversal/symlink/secret denials, missing/dirty/ambiguous/stale/injection, verify-only tamper detection, role+flow staging) + two different mission fixtures without giant trace.
- [x] Native canary in disposable cwd with real permitted tools; full vitest 906 + typecheck + lint clean; DeepSeek independent review APPROVE (F1–F6; F2/F3 doc-aligned, F1/F4/F5/F6 implemented in v1.1.0).
- [x] Human gates RECORDED 2026-10-23: (A+B) "Autorizo ambas cosas" → committed 066286e/fb88f04 + scoped AcroLab role install; (C) "Pues entonces adelante" → single live-model canary success (runId b20b7fc4, muse-spark contributor, 7650/1738 tokens ~$0.0011, no mutation; receipt .rollout-local/live-model-canary-20261023/receipt.json). Excludes merges/push/publication/Beta, data deletion, shared-profile writes, new product decisions.
