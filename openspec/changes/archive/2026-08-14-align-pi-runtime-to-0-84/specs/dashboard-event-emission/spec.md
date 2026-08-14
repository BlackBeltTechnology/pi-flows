## MODIFIED Requirements

### Requirement: pi-flows package.json declares real peerDependency ranges

The `package.json#peerDependencies` block SHALL NOT use the unconstrained `"*"` specifier for any pi-namespace peer dependency. Each peer SHALL declare a caret range pinned to the lowest version currently known to work (the version present in this repo's `node_modules/` at the time of this change).

The three pi-namespace peers — `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` — SHALL share the same caret floor, and that floor SHALL match the version the repo is built and tested against. The same floor SHALL be mirrored in `devDependencies` for those three peers. Non-pi peers (e.g. `@sinclair/typebox`) are out of scope for this rule and keep their independent pins.

The repo SHALL document, in `design.md`, how the pinned lower bound was chosen (i.e., the rule: pick the version from `node_modules/<name>/package.json` and apply a caret).

#### Scenario: peerDependencies do not use "*"

- **WHEN** parsing `pi-flows/package.json`
- **THEN** the `peerDependencies` object SHALL NOT contain any value equal to `"*"`
- **AND** every value SHALL be a parseable semver range with a defined lower bound

#### Scenario: Pin reflects current working version

- **WHEN** the pin is read for `@earendil-works/pi-coding-agent`
- **THEN** the range SHALL include the version currently in `pi-flows/node_modules/@earendil-works/pi-coding-agent/package.json`
- **AND** the range SHALL use the caret form (e.g., `^X.Y.Z`)

#### Scenario: The three pi peers share the tested floor in both dependency blocks

- **WHEN** parsing `pi-flows/package.json`
- **THEN** `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` SHALL each declare the same caret floor in `peerDependencies`
- **AND** the same three SHALL declare that identical caret floor in `devDependencies`
- **AND** that floor SHALL match the version present in `node_modules/` at the time of this change
