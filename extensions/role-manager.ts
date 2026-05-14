/**
 * Role Manager Extension (pi-flows)
 *
 * Manages model role assignments (@planning, @coding, etc.) and autonomous mode.
 * Config: ~/.pi/agent/providers.json (roles section only — preserves other fields)
 *
 * Commands:
 *   /roles     - assign models to roles
 *
 * Event API:
 *   flow:role-get-all / flow:role-set / flow:role-preset-load / flow:role-preset-save / flow:role-preset-delete
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { emitPromptAndAwait } from "./flow-engine/flow-prompt.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// -- Types ----------------------------------------------------------------

interface RolePreset {
  name: string;
  roles: Record<string, string>;
}

interface RoleConfig {
  roles: Record<string, string>;
  rolePresets: RolePreset[];
  activePreset: string | null;
  autonomousMode: boolean;
}

// -- Defaults -------------------------------------------------------------

const CONFIG_PATH = join(homedir(), ".pi", "agent", "providers.json");

const DEFAULT_ROLES: Record<string, string> = {
  planning: "anthropic/claude-opus-4-6",
  coding: "anthropic/claude-sonnet-4-6",
  compact: "anthropic/claude-haiku-4-5",
  fast: "anthropic/claude-haiku-4-5",
  research: "anthropic/claude-opus-4-6",
  vision: "anthropic/claude-sonnet-4-6",
};

// -- Config I/O (roles section only — preserves other fields) -------------

function loadFullConfig(): Record<string, unknown> {
  if (existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    } catch {
      // Fall through to empty
    }
  }
  return {};
}

function loadRoleConfig(): RoleConfig {
  const raw = loadFullConfig();
  return {
    roles: { ...DEFAULT_ROLES, ...(raw.roles as Record<string, string> | undefined) },
    rolePresets: Array.isArray(raw.rolePresets) ? raw.rolePresets as RolePreset[] : [],
    activePreset: (raw.activePreset as string | null) ?? null,
    autonomousMode: (raw.autonomousMode as boolean) ?? true,
  };
}

function saveRoleConfig(roleConfig: RoleConfig): void {
  mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
  // Read full config to preserve provider fields
  const full = loadFullConfig();
  full.roles = roleConfig.roles;
  full.rolePresets = roleConfig.rolePresets;
  full.activePreset = roleConfig.activePreset;
  full.autonomousMode = roleConfig.autonomousMode;
  writeFileSync(CONFIG_PATH, JSON.stringify(full, null, 2));
}

// -- Mutable state --------------------------------------------------------

let currentRoles: Record<string, string> = { ...DEFAULT_ROLES };

export function getModelRole(role: string): string | undefined {
  // Re-read from disk per call so cross-session preset/role updates take
  // effect without needing per-session event broadcast. Each pi session has
  // its own module-scoped `currentRoles`; without this read, a preset switch
  // routed to session A would leave session B spawning agents with stale
  // role assignments. `loadRoleConfig` is a cheap sync read of a ~1 KB file
  // and `getModelRole` is called once per agent spawn (not in a hot loop).
  const cfg = loadRoleConfig();
  currentRoles = cfg.roles;
  return cfg.roles[role];
}

// -- Autonomous mode state ------------------------------------------------

let autonomousModeEnabled = true;

export function isAutonomousMode(): boolean {
  return autonomousModeEnabled;
}

export function setAutonomousMode(enabled: boolean): void {
  autonomousModeEnabled = enabled;
  const config = loadRoleConfig();
  config.autonomousMode = enabled;
  saveRoleConfig(config);
}

// -- Extension entry point ------------------------------------------------

export function activate(pi: ExtensionAPI) {
  // Bootstrap in-memory `currentRoles` from disk so `getModelRole()`
  // reflects persisted state immediately. Each event handler below
  // re-reads from disk via `loadRoleConfig()` at invocation time to
  // avoid a closure-staleness bug where preset-load + role-set
  // interleavings (or external edits to providers.json) could clobber
  // unrelated preset entries when the closure's `config.rolePresets`
  // got written back to disk.
  // See change: fix-pi-flows-end-to-end (Group 5 fix — reliable preset switch).
  {
    const boot = loadRoleConfig();
    currentRoles = boot.roles;
    autonomousModeEnabled = boot.autonomousMode;
  }

  // ── Event API: Role Management ─────────────────────────────────────

  pi.events.on("flow:role-get-all", (data: any) => {
    const cfg = loadRoleConfig();
    data.roles = { ...cfg.roles };
    data.presets = cfg.rolePresets ?? [];
    data.activePreset = cfg.activePreset ?? null;
  });

  pi.events.on("flow:role-set", (data: any) => {
    const { role, modelId } = data;
    if (!role || !modelId) { data.success = false; return; }

    const config = loadRoleConfig();
    config.roles[role] = modelId;
    currentRoles = { ...config.roles };

    // If a preset is active, update it in-place with the new role assignment
    if (config.activePreset && config.rolePresets) {
      const preset = config.rolePresets.find((p) => p.name === config.activePreset);
      if (preset) {
        preset.roles = { ...config.roles };
      }
    }

    saveRoleConfig(config);
    data.success = true;
  });

  pi.events.on("flow:role-preset-load", (data: any) => {
    const { name } = data;
    const config = loadRoleConfig();
    const preset = (config.rolePresets ?? []).find((p) => p.name === name);
    if (!preset) { data.success = false; return; }

    // Replace `config.roles` wholesale with the preset's roles so missing
    // keys are not preserved from the prior preset.
    config.roles = { ...preset.roles };
    currentRoles = { ...config.roles };
    config.activePreset = name;
    saveRoleConfig(config);
    data.success = true;
  });

  pi.events.on("flow:role-preset-save", (data: any) => {
    const { name } = data;
    if (!name) { data.success = false; return; }

    const config = loadRoleConfig();
    if (!config.rolePresets) config.rolePresets = [];
    const existing = config.rolePresets.findIndex((p) => p.name === name);
    const preset: RolePreset = { name, roles: { ...config.roles } };
    if (existing >= 0) {
      config.rolePresets[existing] = preset;
    } else {
      config.rolePresets.push(preset);
    }
    saveRoleConfig(config);
    data.success = true;
  });

  pi.events.on("flow:role-preset-delete", (data: any) => {
    const { name } = data;
    if (!name) { data.success = false; return; }

    const config = loadRoleConfig();
    if (!config.rolePresets) { data.success = false; return; }
    const before = config.rolePresets.length;
    config.rolePresets = config.rolePresets.filter((p) => p.name !== name);
    if (config.rolePresets.length === before) { data.success = false; return; }

    saveRoleConfig(config);
    data.success = true;
  });

  // ── Event-driven roles management ──────────────────────────────────

  pi.events.on("flow:roles-manage-request", async () => {
    while (true) {
      const cfg = loadRoleConfig();
      const options: string[] = ["Edit roles", "Save as preset"];
      const presets = cfg.rolePresets ?? [];
      for (const preset of presets) {
        const isActive = cfg.activePreset === preset.name;
        options.push(isActive ? `✓ Load: ${preset.name}` : `Load: ${preset.name}`);
      }
      if (presets.length > 0) options.push("Delete preset");

      const topResult = await emitPromptAndAwait(pi, {
        pipeline: "flow-mgmt",
        type: "select",
        question: "Model Roles",
        options,
      });
      if (topResult.cancelled || !topResult.answer) return;
      const topChoice = topResult.answer;

      if (topChoice === "Save as preset") {
        const nameResult = await emitPromptAndAwait(pi, {
          pipeline: "flow-mgmt",
          type: "input",
          question: "Preset name",
          defaultValue: "default",
        });
        if (nameResult.cancelled || !nameResult.answer) continue;
        pi.events.emit("flow:role-preset-save", { name: nameResult.answer });
        pi.events.emit("flow:notify", { message: `Saved preset "${nameResult.answer}"`, level: "info" });
        continue;
      }

      if (topChoice.startsWith("Load: ") || topChoice.startsWith("✓ Load: ")) {
        const presetName = topChoice.replace(/^✓?\s*Load:\s*/, "");
        pi.events.emit("flow:role-preset-load", { name: presetName });
        pi.events.emit("flow:notify", { message: `Loaded preset "${presetName}"`, level: "info" });
        continue;
      }

      if (topChoice === "Delete preset") {
        const presetOptions = presets.map((p) => p.name);
        const deleteResult = await emitPromptAndAwait(pi, {
          pipeline: "flow-mgmt",
          type: "select",
          question: "Delete which preset?",
          options: presetOptions,
        });
        if (!deleteResult.cancelled && deleteResult.answer) {
          pi.events.emit("flow:role-preset-delete", { name: deleteResult.answer });
          pi.events.emit("flow:notify", { message: `Deleted preset "${deleteResult.answer}"`, level: "info" });
        }
        continue;
      }

      if (topChoice === "Edit roles") {
        const modelsData: any = {};
        pi.events.emit("flow:get-available-models", modelsData);
        const modelOptions = (modelsData.models ?? []).map((m: any) => `${m.provider}/${m.id}`);

        if (modelOptions.length === 0) {
          pi.events.emit("flow:notify", { message: "No authenticated models found. Use /login or /provider to configure.", level: "warning" });
          continue;
        }

        const currentCfg = loadRoleConfig();
        const roleOptions = Object.keys(currentCfg.roles).map((role) =>
          `@${role} → ${currentCfg.roles[role] || "(not set)"}`
        );
        const roleResult = await emitPromptAndAwait(pi, {
          pipeline: "flow-mgmt",
          type: "select",
          question: "Select role to edit",
          options: roleOptions,
        });
        if (roleResult.cancelled || !roleResult.answer) continue;

        const roleName = roleResult.answer.split(" → ")[0].slice(1);

        const modelResult = await emitPromptAndAwait(pi, {
          pipeline: "flow-mgmt",
          type: "select",
          question: `Model for @${roleName}`,
          options: modelOptions,
        });
        if (modelResult.cancelled || !modelResult.answer) continue;

        pi.events.emit("flow:role-set", { role: roleName, modelId: modelResult.answer });
        pi.events.emit("flow:notify", { message: `@${roleName} → ${modelResult.answer}`, level: "info" });
      }
    }
  });

  // ── TUI Command: /roles (thin wrapper) ─────────────────────────────

  pi.registerCommand("roles", {
    description: "Assign models to roles",
    handler: async () => {
      pi.events.emit("flow:roles-manage-request", {});
    },
  });
}
