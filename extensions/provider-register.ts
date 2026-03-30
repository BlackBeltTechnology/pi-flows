/**
 * Provider Extension
 *
 * Registers LLM providers with shared model catalog.
 * Defaults to Anthropic models. Custom providers added via /provider.
 * Config: ~/.pi/agent/providers.json
 *
 * Commands:
 *   /provider  - add, list, or remove providers
 *   /roles     - assign models to roles
 *   /catalog   - manage model catalog (browse, add, edit, remove)
 */

import type {
  ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import {
  type SelectItem,
  type SettingItem,
} from "@mariozechner/pi-tui";
import {
  selectOverlay,
  searchableOverlay,
  settingsOverlay,
  checkboxOverlay,
  textInputSubmenu,
  type CheckboxResult,
} from "./shared/overlays.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// -- Types ----------------------------------------------------------------

interface ProviderEntry {
  baseUrl: string;
  apiKey: string;
  api?: string;
  modelIds?: string[];
}

interface ModelEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
}

interface RolePreset {
  name: string;
  roles: Record<string, string>;
}

interface Config {
  providers: Record<string, ProviderEntry>;
  roles: Record<string, string>;
  rolePresets?: RolePreset[];
  models: ModelEntry[];
  autonomousMode?: boolean;
}

// -- Default custom model catalog -----------------------------------------

const DEFAULT_MODELS: ModelEntry[] = [
  { id: "cc/claude-opus-4-6", name: "Opus 4.6", reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 128000 },
  { id: "cc/claude-sonnet-4-6", name: "Sonnet 4.6", reasoning: true, input: ["text", "image"], contextWindow: 1000000, maxTokens: 64000 },
  { id: "cc/claude-haiku-4-5-20251001", name: "Haiku 4.5", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 64000 },
  { id: "glm/glm-5", name: "GLM 5", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 128000 },
  { id: "gemini/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", reasoning: false, input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536 },
  { id: "openrouter/inception/mercury-2", name: "Mercury 2", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192 },
  { id: "minimax/MiniMax-M2.5", name: "MiniMax M2.5", reasoning: false, input: ["text", "image"], contextWindow: 1048576, maxTokens: 8192 },
  { id: "minimax/MiniMax-M2.1", name: "MiniMax M2.1", reasoning: false, input: ["text", "image"], contextWindow: 196608, maxTokens: 196608 },
];

// -- Defaults -------------------------------------------------------------

const CONFIG_PATH = join(homedir(), ".pi", "agent", "providers.json");

const DEFAULT_CONFIG: Config = {
  providers: {},
  roles: {
    planning: "anthropic/claude-opus-4-6",
    coding: "anthropic/claude-sonnet-4-6",
    compact: "anthropic/claude-haiku-4-5",
    fast: "anthropic/claude-haiku-4-5",
    research: "anthropic/claude-opus-4-6",
    vision: "anthropic/claude-sonnet-4-6",
  },
  models: DEFAULT_MODELS,
};

// -- Config I/O -----------------------------------------------------------

function loadConfig(): Config {
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      const providers = { ...DEFAULT_CONFIG.providers, ...raw.providers };
      for (const [, entry] of Object.entries(providers) as [string, any][]) {
        if (entry.apiKeyEnv && !entry.apiKey) {
          entry.apiKey = "$" + entry.apiKeyEnv;
          delete entry.apiKeyEnv;
        }
      }
      return {
        providers,
        roles: { ...DEFAULT_CONFIG.roles, ...raw.roles },
        rolePresets: Array.isArray(raw.rolePresets) ? raw.rolePresets : [],
        models: Array.isArray(raw.models) ? raw.models : DEFAULT_MODELS,
      };
    } catch {
      // Fall through to defaults
    }
  }
  return structuredClone(DEFAULT_CONFIG);
}

