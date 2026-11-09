import {
  traceRead,
  preloadedToolTrace,
  type ToolExecutionTrace,
} from "./tool-provenance";
import { z } from "zod";
import { pickIntelligenceSchema, type PickIntelligence } from "../../domain/src/pick-intelligence";
import { routeCheckProcedures, executeCheckProcedures, explicitCheckObjectives, type CheckObjective } from "./check-procedures";
import { researchArtifactTools } from "./research-artifact-policy";
import { createHash } from "node:crypto";
import { runEvidenceDebate, type DebateInvoker } from "./evidence-debate";
import { parseTemporalRequest } from "./temporal-retrieval";
import { lessonVersionSchema } from "../../domain/src/lesson";
import { learningSnapshotHash } from "./learning-provenance";
import {
  dossierSchema,
  dossierState,
  type EventDossier,
  type DecisionDependency,
} from "./event-dossier";
import {
  rememberedConditions,
  evaluateLearningConditions,
} from "./remembered-conditions";
import {
  applyResearchMemoryPolicy,
  researchActionAudit,
} from "./memory-policy";
import type { researchScopeSchema } from "../../domain/src/research-policy";
import { groupCanonicalOrigins } from "../../domain/src/research-policy";
import { compareMemoryContext } from "./memory-comparison";
import {
  settlementComparison,
  type settlementSchema,
} from "../../domain/src/reason-review";
import {
  createAgentContext,
  answerWithContext,
  type ContextInput,
  type GenerateReply,
} from "./context";
export const historySchema = z
  .array(
    z
      .object({
        role: z.enum(["user", "assistant"]),
        text: z.string().max(12000),
      })
      .strict(),
  )
  .max(20);
export const readPlanSchema = z
  .object({
    tools: z
      .array(
        z.enum([
          "read_saved_pick",
          "read_approved_lessons",
          "compare_snapshot",
          "read_tatum_quote",
          "read_tatum_history",
          "read_independent_sources",
        ]),
      )
      .max(5),
  })
  .strict();
