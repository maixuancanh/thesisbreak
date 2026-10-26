import { lessonVersionSchema } from "../../domain/src/lesson";
import type { MemoryEnvelope } from "../../integrations/src/memwal";
/** Recall finds candidates. Current account records remain the permission/version authority. */
export function authorizedRecalledLessons(
  owned: unknown[],
  recalled: Pick<
    MemoryEnvelope,
    "logicalId" | "type" | "version" | "payload"
  >[],
) {
  return owned.flatMap((value) => {
    const current = lessonVersionSchema.safeParse(value);
    if (!current.success) return [];
    const l = current.data;
    return recalled.some((r) => {
      if (
        r.type !== "lesson" ||
        r.logicalId !== l.id ||
        r.version !== l.version
      )
        return false;
      const p = lessonVersionSchema.safeParse(r.payload);
      return (
        p.success &&
        p.data.userId === l.userId &&
        JSON.stringify(p.data) === JSON.stringify(l)
      );
    })
      ? [l]
      : [];
  });
}
