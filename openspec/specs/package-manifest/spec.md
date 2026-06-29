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

