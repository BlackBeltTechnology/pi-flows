## ADDED Requirements

### Requirement: Code step type and handler entry point
The system SHALL support a `code` step type whose work is performed by a target TypeScript module's **default export** — an `async` function invoked as `(input, ctx)`. The engine SHALL load the module via in-process dynamic import (pi's jiti module graph) and await its default export.

#### Scenario: Code node runs its default export
- **WHEN** a flow reaches a step with `type: code` whose handler file exists and default-exports an async function
- **THEN** the engine imports the module and awaits `default(input, ctx)`, using its resolved return value as the step result

#### Scenario: Module without a default export
- **WHEN** the handler module has no default export, or its default export is not a function
- **THEN** the step fails with `status: "error"`, a clean diagnostic naming the node, as a soft failure (per the Code node failure routing requirement)

### Requirement: Input wiring to handlers
The handler's first argument SHALL be an object containing every input declared in the node's `inputs:`, each template-expanded to a string and keyed by its declared name. A declared input whose template resolves to nothing SHALL be passed as an empty string `""`, never omitted and never `undefined`.

#### Scenario: Declared inputs are passed as strings
- **WHEN** a code node declares `inputs: { invoice: "${{result.extract.canonical}}" }` and `extract.canonical` is non-empty
- **THEN** the handler receives `input.invoice` as the expanded string value

#### Scenario: Unresolved input resolves to empty string
- **WHEN** a declared input's template references a step that produced no value
- **THEN** the handler still receives that key, with value `""`

