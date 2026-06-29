# package-manifest delta

## ADDED Requirements

### Requirement: Package exposes a `./testing` subpath export

`pi-flows/package.json` SHALL declare a `"./testing"` entry in `exports` pointing at `"./extensions/flow-engine/testing.ts"`. The `"."` entry SHALL remain unchanged. The target file SHALL be shipped (it lives under `extensions/`, which `files[]` already includes); no entry SHALL require shipping `__tests__/`.

The `./testing` subpath exists so a downstream consumer can resolve the flow-testing API via `import("@blackbelt-technology/pi-flows/testing")` or `createRequire(...).resolve("@blackbelt-technology/pi-flows/testing")`, without deep-importing engine internals.

#### Scenario: Testing subpath import resolves

- **WHEN** a process that has `pi-flows` reachable in its `node_modules` chain calls `await import("@blackbelt-technology/pi-flows/testing")`
- **THEN** the import SHALL return an object exposing at least `runFauxFlow`, `spawnFaux`, `scriptFinish`, and `parseFlowYamlString`.

#### Scenario: require.resolve on the testing subpath succeeds

- **WHEN** a process calls `createRequire(...).resolve("@blackbelt-technology/pi-flows/testing")` with `pi-flows` reachable via `node_modules` (real or symlinked)
- **THEN** the call SHALL return the absolute path to `extensions/flow-engine/testing.ts` and SHALL NOT throw `MODULE_NOT_FOUND`.

#### Scenario: Root export is unchanged

- **WHEN** a process imports `"@blackbelt-technology/pi-flows"` (the `"."` entry)
- **THEN** it SHALL continue to receive the same activator default and `CodeNodeContext` / `CodeNodeHandler` / `FlowHardError` exports as before this change.

#### Scenario: Test suite is not shipped

- **WHEN** the published tarball is inspected (`npm pack --dry-run`)
- **THEN** `__tests__/` SHALL NOT be included in the package payload, and `extensions/flow-engine/testing.ts` SHALL be included.
