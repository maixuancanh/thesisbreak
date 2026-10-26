import { z } from "zod";
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
        ]),
      )
      .max(3),
  })
  .strict();
export type ReadPlan = (input: {
  message: string;
  market: ContextInput["market"];
  history: z.infer<typeof historySchema>;
}) => Promise<unknown>;
export function recentHistory(input: z.infer<typeof historySchema>) {
  const history = historySchema.parse(input).slice(-16);
  while (JSON.stringify(history).length > 30000) history.splice(0, 2);
  return history;
}
type Source = {
  id: string;
  text: string;
  retrievedAt: string;
  url: string;
  publishedAt?: string | null;
  kind?: "market" | "snapshot" | "official_event" | "background" | "settlement";
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
  },
  deps: {
    plan: ReadPlan;
    generate: GenerateReply;
    readPick: () => Promise<ContextInput["pick"]>;
    readLessons: () => Promise<unknown[]>;
    readComparison: () => Promise<Source[]>;
    marketSource: Source;
    readIndependent?: () => Promise<Source[]>;
    readSettlement?: (
      pick: ContextInput["pick"],
    ) => Promise<z.infer<typeof settlementSchema> | null>;
  },
) {
  const history = historySchema.parse(input.history);
  if (JSON.stringify(history).length > 30000)
    throw new Error("HISTORY_TOO_LARGE");
  const plan = readPlanSchema.parse(
    await deps.plan({ message: input.message, market: input.market, history }),
  );
  const trace: {
    tool: string;
    status: "completed" | "unavailable";
    count: number;
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
      sources.push(...found.slice(0, 17));
      trace.push({
        tool: "read_independent_sources",
        status: "completed",
        count: found.length,
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
      sources.push(...found);
      trace.push({ tool, status: "completed", count: found.length });
    }
  }
  const context = createAgentContext({
    userId: input.userId,
    market: input.market,
    pick,
    lessons,
    settlement,
    evidence: sources.map((s) => ({
      id: s.id,
      userId: input.userId,
      market: {
        platform: input.market.platform,
        nativeId: input.market.nativeId,
      },
      text: s.text,
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
  });
  const reply = await answerWithContext(
    context,
    input.message,
    deps.generate,
    undefined,
    history,
  );
  return {
    reply,
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
    sources: sources
      .filter(
        (s) =>
          s.url &&
          (reply.evidenceRefs.includes(s.id) ||
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