export type ReadPlan = (input: {
  message: string;
  market: ContextInput["market"];
  history: z.infer<typeof historySchema>;
  lessons?: unknown[];
  sessionMemories?: unknown[];
  researchArtifacts?: unknown[];
  sourceMemories?: unknown[];
  memoryPolicy?: unknown;
  actionMemories?: unknown[];
  requiredConditions?: ReturnType<typeof rememberedConditions>["applied"];
  decisionChecks?: PickIntelligence;
}) => Promise<unknown>;
export function recentHistory(input: z.infer<typeof historySchema>) {
  const history = historySchema.parse(input).slice(-16);
  while (JSON.stringify(history).length > 30000) history.splice(0, 2);
  return history;
}
export type ResearchSource = {
  id: string;
  text: string;
  retrievedAt: string;
  url: string;
  publishedAt?: string | null;
  quoteObservedAt?: string | null;
  historicalOrigin?: "user_statement";
  historicalKnownAt?: string;
  kind?: "market" | "snapshot" | "official_event" | "background" | "settlement";
  confirmsLineup?: boolean;
  canonicalOriginId?: string | null;
  provenanceRefs?: string[];
  rulesHash?: string | null;
};
async function runCurrentResearch(
  input: {
    userId: string;
    market: ContextInput["market"];
    message: string;
    history: z.infer<typeof historySchema>;
    domain: string;
    competition?: string;
    now: Date;
    compareMemory?: boolean;
    researchPrerequisites?: ContextInput["researchPrerequisites"];
    requestedScope?: z.infer<typeof researchScopeSchema>;
    currentRegime?: string;
    eventId?: string;
    temporalCutoff?: Date;
  },
  deps: {
    plan: ReadPlan;
    /** Server-owned, read-only router gate. Absent preserves the existing runtime. */
    checkProcedures?: {
      maxCalls: number;
      objectives?: CheckObjective[];
      isCurrent?: () => boolean | Promise<boolean>;
    };
    /** Server opt-in only. Shared run budget must reserve mandatory baseline calls first. */
    evidenceDebate?: {
      trigger:
        | "explicit_challenge"
        | "verified_source_disagreement"
        | "approved_countercheck_policy";
      reserveCalls: (count: 3) => boolean;
      invoke: DebateInvoker;
      maxOutputTokens: number;
    };
    generate: GenerateReply;
    readPick: () => Promise<ContextInput["pick"]>;
    readLessons: () => Promise<unknown[]>;
    readSourceMemories?: () => Promise<unknown[]>;
    readForecastMemories?: () => Promise<unknown[]>;
    readActionMemories?: () => Promise<unknown[]>;
    readSessionMemories?: () => Promise<unknown[]>;
    readResearchArtifacts?: () => Promise<unknown[]>;
    readDossier?: () => Promise<EventDossier | null>;
    readLessonProofs?: () => { id: string; version: number; hash: string }[];
    readHistoricalEvidence?: (cutoff: Date) => Promise<ResearchSource[]>;
    readComparison: () => Promise<ResearchSource[]>;
    marketSource: ResearchSource;
    decisionChecks?: PickIntelligence;
    readIndependent?: () => Promise<ResearchSource[]>;
    readTatumQuote?: () => Promise<ResearchSource[]>;
    readTatumHistory?: () => Promise<ResearchSource[]>;
    readSettlement?: (
      pick: ContextInput["pick"],
    ) => Promise<z.infer<typeof settlementSchema> | null>;
  },
) {
  const history = historySchema.parse(input.history);
  // Current checks must not leak future portfolio state into historical evaluation.
  const decisionChecks = !input.temporalCutoff && deps.decisionChecks
    ? pickIntelligenceSchema.parse(deps.decisionChecks)
    : undefined;
  if (JSON.stringify(history).length > 30000)
    throw new Error("HISTORY_TOO_LARGE");
  const trace: ToolExecutionTrace[] = [
    preloadedToolTrace("read_market", [deps.marketSource]),
  ];
  const recordTrace = (entry: {
    tool: string;
    status: "completed" | "unavailable";
    count: number;
    reason?: string;
  }) => {
    // Actual wrappers already recorded success/failure. Fallback entries represent absent capabilities only.
    if (trace.some((t) => t.tool === entry.tool)) return;
    trace.push({
      ...entry,
      startedAt: null,
      completedAt: null,
      observedAt: null,
      observationKind: null,
      resultHash: null,
    });
  };
  deps = {
    ...deps,
    readPick: traceRead("read_saved_pick", deps.readPick, trace),
    readLessons: traceRead("read_approved_lessons", deps.readLessons, trace),
    readComparison: traceRead("compare_snapshot", deps.readComparison, trace),
    ...(deps.readIndependent
      ? {
          readIndependent: traceRead(
            "read_independent_sources",
            deps.readIndependent,
            trace,
            true,
          ),
        }
      : {}),
    ...(deps.readTatumQuote
      ? {
          readTatumQuote: traceRead(
            "read_tatum_quote",
            deps.readTatumQuote,
            trace,
            true,
          ),
        }
      : {}),
    ...(deps.readTatumHistory
      ? {
          readTatumHistory: traceRead(
            "read_tatum_history",
            deps.readTatumHistory,
            trace,
            true,
          ),
        }
      : {}),
    ...(deps.readSettlement
      ? {
          readSettlement: traceRead(
            "read_settlement",
            deps.readSettlement,
            trace,
            true,
          ),
        }
      : {}),
    ...(deps.readSourceMemories
      ? {
          readSourceMemories: traceRead(
            "recall_source_history",
            deps.readSourceMemories,
            trace,
          ),
        }
      : {}),
    ...(deps.readSessionMemories
      ? {
          readSessionMemories: traceRead(
            "recall_conversations",
            deps.readSessionMemories,
            trace,
          ),
        }
      : {}),
    ...(deps.readForecastMemories
      ? {
          readForecastMemories: traceRead(
            "recall_forecasts",
            deps.readForecastMemories,
            trace,
          ),
        }
      : {}),
    ...(deps.readActionMemories
      ? {
          readActionMemories: traceRead(
            "recall_actions",
            deps.readActionMemories,
            trace,
          ),
        }
      : {}),
    ...(deps.readDossier
      ? {
          readDossier: traceRead("read_event_dossier", deps.readDossier, trace),
        }
      : {}),
  };
  // Current account state is authoritative, never optional model context.
  const pick = await deps.readPick();
  recordTrace({
    tool: "read_saved_pick",
    status: "completed",
    count: pick ? 1 : 0,
  });
  let lessons = await deps.readLessons();
  recordTrace({
    tool: "read_approved_lessons",
    status: "completed",
    count: lessons.length,
  });
  const sources = [deps.marketSource];
  let sourceMemories: unknown[] = [];
  if (deps.readSourceMemories) {
    try {
      sourceMemories = (await deps.readSourceMemories()).slice(0, 4);
      recordTrace({
        tool: "recall_source_history",
        status: "completed",
        count: sourceMemories.length,
      });
    } catch {
      recordTrace({
        tool: "recall_source_history",
        status: "unavailable",
        count: 0,
      });
    }
  }
  let sessionMemories: unknown[] = [];
  if (deps.readSessionMemories) {
    try {
      sessionMemories = (await deps.readSessionMemories()).slice(0, 4);
      recordTrace({
        tool: "recall_conversations",
        status: "completed",
        count: sessionMemories.length,
      });
    } catch {
      recordTrace({
        tool: "recall_conversations",
        status: "unavailable",
        count: 0,
      });
    }
  }
  let forecastMemories: unknown[] = [];
  if (deps.readForecastMemories) {
    try {
      forecastMemories = (await deps.readForecastMemories()).slice(0, 4);
    } catch {
      /* Fail closed: no remote readback means no forecast history. */
    }
  }
  const memoryPolicy = applyResearchMemoryPolicy({
    userId: input.userId,
    now: input.now,
    forecastMemories,
    sourceMemories,
    ...(input.requestedScope ? { requestedScope: input.requestedScope } : {}),
    ...(input.currentRegime ? { currentRegime: input.currentRegime } : {}),
  });
  let actionMemories: unknown[] = [];
  if (deps.readActionMemories)
    try {
      actionMemories = (await deps.readActionMemories())
        .filter(
          (m) =>
            m &&
            typeof m === "object" &&
            "userId" in m &&
            m.userId === input.userId,
        )
        .slice(0, 2);
    } catch {
      /* Remote failure never falls back to local action history. */
    }
  forecastMemories = memoryPolicy.forecastMemories;
  sourceMemories = memoryPolicy.sourceMemories;
  const conditions = rememberedConditions({
    userId: input.userId,
    domain: input.domain,
    ...(input.eventId ? { eventId: input.eventId } : {}),
    ...(input.requestedScope
      ? {
          marketType: input.requestedScope.market,
          horizon: input.requestedScope.horizon,
        }
      : {}),
    ...(input.competition ? { competition: input.competition } : {}),
    now: input.now,
    lessons,
  });
  const procedurePlan = deps.checkProcedures && !input.temporalCutoff ? routeCheckProcedures({
    objectives: deps.checkProcedures.objectives ?? explicitCheckObjectives(input.message),
    conditions: conditions.applied, now: input.now,
  }) : null;
  let procedureChecks: Awaited<ReturnType<typeof executeCheckProcedures>> | undefined;
  let artifactPolicy: ReturnType<typeof researchArtifactTools> = {
    artifacts: [],
    requiredTools: [],
  };
  if (deps.readResearchArtifacts && !input.temporalCutoff) {
    try {
      artifactPolicy = researchArtifactTools(
        await deps.readResearchArtifacts(),
      );
      recordTrace({
        tool: "recall_research_artifacts",
        status: "completed",
        count: artifactPolicy.artifacts.length,
      });
    } catch {
      recordTrace({
        tool: "recall_research_artifacts",
        status: "unavailable",
        count: 0,
      });
    }
  }
  const plan = readPlanSchema.parse(
    await deps.plan({
      message: input.message,
      market: input.market,
      history,
      lessons,
      sourceMemories: [...sourceMemories, ...forecastMemories],
      sessionMemories,
      researchArtifacts: artifactPolicy.artifacts,
      memoryPolicy: {
        memoryDecisions: memoryPolicy.memoryDecisions,
        sourceAssessments: memoryPolicy.sourceAssessments,
      },
      actionMemories,
      requiredConditions: conditions.applied,
      ...(decisionChecks ? { decisionChecks } : {}),
    }),
  );
  const requiredTools = [
    ...new Set([
      ...conditions.requiredTools,
      ...artifactPolicy.requiredTools,
      ...(procedurePlan?.tools ?? []),
      ...(decisionChecks && decisionChecks.rules.state !== "available" ? ["compare_snapshot"] : []),
      ...(decisionChecks && (decisionChecks.connections.some((group) => group.kind === "same_condition") || sourceMemories.length > 0)
        ? ["read_independent_sources"] : []),
    ]),
  ];
  const executionTools = [...new Set([...requiredTools, ...plan.tools])];
  let settlement: z.infer<typeof settlementSchema> | null = null;
  if (pick && deps.readSettlement) {
    try {
      settlement = await deps.readSettlement(pick);
      if (settlement)
        sources.push({
          id: settlement.sourceRef,
          url: deps.marketSource.url,
          text: JSON.stringify({
            note: "Verified native final settlement, not an assessment of reasoning quality",
            ...settlement,
          }),
          retrievedAt: input.now.toISOString(),
          kind: "settlement",
        });
      recordTrace({
        tool: "read_settlement",
        status: "completed",
        count: settlement ? 1 : 0,
      });
    } catch {
      recordTrace({ tool: "read_settlement", status: "unavailable", count: 0 });
    }
  }
  let procedureIndependent: ResearchSource[] | null | undefined;
  const independentRequested = !deps.checkProcedures || executionTools.includes("read_independent_sources");
  const independentBudget = !deps.checkProcedures || (Number.isInteger(deps.checkProcedures.maxCalls) && deps.checkProcedures.maxCalls > 0);
  if (deps.readIndependent && independentRequested && independentBudget) {
    try {
      const found = await deps.readIndependent();
      procedureIndependent = found.slice(0, 14);
      sources.push(...found.slice(0, 14));
      recordTrace({
        tool: "read_independent_sources",
        status: "completed",
        count: Math.min(found.length, 14),
      });
    } catch {
      procedureIndependent = null;
      recordTrace({
        tool: "read_independent_sources",
        status: "unavailable",
        count: 0,
      });
    }
  } else if (requiredTools.includes("read_independent_sources")) {
    recordTrace({
      tool: "read_independent_sources",
      status: "unavailable",
      count: 0,
      reason: "required_capability_not_configured",
    });
  }
  for (const tool of executionTools) {
    if (tool === "compare_snapshot") {
      try {
        const found = await deps.readComparison();
        sources.push(...found.slice(0, 1));
        recordTrace({
          tool,
          status: "completed",
          count: Math.min(found.length, 1),
        });
      } catch {
        recordTrace({
          tool,
          status: "unavailable",
          count: 0,
          reason: "provider_read_failed",
        });
      }
    }
  }
  for (const [tool, read] of [
    ["read_tatum_quote", deps.readTatumQuote],
    ["read_tatum_history", deps.readTatumHistory],
  ] as const) {
    if (!executionTools.includes(tool)) continue;
    if (!read) {
      recordTrace({
        tool,
        status: "unavailable",
        count: 0,
        reason: "not_configured",
      });
      continue;
    }
    try {
      const found = (await read()).slice(0, tool === "read_tatum_history" ? 2 : 1);
      sources.push(...found);
      recordTrace({ tool, status: "completed", count: found.length });
    } catch {
      recordTrace({
        tool,
        status: "unavailable",
        count: 0,
        reason: "provider_read_failed",
      });
    }
  }
  // The same bounded evidence drives both context and exported citations.
  const boundedSources = sources
    .slice(0, 20)
    .map((s) => ({ ...s, text: s.text.slice(0, 9500) }));
  // Server-only originals for the extraction worker. Memory/snapshot replay is never new evidence.
  const learningEvidence = boundedSources
    .filter((s) => s.kind !== "snapshot" && s.id !== "saved-snapshot")
    .map((s) => ({
      id: s.id,
      text: s.text,
      origin:
        s.kind === "settlement"
          ? ("verified_outcome" as const)
          : ("tool_result" as const),
      eventId: input.eventId ?? null,
      publishedAt: s.publishedAt ?? null,
      occurredAt: s.quoteObservedAt ?? null,
      retrievedAt: s.retrievedAt,
      sourceOrigin: s.canonicalOriginId ?? `unknown:${s.url}`,
    }));
  // Fence after remote reads: removed/paused/changed conditions cannot authorize proposals.
  const currentLessons = await deps.readLessons();
  const changedLessonState =
    JSON.stringify(lessons) !== JSON.stringify(currentLessons);
  lessons = currentLessons;
  if (procedurePlan?.checks.length && deps.checkProcedures) {
    procedureChecks = await executeCheckProcedures({
      plan: procedurePlan, now: input.now, maxCalls: deps.checkProcedures.maxCalls,
      supportedTools: ["read_market", ...(deps.readIndependent ? ["read_independent_sources"] : [])],
      isCurrent: async () => {
        if (changedLessonState) return false;
        try { return !deps.checkProcedures?.isCurrent || await deps.checkProcedures.isCurrent(); } catch { return false; }
      },
      read: async (tool) => {
        if (tool === "read_market") return [deps.marketSource];
        if (tool === "read_independent_sources" && procedureIndependent !== undefined) {
          if (procedureIndependent === null) throw Error("SOURCE_UNAVAILABLE");
          return procedureIndependent;
        }
        throw Error("READ_NOT_EXECUTED");
      },
    });
  }
  const learningGate = evaluateLearningConditions(conditions, {
    now: input.now,
    sources: boundedSources,
  });
  let eventDossier: {
    state: ReturnType<typeof dossierState>;
    dossier: EventDossier | null;
  } | null = null;
  if (deps.readDossier && input.eventId) {
    try {
      const raw = await deps.readDossier();
      if (raw) {
        const d = dossierSchema.parse(raw);
        if (d.ownerId !== input.userId || d.eventId !== input.eventId)
          throw Error("DOSSIER_SCOPE_MISMATCH");
        const hash = learningSnapshotHash;
        const dependencies: DecisionDependency[] = [
          ...lessons.flatMap((l) => {
            const p = z
              .object({ id: z.string(), version: z.number() })
              .safeParse(l);
            return p.success
              ? [
                  {
                    id: `lesson:${p.data.id}`,
                    version: p.data.version,
                    hash: hash(l),
                    status: "current" as const,
                  },
                ]
              : [];
          }),
          ...(pick
            ? [
                {
                  id: `pick:${pick.pickId}`,
                  version: pick.version,
                  hash: hash({
                    id: pick.pickId,
                    version: pick.version,
                    outcome: pick.outcome,
                    reason: pick.reason,
                  }),
                  status: "current" as const,
                },
              ]
            : []),
          ...learningEvidence.map((e) => ({
            id: `evidence:${e.id}`,
            version: 1,
            hash: hash(e),
            status: "current" as const,
          })),
          ...sourceMemories.flatMap((m) => {
            const p = z
              .object({ id: z.string(), version: z.number() })
              .safeParse(m);
            return p.success
              ? [
                  {
                    id: `source:${p.data.id}`,
                    version: p.data.version,
                    hash: hash(m),
                    status: "current" as const,
                  },
                ]
              : [];
          }),
        ];
        const state = dossierState(d, dependencies);
        // Stale summaries are not injected as facts; the current original reads above remain authoritative.
        eventDossier = {
          state,
          dossier:
            (state === "fresh" || state === "partial") &&
            JSON.stringify(d).length <= 12000
              ? d
              : null,
        };
        recordTrace({
          tool: "read_event_dossier",
          status: "completed",
          count: eventDossier.dossier ? 1 : 0,
          reason: state,
        });
      }
    } catch {
      eventDossier = { state: "failed_refresh", dossier: null };
      recordTrace({
        tool: "read_event_dossier",
        status: "unavailable",
        count: 0,
      });
    }
  }
  if (changedLessonState) {
    learningGate.ready = false;
    learningGate.reasons.push("lesson_state_changed_during_research");
  }
  if (procedureChecks && !procedureChecks.ready) {
    learningGate.ready = false;
    learningGate.reasons.push("procedure_checks_incomplete");
  }
  const origins = groupCanonicalOrigins(
    boundedSources
      .filter((s) => z.url().safeParse(s.url).success)
      .map((s) => ({
        id: s.id,
        url: s.url,
        canonicalOriginId: s.canonicalOriginId ?? null,
        provenanceRefs: s.provenanceRefs ?? [],
      })),
  );
  const context = createAgentContext({
    userId: input.userId,
    market: input.market,
    pick,
    lessons,
    settlement,
    ...(decisionChecks ? { decisionChecks } : {}),
    sourceMemories,
    forecastMemories,
    actionMemories,
    eventDossier,
    temporalContext: input.temporalCutoff
      ? { mode: "historical", cutoff: input.temporalCutoff.toISOString() }
      : null,
    memoryAssessment: {
      memoryDecisions: memoryPolicy.memoryDecisions,
      sourceAssessments: memoryPolicy.sourceAssessments,
    },
    evidence: boundedSources.map((s) => ({
      id: s.id,
      userId: input.userId,
      market: {
        platform: input.market.platform,
        nativeId: input.market.nativeId,
      },
      text: JSON.stringify({
        originPolicy: {
          group: origins.groups.find((g) => g.sourceIds.includes(s.id)) ?? null,
          provenanceRefs: s.provenanceRefs ?? [],
          independence: origins.independence,
          unknownOrigin: origins.unknownSourceIds.includes(s.id),
        },
        sourceText: s.text,
      }).slice(0, 10000),
      publishedAt: s.publishedAt ?? null,
      retrievedAt: s.retrievedAt,
      kind:
        s.kind ??
        (s.id === "market-source"
          ? "market"
          : s.id === "saved-snapshot"
            ? "snapshot"
            : "background"),
    })),
    domain: input.domain,
    ...(input.competition ? { competition: input.competition } : {}),
    now: input.now,
    researchPrerequisites: {
      requiresLineup:
        conditions.requiresLineup ||
        input.researchPrerequisites?.requiresLineup === true ||
        /\b(lineups?|starters?|starting five)\b/i.test(
          `${input.message} ${pick?.reason ?? ""} ${JSON.stringify(sessionMemories)}`,
        ),
      confirmedLineupEvidenceRefs:
        input.researchPrerequisites?.confirmedLineupEvidenceRefs ??
        boundedSources
          .filter(
            (s) => s.confirmsLineup === true && s.kind === "official_event",
          )
          .map((s) => s.id),
      conflictingEvidence:
        (input.researchPrerequisites?.conflictingEvidence ?? false) ||
        !learningGate.ready,
    },
  });
  // Keep room for JSON escaping and the message under the generator's 60k limit.
  // Never refresh evidence between the paired responses.
  const promptSize = () =>
    JSON.stringify({
      context,
      history,
      sessionMemories,
      userMessage: input.message,
    }).length;
  while (promptSize() > 55000 && history.length) {
    history.splice(0, 2);
    if (
      !context.researchPolicy.contextOmissions.some((o) => o.kind === "history")
    )
      context.researchPolicy.contextOmissions.push({
        kind: "history",
        id: "older_turns",
      });
  }
  while (
    promptSize() > 55000 &&
    context.evidence.some((e) => e.text.length > 600)
  ) {
    for (const evidence of context.evidence) {
      if (evidence.text.length > 600) {
        if (
          !context.researchPolicy.contextOmissions.some(
            (o) => o.kind === "evidence_excerpt" && o.id === evidence.id,
          )
        )
          context.researchPolicy.contextOmissions.push({
            kind: "evidence_excerpt",
            id: evidence.id,
          });
        evidence.text =
          evidence.text.slice(
            0,
            Math.max(500, Math.floor(evidence.text.length * 0.7)),
          ) + " [Excerpt truncated for context size]";
      }
    }
  }
  while (promptSize() > 55000 && context.actionMemories.length) {
    context.researchPolicy.contextOmissions.push({
      kind: "action_memory",
      id: "budget_omitted",
    });
    context.actionMemories.pop();
  }
  while (promptSize() > 55000 && context.forecastMemories.length) {
    context.researchPolicy.contextOmissions.push({
      kind: "forecast_memory",
      id: "budget_omitted",
    });
    context.forecastMemories.pop();
  }
  while (promptSize() > 55000 && context.lessons.length) {
    context.researchPolicy.contextOmissions.push({
      kind: "lesson",
      id: context.lessons.at(-1)!.id,
    });
    context.lessons.pop();
  }
  while (promptSize() > 55000 && sessionMemories.length) {
    context.researchPolicy.contextOmissions.push({
      kind: "session_memory",
      id: "budget_omitted",
    });
    sessionMemories.pop();
  }
  if (procedureChecks) {
    const generate = deps.generate;
    const receipts = JSON.stringify(procedureChecks.receipts);
    deps = { ...deps, generate: (request) => generate({ ...request,
      system: `${request.system}\nRead-only check receipts (server metadata): ${receipts}\nOnly say a procedure was checked successfully when its receipt status is passed and evidenceIds is nonempty. Failed, not_run, unavailable and unsupported receipts mean the condition remains unverified. A read does not authorize a pick change.`,
    }) };
  }
  const memoryComparison = input.compareMemory
    ? await compareMemoryContext({
        context,
        sessionMemories,
        message: input.message,
        history: [],
        generate: deps.generate,
      })
    : undefined;
  let reply =
    memoryComparison?.status === "compared"
      ? {
          ...memoryComparison.withMemory,
          proposedChange: null,
          proposedPick: null,
        }
      : await answerWithContext(
          context,
          input.message,
          deps.generate,
          undefined,
          history,
          sessionMemories,
        );
  let evidenceDebate: Awaited<ReturnType<typeof runEvidenceDebate>> | undefined;
  if (deps.evidenceDebate && !input.temporalCutoff) {
    const reservation = deps.evidenceDebate.reserveCalls(3);
    const snapshots = boundedSources
      .filter(
        (s) =>
          s.canonicalOriginId &&
          s.text.length > 0 &&
          s.text.length <= 16000 &&
          Number.isFinite(Date.parse(s.retrievedAt)) &&
          Date.parse(s.retrievedAt) <= input.now.getTime(),
      )
      .slice(0, 100)
      .map((s) => ({
        id: s.id,
        originId: s.canonicalOriginId!,
        eventId:
          input.eventId ?? `${input.market.platform}:${input.market.nativeId}`,
        availableAt: s.retrievedAt,
        sha256: createHash("sha256").update(s.text).digest("hex"),
        text: s.text,
      }));
    evidenceDebate = await runEvidenceDebate(
      {
        trigger: deps.evidenceDebate.trigger,
        eventId:
          input.eventId ?? `${input.market.platform}:${input.market.nativeId}`,
        cutoffAt: input.now.toISOString(),
        evidence: snapshots,
        requiredChecks: requiredTools,
        completedChecks: [...new Set([...plan.tools, ...requiredTools])].filter(
          (tool) =>
            trace.some(
              (t) => t.tool === tool && t.status === "completed" && t.count > 0,
            ),
        ),
        remainingCalls: reservation ? 3 : 0,
        maxOutputTokens: deps.evidenceDebate.maxOutputTokens,
      },
      deps.evidenceDebate.invoke,
    );
  }
  const debateWithholds =
    evidenceDebate?.result != null &&
    evidenceDebate.result.disposition !== "keep";
  const artifactChecksIncomplete = artifactPolicy.requiredTools.some(
    (tool) =>
      !trace.some(
        (t) => t.tool === tool && t.status === "completed" && t.count > 0,
      ),
  );
  if (deps.checkProcedures) {
    let authorityCurrent = false;
    try {
      const finalLessons = await deps.readLessons();
      authorityCurrent = JSON.stringify(lessons) === JSON.stringify(finalLessons) &&
        (!deps.checkProcedures.isCurrent || await deps.checkProcedures.isCurrent());
    } catch { /* No current authority proof means no proposal. */ }
    if (!authorityCurrent) {
      learningGate.ready = false;
      learningGate.reasons.push("lesson_state_changed_during_research");
      if (procedureChecks) procedureChecks = { ...procedureChecks, ready: false,
        receipts: procedureChecks.receipts.map((r) => ({ ...r, status: "unavailable", evidenceIds: [] })) };
    }
  }
  const action =
    debateWithholds || artifactChecksIncomplete
      ? "waited"
      : !learningGate.ready ||
          context.researchPolicy.readiness.action === "wait"
        ? "waited"
        : context.researchPolicy.readiness.action === "abstain"
          ? "abstained"
          : "unchanged";
  const proposalWithheld =
    action !== "unchanged" && (!!reply.proposedChange || !!reply.proposedPick);
  if (proposalWithheld)
    reply = { ...reply, proposedChange: null, proposedPick: null };
  if (!learningGate.ready) {
    const descriptions: Record<string, string> = {
      official_lineup_required: "current official lineup evidence",
      fresh_quote_required:
        "a quote with a verified fresh observation timestamp",
      saved_snapshot_required: "the saved market snapshot",
      independent_origins_required:
        "enough independently identified original sources",
      procedure_checks_incomplete: "the required evidence checks to complete",
      lesson_state_changed_during_research:
        "a new review because your remembered rules changed during this research",
    };
    reply = {
      ...reply,
      message:
        `${reply.message}\n\nI am waiting for ${learningGate.reasons.map((r) => descriptions[r] ?? r).join("; ")} before proposing a pick.`.slice(
          0,
          12000,
        ),
    };
  }
  const researchAudit = researchActionAudit(
    { action, evidenceRefs: reply.evidenceRefs, proposalWithheld },
    memoryPolicy,
  );
  const comparisonRefs =
    memoryComparison?.status === "compared"
      ? [memoryComparison.withMemory, memoryComparison.withoutMemory].flatMap(
          (r) => [
            ...r.evidenceRefs,
            ...(r.reasonReview?.claims.flatMap((c) => c.evidenceRefs) ?? []),
            ...(r.retrospective?.evidenceRefs ?? []),
          ],
        )
      : [];
  return {
    ...(procedureChecks ? { procedureChecks } : {}),
    ...(evidenceDebate ? { evidenceDebate } : {}),
    reply,
    researchAudit,
    sessionMemories,
    plannedTools: plan.tools,
    researchArtifacts: artifactPolicy.artifacts,
    policyRequiredTools: requiredTools,
    learningGate,
    learningEvidence,
    learningEventId:
      input.eventId ?? `${input.market.platform}:${input.market.nativeId}`,
    verifiedLearningLessons: lessons,
    learningSourceMemories: sourceMemories,
    verifiedLearningMemories: (deps.readLessonProofs?.() ?? []).filter((p) =>
      lessons.some((l) => {
        const q = lessonVersionSchema.safeParse(l);
        return q.success && q.data.id === p.id && q.data.version === p.version;
      }),
    ),
    eventDossierState: eventDossier?.state ?? "empty",
    contextOmissions: context.researchPolicy.contextOmissions,
    retrieval: { mode: "lexical", embeddingStatus: "not_configured" },
    appliedConditions: conditions.applied,
    recalledSources: context.sourceMemories,
    ...(memoryComparison ? { memoryComparison } : {}),
    outcomeReview:
      settlement && pick
        ? {
            ...settlement,
            baseVersion: pick.version,
            pickedOutcome: pick.outcome,
            comparison: settlementComparison(pick.outcome, settlement),
          }
        : null,
    trace,
    sources: boundedSources
      .filter(
        (s) =>
          s.url &&
          (comparisonRefs.includes(s.id) ||
            reply.evidenceRefs.includes(s.id) ||
            reply.reasonReview?.claims.some((c) =>
              c.evidenceRefs.includes(s.id),
            ) ||
            reply.retrospective?.evidenceRefs.includes(s.id) ||
            s.id === settlement?.sourceRef),
      )
      .map(({ id, url, retrievedAt }) => ({ id, url, retrievedAt })),
    usedLessons: context.lessons
      .filter((l) => reply.lessonRefs.includes(l.id))
      .map((l) => ({
        id: l.id,
        version: l.version,
        rule: l.rule,
        scope: l.scope,
      })),
    pick: pick
      ? {
          id: pick.pickId,
          version: pick.version,
          outcome: pick.outcome,
          reason: pick.reason,
        }
      : null,
  };
}

