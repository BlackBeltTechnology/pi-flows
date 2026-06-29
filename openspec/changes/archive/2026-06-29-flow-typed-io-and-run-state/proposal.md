## Why

Data crossing a flow step boundary is **string-only** today: code-node inputs
arrive as strings, returning an `object`/`array` is a soft failure, agent typed
outputs are string-valued, and a flow is started with a single `task` string.
Authors must `JSON.stringify`/parse at every edge, encode structured data as
opaque strings, and cram structured run parameters into one freetext field.
Separately, a finished or in-flight run is a black box: only the final summary
is observable, so no external reader can ask "what runs exist and what is each
node doing." These two gaps — an untyped data plane and unobservable run state —
are the friction every non-trivial flow hits.

## What Changes

- **Slim, typed result contract.** A step result is exactly `status`, `summary`,
  `fullOutput`, and a typed `outputs` map (declared outputs in their real
  types). **BREAKING:** the `artifacts` and `files` fields are removed (from the
  result, the `finish` schema, and the template surface); a produced file path
  is conveyed as a declared `*_path` output. `outputs` is the only value channel.
- **Typed delivery to code-node inputs.** When a code-node input is *exactly* a
  single `${{result.X.name}}` / `${{flow.input.name}}` reference, the handler
  receives the **typed value**; a reference embedded in text receives the
  JIT-serialized string. (`CodeNodeContext` input type → `Record<string, unknown>`.)
- **JIT serialization at the text boundary.** A non-string value is serialized
  (compact JSON) **only** when it is interpolated into an agent prompt or a
  `${{...}}` template — the one place a string is required.
- **BREAKING: structured code-node returns allowed.** The current rule that an
  `object`/`array`/`null` return is a soft failure is removed; a handler may
  return structured values matching its declared outputs.
- **Agent typed outputs may be non-string.** A declared agent output may be
  typed (number/boolean/object); the `finish` schema validates and the engine
  stores it typed.
- **BREAKING: `file://` eager input injection is removed.** The engine no longer
  reads a file and pastes its content into a prompt. Large/file data is passed
  as a **path** and read just-in-time by the consumer (an agent via its `read`
  tool, scoped by `access.read`; a code node via the filesystem). `context_files`
  remains only for small, always-needed files.
- **Typed flow input.** `FlowConfig` gains an `inputs:` schema; a run can be
  started with a **structured inputs object**, surfaced as `${{flow.input.<name>}}`
  and as typed data to code nodes. The single-`task` path remains as default.
- **Run-state exposure.** Live and historical run state — runs, per-node status
  (pending/running/finished/upcoming), and produced values — is persisted and
  **readable through a read-only seam** (API + events) for an external consumer.
  No write-back into a run.

## Capabilities

### New Capabilities
- `structured-step-data`: typed values in the result store; JIT compact-JSON
  serialization at agent/template boundaries; structured code-node returns and
  non-string agent outputs; removal of `file://` injection in favor of
  pass-a-path + read-just-in-time.
- `typed-flow-input`: a typed `inputs:` schema on a flow and a structured input
  object accepted at run start, exposed via `${{flow.input.*}}` and to handlers.
- `run-state-exposure`: a read-only seam exposing live + historical run and
  per-node state for external consumers, with no write-back.

### Modified Capabilities
<!-- None as spec-owned deltas; the new capabilities define the target behavior.
     Implementation touches existing code-node / agent-node / flow-wiring
     internals (see Impact). -->

## Impact

- **Behavior (BREAKING):** code nodes may return structured values (the
  object→soft-fail rule is removed); `file://` input injection is removed (flows
  using it must pass a path and have the consumer read it). Existing string
  outputs and the single-`task` start path keep working.
- **Engine internals:** the result store type (`{status, summary, fullOutput,
  outputs}`; `artifacts`/`files` removed), template expansion (typed whole-value
  delivery + serialize non-strings at text boundaries), the code-node return
  contract and `CodeNodeContext` (input type → `Record<string, unknown>`), the
  agent `finish` output schema (typed outputs; `files`/`artifacts` params
  removed), `FlowConfig` parsing + run invocation, and the run-persistence layer
  (read seam).
- **Out of scope:** any reader UI/tooling/skill that consumes the exposed state,
  per-step timeout/retry, and a generic durable key/value handle — tracked
  separately.
