// ---------------------------------------------------------------------------
// Flow Mailbox — parent-attached runs ask the main session's model.
//
// Questions from worker agents (`ask_parent`), agent extension prompts
// (`ctx.ui.*`) and fork steps park here until the parent replies through
// `flow_control`, a timeout fires, or the asker can no longer continue. New
// questions and the run end are announced: a blocked `wait` is woken, otherwise
// a 1 s batch is pushed to the parent. See change: add-flow-parent-mailbox.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { ItemRef } from "./types.js";

export type QuestionKind = "agent" | "extension" | "fork";
export type CloseVia = "reply" | "timeout" | "cancel";

/** What an asker supplies. */
export interface QuestionSpec {
  stepId: string;
  agent: string;
  item?: ItemRef;
  kind: QuestionKind;
  question: string;
  options?: string[];
  multiSelect?: boolean;
  allowCustom?: boolean;
  /** Fork only: the parent may delegate to the fork's decider (`decide`, free text). */
  canDecide?: boolean;
  /** Seconds until the question closes with `default`. */
  timeoutS?: number;
  default?: string | string[];
}

/** A question as the parent and observers see it. */
export interface OpenQuestion extends QuestionSpec {
  question_id: string;
  runId: string;
}

/** How a question closed, as seen by its asker. */
export type QuestionResult =
  | { via: "reply"; answer: string | string[]; notes?: string; decide?: boolean }
  | { via: "timeout"; answer?: string | string[] }
  | { via: "cancel" };

export interface ReplyInput {
  question_id: string;
  answer?: string | string[];
  notes?: string;
  decide?: boolean;
}

export type ReplyOutcome =
  | { question_id: string; outcome: "answered" }
  | { question_id: string; outcome: "invalid"; reason: string; options?: string[] }
  | { question_id: string; outcome: "not_pending" };

export interface RunOutcome {
  runId: string;
  flowName: string;
  status: string;
  summary: string;
}

export interface WaitResult {
  questions: OpenQuestion[];
  outcome?: RunOutcome;
  /** Every still-open question (including ones returned earlier). */
  open: OpenQuestion[];
  timedOut?: boolean;
  aborted?: boolean;
  nothingToWait?: boolean;
  /** Another wait is already blocking. */
  busy?: boolean;
}

export interface MailboxHooks {
  onQuestion?: (q: OpenQuestion) => void;
  onAnswer?: (q: OpenQuestion, via: CloseVia) => void;
  /** Deliver one batched message to the parent. */
  push?: (text: string) => void;
}

interface Entry {
  q: OpenQuestion;
  resolve: (r: QuestionResult) => void;
  timer?: ReturnType<typeof setTimeout>;
  detach?: () => void;
  pushed: boolean;
  waitSeen: boolean;
}

export const PUSH_BATCH_MS = 1000;
export const WAIT_DEFAULT_S = 300;
export const WAIT_MAX_S = 600;

export class FlowMailbox {
  private entries = new Map<string, Entry>();
  private run: { runId: string; flowName: string } | null = null;
  private outcome: RunOutcome | null = null;
  private outcomePushed = false;
  private outcomeWaitSeen = false;
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private waiter: (() => void) | null = null;
  /** Ends the blocked wait (dispose). */
  private stopWaiter: (() => void) | null = null;

  constructor(private hooks: MailboxHooks = {}, private batchMs = PUSH_BATCH_MS) {}

  /** The active parent-attached run, or null. */
  get activeRun(): { runId: string; flowName: string } | null {
    return this.run;
  }

  startRun(runId: string, flowName: string): void {
    this.run = { runId, flowName };
    this.outcome = null;
    this.outcomePushed = false;
    this.outcomeWaitSeen = false;
  }

  /** Close the run's questions, then record and announce its outcome. */
  endRun(outcome: RunOutcome): void {
    this.closeRun(outcome.runId);
    if (this.run?.runId === outcome.runId) this.run = null;
    this.outcome = outcome;
    this.outcomePushed = false;
    this.outcomeWaitSeen = false;
    this.announce();
  }

