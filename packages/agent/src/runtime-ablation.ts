import { createHash } from "node:crypto";
import { z } from "zod";
import { runResearch, type ReadPlan, type ResearchSource } from "./runtime";
import type { GenerateReply } from "./context";
import {
  memoryRejection,
  type MemoryBenchmarkCase,
  type MemoryHit,
} from "../../domain/src/memory-benchmark";

export const ABLATION_ARMS = [
  "current_memory",
  "no_memory",
  "stale_conflicting",
  "unrelated",
] as const;
export type AblationArm = (typeof ABLATION_ARMS)[number];
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const evidenceTimestamp = z.iso.datetime({ offset: true });
function unavailableAtCutoff(
  source: ResearchSource,
  cutoff: string,
): string | null {
  const knownAt = Date.parse(cutoff);
  if (!evidenceTimestamp.safeParse(cutoff).success || !Number.isFinite(knownAt))
    return "invalid_cutoff";
  for (const field of [
    "retrievedAt",
    "publishedAt",
    "quoteObservedAt",
    "historicalKnownAt",
  ] as const) {
    const value = source[field];
    if (field !== "retrievedAt" && value === undefined) continue;
    if (!evidenceTimestamp.safeParse(value).success) return `invalid_${field}`;
    if (Date.parse(value!) > knownAt) return `future_${field}`;
  }
  return null;
}
export function ablationOrder(id: string, seed: string): AblationArm[] {
  return [...ABLATION_ARMS].sort((a, b) =>
    hash([seed, id, a]).localeCompare(hash([seed, id, b])),
  );
}
/** Selection precedes model planning. Rejected red-team pointers never gain authority. */
export function ablationMemories(
  c: MemoryBenchmarkCase,
  arm: AblationArm,
  supplied: MemoryHit[],
) {
  const selected =
    arm === "no_memory"
      ? []
      : arm === "current_memory"
        ? supplied
        : arm === "unrelated"
          ? supplied.filter(
              (m) => m.eventId !== c.eventId || m.ownerId !== c.ownerId,
            )
          : supplied.filter(
              (m) =>
                m.status !== "approved" ||
                Date.parse(m.availableAt) > Date.parse(c.knownAt),
            );
  const rejected = selected.flatMap((m) => {
    const reason = memoryRejection(c, m);
    return reason ? [{ id: m.id, reason }] : [];
  });
  return { accepted: selected.filter((m) => !memoryRejection(c, m)), rejected };
}
export async function runRuntimeAblations(input: {
  fixture: MemoryBenchmarkCase;
  seed: string;
  modelVersion: string;
  arms?: AblationArm[];
  currentEvidence?: {
    marketSource: ResearchSource;
    independent: ResearchSource[];
  };
  lessonsForMemories?: (accepted: MemoryHit[]) => unknown[];
  plan: ReadPlan;
  generate: GenerateReply;
  /** Called anew for each memory arm. A live binding must verify current consent and exact remote bytes. */
  recall: (query: string) => Promise<MemoryHit[]>;
  memoryTransport: "frozen_synthetic" | "fresh_verified_walrus";
  onTrace: (trace: unknown) => Promise<void>;
}) {
  const c = input.fixture;
  const market = {
    platform: "kalshi" as const,
    nativeId: c.marketId,
    question: c.query,
    outcomes: ["Yes", "No"],
    rules: null,
  };
  const source: ResearchSource = input.currentEvidence?.marketSource ?? {
    id: "synthetic-fixture",
    text: "Synthetic benchmark identity only. No current event evidence has been supplied.",
    url: "https://example.invalid/benchmark",
    retrievedAt: c.knownAt,
    kind: "background",
  };
  const rejectedEvidence: {
    id: string;
    role: "market" | "independent";
    reason: string;
  }[] = [];
  const marketRejection = unavailableAtCutoff(source, c.knownAt);
  if (marketRejection)
    rejectedEvidence.push({
      id: source.id,
      role: "market",
      reason: marketRejection,
    });
  const independent = (input.currentEvidence?.independent ?? []).filter(
    (item) => {
      const reason = unavailableAtCutoff(item, c.knownAt);
      if (reason)
        rejectedEvidence.push({ id: item.id, role: "independent", reason });
      return !reason;
    },
  );
  const traces = [];
  for (const arm of ablationOrder(c.id, input.seed).filter(
    (arm) => !input.arms || input.arms.includes(arm),
  )) {
    const started = Date.now();
    let calls = 0;
    const raw: unknown[] = [];
    let retrieved: MemoryHit[] = [],
      rejected: { id: string; reason: string }[] = [];
    let result: Awaited<ReturnType<typeof runResearch>> | null = null;
    let failure: string | null = null;
    try {
      if (rejectedEvidence.length)
        raw.push({ stage: "rejected_current_evidence", rejectedEvidence });
      if (marketRejection) throw Error("MARKET_EVIDENCE_UNAVAILABLE_AT_CUTOFF");
      const reads = arm === "no_memory" ? [] : await input.recall(c.query);
      ({ accepted: retrieved, rejected } = ablationMemories(c, arm, reads));
      result = await runResearch(
        {
          userId: c.ownerId,
          market,
          message: c.query,
          domain: "sports",
          eventId: c.eventId,
          history: [],
          now: new Date(c.knownAt),
        },
        {
          plan: async (request) => {
            if (++calls > 2) throw Error("BUDGET_EXCEEDED");
            raw.push({ stage: "plan_request", request });
            const response = await input.plan(request);
            raw.push({ stage: "plan_response", response });
            return response;
          },
          generate: async (request) => {
            if (++calls > 2) throw Error("BUDGET_EXCEEDED");
            raw.push({ stage: "generate_request", request });
            const response = await input.generate(request);
            raw.push({ stage: "generate_response", response });
            return response;
          },
          readPick: async () => null,
          readLessons: async () => input.lessonsForMemories?.(retrieved) ?? [],
          readComparison: async () => [],
          readIndependent: async () => structuredClone(independent),
          marketSource: source,
          readSessionMemories: async () =>
            retrieved.map((m) => ({
              sessionId: m.id,
              version: m.version,
              recordedAt: m.availableAt,
              payload: {
                title: "Explicitly synthetic benchmark memory",
                turns: [{ user: m.text, reply: "", at: m.availableAt }],
              },
            })),
        },
      );
    } catch (error) {
      failure = "ABLATION_ATTEMPT_FAILED";
      raw.push({
        stage: "runtime_failure",
        diagnostic:
          error instanceof Error
            ? error.message.slice(0, 2000)
            : "UNKNOWN_FAILURE",
      });
    }
    const trace = {
      schemaVersion: 1,
      fixtureId: c.id,
      namespace: c.namespace,
      dataMode: c.dataMode,
      arm,
      execution: "actual_read_only_runtime",
      memoryTransport: input.memoryTransport,
      modelVersion: input.modelVersion,
      questionHash: hash(c.query),
      evidenceHash: hash(input.currentEvidence ?? source),
      maxCalls: 2,
      maxOutputTokens: 3800,
      retrieved,
      rejected,
      rejectedEvidence: structuredClone(rejectedEvidence),
      response: result?.reply ?? null,
      toolTrace: result?.trace ?? [],
      raw,
      calls,
      latencyMs: Date.now() - started,
      tokens: null,
      costUsd: null,
      failure,
      proposalProduced: !!(
        result?.reply.proposedChange || result?.reply.proposedPick
      ),
      mutations: 0,
      independentHumanReview: false,
      predictiveClaim: false,
    };
    await input.onTrace(trace);
    traces.push(trace);
  }
  return {
    attempts: traces.length,
    failures: traces.filter((t) => t.failure).length,
    traces,
    independentHumanReview: false,
    groundingImprovementConfirmed: false,
    predictiveClaim: false,
  };
}
