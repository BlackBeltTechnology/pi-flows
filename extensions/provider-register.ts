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
 */

import type {
  ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import {
  Container,
  type SelectItem,
  type SettingItem,
  SettingsList,
  type SettingsListTheme,
  Spacer,
  Text,
} from "@mariozechner/pi-tui";
import { SearchableSelectList } from "./shared/searchable-select-list.js";
import { selectOverlay } from "./shared/select-overlay.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// -- Types ----------------------------------------------------------------

interface ProviderEntry {
  baseUrl: string;
  apiKey: string;
  api?: string;
}

interface ModelEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
}

interface Config {
  providers: Record<string, ProviderEntry>;
  roles: Record<string, string>;
  models: ModelEntry[];
}

// -- Default custom model catalog -----------------------------------------

const DEFAULT_MODELS: ModelEntry[] = [
  { id: "cc/claude-opus-4-6", name: "Opus 4.6", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 128000 },
  { id: "cc/claude-sonnet-4-6", name: "Sonnet 4.6", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 64000 },
  { id: "cc/claude-haiku-4-5-20251001", name: "Haiku 4.5", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 64000 },
  { id: "glm/glm-5", name: "GLM 5", reasoning: false, input: ["text", "image"], contextWindow: 200000, maxTokens: 131072 },
  { id: "gemini/gemini-3-pro-preview", name: "Gemini 3 Pro", reasoning: false, input: ["text"], contextWindow: 1048576, maxTokens: 65536 },
  { id: "openrouter/inception/mercury-2", name: "Mercury 2", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192 },
  { id: "minimax/MiniMax-M2.5", name: "MiniMax M2.5", reasoning: false, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072 },
  { id: "minimax/MiniMax-M2.1", name: "MiniMax M2.1", reasoning: false, input: ["text", "image"], contextWindow: 1048576, maxTokens: 131072 },
];

// -- Defaults -------------------------------------------------------------

const CONFIG_PATH = join(homedir(), ".pi", "agent", "providers.json");

