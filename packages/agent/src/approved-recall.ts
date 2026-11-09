import {
  isLessonApplicable,
  type LessonContext,
} from "../../domain/src/lesson";
import { lessonVersionSchema } from "../../domain/src/lesson";
import { authorizedRecalledLessons } from "./recalled-lessons";
import { retrieveLearningCandidates } from "./learning-retrieval";
import type { MemoryPointer } from "../../domain/src/strengthening-contracts";
import type { MemoryEnvelope } from "../../integrations/src/memwal";
/** Bounded reconciliation; database records locate candidates, never substitute remote evidence. */
export async function recallApprovedContext(
  input: LessonContext & {
    eventId?: string;
    marketType?: string;
    horizon?: string;
    query: string;
    /** Optional pointer-only index; never a source of content or authority. */
    indexCandidates?: () => Promise<MemoryPointer[]>;
    loadCurrent: () => Promise<unknown[]>;
    recall: (
      query: string,
    ) => Promise<{
      records: Parameters<typeof authorizedRecalledLessons>[1];
      sources?: { record: MemoryEnvelope; blobId: string }[];
    }>;
  },
) {
  const candidates = (await input.loadCurrent())
    .filter((l) => isLessonApplicable(l, input))
    .map((l) => lessonVersionSchema.parse(l))
    .filter(
      (l) =>
        !l.learningScope ||
        (
          ["domain", "competition", "eventId", "marketType", "horizon"] as const
        ).every(
          (k) =>
            l.learningScope?.[k] === undefined ||
            l.learningScope[k] === input[k],
        ),
    )
    .sort((a, b) => {
      const terms = input.query.toLowerCase().split(/\W+/).filter(Boolean);
      const score = (l: typeof a) =>
        terms.filter((t) => l.rule.toLowerCase().includes(t)).length;
      return score(b) - score(a) || a.id.localeCompare(b.id);
    })
    .slice(0, 8);
  const found = await input.recall(input.query);
  const records = [...found.records];
  const sources = [...(found.sources ?? [])];
  const hits = authorizedRecalledLessons(candidates, records);
  const missing = candidates.filter(
    (l) => !hits.some((h) => h.id === l.id && h.version === l.version),
  );
  for (let offset = 0; offset < missing.length; offset += 3) {
    const replies = await Promise.all(
      missing.slice(offset, offset + 3).map((l) => input.recall(l.rule)),
    );
    for (const reply of replies) {
      records.push(...reply.records);
      sources.push(...(reply.sources ?? []));
    }
  }
  let indexPointers: MemoryPointer[] = [];
  if (input.indexCandidates) {
    try {
      indexPointers = (await input.indexCandidates()).slice(0, 20);
    } catch {
      /* The verified lexical baseline remains available during index outages. */
    }
  }
  const current = (await input.loadCurrent())
    .filter((l) => isLessonApplicable(l, input))
    .map((l) => lessonVersionSchema.parse(l))
    .filter(
      (l) =>
        !l.learningScope ||
        (
          ["domain", "competition", "eventId", "marketType", "horizon"] as const
        ).every(
          (k) =>
            l.learningScope?.[k] === undefined ||
            l.learningScope[k] === input[k],
        ),
    );
  const authorized = authorizedRecalledLessons(current, records);
  const ranked = retrieveLearningCandidates({
    userId: input.userId,
    query: input.query,
    scope: {
      domain: input.domain,
      ...(input.competition ? { competition: input.competition } : {}),
      ...(input.eventId ? { eventId: input.eventId } : {}),
      ...(input.marketType ? { marketType: input.marketType } : {}),
      ...(input.horizon ? { horizon: input.horizon } : {}),
    },
    knownAt: input.now,
    items: authorized.map((l) => ({
      id: l.id,
      userId: l.userId,
      scope: l.learningScope ?? {
        domain: l.scope.domain,
        ...(l.scope.competition ? { competition: l.scope.competition } : {}),
      },
      text: l.rule,
      recordedAt: l.effectiveAt,
      publishedAt: null,
      active: true,
      consented: true,
      verified: true,
    })),
    limit: 8,
  });
  const ranks = new Map(ranked.items.map((l, index) => [l.id, index]));
  // Lexical relevance orders verified context. It cannot discard a required approved condition.
  const indexRanks = new Map(
    indexPointers
      .filter(
        (p) =>
          p.ownerId === input.userId &&
          authorized.some(
            (l) => l.id === p.memoryId && l.version === p.version,
          ) &&
          sources.some(
            (s) =>
              s.blobId === p.blobId &&
              s.record.hash === p.sha256 &&
              s.record.userId === p.ownerId &&
              s.record.logicalId === p.memoryId &&
              s.record.version === p.version &&
              s.record.type === "lesson",
          ),
      )
      .map((p, i) => [`${p.memoryId}:${p.version}`, i]),
  );
  return authorized.sort(
    (a, b) =>
      (indexRanks.get(`${a.id}:${a.version}`) ?? 100) -
        (indexRanks.get(`${b.id}:${b.version}`) ?? 100) ||
      (ranks.get(a.id) ?? 100) - (ranks.get(b.id) ?? 100) ||
      a.id.localeCompare(b.id),
  );
}
