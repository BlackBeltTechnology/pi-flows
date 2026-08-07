## Why

`flow:run` is the only way a host starts a flow — every programmatic producer (REST dispatch, domain-package tools, dashboard automations, slash commands) funnels into it. Today the `flow:run` handler declines to run for **four** reasons and emits **nothing** for any of them, while the slash-command registration path emits `flow:notify` for three of them. A programmatic dispatch therefore looks successful to every caller yet never runs.

The operator-facing consequence (verified): an automation-fired dispatch that is declined never emits the `flow_complete` its runner finalizes on, so the run sits `running` until a stale-run reaper fires (default **30 minutes**) and then reports the misleading terminal `"_(run exceeded max age)_"` — the real reason (unknown flow / gate / already-running) is unreachable from the record. For an invoice re-run dispatched without an automation run record, the decline is simply invisible.

Two adjacent defects share the dispatch seam and are fixed together:

1. **`isRunning` is not a sound single-run guard.** `FlowManager.start()` checks `_activeFlow` at the top but assigns it only after an `await import(...)`. Two dispatches inside that window both pass every guard → **two concurrent runs in one process** (the second clobbers the first's abort handle; the first's settle nulls `_activeFlow` while the second is live). Wide window on a session's first flow; microtask-narrow but non-zero after.

2. **Run identity exists but is trapped in the persister.** A `flowRunId` is minted (`randomUUID()` on `flow:flow-started`) but lives only on the persisted record envelope, never on live `flow:*` payloads — so a live consumer cannot attribute a step/cost/completion to a run.

## What Changes

- **A declined `flow:run` emits a terminal, renderable outcome on `flow:complete`.** The payload carries `status: "rejected"` (distinct from a run `"error"`), a top-level `reason` (byte-identical to the command-path text, produced by a shared source so parity holds by construction), `flowName`, and the same reason mirrored into `lastResult.result.summary`. This is renderable by a consumer that never saw `flow_started` (the invoice UI keys off `status === "rejected"` + `reason`) **and** finalizes an event-dispatched automation run in seconds via the existing `flow_complete` completion — **zero dashboard change**. `results` is omitted (no spurious post-flow summary); no run id (no run existed).
- **The dispatch guard becomes a single atomic choke point.** Delete the duplicate `isRunning` guard in the handler; make `FlowManager.start()`'s check-to-assign atomic (mark the run active before the first `await` via a synchronous-prologue IIFE); wrap the handler's `start()` call so the now-reachable "already running" throw becomes the same terminal rejection, never an unhandled promise rejection. **All three together** — any two is a regression.
- **The start path is unchanged** apart from the run identity now carried on lifecycle events; the already-running case still **declines** (no queueing).
- **Every run carries an identity on the live stream.** `FlowManager.start()` mints the run id (co-located with the atomicity fix), exposes it as `activeRunId`, and hands it to `onFlowStarted`; `EventEmitObserver` stamps it on every core-11 `flow:*` payload and onto `FlowResult.runId`; the persister records the **supplied** id (no self-mint); the orphan/reconcile path keeps its explicit `persistTerminal(orphanId, …)` injection.

## Capabilities

### New Capabilities
- `flow-run-dispatch`: `flow:run` is the single programmatic entry for starting a flow. A declined dispatch emits a terminal, renderable `flow:complete` (`status:"rejected"` + `reason`). Concurrent dispatch is guarded atomically so two events can never start two runs; the start path is behaviourally unchanged and still declines when a flow is active.

### Modified Capabilities
- `dashboard-event-emission`: the run id is present on every core-11 `flow:*` live payload and on `FlowResult`.
- `flow-session-persistence`: the run id is minted once per run by the engine (`FlowManager.start`); the persister records the **supplied** id rather than self-minting on `flow:flow-started`. The persisted record still carries `flowRunId`; the orphan/reconcile explicit-injection path is unaffected.

## Impact

- **Code:** `flow-engine/index.ts` (shared reason builders + `buildDispatchRejection`; `runFlowByName` collapse + terminal rejection; delete guard ①; wrap `start()`); `flow-engine/flow-manager.ts` (atomic IIFE, mint `runId`, `activeRunId`, thread to `onFlowStarted`, stamp `FlowResult.runId`); `flow-engine/flow-tui.ts` (`EventEmitObserver` stamps runId; `TuiFlowObserver.onFlowStarted` arity; reconcile carries orphan id); `flow-engine/flow-persist.ts` (record supplied id, drop self-mint); `flow-engine/types.ts` (`FlowResult` += `runId?`, `reason?`, status `"rejected"`); `flow-engine/flow-io.ts` (`FlowObserver.onFlowStarted` += runId).
- **Tests:** `flow-run-rejection-and-identity.test.ts` (new); `flow-persist.test.ts` + `flow-started-route-fields.test.ts` + `node-kind.test.ts` updated for the supplied-id + arity + fire-and-forget-timing changes. Full suite green (343).
- **Out of scope:** `flow:notify` parity on the `flow:run` path (superseded by the terminal signal; the command path keeps its `flow:notify`); a caller-supplied correlation token; `flow:prompt-request` / `flow:summary-*` run id; the dashboard flow-card reducer no-op on a rejection (separate surface); drop→queue for already-running; the three dashboard bugs (double-forward-on-failed-init, leaked rpc process per reject, unbounded invoicebot reuse hang) — filed separately; Option A (typed stream); Option B (kill the monkey-patch). See `research/flow-run-event-surfacing-and-run-identity.md`.
