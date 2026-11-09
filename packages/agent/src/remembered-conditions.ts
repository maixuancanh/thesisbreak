import {
  isLessonApplicable,
  lessonVersionSchema,
} from "../../domain/src/lesson";
import type { z } from "zod";
import type { learningConditionSchema } from "../../domain/src/experience-learning";
type Condition = z.infer<typeof learningConditionSchema>;
export type RequiredLearningTool =
  "read_independent_sources" | "read_tatum_quote" | "compare_snapshot";
export function rememberedConditions(input: {
  userId: string;
  domain: string;
  competition?: string;
  marketType?: string;
  horizon?: string;
  eventId?: string;
  now: Date;
  lessons: unknown[];
}) {
  const applied: {
    id: string;
    version: number;
    condition: "official_lineup" | Condition["type"];
    parameters?: Condition;
  }[] = [];
  const requiredTools: RequiredLearningTool[] = [];
  for (const raw of input.lessons) {
    if (!isLessonApplicable(raw, input)) continue;
    const lesson = lessonVersionSchema.parse(raw);
    const scope = lesson.learningScope;
    if (
      scope &&
      (scope.domain !== input.domain ||
        (["competition", "marketType", "horizon", "eventId"] as const).some(
          (k) => scope[k] !== undefined && scope[k] !== input[k],
        ))
    )
      continue;
    if (lesson.learningCondition) {
      const c = lesson.learningCondition;
      if (Date.parse(c.expiresAt) <= input.now.getTime()) continue;
      applied.push({
        id: lesson.id,
        version: lesson.version,
        condition: c.type,
        parameters: c,
      });
      requiredTools.push(
        c.type === "require_fresh_quote"
          ? "read_tatum_quote"
          : c.type === "compare_saved_snapshot"
            ? "compare_snapshot"
            : "read_independent_sources",
      );
    } else if (
      /^(?:only reconsider (?:my )?pick after (?:an? |the )?official lineup(?: is published)?|wait for (?:an? |the )?official lineup before reconsidering|require (?:an? |the )?official lineup before (?:creating|changing|creating or changing) (?:a |my )?pick)[.!]?$/i.test(
        lesson.rule.trim(),
      )
    ) {
      applied.push({
        id: lesson.id,
        version: lesson.version,
        condition: "official_lineup",
      });
      requiredTools.push("read_independent_sources");
    }
  }
  return {
    requiresLineup: applied.some(
      (c) =>
        c.condition === "official_lineup" ||
        c.condition === "require_official_lineup",
    ),
    applied,
    requiredTools: [...new Set(requiredTools)],
  };
}
/** Only provider-observed structured metadata satisfies these gates, never model prose. */
export function evaluateLearningConditions(
  conditions: ReturnType<typeof rememberedConditions>,
  input: {
    now: Date;
    sources: {
      id: string;
      kind?: string;
      retrievedAt: string;
      publishedAt?: string | null;
      quoteObservedAt?: string | null;
      confirmsLineup?: boolean;
      canonicalOriginId?: string | null;
      provenanceRefs?: string[];
    }[];
  },
) {
  const reasons: string[] = [];
  for (const c of conditions.applied) {
    const recent = (s: (typeof input.sources)[number], age: number) =>
      Date.parse(s.retrievedAt) <= input.now.getTime() &&
      input.now.getTime() - Date.parse(s.retrievedAt) <= age * 1000;
    if (
      (c.condition === "official_lineup" ||
        c.condition === "require_official_lineup") &&
      !input.sources.some(
        (s) =>
          s.kind === "official_event" &&
          s.confirmsLineup === true &&
          recent(s, 900),
      )
    )
      reasons.push("official_lineup_required");
    if (
      c.condition === "require_fresh_quote" &&
      !input.sources.some(
        (s) =>
          s.kind === "market" &&
          recent(s, c.parameters?.maxAgeSeconds ?? 0) &&
          s.quoteObservedAt != null &&
          Date.parse(s.quoteObservedAt) <= input.now.getTime() &&
          input.now.getTime() - Date.parse(s.quoteObservedAt) <=
            (c.parameters?.maxAgeSeconds ?? 0) * 1000,
      )
    )
      reasons.push("fresh_quote_required");
    if (
      c.condition === "compare_saved_snapshot" &&
      !input.sources.some((s) => s.kind === "snapshot")
    )
      reasons.push("saved_snapshot_required");
    if (
      c.condition === "require_independent_origin" &&
      new Set(
        input.sources
          .filter((s) => s.canonicalOriginId && s.provenanceRefs?.length)
          .map((s) => s.canonicalOriginId),
      ).size < (c.parameters?.minimumOrigins ?? 2)
    )
      reasons.push("independent_origins_required");
  }
  return { ready: reasons.length === 0, reasons: [...new Set(reasons)] };
}