  /** Close every open question of a run (`via: "cancel"`). */
  closeRun(runId: string): void {
    for (const e of [...this.entries.values()]) if (e.q.runId === runId) this.close(e, { via: "cancel" });
  }

  /** Open questions, oldest first. */
  open(): OpenQuestion[] {
    return [...this.entries.values()].map((e) => e.q);
  }

  /** Open a question and park until it closes. Never rejects. */
  ask(runId: string, spec: QuestionSpec, signal?: AbortSignal): Promise<QuestionResult> {
    if (signal?.aborted) return Promise.resolve({ via: "cancel" });
    const q: OpenQuestion = { ...spec, question_id: `q-${randomUUID().replace(/-/g, "").slice(0, 12)}`, runId };
    return new Promise<QuestionResult>((resolve) => {
      const entry: Entry = { q, resolve, pushed: false, waitSeen: false };
      this.entries.set(q.question_id, entry);
      if (spec.timeoutS && spec.timeoutS > 0) {
        entry.timer = setTimeout(() => this.close(entry, { via: "timeout", answer: spec.default }), spec.timeoutS * 1000);
        (entry.timer as { unref?: () => void }).unref?.();
      }
      if (signal) {
        const onAbort = () => this.close(entry, { via: "cancel" });
        signal.addEventListener("abort", onAbort, { once: true });
        entry.detach = () => signal.removeEventListener("abort", onAbort);
      }
      safe(() => this.hooks.onQuestion?.(q));
      safe(() => this.announce());
    });
  }

  /** Apply one reply. */
  reply(input: ReplyInput): ReplyOutcome {
    const id = input.question_id;
    const entry = this.entries.get(id);
    if (!entry) return { question_id: id, outcome: "not_pending" };
    const problem = validate(entry.q, input);
    if (problem) return { question_id: id, outcome: "invalid", reason: problem, ...(entry.q.options ? { options: entry.q.options } : {}) };
    this.close(entry, {
      via: "reply",
      answer: input.decide ? "" : (input.answer as string | string[]),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.decide ? { decide: true } : {}),
    });
    return { question_id: id, outcome: "answered" };
  }

  /**
   * Return unseen questions and an unreported run outcome at once, or block
   * until one appears, the timeout passes or the signal aborts.
   */
  wait(opts: { timeoutS?: number; signal?: AbortSignal } = {}): Promise<WaitResult> {
    const take = (): WaitResult | null => {
      const questions = [...this.entries.values()].filter((e) => !e.waitSeen);
      const outcome = this.outcome && !this.outcomeWaitSeen ? this.outcome : undefined;
      if (questions.length === 0 && !outcome) return null;
      for (const e of questions) e.waitSeen = true;
      if (outcome) this.outcomeWaitSeen = true;
      return { questions: questions.map((e) => e.q), ...(outcome ? { outcome } : {}), open: this.open() };
    };
    const now = take();
    if (now) return Promise.resolve(now);
    if (!this.run) return Promise.resolve({ questions: [], open: this.open(), nothingToWait: true });
    if (this.waiter) return Promise.resolve({ questions: [], open: this.open(), busy: true });

    const requested = Number(opts.timeoutS ?? WAIT_DEFAULT_S);
    const timeoutS = Math.min(Math.max(Number.isFinite(requested) ? requested : WAIT_DEFAULT_S, 0), WAIT_MAX_S);
    return new Promise<WaitResult>((resolve) => {
      // Only invoked after `timer` is assigned below (waiter/abort/timeout all fire later).
      const finish = (r: WaitResult) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        this.waiter = null;
        this.stopWaiter = null;
        resolve(r);
        // Anything that arrived while we waited and was not taken is pushed now.
        this.schedulePush();
      };
      const onAbort = () => finish({ questions: [], open: this.open(), aborted: true });
      this.stopWaiter = onAbort;
      this.waiter = () => {
        const r = take();
        if (r) finish(r);
      };
      const timer = setTimeout(() => finish({ questions: [], open: this.open(), timedOut: true }), timeoutS * 1000);
      if (opts.signal?.aborted) return onAbort();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Close everything and stop timers (session shutdown). */
  dispose(): void {
    for (const e of [...this.entries.values()]) this.close(e, { via: "cancel" });
    this.stopWaiter?.();
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = undefined;
  }

  // ── internals ──

  /** Resolve the asker first: a throwing hook must never leave it parked. */
  private close(entry: Entry, result: QuestionResult): void {
    if (!this.entries.delete(entry.q.question_id)) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.detach?.();
    entry.resolve(result);
    safe(() => this.hooks.onAnswer?.(entry.q, result.via));
  }

  private announce(): void {
    if (this.waiter) this.waiter();
    else this.schedulePush();
  }

  private schedulePush(): void {
    if (this.pushTimer || this.waiter || !this.hooks.push) return;
    this.pushTimer = setTimeout(() => this.flush(), this.batchMs);
    (this.pushTimer as { unref?: () => void }).unref?.();
  }

  private flush(): void {
    this.pushTimer = undefined;
    if (this.waiter) return;
    const items = [...this.entries.values()].filter((e) => !e.pushed && !e.waitSeen);
    const outcome = this.outcome && !this.outcomePushed && !this.outcomeWaitSeen ? this.outcome : undefined;
    if (items.length === 0 && !outcome) return;
    for (const e of items) e.pushed = true;
    if (outcome) this.outcomePushed = true;
    try {
      this.hooks.push?.(renderMail(items.map((e) => e.q), outcome));
    } catch {
      // Best-effort: a failed push must never break the run.
    }
  }
}

/** Hooks are observers: their failures must not break the mailbox. */
function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // best-effort
  }
}

