# package-manifest Specification

## Purpose
TBD - created by archiving change add-node-resolvable-entry. Update Purpose after archive.
## Requirements
### Requirement: Package is Node-resolvable as an ES module

`pi-flows/package.json` SHALL declare `"type": "module"`, `"main": "./extensions/index.ts"`, and `"exports": { ".": "./extensions/index.ts" }`. The entry path SHALL be the same file pi's own loader uses (the first entry in `pi.extensions`, after resolving the directory form).

Pi's own loader SHALL continue to read `pi.extensions` and SHALL NOT depend on `main` or `exports` for its operation. The new fields exist solely so Node-style consumers can resolve `pi-flows` via `require.resolve("pi-flows")` or `import("pi-flows")`.

#### Scenario: Bare-specifier import resolves

- **WHEN** a process that has `pi-flows` reachable in its `node_modules` chain calls `await import("pi-flows")`
- **THEN** the import SHALL return an object whose `default` property is the same activator function that `pi.extensions[0]` would produce.

#### Scenario: require.resolve succeeds

- **WHEN** a process calls `createRequire(...).resolve("pi-flows")` with `pi-flows` reachable via `node_modules` (real or symlinked)
- **THEN** the call SHALL return the absolute path to `extensions/index.ts` and SHALL NOT throw `MODULE_NOT_FOUND`.

#### Scenario: Pi loader still works

- **WHEN** pi-coding-agent reads `~/.pi/agent/settings.json#packages[]`, finds an entry pointing at the pi-flows directory, and invokes its extension-discovery code
- **THEN** the loader SHALL read `pi.extensions` (NOT `main` or `exports`) and load `./extensions` as before. No change to existing pi loading behaviour.

#### Scenario: .ts entry works under jiti

- **WHEN** the importer runs under a TypeScript-aware loader (jiti, ts-node, or any pi runtime which preloads jiti-register.mjs)
- **THEN** importing `pi-flows` SHALL succeed even though the entry file is `.ts` (no compilation step required).
- **AND** when the importer runs under a TypeScript-unaware Node (no jiti, no ts-node), the import SHALL fail with a clear "TS file requires a loader" error rather than silently returning an unusable result.

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

