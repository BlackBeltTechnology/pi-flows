## ADDED Requirements

### Requirement: Post-flow summary renders preserved agent cards

When a flow completes and the post-flow summary widget mounts, the widget SHALL render the preserved agent cards from the `lastCards` snapshot in their grid layout, frozen and read-only, above the summary lines. The cards SHALL reflect the final state captured at flow completion and SHALL NOT update afterward.

If no card snapshot is available for an agent (e.g. it never produced a card), the widget SHALL fall back to the existing per-agent summary line for that agent without erroring.

#### Scenario: Cards shown above summary lines on completion

- **WHEN** a flow with multiple agents completes and the summary widget mounts
- **THEN** the widget SHALL render each preserved agent card in grid layout
- **AND** the cards SHALL appear above the per-agent summary lines
- **AND** the cards SHALL be static (no further live updates)

#### Scenario: Missing card falls back to summary line

- **WHEN** the summary widget mounts and one agent has no preserved card in the snapshot
- **THEN** the widget SHALL render the remaining cards normally
- **AND** that agent SHALL still be represented by its summary line
- **AND** the widget SHALL NOT throw or render an empty frame

### Requirement: Summary lines and next-step hint remain beneath the cards

The post-flow summary widget SHALL continue to render, beneath the cards, the per-agent finish `summary` strings, the next-step hint (when a next flow resolves), and the footer key hints. These lines remain the scannable TL;DR while the cards carry the detail.

#### Scenario: Summary lines and footer still present

- **WHEN** the summary widget is rendered after flow completion
- **THEN** the per-agent summary lines SHALL appear below the cards
- **AND** the footer SHALL show the `alt+o inspect · alt+x dismiss` hints
- **AND** the next-step hint SHALL appear when a subsequent flow resolves

### Requirement: alt+o opens the per-agent detail overlay

With the cards now always visible after completion, `alt+o` SHALL open the per-agent detail overlay (full tool history) for the selected agent — the deep drill-in that a static card cannot display. The always-visible cards SHALL NOT remove or replace the detail overlay.

#### Scenario: alt+o still reaches full tool history

- **WHEN** the summary widget is shown and the user presses `alt+o`
- **THEN** the per-agent detail overlay with full tool history SHALL be reachable
- **AND** the always-visible cards SHALL remain the at-a-glance view