const DEFAULT_CONFIG: Config = {
  providers: {},
  roles: {
    planning: "anthropic/claude-opus-4-6",
    coding: "anthropic/claude-sonnet-4-6",
    modelling: "anthropic/claude-opus-4-6",
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

// -- Mutable state --------------------------------------------------------

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

// -- Helpers --------------------------------------------------------------

function registerEntry(pi: ExtensionAPI, name: string, entry: ProviderEntry, models: ModelEntry[]) {
  pi.registerProvider(name, {
    baseUrl: entry.baseUrl,
    apiKey: resolveApiKeyEnvName(name, entry.apiKey),
    api: (entry.api ?? "openai-completions") as any,
    models: models.map((m) => ({
      ...m,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  });
}

// -- Extension ------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  currentRoles = config.roles;

  // Register providers
  for (const [name, entry] of Object.entries(config.providers)) {
    registerEntry(pi, name, entry, config.models);
  }

  // -- /roles: assign models to roles -------------------------------------

  pi.registerCommand("roles", {
    description: "Assign models to roles",
    handler: async (_args, ctx) => {
        // Build merged model list: registry models + user-defined custom models
        const seen = new Set<string>();
        const modelItems: SelectItem[] = [];

        // Add models from pi's ModelRegistry (built-in + configured providers)
        for (const model of ctx.modelRegistry.getAll()) {
          const value = `${model.provider}/${model.id}`;
          if (!seen.has(value)) {
            seen.add(value);
            modelItems.push({ value, label: value, description: model.name });
          }
        }

        // Add user-defined custom model strings (deduplicated)
        // Skip entries whose id is already a suffix of a registered model
        for (const m of config.models) {
          if (!seen.has(m.id)) {
            const alreadyRegistered = [...seen].some((key) => key.endsWith(`/${m.id}`));
            if (!alreadyRegistered) {
              seen.add(m.id);
              modelItems.push({ value: m.id, label: m.id, description: m.name });
            }
          }
        }

        await ctx.ui.custom((tui: any, t: any, _kb: any, done: () => void) => {
          const settingsTheme: SettingsListTheme = {
            label: (text, selected) => selected ? t.fg("accent", text) : text,
            value: (text, selected) => selected ? t.fg("accent", text) : t.fg("muted", text),
            description: (text) => t.fg("dim", text),
            cursor: t.fg("accent", "→ "),
            hint: (text) => t.fg("dim", text),
          };

          const items: SettingItem[] = Object.keys(config.roles).map((role) => ({
            id: role,
            label: `@${role}`,
            description: `Assign a model to the ${role} role`,
            currentValue: config.roles[role] || "(not set)",
            submenu: (_currentValue: string, submenuDone: (val?: string) => void) => {
              const searchable = new SearchableSelectList(modelItems, 10, {
                selectedPrefix: (text: string) => t.fg("accent", text),
                selectedText: (text: string) => t.fg("accent", text),
                description: (text: string) => t.fg("muted", text),
                scrollInfo: (text: string) => t.fg("dim", text),
                noMatch: (text: string) => t.fg("warning", text),
              });
              searchable.onSelect = (item: SelectItem) => submenuDone(item.value);
              searchable.onCancel = () => submenuDone(undefined);
              return {
                render: (w: number) => searchable.render(w),
                invalidate: () => searchable.invalidate(),
                handleInput: (data: string) => {
                  searchable.handleInput(data);
                  tui.requestRender();
                },
              };
            },
          }));

          const settingsList = new SettingsList(
            items,
            Math.min(items.length + 2, 12),
            settingsTheme,
            (id: string, newValue: string) => {
              config.roles[id] = newValue;
              currentRoles = { ...config.roles };
              saveConfig(config);
            },
            () => done(),
          );

          const container = new Container();
          container.addChild(new DynamicBorder((s: string) => t.fg("accent", s)));
          container.addChild(new Text(t.fg("accent", t.bold(" Model Roles")), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(settingsList);
          container.addChild(new Spacer(1));
          container.addChild(new Text(t.fg("dim", " Enter: change model  Esc: close"), 0, 0));
          container.addChild(new DynamicBorder((s: string) => t.fg("accent", s)));

          return {
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
              // Backspace at top level closes the overlay (same as Esc)
              if ((data === "\x7f" || data === "\b") && !(settingsList as any).submenuComponent) {
                done();
                return;
              }
              settingsList.handleInput(data);
              tui.requestRender();
            },
          };
        });
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
        if (!name) return;
        const baseUrl = await ctx.ui.input("Base URL", "https://.../v1");
        if (!baseUrl) return;
        const apiKey = await ctx.ui.input("API key ($ENV_VAR or literal)", "$MY_PROXY_KEY");
        if (!apiKey) return;
        const api = await ctx.ui.select("API protocol", [
          "openai-completions",
          "anthropic-messages",
        ]);
        if (!api) return;

        // Select models via SearchableSelectList overlay
        const allModelsItem: SelectItem = { value: "__all__", label: "All models", description: "Register all catalog models" };
        const modelSelectItems: SelectItem[] = [
          allModelsItem,
          ...config.models.map((m) => ({ value: m.id, label: m.id, description: m.name })),
        ];

        const selectedModelId = await new Promise<string | null>((resolve) => {
          ctx.ui.custom((tui: any, t: any, _kb: any, done: (val: string | null) => void) => {
            const searchable = new SearchableSelectList(modelSelectItems, 10, {
              selectedPrefix: (text: string) => t.fg("accent", text),
              selectedText: (text: string) => t.fg("accent", text),
              description: (text: string) => t.fg("muted", text),
              scrollInfo: (text: string) => t.fg("dim", text),
              noMatch: (text: string) => t.fg("warning", text),
            });
            searchable.onSelect = (item: SelectItem) => done(item.value);
            searchable.onCancel = () => done(null);

            const container = new Container();
            container.addChild(new DynamicBorder((s: string) => t.fg("accent", s)));
            container.addChild(new Text(t.fg("accent", t.bold(" Select models to register")), 0, 0));
            container.addChild(new Spacer(1));
            container.addChild(searchable as any);
            container.addChild(new Spacer(1));
            container.addChild(new Text(t.fg("dim", " Type to search  Enter: select  Esc: all models"), 0, 0));
            container.addChild(new DynamicBorder((s: string) => t.fg("accent", s)));

            return {
              render: (w: number) => container.render(w),
              invalidate: () => container.invalidate(),
              handleInput: (data: string) => {
                searchable.handleInput(data);
                tui.requestRender();
              },
            };
          }).then(resolve);
        });

        const entry: ProviderEntry = { baseUrl, apiKey, api };
        config.providers[name] = entry;
        saveConfig(config);

        if (!selectedModelId || selectedModelId === "__all__") {
          registerEntry(pi, name, entry, config.models);
        } else {
          const selectedModel = config.models.find((m) => m.id === selectedModelId);
          if (selectedModel) {
            pi.registerProvider(name, {
              baseUrl: entry.baseUrl,
              apiKey: resolveApiKeyEnvName(name, entry.apiKey),
              api: (entry.api ?? "openai-completions") as any,
              models: [{
                ...selectedModel,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              }],
            });
          }
        }

        if (!hasApiKey(name, entry)) {
          ctx.ui.notify(`Added "${name}". Set ${apiKey} before use.`, "warning");
        } else {
          ctx.ui.notify(`Added "${name}"`, "info");
        }
      } else if (choice !== "__remove__" && config.providers[choice]) {
        // Edit existing provider
        const name = choice;
        const existing = config.providers[name];

        const editItems: SelectItem[] = [
          { value: "baseUrl", label: "Base URL", description: existing.baseUrl },
          { value: "apiKey", label: "API Key", description: existing.apiKey.startsWith("$") ? existing.apiKey : "••••••" },
          { value: "api", label: "API Protocol", description: existing.api ?? "openai-completions" },
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
          const api = await ctx.ui.select("API protocol", [
            "openai-completions",
            "anthropic-messages",
          ]);
          if (!api) continue;
          existing.api = api;
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

      return; // action completed, exit loop
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
