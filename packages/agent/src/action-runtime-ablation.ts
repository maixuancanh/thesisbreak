import { createHash } from "node:crypto";
import {
  actionBenchmarkCaseSchema,
  scoreAction,
  type ActionBenchmarkCase,
  type ActionTool,
} from "../../domain/src/action-benchmark";
import { ablationOrder, type AblationArm } from "./runtime-ablation";
import { runResearch, type ReadPlan, type ResearchSource } from "./runtime";
import type { GenerateReply } from "./context";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Fixture responses are available only when the real runtime invokes their matching read. */
export async function runActionRuntimeAblations(input: {
  fixture: ActionBenchmarkCase;
  seed: string;
  modelVersion: string;
  plan: ReadPlan;
  generate: GenerateReply;
  onTrace: (trace: unknown) => Promise<void>;
  memoryTransport?: "frozen_synthetic" | "fresh_verified_walrus";
  recallExact?: (
    fixture: ActionBenchmarkCase,
  ) => Promise<{ text: string; proof: unknown }>;
}) {
  const c = actionBenchmarkCaseSchema.parse(input.fixture);
  const traces = [];
  for (const arm of ablationOrder(c.id, input.seed)) {
    const startedAt = Date.now();
    let calls = 0;
    const raw: unknown[] = [];
    const executed: ActionTool[] = [];
    const rejectedEvidence: {
      id: string;
      tool: string;
      reason: string;
      evidenceIds: string[];
    }[] = [];
    let failure: string | null = null;
    let result: Awaited<ReturnType<typeof runResearch>> | null = null;
    let acceptedMemory =
      arm === "current_memory" && c.memoryStatus === "approved";
    let recalledText = c.memory;
    // Controls are explicit rejected candidates, never secretly promoted to current memory.
    const candidate =
      arm === "no_memory"
        ? null
        : {
            ownerId: arm === "unrelated" ? "eval:foreign-owner" : c.ownerId,
            version:
              arm === "stale_conflicting"
                ? Math.max(0, c.memoryVersion - 1)
                : c.memoryVersion,
            text: c.memory,
          };
    const read = (tool: string): ResearchSource[] => {
      const rows = c.goldTools.filter((row) => row.tool === tool);
      const sources: ResearchSource[] = [];
      // Mirror actual runResearch consumer caps before recording scored observations.
      const sourceLimit = tool === "read_independent_sources" ? 14 : 1;
      for (const row of rows) {
        const reject = (reason: string, evidenceIds = row.evidenceIds) =>
          rejectedEvidence.push({
            id: row.id,
            tool,
            reason,
            evidenceIds: [...evidenceIds],
          });
        if (Date.parse(row.availableAt) > Date.parse(c.cutoffAt)) {
          reject("future_evidence");
          continue;
        }
        if (tool === "read_saved_pick") {
          // The fixture defines check metadata, not a native saved-pick payload. A null
          // return cannot substantiate resolved parameters, regardless of gold labels.
          executed.push({
            ...structuredClone(row),
            id: `${row.id}:execution-${executed.length}`,
            status: "unavailable",
            evidenceIds: [],
            verifiedChecks: [],
          });
          reject("native_saved_pick_unavailable");
          continue;
        }
        if (row.status !== "completed") {
          executed.push({
            ...structuredClone(row),
            id: `${row.id}:execution-${executed.length}`,
          });
          continue;
        }
        const selectedIds = row.evidenceIds.slice(
          0,
          Math.max(0, sourceLimit - sources.length),
        );
        const discardedIds = row.evidenceIds.slice(selectedIds.length);
        if (discardedIds.length) reject("runtime_source_limit", discardedIds);
        if (!selectedIds.length) continue;
        const observation = {
          ...structuredClone(row),
          evidenceIds: selectedIds,
        };
        executed.push({
          ...observation,
          id: `${row.id}:execution-${executed.length}`,
        });
        sources.push(
          ...selectedIds.map((id) => ({
            id,
            text: JSON.stringify({ synthetic: true, observation }),
            url: `https://example.invalid/${encodeURIComponent(id)}`,
            retrievedAt: row.availableAt,
            kind: "background" as const,
            canonicalOriginId: row.originIds[0] ?? null,
            provenanceRefs: selectedIds,
          })),
        );
      }
      raw.push({
        stage: "tool_response",
        tool,
        response: tool === "read_saved_pick" ? null : sources,
      });
      return sources;
    };
    try {
      if (
        input.memoryTransport === "fresh_verified_walrus" &&
        arm !== "no_memory"
      ) {
        if (!input.recallExact)
          throw Error("EXACT_AUTHORIZED_WALRUS_BINDING_REQUIRED");
        const recalled = await input.recallExact(c);
        recalledText = recalled.text;
        raw.push({ stage: "fresh_exact_recall", proof: recalled.proof });
      }
      result = await runResearch(
        {
          userId: c.ownerId,
          market: {
            platform: "kalshi",
            nativeId: c.marketId,
            question: c.query,
            outcomes: [c.outcomeId, "other"],
            rules: null,
          },
          message: c.query,
          domain: "sports",
          eventId: c.eventId,
          history: [],
          now: new Date(c.cutoffAt),
        },
        {
          plan: async (request) => {
            if (++calls > 2) throw Error("MODEL_CALL_BUDGET_EXCEEDED");
            raw.push({ stage: "plan_request", request });
            const response = await input.plan(request);
            raw.push({ stage: "plan_response", response });
            return response;
          },
          generate: async (request) => {
            if (++calls > 2) throw Error("MODEL_CALL_BUDGET_EXCEEDED");
            raw.push({ stage: "generate_request", request });
            const response = await input.generate({
              ...request,
              signal: AbortSignal.timeout(60_000),
            });
            raw.push({ stage: "generate_response", response });
            return response;
          },
          readPick: async () => {
            read("read_saved_pick");
            return null;
          },
          readLessons: async () => [],
          readSessionMemories: async () =>
            acceptedMemory
              ? [
                  {
                    sessionId: `${c.namespace}:${c.id}`,
                    version: c.memoryVersion,
                    recordedAt: c.cutoffAt,
                    payload: {
                      title: "Synthetic action benchmark memory",
                      turns: [
                        { user: recalledText, reply: "", at: c.cutoffAt },
                      ],
                    },
                  },
                ]
              : [],
          readComparison: async () => read("compare_snapshot"),
          readIndependent: async () => read("read_independent_sources"),
          readTatumQuote: async () => read("read_tatum_quote"),
          readTatumHistory: async () => read("read_tatum_history"),
          marketSource: {
            id: "synthetic-action-market",
            text: "Synthetic benchmark identity; no external observations.",
            url: "https://example.invalid/action-benchmark",
            retrievedAt: c.cutoffAt,
            kind: "background",
          },
        },
      );
    } catch (error) {
      acceptedMemory = false;
      failure = "ACTION_RUNTIME_ATTEMPT_FAILED";
      raw.push({
        stage: "runtime_failure",
        error: error instanceof Error ? error.name : "UnknownError",
        diagnosticCode:
          error instanceof Error &&
          /^[A-Z][A-Z_0-9]{1,100}$/.test(error.message)
            ? error.message
            : null,
        diagnosticHash: hash(
          error instanceof Error ? error.message : String(error),
        ),
      });
    }
    // A proposed draft is never a confirmed action. Do not infer a keep decision from prose.
    const proposal =
      result?.reply.proposedChange || result?.reply.proposedPick
        ? ("change_pick" as const)
        : ("review" as const);
    const score = scoreAction({
      fixture: c,
      toolEvidence: executed,
      proposal,
      userConfirmed: false,
      mutated: false,
      memoryOwnerId: c.ownerId,
      memoryVersion: c.memoryVersion,
    });
    const trace = {
      schemaVersion: 1,
      fixtureId: c.id,
      namespace: c.namespace,
      arm,
      dataMode: "synthetic",
      execution: "actual_read_only_runtime",
      memoryTransport: input.memoryTransport ?? "frozen_synthetic",
      modelVersion: input.modelVersion,
      questionHash: hash(c.query),
      evidenceHash: hash(c.goldTools),
      candidate,
      acceptedMemory,
      rejectedReason:
        !candidate || acceptedMemory
          ? null
          : arm === "unrelated"
            ? "wrong_owner"
            : arm === "stale_conflicting"
              ? "stale_version"
              : c.memoryStatus,
      raw,
      response: result?.reply ?? null,
      toolTrace: result?.trace ?? [],
      toolEvidence: executed,
      rejectedEvidence,
      score,
      failure,
      calls,
      maxCalls: 2,
      maxOutputTokens: 3800,
      latencyMs: Date.now() - startedAt,
      tokens: null,
      costUsd: null,
      mutations: 0,
      remoteWrites: 0,
      independentHumanReview: false,
      predictiveClaim: false,
    };
    await input.onTrace(trace);
    traces.push(trace);
  }
  return {
    fixtureId: c.id,
    attempts: traces.length,
    failures: traces.filter((t) => t.failure).length,
    passed: traces.filter((t) => !t.failure && t.score.passed).length,
    denominator: traces.length,
    traces,
    groundingImprovementConfirmed: false,
    predictiveClaim: false,
  };
}

export type ActionRuntimeArm = AblationArm;
