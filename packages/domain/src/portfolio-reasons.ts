import { z } from "zod";
import { reasonConditionSchema } from "./pick-reason";

export const portfolioGroupSchema = z.object({
  kind: z.enum(["same_reason", "same_condition"]),
  reason: z.string().max(4000),
  picks: z.array(z.object({
    id: z.string(), version: z.number().int().positive(),
    platform: z.enum(["kalshi", "polymarket"]), nativeId: z.string(),
    question: z.string(), outcome: z.string(),
  })).min(2).max(100),
  evidenceLevel: z.literal("owner_recorded_dependency"),
});
export type PortfolioGroup = z.infer<typeof portfolioGroupSchema>;
export type PortfolioPick = PortfolioGroup["picks"][number] & {
  reason: string;
  conditions: unknown[];
};

/** Exact owner-authored reasons and typed conditions only. No inferred financial correlation. */
export function groupPortfolioReasons(picks: PortfolioPick[], now: Date): PortfolioGroup[] {
  const groups = new Map<string, { kind: PortfolioGroup["kind"]; reason: string; picks: Map<string, PortfolioPick> }>();
  function add(key: string, kind: PortfolioGroup["kind"], reason: string, pick: PortfolioPick) {
    const group = groups.get(key) ?? { kind, reason, picks: new Map() };
    group.picks.set(pick.id, pick);
    groups.set(key, group);
  }
  for (const pick of picks) {
    const reason = pick.reason.trim();
    if (reason) add(JSON.stringify(["reason", reason.replace(/\s+/g, " ")]), "same_reason", reason, pick);
    for (const raw of pick.conditions) {
      const parsed = reasonConditionSchema.safeParse(raw);
      if (!parsed.success) continue;
      const condition = parsed.data;
      if (Date.parse(condition.validFrom) > now.getTime() || Date.parse(condition.validUntil) <= now.getTime()) continue;
      const events = [...condition.eventIds].sort();
      const predicate = condition.predicate;
      const expected = predicate.type === "lineup_status"
        ? [predicate.expected, predicate.revisitOn]
        : predicate.type === "source_revision"
          ? [predicate.referenceId, predicate.revisitOn]
          : [predicate.type === "event_final" ? predicate.revisitOn : condition.revisitWhen];
      const key = JSON.stringify([condition.kind, condition.subjectId, events, condition.sourcePolicy, expected]);
      add(key, "same_condition", condition.statement, pick);
    }
  }
  return [...groups.values()].filter((group) => group.picks.size > 1)
    .map((group) => portfolioGroupSchema.parse({
      kind: group.kind, reason: group.reason,
      picks: [...group.picks.values()].map((pick) => ({
        id: pick.id, version: pick.version, platform: pick.platform,
        nativeId: pick.nativeId, question: pick.question, outcome: pick.outcome,
      })),
      evidenceLevel: "owner_recorded_dependency",
    }))
    .sort((a, b) => b.picks.length - a.picks.length);
}
