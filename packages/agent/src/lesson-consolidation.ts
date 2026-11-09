import type { LearningCandidate } from "../../domain/src/experience-learning";
type Claim = Pick<
  LearningCandidate,
  "statement" | "scope" | "condition" | "evidence"
>;
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x).sort(([a], [b]) => a.localeCompare(b)),
        )
      : x,
  );
const evidenceKey = (e: Claim["evidence"][number]) =>
  `${e.atomId}:${e.version}:${e.hash}:${e.stance}`;
/** Evidence overlap is an index hint, never a vote that resolves contradictory sources. */
export function classifyConsolidation(
  candidate: Claim,
  existing: (Claim & { id: string; supportActive?: boolean })[],
) {
  for (const old of existing) {
    const shared = candidate.evidence.some((e) =>
      old.evidence.some((o) => o.atomId === e.atomId),
    );
    const sameScope = stable(old.scope) === stable(candidate.scope);
    if (!sameScope && !shared) continue;
    if (!sameScope)
      return {
        classification: "scope_change" as const,
        relatedId: old.id,
        requiresReview: true,
      };
    if (
      old.supportActive === false ||
      candidate.evidence.some((e) => e.stance === "contradict") ||
      candidate.evidence.some((e) =>
        old.evidence.some(
          (o) =>
            o.atomId === e.atomId &&
            (o.hash !== e.hash ||
              o.version !== e.version ||
              o.stance !== e.stance),
        ),
      )
    )
      return {
        classification: "conflict" as const,
        relatedId: old.id,
        requiresReview: true,
      };
    if (shared && stable(old.condition) !== stable(candidate.condition))
      return {
        classification: "conflict" as const,
        relatedId: old.id,
        requiresReview: true,
      };
    const keys = new Set(old.evidence.map(evidenceKey));
    if (shared && candidate.evidence.every((e) => keys.has(evidenceKey(e))))
      return {
        classification: "no_increment" as const,
        relatedId: old.id,
        requiresReview:
          old.statement !== candidate.statement ||
          stable(old.condition) !== stable(candidate.condition),
      };
    if (
      old.statement === candidate.statement &&
      stable(old.condition) === stable(candidate.condition)
    )
      return {
        classification: "reinforcement" as const,
        relatedId: old.id,
        requiresReview: true,
      };
    if (shared)
      return {
        classification: "conflict" as const,
        relatedId: old.id,
        requiresReview: true,
      };
  }
  return {
    classification: "new" as const,
    relatedId: null,
    requiresReview: true,
  };
}