// ---- validation ----------------------------------------------------------------

function validate(q: OpenQuestion, input: ReplyInput): string | null {
  if (input.decide) {
    return q.kind === "fork" && q.canDecide ? null : "delegation (decide) is not offered for this question";
  }
  const a = input.answer;
  if (a === undefined || (typeof a === "string" && a.trim() === "" && !q.options)) return "an answer is required";
  const opts = q.options;
  if (Array.isArray(a)) {
    if (!opts || !q.multiSelect) return "a list answer needs a multi-select question";
    if (a.length === 0) return "pick at least one option";
    const bad = a.filter((x) => !opts.includes(x));
    return bad.length ? `not an option: ${bad.join(", ")}` : null;
  }
  if (typeof a !== "string") return "the answer must be text or a list of options";
  if (!opts || opts.includes(a)) return null;
  if (q.kind === "fork") return q.allowCustom && q.canDecide ? null : `not an option: ${a}`;
  return q.allowCustom ? null : `not an option: ${a}`;
}

// ---- rendering -------------------------------------------------------------------

export function describeQuestion(q: OpenQuestion): string {
  const where = [`step ${q.stepId}`, q.agent, q.item ? `item ${q.item.index + 1}/${q.item.count}` : ""].filter(Boolean).join(", ");
  const lines = [`- [${q.question_id}] (${q.kind}; ${where}) ${q.question}`];
  if (q.options?.length) lines.push(`  options: ${q.options.join(" | ")}${q.multiSelect ? " (multi-select: answer with a list)" : ""}${q.allowCustom ? " (free text allowed)" : ""}`);
  if (q.canDecide) lines.push(`  or delegate to the fork's decider: {decide: true, notes?}`);
  if (q.timeoutS) lines.push(`  times out after ${q.timeoutS}s`);
  return lines.join("\n");
}

export function renderMail(questions: OpenQuestion[], outcome?: RunOutcome): string {
  const parts: string[] = [];
  if (questions.length) {
    parts.push(
      `Flow questions for you (answer with flow_control {action:"reply", question_id, answer} or {replies:[...]}; ask the user with ask_user if you cannot decide):`,
      ...questions.map(describeQuestion),
    );
  }
  if (outcome) parts.push(`Flow ${outcome.flowName} (run ${outcome.runId}) ended: ${outcome.status}${outcome.summary ? ` — ${outcome.summary}` : ""}`);
  return parts.join("\n\n");
}
