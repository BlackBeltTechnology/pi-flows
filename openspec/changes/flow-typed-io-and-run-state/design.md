## Context

Today every value crossing a step boundary is a string. The result map is
`{ fullOutput, status, summary, artifacts, files }` (all strings) with agent
typed outputs spread in as strings; code-node inputs arrive as strings and an
`object`/`array`/`null` return is a soft failure; agent outputs are
`Type.String`; a run starts from a single `task` string; and `file://` inputs
are read by the engine and pasted into the prompt. Run observability is limited
to a persisted event stream meant for dashboard replay — there is no read API
to ask "what runs exist and what is each node doing."

This change introduces a typed data plane with serialization deferred to the
text boundary, a typed flow-input contract, and a read-only run-state seam. It
is cross-cutting (parser, executor, template engine, code/agent contracts,
persistence) and changes two behaviors in a breaking way, so the decisions are
recorded here before implementation.

## Goals / Non-Goals

**Goals**
- Carry declared outputs as real JSON types through the result map.
- Serialize a non-string value to compact JSON only when it enters a prompt or
  `${{...}}` template; pass strings through unchanged; pass values `code → code`
  with zero serialization.
- Allow structured code-node returns and non-string agent outputs.
- Remove engine-side file injection (`file://`); large/file data is a path read
  just-in-time by the consumer.
- Add an optional typed `inputs:` schema on a flow and a structured input object
  at run start, exposed as `${{flow.input.*}}` and to handlers.
- Expose live + historical run/node state through a read-only seam.

**Non-Goals**
- The reader/UI/skill that consumes the exposed state (a separate concern).
- Per-step timeout/retry and a generic durable key/value handle (separate).
- Any pause/resume or write-back into a running flow (explicitly excluded;
  the seam is read-only).

## Decisions

### D1. Slim, typed result contract; serialization deferred to the boundary
The result shape is exactly `{ status, summary, fullOutput, outputs:
Record<string, unknown> }`. `status`/`summary`/`fullOutput` are meta; `outputs`
is the typed value channel (declared outputs in their real types). **`artifacts`
and `files` are removed** — from the result, the `finish` schema, and the
template surface. A produced file path is a declared `*_path` output. Template
expansion and prompt assembly serialize a non-string value with compact
`JSON.stringify` at the moment of interpolation.
*Why drop `artifacts`/`files`:* `artifacts` (XML string) is redundant with typed
`outputs`; `files` is agent-self-reported (unreliable), never set by code nodes,
and its only real use (feeding `file://`) is removed (D4). `fullOutput` is kept
as the raw-text fallback (`${{result.X}}`). *Why typed over strings:* it is the
only way `code → code` avoids lossy stringify/parse round-trips; deferring
serialization to the boundary keeps the LLM-facing surface a string where one is
required. Alternative — dual-write (typed + string) — adds storage and two
sources of truth; rejected.

### D1b. Whole-value references deliver typed values to code inputs (Option A)
When a code-node input value is *exactly* one reference (`${{result.X.name}}` /
`${{flow.input.name}}`, no surrounding text), the handler receives the **typed
value**; a reference embedded in text receives the JIT-serialized string.
`CodeNodeContext` input type becomes `Record<string, unknown>`.
*Why over alternatives:* Option B (always string at code inputs) fails the
"object preserved end to end" goal; Option C (a new `${{=...}}` syntax) adds
surface. Whole-value-vs-embedded is unambiguous and needs no new syntax.

### D2. Compact JSON, not pretty, at the text boundary
Non-string interpolation uses compact JSON.
*Why:* token cost; evidence on pretty-vs-compact aiding LLM reasoning is mixed,
and large/structured data should be read just-in-time (D4) rather than inlined
at all, so prompt readability of inlined blobs is a minor concern.

