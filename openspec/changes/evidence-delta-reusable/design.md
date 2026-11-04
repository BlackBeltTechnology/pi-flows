# Design: frozen-bundle snapshot + unchanged guard

## Snapshot producer (`snapshot.mjs` v1.1.0)
Input: `--goal <goal-id|goal-file>` (native Goal-X excerpt), `--question "<=500 chars>"` (frozen PiB+ or operator question), optional `--spec <approved-change-name>` (only `openspec/changes/<name>/{proposal.md,design.md,tasks.md}` as implemented), optional `--log <file>` (single test log/trace summary, any within-project path subject to deny-list). All paths resolved against caller cwd; absolute paths must resolve inside cwd.

Allowlist (exact):
- Goal: exact filename under `.pi/goals/` wins; else substring match must be unique or the run fails listing up to 5 candidates (`--goal test` with two hits → ambiguous, non-zero).
- Spec: `openspec/changes/<approved>/{proposal.md,design.md,tasks.md}` (8 KB cap each; `specs/**` deferred to follow-up).
- Git (as allowed): `rev-parse HEAD`, `status --porcelain`, `diff --stat HEAD` (never full diff by default; 4 KB cap).
- Log: one caller-specified file, 8 KB head-truncated with marker.

Deny: traversal (`..`), absolute escape, symlink (file or any parent), `ideas/`, `.env*`, `*secret*`, `*token*`, private user paths, sibling repos, `/tmp` outside bundle, giant traces (>cap). Violation → non-zero exit, no partial bundle.

Output bundle (under `<target>/.pi/flows/fixtures/`):
- `contract.md` (provenance-labeled approved scope: goal id/revision/owner + spec refs + git SHA).
- `surface.md` (test/log/derived surface summary, truncated).
- `goal-excerpt.md` (bounded goal excerpt + frozen question).
- `MANIFEST.md` + `manifest.json` (sha256 per fixture, producer `1.1.0`, source SHAs, byte counts, warnings: `DIRTY_GIT`, `MISSING_SPEC_FILE`, `TRUNCATED` with timestamps; `GOAL_REVISION_DRIFT`/`STALE_SNAPSHOT` deferred to follow-up). Total 32 KB cap covers fixtures + `MANIFEST.md` together; `--verify-only` checks digests without re-snapshotting; failed runs best-effort stamp `.STALE_<ts>`.

Determinism: sorted keys, LF, fixed header order; same inputs → identical bytes except timestamp/warning lines (documented).

## Role/Flow reuse
`agent.md` frontmatter unchanged in privilege (`tools: read`, 4 fixture paths). Body wording generalizes "four synthetic fixtures" → "four frozen per-invocation fixtures"; normative tool/trust/output clauses stay byte-identical where possible. `flow.yaml` unchanged. Guard `extensions/flow-engine/guard.ts` untouched (pinned).

## Invocation (`reconcile.mjs`)
Thin wrapper: validates owned disposable cwd (realpath, no symlink parent), calls `snapshot.mjs` (all flags forwarded, incl `--verify-only`), verifies manifest digests host-side, then stages `agent.md` + `flow.yaml` into the SAME disposable workspace (refuse-overwrite-if-modified, symlink-safe; skip with `--no-role`) so the bundle is a complete runnable unit with no stale synthetic reads; never auto-runs a model, never writes outside target.

## Verification
Vitest RED→GREEN (11/11): missing-producer repro, assembly/bounds incl manifest/digest manifest, traversal/symlink/secret deny, missing/dirty/ambiguous/stale/injection, verify-only tamper detection, role+flow staging, two genuinely different mission fixtures (historical B1/B3-style + Test-Oracle-style) without giant trace, native canary in disposable cwd with real `read` tools, independent cross-provider review of exact SHA.
