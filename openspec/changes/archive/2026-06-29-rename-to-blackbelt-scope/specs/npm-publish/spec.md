# npm-publish delta

## ADDED Requirements

### Requirement: Package is published under the `@blackbelt-technology` scope

`pi-flows/package.json` SHALL declare `"name": "@blackbelt-technology/pi-flows"`. The unscoped name `pi-flows` SHALL NOT be used for npm publish purposes.

#### Scenario: Bare-specifier import uses the scoped name

- **WHEN** a downstream consumer wants to import the package by name
- **THEN** they SHALL write `import("@blackbelt-technology/pi-flows")` (or the `require` equivalent), and the unscoped form `import("pi-flows")` SHALL NOT be expected to resolve from the public registry.

### Requirement: Scoped package publishes as public

`pi-flows/package.json` SHALL declare `"publishConfig": { "access": "public" }`.

#### Scenario: First publish does not get rejected as private

- **WHEN** a maintainer runs `npm publish` for the first time against `registry.npmjs.org`
- **THEN** npm SHALL accept the publish as a public package and SHALL NOT reject it with "You must sign up for private packages".

### Requirement: Manifest declares the source repository

`pi-flows/package.json` SHALL declare a `"repository"` object pointing at the canonical GitHub source (`git+https://github.com/BlackBeltTechnology/pi-flows.git`).

#### Scenario: npmjs.com surfaces the repo link

- **WHEN** the package page is rendered on npmjs.com
- **THEN** the "Repository" sidebar entry SHALL link to the GitHub repo above.

### Requirement: Published tarball is restricted to consumer-facing files

`pi-flows/package.json` SHALL declare a `"files"` allowlist that includes at minimum `extensions/`, `agents/`, `README.md`, `CHANGELOG.md`, and `LICENSE`. Development-only directories (`__tests__/`, `research/`, `openspec/`, `.pi/`, `docs/` if internal) SHALL NOT be included in the published tarball.

#### Scenario: `npm pack` output excludes development artefacts

- **WHEN** a maintainer runs `npm pack --dry-run` from the package root
- **THEN** the listed file set SHALL NOT contain `__tests__/`, `research/`, `openspec/`, or `.pi/` entries.
- **AND** the listed file set SHALL contain `extensions/index.ts`, `agents/`, `README.md`, `CHANGELOG.md`, and `LICENSE`.

#### Scenario: Pi loader entry is shipped

- **WHEN** a consumer installs the published tarball
- **THEN** the file pointed at by `pi.extensions[0]` and by `main`/`exports` (currently `extensions/index.ts`) SHALL be present in `node_modules/@blackbelt-technology/pi-flows/`.
