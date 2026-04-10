# Public API Reference

This document covers the core TypeScript types and functions exported by pi-flows.

## Core Types

### `AgentConfig`
```typescript
export interface AgentConfig {
    id: string;
    name: string;
    description: string;
    role?: string;
    tools?: string[];
    skills?: string[];
    inputs?: Record<string, any>; // JSON Schema
    systemPrompt: string;
}
```

### `FlowConfig`
```typescript
export interface FlowConfig {
    id: string;
    name: string;
    description: string;
    inputs?: Record<string, any>;
    steps: FlowStep[];
}
```

### `FlowStep`
```typescript
export type FlowStep = 
  | AgentStep 
  | ForkStep 
  | ConditionalStep 
  | DecisionStep 
  | FlowReferenceStep;

export interface BaseStep {
    id: string;
    type: string;
    dependsOn?: string[];
}

export interface AgentStep extends BaseStep {
    type: 'agent';
    agent: string;
    inputs?: Record<string, string | any>;
}
// (Other step types follow similar patterns)
```

### `FlowResult`
```typescript
export interface FlowResult {
    runId: string;
    flowId: string;
    status: 'success' | 'failed' | 'cancelled';
    stepResults: Record<string, any>;
    startTime: number;
    endTime: number;
}
```

## Functions

### Parsing and Discovery

#### `parseAgentFile(filePath: string): Promise<AgentConfig>`
Reads and parses an agent `.md` file, extracting frontmatter and body.

#### `parseFlowFile(filePath: string): Promise<FlowConfig>`
Reads and parses a flow `.yaml` file.

#### `discoverAll(dirs: { agents: string[], flows: string[] }): Promise<{ agents: Map<string, AgentConfig>, flows: Map<string, FlowConfig> }>`
Scans directories and loads all agents and flows.

### Execution

#### `spawnAgent(app: PiApp, config: AgentConfig, input: any): Promise<any>`
Spawns an agent subprocess independently of a flow.

#### `executeFlow(app: PiApp, flowId: string, input: any): Promise<FlowResult>`
Starts a flow execution.
