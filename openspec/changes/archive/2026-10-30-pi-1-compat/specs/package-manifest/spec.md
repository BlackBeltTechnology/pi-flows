## REMOVED Requirements

### Requirement: Declares supported peer version range

**Reason**: The range capped hosts below 1.0.0, so pi-flows fails to install cleanly on pi 1.x even though nothing it uses changed in pi 1.0.0–1.0.2.

**Migration**: None for consumers. Every host the old range admitted (0.84.1 up to but excluding 1.0.0) is still admitted; 1.x hosts are now admitted as well.

## ADDED Requirements

### Requirement: Declares supported peer version range across pi 0.84+ and 1.x

`pi-flows/package.json` SHALL declare `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` in `peerDependencies` with the range `>=0.84.1 <2.0.0`. The range SHALL admit every host on the 0.84 line and later, including every 1.x line, while excluding 2.0.0 and above. No caret (`^`) form SHALL be used for these three peers. `pi-flows/package.json` SHALL declare `typebox` (not `@sinclair/typebox`) as a peer with a range satisfied by the TypeBox versions those hosts ship (1.3.7 on 0.84.1, 1.3.27 on 1.0.2), and SHALL NOT declare `@sinclair/typebox` in `dependencies` or `peerDependencies`.

#### Scenario: 0.84 host satisfies the peer range

- **WHEN** a consumer installs `pi-flows` on a host providing the three `@earendil-works/*` peers at `0.84.1` and `typebox` at `1.3.7`
- **THEN** the peer ranges SHALL be satisfied and the install SHALL NOT report an unmet peer dependency.

#### Scenario: 1.0.2 host satisfies the peer range

- **WHEN** a consumer installs `pi-flows` on a host providing the three `@earendil-works/*` peers at `1.0.2` and `typebox` at `1.3.27`
- **THEN** the peer ranges SHALL be satisfied and the install SHALL NOT report an unmet peer dependency.

#### Scenario: A 2.0.0 host is excluded

- **WHEN** a consumer installs `pi-flows` on a host providing any of the three `@earendil-works/*` peers at `2.0.0`
- **THEN** the peer range SHALL NOT be satisfied, so an incompatible major host is flagged rather than silently accepted.

#### Scenario: No legacy TypeBox dependency

- **WHEN** `pi-flows/package.json` is inspected
- **THEN** `@sinclair/typebox` SHALL NOT appear in `dependencies` or `peerDependencies`, and `typebox` SHALL appear in `peerDependencies`.