export async function runResearch(
  input: Parameters<typeof runCurrentResearch>[0],
  deps: Parameters<typeof runCurrentResearch>[1],
) {
  const temporal = parseTemporalRequest(input.message);
  if (!input.temporalCutoff && temporal.status === "clarification_required")
    throw Error("HISTORICAL_CUTOFF_CLARIFICATION_REQUIRED");
  if (!input.temporalCutoff && temporal.cutoff) {
    if (temporal.cutoff > input.now) throw Error("HISTORICAL_CUTOFF_IN_FUTURE");
    const cutoff = temporal.cutoff;
    const historicalReads: ToolExecutionTrace[] = [];
    const originals = (
      deps.readHistoricalEvidence
        ? await traceRead(
            "read_historical_originals",
            deps.readHistoricalEvidence,
            historicalReads,
          )(cutoff)
        : []
    ).filter(
      (s) =>
        ((s.publishedAt != null &&
          Number.isFinite(Date.parse(s.publishedAt)) &&
          Date.parse(s.publishedAt) <= cutoff.getTime()) ||
          (s.historicalOrigin === "user_statement" &&
            s.historicalKnownAt !== undefined &&
            Number.isFinite(Date.parse(s.historicalKnownAt)) &&
            Date.parse(s.historicalKnownAt) <= cutoff.getTime())) &&
        Number.isFinite(Date.parse(s.retrievedAt)) &&
        Date.parse(s.retrievedAt) <= cutoff.getTime(),
    );
    const historical = await runCurrentResearch(
      {
        ...input,
        temporalCutoff: cutoff,
        now: cutoff,
        history: [],
        compareMemory: false,
        market: {
          ...input.market,
          question: `Historical reconstruction for native market ${input.market.nativeId}`,
          rules: null,
          outcomes: ["Historical reference only", "Unavailable"],
        },
      },
      {
        plan: deps.plan,
        generate: deps.generate,
        readPick: async () => null,
        readLessons: async () => [],
        readComparison: async () => [],
        readIndependent: async () => originals,
        marketSource: {
          id: "historical-coverage",
          url: "",
          kind: "background",
          text: `Historical cutoff ${cutoff.toISOString()}. Only owner-authorized originals recorded and published by cutoff are eligible. ${originals.length} original evidence items available. Current market rules, prices, picks, results, memories and conversation history are excluded. Missing original publication times are ineligible.`,
          publishedAt: null,
          retrievedAt: cutoff.toISOString(),
        },
      },
    );
    return {
      ...historical,
      temporalContext: {
        mode: "historical" as const,
        cutoff: cutoff.toISOString(),
        coverage: originals.length ? "recorded_originals" : "unavailable",
        excludedCurrentContext: true,
      },
      learningEvidence: [],
      trace: [...historicalReads, ...historical.trace],
      reply: {
        ...historical.reply,
        message: `As of ${cutoff.toISOString()} (recorded originals only):\n${historical.reply.message}`,
        proposedPick: null,
        proposedChange: null,
      },
    };
  }
  return runCurrentResearch(input, deps);
}
