# Events API

This document details the events emitted and listened to by pi-flows.

## Registration Events (You -> pi-flows)

These events are used to register components with the flow engine. They should be emitted during your extension's `init` hook.

### `flow:register-provider`
Registers a custom LLM provider.

```typescript
type ProviderRegistration = {
    id: string; // e.g., 'anthropic'
    name: string; // e.g., 'Anthropic'
    provider: any; // The provider instance
    autoDiscoverModels?: boolean; // Whether to fetch models dynamically
    defaultModels?: string[]; // Fallback list if auto-discovery fails
}
```
**Example:**
```typescript
app.emit('flow:register-provider', {
    id: 'openai',
    name: 'OpenAI',
    provider: openAIProvider,
    autoDiscoverModels: true
});
```

### `flow:register-card`
Registers a custom dashboard card renderer for a specific agent.

```typescript
type CardRegistration = {
    agentId: string;
    renderer: AgentCardRenderer;
}

type AgentCardRenderer = {
    render(data: CardData): BlessedElement;
    getHeight(data: CardData): number;
}
```

### `flow:register-agent-dir`
Registers a directory containing agent `.md` files.

```typescript
app.emit('flow:register-agent-dir', '/path/to/agents');
```

### `flow:register-flow-dir`
Registers a directory containing flow `.yaml` files.

```typescript
app.emit('flow:register-flow-dir', '/path/to/flows');
```

### `flow:register-skill-dir`
Registers a directory containing skills to be made available to agents.

```typescript
app.emit('flow:register-skill-dir', '/path/to/skills');
```

### `flow:register-workflow`
Registers a hardcoded workflow definition.

```typescript
type WorkflowDefinition = {
    id: string;
    name: string;
    description: string;
    steps: FlowStep[];
}
```

### `flow:register-gate`
Registers a custom condition gate for conditional steps.

```typescript
type GateRegistration = {
    id: string;
    evaluate: (context: Record<string, any>) => boolean | Promise<boolean>;
}
```

### `flow:register-guard`
Registers a custom guard for access control.

```typescript
type GuardRegistration = {
    id: string;
    validate: (context: Record<string, any>) => boolean | Promise<boolean>;
}
```

### `flow:register-footer-segment`
Registers a segment to be displayed in the flow footer.

```typescript
type FooterSegment = {
    id: string;
    render: () => string;
    position: 'left' | 'right';
    order?: number;
}
```

## Runtime Events (pi-flows -> You)

These events are emitted by the flow engine during execution.

### `flow:started`
Emitted when a flow execution begins.

```typescript
type FlowStartedEvent = {
    runId: string;
    flowId: string;
    startTime: number;
}
```

### `flow:step-started`
Emitted when a step within a flow begins execution.

```typescript
type FlowStepStartedEvent = {
    runId: string;
    stepId: string;
    agentId?: string;
    startTime: number;
}
```

### `flow:step-completed`
Emitted when a step completes successfully.

```typescript
type FlowStepCompletedEvent = {
    runId: string;
    stepId: string;
    result: any;
    endTime: number;
}
```

### `flow:step-failed`
Emitted when a step fails.

```typescript
type FlowStepFailedEvent = {
    runId: string;
    stepId: string;
    error: Error;
    endTime: number;
}
```

### `flow:completed`
Emitted when a flow execution finishes.

```typescript
type FlowCompletedEvent = {
    runId: string;
    flowId: string;
    status: 'success' | 'failed';
    results: Record<string, any>;
    endTime: number;
}
```

## Query/Internal Events

### `flow:get-models`
Used to query available models.

```typescript
// Emits
app.emit('flow:get-models', (models) => {
    console.log(models);
});
```

### `flow:set-role`
Sets the model assigned to a specific role.

```typescript
type SetRoleEvent = {
    role: string;
    modelId: string;
}
```
