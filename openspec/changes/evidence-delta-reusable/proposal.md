# Proposal: reusable evidence-delta via frozen snapshot producer

## Why
`role-lab:evidence-delta` is synthetic-only: `examples/evidence-delta/select.mjs` copies four fixed fixtures from a prior experiment with a frozen PiB+ question. An existing Pi driver cannot reconcile a named/focused native Goal-X without hand-editing fixtures, which breaks provenance, bounds, and guard guarantees.

## What Changes
- Add deterministic, least-privilege snapshot producer `examples/evidence-delta/snapshot.mjs` that assembles a per-invocation frozen bundle (`.pi/flows/fixtures/` under a caller-owned disposable cwd) from only allowlisted within-project sources: Goal-X objective/events/revision/owner excerpt, approved OpenSpec excerpts, Git SHA/diff--stat/status (as allowed), selected test log/trace summaries. Exact allowlist + per-file (8 KB) and total (32 KB) bounds with truncation markers; no secrets (`ideas/`, `.env`, private data), no unrelated repos, no giant-trace ingestion, no model read of live repo at reconcile time.
- Emit digest manifest (`MANIFEST.md` + `manifest.json`) with sha256 per fixture, producer version, source revisions, conflict/freshness warnings (dirty git, goal revision drift, stale snapshot). Per-invocation isolated bundle (target dir argument); no global mutable slots.
- Keep `agent.md`/`flow.yaml` read-only contract (tools: read, 4 fixture paths, finish-only typed outputs `facts`/`minimalDelta`/`gate`); generalize fixture semantics from "four synthetic" to "four frozen per-invocation" without touching `extensions/flow-engine/guard.ts` (pinned fail-closed guard unchanged).
- Simple Pi-native invocation: `node examples/evidence-delta/reconcile.mjs <owned-disposable-cwd> --goal <id|file> --question "<bounded>" [--spec <approved-change>] [--log <bounded-test-log>]`; script snapshots then prints the exact `runFlow` / Flow command the host runs. No supervisor/poller/scheduler, no new control plane.

## Explicit Non-Goals
No live Goal-X mutation/approval/send_prompt/followUp/steer/dispatch/audit from the role; no automatic memory/model-context inflation; no AcroLab Lite or other-repo changes; no guard refactor; no OS sandbox claim; no Beta/publish authorization.

## Discipline Skills
`security-hardening`, `systematic-debugging` if a bug surfaces, completion `code-review`.
