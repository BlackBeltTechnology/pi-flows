## ADDED Requirements

### Requirement: A multi decision returns zero or more routes

An `agent-decision` or `code-decision` with `multi: true` SHALL resolve zero or more unique branch labels: an agent via `finish({ branches })`, a handler via exactly one of `{ branch }`, `{ branches }` or `{ routes: [{ branch, items? }] }`. On a `multi: true` step, `branches`, `routes` and `items` SHALL be reserved output names; without `multi: true` they SHALL remain ordinary data outputs.

#### Scenario: Agent picks two branches
- **WHEN** a `multi: true` agent-decision agent calls `finish({ status: "complete", branches: ["backend", "docs"] })`
- **THEN** the routes SHALL be `backend` and `docs`

#### Scenario: Handler duplicates a label
- **WHEN** a `multi: true` handler returns `{ branches: ["a", "a"] }`
- **THEN** the step SHALL soft-fail naming the duplicate label

#### Scenario: Non-multi handler returning a branches key
- **WHEN** a code-decision without `multi: true` returns `{ branch: "a", branches: ["x"] }`
- **THEN** it SHALL route to `a` AND `result.<id>.branches` SHALL be the data output `["x"]`

#### Scenario: Reserved output declared
- **WHEN** a `multi: true` code-decision declares an output named `routes`
- **THEN** validation SHALL report an error naming the step and the reserved name

### Requirement: Chosen targets activate the next segment

Every forward branch target of a `multi: true` decision SHALL be an `agent` step in the DAG segment immediately after the decision. After routing, the engine SHALL run that segment with every step reachable from a chosen target active and every other step of the segment `skipped`, replacing any earlier result. Choosing no forward branch SHALL skip the whole segment and continue after it.

#### Scenario: Two of three lanes run, report once
- **GIVEN** agent lanes `backend`, `frontend`, `docs` in the next segment and `report` blocked by all three
- **WHEN** the decision returns `backend` and `frontend`
- **THEN** `backend` and `frontend` SHALL both run (concurrently when `max_concurrent` > 1) AND `docs` SHALL be `skipped` AND `report` SHALL run once after both

#### Scenario: Choosing nothing
- **WHEN** a `multi: true` handler returns `{ branches: [] }`
- **THEN** every step of the next segment SHALL be `skipped` AND the step after that segment SHALL run

#### Scenario: Stale result from an earlier pass
- **GIVEN** a loop in which a multi decision chose `apply` on pass 1
- **WHEN** it chooses nothing on pass 2
- **THEN** `result.apply.status` SHALL be `skipped` after pass 2

#### Scenario: Target outside the next segment rejected
- **WHEN** a `multi: true` decision has a forward branch targeting a `code` step or an agent step in a later segment
- **THEN** validation SHALL report an error naming the decision, the branch and the target

### Requirement: A chosen target can run once per item

A branch SHALL be a fan-out branch only if it declares `for_each:` (a template, or `dynamic`). A chosen fan-out route SHALL take items from `routes[].items`, else from `for_each` (an array, a JSON-array string, or `""` meaning `[]`). A route with items SHALL run only its target step once per item; steps blocked by the target SHALL run once after all instances settle. `max_items` (default 50) SHALL cap the count.

#### Scenario: One explorer per project
- **GIVEN** `scan` outputs `projects: ["api", "web", "cli"]` AND a one-branch multi decision with `explore: { to: explore, for_each: "${{result.scan.projects}}" }` AND `merge` blocked by `explore`
- **WHEN** the decision returns `explore`
- **THEN** three `explore` runs SHALL start with tasks containing `api`, `web` and `cli` AND `merge` SHALL run once after all three

#### Scenario: Items over the cap
- **GIVEN** `max_items: 2` AND three items
- **WHEN** the route is chosen
- **THEN** the decision SHALL soft-fail naming the branch, the count and the cap AND no step of the next segment SHALL run

#### Scenario: for_each is not an array
- **WHEN** `for_each` resolves to `"abc"`
- **THEN** the decision SHALL soft-fail naming the step and saying an array was expected

#### Scenario: Items for a non-fan-out branch
- **WHEN** a multi handler returns `{ routes: [{ branch: "docs", items: [1] }] }` and `docs` declares no `for_each`
- **THEN** the step SHALL soft-fail naming `docs`

#### Scenario: Fan-out target reachable from another lane rejected
- **WHEN** fan-out target `b` is blocked by `a`, the target of another branch of the same decision
- **THEN** validation SHALL report an error naming both branches

#### Scenario: Empty item list
- **WHEN** a chosen route has items `[]`
- **THEN** no instance SHALL start AND `result.<target>.status` SHALL be `complete` with `items` `[]` AND steps blocked by the target SHALL run

