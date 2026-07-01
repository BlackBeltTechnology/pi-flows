/**
 * flow-auto-end-session, tasks 1.2–1.4 — the auto-end gate and the
 * flow:complete → shutdown wiring.
 *
 * Gate = flow opted in (auto_end) AND session non-interactive AND terminal
 * status is "success". shutdown() is only ever reachable via flow:complete.
 */
import { describe, it, expect, vi } from "vitest";
import { shouldAutoEnd, registerAutoEndListener } from "../extensions/flow-engine/auto-end.js";

describe("shouldAutoEnd gate", () => {
  const pass = { autoEnd: true, status: "success", isInteractive: false };

  it("passes when flow opted in, non-interactive, and status success", () => {
    expect(shouldAutoEnd(pass)).toBe(true);
  });

  it("fails when the flow did not opt in", () => {
    expect(shouldAutoEnd({ ...pass, autoEnd: false })).toBe(false);
    expect(shouldAutoEnd({ ...pass, autoEnd: undefined })).toBe(false);
  });

  it("fails when the session is interactive", () => {
    expect(shouldAutoEnd({ ...pass, isInteractive: true })).toBe(false);
  });

  it("fails on aborted", () => {
    expect(shouldAutoEnd({ ...pass, status: "aborted" })).toBe(false);
  });

  it("fails on error", () => {
    expect(shouldAutoEnd({ ...pass, status: "error" })).toBe(false);
  });
});

function makeBus() {
  const handlers: Record<string, Array<(d: unknown) => void>> = {};
  return {
    events: {
      on: (ev: string, h: (d: unknown) => void) => {
        (handlers[ev] ??= []).push(h);
      },
    },
    emit: (ev: string, data: unknown) => {
      (handlers[ev] ?? []).forEach((h) => h(data));
    },
  };
}

describe("registerAutoEndListener wiring", () => {
  it("calls shutdown on flow:complete when the gate passes", () => {
    const bus = makeBus();
    const shutdown = vi.fn();
    registerAutoEndListener(bus as any, {
      getFlow: () => ({ auto_end: true }) as any,
      isInteractive: () => false,
      shutdown,
    });
    bus.emit("flow:complete", { flowName: "f", status: "success" });
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it("does not call shutdown when the gate fails (interactive)", () => {
    const bus = makeBus();
    const shutdown = vi.fn();
    registerAutoEndListener(bus as any, {
      getFlow: () => ({ auto_end: true }) as any,
      isInteractive: () => true,
      shutdown,
    });
    bus.emit("flow:complete", { flowName: "f", status: "success" });
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("does not call shutdown before flow:complete has fired", () => {
    const bus = makeBus();
    const shutdown = vi.fn();
    registerAutoEndListener(bus as any, {
      getFlow: () => ({ auto_end: true }) as any,
      isInteractive: () => false,
      shutdown,
    });
    expect(shutdown).not.toHaveBeenCalled();
  });
});