function saveConfig(config: Config): void {
  mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// -- API key resolution ---------------------------------------------------

function resolveApiKeyEnvName(providerName: string, apiKey: string): string {
  if (apiKey.startsWith("$")) {
    return apiKey.slice(1);
  }
  const syntheticEnv = `JUDO_${providerName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_KEY`;
  process.env[syntheticEnv] = apiKey;
  return syntheticEnv;
}

function hasApiKey(_providerName: string, entry: ProviderEntry): boolean {
  if (entry.apiKey.startsWith("$")) {
    return !!process.env[entry.apiKey.slice(1)];
  }
  return true;
}

// -- Mutable state (module-level, shared via single entry point) ----------

let currentRoles: Record<string, string> = { ...DEFAULT_CONFIG.roles };
let currentSessionProvider = "";
let currentSessionModelId = "";

export function getSessionInfo(): { provider: string; modelId: string } {
  return { provider: currentSessionProvider, modelId: currentSessionModelId };
}

export function getModelDisplayName(modelId: string): string {
  const config = loadConfig();
  const model = config.models.find((m) => m.id === modelId);
  return model?.name ?? modelId;
}

export function getModelRole(role: string): string | undefined {
  return currentRoles[role];
}

// -- Autonomous mode state ------------------------------------------------

let autonomousModeEnabled = false;

export function isAutonomousMode(): boolean {
  return autonomousModeEnabled;
}

export function setAutonomousMode(enabled: boolean): void {
  autonomousModeEnabled = enabled;
  // Persist to config
  const config = loadConfig();
  config.autonomousMode = enabled;
  saveConfig(config);
}

function loadAutonomousMode(): void {
  const config = loadConfig();
  autonomousModeEnabled = config.autonomousMode ?? false;
}

// -- Helpers --------------------------------------------------------------

function registerEntry(pi: ExtensionAPI, name: string, entry: ProviderEntry, models: ModelEntry[]) {
  const filtered = entry.modelIds
    ? models.filter((m) => entry.modelIds!.includes(m.id))
    : models;
  pi.registerProvider(name, {
    baseUrl: entry.baseUrl,
    apiKey: resolveApiKeyEnvName(name, entry.apiKey),
    api: (entry.api ?? "openai-completions") as any,
    models: filtered.map((m) => ({
      ...m,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  });
}

// -- Multi-select overlay helper ------------------------------------------

interface MultiSelectResult {
  /** Selected model IDs, or null if all models / cancelled */
  selectedIds: string[] | null;
  /** Whether any new models were added to the catalog */
  catalogChanged: boolean;
}

/**
 * Show a multi-select overlay for choosing models from the catalog.
 * Returns selected model IDs, or null for "all models".
 * Includes inline quick-add support via checkboxOverlay actionItems.
 */
async function showModelMultiSelect(
  ctx: any,
  config: Config,
  preSelected?: string[],
): Promise<MultiSelectResult> {
  let catalogChanged = false;
  let currentPreSelected = preSelected ?? config.models.map((m) => m.id);

  // Loop to support inline quick-add (re-renders overlay after adding)
  while (true) {
    const modelItems: SelectItem[] = config.models.map((m) => ({
      value: m.id,
      label: m.id,
      description: m.name,
    }));

    const result: CheckboxResult = await checkboxOverlay(ctx, "Select Models", modelItems, {
      preSelected: currentPreSelected,
      allToggle: true,
      actionItems: [{ value: "__add__", label: "+ Add new model", description: "Quick-add to catalog and select" }],
      hints: ["Space/Enter: toggle  Enter on confirm  Esc: cancel"],
    });

    if (result.type === "action" && result.value === "__add__") {
      const newId = await ctx.ui.input("Model ID", "provider/model-name");
      if (newId && !config.models.some((m: ModelEntry) => m.id === newId)) {
        config.models.push({
          id: newId,
          name: newId,
          reasoning: false,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 16384,
        });
        saveConfig(config);
        catalogChanged = true;
        currentPreSelected = [...currentPreSelected, newId];
        ctx.ui.notify(`Added "${newId}" to catalog`, "info");
      } else if (newId) {
        ctx.ui.notify(`Model "${newId}" already exists`, "warning");
      }
      continue; // re-show multi-select
    }

    if (result.type === "selected") {
      const ids = result.ids;
      if (ids.length === 0 || ids.length === config.models.length) {
        return { selectedIds: null, catalogChanged };
      }
      return { selectedIds: ids, catalogChanged };
    }

    // cancelled
    return { selectedIds: null, catalogChanged };
  }
}

// -- Extension ------------------------------------------------------------

export function activate(pi: ExtensionAPI) {
  const config = loadConfig();
  currentRoles = config.roles;
  loadAutonomousMode();

  // Register providers
  for (const [name, entry] of Object.entries(config.providers)) {
    registerEntry(pi, name, entry, config.models);
  }



  // -- /roles: assign models to roles -------------------------------------

  pi.registerCommand("roles", {
    description: "Assign models to roles",
    handler: async (_args, ctx) => {
      while (true) {
        // Top-level menu: Edit roles or manage presets
        const topItems: SelectItem[] = [
          { value: "__edit__", label: "Edit roles", description: "Assign models to roles" },
          { value: "__save_preset__", label: "Save as preset", description: "Save current roles as a named preset" },
        ];

        // Add existing presets
        const presets = config.rolePresets ?? [];
        if (presets.length > 0) {
          for (const preset of presets) {
            const summary = Object.values(preset.roles).slice(0, 2).join(", ") + (Object.keys(preset.roles).length > 2 ? "…" : "");
            topItems.push({ value: `__preset__${preset.name}`, label: `▶ ${preset.name}`, description: summary });
          }
          topItems.push({ value: "__delete_preset__", label: "Delete preset", description: "Remove a saved preset" });
        }

        const topChoice = await selectOverlay(ctx, "Model Roles", topItems);
        if (!topChoice) return; // Esc on top menu → exit command

        // -- Save current roles as preset ---
        if (topChoice === "__save_preset__") {
          const name = await ctx.ui.input("Preset name", "default");
          if (!name) continue;
          if (!config.rolePresets) config.rolePresets = [];
          const existing = config.rolePresets.findIndex((p) => p.name === name);
          const preset: RolePreset = { name, roles: { ...config.roles } };
          if (existing >= 0) {
            config.rolePresets[existing] = preset;
          } else {
            config.rolePresets.push(preset);
          }
          saveConfig(config);
          ctx.ui.notify(`Saved preset "${name}"`, "info");
          continue;
        }

        // -- Load a preset ---
        if (topChoice.startsWith("__preset__")) {
          const presetName = topChoice.slice("__preset__".length);
          const preset = presets.find((p) => p.name === presetName);
          if (preset) {
            // Apply preset roles (merge: keep existing role keys, override with preset values)
            for (const [role, model] of Object.entries(preset.roles)) {
              config.roles[role] = model;
            }
            currentRoles = { ...config.roles };
            saveConfig(config);
            ctx.ui.notify(`Loaded preset "${presetName}"`, "info");
          }
          continue;
        }

        // -- Delete a preset ---
        if (topChoice === "__delete_preset__") {
          const deleteItems: SelectItem[] = presets.map((p) => ({
            value: p.name,
            label: p.name,
            description: Object.values(p.roles).slice(0, 2).join(", "),
          }));
          const toDelete = await selectOverlay(ctx, "Delete which preset?", deleteItems);
          if (toDelete && config.rolePresets) {
            config.rolePresets = config.rolePresets.filter((p) => p.name !== toDelete);
            saveConfig(config);
            ctx.ui.notify(`Deleted preset "${toDelete}"`, "info");
          }
          continue;
        }

        // -- Edit roles (original behavior, filtered to available models) ---

        // Build model list: only authenticated/available models
        const seen = new Set<string>();
        const modelItems: SelectItem[] = [];

        // Use getAvailable() to only show models with auth configured
        const availableModels = ctx.modelRegistry.getAvailable?.() ?? ctx.modelRegistry.getAll();
        for (const model of availableModels) {
          const value = `${model.provider}/${model.id}`;
          if (!seen.has(value)) {
            seen.add(value);
            modelItems.push({ value, label: value, description: model.name });
          }
        }

        // Add user-defined custom models only if their provider has auth
        for (const m of config.models) {
          if (!seen.has(m.id)) {
            const alreadyRegistered = [...seen].some((key) => key.endsWith(`/${m.id}`));
            if (!alreadyRegistered) {
              // Check if the custom model's provider has API key configured
              const providerName = m.id.split("/")[0];
              if (providerName && config.providers[providerName] && hasApiKey(providerName, config.providers[providerName])) {
                seen.add(m.id);
                modelItems.push({ value: m.id, label: m.id, description: m.name });
              }
            }
          }
        }

        if (modelItems.length === 0) {
          ctx.ui.notify("No authenticated models found. Use /login or /provider to configure.", "warning");
          continue;
        }

        await settingsOverlay(ctx, "Model Roles", [], (id: string, newValue: string) => {
          config.roles[id] = newValue;
          currentRoles = { ...config.roles };
          saveConfig(config);
        }, {
          hints: ["Enter: change model  Esc: close"],
          createItems: (t, theme) => {
            const { SearchableSelectList } = require("./shared/searchable-select-list.js");
            return Object.keys(config.roles).map((role) => ({
              id: role,
              label: `@${role}`,
              description: `Assign a model to the ${role} role`,
              currentValue: config.roles[role] || "(not set)",
              submenu: (_currentValue: string, submenuDone: (val?: string) => void) => {
                const searchable = new SearchableSelectList(modelItems, 10, theme);
                searchable.onSelect = (item: SelectItem) => submenuDone(item.value);
                searchable.onCancel = () => submenuDone(undefined);
                return {
                  render: (w: number) => searchable.render(w),
                  invalidate: () => searchable.invalidate(),
                  handleInput: (data: string) => {
                    searchable.handleInput(data);
                  },
                };
              },
            }));
          },
        });
      } // end while
    },
  });

  // -- /catalog: manage model catalog ---------------------------------------

  pi.registerCommand("catalog", {
    description: "Manage model catalog",
    handler: async (_args, ctx) => {
      // Catalog browse loop — re-enters after add/edit/delete
      while (true) {
        // Build items: "+ Add new model" at top, then all catalog models
        const catalogItems: SelectItem[] = [
          { value: "__add__", label: "+ Add new model", description: "Quick-add a model by ID" },
        ];
        for (const m of config.models) {
          const tags: string[] = [];
          if (m.reasoning) tags.push("reasoning");
          if (m.input.includes("image")) tags.push("vision");
          tags.push(`${(m.contextWindow / 1000).toFixed(0)}K ctx`);
          catalogItems.push({ value: m.id, label: m.id, description: `${m.name} • ${tags.join(" • ")}` });
        }

        const choice = await searchableOverlay(ctx, "Model Catalog", catalogItems, {
          hints: ["Enter: edit  Esc: close", `Config: ${CONFIG_PATH}`],
        });

        if (!choice) return; // Esc → close

        // -- Quick-add flow ---
        if (choice === "__add__") {
          const newId = await ctx.ui.input("Model ID", "provider/model-name");
          if (!newId) continue; // cancelled, back to catalog

          // Duplicate check
          if (config.models.some((m) => m.id === newId)) {
            ctx.ui.notify(`Model "${newId}" already exists in catalog`, "warning");
            continue;
          }

          const newModel: ModelEntry = {
            id: newId,
            name: newId,
            reasoning: false,
            input: ["text"],
            contextWindow: 128000,
            maxTokens: 16384,
          };
          config.models.push(newModel);
          saveConfig(config);
          ctx.ui.notify(`Added "${newId}" to catalog`, "info");
          continue; // back to catalog browse with new model visible
        }

        // -- Edit model flow ---
        const modelIndex = config.models.findIndex((m) => m.id === choice);
        if (modelIndex < 0) continue;
        const model = config.models[modelIndex];

        let editResult: "deleted" | "back" = "back";

        const editItems: SettingItem[] = [
          { id: "name", label: "Name", currentValue: model.name, description: "Display name", submenu: textInputSubmenu("Enter display name") },
          { id: "reasoning", label: "Reasoning", currentValue: String(model.reasoning), values: ["true", "false"], description: "Supports extended thinking" },
          { id: "vision", label: "Vision", currentValue: model.input.includes("image") ? "true" : "false", values: ["true", "false"], description: "Supports image input" },
          { id: "contextWindow", label: "Context Window", currentValue: String(model.contextWindow), description: "Context window size in tokens", submenu: textInputSubmenu("Enter token count") },
          { id: "maxTokens", label: "Max Tokens", currentValue: String(model.maxTokens), description: "Maximum output tokens", submenu: textInputSubmenu("Enter max output tokens") },
          { id: "__delete__", label: "Delete", currentValue: "", values: ["confirm"], description: "Remove from catalog" },
        ];

        await settingsOverlay(ctx, `Edit: ${model.id}`, editItems, (id: string, newValue: string) => {
          if (id === "name") {
            model.name = newValue;
          } else if (id === "reasoning") {
            model.reasoning = newValue === "true";
          } else if (id === "vision") {
            model.input = newValue === "true" ? ["text", "image"] : ["text"];
          } else if (id === "contextWindow") {
            const num = parseInt(newValue, 10);
            if (!isNaN(num) && num > 0) model.contextWindow = num;
          } else if (id === "maxTokens") {
            const num = parseInt(newValue, 10);
            if (!isNaN(num) && num > 0) model.maxTokens = num;
          } else if (id === "__delete__") {
            config.models.splice(modelIndex, 1);
            saveConfig(config);
            editResult = "deleted";
            return;
          }
          saveConfig(config);
        }, { hints: ["Enter: change  Esc: back"], maxVisible: 10 });

        if (editResult === "deleted") {
          ctx.ui.notify(`Deleted "${choice}" from catalog`, "info");
        }
        continue; // back to catalog browse
      }
    },
  });

  // -- /provider: add, list, or remove providers ---------------------------

  pi.registerCommand("provider", {
    description: "Add, list, or remove providers",
    handler: async (_args, ctx) => {
      while (true) {
      const names = Object.keys(config.providers);

      // Build SelectList items: actions + existing providers
      const items: SelectItem[] = [
        { value: "__add__", label: "+ Add new provider", description: "Register a new LLM provider" },
      ];
      for (const name of names) {
        const entry = config.providers[name];
        const keyOk = hasApiKey(name, entry);
        items.push({
          value: name,
          label: name,
          description: `${keyOk ? "✓" : "✗"} ${entry.baseUrl}`,
        });
      }
      if (names.length > 0) {
        items.push({ value: "__remove__", label: "- Remove provider", description: "Remove an existing provider" });
      }

      const choice = await selectOverlay(ctx, "Providers", items);
      if (!choice) return;

      if (choice === "__add__") {
        const name = await ctx.ui.input("Provider name", "my-proxy");
        if (!name) continue;
        const baseUrl = await ctx.ui.input("Base URL", "https://.../v1");
        if (!baseUrl) continue;
        const apiKey = await ctx.ui.input("API key ($ENV_VAR or literal)", "$MY_PROXY_KEY");
        if (!apiKey) continue;
        const api = await selectOverlay(ctx, "API Protocol", [
          { value: "openai-completions", label: "openai-completions", description: "OpenAI Chat Completions" },
          { value: "anthropic-messages", label: "anthropic-messages", description: "Anthropic Messages" },
        ]);
        if (!api) continue;

        // Multi-select models for this provider
        const { selectedIds } = await showModelMultiSelect(ctx, config);

        const entry: ProviderEntry = { baseUrl, apiKey, api };
        if (selectedIds) {
          entry.modelIds = selectedIds;
        }
        config.providers[name] = entry;
        saveConfig(config);
        registerEntry(pi, name, entry, config.models);

        if (!hasApiKey(name, entry)) {
          ctx.ui.notify(`Added "${name}". Set ${apiKey} before use.`, "warning");
        } else {
          ctx.ui.notify(`Added "${name}"`, "info");
        }
      } else if (choice !== "__remove__" && config.providers[choice]) {
        // Edit existing provider
        const name = choice;
        const existing = config.providers[name];

        const modelsDesc = existing.modelIds
          ? `${existing.modelIds.length} model${existing.modelIds.length !== 1 ? "s" : ""}`
          : "All models";

        const editItems: SelectItem[] = [
          { value: "baseUrl", label: "Base URL", description: existing.baseUrl },
          { value: "apiKey", label: "API Key", description: existing.apiKey.startsWith("$") ? existing.apiKey : "••••••" },
          { value: "api", label: "API Protocol", description: existing.api ?? "openai-completions" },
          { value: "models", label: "Models", description: modelsDesc },
        ];

        const field = await selectOverlay(ctx, `Edit "${name}"`, editItems);
        if (!field) continue; // back to main menu

        if (field === "baseUrl") {
          const baseUrl = await ctx.ui.input("Base URL", existing.baseUrl);
          if (!baseUrl) continue;
          existing.baseUrl = baseUrl;
        } else if (field === "apiKey") {
          const apiKey = await ctx.ui.input("API key ($ENV_VAR or literal)", existing.apiKey);
          if (!apiKey) continue;
          existing.apiKey = apiKey;
        } else if (field === "api") {
          const api = await selectOverlay(ctx, "API Protocol", [
            { value: "openai-completions", label: "openai-completions", description: "OpenAI Chat Completions" },
            { value: "anthropic-messages", label: "anthropic-messages", description: "Anthropic Messages" },
          ]);
          if (!api) continue;
          existing.api = api;
        } else if (field === "models") {
          const { selectedIds } = await showModelMultiSelect(ctx, config, existing.modelIds ?? undefined);
          if (selectedIds) {
            existing.modelIds = selectedIds;
          } else {
            delete existing.modelIds;
          }
        }

        saveConfig(config);
        registerEntry(pi, name, existing, config.models);
        ctx.ui.notify(`Updated "${name}"`, "info");
      } else if (choice === "__remove__") {
        // Remove via SelectList with descriptions
        const removeItems: SelectItem[] = names.map((name) => {
          const entry = config.providers[name];
          return { value: name, label: name, description: entry.baseUrl };
        });

        const toRemove = await selectOverlay(ctx, "Remove which provider?", removeItems);

        if (!toRemove) continue; // back to main menu
        delete config.providers[toRemove];
        saveConfig(config);
        ctx.ui.notify(`Removed "${toRemove}"`, "info");
      }

      continue; // action completed, loop back to provider list
      } // end while
    },
  });

  pi.on("model_select", async (_event, ctx) => {
    if (ctx.model) {
      currentSessionProvider = ctx.model.provider ?? "";
      currentSessionModelId = ctx.model.id ?? "";
    }
  });

  // -- Session start ------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.model) {
      currentSessionProvider = ctx.model.provider ?? "";
      currentSessionModelId = ctx.model.id ?? "";
    }

    for (const [name, entry] of Object.entries(config.providers)) {
      if (!hasApiKey(name, entry) && !ctx.modelRegistry.authStorage.has(name)) {
        const hint = entry.apiKey.startsWith("$")
          ? `Set ${entry.apiKey}`
          : "Check API key";
        ctx.ui.notify(
          `${name}: ${hint} or add "${name}" to ~/.pi/agent/auth.json`,
          "warning",
        );
      }
    }
  });
}