### Requirement: Item templates

Inside instance `i`, `${{item}}` SHALL be the element (strings raw, others compact JSON), `${{item.<field>}}` one field of an object element (`""` if absent) and `${{item_index}}` SHALL be `i` (0-based). `${{item…}}` SHALL be valid only in the task or inputs of a fan-out branch target.

#### Scenario: Object item field
- **WHEN** an instance's item is `{ "change": "a", "worktree": "/w/a" }` and its task contains `${{item.worktree}}`
- **THEN** the task SHALL contain `/w/a`

#### Scenario: item outside a fan-out target
- **WHEN** a step that is not a fan-out branch target uses `${{item}}`
- **THEN** validation SHALL report an error naming the step

### Requirement: Item results aggregate in input order

`${{result.<fanoutTarget>.items}}` SHALL be a valid reference (compact JSON in text, the typed array as a whole-value code input). After all instances settle, `result.<target>.items` SHALL be the per-instance results (`status`, `summary`, `fullOutput`, `outputs`) in input order, `status` SHALL be `complete` only if every instance completed (else `error`), and `outputs` SHALL be empty; a reference to a declared output of a fan-out target SHALL be a validation error pointing to `.items`.

#### Scenario: Out-of-order completion
- **GIVEN** item 1 finishes before item 0
- **WHEN** a later code step reads `${{result.explore.items}}` as a whole-value input
- **THEN** element 0 SHALL be item 0's result

#### Scenario: Declared output referenced directly
- **WHEN** a step reads `${{result.explore.notes}}` where `explore` is a fan-out target declaring output `notes`
- **THEN** validation SHALL report an error pointing to `${{result.explore.items}}`

### Requirement: Item failures aggregate into the target's outcome

A soft failure of one instance SHALL NOT abort its siblings. After all settle, a failed aggregate SHALL route like a soft failure of the target step (its `on_error`, else halt). A hard failure of any instance SHALL abort the others and halt. A soft failure of item expansion or the cap SHALL replace the decision's result with an `error` result and route by the decision's `on_error`.

#### Scenario: One of three items fails
- **GIVEN** three items where item 1 soft-fails AND the target has `on_error: collect`
- **WHEN** all instances settle
- **THEN** items 0 and 2 SHALL be `complete` AND the flow SHALL route to `collect` AND the summary SHALL state 1 failed

#### Scenario: Hard failure of an instance
- **WHEN** instance 0 hits a terminal API error while instance 1 is running
- **THEN** instance 1 SHALL be aborted AND the flow SHALL halt

### Requirement: Loops stay single-route

A multi decision MAY declare backward branches. Returning a backward branch with other routes SHALL soft-fail naming the branches; a backward branch returned alone SHALL loop as today; when `max_iterations` is reached and it is returned again, the decision SHALL act as if it returned no branches.

#### Scenario: Loop plus lane
- **WHEN** a multi decision returns `retry` (backward) and `docs`
- **THEN** the decision SHALL soft-fail naming `retry` and `docs`

#### Scenario: Cap reached
- **GIVEN** `max_iterations: 1` and the loop already taken once
- **WHEN** the decision returns `retry` again
- **THEN** every step of the next segment SHALL be `skipped` AND execution SHALL continue after it

### Requirement: Classifiers do not decide multi decisions

For a `multi: true` decision, classifier entries SHALL be removed from the resolved decider chain (`[agent]` if nothing remains) and `flow:decision.chain` SHALL show the filtered chain. A step-level `decider:` containing a classifier entry on a multi decision SHALL be a validation error.

#### Scenario: Inherited classifier chain
- **GIVEN** setting `flows.decider: [system-one, agent]`
- **WHEN** a multi agent-decision runs
- **THEN** System One SHALL NOT be called AND `flow:decision.chain` SHALL be `["agent"]`

### Requirement: Multi routes and items are observable

`flow:decision` of an agent-decision SHALL carry `labels` (returned order) and `routes` (`{ branch, itemCount? }`), with `label` the first label or absent, emitted after item expansion and carrying `routeError` when expansion fails. Every per-agent event of an instance SHALL carry `itemIndex` and `itemCount`, and the TUI SHALL show the instance as `<agent>[i]`.

#### Scenario: Decision event of a fan-out
- **WHEN** a multi agent-decision returns `explore` whose `for_each` yields two items
- **THEN** `flow:decision` SHALL carry `labels: ["explore"]` AND `routes: [{ branch: "explore", itemCount: 2 }]`

#### Scenario: Instance events
- **WHEN** instance 1 of 3 of step `explore` emits assistant text
- **THEN** `flow:assistant-text` SHALL carry `stepId: "explore"`, `itemIndex: 1`, `itemCount: 3`
