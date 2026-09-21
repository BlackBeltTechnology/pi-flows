## ADDED Requirements

### Requirement: Declares supported peer version range

`pi-flows/package.json` SHALL declare `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` in `peerDependencies` with the range `>=0.84.1 <1.0.0`. The range SHALL admit every host on the 0.84, 0.85, and 0.86 lines (and any later pre-1.0.0 line) while excluding 1.0.0 and above. No caret (`^`) form SHALL be used for these three peers, because a caret pinned to a `0.x` version narrows to a single minor line and would exclude newer supported hosts.

#### Scenario: 0.84 host satisfies the peer range

- **WHEN** a consumer installs `pi-flows` on a host providing `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` at `0.84.1`
- **THEN** the peer range SHALL be satisfied and the install SHALL NOT report an unmet peer dependency.

#### Scenario: 0.86 host satisfies the peer range

- **WHEN** a consumer installs `pi-flows` on a host providing the three `@earendil-works/*` peers at `0.86.1`
- **THEN** the peer range SHALL be satisfied and the install SHALL NOT report an unmet peer dependency.

#### Scenario: A 1.0.0 host is excluded

- **WHEN** a consumer installs `pi-flows` on a host providing any of the three `@earendil-works/*` peers at `1.0.0`
- **THEN** the peer range SHALL NOT be satisfied, so an incompatible major host is flagged rather than silently accepted.
