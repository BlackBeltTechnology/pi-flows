# structured-step-data Specification

## Purpose
TBD - created by syncing change flow-typed-io-and-run-state. Update Purpose after archive.
## Requirements
### Requirement: Step result contract
A step result SHALL consist of exactly: `status`
(`complete`|`error`|`blocked`|`skipped`), `summary` (string), `fullOutput`
(string — the node's raw output text), and `outputs` (a map of the step's
declared output names to their values). The legacy `artifacts` and `files`
fields SHALL be removed from the result contract, from the `finish` tool schema,
and from the template surface. The typed value channel between steps SHALL be
`outputs` only.

#### Scenario: result carries the four standard members
- **WHEN** any step completes
- **THEN** its stored result exposes `status`, `summary`, `fullOutput`, and `outputs`, and no `artifacts` or `files` member

#### Scenario: artifacts and files template forms are gone
- **WHEN** a template references `${{result.X.artifacts}}` or `${{result.X.files}}`
- **THEN** these are no longer recognized result fields (a produced path is conveyed as a declared typed output instead)

### Requirement: Typed outputs stored without coercion
A step's declared outputs SHALL be stored in the result map's `outputs` as their
real JSON-compatible types (string, number, boolean, object, array, null). The
engine SHALL NOT coerce output values to strings when storing them.

#### Scenario: object output stored typed
- **WHEN** a step declares output `data` and produces `{ k: 1 }`
- **THEN** `result.<id>.outputs.data` is stored as the object `{ k: 1 }`, not a JSON string

#### Scenario: scalar types preserved
- **WHEN** a step output is the number `92` or boolean `true`
- **THEN** the stored value is the number `92` / boolean `true`, not `"92"` / `"true"`

### Requirement: Typed delivery to code-node inputs
The engine SHALL deliver a code-node input as a typed value when the input value
is **exactly** a single output reference (`${{result.<id>.<name>}}` or
`${{flow.input.<name>}}`) with no surrounding text: the handler MUST receive that
output's value unchanged (object/array/number/boolean/string). When a reference
is embedded within other text, the engine MUST instead deliver the interpolated
string (per JIT serialization). The `CodeNodeContext` handler input type is
therefore `Record<string, unknown>`.

#### Scenario: whole-value reference delivered typed
- **WHEN** a code node wires `inputs: { data: "${{result.a.data}}" }` and `result.a.outputs.data` is `{ k: 1 }`
- **THEN** the handler receives `input.data` as the object `{ k: 1 }`

#### Scenario: embedded reference delivered as string
- **WHEN** a code node wires `inputs: { msg: "id=${{result.a.data}}" }` and `result.a.outputs.data` is `{ k: 1 }`
- **THEN** the handler receives `input.msg` as the string `id={"k":1}`

### Requirement: Just-in-time serialization at text boundaries
A non-string value SHALL be serialized to a string **only** at a text boundary —
when interpolated into an agent system prompt/task or into a `${{...}}` template
expression that is not a whole-value code-node input (see typed delivery). The
serialization SHALL be compact JSON. Scalar strings SHALL pass through unchanged.

#### Scenario: object interpolated into a task
- **WHEN** an agent task contains `${{result.a.data}}` and the value is `{ k: 1 }`
- **THEN** the expansion yields the compact JSON string `{"k":1}`

#### Scenario: string interpolated unchanged
- **WHEN** a template references a string-valued output
- **THEN** the value is inserted verbatim with no JSON quoting

### Requirement: Structured code-node returns
A code-node handler SHALL be permitted to return values of any JSON-compatible
type for its declared outputs. The prior rule that an `object`/`array`/`null`
return is a soft failure SHALL be removed. The return MUST still contain exactly
the declared output keys (all present, no undeclared extras); a missing or extra
key SHALL remain a soft failure.

#### Scenario: handler returns an object output
- **WHEN** a code node declares output `record` and its handler returns `{ record: { id: 1 } }`
- **THEN** the step succeeds and `result.<id>.outputs.record` is the object `{ id: 1 }`

#### Scenario: missing declared key still fails
- **WHEN** a handler omits a declared output key
- **THEN** the step soft-fails with a diagnostic naming the missing key

### Requirement: Non-string agent outputs
The engine SHALL support non-string declared agent outputs: when an output
declares a non-string type, the `finish` tool schema MUST accept that type,
validate the agent-emitted value against it, and the engine MUST store the
validated value with that type under `outputs`.

#### Scenario: agent emits a typed number output
- **WHEN** an agent declares output `score` of type number and calls `finish(score: 92)`
- **THEN** `result.<id>.outputs.score` is stored as the number `92`

#### Scenario: type violation is rejected
- **WHEN** an agent emits a value that violates the declared output type
- **THEN** the `finish` call is rejected and the agent is re-prompted (existing finish-retry loop)

### Requirement: File data is read just-in-time, not injected
The engine SHALL NOT read a file and inject its content into a prompt. The
`file://` input-injection mechanism SHALL be removed. File-backed data SHALL be
passed as a **path** value (typically a declared `*_path` output); the consuming
agent reads it at runtime via its `read` tool (subject to `access.read`), and a
consuming code node reads it from the filesystem.

#### Scenario: path passed to an agent
- **WHEN** step `a` declares an output `report_path`, and step `b` wires `inputs: { report_path: "${{result.a.report_path}}" }` with a prompt instruction to read that path
- **THEN** no file content is injected at dispatch; the agent obtains the content by calling its `read` tool on the path

#### Scenario: file:// is no longer resolved
- **WHEN** an input value is prefixed with `file://`
- **THEN** the engine does not read or inject file content for that input (the prefix is not a special form)
