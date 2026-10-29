import { z } from "zod";
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
  sourceMemories?: unknown[];
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
  kind?: "market" | "snapshot" | "official_event" | "background" | "settlement";
  canonicalOriginId?: string | null;
  provenanceRefs?: string[];
};
export async function runResearch(
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
  },
  deps: {
    plan: ReadPlan;
    generate: GenerateReply;
    readPick: () => Promise<ContextInput["pick"]>;
    readLessons: () => Promise<unknown[]>;
    readSourceMemories?: () => Promise<unknown[]>;
    readSessionMemories?: () => Promise<unknown[]>;
    readComparison: () => Promise<ResearchSource[]>;
    marketSource: ResearchSource;
    readIndependent?: () => Promise<ResearchSource[]>;
    readTatumQuote?: () => Promise<ResearchSource[]>;
    readTatumHistory?: () => Promise<ResearchSource[]>;
    readSettlement?: (
      pick: ContextInput["pick"],
    ) => Promise<z.infer<typeof settlementSchema> | null>;
  },
) {
  const history = historySchema.parse(input.history);
  if (JSON.stringify(history).length > 30000)
    throw new Error("HISTORY_TOO_LARGE");
  const trace: {
    tool: string;
    status: "completed" | "unavailable";
    count: number;
    reason?: string;
  }[] = [{ tool: "read_market", status: "completed", count: 1 }];
  // Current account state is authoritative, never optional model context.
  const pick = await deps.readPick();
  trace.push({
    tool: "read_saved_pick",
    status: "completed",
    count: pick ? 1 : 0,
  });
  const lessons = await deps.readLessons();
  trace.push({
    tool: "read_approved_lessons",
    status: "completed",
    count: lessons.length,
  });
  const sources = [deps.marketSource];
  let sourceMemories: unknown[] = [];
  if (deps.readSourceMemories) {
    try {
      sourceMemories = (await deps.readSourceMemories()).slice(0, 4);
      trace.push({
        tool: "recall_source_history",
        status: "completed",
        count: sourceMemories.length,
      });
    } catch {
      trace.push({
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
      trace.push({
        tool: "recall_conversations",
        status: "completed",
        count: sessionMemories.length,
      });
    } catch {
      trace.push({
        tool: "recall_conversations",
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
      sourceMemories,
      sessionMemories,
    }),
  );
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
      trace.push({
        tool: "read_settlement",
        status: "completed",
        count: settlement ? 1 : 0,
      });
    } catch {
      trace.push({ tool: "read_settlement", status: "unavailable", count: 0 });
    }
  }
  if (deps.readIndependent) {
    try {
      const found = await deps.readIndependent();
      sources.push(...found.slice(0, 14));
      trace.push({
        tool: "read_independent_sources",
        status: "completed",
        count: Math.min(found.length, 14),
      });
    } catch {
      trace.push({
        tool: "read_independent_sources",
        status: "unavailable",
        count: 0,
      });
    }
  }
  for (const tool of new Set(plan.tools)) {
    if (tool === "compare_snapshot") {
      const found = await deps.readComparison();
      sources.push(...found.slice(0, 1));
      trace.push({
        tool,
        status: "completed",
        count: Math.min(found.length, 1),
      });
    }
  }
  for (const [tool, read] of [
    ["read_tatum_quote", deps.readTatumQuote],
    ["read_tatum_history", deps.readTatumHistory],
  ] as const) {
    if (!plan.tools.includes(tool)) continue;
    if (!read) {
      trace.push({
        tool,
        status: "unavailable",
        count: 0,
        reason: "not_configured",
      });
      continue;
    }
    try {
      const found = (await read()).slice(0, 1);
      sources.push(...found);
      trace.push({ tool, status: "completed", count: found.length });
    } catch {
      trace.push({
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
  const origins = groupCanonicalOrigins(
    boundedSources.map((s) => ({
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
    sourceMemories,
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
    ...(input.researchPrerequisites
      ? { researchPrerequisites: input.researchPrerequisites }
      : {}),
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
  while (promptSize() > 55000 && history.length) history.splice(0, 2);
  while (
    promptSize() > 55000 &&
    context.evidence.some((e) => e.text.length > 600)
  ) {
    for (const evidence of context.evidence) {
      if (evidence.text.length > 600)
        evidence.text =
          evidence.text.slice(
            0,
            Math.max(500, Math.floor(evidence.text.length * 0.7)),
          ) + " [Excerpt truncated for context size]";
    }
  }
  while (promptSize() > 55000 && context.lessons.length) context.lessons.pop();
  while (promptSize() > 55000 && sessionMemories.length) sessionMemories.pop();
  const memoryComparison = input.compareMemory
    ? await compareMemoryContext({
        context,
        sessionMemories,
        message: input.message,
        history: [],
        generate: deps.generate,
      })
    : undefined;
  const reply =
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
    reply,
    sessionMemories,
    plannedTools: plan.tools,
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
