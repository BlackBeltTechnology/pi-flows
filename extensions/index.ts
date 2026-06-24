// ---------------------------------------------------------------------------
// pi-flows — Single Extension Entry Point
//
// All sub-extensions are loaded through this single entry point so they share
// one jiti module graph. This eliminates module identity issues where dynamic
// imports between extensions would create separate module instances with
// different module-level variables (jiti uses moduleCache: false).
//
// Activation order must match the original package.json declaration order.
// New extensions should be added at the appropriate position in the sequence.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { activate as activateAutonomousMode } from "./autonomous-mode.js";
import { activate as activateFileTracker } from "./file-tracker.js";
import { activate as activateFlowEngine } from "./flow-engine/index.js";
import { activate as activateFlowDashboard } from "./flow-dashboard/index.js";
import { activate as activateFlowSummary } from "./flow-summary/index.js";
import { activate as activateFlowContext } from "./flow-context/index.js";
import { activate as activateFlowWorkspace } from "./flow-workspace/index.js";
import { activate as activateFlowFooter } from "./flow-footer.js";

export type { CodeNodeContext, CodeNodeHandler } from "./flow-engine/types.js";
export { FlowHardError } from "./flow-engine/types.js";

export default function activate(pi: ExtensionAPI) {
  activateAutonomousMode(pi);
  activateFileTracker(pi);
  activateFlowEngine(pi);
  activateFlowDashboard(pi);
  activateFlowSummary(pi);
  activateFlowContext(pi);
  activateFlowWorkspace(pi);
  activateFlowFooter(pi);
}
