// ---------------------------------------------------------------------------
// Flow Write Tool
//
// Validates flow YAML content via flow-validate, then writes it to the
// discovery-derived location .pi/flows/flows/<namespace>/<name>.yaml, which
// auto-registers as the /<namespace>:<name> command. Emits "flow:rediscover"
// after a successful write. Overwriting an existing file edits it. No raw
// `path` param — the engine derives the canonical discovered location.
// ---------------------------------------------------------------------------

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../types.js";
import { validateFlowContent, unsafeNameError } from "./flow-validate.js";
import { generateCodeHandlers } from "../flow-generate.js";
import { parseFlowYamlString } from "../flow-parser-yaml.js";
import { PI_TOO_OLD } from "../decider/pi-ai.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function registerFlowWriteTool(
  pi: ExtensionAPI,
  getDiscoveredAgents: () => Map<string, AgentConfig>,
  projectRoot: string,
  userRoot?: string,
): void {
  pi.registerTool({
    name: "flow_write",
    label: "flow_write",
    description:
      "Validate and write a flow YAML file. Validates internally first; on " +
      "success writes to .pi/flows/flows/<namespace>/<name>.yaml, which " +
      "auto-registers as the /<namespace>:<name> command. scope \"user\" writes to <agentDir>/flows/flows/ instead (all projects). namespace defaults " +
      "to \"custom\". Overwriting an existing <namespace>/<name>.yaml edits it. " +
      "On success returns the written flow path plus generatedHandlers — the " +
      "absolute paths of the <id>.ts.default scaffolds written for each code " +
      "node. Returns validation diagnostics on failure.",
    parameters: Type.Object({
      namespace: Type.Optional(Type.String({ description: "Flow namespace / subfolder (default \"custom\"). Becomes the /<namespace>: command prefix." })),
      name: Type.String({ description: "Flow file name without extension. Becomes the command name after the namespace prefix." }),
      content: Type.String({ description: "The flow YAML content to validate and write" }),
      scope: Type.Optional(
        Type.Union([Type.Literal("project"), Type.Literal("user")], {
          description: "Where to save: \"project\" (default, .pi/flows/) or \"user\" (<agentDir>/flows/, available in every project)",
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const { name, content } = params as { namespace?: string; name: string; content: string };
      const namespace = (params as { namespace?: string }).namespace?.trim() || "custom";

      const nameError = unsafeNameError("name", name) ?? unsafeNameError("namespace", namespace);
      if (nameError) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ written: false, error: nameError }, null, 2) }],
          details: {},
        };
      }

      const scope = (params as { scope?: unknown }).scope;
      if (scope !== undefined && scope !== "project" && scope !== "user") {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ written: false, error: `Invalid scope "${String(scope)}". Allowed values: "project", "user".` }, null, 2) }],
          details: {},
        };
      }
      if (scope === "user" && !userRoot) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ written: false, error: "User scope is not available (no user flows directory configured)." }, null, 2) }],
          details: {},
        };
      }

      // Run validation first
      // Classifier-model check needs the session registry. Without
      // `getModelOfType` (pi < 0.99.0) it cannot run — warn rather than skip silently.
      const registry: any = (ctx as any)?.modelRegistry;
      const canCheck = typeof registry?.getModelOfType === "function";
      let classifierCheckSkipped = false;
      const isKnownClassifier = canCheck
        ? (ref: string) => {
            const i = ref.indexOf("/");
            try { return !!registry.getModelOfType("classifier", ref.slice(0, i), ref.slice(i + 1)); } catch { return true; }
          }
        : (_ref: string) => { classifierCheckSkipped = true; return true; };
      const validation = validateFlowContent(content, getDiscoveredAgents, isKnownClassifier);
      if (classifierCheckSkipped) {
        validation.diagnostics.push({ line: 1, severity: "warning", message: PI_TOO_OLD });
      }
      if (!validation.valid) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ written: false, diagnostics: validation.diagnostics }, null, 2) }],
          details: {},
        };
      }

      // Bundled layout: each flow is a self-contained directory
      // `.pi/flows/flows/<namespace>/<name>/` holding `flow.yaml` and its
      // co-located code handlers.
      const flowDir = join(scope === "user" ? userRoot! : join(projectRoot, ".pi", "flows"), "flows", namespace, name);
      const filePath = join(flowDir, "flow.yaml");
      const command = `${namespace}:${name}`;

      try {
        mkdirSync(flowDir, { recursive: true });
        writeFileSync(filePath, content, "utf-8");
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ written: false, error: err instanceof Error ? err.message : String(err) }, null, 2) }],
          details: {},
        };
      }

      // Generate code-node handler templates against the just-persisted YAML.
      // Best-effort: a generation failure must not fail the write itself.
      let generationDiagnostics: typeof validation.diagnostics = [];
      let generatedHandlers: string[] = [];
      try {
        const flow = parseFlowYamlString(content, filePath);
        const gen = generateCodeHandlers(flow, filePath);
        generationDiagnostics = gen.diagnostics;
        generatedHandlers = gen.generated;
      } catch {
        // Parsing/generation problems are non-fatal here — validation already passed.
      }

      // Trigger re-discovery so the new flow registers as a command immediately
      pi.events.emit("flow:rediscover", {});

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ written: true, name, namespace, command, path: filePath, generatedHandlers, diagnostics: [...validation.diagnostics, ...generationDiagnostics] }, null, 2) }],
        details: {},
      };
    },
  });
}