### D3. Removal of the object→soft-fail coercion is a clean break
The code-node return contract keeps "exactly the declared keys" but drops the
"object/array/null → soft failure" rule. Strings/numbers/booleans still pass.
*Why:* the coercion existed only to keep an all-string interface honest; once the
store is typed (D1) it is counterproductive. Existing handlers that returned
strings are unaffected.

### D4. `file://` injection is removed in favor of pass-a-path + read-JIT
The engine stops resolving `file://` inputs. Large/file data is wired as a path;
an agent reads it through its `read` tool (governed by `access.read`); a code
node reads it from disk.
*Why:* just-in-time retrieval is the current best practice (keep a reference in
context, fetch on demand) — it avoids prompt bloat and long-context degradation,
and removes an engine mechanism. Alternative — a new claim-check/`read_artifact`
tool — is redundant once a path + the existing `read` tool already provide the
reference + fetch; rejected. `context_files` is retained for small, always-needed
files where guaranteed presence beats the negligible token cost.

### D5. Flow input is an additive typed schema; `task` stays the default
`FlowConfig` gains `inputs:`; run invocation accepts a structured `inputs`
object validated against it; values surface as `${{flow.input.*}}` and typed to
handlers. The single-`task` path is untouched.
*Why:* a structured contract removes the "stuff everything into one string and
re-parse" anti-pattern at the trigger edge while preserving the casual one-string
ergonomics. Alternative — overload `task` with JSON — keeps the stringly plane;
rejected.

### D6. Run-state exposure extends the existing persistence, read-only
Build the read seam on the existing run-persistence layer, adding per-node
status (`pending`/`running`/`finished`/`upcoming`) and produced values, served
for live + historical runs. The seam exposes queries/events only — no operation
can mutate a run.
*Why:* reuse the shipped persistence rather than a parallel store; read-only by
construction keeps the engine free of any steering/resume surface (explicitly a
non-goal).

## Risks / Trade-offs

- **[Breaking: `file://` removal]** → flows relying on injection break. Mitigate
  with a clear migration note and a `flow_write` validation hint when an input
  looks like a path but the consumer lacks `access.read` or a read instruction.
- **[Breaking: structured returns]** → unlikely to break (it only widens what is
  allowed), but downstream templates that assumed a stringified object now get
  compact JSON; document the boundary rule.
- **[Result-contract change]** → removing `artifacts`/`files` touches every
  result read + the `finish` schema + template forms `${{result.X.artifacts}}`/
  `${{result.X.files}}`. Mitigate by keeping `status`/`summary`/`fullOutput`
  stable; flows referencing the removed forms must move a needed path to a
  declared `*_path` output (migration note).
- **[JIT reliance on the agent reading]** → an agent may not read a referenced
  path. Mitigate via authoring guidance + validation hint; for small critical
  context, `context_files` remains.

## Migration Plan

1. Land the slim typed result contract `{ status, summary, fullOutput, outputs }`;
   remove `artifacts`/`files` from the result, the `finish` schema, and the
   template surface.
2. Update template expansion: typed whole-value delivery to code inputs (D1b) +
   compact-JSON serialization of non-strings at text boundaries.
3. Relax the code-node return contract; update the agent `finish` schema to allow
   typed outputs.
4. Remove `file://` resolution; add the `flow_write` path/`access.read` hint.
5. Add `FlowConfig.inputs` parsing + validation and structured run-start input;
   wire `${{flow.input.*}}`.
6. Extend persistence with per-node status + produced values; add the read-only
   query/event seam.

Rollback: each step is independently revertible; the typed map and the input
schema are additive at the boundary, so reverting the seam or input schema does
not affect the data-plane change and vice versa.

## Open Questions

- Resolved: `artifacts` and `files` are **dropped** (not aliased); `fullOutput`
  is kept. Flows using the removed template forms migrate to a declared output.
- Shape of the read seam — a synchronous query API, an event projection, or both?
- Type vocabulary for `inputs:`/agent outputs — reuse the existing output
  `type`/`pattern` validators or introduce a small shared schema type?
