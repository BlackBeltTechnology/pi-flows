/** Spec: classifier-decisions — decide() chain execution (3.1). */
import { describe, expect, it } from "vitest";
import { decide, describeAttempts } from "../extensions/flow-engine/decider/chain.js";
import type { EntryResult } from "../extensions/flow-engine/decider/types.js";

const ok = (label: string, confidence = 0.9, extra: Partial<any> = {}): EntryResult => ({ ok: true, answer: { label, confidence, ...extra } });
const base = { trust: "confidence" as const, minConfidence: 0.75, labels: ["done", "fix"] };

describe("decide", () => {
  it("first trusted valid label routes; later entries not tried", async () => {
    const calls: string[] = [];
    const r = await decide({ ...base, entries: ["a/b", "agent"], run: async (e) => { calls.push(e); return ok("done"); } });
    expect(r).toMatchObject({ ok: true, label: "done", routedBy: "a/b" });
    expect(calls).toEqual(["a/b"]);
  });
  it("untrusted → shadow, continue; agreed filled", async () => {
    const r = await decide({
      ...base, entries: ["a/b", "agent"],
      run: async (e) => e === "agent" ? { ok: true, answer: { label: "done", confidence: 1 }, authoritative: true } : ok("done", 0.6),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.routedBy).toBe("agent");
    expect(r.attempts[0]).toMatchObject({ entry: "a/b", outcome: "untrusted", trusted: false, agreed: true, label: "done", confidence: 0.6 });
    expect(r.attempts[1]).toMatchObject({ entry: "agent", outcome: "ok", trusted: true });
  });
  it("shadow disagreement", async () => {
    const r = await decide({
      ...base, entries: ["a/b", "agent"],
      run: async (e) => e === "agent" ? { ok: true, answer: { label: "fix", confidence: 1 }, authoritative: true } : ok("done", 0.1),
    });
    if (!r.ok) throw new Error("x");
    expect(r.attempts[0].agreed).toBe(false);
  });
  it("invalid label is a failed attempt, never routed", async () => {
    const r = await decide({ ...base, entries: ["system-one"], run: async () => ok("maybe") });
    expect(r.ok).toBe(false);
    expect(r.attempts[0]).toMatchObject({ outcome: "invalid-label", label: "maybe" });
    expect(describeAttempts(r.attempts, base.labels)).toMatch(/maybe/);
    expect(describeAttempts(r.attempts, base.labels)).toMatch(/done, fix/);
  });
  it("failed attempts carry reason; exhausted → ok false with all attempts", async () => {
    const r = await decide({
      ...base, entries: ["system-one", "a/b"],
      run: async (e) => ({ ok: false, outcome: e === "a/b" ? "credentials" : "no-backend", reason: `why ${e}` }),
    });
    expect(r.ok).toBe(false);
    expect(r.attempts.map((a) => a.outcome)).toEqual(["no-backend", "credentials"]);
    expect(describeAttempts(r.attempts, base.labels)).toMatch(/why a\/b/);
  });
  it("abort stops the chain", async () => {
    const ac = new AbortController();
    const calls: string[] = [];
    const r = await decide({
      ...base, entries: ["a/b", "agent"], signal: ac.signal,
      run: async (e) => { calls.push(e); ac.abort(); return { ok: false, outcome: "error" }; },
    });
    expect(calls).toEqual(["a/b"]);
    expect(r).toMatchObject({ ok: false, aborted: true });
    expect(r.attempts.at(-1)?.outcome).toBe("aborted");
  });
  it("entry exceeding the timeout fails with timeout and the chain continues", async () => {
    const r = await decide({
      ...base, entries: ["a/b", "x/y"], timeoutMs: 20,
      run: async (e, signal) => e === "a/b" ? new Promise(() => { void signal; }) : ok("fix"),
    });
    expect(r.attempts[0].outcome).toBe("timeout");
    expect(r).toMatchObject({ ok: true, label: "fix", routedBy: "x/y" });
  });
  it("a throwing entry is an error attempt", async () => {
    const r = await decide({ ...base, entries: ["a/b"], run: async () => { throw new Error("boom"); } });
    expect(r.attempts[0]).toMatchObject({ outcome: "error", reason: "boom" });
  });
  it("agent entries are not subject to the timeout", async () => {
    const r = await decide({
      ...base, entries: ["agent"], timeoutMs: 10,
      run: async () => { await new Promise((res) => setTimeout(res, 40)); return { ok: true, answer: { label: "done", confidence: 1 }, authoritative: true }; },
    });
    expect(r.ok).toBe(true);
  });
});
