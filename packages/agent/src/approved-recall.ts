import {
  isLessonApplicable,
  type LessonContext,
} from "../../domain/src/lesson";
import { lessonVersionSchema } from "../../domain/src/lesson";
import { authorizedRecalledLessons } from "./recalled-lessons";
/** Bounded reconciliation; database records locate candidates, never substitute remote evidence. */
export async function recallApprovedContext(
  input: LessonContext & {
    query: string;
    loadCurrent: () => Promise<unknown[]>;
    recall: (
      query: string,
    ) => Promise<{ records: Parameters<typeof authorizedRecalledLessons>[1] }>;
  },
) {
  const candidates = (await input.loadCurrent())
    .filter((l) => isLessonApplicable(l, input))
    .slice(0, 8)
    .map((l) => lessonVersionSchema.parse(l));
  const found = await input.recall(input.query);
  const records = [...found.records];
  const hits = authorizedRecalledLessons(candidates, records);
  const missing = candidates.filter(
    (l) => !hits.some((h) => h.id === l.id && h.version === l.version),
  );
  for (let offset = 0; offset < missing.length; offset += 3) {
    const replies = await Promise.all(
      missing.slice(offset, offset + 3).map((l) => input.recall(l.rule)),
    );
    for (const reply of replies) records.push(...reply.records);
  }
  const current = (await input.loadCurrent()).filter((l) =>
    isLessonApplicable(l, input),
  );
  return authorizedRecalledLessons(current, records);
}
