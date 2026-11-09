import type { z } from "zod";
import type { learningScopeSchema } from "../../domain/src/experience-learning";
type Scope = z.infer<typeof learningScopeSchema>;
export type LearningRetrievalItem = {
  id: string;
  userId: string;
  scope: Scope;
  text: string;
  recordedAt: string;
  publishedAt: string | null;
  occurredAt?: string | null;
  active: boolean;
  consented: boolean;
  verified: boolean;
  superseded?: boolean;
};
/** Rebuildable lexical reference index; a hit still requires authoritative remote readback. */
export function retrieveLearningCandidates(input: {
  userId: string;
  query: string;
  scope: Scope;
  knownAt: Date;
  historical?: boolean;
  items: LearningRetrievalItem[];
  limit?: number;
  maxCharacters?: number;
}) {
  if (!Number.isFinite(input.knownAt.getTime()))
    throw Error("INVALID_RETRIEVAL_CUTOFF");
  const terms = [
    ...new Set(input.query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []),
  ];
  const excluded: { id: string; reason: string }[] = [];
  const eligible = input.items.filter((item) => {
    const reason =
      item.userId !== input.userId
        ? "foreign_owner"
        : !Number.isFinite(Date.parse(item.recordedAt))
          ? "unknown_recording_time"
          : item.publishedAt !== null &&
              !Number.isFinite(Date.parse(item.publishedAt))
            ? "unknown_publication_time"
            : item.occurredAt != null &&
                !Number.isFinite(Date.parse(item.occurredAt))
              ? "unknown_event_time"
              : !item.active ||
                  !item.consented ||
                  !item.verified ||
                  item.superseded
                ? "inactive_or_unverified"
                : Object.entries(item.scope).some(
                      ([k, v]) => input.scope[k as keyof Scope] !== v,
                    )
                  ? "scope_mismatch"
                  : Date.parse(item.recordedAt) > input.knownAt.getTime()
                    ? "future_record"
                    : item.publishedAt !== null &&
                        Date.parse(item.publishedAt) > input.knownAt.getTime()
                      ? "future_publication"
                      : input.historical && item.publishedAt === null
                        ? "unknown_publication_time"
                        : item.occurredAt &&
                            Date.parse(item.occurredAt) >
                              input.knownAt.getTime()
                          ? "future_event"
                          : null;
    if (reason) {
      excluded.push({ id: item.id, reason });
      return false;
    }
    return true;
  });
  const ranked = eligible
    .map((item) => ({
      item,
      score: terms.reduce(
        (n, t) => n + (item.text.toLocaleLowerCase().includes(t) ? 1 : 0),
        0,
      ),
    }))
    .filter((x) => x.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.item.recordedAt.localeCompare(a.item.recordedAt) ||
        a.item.id.localeCompare(b.item.id),
    );
  let budget = Math.max(0, Math.min(input.maxCharacters ?? 16000, 40000));
  const selected: LearningRetrievalItem[] = [];
  for (const { item } of ranked) {
    if (
      selected.length >= Math.min(input.limit ?? 8, 20) ||
      item.text.length > budget
    ) {
      excluded.push({
        id: item.id,
        reason: "budget_omitted_requires_original_lookup",
      });
      continue;
    }
    selected.push(item);
    budget -= item.text.length;
  }
  return {
    items: selected,
    excluded,
    mode: "lexical" as const,
    embeddingStatus: "not_configured" as const,
    requiresRemoteReadback: true,
    clarificationRequired:
      !input.scope.eventId &&
      input.items.some((i) => i.scope.eventId !== undefined),
  };
}
