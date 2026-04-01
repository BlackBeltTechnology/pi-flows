/**
 * Provider Extension
 *
 * Registers LLM providers with auto-discovered models.
 * Config: ~/.pi/agent/providers.json
 *
 * Commands:
 *   /provider  - add, list, or remove providers
 *   /roles     - assign models to roles
 *
 * Event API (for dashboard / programmatic access):
 *   flow:provider-list / flow:provider-add / flow:provider-edit / flow:provider-remove
 *   flow:role-get-all / flow:role-set / flow:role-preset-load / flow:role-preset-save / flow:role-preset-delete
 *   flow:resolve-model / flow:get-available-models
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { searchableOverlay } from "./shared/overlays.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// -- Types ----------------------------------------------------------------

interface ProviderEntry {
  baseUrl: string;
  apiKey: string;
  api?: string;
}

interface RolePreset {
  name: string;
  roles: Record<string, string>;
}

interface Config {
  providers: Record<string, ProviderEntry>;
  roles: Record<string, string>;
  rolePresets?: RolePreset[];
  activePreset?: string | null;
  autonomousMode?: boolean;
}

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
        // Migration: drop legacy modelIds field
        delete (entry as any).modelIds;
      }
      return {
        providers,
        roles: { ...DEFAULT_CONFIG.roles, ...raw.roles },
        rolePresets: Array.isArray(raw.rolePresets) ? raw.rolePresets : [],
        activePreset: raw.activePreset ?? null,
        // Migration: silently ignore legacy 'models' array
        autonomousMode: raw.autonomousMode,
      };
    } catch {
      // Fall through to defaults
    }
  }
  return structuredClone(DEFAULT_CONFIG);
}

function saveConfig(config: Config): void {
  mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
  // Do not write legacy 'models' or 'modelIds' fields
  const { ...toSave } = config;
  writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2));
}

// -- API key resolution ---------------------------------------------------

function resolveApiKey(apiKey: string): string | undefined {
  if (apiKey.startsWith("$")) {
    return process.env[apiKey.slice(1)];
  }
  return apiKey;
}

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

// -- Model discovery from /v1/models endpoint -----------------------------

interface DiscoveredModel {
  id: string;
  owned_by?: string;
}

async function discoverModels(baseUrl: string, apiKey: string): Promise<DiscoveredModel[]> {
  const resolved = resolveApiKey(apiKey);
  if (!resolved) return [];

  // Append /models to baseUrl
  const url = baseUrl.endsWith("/") ? `${baseUrl}models` : `${baseUrl}/models`;

  try {
    const response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${resolved}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.warn(`[provider] Model discovery failed for ${url}: HTTP ${response.status}`);
      return [];
    }

    const body = await response.json() as any;
    if (!body?.data || !Array.isArray(body.data)) {
      console.warn(`[provider] Model discovery: unexpected response format from ${url}`);
      return [];
    }

    return body.data
      .filter((m: any) => m?.id && typeof m.id === "string")
      .map((m: any) => ({ id: m.id, owned_by: m.owned_by }));
  } catch (err: any) {
    console.warn(`[provider] Model discovery failed for ${url}: ${err.message}`);
    return [];
  }
}

// -- Mutable state (module-level, shared via single entry point) ----------

let currentRoles: Record<string, string> = { ...DEFAULT_CONFIG.roles };
let currentSessionProvider = "";
let currentSessionModelId = "";

// Reference to pi for event queries (set during activate)
let piRef: ExtensionAPI | null = null;

export function getSessionInfo(): { provider: string; modelId: string } {
  return { provider: currentSessionProvider, modelId: currentSessionModelId };
}

export function getModelDisplayName(modelId: string): string {
  // Use event-based model resolution — no ctx.modelRegistry dependency
  if (piRef) {
    const data: any = {};
    piRef.events.emit("flow:get-available-models", data);
    if (data.models && Array.isArray(data.models)) {
      const match = data.models.find((m: any) => m.id === modelId || `${m.provider}/${m.id}` === modelId);
      if (match?.name) return match.name;
    }
  }
  return modelId;
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
  const config = loadConfig();
  config.autonomousMode = enabled;
  saveConfig(config);
}

function loadAutonomousMode(): void {
  const config = loadConfig();
  autonomousModeEnabled = config.autonomousMode ?? false;
}

// -- Provider registration (with auto-discovery) --------------------------

async function registerEntry(pi: ExtensionAPI, name: string, entry: ProviderEntry): Promise<number> {
  const discovered = await discoverModels(entry.baseUrl, entry.apiKey);

  const models = discovered.map((m) => ({
    id: m.id,
    name: m.id,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    contextWindow: 200000,
    maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));

  pi.registerProvider(name, {
    baseUrl: entry.baseUrl,
    apiKey: resolveApiKeyEnvName(name, entry.apiKey),
    api: (entry.api ?? "openai-completions") as any,
    models,
  });

  return discovered.length;
}

// -- Helper: get modelRegistry via event ----------------------------------

function getModelRegistry(): any {
  if (!piRef) return null;
  const spawnCtx: any = {};
  piRef.events.emit("flow:get-spawn-context", spawnCtx);
  return spawnCtx.modelRegistry ?? null;
}

// -- Extension entry point ------------------------------------------------

export function activate(pi: ExtensionAPI) {
  piRef = pi;
  const config = loadConfig();
  currentRoles = config.roles;
  loadAutonomousMode();

  // Register providers (async discovery, fire-and-forget at startup)
  for (const [name, entry] of Object.entries(config.providers)) {
    registerEntry(pi, name, entry).catch(() => {});
  }

  // ── Event API: Model Resolution ─────────────────────────────────────

  pi.events.on("flow:resolve-model", async (data: any) => {
    const modelRef: string = data?.modelRef;
    if (!modelRef) return;

    // Resolve role alias
    let modelId = modelRef;
    if (modelRef.startsWith("@")) {
      const resolved = getModelRole(modelRef.slice(1));
      if (!resolved) return;
      modelId = resolved;
    }

    const registry = getModelRegistry();
    if (!registry) return;

    const parts = modelId.split("/");
    let model: any;
    if (parts.length >= 2) {
      model = registry.find(parts[0], parts.slice(1).join("/"));
    }
    if (!model) {
      const allModels = registry.getAll?.() ?? [];
      model = allModels.find((m: any) => m.id === modelId);
    }
    if (!model) return;

    data.model = model;
    try {
      data.auth = await registry.getApiKeyAndHeaders(model);
    } catch {
      data.auth = { ok: false, error: "Auth resolution failed" };
    }
  });

  pi.events.on("flow:get-available-models", (data: any) => {
    const registry = getModelRegistry();
    if (!registry) {
      data.models = [];
      return;
    }
    try {
      const available = registry.getAvailable?.() ?? registry.getAll?.() ?? [];
      data.models = available.map((m: any) => ({
        provider: m.provider,
        id: m.id,
        name: m.name ?? m.id,
      }));
    } catch {
      data.models = [];
    }
  });

  // ── Event API: Provider Management ──────────────────────────────────

  pi.events.on("flow:provider-list", (data: any) => {
    const cfg = loadConfig();
    data.providers = Object.entries(cfg.providers).map(([name, entry]) => ({
      name,
      baseUrl: entry.baseUrl,
      api: entry.api ?? "openai-completions",
      hasAuth: hasApiKey(name, entry),
    }));
  });

  pi.events.on("flow:provider-add", async (data: any) => {
    const { name, baseUrl, apiKey, api } = data;
    if (!name || !baseUrl || !apiKey) {
      data.success = false;
      data.error = "Missing required fields: name, baseUrl, apiKey";
      return;
    }

    const cfg = loadConfig();
    if (cfg.providers[name]) {
      data.success = false;
      data.error = `Provider "${name}" already exists`;
      return;
    }

    const entry: ProviderEntry = { baseUrl, apiKey, api: api ?? "openai-completions" };
    cfg.providers[name] = entry;
    saveConfig(cfg);
    // Sync in-memory config
    config.providers[name] = entry;

    let modelsDiscovered = 0;
    let discoveryError: string | undefined;
    try {
      modelsDiscovered = await registerEntry(pi, name, entry);
    } catch (err: any) {
      discoveryError = err.message;
    }

    data.success = true;
    data.modelsDiscovered = modelsDiscovered;
    if (discoveryError) data.discoveryError = discoveryError;
    pi.events.emit("provider:changed", { action: "add", name });
  });

  pi.events.on("flow:provider-edit", async (data: any) => {
    const { name, fields } = data;
    if (!name) { data.success = false; data.error = "Missing provider name"; return; }

    const cfg = loadConfig();
    const existing = cfg.providers[name];
    if (!existing) {
      data.success = false;
      data.error = `Provider "${name}" not found`;
      return;
    }

    if (fields?.baseUrl) existing.baseUrl = fields.baseUrl;
    if (fields?.apiKey) existing.apiKey = fields.apiKey;
    if (fields?.api) existing.api = fields.api;

    cfg.providers[name] = existing;
    saveConfig(cfg);
    config.providers[name] = existing;

    let modelsDiscovered = 0;
    try {
      modelsDiscovered = await registerEntry(pi, name, existing);
    } catch { /* ignore */ }

    data.success = true;
    data.modelsDiscovered = modelsDiscovered;
    pi.events.emit("provider:changed", { action: "edit", name });
  });

  pi.events.on("flow:provider-remove", (data: any) => {
    const { name } = data;
    if (!name) { data.success = false; data.error = "Missing provider name"; return; }

    const cfg = loadConfig();
    if (!cfg.providers[name]) {
      data.success = false;
      data.error = `Provider "${name}" not found`;
      return;
    }

    delete cfg.providers[name];
    saveConfig(cfg);
    delete config.providers[name];

    data.success = true;
    pi.events.emit("provider:changed", { action: "remove", name });
  });

  // ── Event API: Role Management ─────────────────────────────────────

  pi.events.on("flow:role-get-all", (data: any) => {
    const cfg = loadConfig();
    data.roles = { ...cfg.roles };
    data.presets = cfg.rolePresets ?? [];
    data.activePreset = cfg.activePreset ?? null;
  });

  pi.events.on("flow:role-set", (data: any) => {
    const { role, modelId } = data;
    if (!role || !modelId) { data.success = false; return; }

    config.roles[role] = modelId;
    currentRoles = { ...config.roles };
    config.activePreset = null;
    saveConfig(config);
    data.success = true;
    pi.events.emit("provider:changed", { action: "roles-updated" });
  });

  pi.events.on("flow:role-preset-load", (data: any) => {
    const { name } = data;
    const cfg = loadConfig();
    const preset = (cfg.rolePresets ?? []).find((p) => p.name === name);
    if (!preset) { data.success = false; return; }

    for (const [role, model] of Object.entries(preset.roles)) {
      config.roles[role] = model;
    }
    currentRoles = { ...config.roles };
    config.activePreset = name;
    saveConfig(config);
    data.success = true;
  });

  pi.events.on("flow:role-preset-save", (data: any) => {
    const { name } = data;
    if (!name) { data.success = false; return; }

    if (!config.rolePresets) config.rolePresets = [];
    const existing = config.rolePresets.findIndex((p) => p.name === name);
    const preset: RolePreset = { name, roles: { ...config.roles } };
    if (existing >= 0) {
      config.rolePresets[existing] = preset;
    } else {
      config.rolePresets.push(preset);
    }
    saveConfig(config);
    data.success = true;
  });

  pi.events.on("flow:role-preset-delete", (data: any) => {
    const { name } = data;
    if (!name || !config.rolePresets) { data.success = false; return; }

    const before = config.rolePresets.length;
    config.rolePresets = config.rolePresets.filter((p) => p.name !== name);
    if (config.rolePresets.length === before) { data.success = false; return; }

    saveConfig(config);
    data.success = true;
  });

  // ── TUI Command: /roles ────────────────────────────────────────────

  pi.registerCommand("roles", {
    description: "Assign models to roles",
    handler: async (_args, ctx) => {
      while (true) {
        // Build top-level menu options
        const options: string[] = ["Edit roles", "Save as preset"];
        const presets = config.rolePresets ?? [];
        for (const preset of presets) {
          const isActive = config.activePreset === preset.name;
          options.push(isActive ? `✓ Load: ${preset.name}` : `Load: ${preset.name}`);
        }
        if (presets.length > 0) options.push("Delete preset");

        const topChoice = await ctx.ui.select("Model Roles", options);
        if (!topChoice) return;

        if (topChoice === "Save as preset") {
          const name = await ctx.ui.input("Preset name", "default");
          if (!name) continue;
          const result: any = {};
          pi.events.emit("flow:role-preset-save", { name, ...result });
          ctx.ui.notify(`Saved preset "${name}"`, "info");
          continue;
        }

        if (topChoice.startsWith("Load: ") || topChoice.startsWith("✓ Load: ")) {
          const presetName = topChoice.replace(/^✓?\s*Load:\s*/, "");
          const result: any = {};
          pi.events.emit("flow:role-preset-load", { name: presetName, ...result });
          ctx.ui.notify(`Loaded preset "${presetName}"`, "info");
          continue;
        }

        if (topChoice === "Delete preset") {
          const presetOptions = presets.map((p) => p.name);
          const toDelete = await ctx.ui.select("Delete which preset?", presetOptions);
          if (toDelete) {
            pi.events.emit("flow:role-preset-delete", { name: toDelete });
            ctx.ui.notify(`Deleted preset "${toDelete}"`, "info");
          }
          continue;
        }

        if (topChoice === "Edit roles") {
          // Get available models for searchable selection
          const modelsData: any = {};
          pi.events.emit("flow:get-available-models", modelsData);
          const modelItems = (modelsData.models ?? []).map((m: any) => ({
            value: `${m.provider}/${m.id}`,
            label: `${m.provider}/${m.id}`,
            description: m.name,
          }));

          if (modelItems.length === 0) {
            ctx.ui.notify("No authenticated models found. Use /login or /provider to configure.", "warning");
            continue;
          }

          // Pick a role to edit
          const roleOptions = Object.keys(config.roles).map((role) =>
            `@${role} → ${config.roles[role] || "(not set)"}`
          );
          const roleChoice = await ctx.ui.select("Select role to edit", roleOptions);
          if (!roleChoice) continue;

          const roleName = roleChoice.split(" → ")[0].slice(1); // strip "@"

          // Use searchableOverlay for model picking (60+ models)
          const modelChoice = await searchableOverlay(ctx, `Model for @${roleName}`, modelItems);
          if (!modelChoice) continue;

          const setResult: any = {};
          pi.events.emit("flow:role-set", { role: roleName, modelId: modelChoice, ...setResult });
          ctx.ui.notify(`@${roleName} → ${modelChoice}`, "info");
        }
      }
    },
  });

  // ── TUI Command: /provider ─────────────────────────────────────────

  pi.registerCommand("provider", {
    description: "Add, list, or remove providers",
    handler: async (_args, ctx) => {
      while (true) {
        // Build menu options
        const options: string[] = ["+ Add new provider"];
        const names = Object.keys(config.providers);
        for (const name of names) {
          const entry = config.providers[name];
          const keyOk = hasApiKey(name, entry);
          options.push(`${keyOk ? "✓" : "✗"} ${name} — ${entry.baseUrl}`);
        }
        if (names.length > 0) options.push("- Remove provider");

        const choice = await ctx.ui.select("Providers", options);
        if (!choice) return;

        if (choice === "+ Add new provider") {
          const name = await ctx.ui.input("Provider name", "my-proxy");
          if (!name) continue;
          const baseUrl = await ctx.ui.input("Base URL", "https://.../v1");
          if (!baseUrl) continue;
          const apiKey = await ctx.ui.input("API key ($ENV_VAR or literal)", "$MY_PROXY_KEY");
          if (!apiKey) continue;
          const api = await ctx.ui.select("API Protocol", ["openai-completions", "anthropic-messages"]);
          if (!api) continue;

          const result: any = {};
          await pi.events.emit("flow:provider-add", { name, baseUrl, apiKey, api, ...result });

          if (result.success) {
            const countMsg = result.modelsDiscovered > 0
              ? ` (${result.modelsDiscovered} models discovered)`
              : " (no models discovered)";
            if (!hasApiKey(name, { baseUrl, apiKey, api })) {
              ctx.ui.notify(`Added "${name}"${countMsg}. Set ${apiKey} before use.`, "warning");
            } else {
              ctx.ui.notify(`Added "${name}"${countMsg}`, "info");
            }
            if (result.discoveryError) {
              ctx.ui.notify(`Model discovery warning: ${result.discoveryError}`, "warning");
            }
          } else {
            ctx.ui.notify(result.error || "Failed to add provider", "error");
          }
        } else if (choice === "- Remove provider") {
          const removeOptions = names.map((n) => n);
          const toRemove = await ctx.ui.select("Remove which provider?", removeOptions);
          if (!toRemove) continue;

          const result: any = {};
          pi.events.emit("flow:provider-remove", { name: toRemove, ...result });
          if (result.success) {
            ctx.ui.notify(`Removed "${toRemove}"`, "info");
          }
        } else {
          // Edit existing provider — extract name from the menu string
          const providerName = names.find((n) => choice.includes(n));
          if (!providerName) continue;

          const existing = config.providers[providerName];
          if (!existing) continue;

          const editOptions = [
            `Base URL: ${existing.baseUrl}`,
            `API Key: ${existing.apiKey.startsWith("$") ? existing.apiKey : "••••••"}`,
            `API Protocol: ${existing.api ?? "openai-completions"}`,
            "Refresh models",
          ];

          const field = await ctx.ui.select(`Edit "${providerName}"`, editOptions);
          if (!field) continue;

          const fields: any = {};
          if (field.startsWith("Base URL:")) {
            const val = await ctx.ui.input("Base URL", existing.baseUrl);
            if (val) fields.baseUrl = val;
          } else if (field.startsWith("API Key:")) {
            const val = await ctx.ui.input("API key ($ENV_VAR or literal)", existing.apiKey);
            if (val) fields.apiKey = val;
          } else if (field.startsWith("API Protocol:")) {
            const val = await ctx.ui.select("API Protocol", ["openai-completions", "anthropic-messages"]);
            if (val) fields.api = val;
          }
          // "Refresh models" falls through with empty fields — re-registers with discovery

          const result: any = {};
          await pi.events.emit("flow:provider-edit", { name: providerName, fields, ...result });
          if (result.success) {
            const msg = result.modelsDiscovered > 0
              ? `Updated "${providerName}" (${result.modelsDiscovered} models)`
              : `Updated "${providerName}"`;
            ctx.ui.notify(msg, "info");
          }
        }

        continue;
      }
    },
  });

  // ── Session lifecycle ──────────────────────────────────────────────

  pi.on("model_select", async (_event, ctx) => {
    if (ctx.model) {
      currentSessionProvider = ctx.model.provider ?? "";
      currentSessionModelId = ctx.model.id ?? "";
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.model) {
      currentSessionProvider = ctx.model.provider ?? "";
      currentSessionModelId = ctx.model.id ?? "";
    }

    // Warn about providers missing API keys
    for (const [name, entry] of Object.entries(config.providers)) {
      if (!hasApiKey(name, entry)) {
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
