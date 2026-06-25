## Context

Flow nodes have no unified node-type discriminator. `code` / `code-decision` carry a `kind` tag on the agent-lifecycle `extra` arg (because they impersonate the agent channel), but agent / fork / agent-decision / flow-ref carry none, and the tag is dropped at the `FlowManager` fan-out (`flow-manager.ts:121-135` — a 3-arg handler assigned to a 4-arg callback type; TypeScript allows fewer-param functions and JS silently drops the extra arg, so neither typecheck nor tests catch it). The dashboard therefore distinguishes node types three incompatible ways (the dropped `extra.kind`; the timeline-entry `kind` of `text|thinking|tool|error`; and reading `stepType` from the flow YAML for the static preview), none of which drive live or replayed card rendering. Persistence already records the full lifecycle stream into the parent session JSONL (the only pi store with `/resume` reattach + reload survival + the dashboard's seq-ordered replay), but the records carry no node type, so replay rebuilds timelines without card types, and code logs are indistinguishable from agent output.

## Goals / Non-Goals

**Goals:**
- One first-class `NodeKind` emitted by every node executor.
- The value survives the `FlowManager` seam, lands on `flow:agent-started` / `flow:agent-complete` payloads, and therefore in persisted records.
- Live and replayed runs select the card renderer by `nodeKind` identically.
- Code-node logs are program logs by virtue of the card's `nodeKind` — no new event, no per-line marker.
- Code nodes surface their resolved handler `target`.

**Non-Goals:**
- No new `flow:*` event channel and no `FLOW_EVENT_MAP` addition.
- No `FlowEventRecord` interface change (`nodeKind` rides inside `data`).
- No capture of the full code-handler source body.
- No change to the marker flush-gate workaround, `seq` ordering, or the live emit path.
- The pi-agent-dashboard reducer change ships separately (cross-repo).

## Decisions

**D1 — Card type is decided once, at the started event.** A node's `nodeKind` is emitted on `onAgentStarted`; all later `text` / `tool` / `thinking` entries attach to that card by `stepId`. This is why code logs need no marker: a code card's text entries *are* program logs by definition. Alternative (a distinct `flow:code-log` event + reducer case) was rejected — it doubles the cross-repo contract for zero added information.

**D2 — Carry `nodeKind` inside the payload, not as a new record field.** `FlowEventRecord.data` is the exact emitted payload, persisted verbatim. Adding `nodeKind` to the `flow:agent-started` / `flow:agent-complete` payload makes it persist and replay for free. Alternative (a top-level `FlowEventRecord.nodeKind` column) was rejected — redundant, and forces a record-schema migration.

**D3 — Fix the drop at the seam, widen the observer contract.** `FlowManager`'s lifecycle callbacks gain the 4th `extra` param and forward it; `FlowObserver.onAgentStarted` / `onAgentComplete` signatures accept `{ nodeKind }`. This is the root-cause fix for the silent drop, not a workaround layered above it.

**D4 — Emit for all six executors, generalize the existing code-decision tag.** Each `executeXStep` passes its `nodeKind`. The existing dashboard-event-emission requirement "Code-decision node lifecycle events carry a distinguishing kind" is generalized to the unified scheme (the `code-decision` value becomes one case of `NodeKind`).

**D5 — Rename to disambiguate.** Use `nodeKind` on the node and leave the dashboard timeline-entry `kind` (`text|thinking|tool|error`) untouched, so the two stop colliding. The node-side field is the one threaded end-to-end.

**D6 — Code `target` on the started payload only.** Include the resolved handler path so a replayed code card shows what ran; defer full-source capture. Alternative (embed source body) rejected as over-scope and a payload-size risk.

## Risks / Trade-offs

- **[Cross-repo skew: pi-flows ships `nodeKind`, dashboard not yet reading it]** → The tag is additive; unknown/absent `nodeKind` degrades to a generic node card (existing behavior). The two repos land independently with no hard coupling.
- **[Re-introducing a silent drop later]** → Add a test that asserts a registered observer actually receives `nodeKind` for an agent node (covers the exact `FlowManager` seam the original bug hid in), plus a replay test asserting card type is reconstructed.
- **[`target` path leaks an absolute/local path into persisted data]** → Emit the resolved path as already used for execution; it is the same path the run logged. No new sensitivity beyond what the run already exposes.
- **[Naming churn `kind` → `nodeKind`]** → Confined to the node-side lifecycle contract; the dashboard entry-`kind` union is left as-is, so blast radius is the engine + observer signatures only.
