import { z } from "zod";
export const reviewItem = z.object({
  id: z.string(),
  changeId: z.string(),
  pickId: z.string(),
  pickVersion: z.number(),
  affectedPickCount: z.number().int().nonnegative().optional(),
  reasonRevision: z.number(),
  state: z.enum([
    "needs_review",
    "waiting_confirmation",
    "check_unavailable",
    "still_watching",
  ]),
  evidenceState: z.enum(["supported", "contradicted", "unclear"]),
  conditionMet: z.boolean().nullable(),
  explanation: z.string(),
  checkedAt: z.string(),
  question: z.string().nullable(),
  userText: z.string(),
  beforeExcerpt: z.string().optional(),
  afterExcerpt: z.string().optional(),
  beforeRefs: z.array(z.string()),
  afterRefs: z.array(z.string()),
  closed: z.boolean(),
  sourceUrl: z.string().nullable().optional(),
});
export type PickReview = z.infer<typeof reviewItem>;
export const reviewsResponse = z.object({
  items: z.array(reviewItem),
  nextCursor: z.string().nullable().optional(),
  coverage: z.object({
    trackedPicks: z.number(),
    totalPicks: z.number(),
    unconfiguredPicks: z.number(),
  }),
  lastCheckedAt: z.string().nullable(),
});
export const sharedResponse = z.object({
  items: z.array(
    z.object({
      familyId: z.string(),
      originStatus: z.enum(["verified", "unknown"]),
      sourceUrl: z.string().nullable().optional(),
      pickIds: z.array(z.string()),
      pickCount: z.number(),
      reasonIds: z.array(z.string()),
    }),
  ),
  methodologyVersion: z.string(),
});
export function safeEvidenceUrl(value: string | null | undefined) {
  try {
    const u = new URL(value ?? "");
    return ["https:", "http:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}
export async function reviewJson(r: Response) {
  if (!r.ok)
    throw new Error(
      r.status === 401
        ? "Sign in to see your review inbox."
        : r.status === 404
          ? "Reason monitoring is not available for this account yet."
          : "Your reviews could not be loaded. Try again.",
    );
  return r.json();
}
