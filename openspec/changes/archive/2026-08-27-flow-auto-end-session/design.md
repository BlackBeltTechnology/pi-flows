## Context

Automation runs are spawned headless by the dashboard (`spawnPiSession(strategy: "headless")`) under an RPC keeper sidecar that holds the process open. The automation runner finalizes a run — captures `result.md`, sets status, displays success/failure — when it observes the forwarded core **`agent_end`** event (`automation-plugin/src/server/index.ts`: "flush on agent_end"; `action-registry.ts`: "Runs finalize on `agent_end`").

Prompt/skill actions **seed a prompt** → the session runs one agent turn → `turn_end` → `agent_end` → the runner finalizes. `flows.run` instead injects the **`flow:run` event**; pi-flows runs the flow in sub-sessions out-of-band, the parent session never runs a turn, so **no `agent_end`** is emitted and the run times out.

Two facts kill the previous design:
- `ctx.shutdown()` is a **no-op in headless mode** (pi binds the default `shutdownHandler = () => {}` unless the mode wires a real one; TUI does, headless does not).
- The **RPC keeper** keeps the process alive regardless.

So closing the process was never the right goal. The right goal is to emit the **same completion signal** (`agent_end`) the runner already consumes.

## Goals / Non-Goals

**Goals:**
- On flow completion, emit an `agent_end`-equivalent signal carrying outcome metadata (`status` + summary) so a host/automation runner finalizes + displays success/failure.
- Make emission unconditional and side-effect-free (no shutdown) → safe in all modes, no opt-in.
- Reuse `FlowResult.status` as the metadata source.

**Non-Goals:**
- Shutting down / tearing down the run session or RPC keeper — automation-layer concern, handled separately.
- The `auto_end` flow key, the mode/interactivity gate, and `ctx.shutdown()` — all removed.
- Changing how the flow itself executes.

## Decisions

### D1 — Signal completion via `agent_end`, don't shut down
On `flow:complete`, pi-flows emits a turn/agent-completion signal (`agent_end`) with metadata `{ status, summary }`. This mirrors the lifecycle a seeded prompt produces, so the automation runner's existing `agent_end` finalize path fires for flow runs too. `agent_end` does not terminate the process, so this is safe everywhere.
- *Alternative (rejected):* `ctx.shutdown()` — no-op in headless, defeated by the keeper.

### D2 — Unconditional, no opt-in
Because the signal has no side effects, there is no `auto_end` key and no mode/status gate. Every flow run emits completion metadata on every terminal outcome (`success`/`error`/`aborted`). Interactive TUI runs are unaffected (a completion signal at flow end is benign).

### D3 — Metadata comes from `FlowResult`
`status` (`success` | `error` | `aborted`, from the status-population fix) and a summary derived from `lastResult.result.summary` are attached to the signal so the runner can display *what happened*, not just that it ended.

### D4 — The completion message REPLACES the persistence completion marker
Today `FlowPersister.emitCompletionMarker` appends a non-empty assistant message `[flow] <name> finished` at flow end purely to open pi's sticky `hasAssistant` flush gate (so buffered flow events persist for `/resume`) and to double as status context. The new end-of-flow completion message is *also* an appended assistant message, so it opens the same flush gate. Therefore the dedicated `finished` marker is **removed** — the single completion message (assistant text = outcome summary, plus the `agent_end` signal) serves both roles: flush-gate opener + persistence status AND the runner's finalize signal.
- **Constraints carried over:** the completion message MUST remain a non-empty text block with a well-formed zero `usage` (the Anthropic empty-text 400 and the `calculateContextTokens(usage)` crash guards described on `appendMarker`).
- The **start** marker (`emitStartMarker`) is kept — it opens the gate up front for mid-run reload survival, before any completion exists.

## Risks / Trade-offs

- **Extensions emit `flow:*`, not core `agent_end`** → the concrete surfacing mechanism is unresolved (see Open Questions). This is the make-or-break implementation detail.
- **Interactive TUI double-signal** → a flow run in TUI already ends its own way; an extra completion signal must not confuse the TUI turn state. Verify it is benign (or scope emission to non-tui if it is not).
- **Metadata shape** must match what the runner reads on `agent_end` (assistant `turn_end` text is what it captures today) — align the payload so success/failure text is displayed.

## Open Questions

1. **How does pi-flows surface `agent_end`?** A pi extension cannot emit a core lifecycle event directly. Options: (a) run `flow:run` inside a real agent turn so pi emits `agent_end` naturally at flow end; (b) a new pi-coding-agent API to emit/synthesize `agent_end`; (c) leave it to the dashboard to map forwarded `flow:complete` → its `agent_end` finalize path (moves the work out of pi-flows). Resolve before implementation.
2. **Exact metadata payload** the runner should read for a flow run (text block on `turn_end` vs. a structured field on `agent_end`).
3. Should emission be suppressed in `tui` mode if it interferes with the interactive turn lifecycle? Default: emit everywhere.
