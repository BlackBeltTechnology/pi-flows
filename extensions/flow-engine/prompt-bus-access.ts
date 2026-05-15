/**
 * PromptBus accessor for pi-flows.
 *
 * The PromptBus lives in pi-agent-dashboard. Pi-flows accesses it via
 * a cached request function injected during adapter registration.
 * Falls back to the legacy event-based emitPromptAndAwait if no bus is available.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface PromptOptions {
  pipeline: string;
  type: "select" | "input" | "confirm" | "editor" | "multiselect";
  question: string;
  options?: string[];
  defaultValue?: string;
  metadata?: Record<string, unknown>;
}

interface PromptResponse {
  id: string;
  answer?: string;
  cancelled?: boolean;
  source: string;
}

type BusRequestFn = (options: PromptOptions) => Promise<PromptResponse>;

let cachedBusRequest: BusRequestFn | null = null;

/**
 * Set the bus request function. Called by the bridge when it registers
 * an adapter from pi-flows.
 */
export function setPromptBusRequest(fn: BusRequestFn): void {
  cachedBusRequest = fn;
}

/**
 * Check if the PromptBus is available.
 */
export function hasPromptBus(): boolean {
  return cachedBusRequest !== null;
}

/**
 * Submit a prompt via the PromptBus.
 * Falls back to legacy emitPromptAndAwait if bus is not available.
 */
export function promptBusRequest(options: PromptOptions): Promise<PromptResponse> {
  if (!cachedBusRequest) {
    throw new Error("PromptBus not available — dashboard bridge not connected");
  }
  return cachedBusRequest(options);
}

/**
 * Listen for the bus request function via pi.events.
 * Called during flow-engine activation.
 */
export function listenForPromptBus(pi: ExtensionAPI): void {
  pi.events.on("prompt:set-bus-request", (data: any) => {
    if (typeof data?.request === "function") {
      setPromptBusRequest(data.request);
    }
  });
}