### Requirement: Code node execution context
The handler's second argument SHALL be a `CodeNodeContext` object containing `signal` (AbortSignal), `cwd` (the project root that contains `.pi`), `logger` (a function streaming a message to the step's card), `setSummary` (a function setting the step summary), `flowName`, `stepId`, and `task` (the flow's overall task text). `CodeNodeContext` SHALL be exported from the package entrypoint.

#### Scenario: Context carries identity, cwd, and helpers
- **WHEN** a handler runs
- **THEN** `ctx.cwd` equals the project root, `ctx.stepId` equals the node id, `ctx.flowName` equals the running flow, and `ctx.logger`/`ctx.setSummary` are callable

#### Scenario: Logger output reaches the step card
- **WHEN** a handler calls `ctx.logger("checking record")`
- **THEN** that text is emitted on the same streaming channel used for agent assistant text, tagged to the node's step

### Requirement: Code node failure routing
Code-node failures SHALL follow the `node-failure-model` capability. A plain `throw`, a contract violation, a coercion error, a missing handler, or a timeout SHALL be a SOFT failure: it routes to `on_error` when set, and hard-fails the flow when `on_error` is unset. The package SHALL export a `FlowHardError` class; `throw new FlowHardError(msg)` SHALL be an unconditional HARD failure that stops the flow regardless of `on_error`. The engine SHALL NOT add any retry layer for code handlers.

#### Scenario: Soft failure routes on_error when set
- **WHEN** a handler `throw`s a plain error and the node sets `on_error: park`
- **THEN** the step fails with `status: "error"` and the flow routes to `park`

#### Scenario: Soft failure with no on_error hard-fails
- **WHEN** a handler `throw`s a plain error and the node has no `on_error`
- **THEN** the flow hard-fails (stops) per the node-failure-model

#### Scenario: FlowHardError stops the flow
- **WHEN** a handler executes `throw new FlowHardError("unrecoverable")`, even with `on_error` set
- **THEN** the flow hard-fails (stops) and surfaces the message, ignoring `on_error`

### Requirement: Strict output contract
A code node's returned object SHALL contain exactly the keys declared in its `outputs:` — every declared key MUST be present, and no undeclared extra key MAY be present. A node with no declared outputs SHALL return `{}`. Any violation SHALL produce a soft failure (per the Code node failure routing requirement) with a diagnostic naming the offending key(s).

#### Scenario: Return matches declared outputs
- **WHEN** a node declares `outputs: [valid, nav_record]` and the handler returns `{ valid: "true", nav_record: "X" }`
- **THEN** the step succeeds and both values are available as typed outputs

#### Scenario: Missing declared output
- **WHEN** a node declares `outputs: [valid, nav_record]` and the handler returns only `{ valid: "true" }`
- **THEN** the step fails with `status: "error"` and a diagnostic naming the missing `nav_record`, as a soft failure

#### Scenario: Undeclared extra key
- **WHEN** the handler returns a key not present in the node's `outputs:`
- **THEN** the step fails with `status: "error"` and a diagnostic naming the extra key, as a soft failure

### Requirement: Output value coercion
For each declared output present in the return, the system SHALL coerce values to strings: `string` passes through unchanged; `number`, `boolean`, and `bigint` are coerced via `String()`; an `object`, `array`, or `null` value SHALL produce a clean error naming the key (the author must serialize intentionally). Coerced values populate `typedOutputs`.

#### Scenario: Primitive coercion
- **WHEN** a handler returns `{ valid: true, count: 3 }` for declared outputs `valid` and `count`
- **THEN** the typed outputs are `valid: "true"` and `count: "3"`

#### Scenario: Object value rejected
- **WHEN** a handler returns `{ record: { id: 1 } }` for a declared output `record`
- **THEN** the step fails with `status: "error"` and a diagnostic naming `record`

### Requirement: In-process execution and cooperative abort
The system SHALL run code handlers in-process within pi's event loop, mirroring agent execution. The handler SHALL receive `ctx.signal`, and when the flow is aborted the engine SHALL abort that signal so a cooperating handler can stop.

#### Scenario: Abort signals the handler
- **WHEN** the flow run is aborted while a handler is executing
- **THEN** `ctx.signal` becomes aborted and the step is recorded as not completed

### Requirement: Optional soft timeout
A code node MAY declare a `timeout`. When set, the system SHALL enforce it as a soft deadline: on expiry the engine aborts `ctx.signal` and marks the step `status: "error"` → `on_error`. When `timeout` is omitted, the handler SHALL run to completion with no deadline.

#### Scenario: Timeout expires
- **WHEN** a node sets `timeout` and the handler is still running when it elapses
- **THEN** `ctx.signal` is aborted and the step fails with `status: "error"` as a soft failure

#### Scenario: No timeout declared
- **WHEN** a node omits `timeout`
- **THEN** the handler runs to completion with no engine-imposed deadline

### Requirement: Result mapping and summary
On success the system SHALL set `status: "complete"`, populate `typedOutputs` from the coerced return, set `fullOutput` to `JSON.stringify` of the coerced outputs, set `files` and `artifacts` to `""`, and set `summary` to the value passed to `ctx.setSummary` or, if none was set, an auto-generated non-empty summary derived from the node id and output keys.

#### Scenario: Handler sets an explicit summary
- **WHEN** a handler calls `ctx.setSummary("validated against NAV")` and succeeds
- **THEN** the step `summary` is `"validated against NAV"`

#### Scenario: Auto summary fallback
- **WHEN** a handler succeeds without calling `ctx.setSummary`
- **THEN** the step `summary` is a non-empty auto-generated string referencing the node and its outputs

### Requirement: Missing handler at run time
When a flow reaches a code node whose real handler file does not exist, the system SHALL fail the step cleanly with `status: "error"` and a message instructing the author to copy the `<id>.ts.default` template, drop `.default`, and implement the default export, as a soft failure (per the Code node failure routing requirement).

#### Scenario: Handler not yet implemented
- **WHEN** a convention-based code node runs and only `<id>.ts.default` (or nothing) exists, not the real `<id>.ts`
- **THEN** the step fails with `status: "error"` and the copy-the-template message, as a soft failure

### Requirement: Handler location convention with target override
By default the system SHALL locate a code node's handler from its `id`: real file `.pi/flows/handlers/<flow>/<id>.ts` and reference template `.pi/flows/handlers/<flow>/<id>.ts.default`. A node MAY set `target:` to override the real-file path for shared or custom-path handlers.

#### Scenario: Convention-based location
- **WHEN** a flow `research` has a code node `validate-nav` with no `target:`
- **THEN** the engine runs `.pi/flows/handlers/research/validate-nav.ts`

#### Scenario: Explicit target override
- **WHEN** a code node sets `target: ./shared/nav.ts`
- **THEN** the engine runs that file instead of the convention path

### Requirement: Generated reference template
For convention-based code nodes, the system SHALL generate an inert `<id>.ts.default` reference template containing a full runnable scaffold: a `CodeNodeContext` import, `interface Input` and `interface Output` derived from the node's `inputs`/`outputs`, and a default-export async function with a `// TODO` body returning empty output values. The `.ts.default` file SHALL never be imported or executed by the engine.

#### Scenario: Scaffold reflects declared inputs and outputs
- **WHEN** the template is generated for a node with `inputs: [invoice]` and `outputs: [valid, nav_record]`
- **THEN** `<id>.ts.default` contains `interface Input { invoice: string }`, `interface Output { valid: string; nav_record: string }`, and a default-export function returning empty values for `valid` and `nav_record`

### Requirement: Generation triggers
The system SHALL run handler generation automatically on every successful `flow_write`, operating on the persisted YAML. The system SHALL also expose a human-facing `/flows:generate <name>` command that regenerates a saved flow's code-node templates on demand. No standalone agent tool is provided.

#### Scenario: Generation on flow_write success
- **WHEN** `flow_write` validates and persists a flow containing code nodes
- **THEN** the corresponding `<id>.ts.default` templates are generated/refreshed

#### Scenario: Manual regeneration command
- **WHEN** the user runs `/flows:generate research` against a hand-edited saved flow
- **THEN** that flow's code-node templates are regenerated

### Requirement: Template regeneration and drift detection
The system SHALL always (re)write the `.ts.default` template so it stays in sync with the node's `inputs`/`outputs`, and SHALL never modify the real handler file. When the real handler file exists, the system SHALL compare the YAML-derived `Input`/`Output` key sets against the `interface Input`/`interface Output` blocks textually extracted from the real file; a mismatch SHALL emit a non-fatal warning diagnostic. When those blocks cannot be found, the system SHALL skip the warning silently and rely on runtime shape validation.

#### Scenario: Template kept in sync without touching real file
- **WHEN** a node's outputs change and the flow is saved while the real handler exists
- **THEN** `<id>.ts.default` is rewritten with the new interfaces and the real `<id>.ts` is left unchanged

#### Scenario: Drift warning
- **WHEN** the real handler's `interface Output` block omits a key the YAML declares
- **THEN** a non-fatal warning diagnostic reports the signature drift

#### Scenario: Interface blocks not found
- **WHEN** the real handler inlined or renamed its types so no `interface Input`/`Output` block is present
- **THEN** no drift warning is emitted and runtime validation remains the safety net

### Requirement: Custom target receives no template
For code nodes using an explicit `target:` override, the system SHALL NOT generate a `.ts.default` template; the author owns the file and runtime shape validation is the safety net.

#### Scenario: No template for custom target
- **WHEN** a code node declares a `target:` path
- **THEN** no `.ts.default` file is generated for that node

### Requirement: Conditional resolves typed outputs
The system SHALL extend conditional checks so `check: <stepId>.<key>` resolves any typed-output key from the merged result map, falling back to `fullOutput` only when the key is genuinely absent. The standard fields `artifacts`, `summary`, `files`, and `status` continue to resolve as before.

#### Scenario: Branch on a typed output
- **WHEN** a conditional sets `check: validate-nav.valid` and the `validate-nav` result has a non-empty `valid` typed output
- **THEN** the conditional routes to its `present` branch

#### Scenario: Standard field still resolves
- **WHEN** a conditional sets `check: step.status`
- **THEN** it resolves the `status` field as before

### Requirement: Code node validation
The system SHALL validate code nodes in `flow_write`: `outputs` is optional; output names MUST be unique and valid JavaScript identifiers; input names MUST be valid JavaScript identifiers; the node `id` MUST be filesystem-safe; and `blockedBy`/`on_complete`/`on_error` MUST reference existing step ids.

#### Scenario: Duplicate output names rejected
- **WHEN** a code node declares two outputs with the same name
- **THEN** `flow_write` returns a validation error and does not persist

#### Scenario: Side-effect-only node is valid
- **WHEN** a code node declares no `outputs`
- **THEN** validation passes and the handler is expected to return `{}`

### Requirement: Code node lifecycle events
The system SHALL emit the same step lifecycle callbacks for code nodes as for agent steps — start, streaming text, and completion keyed by the node id — carrying a `kind: "code"` discriminator so consumers can distinguish them. Rendering is the dashboard's responsibility.

#### Scenario: Lifecycle events fire with a code discriminator
- **WHEN** a code node starts, logs, and completes
- **THEN** the start, assistant-text, and completion callbacks fire for that step id with a `kind: "code"` discriminator
