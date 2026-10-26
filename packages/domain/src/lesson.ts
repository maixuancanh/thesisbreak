import { z } from "zod";
import { versionFields, validAncestry } from "./pick";
export const lessonVersionSchema = z
  .object({
    id: z.string().min(1),
    userId: z.string().min(1),
    ...versionFields,
    rule: z.string().min(1),
    scope: z
      .object({
        domain: z.string().min(1),
        competition: z.string().optional(),
        sourceClass: z.string().optional(),
      })
      .strict(),
    approval: z.enum(["pending", "approved", "rejected"]),
    status: z.enum(["active", "paused", "retired"]),
    effectiveAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
    reviewAt: z.iso.datetime().optional(),
    supersededBy: z.string().nullable(),
    originatingCorrection: z.string().optional(),
  })
  .strict()
  .refine(validAncestry, "INVALID_ANCESTRY")
  .refine(
    (v) =>
      v.expiresAt === null ||
      Date.parse(v.expiresAt) > Date.parse(v.effectiveAt),
    "INVALID_EFFECTIVE_WINDOW",
  );
export interface LessonContext {
  userId: string;
  domain: string;
  competition?: string;
  sourceClass?: string;
  now: Date;
}
export function isLessonApplicable(input: unknown, c: LessonContext): boolean {
  const p = lessonVersionSchema.safeParse(input);
  if (!p.success) return false;
  const l = p.data;
  return (
    l.userId === c.userId &&
    l.approval === "approved" &&
    l.status === "active" &&
    l.supersededBy === null &&
    new Date(l.effectiveAt) <= c.now &&
    (l.expiresAt === null || new Date(l.expiresAt) > c.now) &&
    l.scope.domain === c.domain &&
    (l.scope.competition === undefined ||
      l.scope.competition === c.competition) &&
    (l.scope.sourceClass === undefined || l.scope.sourceClass === c.sourceClass)
  );
}
